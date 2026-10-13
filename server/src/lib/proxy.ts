import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';
import { log } from './log.js';

const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

const agent = new http.Agent({ keepAlive: true, maxSockets: 256 });

export type ProxyOptions = {
  /** Upstream base, e.g. http://keel-rest:3000 */
  target: string;
  /** Path (and query) to request upstream. */
  path: string;
  /** Headers to add or override; a value of null removes the header. */
  headers?: Record<string, string | null>;
  /** Response headers to drop before passing upstream headers on. */
  dropResponseHeaders?: (name: string) => boolean;
  /** Extra headers to set on the response. */
  responseHeaders?: Record<string, string>;
  /** Headers to set on the response only when upstream did not send them. */
  defaultResponseHeaders?: Record<string, string>;
  /** Connect to this unix socket instead of the target's host and port. */
  socketPath?: string;
  /** Give up on the upstream after this long and answer 504. */
  timeoutMs?: number;
  /** Body for the 502/504 answers, when the default doesn't fit the API. */
  errorBody?: (status: 502 | 504) => unknown;
};

function forwardHeaders(req: IncomingMessage, overrides: Record<string, string | null> = {}) {
  const out: Record<string, string | string[]> = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (v === undefined || HOP_BY_HOP.has(k)) continue;
    out[k] = v;
  }
  const remoteIp = req.socket.remoteAddress || '';
  const prior = req.headers['x-forwarded-for'];
  out['x-forwarded-for'] = prior ? `${prior}, ${remoteIp}` : remoteIp;
  if (!out['x-forwarded-proto']) out['x-forwarded-proto'] = 'http';
  if (!out['x-forwarded-host'] && req.headers.host) out['x-forwarded-host'] = req.headers.host;
  for (const [k, v] of Object.entries(overrides)) {
    if (v === null) delete out[k.toLowerCase()];
    else out[k.toLowerCase()] = v;
  }
  return out;
}

/**
 * Resolves the upstream URL. The host always comes from the configured
 * target; the path must be a plain absolute path. A path such as
 * "//other-host/x" or "/\\other-host" would otherwise be treated as a
 * scheme-relative URL and let callers pick the upstream host (SSRF).
 */
export function upstreamUrl(target: string, path: string): URL | null {
  if (!path.startsWith('/') || path.startsWith('//') || path.includes('\\') || /[\r\n\0]/.test(path)) return null;
  const base = new URL(target);
  const url = new URL(base.origin);
  const q = path.indexOf('?');
  url.pathname = q < 0 ? path : path.slice(0, q);
  url.search = q < 0 ? '' : path.slice(q);
  if (url.origin !== base.origin) return null;
  return url;
}

export function proxyRequest(req: IncomingMessage, res: ServerResponse, opts: ProxyOptions): Promise<void> {
  return new Promise((resolve) => {
    const target = upstreamUrl(opts.target, opts.path);
    if (!target) {
      const body = JSON.stringify({ error: 'bad_request', message: 'Invalid request path' });
      res.writeHead(400, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), ...(opts.responseHeaders || {}) });
      res.end(body);
      req.resume();
      return resolve();
    }
    const headers = forwardHeaders(req, opts.headers);
    if (!opts.socketPath) headers['host'] = target.host;
    let timedOut = false;
    const fail = (status: 502 | 504) => {
      if (!res.headersSent) {
        const body = JSON.stringify(
          opts.errorBody?.(status) ??
            (status === 504
              ? { error: 'gateway_timeout', message: 'Upstream took too long to respond' }
              : { error: 'bad_gateway', message: 'The service is not available right now' }),
        );
        res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), ...(opts.responseHeaders || {}) });
        res.end(body);
      } else {
        res.destroy();
      }
    };
    const upstream = http.request(
      {
        ...(opts.socketPath
          ? { socketPath: opts.socketPath }
          : { protocol: target.protocol, hostname: target.hostname, port: target.port }),
        method: req.method,
        path: target.pathname + target.search,
        headers,
        agent: opts.socketPath ? undefined : agent,
      },
      (up) => {
        const outHeaders: Record<string, string | string[]> = {};
        for (const [k, v] of Object.entries(up.headers)) {
          if (v === undefined || HOP_BY_HOP.has(k)) continue;
          if (opts.dropResponseHeaders?.(k)) continue;
          outHeaders[k] = v;
        }
        for (const [k, v] of Object.entries(opts.defaultResponseHeaders || {})) {
          if (outHeaders[k.toLowerCase()] === undefined) outHeaders[k] = v;
        }
        Object.assign(outHeaders, opts.responseHeaders || {});
        res.writeHead(up.statusCode || 502, outHeaders);
        up.pipe(res);
        up.on('end', () => {
          clearTimeout(timer);
          resolve();
        });
        up.on('error', () => {
          clearTimeout(timer);
          res.destroy();
          resolve();
        });
      },
    );
    const timer = opts.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          upstream.destroy(new Error('upstream timed out'));
        }, opts.timeoutMs)
      : undefined;
    upstream.on('error', (err) => {
      clearTimeout(timer);
      if (!timedOut) log.warn('upstream request failed', { target: opts.socketPath || target.origin, path: target.pathname, error: err.message });
      fail(timedOut ? 504 : 502);
      resolve();
    });
    res.on('close', () => {
      // The client went away: stop working on its behalf.
      if (!res.writableFinished) upstream.destroy();
    });
    req.pipe(upstream);
  });
}

