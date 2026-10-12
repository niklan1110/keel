import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodeUnverified, verify } from './jwt.js';
import { generateKeys, keyGraceHours, newJwtKey } from './projects.js';

test('the grace period defaults to 24 hours and takes whole hours up to 30 days', () => {
  assert.equal(keyGraceHours(undefined), 24);
  assert.equal(keyGraceHours(''), 24);
  assert.equal(keyGraceHours(1), 1);
  assert.equal(keyGraceHours('720'), 720);
  for (const bad of [0, -1, 1.5, 721, 'soon', {}]) assert.throws(() => keyGraceHours(bad), /whole number of hours/);
});

test('new keys get a random id and secret', () => {
  const a = newJwtKey();
  const b = newJwtKey();
  assert.match(a.kid, /^[0-9a-f]{12}$/);
  assert.notEqual(a.kid, b.kid);
  assert.ok(a.secret.length >= 64);
});

test('anon and service keys are signed with the key and name it in kid', () => {
  const key = newJwtKey();
  const { anonKey, serviceKey } = generateKeys('my-app', key);
  const header = JSON.parse(Buffer.from(anonKey.split('.')[0], 'base64url').toString('utf8'));
  assert.equal(header.kid, key.kid);
  assert.equal(verify(anonKey, [key]).role, 'anon');
  assert.equal(verify(serviceKey, [key]).role, 'service_role');
  assert.equal(decodeUnverified(serviceKey)?.ref, 'my-app');
});
