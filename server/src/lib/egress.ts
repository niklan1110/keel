import dns from 'node:dns';
import fs from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import os from 'node:os';
import { DENIED_RANGES, defaultGateway, keepAllowed, parseAllowLan, parseBlock, type Block } from '../functions/sandbox.js';
import { config, serverOverrides } from './config.js';
import { connectedNetworks, hostAddresses, normalizeIp } from './net.js';

/**
 * Outgoing HTTP requests made for a project's SQL (pg_net's net.http_get and
 * net.http_post, database webhooks). The URL comes from the project, so the
 * rules are those of edge functions (see functions/sandbox.ts): the internet
 * only, never a private or special address, this server or Keel's own
 * containers, except LAN addresses the owner opened with
 * KEEL_FUNCTIONS_ALLOW_LAN. The name is resolved once, every address it
 * resolves to is checked, and the connection goes to the checked address
 * (a name can't resolve to something else a moment later: DNS rebinding).
 * Redirects are not followed. Calls to the project's own edge functions go
 * straight to the gateway instead.
 */

/**
 * IPv6 ranges no request may reach (Node's BlockList handles IPv6 ranges,
 * unlike Deno's --deny-net). IPv4-mapped addresses (::ffff:a.b.c.d) are
 * checked by BlockList against the IPv4 rules.
 */
const DENIED_IPV6 = [
  '::/96', // unspecified, loopback, IPv4-compatible
  '::ffff:0:0:0/96', // IPv4-translated (SIIT): reaches IPv4 addresses
  '64:ff9b::/96', // NAT64: reaches IPv4 addresses
  '64:ff9b:1::/48',
  '100::/64', // discard
  '2001::/32', // Teredo
  '2001:db8::/32', // documentation
  '2002::/16', // 6to4: reaches IPv4 addresses
  'fc00::/7', // unique local
  'fe80::/10', // link-local
  'fec0::/10', // site-local (deprecated)
  'ff00::/8', // multicast
];

export type EgressPolicy = {
  /** Ranges and addresses that are always refused. */
  denied: net.BlockList;
  /** This server's and Keel's own addresses: refused even inside an allowed LAN block. */
  own: net.BlockList;
  /** LAN blocks opened with KEEL_FUNCTIONS_ALLOW_LAN. */
  allowed: Block[];
};

function addTo(list: net.BlockList, item: string): void {
  const [addr, bits] = item.split('/');
  const ip = normalizeIp(addr);
  const type = net.isIPv6(ip) ? 'ipv6' : net.isIPv4(ip) ? 'ipv4' : null;
  if (!type) return;
  if (bits === undefined) list.addAddress(ip, type);
  else list.addSubnet(ip, Number(bits), type);
}

/** A policy from this server's own addresses and the allowed LAN blocks (exported for tests). */
export function makePolicy(ownAddresses: string[], allowed: Block[] = []): EgressPolicy {
  const denied = new net.BlockList();
  for (const r of [...DENIED_RANGES, ...DENIED_IPV6]) addTo(denied, r);
  const own = new net.BlockList();
  for (const a of ownAddresses) addTo(own, a.trim());
  return { denied, own, allowed };
}

const v4num = (ip: string) => ip.split('.').reduce((n, p) => n * 256 + Number(p), 0);

/** Why a request may not go to this address, or null when it may. */
export function addressProblem(address: string, policy: EgressPolicy): string | null {
  const ip = normalizeIp(address);
  const type = net.isIPv4(ip) ? 'ipv4' : net.isIPv6(ip) ? 'ipv6' : null;
  if (!type) return 'not an IP address';
  if (policy.own.check(ip, type)) return "it is this server or one of Keel's containers";
  if (!policy.denied.check(ip, type)) return null;
  if (type === 'ipv4') {
    const n = v4num(ip);
    if (policy.allowed.some((b) => n >= b.base && n < b.base + 2 ** (32 - b.bits))) return null;
  }
  return 'it is a private or reserved address (see KEEL_FUNCTIONS_ALLOW_LAN to open LAN addresses)';
}

let cached: { at: number; policy: EgressPolicy } | null = null;

/**
 * This container's policy, rebuilt every 30 seconds: its own addresses and
 * networks, the Docker host, Keel's containers, the server's public address
 * and KEEL_FUNCTIONS_DENY_NET are refused; KEEL_FUNCTIONS_ALLOW_LAN opens LAN
 * blocks that touch none of those (as for edge functions).
 */
