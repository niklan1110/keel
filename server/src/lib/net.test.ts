import assert from 'node:assert/strict';
import type { IncomingMessage } from 'node:http';
import test from 'node:test';
import { ProxyTrust, addressKey, connectedNetworks, fromTrustedProxy, hostAddresses, hostName, isKnownHost, isLocalAddress, normalizeIp, parseNetworks, requestAddress, requestOrigin, untrustedForwarder } from './net.js';

const req = (socket: string, xff?: string, extra: Record<string, string> = {}) =>
  ({ headers: { ...(xff === undefined ? {} : { 'x-forwarded-for': xff }), ...extra }, socket: { remoteAddress: socket } }) as unknown as IncomingMessage;

// Keel's proxies as Docker's DNS would report them.
const GATEWAY = '172.18.0.7';
const TUNNEL = '172.19.0.3';
const noDns = async () => [] as string[];
const lookup = async (name: string) => ({ 'keel-gateway': [GATEWAY], 'keel-tunnel': [TUNNEL], caddy: ['172.18.0.9'] })[name] ?? [];
// The networks this container is on, as the routing table would list them.
const connected = async () => ['172.18.0.0/16', '172.19.0.0/16'];
const docker = async () => {
  const t = new ProxyTrust('', lookup, async () => ['172.18.0.1'], connected);
  await t.refresh();
  return t;
};

test('local networks: private ranges, Tailscale, IPv6, custom lists', () => {
  const priv = parseNetworks('private');
  for (const ip of ['127.0.0.1', '10.1.2.3', '172.20.0.5', '192.168.1.20', '100.101.102.103', '::1', 'fd7a:115c:a1e0::1', '::ffff:192.168.1.9']) {
    assert.equal(isLocalAddress(ip, priv), true, ip);
  }
  for (const ip of ['8.8.8.8', '172.32.0.1', '100.128.0.1', '2001:4860::8888', 'unknown', '']) {
    assert.equal(isLocalAddress(ip, priv), false, ip);
  }
  const custom = parseNetworks('192.168.1.0/24, 203.0.113.7');
  assert.equal(isLocalAddress('192.168.1.50', custom), true);
  assert.equal(isLocalAddress('192.168.2.50', custom), false);
  assert.equal(isLocalAddress('203.0.113.7', custom), true);
  assert.equal(isLocalAddress('127.0.0.1', parseNetworks('none')), false);
  assert.throws(() => parseNetworks('my-lan'), /KEEL_LOCAL_NETWORKS/);
  assert.equal(normalizeIp('[::1]'), '::1');
});

test('trusted proxies: keywords, ranges and container names', async () => {
  const t = await docker();
  for (const ip of ['127.0.0.1', '::1', GATEWAY, TUNNEL]) assert.equal(t.trusts(ip), true, ip);
  // Other containers, the Docker host and the LAN are not proxies.
  for (const ip of ['172.18.0.1', '172.18.0.5', '192.168.1.5', '203.0.113.9', 'junk']) assert.equal(t.trusts(ip), false, ip);
  assert.equal(t.isTunnel(TUNNEL), true);
  assert.equal(t.isTunnel(GATEWAY), false);

  const host = new ProxyTrust('host, 10.9.0.0/16, caddy', lookup, async () => ['172.18.0.1'], connected);
  await host.refresh();
  for (const ip of ['172.18.0.1', '10.9.4.4', '172.18.0.9']) assert.equal(host.trusts(ip), true, ip);
  // Keel's own proxies are always trusted.
  for (const ip of ['127.0.0.1', GATEWAY]) assert.equal(host.trusts(ip), true, ip);
  assert.equal(new ProxyTrust('', noDns).trusts('192.168.1.5'), false);
  assert.equal(new ProxyTrust('private', noDns).trusts('192.168.1.5'), true);
  assert.throws(() => new ProxyTrust('not a proxy!'), /KEEL_TRUSTED_PROXIES/);
});

test("a proxy name counts only where it resolves to one of this container's own networks", async () => {
  // keel-tunnel isn't running, so the name went upstream to a router that
  // answers with a LAN device that called itself keel-tunnel.
  const upstream = async (name: string) => ({ 'keel-gateway': [GATEWAY], 'keel-tunnel': ['192.168.1.66'], caddy: ['10.20.0.4'], 'keel-host': ['172.18.0.1'] })[name] ?? [];
  const t = new ProxyTrust('caddy, keel-host', upstream, async () => ['172.18.0.1'], connected);
  await t.refresh();
  assert.equal(t.trusts(GATEWAY), true);
  for (const ip of ['192.168.1.66', '10.20.0.4']) assert.equal(t.trusts(ip), false, ip);
  assert.equal(t.isTunnel('192.168.1.66'), false);
  // Nor the Docker host's end of a network, unless "host" was asked for.
  assert.equal(t.trusts('172.18.0.1'), false);
  // Outside Docker (no routing table) no name is trusted.
  const bare = new ProxyTrust('', lookup, async () => [], async () => []);
  await bare.refresh();
  assert.equal(bare.trusts(GATEWAY), false);
});

