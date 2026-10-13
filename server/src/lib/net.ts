import dns from 'node:dns';
import fs from 'node:fs/promises';
import net from 'node:net';
import type { IncomingMessage } from 'node:http';

/**
 * "Your network": loopback, private LANs, Tailscale (100.64.0.0/10) and
 * link-local addresses, for IPv4 and IPv6.
 */
const PRIVATE_NETWORKS = [
  '127.0.0.0/8',
  '10.0.0.0/8',
  '172.16.0.0/12',
  '192.168.0.0/16',
  '100.64.0.0/10',
  '169.254.0.0/16',
  '::1/128',
  'fc00::/7',
  'fe80::/10',
];

const LOOPBACK = ['127.0.0.0/8', '::1/128'];

/**
 * Keel's own proxies, by their names on the Docker networks: the gateway (in
 * front of every API service) and keel-tunnel (Cloudflare Tunnel, in front of
 * the gateway and Studio).
 */
export const KEEL_PROXIES = ['keel-gateway', 'keel-tunnel'];
/** Requests that came through this one passed Cloudflare, which sets CF-Connecting-IP. */
export const TUNNEL_HOST = 'keel-tunnel';

/** Strips IPv4-mapped prefixes, brackets and zone IDs: "::ffff:10.0.0.2" -> "10.0.0.2". */
export function normalizeIp(ip: string): string {
  let s = ip.trim();
  if (s.startsWith('[') && s.includes(']')) s = s.slice(1, s.indexOf(']'));
  s = s.replace(/%.*$/, '');
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(s);
  return mapped ? mapped[1] : s;
}

/** Adds an address or CIDR range to a list; `setting` names the variable in errors. */
function addRange(list: net.BlockList, item: string, setting: string): void {
  const [addr, bits] = item.split('/');
  const ip = normalizeIp(addr);
  const type = net.isIPv6(ip) ? 'ipv6' : net.isIPv4(ip) ? 'ipv4' : null;
  if (!type) throw new Error(`${setting}: "${item}" is not an IP address or CIDR range`);
  if (bits === undefined) list.addAddress(ip, type);
  else list.addSubnet(ip, Number(bits), type);
}

/**
 * Parses KEEL_LOCAL_NETWORKS: comma-separated CIDRs or addresses, where
 * "private" stands for the list above and "none" for nothing.
 */
export function parseNetworks(spec: string): net.BlockList {
  const list = new net.BlockList();
  const items = spec
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .flatMap((s) => (s === 'private' ? PRIVATE_NETWORKS : s === 'none' ? [] : [s]));
  for (const item of items) addRange(list, item, 'KEEL_LOCAL_NETWORKS');
  return list;
}

export function isLocalAddress(ip: string, networks: net.BlockList): boolean {
  const a = normalizeIp(ip);
  if (net.isIPv4(a)) return networks.check(a, 'ipv4');
  if (net.isIPv6(a)) return networks.check(a, 'ipv6');
  return false;
}

/**
 * The key rate limits count an address under. An IPv6 client usually gets a
 * whole /64 from its provider, so it's counted per /64, not per address.
 */
export function addressKey(ip: string): string {
  const a = normalizeIp(ip);
  if (!net.isIPv6(a)) return a;
  // An embedded IPv4 tail ("64:ff9b::1.2.3.4") is two groups.
  const s = a.replace(/(\d+)\.(\d+)\.(\d+)\.(\d+)$/, (_, w, x, y, z) => `${((+w << 8) | +x).toString(16)}:${((+y << 8) | +z).toString(16)}`);
  const [head, tail] = s.split('::');
  const left = head ? head.split(':') : [];
  const right = tail ? tail.split(':') : [];
  const fill = tail === undefined ? 0 : 8 - left.length - right.length;
  const groups = [...left, ...Array(fill).fill('0'), ...right];
  return `${groups
    .slice(0, 4)
    .map((g) => (parseInt(g, 16) || 0).toString(16))
    .join(':')}::/64`;
}

/**
 * The Docker host as seen from inside a container, from the kernel's routing
 * table (/proc/net/route): every gateway, and the first address of every
 * network the container is on (where Docker puts the host's end of a bridge).
 * Addresses there are hex, least significant byte first.
 */