export async function loadPolicy(): Promise<EgressPolicy> {
  if (cached && Date.now() - cached.at < 30_000) return cached.policy;
  const hostname = (h: string) => {
    try {
      return (h.includes('://') ? new URL(h).hostname : h).replace(/^\[|\]$/g, '');
    } catch {
      return '';
    }
  };
  const quick = new dns.promises.Resolver({ timeout: 1000, tries: 1 });
  const resolve = async (h: string) =>
    !h ? [] : net.isIP(h) ? [h] : (await Promise.all([quick.resolve4(h).catch(() => []), quick.resolve6(h).catch(() => [])])).flat();
  const interfaces = Object.values(os.networkInterfaces()).flat().filter((i) => i && !i.internal) as os.NetworkInterfaceInfo[];
  const route = await fs.readFile('/proc/net/route', 'utf8').catch(() => '');
  const route6 = await fs.readFile('/proc/net/ipv6_route', 'utf8').catch(() => '');
  const envHost = hostname(config.envPublicUrl);
  const names = [
    serverOverrides().publicDbHost || process.env.KEEL_PUBLIC_DB_HOST || '',
    net.isIP(envHost) ? envHost : '',
    config.db.host,
    ...Object.values(config.services).map(hostname),
    'keel-studio',
    'keel-docker',
    'keel-tunnel',
  ];
  const found = (await Promise.all(names.map(resolve))).flat();
  const split = (s: string) => s.split(',').map((x) => x.trim()).filter(Boolean);
  const inDocker = await fs.stat('/.dockerenv').then(() => true, () => false);
  const own = [
    ...interfaces.map((i) => i.address),
    // In Docker, the networks this container is on are Keel's own.
    ...(inDocker ? connectedNetworks(route, route6) : []),
    ...hostAddresses(route),
    ...found,
    ...split(config.functions.denyNet),
    ...split(config.functions.hostAddresses),
  ];
  let allowed: Block[] = [];
  if (config.functions.allowLan.trim()) {
    const hosts = split(config.functions.hostAddresses).filter((ip) => net.isIPv4(ip));
    const parsed = parseAllowLan(config.functions.allowLan, { ranges: hosts.length > 0 });
    const forbidden: Block[] = [];
    for (const i of interfaces) if (i.family === 'IPv4' && i.cidr) forbidden.push(parseBlock(inDocker ? i.cidr : i.address)!);
    const gw = defaultGateway(route);
    for (const ip of [...own, ...(gw ? [gw] : [])]) {
      const b = net.isIPv4(ip) || (ip.includes('/') && !ip.includes(':')) ? parseBlock(ip) : null;
      if (b) forbidden.push(b);
    }
    allowed = keepAllowed(parsed.allowed, forbidden).kept.map((a) => a.block);
  }
  const policy = makePolicy(own, allowed);
  cached = { at: Date.now(), policy };
  return policy;
}

/**
 * The gateway path when `url` is one of the project's own edge functions
 * (<public URL>/<project>/functions/v1/...), reached through the gateway
 * inside Keel rather than over the network. Null for anything else.
 */
export function ownFunctionPath(url: URL, project: string, bases: string[]): string | null {
  for (const raw of bases) {
    let base: URL;
    try {
      base = new URL(raw);
    } catch {
      continue;
    }
    if (url.origin !== base.origin) continue;
    const prefix = base.pathname.replace(/\/+$/, '');
    // The URL parser has already resolved "." and ".." segments (including %2e).
    const rest = url.pathname.slice(prefix.length);
    if (url.pathname.startsWith(prefix) && rest.startsWith(`/${project}/functions/v1/`)) return rest + url.search;
  }
  return null;
}

export type OutgoingRequest = {
  method: 'GET' | 'POST' | 'DELETE';
  url: string;
  headers: Record<string, string>;
  body: Buffer | null;
  timeoutMs: number;
};

export type OutgoingResult =
  | { ok: true; status: number; headers: Record<string, string>; contentType: string | null; content: string }
  | { ok: false; timedOut: boolean; error: string };

/** Headers a request may not set: they describe the connection, which Keel makes. */
const DROP_HEADERS = new Set(['host', 'content-length', 'transfer-encoding', 'connection', 'keep-alive', 'upgrade', 'proxy-connection', 'te', 'trailer']);
const FORWARD_HEADERS = /^(x-forwarded-|x-real-ip$|forwarded$)/i;

export type SendOptions = {
  project: string;
  /** Largest response body kept, in bytes. */
  maxResponseBytes: number;
  policy: EgressPolicy;
  /** Base URLs under which the project's functions are reached (the public URL, the gateway's). */
  functionBases: string[];
  gateway: string;
  lookup?: (host: string) => Promise<string[]>;
};

