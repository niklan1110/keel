import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createClient } from '@supabase/supabase-js';
import { GATEWAY, sql, studio, uniq, waitFor } from './helpers.js';

// Rolling a project's keys. A planned roll signs new tokens with a new key
// and keeps the old one verifying for a grace period, so apps on the old
// anon key and signed-in users carry on. Revoking ends the grace period.
// An emergency roll stops the old key at once and signs every user out.
// Runs on a project of its own, so other tests keep their keys.

const project = `keys-${Date.now().toString(36)}`;
const P = `/api/projects/${project}`;
const API = `${GATEWAY}/${project}`;
const kidOf = (token) => JSON.parse(Buffer.from(token.split('.')[0], 'base64url').toString('utf8')).kid;
const opts = { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } };

/** Status of a REST call through the gateway with this API key (and user token). */
const rest = async (apikey, token = apikey) => (await fetch(`${API}/rest/v1/`, { headers: { apikey, Authorization: `Bearer ${token}` } })).status;
/** Status of an auth call that needs a valid user token. */
const authUser = async (apikey, token) => (await fetch(`${API}/auth/v1/user`, { headers: { apikey, Authorization: `Bearer ${token}` } })).status;
/** PostgREST restarts with the new key set; wait until a call gives `status`. */
const restBecomes = (status, apikey, token) => waitFor(async () => (await rest(apikey, token)) === status, { timeout: 30_000, label: `REST answering ${status}` });

let first; // keys the project was created with
const user = { email: `${uniq('roll')}@example.com`, password: 'correct-horse-battery' };
let session; // the user's session from before any roll

before(async () => {
  const c = await studio('POST', '/api/projects', { name: project });
  assert.equal(c.status, 201, JSON.stringify(c.data));
  first = (await studio('GET', `${P}/connect`)).data;
  await restBecomes(200, first.anonKey);
  const admin = createClient(API, first.serviceKey, opts);
  const created = await admin.auth.admin.createUser({ email: user.email, password: user.password, email_confirm: true });
  assert.ifError(created.error);
  const signIn = await createClient(API, first.anonKey, opts).auth.signInWithPassword(user);
  assert.ifError(signIn.error);
  session = signIn.data.session;
});

after(async () => {
  await studio('DELETE', P, { confirm: project });
});

test('a new project has one signing key, named in its tokens', async () => {
  const r = await studio('GET', `${P}/keys`);
  assert.equal(r.status, 200);
  assert.equal(r.data.keys.length, 1);
  assert.equal(r.data.keys[0].current, true);
  assert.equal(kidOf(first.anonKey), r.data.keys[0].kid);
  assert.equal(kidOf(session.access_token), r.data.keys[0].kid, 'user tokens carry the kid too');
});

test('roll input is checked', async () => {
  assert.equal((await studio('POST', `${P}/keys/roll`, { graceHours: 0 })).status, 400);
  assert.equal((await studio('POST', `${P}/keys/roll`, { graceHours: 'soon' })).status, 400);
  const noConfirm = await studio('POST', `${P}/keys/roll`, { emergency: true });
  assert.equal(noConfirm.status, 400);
  assert.equal(noConfirm.data.error, 'confirm_required');
});

let second; // keys after the planned roll
let refreshed; // the user's session refreshed onto the new key

