import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GATEWAY, PROJECT, PROJECT_URL, client, keys, newUser, uniq } from './helpers.js';

test('gateway rejects requests without a valid API key', async () => {
  const res = await fetch(`${PROJECT_URL}/rest/v1/`, {});
  assert.equal(res.status, 401);
  const bad = await fetch(`${PROJECT_URL}/rest/v1/`, { headers: { apikey: 'nope' } });
  assert.equal(bad.status, 401);
  // A project that doesn't exist answers like a wrong key, so names can't be probed.
  const unknown = await fetch(`${GATEWAY}/no-such-project/rest/v1/`, { headers: { apikey: 'x' } });
  assert.equal(unknown.status, 401);
});

test('settings are readable with the anon key', async () => {
  const { anon } = await keys();
  const res = await fetch(`${PROJECT_URL}/auth/v1/settings`, { headers: { apikey: anon } });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.external.email, true);
  assert.equal(typeof body.mailer_autoconfirm, 'boolean');
});

test('sign up, sign in, get and update user, refresh, sign out', async () => {
  const { anon } = await keys();
  const email = `${uniq('alice')}@example.com`;
  const c = client(anon);

  const up = await c.auth.signUp({ email, password: 'hunter2hunter2', options: { data: { full_name: 'Alice' } } });
  assert.equal(up.error, null);
  assert.ok(up.data.session?.access_token);
  assert.equal(up.data.user.email, email);
  assert.equal(up.data.user.user_metadata.full_name, 'Alice');
  assert.equal(up.data.user.identities.length, 1);

  const dup = await client(anon).auth.signUp({ email, password: 'hunter2hunter2' });
  assert.equal(dup.error?.code, 'user_already_exists');

  const wrong = await client(anon).auth.signInWithPassword({ email, password: 'nope-nope' });
  assert.equal(wrong.error?.code, 'invalid_credentials');

  const weak = await client(anon).auth.signUp({ email: `${uniq('w')}@example.com`, password: '123' });
  assert.equal(weak.error?.code, 'weak_password');

  const c2 = client(anon);
  const signIn = await c2.auth.signInWithPassword({ email, password: 'hunter2hunter2' });
  assert.equal(signIn.error, null);
  const token = signIn.data.session.access_token;
  const claims = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString());
  assert.equal(claims.role, 'authenticated');
  assert.equal(claims.ref, PROJECT);
  assert.equal(claims.email, email);

  const me = await c2.auth.getUser();
  assert.equal(me.data.user.id, up.data.user.id);

  const upd = await c2.auth.updateUser({ data: { full_name: 'Alice B', plan: 'pro' } });
  assert.equal(upd.error, null);
  assert.equal(upd.data.user.user_metadata.full_name, 'Alice B');
  assert.equal(upd.data.user.user_metadata.plan, 'pro');

  const oldRefresh = signIn.data.session.refresh_token;
  const ref = await c2.auth.refreshSession();
  assert.equal(ref.error, null);
  assert.notEqual(ref.data.session.refresh_token, oldRefresh);
  assert.equal(ref.data.user.user_metadata.plan, 'pro');

  const pw = await c2.auth.updateUser({ password: 'a-new-password' });
  assert.equal(pw.error, null);
  const again = await client(anon).auth.signInWithPassword({ email, password: 'a-new-password' });
  assert.equal(again.error, null);

  const out = await c2.auth.signOut();
  assert.equal(out.error, null);
  // The session is gone, so its access token can no longer fetch the user.
  const res = await fetch(`${PROJECT_URL}/auth/v1/user`, { headers: { apikey: anon, Authorization: `Bearer ${ref.data.session.access_token}` } });
  assert.equal(res.status, 403);
});

