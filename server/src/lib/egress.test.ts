import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import net from 'node:net';
import test from 'node:test';
import { parseBlock } from '../functions/sandbox.js';
import { addressProblem, makePolicy, ownFunctionPath, sendRequest, type EgressPolicy, type SendOptions } from './egress.js';

const policy = makePolicy(['203.0.113.10', '2001:db8:1::5'], [parseBlock('192.168.1.50')!]);

test('private, loopback, link-local and other special addresses are refused', () => {
  for (const ip of ['127.0.0.1', '10.1.2.3', '172.20.0.5', '192.168.0.1', '169.254.169.254', '100.100.100.100', '0.0.0.0', '224.0.0.1', '255.255.255.255', '198.18.0.1']) {
    assert.match(addressProblem(ip, policy) || '', /private or reserved/, ip);
  }
  for (const ip of ['::1', '::', 'fe80::1', 'fd00::1', 'fc00::2', 'ff02::1', '::ffff:127.0.0.1', '::ffff:7f00:1', '64:ff9b::a00:1', '2002:a00:1::1', '::ffff:a9fe:a9fe', '::ffff:0:7f00:1', '::7f00:1', '64:ff9b:1::a00:1', '2001::1']) {
    assert.ok(addressProblem(ip, policy), ip);
  }
});

test('public addresses are allowed, except this server', () => {
  assert.equal(addressProblem('8.8.8.8', policy), null);
  assert.equal(addressProblem('2606:4700::1111', policy), null);
  assert.match(addressProblem('203.0.113.10', policy) || '', /this server/);
  assert.match(addressProblem('[2001:db8:1::5]', policy) || '', /this server/);
  // This server's address written as an IPv4-mapped IPv6 address.
  assert.match(addressProblem('::ffff:cb00:710a', policy) || '', /this server/);
  assert.equal(addressProblem('not-an-ip', policy), 'not an IP address');
});

test('LAN addresses opened with KEEL_FUNCTIONS_ALLOW_LAN are allowed, unless they are this server', () => {
  assert.equal(addressProblem('192.168.1.50', policy), null);
  assert.ok(addressProblem('192.168.1.51', policy));
  const both = makePolicy(['192.168.1.50'], [parseBlock('192.168.1.48/29')!]);
  assert.match(addressProblem('192.168.1.50', both) || '', /this server/);
  assert.equal(addressProblem('192.168.1.49', both), null);
});

test("the project's own functions are recognised by the public and internal URLs only", () => {
  const bases = ['https://api.example.com', 'http://keel-gateway:8000', 'https://example.org/keel/'];
  const path = (u: string, p = 'my-app') => ownFunctionPath(new URL(u), p, bases);
  assert.equal(path('https://api.example.com/my-app/functions/v1/hello?x=1'), '/my-app/functions/v1/hello?x=1');
  assert.equal(path('http://keel-gateway:8000/my-app/functions/v1/a/b'), '/my-app/functions/v1/a/b');
  assert.equal(path('https://example.org/keel/my-app/functions/v1/hi'), '/my-app/functions/v1/hi');
  assert.equal(path('https://api.example.com/other/functions/v1/hello'), null);
  assert.equal(path('https://api.example.com/my-app/rest/v1/todos'), null);
  assert.equal(path('https://api.example.com/my-app/functions/v1/../../other/functions/v1/x'), null);
  assert.equal(path('https://api.example.com/my-app/functions/v1/%2e%2e/%2e%2e/rest/v1/x'), null);
  assert.equal(path('http://api.example.com/my-app/functions/v1/hello'), null);
  assert.equal(path('https://api.example.com:8443/my-app/functions/v1/hello'), null);
  assert.equal(path('https://evil.example/my-app/functions/v1/hello'), null);
});

async function server(handler: http.RequestListener): Promise<{ port: number; close: () => void }> {
  const s = http.createServer(handler);
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
  return { port: (s.address() as AddressInfo).port, close: () => s.close() };
}

const open: EgressPolicy = { denied: new net.BlockList(), own: new net.BlockList(), allowed: [] };
const base = (over: Partial<SendOptions> = {}): SendOptions => ({ project: 'my-app', maxResponseBytes: 1024, policy, functionBases: [], gateway: 'http://127.0.0.1:1', ...over });
const req = (url: string, over = {}) => ({ method: 'GET' as const, url, headers: {}, body: null, timeoutMs: 2000, ...over });

