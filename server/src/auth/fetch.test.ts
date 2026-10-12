import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { MAX_RESPONSE_BYTES, checkBrowserUrl, checkFetchUrl, providerFetch } from './fetch.js';

let server: http.Server;
let base = '';

before(async () => {
  server = http.createServer((req, res) => {
    const url = new URL(req.url || '/', 'http://x');
    if (url.pathname === '/json') return res.end(JSON.stringify({ ok: 1 }));
    if (url.pathname === '/big') return res.end('x'.repeat(MAX_RESPONSE_BYTES + 10));
    if (url.pathname === '/same') return res.writeHead(302, { Location: '/json' }).end();
    if (url.pathname === '/away') return res.writeHead(302, { Location: 'http://localhost:1/json' }).end();
    if (url.pathname === '/loop') return res.writeHead(302, { Location: '/loop' }).end();
    res.writeHead(404).end('nope');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(() => {
  server.closeAllConnections();
  server.close();
});

const lan = { allowHttp: true };
const strict = { allowHttp: false };

test('https is required unless plain http is allowed for the provider', async () => {
  assert.equal(checkBrowserUrl('https://idp.example.test/auth', strict, 'x').host, 'idp.example.test');
  assert.throws(() => checkBrowserUrl('http://idp.example.test/auth', strict, 'x'), /must use https/);
  assert.throws(() => checkBrowserUrl('ftp://idp.example.test/', lan, 'x'), /must use https/);
  assert.throws(() => checkBrowserUrl('javascript:alert(1)', lan, 'x'), /must use https/);
  assert.throws(() => checkBrowserUrl('https://user:pw@idp.example.test/', strict, 'x'), /user name or password/);
  assert.throws(() => checkBrowserUrl('not a url', strict, 'x'), /not a valid URL/);
});

test('plain http is fetched only on your own network', async () => {
  for (const ok of ['http://192.168.1.10:9000/', 'http://10.1.2.3/', 'http://authentik.lan/', 'http://keel-gateway:8000/', 'http://[fd00::1]/', 'http://localhost:9000/']) {
    assert.ok(await checkFetchUrl(ok, lan, 'x'), ok);
  }
  for (const bad of ['http://203.0.113.9/', 'http://8.8.8.8/', 'http://[2001:db8::1]/']) {
    await assert.rejects(checkFetchUrl(bad, lan, 'x'), /not on your own network/, bad);
  }
  await assert.rejects(checkFetchUrl('http://192.168.1.10/', strict, 'x'), /must use https/);
});

test('fetches JSON and follows a redirect on the same origin', async () => {
  assert.deepEqual((await providerFetch(`${base}/json`, lan, 'x')).body, { ok: 1 });
  assert.deepEqual((await providerFetch(`${base}/same`, lan, 'x')).body, { ok: 1 });
  const missing = await providerFetch(`${base}/missing`, lan, 'x');
  assert.equal(missing.status, 404);
  assert.equal(missing.body, null);
});

test('refuses redirects to another host, redirect loops and redirected POSTs', async () => {
  await assert.rejects(providerFetch(`${base}/away`, lan, 'x'), /another host/);
  await assert.rejects(providerFetch(`${base}/loop`, lan, 'x'), /redirected/);
  await assert.rejects(providerFetch(`${base}/same`, lan, 'x', { method: 'POST', body: 'a=b' }), /redirected/);
});

test('caps the response size', async () => {
  await assert.rejects(providerFetch(`${base}/big`, lan, 'x'), /too large/);
});

test('plain http never reaches link-local addresses, where cloud instance metadata lives', async () => {
  for (const bad of ['http://169.254.169.254/latest/meta-data/', 'http://[fe80::1]/', 'http://[::ffff:169.254.169.254]/']) {
    await assert.rejects(checkFetchUrl(bad, lan, 'x'), /not on your own network/, bad);
  }
});