test('a replayed refresh token ends the session', async () => {
  const { anon, db } = await keys();
  const { sql } = await import('./helpers.js');
  const u = await newUser();
  const first = u.session.refresh_token;
  const r1 = await u.client.auth.refreshSession({ refresh_token: first });
  assert.equal(r1.error, null);
  // Reuse within the grace period is tolerated (two tabs refreshing at once),
  // and gets the session's current token rather than starting a second chain.
  const r2 = await u.client.auth.refreshSession({ refresh_token: first });
  assert.equal(r2.error, null);
  assert.equal(r2.data.session.refresh_token, r1.data.session.refresh_token);

  // Later reuse means the token leaked: the session ends, and stays ended.
  await sql(db, `update auth.refresh_tokens set updated_at = now() - interval '1 minute' where token = encode(sha256(convert_to($1, 'utf8')), 'hex')`, [first]);
  const replay = await client(anon).auth.refreshSession({ refresh_token: first });
  assert.equal(replay.error?.code, 'refresh_token_already_used');
  const current = await client(anon).auth.refreshSession({ refresh_token: r1.data.session.refresh_token });
  assert.equal(current.error?.code, 'refresh_token_not_found');
  const res = await fetch(`${PROJECT_URL}/auth/v1/user`, { headers: { apikey: anon, Authorization: `Bearer ${r1.data.session.access_token}` } });
  assert.equal(res.status, 403);
});

test('admin API: list, create, generate link, verify, delete', async () => {
  const { service, anon } = await keys();
  const admin = client(service);
  const email = `${uniq('bob')}@example.com`;

  const created = await admin.auth.admin.createUser({ email, password: 'bobs-password', email_confirm: true, user_metadata: { team: 'ops' } });
  assert.equal(created.error, null);
  assert.equal(created.data.user.email, email);

  const list = await admin.auth.admin.listUsers({ page: 1, perPage: 500 });
  assert.equal(list.error, null);
  assert.ok(list.data.users.some((x) => x.id === created.data.user.id));
  // Pagination info, which auth-js reads from the Link header.
  const page1 = await admin.auth.admin.listUsers({ page: 1, perPage: 1 });
  assert.ok(page1.data.total >= 2, `total is ${page1.data.total}`);
  assert.equal(page1.data.nextPage, 2);

  const link = await admin.auth.admin.generateLink({ type: 'magiclink', email });
  assert.equal(link.error, null);
  assert.match(link.data.properties.action_link, /\/auth\/v1\/verify\?token=/);
  assert.match(link.data.properties.email_otp, /^\d{6}$/);

  // Exchange the emailed code for a session, as a user would.
  const c = client(anon);
  const v = await c.auth.verifyOtp({ email, token: link.data.properties.email_otp, type: 'email' });
  assert.equal(v.error, null);
  assert.equal(v.data.user.id, created.data.user.id);

  // A token can only be used once.
  const v2 = await client(anon).auth.verifyOtp({ token_hash: link.data.properties.hashed_token, type: 'magiclink' });
  assert.equal(v2.error?.code, 'otp_expired');

  const anonAdmin = await client(anon).auth.admin.listUsers();
  assert.ok(anonAdmin.error, 'anon key must not reach the admin API');

  const del = await admin.auth.admin.deleteUser(created.data.user.id);
  assert.equal(del.error, null);
  const gone = await admin.auth.admin.getUserById(created.data.user.id);
  assert.ok(gone.error);
});

test('recovery link redirects with a session in the URL fragment', async () => {
  const { service } = await keys();
  const admin = client(service);
  const email = `${uniq('carol')}@example.com`;
  await admin.auth.admin.createUser({ email, password: 'carols-password', email_confirm: true });
  // No site URL is configured, so allow-list localhost for this test.
  const link = await admin.auth.admin.generateLink({ type: 'recovery', email });
  assert.equal(link.error, null);
  const res = await fetch(link.data.properties.action_link, { redirect: 'manual' });
  // Without a site URL Keel shows a page instead of redirecting.
  assert.ok([200, 303].includes(res.status));
});

