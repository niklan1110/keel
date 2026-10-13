// Security properties of keel-auth: sign-up can't take over accounts or tell
// whether they exist, revocations stick, the first real proof of an email
// address locks out whoever registered it, abuse limits, OAuth state binding.

import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { PROJECT, PROJECT_URL, client, env, gatewayTrustsForwarding, keys, needsConfig, newUser, setProjectSettings, sql, uniq } from './helpers.js';

const AUTH = `${PROJECT_URL}/auth/v1`;
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const claimsOf = (token) => JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString());

/** A raw call to the auth API, optionally as if from another IP address (behind the gateway). */
async function call(method, path, { body, ip, token, headers = {} } = {}) {
  const { anon } = await keys();
  const res = await fetch(`${AUTH}${path}`, {
    method,
    redirect: 'manual',
    headers: {
      apikey: anon,
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(ip ? { 'X-Forwarded-For': ip } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = text;
  }
  return { status: res.status, body: json, headers: res.headers };
}

// Addresses from the IPv6 documentation range, written the way Postgres prints them.
const hex = () => crypto.randomInt(1, 0xffff).toString(16);
const internetIp = () => `2001:db8:${hex()}:${hex()}::${hex()}`;

/** Restores one top-level project setting to what it was. */
async function restoreSetting(key, value) {
  if (value === null || value === undefined) {
    await sql('keel', `update keel.projects set settings = settings - $2::text where name = $1`, [PROJECT, key]);
  } else {
    await sql('keel', `update keel.projects set settings = settings || jsonb_build_object($2::text, $3::jsonb) where name = $1`, [PROJECT, key, JSON.stringify(value)]);
  }
  await new Promise((r) => setTimeout(r, 400));
}

async function setting(key) {
  return (await sql('keel', `select settings -> $2::text as v from keel.projects where name = $1`, [PROJECT, key])).rows[0].v;
}

// The per-IP tests pretend to be internet clients with X-Forwarded-For, which
// keel believes only from a trusted proxy (KEEL_TRUSTED_PROXIES=host, or the
// gateway published on 127.0.0.1).
let forwardedIpHonoured = false;
before(async () => {
  forwardedIpHonoured = await gatewayTrustsForwarding();
});

// ------------------------------------------------------------------ sessions

test('a failed PKCE exchange still uses up the code', async () => {
  const { service } = await keys();
  const siteUrl = await setting('site_url');
  await setProjectSettings({ site_url: 'http://localhost:5999' });
  try {
    const email = `${uniq('pkcefail')}@example.com`;
    await client(service).auth.admin.createUser({ email, password: 'pkce-fail-password', email_confirm: true });
    const verifier = crypto.randomBytes(32).toString('base64url');
    const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
    const rec = await call('POST', '/recover', { body: { email, code_challenge: challenge, code_challenge_method: 's256' } });
    assert.equal(rec.status, 200);
    const link = await client(service).auth.admin.generateLink({ type: 'recovery', email, options: { redirectTo: 'http://localhost:5999/reset' } });
    const res = await fetch(link.data.properties.action_link, { redirect: 'manual' });
    assert.equal(res.status, 303);
    const code = new URL(res.headers.get('location')).searchParams.get('code');
    assert.ok(code);

    const wrong = await call('POST', '/token?grant_type=pkce', { body: { auth_code: code, code_verifier: 'not-the-verifier' } });
    assert.equal(wrong.status, 403);
    assert.equal(wrong.body.error_code, 'bad_code_verifier');
    const right = await call('POST', '/token?grant_type=pkce', { body: { auth_code: code, code_verifier: verifier } });
    assert.equal(right.status, 404, 'the wrong guess used the code up');
    assert.equal(right.body.error_code, 'flow_state_not_found');
  } finally {
    await restoreSetting('site_url', siteUrl);
  }
});

test('changing the password ends the other sessions; an admin change ends all of them', async () => {
  const { anon, service } = await keys();
  const u = await newUser();
  const other = await client(anon).auth.signInWithPassword({ email: u.email, password: u.password });
  assert.equal(other.error, null);

  const upd = await u.client.auth.updateUser({ password: 'brand-new-password-1' });
  assert.equal(upd.error, null);
  assert.equal((await call('GET', '/user', { token: u.session.access_token })).status, 200, 'the session that changed it stays');
  const gone = await call('GET', '/user', { token: other.data.session.access_token });
  assert.equal(gone.status, 403);
  assert.equal(gone.body.error_code, 'session_not_found');
  const refresh = await call('POST', '/token?grant_type=refresh_token', { body: { refresh_token: other.data.session.refresh_token } });
  assert.equal(refresh.body.error_code, 'refresh_token_not_found');

  const byAdmin = await client(service).auth.admin.updateUserById(u.user.id, { password: 'admin-set-password-1' });
  assert.equal(byAdmin.error, null);
  assert.equal((await call('GET', '/user', { token: u.session.access_token })).status, 403);
  assert.equal((await client(anon).auth.signInWithPassword({ email: u.email, password: 'admin-set-password-1' })).error, null);
});

// ------------------------------------------------------------------ sign-up

test('signing up again with an unconfirmed address changes nothing and gets nobody in', async () => {
  const { anon, service, db } = await keys();
  const autoconfirm = await setting('mailer_autoconfirm');
  await setProjectSettings({ mailer_autoconfirm: false });
  try {
    const email = `${uniq('owner')}@example.com`;
    const owner = await client(anon).auth.signUp({ email, password: 'owner-password-1', options: { data: { name: 'Owner' } } });
    assert.equal(owner.error, null);
    assert.equal(owner.data.session, null);
    const ownerId = owner.data.user.id;

    const attack = await client(anon).auth.signUp({ email, password: 'attacker-password', options: { data: { name: 'Attacker', plan: 'pro' } } });
    assert.equal(attack.error, null);
    assert.equal(attack.data.session, null);
    assert.notEqual(attack.data.user.id, ownerId);
    assert.deepEqual(attack.data.user.identities, []);
    assert.deepEqual(attack.data.user.user_metadata, { name: 'Attacker', plan: 'pro' }, "only the caller's own data comes back");

    const row = (await sql(db, 'select raw_user_meta_data, encrypted_password from auth.users where id = $1', [ownerId])).rows[0];
    assert.deepEqual(row.raw_user_meta_data, { name: 'Owner' });
    assert.equal(row.encrypted_password, null, 'two sign-ups disagreed on the password, so neither is kept');

    // The owner confirms the address: signed in by the link, but neither password works.
    const link = await client(service).auth.admin.generateLink({ type: 'signup', email, password: 'unused-password' });
    assert.equal(link.error, null);
    const v = await client(anon).auth.verifyOtp({ token_hash: link.data.properties.hashed_token, type: 'signup' });
    assert.equal(v.error, null);
    assert.equal(v.data.user.id, ownerId);
    for (const password of ['attacker-password', 'owner-password-1']) {
      assert.equal((await client(anon).auth.signInWithPassword({ email, password })).error?.code, 'invalid_credentials', password);
    }

    // Signing up twice with the same password (the first email got lost) keeps it.
    const again = `${uniq('twice')}@example.com`;
    assert.equal((await client(anon).auth.signUp({ email: again, password: 'same-password-1' })).error, null);
    assert.equal((await client(anon).auth.signUp({ email: again, password: 'same-password-1' })).error, null);
    const link2 = await client(service).auth.admin.generateLink({ type: 'signup', email: again, password: 'unused-password' });
    assert.equal((await client(anon).auth.verifyOtp({ token_hash: link2.data.properties.hashed_token, type: 'signup' })).error, null);
    assert.equal((await client(anon).auth.signInWithPassword({ email: again, password: 'same-password-1' })).error, null);
  } finally {
    await restoreSetting('mailer_autoconfirm', autoconfirm);
  }
});

test('with confirmation on, sign-up answers the same for new, unconfirmed and confirmed addresses', async () => {
  const { anon, service } = await keys();
  const autoconfirm = await setting('mailer_autoconfirm');
  await setProjectSettings({ mailer_autoconfirm: false });
  try {
    const fresh = await client(anon).auth.signUp({ email: `${uniq('fresh')}@example.com`, password: 'fresh-password-1' });
    assert.equal(fresh.error, null);

    const confirmed = `${uniq('confirmed')}@example.com`;
    const created = await client(service).auth.admin.createUser({ email: confirmed, password: 'confirmed-password-1', email_confirm: true, user_metadata: { secret: 'not-for-you' } });
    const unconfirmed = `${uniq('unconfirmed')}@example.com`;
    const pending = await client(anon).auth.signUp({ email: unconfirmed, password: 'pending-password-1', options: { data: { secret: 'not-for-you' } } });

    for (const [email, real] of [
      [confirmed, created.data.user],
      [unconfirmed, pending.data.user],
    ]) {
      const dup = await client(anon).auth.signUp({ email, password: 'someone-else-1' });
      assert.equal(dup.error, null, email);
      assert.equal(dup.data.session, null);
      assert.deepEqual(Object.keys(dup.data.user).sort(), Object.keys(fresh.data.user).sort(), 'same fields as a new sign-up');
      assert.notEqual(dup.data.user.id, real.id);
      assert.equal(dup.data.user.email, email);
      assert.deepEqual(dup.data.user.user_metadata, {});
      assert.deepEqual(dup.data.user.identities, []);
      assert.equal(dup.data.user.email_confirmed_at, undefined);
      assert.doesNotMatch(JSON.stringify(dup.data), /not-for-you/);
    }
    // The confirmed account is untouched.
    assert.equal((await client(anon).auth.signInWithPassword({ email: confirmed, password: 'confirmed-password-1' })).error, null);
  } finally {
    await restoreSetting('mailer_autoconfirm', autoconfirm);
  }
});

test('addresses with display names, lists or quoting are rejected', async () => {
  for (const email of ['victim<attacker@evil.test>', 'victim@example.com, attacker@evil.test', 'victim@example.com;attacker@evil.test', '"victim"@example.com', 'vic tim@example.com']) {
    for (const [path, body] of [
      ['/signup', { email, password: 'long-enough-1' }],
      ['/otp', { email }],
      ['/recover', { email }],
    ]) {
      const r = await call('POST', path, { body });
      assert.equal(r.status, 400, `${path} ${email}`);
      assert.equal(r.body.error_code, 'validation_failed');
    }
  }
});

// ------------------------------------------------------------------ pre-registration

test('with autoconfirm, the first real proof of an address locks out whoever registered it', async () => {
  const { anon, service, db } = await keys();
  // No SMTP in the test stack, so sign-ups are confirmed without proof.
  const email = `${uniq('target')}@example.com`;
  const attacker = await client(anon).auth.signUp({ email, password: 'attacker-password' });
  assert.ok(attacker.data.session, 'auto-confirmed');

  // The address's owner later signs in with a magic link.
  const owner = client(anon);
  const link = await client(service).auth.admin.generateLink({ type: 'magiclink', email });
  const v = await owner.auth.verifyOtp({ token_hash: link.data.properties.hashed_token, type: 'magiclink' });
  assert.equal(v.error, null);
  assert.equal(v.data.user.id, attacker.data.user.id);

  assert.equal((await client(anon).auth.signInWithPassword({ email, password: 'attacker-password' })).error?.code, 'invalid_credentials');
  assert.equal((await call('GET', '/user', { token: attacker.data.session.access_token })).status, 403, "the attacker's session ended");
  const refresh = await call('POST', '/token?grant_type=refresh_token', { body: { refresh_token: attacker.data.session.refresh_token } });
  assert.equal(refresh.status, 400);
  assert.equal((await call('GET', '/user', { token: v.data.session.access_token })).status, 200);
  assert.ok((await sql(db, 'select email_proven_at from auth.users where id = $1', [v.data.user.id])).rows[0].email_proven_at);

  // Proven now: the owner's own password survives the next magic link.
  assert.equal((await owner.auth.updateUser({ password: 'owner-password-1' })).error, null);
  const link2 = await client(service).auth.admin.generateLink({ type: 'magiclink', email });
  assert.equal((await client(anon).auth.verifyOtp({ token_hash: link2.data.properties.hashed_token, type: 'magiclink' })).error, null);
  assert.equal((await client(anon).auth.signInWithPassword({ email, password: 'owner-password-1' })).error, null);
});

test('an address an admin confirmed counts as proven', async () => {
  const { anon, service } = await keys();
  const email = `${uniq('staff')}@example.com`;
  const created = await client(service).auth.admin.createUser({ email, password: 'staff-password-1', email_confirm: true });
  assert.equal(created.error, null);
  const session = await client(anon).auth.signInWithPassword({ email, password: 'staff-password-1' });
  const link = await client(service).auth.admin.generateLink({ type: 'magiclink', email });
  assert.equal((await client(anon).auth.verifyOtp({ token_hash: link.data.properties.hashed_token, type: 'magiclink' })).error, null);
  assert.equal((await client(anon).auth.signInWithPassword({ email, password: 'staff-password-1' })).error, null);
  assert.equal((await call('GET', '/user', { token: session.data.session.access_token })).status, 200);
});

// ------------------------------------------------------------------ enumeration and abuse

test('/recover and /resend answer the same for existing and unknown addresses', async () => {
  const { anon, service } = await keys();
  const known = `${uniq('known')}@example.com`;
  await client(service).auth.admin.createUser({ email: known, password: 'known-password-1', email_confirm: true });
  const pending = `${uniq('pending')}@example.com`;
  await client(anon).auth.signInWithOtp({ email: pending }); // creates an unconfirmed account
  const unknown = `${uniq('unknown')}@example.com`;

  for (const [path, extra, emails] of [
    ['/recover', {}, [known, unknown]],
    ['/resend', { type: 'signup' }, [known, pending, unknown]],
  ]) {
    const first = await Promise.all(emails.map((email) => call('POST', path, { body: { email, ...extra } })));
    for (const r of first) assert.equal(r.status, 200, path);
    assert.equal(new Set(first.map((r) => JSON.stringify(r.body))).size, 1, `${path}: same body`);
    const second = await Promise.all(emails.map((email) => call('POST', path, { body: { email, ...extra } })));
    for (const r of second) assert.equal(r.status, 429, `${path}: a second request within a minute is refused for every address`);
    assert.equal(new Set(second.map((r) => JSON.stringify(r.body))).size, 1, `${path}: same 429`);
  }
});

test('per-IP limits on sign-up, anonymous sign-in, OTP, recovery, resend and /authorize', async (t) => {
  if (!forwardedIpHonoured) return needsConfig(t, 'the gateway does not take X-Forwarded-For from this machine (not a trusted proxy)');
  for (const [name, method, path, body, limit] of [
    ['signup', 'POST', '/signup', { email: 'not-an-email', password: 'long-enough-1' }, 30],
    ['anonymous', 'POST', '/signup', {}, 30],
    ['otp', 'POST', '/otp', { email: 'not-an-email' }, 30],
    ['recover', 'POST', '/recover', { email: 'not-an-email' }, 30],
    ['resend', 'POST', '/resend', { type: 'signup', email: 'not-an-email' }, 30],
    ['authorize', 'GET', '/authorize?provider=nope', undefined, 60],
  ]) {
    const ip = internetIp();
    for (let i = 0; i < limit; i++) {
      const r = await call(method, path, { body, ip });
      assert.notEqual(r.status, 429, `${name}: request ${i + 1} of ${limit} was refused`);
    }
    const over = await call(method, path, { body, ip });
    assert.equal(over.status, 429, name);
    assert.equal(over.body.error_code, 'over_request_rate_limit');
    assert.notEqual((await call(method, path, { body, ip: internetIp() })).status, 429, `${name}: other addresses are not affected`);
  }
});

test('password guesses are limited per account, from any number of addresses', async (t) => {
  if (!forwardedIpHonoured) return needsConfig(t, 'the gateway does not take X-Forwarded-For from this machine (not a trusted proxy)');
  const u = await newUser();
  const signIn = (password) => call('POST', '/token?grant_type=password', { body: { email: u.email, password }, ip: internetIp() });
  // 20 wrong passwords an hour from as many addresses (one /64 each)...
  for (let i = 0; i < 20; i++) assert.equal((await signIn('wrong-password-1')).status, 400, `attempt ${i + 1}`);
  // ...then even the right one has to wait, from yet another address.
  const over = await signIn(u.password);
  assert.equal(over.status, 429);
  assert.equal(over.body.error_code, 'over_request_rate_limit');
  // Once the guessing stops, a second later the right password gets in, which starts the count over.
  await new Promise((r) => setTimeout(r, 1100));
  assert.equal((await signIn(u.password)).status, 200);
  assert.equal((await signIn('wrong-password-1')).status, 400);
});

test('someone who keeps guessing can not lock the owner out of an address they signed in from', async (t) => {
  if (!forwardedIpHonoured) return needsConfig(t, 'the gateway does not take X-Forwarded-For from this machine (not a trusted proxy)');
  const u = await newUser();
  const signIn = (password, ip) => call('POST', '/token?grant_type=password', { body: { email: u.email, password }, ip });
  // The owner has signed in from home before.
  const home = internetIp();
  assert.equal((await signIn(u.password, home)).status, 200);
  // The attacker uses up the free guesses from many addresses...
  for (let i = 0; i < 20; i++) assert.equal((await signIn('wrong-password-1', internetIp())).status, 400, `guess ${i + 1}`);
  // ...and then keeps guessing as soon as each wait is over, so the account is always waiting.
  for (const wait of [0, 1100, 2100]) {
    await new Promise((r) => setTimeout(r, wait));
    if (wait) assert.equal((await signIn('wrong-password-1', internetIp())).status, 400, `the guess after ${wait} ms went through`);
    const stranger = await signIn(u.password, internetIp());
    assert.equal(stranger.status, 429, 'a new address has to wait, even with the right password');
    assert.equal(stranger.body.error_code, 'over_request_rate_limit');
    const owner = await signIn(u.password, home);
    assert.equal(owner.status, 200, 'the owner still signs in from home');
    // A wrong password from home is just a wrong password, not a way around the wait for others.
    assert.equal((await signIn('wrong-password-1', home)).status, 400);
  }
});

// ------------------------------------------------------------------ OAuth

test('OAuth state is bound to the browser that started the sign-in and works once', async () => {
  const external = await setting('external');
  await setProjectSettings({ external: { ...(external || {}), github: { enabled: true, client_id: 'e2e-client-id', secret: 'e2e-client-secret' } } });
  try {
    const start = await fetch(`${AUTH}/authorize?provider=github`, { redirect: 'manual' });
    assert.equal(start.status, 302);
    const location = new URL(start.headers.get('location'));
    assert.equal(location.hostname, 'github.com');
    const state = location.searchParams.get('state');

    const name = `keel-oauth-${PROJECT}`;
    const setCookie = start.headers.get('set-cookie') || '';
    const m = new RegExp(`^${name}=([A-Za-z0-9_-]+);`).exec(setCookie);
    assert.ok(m, `cookie: ${setCookie}`);
    const nonce = m[1];
    for (const attr of ['Path=/', 'Max-Age=600', 'HttpOnly', 'SameSite=Lax']) assert.ok(setCookie.includes(`; ${attr}`), attr);
    assert.equal(setCookie.includes('; Secure'), /^https:/i.test(env.KEEL_PUBLIC_URL || ''));
    assert.equal(claimsOf(state).nonce, nonce, 'the cookie holds the nonce in the signed state');

    const callback = (cookie) =>
      fetch(`${AUTH}/callback?state=${encodeURIComponent(state)}&error=access_denied&error_description=e2e-cancelled`, {
        redirect: 'manual',
        headers: cookie ? { Cookie: cookie } : {},
      });
    // Another browser (no cookie, or its own) can't finish this sign-in.
    for (const cookie of [undefined, `${name}=someone-elses-nonce`, `keel-oauth-other-project=${nonce}`]) {
      const r = await callback(cookie);
      assert.equal(r.status, 400, String(cookie));
      assert.match(await r.text(), /different browser/);
      assert.equal(r.headers.get('set-cookie'), null, "a stranger's callback leaves the browser's own sign-in alone");
    }
    // The browser that started it gets through (here to the provider's error) and loses the cookie.
    const own = await callback(`${name}=${nonce}`);
    const ownBody = await own.text();
    if (own.status === 400) assert.match(ownBody, /e2e-cancelled/);
    else assert.match(own.headers.get('location') || '', /error_description=e2e-cancelled/);
    assert.match(own.headers.get('set-cookie') || '', new RegExp(`^${name}=;.*Max-Age=0`));
    // The state works once.
    const replay = await callback(`${name}=${nonce}`);
    assert.equal(replay.status, 400);
    assert.match(await replay.text(), /invalid or has expired/);
  } finally {
    await restoreSetting('external', external);
  }
});

// ------------------------------------------------------------------ misc

test('the health endpoint does not reveal the version', async () => {
  const r = await call('GET', '/health');
  assert.equal(r.status, 200);
  assert.equal(r.body.version, undefined);
  assert.doesNotMatch(JSON.stringify(r.body), /\d+\.\d+/);
});
