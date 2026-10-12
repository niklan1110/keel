// Who a request is from: X-Forwarded-For is believed only from trusted proxies
// (KEEL_TRUSTED_PROXIES: Keel's own gateway and tunnel by default), so a
// client can neither claim to be on the local network nor rotate its
// rate-limit key by writing addresses into the header.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { PROJECT_URL, STUDIO, gatewayTrustsForwarding, inContainer, keys, needsConfig, studioHeaders, studioSignIn, studioTrustsForwarding, uniq } from './helpers.js';


test('Studio: a forged private X-Forwarded-For from a peer that is not a trusted proxy counts as the internet', async (t) => {
  const session = await studioSignIn();
  const forgeries = ['192.168.1.5', '10.0.0.1, 192.168.1.5', '127.0.0.1'];
  let direct;
  let forged;
  if (!(await studioTrustsForwarding())) {
    const account = async (headers = {}) => (await fetch(`${STUDIO}/api/account`, { headers: { ...studioHeaders(session), ...headers } })).json();
    direct = await account();
    forged = [];
    for (const f of forgeries) forged.push(await account({ 'X-Forwarded-For': f }));
  } else {
    // Studio trusts this machine (the default: it's published on 127.0.0.1), so
    // send the same requests from keel-auth, a container on Keel's network
    // that isn't a proxy, with the same session cookie and X-Keel-Studio header.
    const out = inContainer(
      'keel-auth',
      `const get = async (h) => (await fetch('http://keel-studio:3000/api/account', { headers: { ...${JSON.stringify(studioHeaders(session))}, ...h } })).json();
      const direct = await get({});
      const forged = [];
      for (const f of ${JSON.stringify(forgeries)}) forged.push(await get({ 'X-Forwarded-For': f }));
      console.log(JSON.stringify({ direct, forged }));`,
    );
    if (!out) return needsConfig(t, "Studio trusts this machine and Docker isn't reachable to send the requests from inside Keel's network");
    ({ direct, forged } = out);
  }
  assert.equal(direct.fromInternet, false, 'the peer itself is on the local network');
  forgeries.forEach((f, i) => {
    assert.equal(forged[i].fromInternet, true, `X-Forwarded-For: ${f}`);
    assert.equal(forged[i].address, direct.address, 'counted under the real peer, not the forged address');
  });
});

test('auth: forged X-Forwarded-For addresses share one rate-limit key', async (t) => {
  const { anon } = await keys();
  // 10 failed sign-ins per address and account in 5 minutes, whatever address is claimed,
  // then another account from the same peer.
  const attack = async (base, emails) => {
    const randomPrivate = () => `10.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}.${1 + Math.floor(Math.random() * 250)}`;
    const signIn = async (email) => {
      const r = await fetch(`${base}/auth/v1/token?grant_type=password`, {
        method: 'POST',
        headers: { apikey: emails.anon, 'Content-Type': 'application/json', 'X-Forwarded-For': randomPrivate() },
        body: JSON.stringify({ email, password: 'wrong-password-1' }),
      });
      return { status: r.status, code: (await r.json()).error_code };
    };
    const out = [];
    for (let i = 0; i < 11; i++) out.push(await signIn(emails.target));
    out.push(await signIn(emails.other));
    return out;
  };
  const emails = { anon, target: `${uniq('rotate')}@example.com`, other: `${uniq('other')}@example.com` };
  let results;
  if (!(await gatewayTrustsForwarding())) results = await attack(PROJECT_URL, emails);
  else {
    // The gateway trusts this machine, so attack from keel-auth, a container on
    // Keel's network that isn't a proxy.
    results = inContainer('keel-auth', `const attack = ${attack.toString()};
      console.log(JSON.stringify(await attack(${JSON.stringify(`http://keel-gateway:8000/${new URL(PROJECT_URL).pathname.split('/')[1]}`)}, ${JSON.stringify(emails)})));`);
    if (!results) return needsConfig(t, "the gateway trusts this machine and Docker isn't reachable to send the requests from inside Keel's network");
  }
  results.slice(0, 10).forEach((r, i) => assert.equal(r.status, 400, `attempt ${i + 1}`));
  assert.deepEqual(results[10], { status: 429, code: 'over_request_rate_limit' });
  assert.equal(results[11].status, 400, 'another account from the same peer is not affected');
});

/** A GET to Studio with any Host header (fetch doesn't allow setting it). */
function getWithHost(path, host) {
  const u = new URL(STUDIO);
  return new Promise((resolve, reject) => {
    const r = http.get({ hostname: u.hostname, port: u.port || 80, path, headers: { Host: host } }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    r.on('error', reject);
  });
}

test('Studio refuses host names it does not know (DNS rebinding) with 421', async () => {
  for (const host of ['rebind.attacker.test', 'evil.example:3000']) {
    const page = await getWithHost('/', host);
    assert.equal(page.status, 421, host);
    const api = await getWithHost('/api/session', host);
    assert.equal(api.status, 421, host);
    assert.equal(JSON.parse(api.body).error, 'unknown_host');
  }
  // Addresses, localhost and names that only resolve locally keep working.
  for (const host of ['127.0.0.1:3000', '192.168.1.20:3000', '[::1]:3000', 'localhost:3000', 'nas:3000', 'nas.local:3000', 'server.tail1234.ts.net']) {
    assert.notEqual((await getWithHost('/', host)).status, 421, host);
  }
  // So does /health, for container health checks.
  assert.equal((await getWithHost('/health', 'rebind.attacker.test')).status, 200);
});
