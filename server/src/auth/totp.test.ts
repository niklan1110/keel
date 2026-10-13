import assert from 'node:assert/strict';
import test from 'node:test';
import { base32Decode, base32Encode, hotp, isSealed, openSecret, sealSecret, totp, totpKey, verifyTotp } from './totp.js';

// RFC 6238 appendix B uses the ASCII secret "12345678901234567890".
const SECRET = base32Encode(Buffer.from('12345678901234567890'));

test('base32 round trip', () => {
  assert.equal(SECRET, 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
  assert.equal(base32Decode(SECRET).toString(), '12345678901234567890');
});

test('RFC 4226 HOTP vectors', () => {
  assert.deepEqual([0, 1, 2, 9].map((c) => hotp(SECRET, c)), ['755224', '287082', '359152', '520489']);
});

test('RFC 6238 TOTP vectors (last 6 digits)', () => {
  assert.equal(totp(SECRET, 59_000), '287082');
  assert.equal(totp(SECRET, 1111111109_000), '081804');
  assert.equal(totp(SECRET, 2000000000_000), '279037');
});

test('verifyTotp accepts one step of drift and returns the step', () => {
  const now = 1111111109_000;
  assert.equal(verifyTotp(SECRET, '081804', now), Math.floor(1111111109 / 30));
  assert.notEqual(verifyTotp(SECRET, totp(SECRET, now - 30_000), now), null);
  assert.equal(verifyTotp(SECRET, totp(SECRET, now - 90_000), now), null);
  assert.equal(verifyTotp(SECRET, 'abcdef', now), null);
});

test('TOTP secrets are sealed per project and older plain secrets still open', () => {
  const key = totpKey('project-one-jwt-secret');
  const sealed = sealSecret(SECRET, key);
  assert.ok(isSealed(sealed));
  assert.ok(!sealed.includes(SECRET));
  assert.notEqual(sealSecret(SECRET, key), sealed, 'a fresh IV each time');
  assert.equal(openSecret(sealed, key), SECRET);
  assert.equal(openSecret(SECRET, key), SECRET);
  assert.throws(() => openSecret(sealed, totpKey('project-two-jwt-secret')));
});
