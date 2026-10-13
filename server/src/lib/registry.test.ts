import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nextKeyExpiry, signingKey } from './registry.js';

test('the next key expiry is the earliest grace period still running', () => {
  const now = 1_000_000;
  const projects = [
    { jwtKeys: [{ kid: 'a2', secret: 's' }, { kid: 'a1', secret: 's', expiresAt: now + 5000 }] },
    { jwtKeys: [{ kid: 'b2', secret: 's' }, { kid: 'b1', secret: 's', expiresAt: now + 2000 }, { kid: 'b0', secret: 's', expiresAt: now - 1 }] },
  ];
  assert.equal(nextKeyExpiry(projects, now), now + 2000);
  assert.equal(nextKeyExpiry([{ jwtKeys: [{ kid: 'x', secret: 's', expiresAt: null }] }], now), null);
});

test('new tokens are signed with the newest key', () => {
  assert.equal(signingKey({ jwtKeys: [{ kid: 'new', secret: 'n' }, { kid: 'old', secret: 'o', expiresAt: 1 }] }).kid, 'new');
});
