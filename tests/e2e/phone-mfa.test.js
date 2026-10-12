import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { PROJECT, client, deployFunction, keys, newUser, setProjectSettings, sql, studio, uniq, waitFor } from './helpers.js';

// Test numbers never reach a provider and accept a fixed code.
const TEST_PHONE = `1555${String(Date.now()).slice(-7)}`;
const TEST_CODE = '424242';
const sink = uniq('smssink');

const totpCode = (secret, offset = 0) => {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const ch of secret) bits += alphabet.indexOf(ch).toString(2).padStart(5, '0');
  const key = Buffer.from(bits.match(/.{8}/g).map((b) => parseInt(b, 2)));
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30000) + offset));
  const mac = crypto.createHmac('sha1', key).update(msg).digest();
  const o = mac[mac.length - 1] & 0xf;
  return String((mac.readUInt32BE(o) & 0x7fffffff) % 1e6).padStart(6, '0');
};

const claimsOf = (token) => JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString());

before(async () => {
  const { db } = await keys();
  await sql(
    db,
    `create table if not exists public.sms_outbox (id bigint generated always as identity primary key, phone text, otp text, message text, signed boolean, created_at timestamptz default now());
     create table if not exists public.vault_items (id int primary key, secret text);
     insert into public.vault_items values (1, 'only with MFA') on conflict do nothing;
     drop policy if exists "aal2 only" on public.vault_items;
     create policy "aal2 only" on public.vault_items for select to authenticated using ((auth.jwt() ->> 'aal') = 'aal2');`,
  );
  await new Promise((r) => setTimeout(r, 600));
});

after(async () => {
  await setProjectSettings({ phone: { enabled: false }, mfa: {} });
  await studio('DELETE', `/api/projects/${PROJECT}/functions/${sink}`);
  await studio('DELETE', `/api/projects/${PROJECT}/secrets/SMS_WEBHOOK_SECRET`);
});

test('phone sign-in is off until a provider is configured', async () => {
  const { anon } = await keys();
  const r = await client(anon).auth.signInWithOtp({ phone: `+${TEST_PHONE}` });
  assert.equal(r.error?.code, 'phone_provider_disabled');
  const settings = await (await fetch(`${client(anon).supabaseUrl}/auth/v1/settings`, { headers: { apikey: anon } })).json();
  assert.equal(settings.external.phone, false);
});

test('passwordless SMS sign-in with signInWithOtp + verifyOtp (test number)', async () => {
  await setProjectSettings({ phone: { enabled: true, provider: 'log', test_otp: { [TEST_PHONE]: TEST_CODE } } });
  const { anon } = await keys();
  const c = client(anon);
  const settings = await (await fetch(`${c.supabaseUrl}/auth/v1/settings`, { headers: { apikey: anon } })).json();
  assert.equal(settings.external.phone, true);

  const sent = await c.auth.signInWithOtp({ phone: `+1 (${TEST_PHONE.slice(1, 4)}) ${TEST_PHONE.slice(4)}` });
  assert.equal(sent.error, null);
  const wrong = await c.auth.verifyOtp({ phone: `+${TEST_PHONE}`, token: '000000', type: 'sms' });
  assert.equal(wrong.error?.code, 'otp_expired');
  const { data, error } = await c.auth.verifyOtp({ phone: `+${TEST_PHONE}`, token: TEST_CODE, type: 'sms' });
  assert.equal(error, null);
  assert.equal(data.user.phone, TEST_PHONE);
  assert.ok(data.user.phone_confirmed_at);
  assert.equal(data.user.identities[0].provider, 'phone');
  assert.equal(claimsOf(data.session.access_token).phone, TEST_PHONE);
});