const systemLookup = async (host: string) => (await dns.promises.lookup(host, { all: true, verbatim: true })).map((a) => a.address);

/** Sends one request under the rules above. Never throws. */
export async function sendRequest(r: OutgoingRequest, o: SendOptions): Promise<OutgoingResult> {
  let url: URL;
  try {
    url = new URL(r.url);
  } catch {
    return { ok: false, timedOut: false, error: 'invalid URL' };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return { ok: false, timedOut: false, error: 'only http and https URLs are supported' };
  if (url.username || url.password) return { ok: false, timedOut: false, error: 'credentials in the URL are not supported; send an Authorization header' };
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(r.headers)) {
    if (!DROP_HEADERS.has(k.toLowerCase())) headers[k] = v;
  }
  if (r.body) headers['Content-Length'] = String(r.body.length);

  const internal = ownFunctionPath(url, o.project, o.functionBases);
  let target: URL;
  let address: string | null = null;
  if (internal) {
    target = new URL(internal, o.gateway);
    for (const k of Object.keys(headers)) if (FORWARD_HEADERS.test(k)) delete headers[k];
  } else {
    target = url;
    const host = url.hostname.replace(/^\[|\]$/g, '');
    let addresses: string[];
    try {
      if (net.isIP(host)) addresses = [host];
      else {
        // The request's time limit covers looking the name up too.
        let timer: NodeJS.Timeout | undefined;
        const late = new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new Error('timeout')), r.timeoutMs)));
        addresses = await Promise.race([(o.lookup || systemLookup)(host), late]).finally(() => clearTimeout(timer));
      }
    } catch {
      return { ok: false, timedOut: false, error: `could not resolve ${host}` };
    }
    if (!addresses.length) return { ok: false, timedOut: false, error: `could not resolve ${host}` };
    for (const a of addresses) {
      const problem = addressProblem(a, o.policy);
      if (problem) {
        const what = net.isIP(host) ? host : `${host} resolves to ${normalizeIp(a)}`;
        return { ok: false, timedOut: false, error: `refused: ${what}; ${problem}` };
      }
    }
    address = normalizeIp(addresses[0]);
  }

  return new Promise<OutgoingResult>((resolve) => {
    let done = false;
    const finish = (out: OutgoingResult) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      req.destroy();
      resolve(out);
    };
    const pinned = address;
    const family = pinned && net.isIPv6(pinned) ? 6 : 4;
    const options: https.RequestOptions = {
      method: r.method,
      protocol: target.protocol,
      hostname: target.hostname.replace(/^\[|\]$/g, ''),
      port: target.port || undefined,
      path: target.pathname + target.search,
      headers,
      agent: false,
      ...(pinned
        ? {
            // Connect to the address checked above, whatever the name resolves to now.
            lookup: ((_h: string, opts: { all?: boolean }, cb: (...args: unknown[]) => void) =>
              opts?.all ? cb(null, [{ address: pinned, family }]) : cb(null, pinned, family)) as unknown as net.LookupFunction,
          }
        : {}),
    };
    let req: http.ClientRequest;
    try {
      req = (target.protocol === 'https:' ? https : http).request(options);
    } catch (err) {
      resolve({ ok: false, timedOut: false, error: `invalid request: ${(err as Error).message}` });
      return;
    }
    const timer = setTimeout(() => finish({ ok: false, timedOut: true, error: `Timeout of ${r.timeoutMs} ms reached` }), r.timeoutMs);
    req.on('error', (err) => finish({ ok: false, timedOut: false, error: err.message }));
    req.on('response', (res) => {
      const chunks: Buffer[] = [];
      let size = 0;
      res.on('data', (c: Buffer) => {
        size += c.length;
        if (size > o.maxResponseBytes) return finish({ ok: false, timedOut: false, error: `response larger than ${o.maxResponseBytes} bytes` });
        chunks.push(c);
      });
      res.on('error', (err) => finish({ ok: false, timedOut: false, error: err.message }));
      res.on('end', () => {
        const out: Record<string, string> = {};
        for (const [k, v] of Object.entries(res.headers)) if (v !== undefined) out[k] = Array.isArray(v) ? v.join(', ') : v;
        finish({
          ok: true,
          status: res.statusCode || 0,
          headers: out,
          contentType: res.headers['content-type'] || null,
          // Postgres text can't hold NUL characters.
          content: Buffer.concat(chunks).toString('utf8').replace(/\0/g, ''),
        });
      });
    });
    req.end(r.body || undefined);
  });
}
