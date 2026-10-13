import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { GATEWAY, STUDIO, env, needsConfig, sessionFrom, studioHeaders, studioTrustsForwarding, uniq } from './helpers.js';

// Studio accounts: sessions on the server, two-factor codes, and the rule for
// sign-ins from the internet (default: only with two-factor). Requests that
// come "from the internet" are simulated with X-Forwarded-For: from a peer
// Studio doesn't trust as a proxy, any forwarded request counts as the
// internet (under the peer's own address); when this machine is a trusted
// proxy (see studioTrustsForwarding), the forwarded address is used.

const created = [];
let ownerToken;

async function call(method, path, { token, body, ip } = {}) {
  const res = await fetch(`${STUDIO}${path}`, {
    method,
    headers: {
      ...studioHeaders(token),
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(ip ? { 'X-Forwarded-For': ip } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }
  // `token` is the session from the sign-in's cookie.
  return { status: res.status, data, token: sessionFrom(res) };
}

const login = (username, password, extra = {}) => call('POST', '/api/login', { body: { username, password, ...(extra.code ? { code: extra.code } : {}) }, ip: extra.ip });

function totp(secret, step = Math.floor(Date.now() / 30000)) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = 0;
  let value = 0;
  const bytes = [];
  for (const ch of secret) {
    value = (value << 5) | alphabet.indexOf(ch);
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(step));
  const mac = crypto.createHmac('sha1', Buffer.from(bytes)).update(msg).digest();
  const o = mac[mac.length - 1] & 0xf;
  return String((mac.readUInt32BE(o) & 0x7fffffff) % 1e6).padStart(6, '0');
}

async function owner() {
  if (!ownerToken) {
    const r = await login(env.KEEL_DASHBOARD_USERNAME || 'admin', env.KEEL_DASHBOARD_PASSWORD);
    assert.equal(r.status, 200, JSON.stringify(r.data));
    ownerToken = r.token;
  }
  return ownerToken;
}

async function newAccount() {
  const username = uniq('ops');
  const password = `pw-${crypto.randomBytes(6).toString('hex')}`;
  const r = await call('POST', '/api/studio-users', { token: await owner(), body: { username, password } });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  created.push(r.data.id);
  return { id: r.data.id, username, password };
}

after(async () => {
  for (const id of created) await call('DELETE', `/api/studio-users/${id}`, { token: await owner() });
});

test('the .env login is the owner account; sign-out ends the session on the server', async () => {
  const r = await login(env.KEEL_DASHBOARD_USERNAME || 'admin', env.KEEL_DASHBOARD_PASSWORD);
  assert.equal(r.status, 200);
  assert.equal(r.data.user.isOwner, true);
  const s = await call('GET', '/api/session', { token: r.token });
  assert.equal(s.status, 200);
  assert.equal(s.data.user.isOwner, true);
  assert.equal((await call('POST', '/api/logout', { token: r.token })).status, 200);
  const after = await call('GET', '/api/session', { token: r.token });
  assert.equal(after.status, 401, 'the token stops working after sign-out');
});

test('accounts: create, sign in, change password ends other sessions, remove', async () => {
  const a = await newAccount();
  const one = await login(a.username, a.password);
  const two = await login(a.username.toUpperCase(), a.password);
  assert.equal(one.status, 200);
  assert.equal(two.status, 200, 'usernames are case-insensitive');
  assert.equal((await login(a.username, 'wrong-password')).status, 401);

  const sessions = await call('GET', '/api/account/sessions', { token: one.token });
  assert.equal(sessions.data.length, 2);
  assert.equal(sessions.data.filter((s) => s.current).length, 1);

  assert.equal((await call('POST', '/api/account/password', { token: one.token, body: { current: 'nope', password: 'new-password-1' } })).status, 400);
  assert.equal((await call('POST', '/api/account/password', { token: one.token, body: { current: a.password, password: 'short' } })).status, 400);
  const changed = await call('POST', '/api/account/password', { token: one.token, body: { current: a.password, password: 'new-password-1' } });
  assert.equal(changed.status, 200);
  assert.equal(changed.data.endedSessions, 1);
  assert.equal((await call('GET', '/api/session', { token: two.token })).status, 401, 'other session ended');
  assert.equal((await call('GET', '/api/session', { token: one.token })).status, 200, 'this session stays');
  assert.equal((await login(a.username, 'new-password-1')).status, 200);

  // The owner can't be removed or changed by another account; nobody removes themselves.
  const list = await call('GET', '/api/studio-users', { token: one.token });
  const ownerRow = list.data.find((u) => u.isOwner);
  assert.equal((await call('DELETE', `/api/studio-users/${ownerRow.id}`, { token: one.token })).status, 403);
  assert.equal((await call('DELETE', `/api/studio-users/${a.id}`, { token: one.token })).status, 400);

  assert.equal((await call('DELETE', `/api/studio-users/${a.id}`, { token: await owner() })).status, 200);
  assert.equal((await call('GET', '/api/session', { token: one.token })).status, 401, 'removed accounts are signed out');
  assert.equal((await login(a.username, 'new-password-1')).status, 401);
});

test('two-factor: setup, code required at sign-in, no replays, reset by another admin', async () => {
  const a = await newAccount();
  const t = (await login(a.username, a.password)).token;
  const setup = await call('POST', '/api/account/2fa/setup', { token: t });
  assert.match(setup.data.uri, /^otpauth:\/\/totp\//);
  assert.match(setup.data.qr, /<svg/);
  assert.equal((await call('POST', '/api/account/2fa/enable', { token: t, body: { secret: setup.data.secret, code: '000000' } })).status, 400);
  const step = Math.floor(Date.now() / 30000);
  assert.equal((await call('POST', '/api/account/2fa/enable', { token: t, body: { secret: setup.data.secret, code: totp(setup.data.secret, step) } })).status, 200);

  const noCode = await login(a.username, a.password);
  assert.equal(noCode.status, 401);
  assert.equal(noCode.data.error, 'mfa_required');
  const reused = await login(a.username, a.password, { code: totp(setup.data.secret, step) });
  assert.equal(reused.data.error, 'invalid_code', 'the code used to turn it on can’t sign in');
  const next = totp(setup.data.secret, step + 1);
  const ok = await login(a.username, a.password, { code: next });
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  assert.equal(ok.data.user.twoFactor, true);
  assert.equal((await login(a.username, a.password, { code: next })).data.error, 'invalid_code', 'no replays');

  // Lost phone: another admin turns it off, which also signs them out.
  assert.equal((await call('DELETE', `/api/studio-users/${a.id}/2fa`, { token: await owner() })).status, 200);
  assert.equal((await call('GET', '/api/session', { token: ok.token })).status, 401);
  assert.equal((await login(a.username, a.password)).status, 200);
});

test('sign-ins from the internet need two-factor (KEEL_STUDIO_INTERNET_LOGIN=2fa)', async () => {
  const a = await newAccount();
  const internet = '203.0.113.' + (10 + Math.floor(Math.random() * 200));
  const blocked = await login(a.username, a.password, { ip: internet });
  assert.equal(blocked.status, 403);
  assert.equal(blocked.data.error, 'two_factor_required');
  // A wrong password from the internet still says only "wrong password".
  assert.equal((await login(a.username, 'wrong-password', { ip: internet })).data.error, 'invalid_credentials');
  // A spoofed private address in X-Forwarded-For doesn't help: the proxy's view counts.
  const spoofed = await call('POST', '/api/login', { body: { username: a.username, password: a.password }, ip: `192.168.1.5, ${internet}` });
  assert.equal(spoofed.data.error, 'two_factor_required');

  // From the local network (this machine, nothing forwarded) the password is enough; then turn on two-factor.
  const t = (await login(a.username, a.password)).token;
  const acct = await call('GET', '/api/account', { token: t });
  assert.equal(acct.data.internetLogin, '2fa');
  const setup = await call('POST', '/api/account/2fa/setup', { token: t });
  const step = Math.floor(Date.now() / 30000);
  await call('POST', '/api/account/2fa/enable', { token: t, body: { secret: setup.data.secret, code: totp(setup.data.secret, step) } });

  const ok = await login(a.username, a.password, { ip: internet, code: totp(setup.data.secret, step + 1) });
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  const sessions = await call('GET', '/api/account/sessions', { token: ok.token });
  const mine = sessions.data.find((s) => s.current);
  assert.equal(mine.fromInternet, true);
  if (await studioTrustsForwarding()) assert.equal(mine.ip, internet);
  else assert.notEqual(mine.ip, internet, 'a forged address is not believed');
});

test('failed sign-ins are limited per address', async (t) => {
  // Posing as several addresses needs a trusted proxy; otherwise this would lock this machine out of Studio.
  if (!(await studioTrustsForwarding())) return needsConfig(t, 'Studio does not trust this machine as a proxy (KEEL_TRUSTED_PROXIES)');
  const a = await newAccount();
  const ip = '198.51.100.' + (10 + Math.floor(Math.random() * 200));
  for (let i = 0; i < 10; i++) assert.equal((await login(a.username, 'wrong-password', { ip: `192.168.7.${i + 1}, ${ip}` })).status, 401);
  assert.equal((await login(a.username, a.password, { ip })).status, 429);
  // Someone else (a different address) is not affected.
  assert.notEqual((await login(a.username, a.password, { ip: '192.168.1.77' })).status, 429);
});

test('the gateway serves the docs; browsers opening the API root land there', async () => {
  const docs = await fetch(`${GATEWAY}/docs/guide/quickstart`);
  assert.equal(docs.status, 200);
  assert.match(await docs.text(), /Quickstart/);
  assert.equal((await fetch(`${GATEWAY}/docs/llms.txt`)).status, 200);
  const browser = await fetch(`${GATEWAY}/`, { headers: { Accept: 'text/html' }, redirect: 'manual' });
  assert.equal(browser.status, 302);
  assert.equal(browser.headers.get('location'), '/docs/');
  const api = await fetch(`${GATEWAY}/`);
  assert.equal((await api.json()).docs, '/docs/');
  assert.equal((await fetch(`${GATEWAY}/docs/..%2f..%2fpackage.json`)).status, 404);
});
