import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import type { BlockList } from 'node:net';
import { config } from './config.js';
import { log } from './log.js';
import { ProxyTrust, addressKey, fromTrustedProxy, isLocalAddress, normalizeIp, parseNetworks, requestOrigin, untrustedForwarder, type Origin } from './net.js';

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
    public code?: string,
    public extra?: Record<string, unknown>,
  ) {
    super(message);
  }
}

export type Req = IncomingMessage & {
  path: string;
  query: URLSearchParams;
  params: Record<string, string>;
};
export type Res = ServerResponse;
export type Handler = (req: Req, res: Res) => unknown | Promise<unknown>;

type Route = { method: string; parts: string[]; handler: Handler };

/** Minimal path router. Supports `:param` segments and a trailing `*` wildcard (params['*']). */
export class Router {
  private routes: Route[] = [];

  add(method: string, pattern: string, handler: Handler): this {
    const parts = pattern.split('/').filter(Boolean);
    this.routes.push({ method: method.toUpperCase(), parts, handler });
    return this;
  }
  get(p: string, h: Handler) { return this.add('GET', p, h); }
  head(p: string, h: Handler) { return this.add('HEAD', p, h); }
  post(p: string, h: Handler) { return this.add('POST', p, h); }
  put(p: string, h: Handler) { return this.add('PUT', p, h); }
  patch(p: string, h: Handler) { return this.add('PATCH', p, h); }
  delete(p: string, h: Handler) { return this.add('DELETE', p, h); }

  match(method: string, path: string): { handler: Handler; params: Record<string, string> } | null {
    const segs = path.split('/').filter(Boolean);
    let methodMismatch = false;
    for (const r of this.routes) {
      const params = matchParts(r.parts, segs);
      if (!params) continue;
      if (r.method !== method && !(r.method === 'GET' && method === 'HEAD')) {
        methodMismatch = true;
        continue;
      }
      return { handler: r.handler, params };
    }
    if (methodMismatch) throw new HttpError(405, 'Method not allowed', 'method_not_allowed');
    return null;
  }
}

function matchParts(parts: string[], segs: string[]): Record<string, string> | null {
  const params: Record<string, string> = {};
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    if (p === '*') {
      params['*'] = segs.slice(i).map(safeDecode).join('/');
      return params;
    }
    if (i >= segs.length) return null;
    if (p.startsWith(':')) params[p.slice(1)] = safeDecode(segs[i]);
    else if (p !== segs[i]) return null;
  }
  return segs.length === parts.length ? params : null;
}

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    throw new HttpError(400, 'Malformed URL encoding', 'invalid_request');
  }
}

export function enhance(req: IncomingMessage): Req {
  const url = new URL(req.url || '/', 'http://local');
  const r = req as Req;
  r.path = url.pathname;
  r.query = url.searchParams;
  r.params = {};
  return r;
}

export async function readBody(req: IncomingMessage, limit = 1024 * 1024): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limit) throw new HttpError(413, 'Request body too large', 'payload_too_large');
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

export async function readJson<T = Record<string, any>>(req: IncomingMessage, limit = 1024 * 1024): Promise<T> {
  const buf = await readBody(req, limit);
  if (buf.length === 0) return {} as T;
  const type = String(req.headers['content-type'] || '');
  if (type.includes('application/x-www-form-urlencoded')) {
    return Object.fromEntries(new URLSearchParams(buf.toString('utf8'))) as T;
  }
  try {
    return JSON.parse(buf.toString('utf8')) as T;
  } catch {
    throw new HttpError(400, 'Request body is not valid JSON', 'bad_json');
  }
}

export function sendJson(res: Res, status: number, body: unknown, headers: Record<string, string> = {}): void {
  if (res.headersSent) return;
  const data = JSON.stringify(body ?? null);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(data),
    ...headers,
  });
  res.end(data);
}

export function redirect(res: Res, location: string, status = 303): void {
  res.writeHead(status, { Location: location, 'Content-Length': 0 });
  res.end();
}

export type ErrorFormatter = (err: HttpError, req: Req) => { status: number; body: unknown };

