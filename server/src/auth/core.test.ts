import { test } from 'node:test';
import assert from 'node:assert/strict';
import bcrypt from 'bcryptjs';
import { WorkQueue, comparePassword, hashPassword, needsRehash, normalizeEmail, obfuscatedUser, refreshTokenFor, userJson, type IdentityRow, type UserRow } from './core.js';

test('normalizeEmail trims and lowercases plain addresses', () => {
  assert.equal(normalizeEmail('  Alice@Example.COM '), 'alice@example.com');
  assert.equal(normalizeEmail('first.last+tag@sub.example.co.uk'), 'first.last+tag@sub.example.co.uk');
});

test('normalizeEmail rejects display names, lists, groups, quoting and whitespace', () => {
  for (const bad of [
    'victim<attacker@evil.test>',
    'Victim <victim@example.com>',
    'victim@example.com, attacker@evil.test',
    'victim@example.com;attacker@evil.test',
    'team:victim@example.com;',
    '"victim"@example.com',
    'victim(comment)@example.com',
    'vic tim@example.com',
    'victim@exam\tple.com',
    'victim@example.com\r\nBcc: attacker@evil.test',
    'victim\\@example.com',
    'victim@[127.0.0.1]',
    'victim@example',
    'no-at-sign.example.com',
    'a@b@example.com',
    '',
  ]) {
    assert.throws(() => normalizeEmail(bad), { code: 'validation_failed' }, bad);
  }
  assert.throws(() => normalizeEmail(undefined), { code: 'validation_failed' });
  assert.throws(() => normalizeEmail(`${'a'.repeat(250)}@example.com`), { code: 'validation_failed' });
});

const realNewUser = (): UserRow => {
  const now = new Date();
  return {
    id: '0b5e3c1a-0000-4000-8000-000000000001',
    aud: 'authenticated',
    role: 'authenticated',
    email: 'new@example.com',
    encrypted_password: '$2a$10$hash',
    email_confirmed_at: null,
    invited_at: null,
    confirmation_sent_at: now,
    recovery_sent_at: null,
    email_change: null,
    email_change_sent_at: null,
    last_sign_in_at: null,
    raw_app_meta_data: { provider: 'email', providers: ['email'] },
    raw_user_meta_data: { name: 'New' },
    created_at: now,
    updated_at: now,
    phone: null,
    phone_confirmed_at: null,
    phone_change: '',
    phone_change_sent_at: null,
    confirmed_at: null,
    banned_until: null,
    deleted_at: null,
    is_anonymous: false,
    email_proven_at: null,
  };
};

test('the sign-up answer for an existing account has the shape of a new unconfirmed user and nothing of the account', () => {
  const identity = { id: 'i', provider_id: 'p', user_id: 'u', identity_data: {}, provider: 'email', last_sign_in_at: null, created_at: new Date(), updated_at: new Date(), email: 'new@example.com' } as IdentityRow;
  const real = JSON.parse(JSON.stringify(userJson(realNewUser(), [identity])));
  const fake = JSON.parse(JSON.stringify(obfuscatedUser('email', 'new@example.com', { name: 'Caller' }, new Date())));
  assert.deepEqual(Object.keys(fake), Object.keys(real));
  assert.match(fake.id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.notEqual(obfuscatedUser('email', 'x@example.com', {}, new Date()).id, obfuscatedUser('email', 'x@example.com', {}, new Date()).id);
  assert.equal(fake.email, 'new@example.com');
  assert.equal(fake.phone, '');
  assert.deepEqual(fake.identities, []);
  assert.deepEqual(fake.user_metadata, { name: 'Caller' }, "only the caller's own data comes back");
  assert.deepEqual(fake.app_metadata, { provider: 'email', providers: ['email'] });
  assert.equal(fake.email_confirmed_at, undefined);
  assert.equal(fake.last_sign_in_at, undefined);
  assert.ok(fake.confirmation_sent_at >= fake.created_at);

  const phone = JSON.parse(JSON.stringify(obfuscatedUser('phone', '15555550100', {}, new Date())));
  assert.equal(phone.email, '');
  assert.equal(phone.phone, '15555550100');
  assert.deepEqual(phone.app_metadata, { provider: 'phone', providers: ['phone'] });
});

test('refresh tokens are derived per session row with the project secret', () => {
  const a = refreshTokenFor('secret-1', 'session-a', '41');
  assert.match(a, /^[A-Za-z0-9_-]{32}$/);
  assert.equal(refreshTokenFor('secret-1', 'session-a', '41'), a, 'the same row gives the same token, so it can be handed out again');
  assert.notEqual(refreshTokenFor('secret-1', 'session-a', '42'), a);
  assert.notEqual(refreshTokenFor('secret-1', 'session-b', '41'), a);
  assert.notEqual(refreshTokenFor('secret-2', 'session-a', '41'), a, 'not computable without the secret');
});

test('new password hashes use bcrypt cost 12; older cost-10 hashes still verify and are flagged for an upgrade', async () => {
  const fresh = await hashPassword('correct-horse-battery');
  assert.equal(bcrypt.getRounds(fresh), 12);
  assert.equal(needsRehash(fresh), false);
  const old = bcrypt.hashSync('correct-horse-battery', 10);
  assert.equal(await comparePassword('correct-horse-battery', old), true);
  assert.equal(needsRehash(old), true);
  assert.equal(needsRehash(null), false);
  assert.equal(needsRehash('not-a-bcrypt-hash'), false);
});

test('WorkQueue runs a few jobs at once, queues a few more briefly and turns the rest away', async () => {
  const busy = () => new Error('busy');
  const q = new WorkQueue(2, 2, 200, busy);
  let running = 0;
  let most = 0;
  const releases: (() => void)[] = [];
  const job = () =>
    q.run(async () => {
      running++;
      most = Math.max(most, running);
      await new Promise<void>((r) => releases.push(r));
      running--;
      return 'done';
    });
  const jobs = [job(), job(), job(), job()];
  // Two run, two wait; a fifth has no room in the queue.
  await assert.rejects(job(), /busy/);
  await new Promise((r) => setImmediate(r));
  assert.equal(running, 2);
  // Finishing one hands its place to the next in line.
  releases.shift()!();
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(running, 2);
  releases.shift()!();
  await new Promise((r) => setTimeout(r, 10));
  while (releases.length) releases.shift()!();
  assert.deepEqual(await Promise.all(jobs), ['done', 'done', 'done', 'done']);
  assert.equal(most, 2);
});

test('WorkQueue gives up on a job that waited too long', async () => {
  const q = new WorkQueue(1, 5, 30, () => new Error('busy'));
  let release!: () => void;
  const first = q.run(() => new Promise<void>((r) => (release = r)));
  await assert.rejects(q.run(async () => 'late'), /busy/);
  release();
  await first;
  // The place is free again.
  assert.equal(await q.run(async () => 'next'), 'next');
});