test('connectedNetworks reads the directly connected networks from the routing tables', () => {
  const v4 = [
    'Iface\tDestination\tGateway \tFlags\tRefCnt\tUse\tMetric\tMask\t\tMTU\tWindow\tIRTT',
    'eth0\t00000000\t010012AC\t0003\t0\t0\t0\t00000000\t0\t0\t0',
    'eth0\t000012AC\t00000000\t0001\t0\t0\t0\t0000FFFF\t0\t0\t0',
    'eth1\t0000A8C0\t00000000\t0001\t0\t0\t0\t00FFFFFF\t0\t0\t0',
  ].join('\n');
  const v6 = [
    'fd000000000000000000000000000000 40 00000000000000000000000000000000 00 00000000000000000000000000000000 00000100 00000001 00000000 00000001     eth0',
    'fe800000000000000000000000000000 40 00000000000000000000000000000000 00 00000000000000000000000000000000 00000100 00000001 00000000 00000001     eth0',
    '00000000000000000000000000000000 00 00000000000000000000000000000000 00 fd000000000000000000000000000001 00000400 00000001 00000000 00000003     eth0',
    '00000000000000000000000000000001 80 00000000000000000000000000000000 00 00000000000000000000000000000000 00000000 00000002 00000000 80200001       lo',
  ].join('\n');
  // Not the link-local network every interface has, nor routes through a gateway.
  assert.deepEqual(connectedNetworks(v4, v6), ['172.18.0.0/16', '192.168.0.0/24', 'fd00:0:0:0:0:0:0:0/64']);
  assert.deepEqual(connectedNetworks('', ''), []);
});

test('trusted proxies follow a container to its new address', async () => {
  let gateway = '172.18.0.7';
  const t = new ProxyTrust('', async (name) => (name === 'keel-gateway' ? [gateway] : []), async () => [], connected);
  await t.refresh();
  assert.equal(t.trusts('172.18.0.7'), true);
  gateway = '172.18.0.12';
  await t.refresh();
  assert.equal(t.trusts('172.18.0.12'), true);
  assert.equal(t.trusts('172.18.0.7'), false);
});

test('requestAddress reads X-Forwarded-For from the right, past trusted proxies only', async () => {
  const priv = parseNetworks('private');
  const t = await docker();
  // Direct connections.
  assert.equal(requestAddress(req('192.168.1.5'), priv, t), '192.168.1.5');
  assert.equal(requestAddress(req('::ffff:203.0.113.9'), priv, t), '203.0.113.9');
  // Through the gateway.
  assert.equal(requestAddress(req(GATEWAY, '203.0.113.9'), priv, t), '203.0.113.9');
  assert.equal(requestAddress(req(GATEWAY, '192.168.1.5'), priv, t), '192.168.1.5');
  // A client can't pick its address through a proxy: the proxy appends the real one.
  assert.equal(requestAddress(req(GATEWAY, '10.0.0.1, 203.0.113.9'), priv, t), '203.0.113.9');
  // A direct client's own X-Forwarded-For is ignored, private peer or not.
  assert.equal(requestAddress(req('203.0.113.9', '10.0.0.1'), priv, t), '203.0.113.9');
  assert.equal(requestAddress(req('172.18.0.1', '10.0.0.1'), priv, t), '172.18.0.1');
  // Two forged addresses from the same peer share its key.
  assert.equal(requestAddress(req(GATEWAY, `10.1.1.1, 172.18.0.1`), priv, t), '172.18.0.1');
  assert.equal(requestAddress(req(GATEWAY, `10.2.2.2, 172.18.0.1`), priv, t), '172.18.0.1');
  // Until the gateway's address is known, only the socket counts.
  assert.equal(requestAddress(req(GATEWAY, '203.0.113.9'), priv, new ProxyTrust('', noDns)), GATEWAY);
});

