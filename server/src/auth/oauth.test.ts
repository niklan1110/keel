import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newAccountEmail, providerConfig } from './oauth.js';
import { enabledProviders, type AuthSettings } from './settings.js';
import { providerSecretKey, sealSecret } from './totp.js';

const PROJECT_SECRET = 'project-secret-for-tests-0123456789';

const settings = (secret: string) =>
  ({
    providers: enabledProviders({
      external: { github: { enabled: true, client_id: 'gh', secret: 'plain-old' } },
      custom_providers: [{ id: 'custom:home', enabled: true, issuer: 'https://id.example.test', client_id: 'keel', secret }],
    }),
  }) as AuthSettings;

test('opens sealed secrets and still reads plain ones stored before sealing', () => {
  const s = settings(sealSecret('the-secret', providerSecretKey(PROJECT_SECRET)));
  assert.equal(providerConfig(s, 'custom:home', PROJECT_SECRET).secret, 'the-secret');
  assert.equal(providerConfig(s, 'github', PROJECT_SECRET).secret, 'plain-old');
});

test('a secret sealed for another project cannot be opened', () => {
  const s = settings(sealSecret('the-secret', providerSecretKey('another-project-secret')));
  assert.throws(() => providerConfig(s, 'custom:home', PROJECT_SECRET), /could not be read/);
});

test('unknown providers, and names of object properties, are not enabled', () => {
  const s = settings('x');
  for (const name of ['', 'google', 'custom:other', '__proto__', 'constructor', 'toString', 'hasOwnProperty']) {
    assert.throws(() => providerConfig(s, name, PROJECT_SECRET), /Provider is not enabled/, name);
  }
});

test('an address the provider did not verify goes on a new account only with automatic confirmation', () => {
  assert.equal(newAccountEmail({ email: 'a@example.com', emailVerified: true }, false), 'a@example.com');
  assert.equal(newAccountEmail({ email: 'a@example.com', emailVerified: true }, true), 'a@example.com');
  assert.equal(newAccountEmail({ email: 'a@example.com', emailVerified: false }, true), 'a@example.com');
  assert.equal(newAccountEmail({ email: 'a@example.com', emailVerified: false }, false), null);
  assert.equal(newAccountEmail({ email: null, emailVerified: false }, true), null);
});