test('requests to private addresses are refused before connecting', async () => {
  for (const url of ['http://127.0.0.1:5432/', 'http://169.254.169.254/latest/meta-data/', 'http://[::1]/', 'http://10.0.0.1/', 'http://0x7f000001/', 'http://0x7f.1/', 'http://2130706433/', 'http://127.1/', 'http://0/', 'http://[::ffff:127.0.0.1]/', 'http://[::ffff:0:127.0.0.1]/', 'http://[::127.0.0.1]/', 'http://[64:ff9b::127.0.0.1]/', 'http://①②⑦.0.0.1/']) {
    const r = await sendRequest(req(url), base());
    assert.equal(r.ok, false, url);
    assert.match((r as { error: string }).error, /refused/, url);
  }
  // A name is checked by every address it resolves to.
  const r = await sendRequest(req('http://looks-public.test/'), base({ lookup: async () => ['93.184.215.14', '192.168.0.10'] }));
  assert.match((r as { error: string }).error, /refused: looks-public\.test resolves to 192\.168\.0\.10/);
});

test('only http and https, and no credentials in the URL', async () => {
  assert.match((await sendRequest(req('ftp://example.com/'), base()) as { error: string }).error, /only http and https/);
  assert.match((await sendRequest(req('file:///etc/passwd'), base()) as { error: string }).error, /only http and https/);
  assert.match((await sendRequest(req('http://u:p@example.com/'), base()) as { error: string }).error, /credentials/);
});

test('the connection goes to the address that was checked, not a fresh lookup', async () => {
  const s = await server((q, res) => res.end(JSON.stringify({ host: q.headers.host })));
  try {
    // The system resolver doesn't know this name: it can only work through the pinned address.
    const r = await sendRequest(req(`http://rebind.invalid:${s.port}/`), base({ policy: open, lookup: async () => ['127.0.0.1'] }));
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(JSON.parse((r as { content: string }).content).host, `rebind.invalid:${s.port}`);
  } finally {
    s.close();
  }
});

test('redirects are not followed, and big or slow responses are cut off', async () => {
  const s = await server((q, res) => {
    if (q.url === '/redirect') return res.writeHead(302, { Location: 'http://169.254.169.254/' }).end();
    if (q.url === '/big') return res.end('x'.repeat(5000));
    if (q.url === '/slow') return setTimeout(() => res.end('late'), 1500);
    res.end('ok');
  });
  try {
    const o = base({ policy: open });
    const redirect = await sendRequest(req(`http://127.0.0.1:${s.port}/redirect`), o);
    assert.equal(redirect.ok && redirect.status, 302);
    const big = await sendRequest(req(`http://127.0.0.1:${s.port}/big`), o);
    assert.match((big as { error: string }).error, /larger than 1024 bytes/);
    const slow = await sendRequest(req(`http://127.0.0.1:${s.port}/slow`, { timeoutMs: 200 }), o);
    assert.deepEqual(slow, { ok: false, timedOut: true, error: 'Timeout of 200 ms reached' });
  } finally {
    s.close();
  }
});

test("calls to the project's functions go to the gateway, without forwarding headers", async () => {
  let seen: { url?: string; headers?: http.IncomingHttpHeaders; body?: string } = {};
  const gw = await server((q, res) => {
    let body = '';
    q.on('data', (c) => (body += c));
    q.on('end', () => {
      seen = { url: q.url, headers: q.headers, body };
      res.end('{"done":true}');
    });
  });
  try {
    const r = await sendRequest(
      req('http://localhost:8000/my-app/functions/v1/hook?a=1', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': '1.2.3.4', Host: 'elsewhere' },
        body: Buffer.from('{"x":1}'),
      }),
      base({ functionBases: ['http://localhost:8000'], gateway: `http://127.0.0.1:${gw.port}` }),
    );
    assert.equal(r.ok && r.status, 200);
    assert.equal(seen.url, '/my-app/functions/v1/hook?a=1');
    assert.equal(seen.body, '{"x":1}');
    assert.equal(seen.headers?.['x-forwarded-for'], undefined);
    assert.equal(seen.headers?.host, `127.0.0.1:${gw.port}`);
  } finally {
    gw.close();
  }
});