test('requestOrigin: only an address no untrusted hop forwarded can be local', async () => {
  const priv = parseNetworks('private');
  const t = await docker();
  // A LAN browser, directly or through the gateway.
  assert.deepEqual(requestOrigin(req('192.168.1.5'), priv, t), { address: '192.168.1.5', local: true });
  assert.deepEqual(requestOrigin(req(GATEWAY, '192.168.1.5'), priv, t), { address: '192.168.1.5', local: true });
  // A forged private address from a peer that isn't a trusted proxy (the
  // Docker host's userland proxy, a port forwarder, a client) is the internet.
  assert.deepEqual(requestOrigin(req('172.18.0.1', '192.168.1.5'), priv, t), { address: '172.18.0.1', local: false });
  assert.deepEqual(requestOrigin(req(GATEWAY, '192.168.1.5, 172.18.0.1'), priv, t), { address: '172.18.0.1', local: false });
  assert.deepEqual(requestOrigin(req('192.168.1.5', '10.0.0.1'), priv, t), { address: '192.168.1.5', local: false });
  // The internet through the gateway.
  assert.deepEqual(requestOrigin(req(GATEWAY, '203.0.113.9'), priv, t), { address: '203.0.113.9', local: false });
  // Under the old "private networks are proxies" rule, the forged address won.
  assert.deepEqual(requestOrigin(req('172.18.0.1', '10.0.0.1'), priv, new ProxyTrust('private', noDns)), { address: '10.0.0.1', local: true });
});

test('requestOrigin: Cloudflare Tunnel uses CF-Connecting-IP and is always the internet', async () => {
  const priv = parseNetworks('private');
  const t = await docker();
  const cf = (ip: string) => ({ 'cf-ray': 'x', 'cf-connecting-ip': ip });
  // keel-tunnel straight to Studio, or to the gateway.
  assert.deepEqual(requestOrigin(req(TUNNEL, '203.0.113.9', cf('203.0.113.9')), priv, t), { address: '203.0.113.9', local: false });
  // ...and on to a service behind the gateway.
  assert.deepEqual(requestOrigin(req(GATEWAY, `203.0.113.9, ${TUNNEL}`, cf('203.0.113.9')), priv, t), { address: '203.0.113.9', local: false });
  // Cloudflare's address wins over X-Forwarded-For, which Cloudflare only appends to.
  assert.deepEqual(requestOrigin(req(TUNNEL, '10.0.0.1, 203.0.113.9', cf('203.0.113.9')), priv, t), { address: '203.0.113.9', local: false });
  // "Remove visitor IP headers": no address left, still the internet, keyed by the tunnel.
  assert.deepEqual(requestOrigin(req(TUNNEL, undefined, { 'cf-ray': 'x' }), priv, t), { address: TUNNEL, local: false });
  // CF-Connecting-IP from anyone but the tunnel is ignored (it would let clients pick their key).
  assert.deepEqual(requestOrigin(req(GATEWAY, '203.0.113.9', cf('198.51.100.1')), priv, t), { address: '203.0.113.9', local: false });
  assert.deepEqual(requestOrigin(req('203.0.113.9', undefined, cf('198.51.100.1')), priv, t), { address: '203.0.113.9', local: false });
  // Edge headers from a LAN client make it the internet, never the other way round.
  assert.deepEqual(requestOrigin(req('192.168.1.5', undefined, { 'cdn-loop': 'cloudflare' }), priv, t), { address: '192.168.1.5', local: false });
});

test('fromTrustedProxy looks at the socket only', async () => {
  const t = await docker();
  assert.equal(fromTrustedProxy(req(GATEWAY), t), true);
  assert.equal(fromTrustedProxy(req('192.168.1.5', GATEWAY), t), false);
});

test('addressKey counts IPv6 clients per /64', () => {
  assert.equal(addressKey('203.0.113.9'), '203.0.113.9');
  assert.equal(addressKey('::ffff:203.0.113.9'), '203.0.113.9');
  assert.equal(addressKey('2001:db8:1:2:aaaa::1'), '2001:db8:1:2::/64');
  assert.equal(addressKey('2001:db8:1:2:bbbb:cccc:dddd:eeee'), '2001:db8:1:2::/64');
  assert.equal(addressKey('2001:0db8:0001:0002::'), '2001:db8:1:2::/64');
  assert.equal(addressKey('2001:db8::1'), '2001:db8:0:0::/64');
  assert.equal(addressKey('::1'), '0:0:0:0::/64');
  assert.equal(addressKey('64:ff9b::192.0.2.33'), '64:ff9b:0:0::/64');
  assert.notEqual(addressKey('2001:db8:1:2::1'), addressKey('2001:db8:1:3::1'));
});

