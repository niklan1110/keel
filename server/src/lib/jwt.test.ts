import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodeUnverified, jwks, postgrestSecret, sign, verify } from './jwt.js';

const secret = 'test-secret-that-is-long-enough';

test('sign and verify round trip', () => {
  const token = sign({ role: 'anon', ref: 'my-app' }, secret);
  assert.deepEqual(verify(token, secret), { role: 'anon', ref: 'my-app' });
  assert.equal(decodeUnverified(token)?.ref, 'my-app');
});

test('rejects a wrong secret, tampering and alg=none', () => {
  const token = sign({ role: 'anon' }, secret);
  assert.throws(() => verify(token, 'other'), /signature/);
  const [h, , s] = token.split('.');
  const forged = `${h}.${Buffer.from(JSON.stringify({ role: 'service_role' })).toString('base64url')}.${s}`;
  assert.throws(() => verify(forged, secret), /signature/);
  const none = `${Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url')}.${Buffer.from('{"role":"service_role"}').toString('base64url')}.`;
  assert.throws(() => verify(none, secret), /algorithm/);
  assert.throws(() => verify('garbage', secret), /malformed/);
});

test('rejects expired tokens', () => {
  const token = sign({ exp: Math.floor(Date.now() / 1000) - 10 }, secret);
  assert.throws(() => verify(token, secret), /expired/);
});

test('a key with an id puts kid in the header and verifies against a key set', () => {
  const current = { kid: 'k2', secret: 'second-secret-that-is-long-enough' };
  const token = sign({ role: 'anon' }, current);
  const header = JSON.parse(Buffer.from(token.split('.')[0], 'base64url').toString('utf8'));
  assert.deepEqual(header, { alg: 'HS256', typ: 'JWT', kid: 'k2' });
  assert.deepEqual(verify(token, [{ kid: 'k1', secret }, current]), { role: 'anon' });
});

test('tokens without kid (issued before rotation) verify against any active key', () => {
  const legacy = sign({ role: 'anon' }, secret);
  assert.deepEqual(verify(legacy, [{ kid: 'k2', secret: 'second-secret-that-is-long-enough' }, { kid: 'k1', secret }]), { role: 'anon' });
});

test('a kid that names no active key is rejected, even if another key would match', () => {
  const token = sign({ role: 'anon' }, { kid: 'gone', secret });
  assert.throws(() => verify(token, [{ kid: 'k1', secret }]), /signature/);
  assert.throws(() => verify(token, []), /signature/);
});

test('a key past its expiry no longer verifies', () => {
  const now = Date.now();
  const old = { kid: 'k1', secret, expiresAt: now - 1000 };
  const token = sign({ role: 'anon' }, old);
  assert.throws(() => verify(token, [old, { kid: 'k2', secret: 'x'.repeat(40) }], now), /signature/);
  assert.throws(() => verify(sign({ role: 'anon' }, secret), [old], now), /signature/);
  assert.deepEqual(verify(token, [{ ...old, expiresAt: now + 1000 }], now), { role: 'anon' });
});

test('jwks lists the usable keys as oct JWKs for PostgREST', () => {
  const now = Date.now();
  const set = JSON.parse(jwks([{ kid: 'k2', secret: 'abc' }, { kid: 'k1', secret: 'def', expiresAt: now - 1 }, { kid: 'k0', secret: 'ghi', expiresAt: now + 1000 }], now));
  assert.deepEqual(set, {
    keys: [
      { kty: 'oct', kid: 'k2', alg: 'HS256', k: Buffer.from('abc').toString('base64url') },
      { kty: 'oct', kid: 'k0', alg: 'HS256', k: Buffer.from('ghi').toString('base64url') },
    ],
  });
});

test('PostgREST gets the plain secret for one key and a JWKS while rolling', () => {
  const now = Date.now();
  assert.equal(postgrestSecret([{ kid: 'k1', secret: 'only' }, { kid: 'k0', secret: 'old', expiresAt: now - 1 }], now), 'only');
  assert.equal(JSON.parse(postgrestSecret([{ kid: 'k2', secret: 'new' }, { kid: 'k1', secret: 'old', expiresAt: now + 1 }], now)).keys.length, 2);
});

test('a token whose exp is not a number never verifies', () => {
  // {"expiresIn": 1e400} once gave a signed URL with "exp": null, which never expired.
  assert.throws(() => verify(sign({ role: 'anon', exp: null as unknown as number }, secret), secret), /expiry/);
  assert.throws(() => verify(sign({ role: 'anon', exp: '9999999999' as unknown as number }, secret), secret), /expiry/);
  assert.equal(verify(sign({ role: 'anon' }, secret), secret).role, 'anon');
});