export function createServer(
  name: string,
  router: Router,
  formatError: ErrorFormatter = (e) => ({ status: e.status, body: { error: e.code || 'error', message: e.message } }),
  fallback?: Handler,
  /** Pass Postgres's own error text on to callers (Studio, whose users are admins). */
  dbErrorDetails = false,
) {
  return http.createServer(async (rawReq, res) => {
    const req = enhance(rawReq);
    const started = Date.now();
    res.on('finish', () => {
      if (req.path === '/health') return;
      log.debug(`${req.method} ${req.path} ${res.statusCode} ${Date.now() - started}ms`);
    });
    try {
      const m = router.match(req.method || 'GET', req.path);
      if (m) {
        req.params = m.params;
        await m.handler(req, res);
      } else if (fallback) {
        await fallback(req, res);
      } else {
        throw new HttpError(404, 'Not found', 'not_found');
      }
    } catch (err) {
      const e = toHttpError(err, dbErrorDetails);
      if (e.status >= 500) log.error(`${name}: ${req.method} ${req.path} failed`, { error: (err as Error)?.stack || String(err) });
      else if (!(err instanceof HttpError)) log.info(`${name}: ${req.method} ${req.path} database error`, dbErrorFields(err, config.logPii));
      if (!res.headersSent) {
        const { status, body } = formatError(e, req);
        sendJson(res, status, body);
      } else {
        res.destroy();
      }
    }
  });
}

/**
 * What to log about a Postgres error a client caused. Its text can hold the
 * values that were sent ('invalid input syntax for type uuid: "..."'), so
 * without KEEL_LOG_PII only the code and the names of what it hit are kept.
 */
export function dbErrorFields(err: unknown, pii: boolean): Record<string, unknown> {
  const e = (err || {}) as { code?: string; message?: string; table?: string; column?: string; constraint?: string };
  const out: Record<string, unknown> = { code: e.code };
  for (const k of ['table', 'column', 'constraint'] as const) if (e[k]) out[k] = e[k];
  if (pii) out.error = e.message;
  return out;
}

/**
 * Maps common Postgres errors to client errors. Their text names tables,
 * columns and constraints, so callers get a generic message unless
 * `details` is set (the caller logs the original).
 */
export function toHttpError(err: unknown, details = false): HttpError {
  if (err instanceof HttpError) return err;
  const pg = err as { code?: string; message?: string };
  if (pg && typeof pg.code === 'string' && /^[0-9A-Z]{5}$/.test(pg.code)) {
    const msg = (generic: string) => (details && pg.message) || generic;
    if (pg.code === '42501') return new HttpError(403, msg('Permission denied'), 'permission_denied');
    if (pg.code === '23505') return new HttpError(409, msg('Duplicate value'), 'duplicate');
    if (pg.code === '23503') return new HttpError(409, msg('The value refers to a row that does not exist, or the row is still referred to'), 'foreign_key_violation');
    if (pg.code.startsWith('22') || pg.code.startsWith('23')) return new HttpError(400, msg('Invalid input'), 'invalid_input');
  }
  return new HttpError(500, 'Internal server error', 'internal_error');
}

export function bearer(req: IncomingMessage): string | null {
  const h = req.headers.authorization;
  if (!h) return null;
  const m = /^Bearer\s+(.+)$/i.exec(h);
  return m ? m[1].trim() : null;
}

let trust: ProxyTrust | null = null;
/** Parsed KEEL_TRUSTED_PROXIES (cached, names looked up again every 30 seconds). */
export function trustedProxies(): ProxyTrust {
  if (!trust) {
    try {
      trust = new ProxyTrust(config.trustedProxies);
    } catch (err) {
      log.error(`${(err as Error).message}; trusting only Keel's own proxies`);
      trust = new ProxyTrust('');
    }
    const t = trust;
    void t.refresh();
    setInterval(() => void t.refresh(), 30_000).unref();
  }
  return trust;
}

let networks: BlockList | null = null;
/** Parsed KEEL_LOCAL_NETWORKS (cached). */
export function localNetworks(): BlockList {
  if (!networks) {
    try {
      networks = parseNetworks(config.localNetworks);
    } catch (err) {
      log.error(`${(err as Error).message}; using the default (private networks)`);
      networks = parseNetworks('private');
    }
  }
  return networks;
}

const warnedForwarders = new Map<string, number>();
/**
 * requestOrigin() with this service's settings. A proxy on your network that
 * isn't trusted makes every visitor look like the proxy, which is right but
 * surprising after an upgrade, so it's logged (once an hour per proxy).
 */