/** Proxies a WebSocket (or any HTTP upgrade) to the target. */
export function proxyUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer, opts: ProxyOptions): void {
  const target = upstreamUrl(opts.target, opts.path);
  if (!target) return rejectUpgrade(socket, 400, 'invalid request path');
  const headers = forwardHeaders(req, opts.headers);
  if (!opts.socketPath) headers['host'] = target.host;
  headers['connection'] = 'Upgrade';
  headers['upgrade'] = String(req.headers.upgrade || 'websocket');

  const upstream = http.request({
    ...(opts.socketPath ? { socketPath: opts.socketPath } : { hostname: target.hostname, port: target.port }),
    method: req.method,
    path: target.pathname + target.search,
    headers,
  });

  upstream.on('upgrade', (upRes, upSocket, upHead) => {
    const lines = [`HTTP/1.1 ${upRes.statusCode} ${upRes.statusMessage}`];
    for (let i = 0; i < upRes.rawHeaders.length; i += 2) {
      lines.push(`${upRes.rawHeaders[i]}: ${upRes.rawHeaders[i + 1]}`);
    }
    socket.write(lines.join('\r\n') + '\r\n\r\n');
    if (upHead && upHead.length) socket.write(upHead);
    if (head && head.length) upSocket.write(head);
    upSocket.pipe(socket);
    socket.pipe(upSocket);
    const close = () => {
      upSocket.destroy();
      socket.destroy();
    };
    upSocket.on('error', close);
    socket.on('error', close);
    upSocket.on('close', close);
    socket.on('close', close);
  });

  upstream.on('response', (upRes) => {
    // Upstream refused the upgrade; relay its answer and close.
    const lines = [`HTTP/1.1 ${upRes.statusCode} ${upRes.statusMessage}`];
    for (let i = 0; i < upRes.rawHeaders.length; i += 2) {
      const name = upRes.rawHeaders[i].toLowerCase();
      if (HOP_BY_HOP.has(name)) continue;
      lines.push(`${upRes.rawHeaders[i]}: ${upRes.rawHeaders[i + 1]}`);
    }
    lines.push('Connection: close');
    socket.write(lines.join('\r\n') + '\r\n\r\n');
    upRes.pipe(socket);
  });

  upstream.on('error', (err) => {
    log.warn('upstream upgrade failed', { target: target.origin, error: err.message });
    socket.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
  });

  socket.on('error', () => upstream.destroy());
  upstream.end();
}

export function rejectUpgrade(socket: Duplex, status: number, message: string): void {
  const body = JSON.stringify({ error: message });
  socket.end(
    `HTTP/1.1 ${status} ${http.STATUS_CODES[status] || 'Error'}\r\n` +
      `Content-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`,
  );
}
