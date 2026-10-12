import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { PROJECT, PROJECT_URL, keys, studio, waitFor } from './helpers.js';

// Studio > Internet access: the public address (stored in the database, used
// by every service without a restart) and the Cloudflare Tunnel run by keel-tunnel.

after(async () => {
  await studio('PUT', '/api/internet/address', { publicUrl: null, publicDbHost: null });
  await studio('DELETE', '/api/internet/tunnel');
});

test('the public address can be changed in Studio, and every service follows', async () => {
  const before = (await studio('GET', '/api/internet')).data;
  assert.equal(before.publicUrlSetHere, false);
  assert.equal(before.publicUrl, before.envPublicUrl);

  const r = await studio('PUT', '/api/internet/address', { publicUrl: 'api.keel-e2e.test/' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.publicUrl, 'https://api.keel-e2e.test');
  assert.equal(r.data.publicUrlSetHere, true);
  // Connection strings keep the server's own host: a tunnel only carries HTTP.
  assert.equal(r.data.publicDbHost, before.publicDbHost);
  assert.equal(r.data.publicDbHostSetHere, false);

  // Studio's Connect panel and OAuth callback.
  const connect = (await studio('GET', `/api/projects/${PROJECT}/connect`)).data;
  assert.equal(connect.apiUrl, `https://api.keel-e2e.test/${PROJECT}`);
  assert.equal(connect.callbackUrl, `https://api.keel-e2e.test/${PROJECT}/auth/v1/callback`);
  // The gateway serves the docs, so the agent prompt can link them.
  assert.equal(connect.docsOnApi, true);

  // PostgREST is restarted with the new address in its OpenAPI document.
  const { anon } = await keys();
  await waitFor(
    async () => {
      const res = await fetch(`${PROJECT_URL}/rest/v1/`, { headers: { apikey: anon } });
      if (res.status !== 200) return false;
      const doc = await res.json();
      return /^api\.keel-e2e\.test(:443)?$/.test(doc.host) && (doc.schemes || []).includes('https');
    },
    { timeout: 20_000, label: 'OpenAPI document with the new address' },
  );

  // A separate host for connection strings, then both back to the server's settings.
  const db = await studio('PUT', '/api/internet/address', { publicDbHost: '192.168.1.20' });
  assert.equal(db.data.publicDbHost, '192.168.1.20');
  assert.equal((await studio('GET', `/api/projects/${PROJECT}/connect`)).data.db.host, '192.168.1.20');
  const reset = await studio('PUT', '/api/internet/address', { publicUrl: null, publicDbHost: null });
  assert.equal(reset.data.publicUrl, before.envPublicUrl);
  assert.equal(reset.data.publicUrlSetHere, false);
});

test('bad addresses are refused', async () => {
  for (const publicUrl of ['ftp://example.com', 'https://user:pw@example.com', 'https://example.com/?x=1', 'not a url at all']) {
    const r = await studio('PUT', '/api/internet/address', { publicUrl });
    assert.equal(r.status, 400, publicUrl);
  }
  assert.equal((await studio('PUT', '/api/internet/address', { publicDbHost: 'bad host; rm -rf' })).status, 400);
});

test('the address check reaches Keel and reports failures plainly', async () => {
  const ok = (await studio('POST', '/api/internet/check', { url: 'http://keel-gateway:8000' })).data;
  assert.equal(ok.ok, true, ok.message);
  const bad = (await studio('POST', '/api/internet/check', { url: 'http://keel-nowhere.invalid' })).data;
  assert.equal(bad.ok, false);
  assert.match(bad.message, /Couldn't reach it/);
});

test('a tunnel token pasted in Studio starts the tunnel; removing it stops it', async () => {
  const start = (await studio('GET', '/api/internet')).data;
  assert.equal(start.tunnel.available, true, 'keel-tunnel is running');
  assert.equal(start.tunnel.configured, false);

  assert.equal((await studio('PUT', '/api/internet/tunnel', { token: 'hello' })).status, 400);

  // A well-formed token for a tunnel that doesn't exist, inside the command Cloudflare shows.
  const id = crypto.randomUUID();
  const token = Buffer.from(JSON.stringify({ a: crypto.randomBytes(16).toString('hex'), t: id, s: crypto.randomBytes(32).toString('base64') })).toString('base64');
  const r = await studio('PUT', '/api/internet/tunnel', { token: `docker run cloudflare/cloudflared:latest tunnel --no-autoupdate run --token ${token}` });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.tunnel.configured, true);
  assert.equal(JSON.stringify(r.data).includes(token), false, 'the token is never sent back');

  const running = await waitFor(
    async () => {
      const t = (await studio('GET', '/api/internet')).data.tunnel;
      return t.status?.tunnelId === id && ['starting', 'error'].includes(t.status.state) ? t : false;
    },
    { timeout: 15_000, label: 'keel-tunnel picks up the token' },
  );
  assert.equal(running.status.log.some((l) => l.includes(token)), false, 'the token is kept out of the log');

  assert.equal((await studio('DELETE', '/api/internet/tunnel')).status, 200);
  await waitFor(async () => (await studio('GET', '/api/internet')).data.tunnel.status?.state === 'off', { timeout: 15_000, label: 'tunnel off' });
});