test('hostAddresses reads the Docker host from the routing table', () => {
  const table = [
    'Iface\tDestination\tGateway \tFlags\tRefCnt\tUse\tMetric\tMask\t\tMTU\tWindow\tIRTT',
    'eth0\t00000000\t010012AC\t0003\t0\t0\t0\t00000000\t0\t0\t0',
    'eth0\t000012AC\t00000000\t0001\t0\t0\t0\t0000FFFF\t0\t0\t0',
    'eth1\t000014AC\t00000000\t0001\t0\t0\t0\t0000FFFF\t0\t0\t0',
    'eth2\t0800A8C0\t00000000\t0001\t0\t0\t0\t FCFFFFFF\t0\t0\t0',
  ].join('\n');
  assert.deepEqual(hostAddresses(table), ['172.18.0.1', '172.20.0.1']);
  assert.deepEqual(hostAddresses(''), []);
});

test('what the gateway forwards keeps its verdict for the services behind it', async () => {
  const priv = parseNetworks('private');
  const t = await docker();
  // The gateway sends only the client it settled on, with "unknown" in front
  // of a private address it didn't count as local.
  assert.deepEqual(requestOrigin(req(GATEWAY, '192.168.1.5'), priv, t), { address: '192.168.1.5', local: true });
  assert.deepEqual(requestOrigin(req(GATEWAY, 'unknown, 172.18.0.1'), priv, t), { address: '172.18.0.1', local: false });
  // Also when the service trusts that address as a proxy itself.
  const host = new ProxyTrust('host', lookup, async () => ['172.18.0.1'], connected);
  await host.refresh();
  assert.deepEqual(requestOrigin(req(GATEWAY, 'unknown, 172.18.0.1'), priv, host), { address: '172.18.0.1', local: false });
});

test('hostName strips ports, brackets and trailing dots', () => {
  assert.equal(hostName('Studio.Example.com:3000'), 'studio.example.com');
  assert.equal(hostName('[fd00::5]:3000'), 'fd00::5');
  assert.equal(hostName('fd00::5'), 'fd00::5');
  assert.equal(hostName('example.com.'), 'example.com');
});

test('isKnownHost: addresses and local names always, other names only when configured', () => {
  const known = ['studio.example.com', '*.example.net'];
  for (const h of ['192.168.1.20:3000', '[fd00::5]:3000', 'localhost:3000', 'nas:3000', 'nas.local', 'server.lan', 'box.home.arpa', 'server.tail1234.ts.net:8443', 'studio.example.com', 'a.example.net']) {
    assert.equal(isKnownHost(h, known), true, h);
  }
  for (const h of ['evil.example', 'rebind.attacker.test:3000', 'example.net', 'studio.example.com.evil.test', '', undefined]) {
    assert.equal(isKnownHost(h, known), false, String(h));
  }
  assert.equal(isKnownHost('anything.test', ['*']), true);
});

test('untrustedForwarder spots a proxy on the network that Keel does not trust', async () => {
  const priv = parseNetworks('private');
  const t = await docker();
  // Nginx Proxy Manager in its own container, say: private, forwards, not trusted.
  assert.equal(untrustedForwarder(req('172.18.0.30', '203.0.113.9'), priv, t), '172.18.0.30');
  assert.equal(untrustedForwarder(req('::ffff:192.168.1.5', '203.0.113.9'), priv, t), '192.168.1.5');
  // Not without X-Forwarded-For, not from a trusted proxy, not from the internet.
  assert.equal(untrustedForwarder(req('172.18.0.30'), priv, t), null);
  assert.equal(untrustedForwarder(req(GATEWAY, '203.0.113.9'), priv, t), null);
  assert.equal(untrustedForwarder(req('127.0.0.1', '203.0.113.9'), priv, t), null);
  assert.equal(untrustedForwarder(req('198.51.100.4', '203.0.113.9'), priv, t), null);
});

test('a request through Tailscale Funnel is never local, even from the host proxy', async () => {
  const priv = parseNetworks('private');
  const host = new ProxyTrust('host', lookup, async () => ['172.18.0.1'], connected);
  await host.refresh();
  // tailscale serve on the Docker host forwards a tailnet device: local.
  assert.equal(requestOrigin(req('172.18.0.1', '100.101.102.103'), priv, host).local, true);
  // The same proxy forwarding a Funnel visitor: the internet.
  assert.equal(requestOrigin(req('172.18.0.1', '100.101.102.103', { 'tailscale-funnel-request': '?1' }), priv, host).local, false);
});