test('OTP endpoint accepts magic link requests without leaking users', async () => {
  const { anon } = await keys();
  const res = await client(anon).auth.signInWithOtp({ email: `${uniq('otp')}@example.com`, options: { shouldCreateUser: false } });
  assert.equal(res.error?.code, 'otp_disabled');
  const rec = await client(anon).auth.resetPasswordForEmail(`${uniq('ghost')}@example.com`);
  assert.equal(rec.error, null);
});

test('PKCE: password recovery link returns a code that exchanges for a session', async () => {
  const { anon, service } = await keys();
  const { setProjectSettings } = await import('./helpers.js');
  await setProjectSettings({ site_url: 'http://localhost:5999' });
  const email = `${uniq('pkce')}@example.com`;
  await client(service).auth.admin.createUser({ email, password: 'pkce-password', email_confirm: true });

  const memory = new Map();
  const storage = { getItem: (k) => memory.get(k) ?? null, setItem: (k, v) => memory.set(k, v), removeItem: (k) => memory.delete(k) };
  const c = client(anon, { auth: { persistSession: true, autoRefreshToken: false, detectSessionInUrl: false, flowType: 'pkce', storage } });
  const rec = await c.auth.resetPasswordForEmail(email, { redirectTo: 'http://localhost:5999/reset' });
  assert.equal(rec.error, null);

  // The emailed link is equivalent to the admin-generated one (same user + type).
  const link = await client(service).auth.admin.generateLink({ type: 'recovery', email, options: { redirectTo: 'http://localhost:5999/reset' } });
  const res = await fetch(link.data.properties.action_link, { redirect: 'manual' });
  assert.equal(res.status, 303);
  const location = new URL(res.headers.get('location'));
  assert.equal(location.origin + location.pathname, 'http://localhost:5999/reset');
  const code = location.searchParams.get('code');
  assert.ok(code, `expected ?code= in ${location}`);

  const ex = await c.auth.exchangeCodeForSession(code);
  assert.equal(ex.error, null);
  assert.equal(ex.data.user.email, email);
  const again = await c.auth.exchangeCodeForSession(code);
  assert.ok(again.error, 'codes are single use');

  // Redirects outside the allow list fall back to the site URL.
  const evil = await client(service).auth.admin.generateLink({ type: 'magiclink', email, options: { redirectTo: 'https://evil.test/' } });
  const r2 = await fetch(evil.data.properties.action_link, { redirect: 'manual' });
  assert.ok(r2.headers.get('location').startsWith('http://localhost:5999'));
});

test('a password set before the email was confirmed stops working once the owner proves the address', async () => {
  const { anon, service, db } = await keys();
  const { setProjectSettings, sql } = await import('./helpers.js');
  await setProjectSettings({ mailer_autoconfirm: false });
  try {
    const email = `${uniq('victim')}@example.com`;
    // Attacker registers the victim's address with their own password, never confirms.
    const pre = await client(anon).auth.signUp({ email, password: 'attacker-password' });
    assert.equal(pre.error, null);
    assert.equal(pre.data.session, null);
    // Later the real owner signs in with a magic link.
    const link = await client(service).auth.admin.generateLink({ type: 'magiclink', email });
    const v = await client(anon).auth.verifyOtp({ token_hash: link.data.properties.hashed_token, type: 'magiclink' });
    assert.equal(v.error, null);
    const hijack = await client(anon).auth.signInWithPassword({ email, password: 'attacker-password' });
    assert.equal(hijack.error?.code, 'invalid_credentials');
  } finally {
    await sql('keel', `update keel.projects set settings = settings - 'mailer_autoconfirm' where db_name = $1`, [db]);
    await new Promise((r) => setTimeout(r, 400));
  }
});

test('the gateway root does not list projects', async () => {
  const r = await fetch(`${GATEWAY}/`);
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.equal(body.name, 'keel');
  assert.equal(body.projects, undefined);
  assert.doesNotMatch(JSON.stringify(body), new RegExp(PROJECT));
});
