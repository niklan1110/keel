import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import { GATEWAY, PROJECT, PROJECT_URL, STUDIO, client, env, keys, newUser, sql, studio, uniq, waitFor } from './helpers.js';

// What ends up in logs and in the database: no sign-in links, codes or
// readable personal data in the logs, no plain TOTP secrets in the database,
// and no open, auto-confirmed sign-ups on projects created on a public server.

const piiLogged = /^(1|true|yes|on)$/i.test(env.KEEL_LOG_PII || '');

/** Recent log lines of one service, read through Studio, or null without Docker access. */
async function logText(service, tail = 500) {
  const r = await studio('GET', `/api/stack/${service}/logs?tail=${tail}`);
  if (r.status !== 200 || !r.data.docker) return null;
  return r.data.lines.map((l) => l.msg).join('\n');
}

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

test('a password reset request leaves no link, code or address in the keel-auth log', async (t) => {
  if (piiLogged) return t.skip('KEEL_LOG_PII is on');
  if ((await logText('keel-auth', 1)) === null) return t.skip('Studio has no Docker access, so logs cannot be read');
  const { anon, service, db } = await keys();
  const email = `${uniq('logs')}@example.com`;
  const created = await client(service).auth.admin.createUser({ email, password: 'correct-horse-battery', email_confirm: true });
  assert.equal(created.error, null, created.error?.message);

  assert.equal((await client(anon).auth.resetPasswordForEmail(email)).error, null);
  const token = (await sql(db, `select token_hash from auth.one_time_tokens where user_id = $1 and token_type = 'recovery'`, [created.data.user.id])).rows[0]?.token_hash;
  assert.ok(token, 'a recovery token was issued');

  // With or without a mail server, keel-auth logs one line about the email, with the address masked.
  const masked = `${email[0]}***@example.com`;
  const text = await waitFor(
    async () => {
      const s = await logText('keel-auth');
      return s && /recovery email/.test(s) && s.includes(masked) ? s : null;
    },
    { timeout: 10_000, label: 'the recovery email log line' },
  );
  assert.ok(!text.includes(email), 'the full address is not logged');
  assert.ok(!text.includes(token), 'the token is not logged');
  assert.doesNotMatch(text, /\/verify\?token=/, 'no verification link is logged');
  assert.doesNotMatch(text, /\bcode=\d{6}\b/, 'no one-time code is logged');
});

test('the gateway logs the route of a storage request, not the object name', async (t) => {
  if (piiLogged) return t.skip('KEEL_LOG_PII is on');
  if ((await logText('keel-gateway', 1)) === null) return t.skip('Studio has no Docker access, so logs cannot be read');
  const userId = crypto.randomUUID();
  const file = uniq('holiday-photo');
  await fetch(`${PROJECT_URL}/storage/v1/object/public/avatars/${userId}/${file}.png`);
  const text = await waitFor(
    async () => {
      const s = await logText('keel-gateway', 1000);
      return s && s.includes(`/${PROJECT}/storage/v1/object/public/avatars/*`) ? s : null;
    },
    { timeout: 10_000, label: 'the storage request in the gateway log' },
  );
  assert.ok(!text.includes(file), 'the file name is not logged');
  assert.ok(!text.includes(userId), 'the user id in the path is not logged');
});

test('a failed Studio sign-in with an unknown name does not log what was typed', async (t) => {
  if ((await logText('keel-studio', 1)) === null) return t.skip('Studio has no Docker access, so logs cannot be read');
  const typed = uniq('maybe-a-password');
  const r = await fetch(`${STUDIO}/api/login`, {
    method: 'POST',
    headers: { 'X-Keel-Studio': '1', 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: typed, password: 'wrong-password' }),
  });
  assert.equal(r.status, 401);
  const text = await waitFor(
    async () => {
      const s = await logText('keel-studio');
      return s && /studio sign-in failed/.test(s) ? s : null;
    },
    { timeout: 10_000, label: 'the failed sign-in log line' },
  );
  assert.ok(!text.includes(typed));
});

test('TOTP secrets are stored encrypted, and MFA works as before', async () => {
  const u = await newUser();
  const enrolled = await u.client.auth.mfa.enroll({ factorType: 'totp', friendlyName: 'Encrypted' });
  assert.equal(enrolled.error, null, enrolled.error?.message);
  const { id: factorId, totp: { secret } } = enrolled.data;
  const { db } = await keys();
  const stored = (await sql(db, 'select secret from auth.mfa_factors where id = $1', [factorId])).rows[0].secret;
  assert.match(stored, /^v1:/);
  assert.ok(!stored.includes(secret), 'the base32 secret is not stored as is');

  const ok = await u.client.auth.mfa.challengeAndVerify({ factorId, code: totpCode(secret) });
  assert.equal(ok.error, null, ok.error?.message);
  assert.equal((await u.client.auth.mfa.getAuthenticatorAssuranceLevel()).data.currentLevel, 'aal2');
  assert.equal((await u.client.auth.mfa.unenroll({ factorId })).error, null);
});

