import net from 'node:net';
import type os from 'node:os';

/**
 * Studio refuses connections from the edge-functions container: function
 * code never needs Studio. The container's address can change when it
 * restarts, so every address on its network counts, not just the one DNS
 * gave last: no other container there (database, gateway) calls Studio.
 *
 * Two addresses on that network are not refused: Studio's own, and the
 * network's first address, which Docker gives the host. Connections that go
 * through the host (a published port) arrive from a host address after
 * Docker's NAT, the same as a browser on the host itself, so Studio can't
 * tell them apart; function code is kept from the host's addresses by its
 * own sandbox (--deny-net) instead.
 */

type Net = { base: number; mask: number; self: number };

const v4 = (ip: string) => ip.split('.').reduce((n, p) => (n * 256 + Number(p)) >>> 0, 0);
const plain = (ip: string | undefined) => String(ip || '').replace(/^::ffff:/i, '');

/** Studio's own IPv4 networks that contain one of the functions container's addresses. */
export function functionNetworks(interfaces: ReturnType<typeof os.networkInterfaces>, functionIps: string[]): Net[] {
  const out: Net[] = [];
  const fns = functionIps.map(plain).filter((ip) => net.isIPv4(ip)).map(v4);
  for (const list of Object.values(interfaces)) {
    for (const i of list || []) {
      if (i.internal || i.family !== 'IPv4' || !i.cidr) continue;
      const bits = Number(i.cidr.split('/')[1]);
      // A /31 or /32 has no room for anyone else; a /8 or wider isn't a Docker network.
      if (!(bits >= 9 && bits <= 30)) continue;
      const mask = (0xffffffff << (32 - bits)) >>> 0;
      const self = v4(i.address);
      const base = (self & mask) >>> 0;
      if (fns.some((f) => ((f & mask) >>> 0) === base)) out.push({ base, mask, self });
    }
  }
  return out;
}

/** True when a connection comes from the functions container or another address on its network. */
export function isFunctionPeer(remote: string | undefined, functionIps: Set<string>, networks: Net[]): boolean {
  const ip = plain(remote);
  if (functionIps.has(ip)) return true;
  if (!net.isIPv4(ip)) return false;
  const n = v4(ip);
  return networks.some((x) => ((n & x.mask) >>> 0) === x.base && n !== x.self && n !== x.base + 1);
}
