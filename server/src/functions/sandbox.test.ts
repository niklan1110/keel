import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DENIED_RANGES, blockContains, defaultGateway, denyNetList, formatBlock, gatewayPath, keepAllowed, parseAllowLan, parseBlock, serveGatewaySocket, subtractBlock } from './sandbox.js';

test('the deny list covers private, loopback, link-local and other special ranges', () => {
  const list = denyNetList([]).split(',');
  for (const r of ['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', '100.64.0.0/10', '127.0.0.0/8', '169.254.0.0/16', '0.0.0.0/8', '[::1]', '[::]']) {
    assert.ok(list.includes(r), r);
  }
  // No names: a name is only one of many ways to reach an address.
  assert.ok(list.every((x) => /^[\d./]+$|^\[[0-9a-f:.]+\]$/i.test(x)), list.join(','));
});

test('single addresses are added unless a range already covers them', () => {
  const list = denyNetList(['203.0.113.7', '172.19.0.1', '::ffff:198.51.100.2', 'fd00::5', '[fe80::1%eth0]', '198.51.100.0/24', 'keel-db', '10.0.0.0/33']).split(',');
  assert.ok(list.includes('203.0.113.7'));
  assert.ok(list.includes('198.51.100.2'));
  assert.ok(list.includes('[fd00::5]'));
  assert.ok(list.includes('[fe80::1]'));
  assert.ok(list.includes('198.51.100.0/24'));
  assert.ok(!list.includes('172.19.0.1'));
  assert.ok(!list.includes('keel-db'));
  assert.ok(!list.some((x) => x.endsWith('/33')));
  assert.equal(list.length, new Set(list).size);
  assert.deepEqual(list.slice(0, DENIED_RANGES.length), DENIED_RANGES);
});

test('the gateway socket forwards only paths of the function own project', () => {
  assert.equal(gatewayPath('my-app', 'http://keel-gateway:8000/my-app/rest/v1/todos?select=*'), '/my-app/rest/v1/todos?select=*');
  assert.equal(gatewayPath('my-app', '/my-app/auth/v1/user'), '/my-app/auth/v1/user');
  assert.equal(gatewayPath('my-app', 'ws://keel-gateway:8000/my-app/realtime/v1/websocket'), '/my-app/realtime/v1/websocket');
  assert.equal(gatewayPath('my-app', '/my-app'), '/my-app');
  for (const bad of [
    '/other-app/rest/v1/todos',
    '/my-app-2/rest/v1/todos',
    '/my-app/../other-app/rest/v1/x',
    '/my-app/%2e%2e/other-app/rest/v1/x',
    '//evil.example/my-app/x',
    '/my-app\\..\\other',
    'https://keel-gateway/my-app/rest/v1/x',
    'file:///my-app/x',
    '/docs',
    '',
  ]) {
    assert.equal(gatewayPath('my-app', bad), null, bad);
  }
});

test('serveGatewaySocket proxies to the gateway and refuses other projects', async () => {
  const seen: { url?: string; xff?: string; host?: string }[] = [];
  const gateway = http.createServer((req, res) => {
    seen.push({ url: req.url, xff: req.headers['x-forwarded-for'] as string | undefined, host: req.headers.host });
    res.end('from-gateway');
  });
  await new Promise<void>((r) => gateway.listen(0, '127.0.0.1', r));
  const target = `http://127.0.0.1:${(gateway.address() as AddressInfo).port}`;
  const name = `keel-gw-${crypto.randomBytes(4).toString('hex')}`;
  const socketPath = process.platform === 'win32' ? `\\\\?\\pipe\\${name}` : path.join(os.tmpdir(), `${name}.sock`);
  const server = await serveGatewaySocket(socketPath, 'my-app', target, 5000);
  const ask = (reqPath: string, headers: Record<string, string> = {}) =>
    new Promise<{ status: number; body: string }>((resolve, reject) => {
      const r = http.request({ socketPath, path: reqPath, headers }, (res) => {
        let body = '';
        res.on('data', (d) => (body += d));
        res.on('end', () => resolve({ status: res.statusCode || 0, body }));
      });
      r.on('error', reject);
      r.end();
    });
  try {
    const ok = await ask('http://keel-gateway:8000/my-app/rest/v1/todos', { 'X-Forwarded-For': '10.1.2.3' });
    assert.equal(ok.status, 200);
    assert.equal(ok.body, 'from-gateway');
    assert.equal(seen[0].url, '/my-app/rest/v1/todos');
    assert.equal(seen[0].xff, undefined);
    assert.equal(seen[0].host, new URL(target).host);
    const other = await ask('http://keel-gateway:8000/other-app/rest/v1/todos');
    assert.equal(other.status, 403);
    assert.equal(seen.length, 1);
  } finally {
    server.close();
    gateway.close();
  }
});