test('a TOTP secret stored in plain text (older version or a Supabase import) still verifies', async () => {
  const u = await newUser();
  const { db } = await keys();
  const secret = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';
  const factorId = (
    await sql(db, `insert into auth.mfa_factors (user_id, friendly_name, factor_type, secret, status) values ($1, 'Imported', 'totp', $2, 'verified') returning id`, [u.user.id, secret])
  ).rows[0].id;
  const ok = await u.client.auth.mfa.challengeAndVerify({ factorId, code: totpCode(secret) });
  assert.equal(ok.error, null, ok.error?.message);
  assert.equal((await u.client.auth.mfa.getAuthenticatorAssuranceLevel()).data.currentLevel, 'aal2');
});

test('a password hash with a lower bcrypt cost still signs in and is upgraded', async (t) => {
  let bcrypt;
  try {
    bcrypt = (await import('bcryptjs')).default;
  } catch {
    return t.skip('bcryptjs is not installed here');
  }
  const { anon, db } = await keys();
  const u = await newUser();
  await sql(db, 'update auth.users set encrypted_password = $2 where id = $1', [u.user.id, bcrypt.hashSync(u.password, 10)]);
  const r = await client(anon).auth.signInWithPassword({ email: u.email, password: u.password });
  assert.equal(r.error, null, r.error?.message);
  const hash = (await sql(db, 'select encrypted_password from auth.users where id = $1', [u.user.id])).rows[0].encrypted_password;
  assert.equal(bcrypt.getRounds(hash), 12);
  assert.equal((await client(anon).auth.signInWithPassword({ email: u.email, password: u.password })).error, null);
});

test('a project created while the public address is on the internet does not start with open, auto-confirmed sign-ups', async () => {
  const name = `pub-${Date.now().toString(36)}`;
  const existing = (await studio('GET', `/api/projects/${PROJECT}/settings`)).data;
  const set = await studio('PUT', '/api/internet/address', { publicUrl: 'https://api.keel-e2e.test' });
  assert.equal(set.status, 200, JSON.stringify(set.data));
  try {
    const made = await studio('POST', '/api/projects', { name });
    assert.equal(made.status, 201, JSON.stringify(made.data));
    const s = (await studio('GET', `/api/projects/${name}/settings`)).data;
    assert.equal(s.public_url_private, false);
    assert.equal(s.mailer_autoconfirm, false);
    const mail = !!s.smtp.host || s.global_smtp;
    assert.equal(s.disable_signup, !mail, 'without a mail server, sign-ups start turned off');

    // Through the API, as an app would.
    const info = (await studio('GET', `/api/projects/${name}/connect`)).data;
    const sb = createClient(`${GATEWAY}/${name}`, info.anonKey, { auth: { persistSession: false, autoRefreshToken: false } });
    const up = await waitFor(
      async () => {
        const r = await sb.auth.signUp({ email: `${uniq('stranger')}@example.com`, password: 'correct-horse-battery' });
        return r.error?.code === 'project_not_found' || r.error?.status === 401 ? null : r;
      },
      { timeout: 10_000, label: 'the new project in the gateway' },
    );
    if (mail) assert.equal(up.data.session, null, 'the account needs confirming');
    else assert.equal(up.error?.code, 'signup_disabled');

    // Projects that already existed keep their settings.
    const after = (await studio('GET', `/api/projects/${PROJECT}/settings`)).data;
    assert.equal(after.disable_signup, existing.disable_signup);
    assert.equal(after.mailer_autoconfirm, existing.mailer_autoconfirm);
  } finally {
    await studio('PUT', '/api/internet/address', { publicUrl: null });
    await studio('DELETE', `/api/projects/${name}`, { confirm: name });
  }
});

test('a project created on a local address keeps the usual defaults', async (t) => {
  const s0 = (await studio('GET', `/api/projects/${PROJECT}/settings`)).data;
  if (!s0.public_url_private) return t.skip('this stack has a public KEEL_PUBLIC_URL');
  const name = `lan-${Date.now().toString(36)}`;
  const made = await studio('POST', '/api/projects', { name });
  assert.equal(made.status, 201, JSON.stringify(made.data));
  try {
    const s = (await studio('GET', `/api/projects/${name}/settings`)).data;
    assert.equal(s.disable_signup, false);
    assert.equal(s.mailer_autoconfirm, null);
  } finally {
    await studio('DELETE', `/api/projects/${name}`, { confirm: name });
  }
});