function origin(req: IncomingMessage): Origin {
  const nets = localNetworks();
  const trust = trustedProxies();
  const peer = untrustedForwarder(req, nets, trust);
  const last = peer ? warnedForwarders.get(peer) : undefined;
  if (peer && !(last && Date.now() - last < 60 * 60_000)) {
    if (warnedForwarders.size >= 1000) warnedForwarders.clear();
    warnedForwarders.set(peer, Date.now());
    // Look the proxy names up again first: a trusted proxy may just have restarted with a new address.
    void trust.refresh(5_000).then(() => {
      if (trust.trusts(peer)) return;
      log.warn(`${peer} forwards requests for others (X-Forwarded-For) but isn't a trusted proxy, so every visitor it sends counts as ${peer} for rate limits. If it's your reverse proxy, add it to KEEL_TRUSTED_PROXIES.`, { peer });
    });
  }
  return requestOrigin(req, nets, trust);
}

/**
 * The caller's IP: the first address in X-Forwarded-For (read from the
 * right) that a trusted proxy reported, so rate limits see real clients
 * behind the gateway and behind proxies or tunnels in front of Keel.
 */
export function clientIp(req: IncomingMessage): string {
  return origin(req).address;
}

/** The caller's rate-limit key: its address, or its /64 for IPv6. */
export function clientKey(req: IncomingMessage): string {
  return addressKey(clientIp(req));
}

/**
 * True when the caller is on your network (LAN, Tailscale, this machine)
 * and no proxy we don't trust forwarded the request. Requests that came
 * through a CDN edge such as Cloudflare never are.
 */
export function fromLocalNetwork(req: IncomingMessage): boolean {
  return origin(req).local;
}

/** True when the request came straight from a trusted proxy. */
export function viaTrustedProxy(req: IncomingMessage): boolean {
  return fromTrustedProxy(req, trustedProxies());
}

/** True when the request came straight from keel-tunnel (Cloudflare Tunnel). */
export function viaTunnel(req: IncomingMessage): boolean {
  return trustedProxies().isTunnel(req.socket.remoteAddress || '');
}

/**
 * Forwarding headers for a service behind the gateway. X-Forwarded-For is
 * just the client the gateway settled on, so services needn't know which
 * proxies it trusts (one on the Docker host, say); a leading "unknown" keeps
 * a private address that isn't local (someone untrusted forwarded it) from
 * counting as local there. The client's own X-Forwarded-Host and -Proto,
 * and CDN address headers, are only passed on from a trusted proxy.
 */
export function gatewayForwarding(req: IncomingMessage): Record<string, string | null> {
  const nets = localNetworks();
  const o = origin(req);
  const xff = o.local || !isLocalAddress(o.address, nets) ? o.address : `unknown, ${o.address}`;
  if (viaTrustedProxy(req)) return { 'x-forwarded-for': xff };
  return {
    'x-forwarded-for': xff,
    'x-forwarded-host': req.headers.host || null,
    'x-forwarded-proto': 'http',
    'cf-connecting-ip': null,
    'true-client-ip': null,
  };
}

export function listen(server: http.Server, port: number, name: string): Promise<void> {
  trustedProxies();
  return new Promise((resolve) => {
    server.listen(port, '0.0.0.0', () => {
      log.info(`${name} listening on port ${port}`);
      resolve();
    });
  });
}

/** Simple fixed-window rate limiter keyed by string. */
export class RateLimiter {
  private hits = new Map<string, { count: number; reset: number }>();
  constructor(private limit: number, private windowMs: number) {
    setInterval(() => {
      const now = Date.now();
      for (const [k, v] of this.hits) if (v.reset < now) this.hits.delete(k);
    }, Math.min(windowMs, 60_000)).unref();
  }
  /** Returns true when the call is allowed. */
  take(key: string): boolean {
    const now = Date.now();
    const cur = this.hits.get(key);
    if (!cur || cur.reset < now) {
      this.hits.set(key, { count: 1, reset: now + this.windowMs });
      return true;
    }
    cur.count++;
    return cur.count <= this.limit;
  }
  /** Forgets a key, e.g. after a successful sign-in. */
  reset(key: string): void {
    this.hits.delete(key);
  }
}

