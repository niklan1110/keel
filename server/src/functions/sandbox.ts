import http from 'node:http';
import net from 'node:net';
import { proxyRequest, proxyUpgrade, rejectUpgrade } from '../lib/proxy.js';

/**
 * Network rules for function code (Deno's --deny-net).
 *
 * Function code may reach the internet, but no private or special address:
 * not Keel's containers, not the Docker host (whose published ports include
 * Studio and Postgres), not the LAN, not cloud metadata. Deno checks these
 * ranges against the address a name resolves to when it connects, so other
 * names for the same address (container aliases, <ip>.nip.io) are refused too.
 * Function code reaches this Keel's API through a unix socket instead (see
 * serveGatewaySocket), which needs no network permission.
 */
export const DENIED_RANGES = [
  '0.0.0.0/8', // "this network"; 0.0.0.0 reaches this machine
  '10.0.0.0/8', // private
  '100.64.0.0/10', // carrier-grade NAT, Tailscale
  '127.0.0.0/8', // loopback
  '169.254.0.0/16', // link-local, cloud metadata
  '172.16.0.0/12', // private, Docker networks
  '192.0.0.0/24', // IETF protocol assignments
  '192.168.0.0/16', // private
  '198.18.0.0/15', // benchmarking, used by some VPNs and Docker Desktop
  '224.0.0.0/4', // multicast
  '240.0.0.0/4', // reserved, broadcast
];

/**
 * Deno 2 has no syntax for IPv6 ranges in --deny-net, so IPv6 is refused
 * address by address. Keel's Docker networks are IPv4 only; keel-functions
 * warns when it finds a routable IPv6 address of its own.
 */
export const DENIED_IPV6 = ['::', '::1'];

/** IPv6 addresses whose range Deno can't deny: link-local, unique local. */
export const isPrivateIpv6 = (ip: string) => net.isIPv6(ip) && /^(fe[89ab]|f[cd])/i.test(ip);

/** An IPv4 block: a single address is a /32. */
export type Block = { base: number; bits: number };

const v4num = (ip: string) => ip.split('.').reduce((n, p) => n * 256 + Number(p), 0);
const v4str = (n: number) => [24, 16, 8, 0].map((s) => Math.floor(n / 2 ** s) % 256).join('.');
const size = (b: Block) => 2 ** (32 - b.bits);

/** Parses "a.b.c.d" or "a.b.c.d/nn" (the address is rounded down to the block's start). */
export function parseBlock(s: string): Block | null {
  const [ip, bits = '32', extra] = s.trim().split('/');
  if (extra !== undefined || !net.isIPv4(ip) || !/^\d{1,2}$/.test(bits) || Number(bits) > 32) return null;
  const b = Number(bits);
  return { base: v4num(ip) - (v4num(ip) % 2 ** (32 - b)), bits: b };
}

export const formatBlock = (b: Block) => `${v4str(b.base)}/${b.bits}`;

/** True when `inner` lies entirely inside `outer`. */
export const blockContains = (outer: Block, inner: Block) => inner.base >= outer.base && inner.base + size(inner) <= outer.base + size(outer);

/**
 * A block minus another, as the fewest blocks that cover what's left: the
 * block is halved until the part taken out is reached, keeping each other
 * half. Taking one address out of a /16 leaves 16 blocks.
 */
export function subtractBlock(from: Block, take: Block): Block[] {
  if (blockContains(take, from)) return [];
  if (!blockContains(from, take)) return [from];
  const out: Block[] = [];
  let cur = from;
  while (cur.bits < take.bits) {
    const lo = { base: cur.base, bits: cur.bits + 1 };
    const hi = { base: cur.base + size(lo), bits: cur.bits + 1 };
    if (blockContains(lo, take)) {
      out.push(hi);
      cur = lo;
    } else {
      out.push(lo);
      cur = hi;
    }
  }
  return out;
}

/** LAN ranges a function may be allowed into (KEEL_FUNCTIONS_ALLOW_LAN). */
const LAN_RANGES = ['10.0.0.0/8', '100.64.0.0/10', '172.16.0.0/12', '192.168.0.0/16'].map((r) => parseBlock(r)!);
/** Ranges wider than this can't be allowed: a /24 is a whole home network already. */
export const ALLOW_LAN_MIN_BITS = 24;

export type AllowEntry = { entry: string; block: Block; port?: number };

/**
 * Parses KEEL_FUNCTIONS_ALLOW_LAN: comma separated LAN addresses with an
 * optional port (192.168.1.50:11434) or small ranges (192.168.1.48/29).
 * Deno can't refuse an address except on one port, so a port is accepted
 * but doesn't narrow anything: every port of an allowed address is open.
 *
 * A range almost always holds the server's own LAN address, which Keel can
 * only keep closed when it knows it (KEEL_HOST_ADDRESSES): without that,
 * `ranges` is false and only single addresses are taken.
 */
export function parseAllowLan(value: string, opts: { ranges: boolean }): { allowed: AllowEntry[]; refused: { entry: string; reason: string }[] } {
  const allowed: AllowEntry[] = [];
  const refused: { entry: string; reason: string }[] = [];
  for (const entry of value.split(',').map((x) => x.trim()).filter(Boolean)) {
    const m = /^(\d+\.\d+\.\d+\.\d+(?:\/\d{1,2})?)(?::(\d{1,5}))?$/.exec(entry);
    const block = m ? parseBlock(m[1]) : null;
    const port = m?.[2] ? Number(m[2]) : undefined;
    if (!m || !block || (port !== undefined && !(port >= 1 && port <= 65535))) {
      refused.push({ entry, reason: 'not an IPv4 address, address:port or address/bits' });
    } else if (!LAN_RANGES.some((r) => blockContains(r, block))) {
      refused.push({ entry, reason: 'only addresses in 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16 and 100.64.0.0/10 can be allowed (public addresses need no entry)' });
    } else if (block.bits < ALLOW_LAN_MIN_BITS) {
      refused.push({ entry, reason: `ranges wider than /${ALLOW_LAN_MIN_BITS} can't be allowed` });
    } else if (block.bits < 32 && !opts.ranges) {
      refused.push({ entry, reason: "ranges need KEEL_HOST_ADDRESSES (this server's own LAN addresses, so they stay closed); list single addresses instead" });
    } else {
      allowed.push(port === undefined ? { entry, block } : { entry, block, port });
    }
  }
  return { allowed, refused };
}