export function hostAddresses(table: string): string[] {
  const out = new Set<string>();
  const ip = (n: number) => [n & 255, (n >>> 8) & 255, (n >>> 16) & 255, n >>> 24].join('.');
  for (const line of table.split('\n').slice(1)) {
    const [, dest, gateway, flags, , , , mask] = line.trim().split(/\s+/);
    if (![dest, gateway, mask].every((h) => /^[0-9A-F]{8}$/i.test(h || ''))) continue;
    const g = parseInt(gateway, 16);
    // RTF_GATEWAY (0x2): a route through the host.
    if (parseInt(flags, 16) & 2 && g) out.add(ip(g));
    // A directly connected network, smaller than /30: its first address.
    const d = parseInt(dest, 16);
    const m = parseInt(mask, 16);
    if (!g && d && m && m >>> 24 < 0xfc) out.add(ip(d + 0x01000000));
  }
  return [...out];
}

const routeGateways = async () => hostAddresses(await fs.readFile('/proc/net/route', 'utf8').catch(() => ''));

/**
 * The networks this container is directly connected to (its Docker
 * networks), as CIDRs, from /proc/net/route and /proc/net/ipv6_route. IPv6
 * link-local networks and loopback are left out: every interface has them.
 */
export function connectedNetworks(v4: string, v6: string): string[] {
  const out: string[] = [];
  const ip = (n: number) => [n & 255, (n >>> 8) & 255, (n >>> 16) & 255, n >>> 24].join('.');
  for (const line of v4.split('\n').slice(1)) {
    const [, dest, gateway, , , , , mask] = line.trim().split(/\s+/);
    if (![dest, gateway, mask].every((h) => /^[0-9A-F]{8}$/i.test(h || ''))) continue;
    const m = parseInt(mask, 16);
    if (parseInt(gateway, 16) || !m) continue;
    // The mask is little-endian too; count its bits.
    const bits = m.toString(2).replace(/0/g, '').length;
    out.push(`${ip(parseInt(dest, 16))}/${bits}`);
  }
  for (const line of v6.split('\n')) {
    const [dest, plen, , , hop, , , , , dev] = line.trim().split(/\s+/);
    if (!/^[0-9a-f]{32}$/i.test(dest || '') || !/^0{32}$/.test(hop || '') || dev === 'lo') continue;
    const bits = parseInt(plen, 16);
    if (!(bits > 0 && bits < 128) || /^fe[89ab]/i.test(dest)) continue;
    const groups = dest.match(/.{4}/g)!.map((g) => parseInt(g, 16).toString(16));
    out.push(`${groups.join(':')}/${bits}`);
  }
  return out;
}

const routeNetworks = async () =>
  connectedNetworks(await fs.readFile('/proc/net/route', 'utf8').catch(() => ''), await fs.readFile('/proc/net/ipv6_route', 'utf8').catch(() => ''));

type Lookup = (name: string) => Promise<string[]>;
// With a trailing dot the resolver doesn't try the search domains, so
// "keel-tunnel" never becomes keel-tunnel.<your router's domain>.
const dnsLookup: Lookup = async (name) => (await dns.promises.lookup(name.endsWith('.') ? name : `${name}.`, { all: true })).map((a) => a.address);

/**
 * The proxies whose X-Forwarded-For is believed: always Keel's own
 * (keel-gateway, keel-tunnel and this container itself), plus those in
 * KEEL_TRUSTED_PROXIES: comma-separated addresses, CIDR ranges and container
 * names, and
 *   host      the Docker host, for a reverse proxy running on the server
 *             itself (Caddy, nginx, tailscale serve) in front of a port
 *             published on 127.0.0.1
 *   private   every private address (how Keel behaved before this setting)
 * Names are looked up through Docker's DNS and refreshed, since container
 * addresses change when they restart. An address counts only when it is on
 * one of this container's own networks (and isn't the Docker host's end of
 * one): when a container isn't running, Docker passes its name on to the
 * LAN's DNS, where any device could have taken it.
 */
export class ProxyTrust {
  private fixed = new net.BlockList();
  private names: string[] = [];
  private host = false;
  private dynamic = new Set<string>();
  private tunnel = new Set<string>();
  private refreshedAt = 0;
  private refreshing: Promise<void> | null = null;