/**
 * Wrong passwords per account, from any address. The first `free` failures
 * in a window cost nothing; after that each attempt has to wait twice as long
 * as the one before, from a second up to `maxDelayMs`, so guessing slows to a
 * few tries an hour. Only wrong passwords count, and a right one starts over.
 * Attempts still being checked count as failures until they finish, so a
 * parallel burst can't slip past.
 *
 * Someone who keeps guessing keeps the account waiting, so callers must let
 * the owner past from somewhere the attacker can't be (see knownAddress in
 * keel-auth) rather than relying on this alone.
 */
export class AccountBackoff {
  private hits = new Map<string, { failures: number; inflight: number; last: number; reset: number }>();
  constructor(
    private free: number,
    private windowMs: number,
    private maxDelayMs: number,
    private now: () => number = Date.now,
  ) {
    setInterval(() => {
      const t = this.now();
      for (const [k, v] of this.hits) if (v.reset < t && !v.inflight) this.hits.delete(k);
    }, 60_000).unref();
  }
  /** Starts an attempt; false when the account has to wait first. Every true needs an end(). */
  begin(key: string): boolean {
    const t = this.now();
    let cur = this.hits.get(key);
    if (!cur) {
      cur = { failures: 0, inflight: 0, last: 0, reset: t + this.windowMs };
      this.hits.set(key, cur);
    } else if (cur.reset < t) {
      cur.failures = 0;
      cur.reset = t + this.windowMs;
    }
    const n = cur.failures + cur.inflight;
    if (n >= this.free) {
      const delay = Math.min(1000 * 2 ** (n - this.free), this.maxDelayMs);
      if (t < cur.last + delay) return false;
    }
    cur.inflight++;
    cur.last = t;
    return true;
  }
  /** Ends an attempt: a wrong password counts, a right one forgets the failures, 'none' neither. */
  end(key: string, outcome: 'success' | 'failure' | 'none'): void {
    const cur = this.hits.get(key);
    if (!cur) return;
    cur.inflight = Math.max(0, cur.inflight - 1);
    if (outcome === 'success') cur.failures = 0;
    if (outcome === 'failure') {
      cur.failures++;
      // Keep counting past the window while someone is still guessing.
      cur.reset = Math.max(cur.reset, this.now() + this.windowMs);
    }
    if (!cur.failures && !cur.inflight) this.hits.delete(key);
  }
}

export type ServerLimits = {
  /** Close a request whose body sends nothing for this long (0 = never). */
  bodyIdleMs: number;
  /** Open connections allowed per peer address (0 = no limit). */
  connectionsPerIp: number;
  /** Peers the connection limit doesn't apply to; by default trusted proxies, which carry everyone's traffic. */
  exempt?: (ip: string) => boolean;
};

/**
 * Protects a server from slow bodies and connection floods. The body limit
 * is idle-based rather than a total, so large uploads on slow links still
 * work; it stops once the body has arrived, so slow answers (long function
 * calls) are left alone.
 */
export function limitServer(server: http.Server, name: string, limits: ServerLimits): void {
  const exempt = limits.exempt ?? ((ip: string) => trustedProxies().trusts(ip));
  if (limits.connectionsPerIp > 0) {
    const open = new Map<string, number>();
    let warned = 0;
    server.on('connection', (socket) => {
      const ip = normalizeIp(socket.remoteAddress || '');
      if (exempt(ip)) return;
      // IPv6 clients count per /64, which they can pick addresses from freely.
      const key = addressKey(ip);
      const n = (open.get(key) || 0) + 1;
      if (n > limits.connectionsPerIp) {
        if (Date.now() - warned > 60_000) {
          warned = Date.now();
          log.warn(`${name}: too many connections from one address, refusing more`, { ip: key, limit: limits.connectionsPerIp });
        }
        return void socket.destroy();
      }
      open.set(key, n);
      socket.once('close', () => {
        const left = (open.get(key) || 1) - 1;
        if (left) open.set(key, left);
        else open.delete(key);
      });
    });
  }
  if (limits.bodyIdleMs > 0) {
    server.on('request', (req: IncomingMessage) => {
      if (req.complete) return;
      // Just close: the handler may be about to answer, and closing also stops its upstream request.
      req.setTimeout(limits.bodyIdleMs, () => req.socket.destroy());
      req.once('end', () => req.setTimeout(0));
    });
  }
}