/** Drops allowed entries that touch a block that must stay closed (the Docker host, Keel's network, Keel's containers). */
export function keepAllowed(allowed: AllowEntry[], forbidden: Block[]): { kept: AllowEntry[]; refused: { entry: string; reason: string }[] } {
  const kept: AllowEntry[] = [];
  const refused: { entry: string; reason: string }[] = [];
  for (const a of allowed) {
    if (forbidden.some((f) => blockContains(f, a.block) || blockContains(a.block, f))) {
      refused.push({ entry: a.entry, reason: "it is this server, Keel's own network or one of Keel's containers" });
    } else kept.push(a);
  }
  return { kept, refused };
}

/** The default gateway (the Docker host) from the text of /proc/net/route. */
export function defaultGateway(route: string): string | null {
  const row = route.split('\n').slice(1).map((l) => l.trim().split(/\s+/)).find((c) => c[1] === '00000000' && /^[0-9A-F]{8}$/i.test(c[2] || ''));
  if (!row) return null;
  // Little-endian: 010014AC is 172.20.0.1.
  return [6, 4, 2, 0].map((i) => parseInt(row[2].slice(i, i + 2), 16)).join('.');
}

/**
 * The --deny-net value: the fixed ranges, minus any allowed LAN blocks, plus
 * single addresses (this container's, the host's public address and
 * anything else to keep out). Single addresses always stay denied, even
 * inside an allowed block. IPv4 addresses inside a denied range are left
 * out; IPv6 ones are bracketed.
 */
export function denyNetList(addresses: Iterable<string>, allow: Block[] = []): string {
  let ranges = DENIED_RANGES.map((r) => parseBlock(r)!);
  for (const a of allow) ranges = ranges.flatMap((r) => subtractBlock(r, a));
  const out = new Set<string>(ranges.map(formatBlock));
  const inRanges = (ip: string) => ranges.some((r) => blockContains(r, parseBlock(ip)!));
  for (const raw of [...DENIED_IPV6, ...addresses]) {
    const a = raw.trim().replace(/^\[|\]$/g, '').replace(/%.*$/, '');
    if (net.isIPv4(a)) {
      if (!inRanges(a)) out.add(a);
    } else if (net.isIPv6(a)) {
      const v4 = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(a)?.[1];
      if (v4) {
        if (!inRanges(v4)) out.add(v4);
      } else out.add(`[${a}]`);
    } else if (parseBlock(a) && a.includes('/')) {
      out.add(formatBlock(parseBlock(a)!));
    }
  }
  return [...out].join(',');
}

/**
 * The gateway path for a request function code sent to its gateway socket,
 * or null when it isn't for the function's own project. Deno sends the
 * request line in absolute form (http://keel-gateway:8000/my-app/rest/v1/...)
 * since the socket acts as its proxy; only the path and query are kept.
 */
export function gatewayPath(project: string, raw: string): string | null {
  if (!raw || raw.startsWith('//') || raw.includes('\\') || /[\r\n\0]/.test(raw)) return null;
  let u: URL;
  try {
    u = new URL(raw, 'http://keel-gateway.invalid');
  } catch {
    return null;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'ws:') return null;
  // The URL parser has already resolved "." and ".." segments (including %2e).
  if (u.pathname !== `/${project}` && !u.pathname.startsWith(`/${project}/`)) return null;
  return u.pathname + u.search;
}

/**
 * Serves one function's way to the API: a unix socket in the function's own
 * temporary folder that forwards to the gateway, for the function's project
 * only. Headers that could pose as another client (X-Forwarded-*) are dropped.
 */
export function serveGatewaySocket(socketPath: string, project: string, gateway: string, timeoutMs: number): Promise<http.Server> {
  const strip = { 'x-forwarded-for': null, 'x-forwarded-host': null, 'x-forwarded-proto': null, 'x-real-ip': null, forwarded: null };
  const deny = (res: http.ServerResponse) => {
    const body = JSON.stringify({ error: 'forbidden', message: `Functions can only call their own project's API (/${project}/...)` });
    res.writeHead(403, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
    res.end(body);
  };
  const server = http.createServer((req, res) => {
    const path = gatewayPath(project, req.url || '');
    if (!path) {
      req.resume();
      return deny(res);
    }
    void proxyRequest(req, res, { target: gateway, path, headers: strip, timeoutMs });
  });
  server.on('upgrade', (req, socket, head) => {
    const path = gatewayPath(project, req.url || '');
    if (!path) return rejectUpgrade(socket, 403, 'Functions can only call their own project');
    proxyUpgrade(req, socket, head, { target: gateway, path, headers: strip });
  });
  // The socket acts as an HTTP proxy for Deno; tunnels (CONNECT) aren't offered.
  server.on('connect', (_req, socket) => rejectUpgrade(socket, 405, 'CONNECT is not supported'));
  server.on('clientError', (_err, socket) => socket.destroy());
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, () => {
      server.off('error', reject);
      resolve(server);
    });
  });
}