  constructor(
    spec: string,
    private lookup: Lookup = dnsLookup,
    private gateways: () => Promise<string[]> = routeGateways,
    private networks: () => Promise<string[]> = routeNetworks,
  ) {
    LOOPBACK.forEach((r) => addRange(this.fixed, r, 'KEEL_TRUSTED_PROXIES'));
    this.names.push(...KEEL_PROXIES);
    for (const item of spec.split(',').map((s) => s.trim()).filter(Boolean)) {
      if (item === 'keel') continue;
      else if (item === 'private') PRIVATE_NETWORKS.forEach((r) => addRange(this.fixed, r, 'KEEL_TRUSTED_PROXIES'));
      else if (item === 'host') this.host = true;
      else if (/^[0-9a-f.:[\]%]+(\/\d+)?$/i.test(item)) addRange(this.fixed, item, 'KEEL_TRUSTED_PROXIES');
      else if (/^[A-Za-z0-9]([A-Za-z0-9_.-]{0,252})$/.test(item)) this.names.push(item);
      else throw new Error(`KEEL_TRUSTED_PROXIES: "${item}" is not an address, CIDR range or container name`);
    }
  }

  trusts(ip: string): boolean {
    const a = normalizeIp(ip);
    if (!net.isIP(a)) return false;
    if (isLocalAddress(a, this.fixed) || this.dynamic.has(a)) return true;
    // An unknown peer may be a proxy that just restarted with a new address.
    void this.refresh(5_000);
    return false;
  }

  /** True for keel-tunnel's addresses. */
  isTunnel(ip: string): boolean {
    return this.tunnel.has(normalizeIp(ip));
  }

  /** Looks the names up again, at most once per `minAgeMs`. */
  refresh(minAgeMs = 0): Promise<void> {
    if (this.refreshing) return this.refreshing;
    if (Date.now() - this.refreshedAt < minAgeMs) return Promise.resolve();
    this.refreshing = (async () => {
      const dynamic = new Set<string>();
      const tunnel = new Set<string>();
      const own = new net.BlockList();
      for (const n of await this.networks().catch(() => [] as string[])) addRange(own, n, 'routing table');
      const hostEnds = new Set((await this.gateways().catch(() => [] as string[])).map(normalizeIp));
      for (const name of this.names) {
        const found = await this.lookup(name).catch(() => [] as string[]);
        for (const a of found.map(normalizeIp)) {
          if (!isLocalAddress(a, own) || hostEnds.has(a)) continue;
          dynamic.add(a);
          if (name === TUNNEL_HOST) tunnel.add(a);
        }
      }
      if (this.host) for (const a of hostEnds) dynamic.add(a);
      this.dynamic = dynamic;
      this.tunnel = tunnel;
      this.refreshedAt = Date.now();
    })().finally(() => {
      this.refreshing = null;
    });
    return this.refreshing;
  }
}

/**
 * Headers only a CDN or tunnel edge adds (Cloudflare and similar). A request
 * carrying one never counts as local, even when the edge was told to drop the
 * visitor's address ("Remove visitor IP headers"). Forging one only makes a
 * request look less trusted, so they're honoured from anyone.
 */
// tailscale serve marks requests that came in through Funnel (from the
// internet) with Tailscale-Funnel-Request and drops any copy a client sent.
const EDGE_HEADERS = ['cf-ray', 'cf-connecting-ip', 'cf-visitor', 'cdn-loop', 'true-client-ip', 'fly-client-ip', 'tailscale-funnel-request'];

export type Origin = { address: string; local: boolean };

/**
 * Who made the request, also behind reverse proxies and tunnels (the
 * gateway, Cloudflare Tunnel, Caddy, tailscale serve), and whether they are
 * on your network.
 *
 * Each proxy appends the address it received the request from to
 * X-Forwarded-For, so the chain is read from the right, past trusted proxies
 * only. The first address that isn't one is the client: the proxy to its
 * right wrote it. Entries further left came from the client (or a proxy we
 * don't trust) and are never believed.
 *
 * The client is local only when it's on the local network and nobody we
 * don't trust forwarded the request: an untrusted hop that sends
 * X-Forwarded-For is a proxy for someone else or a client forging addresses,
 * and either way counts as the internet. Through keel-tunnel the visitor's
 * address is Cloudflare's CF-Connecting-IP.
 */