test('phone + password sign-up, confirmation code delivered through a webhook to an edge function', async () => {
  // The SMS webhook posts to an edge function that checks the signature and stores the message.
  await studio('PUT', `/api/projects/${PROJECT}/secrets`, { secrets: { SMS_WEBHOOK_SECRET: 'whsec-e2e' } });
  await deployFunction(
    sink,
    {
      [`${sink}/index.ts`]: `Deno.serve(async (req) => {
  const body = await req.text();
  const ts = req.headers.get('x-keel-timestamp');
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(Deno.env.get('SMS_WEBHOOK_SECRET')), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(ts + '.' + body)));
  const expected = 'sha256=' + [...mac].map((b) => b.toString(16).padStart(2, '0')).join('');
  const msg = JSON.parse(body);
  const r = await fetch(Deno.env.get('SUPABASE_URL') + '/rest/v1/sms_outbox', {
    method: 'POST',
    headers: { apikey: Deno.env.get('SUPABASE_SERVICE_ROLE_KEY'), Authorization: 'Bearer ' + Deno.env.get('SUPABASE_SERVICE_ROLE_KEY'), 'Content-Type': 'application/json' },
    body: JSON.stringify({ phone: msg.phone, otp: msg.otp, message: msg.message, signed: expected === req.headers.get('x-keel-signature') }),
  });
  return Response.json({ message_id: 'sink-' + r.status }, { status: r.ok ? 200 : 500 });
});
`,
    },
    { verifyJwt: false },
  );
  await setProjectSettings({
    phone: {
      enabled: true,
      provider: 'webhook',
      webhook: { url: `http://keel-gateway:8000/${PROJECT}/functions/v1/${sink}`, secret: 'whsec-e2e' },
      template: 'Your Keel code: {{ .Code }}',
    },
  });
  const { anon, db } = await keys();
  const phone = `4477${String(Date.now()).slice(-7)}`;
  const c = client(anon);
  const up = await c.auth.signUp({ phone: `+${phone}`, password: 'correct-horse-battery' });
  assert.equal(up.error, null, up.error?.message);
  assert.equal(up.data.session, null);
  assert.equal(up.data.user.phone, phone);

  const early = await client(anon).auth.signInWithPassword({ phone: `+${phone}`, password: 'correct-horse-battery' });
  assert.equal(early.error?.code, 'phone_not_confirmed');

  const sms = await waitFor(async () => (await sql(db, 'select * from public.sms_outbox where phone = $1 order by id desc limit 1', [`+${phone}`])).rows[0], {
    label: 'SMS delivered to the webhook',
  });
  assert.equal(sms.signed, true);
  assert.equal(sms.message, `Your Keel code: ${sms.otp}`);
  const v = await c.auth.verifyOtp({ phone: `+${phone}`, token: sms.otp, type: 'sms' });
  assert.equal(v.error, null);
  const again = await client(anon).auth.signInWithPassword({ phone: `+${phone}`, password: 'correct-horse-battery' });
  assert.equal(again.error, null);
  assert.equal(again.data.user.phone, phone);
});