test('subtracting an address from a range leaves the smallest set of ranges around it', () => {
  const left = subtractBlock(parseBlock('192.168.0.0/16')!, parseBlock('192.168.1.50')!).map(formatBlock);
  assert.equal(left.length, 16);
  assert.ok(!left.includes('192.168.0.0/16'));
  assert.ok(left.includes('192.168.128.0/17'));
  assert.ok(left.includes('192.168.1.51/32'));
  assert.ok(left.includes('192.168.1.48/31'));
  // Together they cover every address of the range except the one taken out.
  const blocks = left.map((b) => parseBlock(b)!);
  const covered = (ip: string) => blocks.some((b) => blockContains(b, parseBlock(ip)!));
  assert.equal(covered('192.168.1.50'), false);
  for (const ip of ['192.168.0.0', '192.168.1.49', '192.168.1.51', '192.168.255.255', '192.168.200.1']) assert.equal(covered(ip), true, ip);
  assert.equal(blocks.reduce((n, b) => n + 2 ** (32 - b.bits), 0), 2 ** 16 - 1);
  // Outside the range: nothing to take out. The whole range: nothing left.
  assert.deepEqual(subtractBlock(parseBlock('10.0.0.0/8')!, parseBlock('192.168.1.50')!).map(formatBlock), ['10.0.0.0/8']);
  assert.deepEqual(subtractBlock(parseBlock('10.1.2.0/24')!, parseBlock('10.0.0.0/8')!), []);
});

test('the deny list leaves out allowed LAN addresses and keeps everything else', () => {
  const list = denyNetList([], [parseBlock('192.168.1.50')!, parseBlock('10.0.0.0/24')!]).split(',');
  assert.ok(!list.includes('192.168.0.0/16'));
  assert.ok(!list.includes('10.0.0.0/8'));
  assert.ok(list.includes('192.168.1.51/32'));
  assert.ok(list.includes('10.0.1.0/24'));
  assert.ok(list.includes('172.16.0.0/12'));
  assert.ok(list.includes('127.0.0.0/8'));
  // A single address that must stay closed is still listed, even inside an allowed block.
  assert.ok(denyNetList(['192.168.1.50'], [parseBlock('192.168.1.50')!]).split(',').includes('192.168.1.50'));
});

test('KEEL_FUNCTIONS_ALLOW_LAN accepts LAN addresses and small ranges only', () => {
  const r = parseAllowLan(' 192.168.1.50:11434, 10.0.0.7 ,192.168.2.0/28,100.100.1.2, 8.8.8.8, 127.0.0.1, 169.254.169.254, 192.168.0.0/16, 10.0.0.1:99999, nas.local, ', { ranges: true });
  assert.deepEqual(r.allowed.map((a) => [formatBlock(a.block), a.port ?? null]), [
    ['192.168.1.50/32', 11434],
    ['10.0.0.7/32', null],
    ['192.168.2.0/28', null],
    ['100.100.1.2/32', null],
  ]);
  assert.deepEqual(r.refused.map((x) => x.entry), ['8.8.8.8', '127.0.0.1', '169.254.169.254', '192.168.0.0/16', '10.0.0.1:99999', 'nas.local']);
  assert.deepEqual(parseAllowLan('', { ranges: true }), { allowed: [], refused: [] });
});

test('KEEL_FUNCTIONS_ALLOW_LAN takes ranges only when the server knows its own LAN addresses', () => {
  const r = parseAllowLan('192.168.1.50, 192.168.1.0/24, 10.0.0.8/29', { ranges: false });
  assert.deepEqual(r.allowed.map((a) => a.entry), ['192.168.1.50']);
  assert.deepEqual(r.refused.map((x) => x.entry), ['192.168.1.0/24', '10.0.0.8/29']);
  assert.match(r.refused[0].reason, /KEEL_HOST_ADDRESSES/);
  assert.deepEqual(parseAllowLan('192.168.1.0/24', { ranges: true }).allowed.map((a) => a.entry), ['192.168.1.0/24']);
});

test("this server's LAN address stays closed inside an allowed range", () => {
  const list = denyNetList(['192.168.1.20'], [parseBlock('192.168.1.0/24')!]).split(',');
  assert.ok(list.includes('192.168.1.20'));
  assert.ok(!list.includes('192.168.0.0/16'));
});

test('allowed addresses never include the Docker host, the functions network or Keel itself', () => {
  const { allowed } = parseAllowLan('172.20.0.1,172.20.0.9,192.168.1.20,192.168.1.16/28,192.168.1.50,10.9.0.0/24', { ranges: true });
  const { kept, refused } = keepAllowed(allowed, ['172.20.0.0/16', '192.168.1.20', '10.9.0.77'].map((x) => parseBlock(x)!));
  assert.deepEqual(kept.map((a) => a.entry), ['192.168.1.50']);
  assert.deepEqual(refused.map((x) => x.entry), ['172.20.0.1', '172.20.0.9', '192.168.1.20', '192.168.1.16/28', '10.9.0.0/24']);
});

test('the default gateway is read from /proc/net/route', () => {
  const route = 'Iface\tDestination\tGateway \tFlags\tRefCnt\tUse\tMetric\tMask\t\tMTU\tWindow\tIRTT\n' +
    'eth0\t00000000\t010014AC\t0003\t0\t0\t0\t00000000\t0\t0\t0\n' +
    'eth0\t000014AC\t00000000\t0001\t0\t0\t0\t0000FFFF\t0\t0\t0\n';
  assert.equal(defaultGateway(route), '172.20.0.1');
  assert.equal(defaultGateway('Iface\tDestination\n'), null);
});