export function requestOrigin(req: IncomingMessage, networks: net.BlockList, trust: ProxyTrust): Origin {
  const fwd = req.headers['x-forwarded-for'];
  const chain = (Array.isArray(fwd) ? fwd.join(',') : fwd || '')
    .split(',')
    .map((s) => normalizeIp(s))
    .filter(Boolean);
  chain.push(normalizeIp(req.socket.remoteAddress || ''));
  let i = chain.length - 1;
  let viaTunnel = false;
  while (i > 0 && trust.trusts(chain[i])) {
    viaTunnel ||= trust.isTunnel(chain[i]);
    i--;
  }
  // Every hop was a trusted proxy: the request started at one of them.
  if (i === 0 && trust.trusts(chain[0])) viaTunnel ||= trust.isTunnel(chain[0]);
  if (viaTunnel) {
    const cf = normalizeIp(String(req.headers['cf-connecting-ip'] || ''));
    if (net.isIP(cf)) return { address: cf, local: false };
  }
  const address = chain[i];
  // Not an address (written by a broken proxy): count the proxy that passed it on.
  if (!net.isIP(address)) return { address: chain[Math.min(i + 1, chain.length - 1)], local: false };
  const edge = EDGE_HEADERS.some((h) => req.headers[h] !== undefined);
  return { address, local: i === 0 && !edge && !viaTunnel && isLocalAddress(address, networks) };
}

/** The address part of requestOrigin(). */
export function requestAddress(req: IncomingMessage, networks: net.BlockList, trust: ProxyTrust): string {
  return requestOrigin(req, networks, trust).address;
}

/**
 * The peer's address when it forwards requests for others (sends
 * X-Forwarded-For) from your network but isn't a trusted proxy: most likely
 * a reverse proxy the owner runs (Nginx Proxy Manager, Traefik, Caddy) and
 * forgot to list in KEEL_TRUSTED_PROXIES. Every visitor then shares its
 * rate-limit key. Null otherwise.
 */
export function untrustedForwarder(req: IncomingMessage, networks: net.BlockList, trust: ProxyTrust): string | null {
  if (req.headers['x-forwarded-for'] === undefined) return null;
  const peer = normalizeIp(req.socket.remoteAddress || '');
  return isLocalAddress(peer, networks) && !trust.trusts(peer) ? peer : null;
}

/** True when the request came straight from a trusted proxy (whose forwarding headers can be believed). */
export function fromTrustedProxy(req: IncomingMessage, trust: ProxyTrust): boolean {
  return trust.trusts(req.socket.remoteAddress || '');
}

/** The host name in a Host header, without port, brackets or trailing dot, in lower case. */
export function hostName(header: string): string {
  const h = header.trim().toLowerCase();
  const bracketed = /^\[([^\]]+)\](:\d+)?$/.exec(h);
  if (bracketed) return bracketed[1];
  // A bare IPv6 address has several colons; anything else may end in :port.
  return (h.split(':').length > 2 ? h : h.replace(/:\d*$/, '')).replace(/\.$/, '');
}

/**
 * Names nobody can point at your network from the public DNS: one-label
 * names ("nas"), mDNS (.local) and the suffixes routers and Tailscale hand
 * out. DNS rebinding needs a name the attacker controls, so these are safe.
 */
const LOCAL_SUFFIXES = ['.localhost', '.local', '.lan', '.home', '.home.arpa', '.internal', '.ts.net'];

/**
 * Whether a Host header names this server: an IP address, localhost, a name
 * that only resolves on your own network (see above), or one of `known`
 * (KEEL_STUDIO_HOSTS, the public addresses). "*" in `known` allows any.
 */
export function isKnownHost(header: string | undefined, known: string[]): boolean {
  if (!header) return false;
  const name = hostName(header);
  if (!name) return false;
  if (net.isIP(name) || name === 'localhost' || !name.includes('.')) return true;
  if (LOCAL_SUFFIXES.some((s) => name.endsWith(s))) return true;
  return known.some((k) => {
    const n = hostName(k);
    return n === '*' || n === name || (n.startsWith('*.') && name.endsWith(n.slice(1)));
  });
}