test('TOTP MFA: enroll, verify, aal2 sessions, RLS on aal, unenroll', async () => {
  await setProjectSettings({ mfa: {} });
  const u = await newUser();
  const c = u.client;

  const enrolled = await c.auth.mfa.enroll({ factorType: 'totp', friendlyName: 'Phone app' });
  assert.equal(enrolled.error, null, enrolled.error?.message);
  assert.match(enrolled.data.totp.qr_code, /^data:image\/svg\+xml;utf-8,<svg/);
  assert.match(enrolled.data.totp.uri, /^otpauth:\/\/totp\//);
  const { id: factorId, totp: { secret } } = enrolled.data;

  const bad = await c.auth.mfa.challengeAndVerify({ factorId, code: '000000' });
  assert.equal(bad.error?.code, 'mfa_verification_failed');
  const ok = await c.auth.mfa.challengeAndVerify({ factorId, code: totpCode(secret) });
  assert.equal(ok.error, null, ok.error?.message);
  assert.equal(claimsOf(ok.data.access_token).aal, 'aal2');
  const aal = await c.auth.mfa.getAuthenticatorAssuranceLevel();
  assert.equal(aal.data.currentLevel, 'aal2');
  assert.ok(aal.data.currentAuthenticationMethods.some((m) => m.method === 'totp'));

  // The same code can't be used twice.
  const replay = await c.auth.mfa.challengeAndVerify({ factorId, code: totpCode(secret) });
  assert.equal(replay.error?.code, 'mfa_verification_failed');

  const rows = await c.from('vault_items').select('secret');
  assert.deepEqual(rows.data, [{ secret: 'only with MFA' }]);

  // A fresh sign-in starts at aal1 and must step up.
  const { anon } = await keys();
  const c2 = client(anon);
  await c2.auth.signInWithPassword({ email: u.email, password: u.password });
  const lvl = await c2.auth.mfa.getAuthenticatorAssuranceLevel();
  assert.equal(lvl.data.currentLevel, 'aal1');
  assert.equal(lvl.data.nextLevel, 'aal2');
  assert.deepEqual((await c2.from('vault_items').select('secret')).data, []);
  const factors = await c2.auth.mfa.listFactors();
  assert.equal(factors.data.totp.length, 1);
  assert.equal((await c2.auth.mfa.enroll({ factorType: 'totp' })).error?.code, 'insufficient_aal');
  assert.equal((await c2.auth.updateUser({ password: 'another-password-1' })).error?.code, 'insufficient_aal');
  assert.equal((await c2.auth.mfa.unenroll({ factorId })).error?.code, 'insufficient_aal');

  // Refreshing keeps the level the session reached.
  const refreshed = await c.auth.refreshSession();
  assert.equal(claimsOf(refreshed.data.session.access_token).aal, 'aal2');

  const gone = await c.auth.mfa.unenroll({ factorId });
  assert.equal(gone.error, null);
  assert.equal((await c.auth.mfa.listFactors()).data.all.length, 0);
});

test('phone MFA factor and admin factor management', async () => {
  const phone = `1555${String(Date.now() + 7).slice(-7)}`;
  await setProjectSettings({ phone: { enabled: true, provider: 'log', test_otp: { [phone]: '135790' } }, mfa: { phone: true } });
  const u = await newUser();
  const enrolled = await u.client.auth.mfa.enroll({ factorType: 'phone', phone: `+${phone}` });
  assert.equal(enrolled.error, null, enrolled.error?.message);
  const ch = await u.client.auth.mfa.challenge({ factorId: enrolled.data.id });
  assert.equal(ch.error, null);
  const v = await u.client.auth.mfa.verify({ factorId: enrolled.data.id, challengeId: ch.data.id, code: '135790' });
  assert.equal(v.error, null, v.error?.message);
  assert.equal(claimsOf(v.data.access_token).aal, 'aal2');

  const { service } = await keys();
  const admin = client(service).auth.admin;
  const list = await admin.mfa.listFactors({ userId: u.user.id });
  assert.equal(list.data.factors.length, 1);
  assert.equal(list.data.factors[0].status, 'verified');
  const del = await admin.mfa.deleteFactor({ userId: u.user.id, id: enrolled.data.id });
  assert.equal(del.error, null);
  assert.equal((await admin.mfa.listFactors({ userId: u.user.id })).data.factors.length, 0);
});

test('signing up with the phone number of an account confirmed by email does not touch it', async () => {
  await setProjectSettings({ phone: { enabled: true, provider: 'log', test_otp: {} } });
  const { anon, service } = await keys();
  const email = `${uniq('owner')}@example.com`;
  const phone = `1555${String(Date.now() + 11).slice(-7)}`;
  const created = await client(service).auth.admin.createUser({ email, password: 'owner-password-1', email_confirm: true, phone });
  assert.equal(created.error, null, created.error?.message);
  assert.equal(created.data.user.phone_confirmed_at, undefined);

  const attack = await client(anon).auth.signUp({ phone: `+${phone}`, password: 'attacker-password' });
  // Phone confirmation is on, so the answer looks like any new sign-up and says nothing about the account.
  assert.equal(attack.error, null);
  assert.equal(attack.data.session, null);
  assert.notEqual(attack.data.user.id, created.data.user.id);
  assert.equal(attack.data.user.email, '');
  assert.deepEqual(attack.data.user.identities, []);
  const hijack = await client(anon).auth.signInWithPassword({ email, password: 'attacker-password' });
  assert.equal(hijack.error?.code, 'invalid_credentials');
  assert.equal((await client(anon).auth.signInWithPassword({ email, password: 'owner-password-1' })).error, null);
});

test('signing up again with an unconfirmed number changes nothing and gets nobody in', async () => {
  const { anon, db } = await keys();
  const phone = `1555${String(Date.now() + 17).slice(-7)}`;
  await setProjectSettings({ phone: { enabled: true, provider: 'log', test_otp: { [phone]: '975310' } } });
  const owner = await client(anon).auth.signUp({ phone: `+${phone}`, password: 'owner-password-1', options: { data: { name: 'Owner' } } });
  assert.equal(owner.error, null);
  assert.equal(owner.data.session, null);

  const attack = await client(anon).auth.signUp({ phone: `+${phone}`, password: 'attacker-password', options: { data: { name: 'Attacker' } } });
  assert.equal(attack.error, null);
  assert.equal(attack.data.session, null);
  assert.notEqual(attack.data.user.id, owner.data.user.id);
  assert.deepEqual(attack.data.user.identities, []);
  assert.deepEqual(attack.data.user.user_metadata, { name: 'Attacker' });
  const row = (await sql(db, 'select raw_user_meta_data, encrypted_password from auth.users where id = $1', [owner.data.user.id])).rows[0];
  assert.deepEqual(row.raw_user_meta_data, { name: 'Owner' });
  assert.equal(row.encrypted_password, null, 'two sign-ups disagreed on the password, so neither is kept');

  // The number's owner confirms it: signed in by the code, but neither password works.
  const v = await client(anon).auth.verifyOtp({ phone: `+${phone}`, token: '975310', type: 'sms' });
  assert.equal(v.error, null);
  assert.equal(v.data.user.id, owner.data.user.id);
  for (const password of ['attacker-password', 'owner-password-1']) {
    assert.equal((await client(anon).auth.signInWithPassword({ phone: `+${phone}`, password })).error?.code, 'invalid_credentials', password);
  }
});

test('SMS codes can only be checked as phone + code (no precomputed hashes)', async () => {
  const { anon } = await keys();
  const phone = `1555${String(Date.now() + 13).slice(-7)}`;
  await setProjectSettings({ phone: { enabled: true, provider: 'log', test_otp: { [phone]: '246810' } } });
  await client(anon).auth.signInWithOtp({ phone: `+${phone}` });
  const r = await fetch(`${client(anon).supabaseUrl}/auth/v1/verify`, {
    method: 'POST',
    headers: { apikey: anon, 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'sms', token_hash: crypto.createHash('sha256').update(phone + '246810').digest('hex') }),
  });
  assert.equal(r.status, 400);
  const ok = await client(anon).auth.verifyOtp({ phone: `+${phone}`, token: '246810', type: 'sms' });
  assert.equal(ok.error, null);
});