test('planned roll: new keys work, old keys and sessions keep working in the grace period', async () => {
  const r = await studio('POST', `${P}/keys/roll`, { graceHours: 24 });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  second = r.data;
  assert.notEqual(second.anonKey, first.anonKey);
  assert.notEqual(second.serviceKey, first.serviceKey);
  assert.equal(kidOf(second.anonKey), second.kid);

  // Connect shows the new keys.
  const connect = (await studio('GET', `${P}/connect`)).data;
  assert.equal(connect.anonKey, second.anonKey);
  assert.equal(connect.serviceKey, second.serviceKey);

  // The key list: the new key signs, the old one verifies for about 24 hours.
  const list = (await studio('GET', `${P}/keys`)).data;
  assert.equal(list.keys.length, 2);
  assert.equal(list.keys[0].kid, second.kid);
  assert.equal(list.keys[0].current, true);
  const until = Date.parse(list.keys[1].expiresAt) - Date.now();
  assert.ok(until > 23 * 3600_000 && until <= 24 * 3600_000, `old key verifies for 24 hours (${until} ms)`);
  assert.equal(list.events[0].action, 'roll');
  assert.equal(list.events[0].kid, second.kid);
  assert.match(list.events[0].actor, /^studio:/);

  await restBecomes(200, second.anonKey);
  assert.equal(await rest(first.anonKey), 200, 'the old anon key still works');
  assert.equal(await rest(second.serviceKey), 200);

  // The user signed in before the roll stays signed in.
  assert.equal(await authUser(second.anonKey, session.access_token), 200, 'the old access token still verifies');
  assert.equal(await rest(second.anonKey, session.access_token), 200);
  const r2 = await createClient(API, second.anonKey, opts).auth.refreshSession({ refresh_token: session.refresh_token });
  assert.ifError(r2.error);
  refreshed = r2.data.session;
  assert.equal(kidOf(refreshed.access_token), second.kid, 'refreshed tokens are signed with the new key');
  assert.equal(await authUser(second.anonKey, refreshed.access_token), 200);
});

test('revoking the old key stops it; the refreshed session carries on', async () => {
  const r = await studio('POST', `${P}/keys/revoke-old`);
  assert.equal(r.status, 200);
  assert.deepEqual(r.data.revoked, [kidOf(first.anonKey)]);

  await waitFor(async () => (await rest(first.anonKey)) === 401, { timeout: 10_000, label: 'the gateway refusing the old anon key' });
  assert.equal(await authUser(second.anonKey, session.access_token), 403, 'an access token signed with the old key no longer verifies');
  await restBecomes(401, second.anonKey, session.access_token);
  assert.equal(await rest(second.anonKey), 200);
  assert.equal(await authUser(second.anonKey, refreshed.access_token), 200);
  assert.equal(await rest(second.anonKey, refreshed.access_token), 200);

  const list = (await studio('GET', `${P}/keys`)).data;
  assert.equal(list.keys.length, 1);
  assert.equal(list.events[0].action, 'revoke');
});

test('an old key stops verifying when its grace period ends', async () => {
  const r = await studio('POST', `${P}/keys/roll`, { graceHours: 1 });
  assert.equal(r.status, 200);
  const third = r.data;
  await restBecomes(200, third.anonKey);
  assert.equal(await rest(second.anonKey), 200);
  // Shorten the grace period to a few seconds, as if the hour had passed.
  await sql('keel', `update keel.project_jwt_keys set expires_at = now() + interval '3 seconds' where project = $1 and kid = $2`, [project, second.kid]);
  await waitFor(async () => (await rest(second.anonKey)) === 401, { timeout: 15_000, label: 'the expired key being refused' });
  await restBecomes(200, third.anonKey);
  second = third;
  const signIn = await createClient(API, second.anonKey, opts).auth.signInWithPassword(user);
  assert.ifError(signIn.error);
  refreshed = signIn.data.session;
});

test('emergency roll: old keys stop at once and every user is signed out', async () => {
  const r = await studio('POST', `${P}/keys/roll`, { emergency: true, confirm: project });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const third = r.data;
  assert.deepEqual(third.revoked, [second.kid]);
  assert.ok(third.endedSessions >= 1);

  await waitFor(async () => (await rest(second.anonKey)) === 401, { timeout: 10_000, label: 'the old anon key being refused' });
  await restBecomes(200, third.anonKey);
  assert.equal(await authUser(third.anonKey, refreshed.access_token), 403, 'old access tokens are refused');
  const again = await createClient(API, third.anonKey, opts).auth.refreshSession({ refresh_token: refreshed.refresh_token });
  assert.ok(again.error, 'the refresh token ended with its session');
  const signIn = await createClient(API, third.anonKey, opts).auth.signInWithPassword(user);
  assert.ifError(signIn.error);
  assert.equal(kidOf(signIn.data.session.access_token), third.kid);

  const list = (await studio('GET', `${P}/keys`)).data;
  assert.deepEqual(list.keys.map((k) => k.kid), [third.kid]);
  assert.deepEqual(list.events.slice(0, 2).map((e) => e.action).sort(), ['end_sessions', 'roll_emergency']);
});
