import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ProjectSettings } from '../lib/registry.js';
import { enabledProviders } from '../auth/settings.js';
import { maskProviders, mergeBuiltinProviders, mergeCustomProviders } from './providers.js';

const seal = (s: string) => `sealed(${s})`;

const authentik = {
  id: 'custom:authentik',
  enabled: true,
  name: 'Authentik',
  issuer: 'https://auth.example.test/application/o/keel/',
  client_id: 'keel',
  secret: 'shh',
  scopes: 'email profile groups',
};

test('custom providers are stored with a sealed secret and come back without it', () => {
  const cur: ProjectSettings = {};
  mergeCustomProviders(cur, [authentik], seal);
  assert.equal(cur.custom_providers![0].secret, 'sealed(shh)');
  assert.equal(cur.custom_providers![0].issuer, 'https://auth.example.test/application/o/keel/', 'the issuer is kept exactly as typed');
  const masked = maskProviders(cur);
  assert.equal(JSON.stringify(masked).includes('shh'), false);
  assert.deepEqual(masked.custom_providers[0], {
    id: 'custom:authentik',
    enabled: true,
    name: 'Authentik',
    icon_url: '',
    issuer: 'https://auth.example.test/application/o/keel/',
    client_id: 'keel',
    scopes: 'email profile groups',
    allow_http: false,
    has_secret: true,
  });
});

test('an update without a secret keeps the stored one; leaving a provider out removes it', () => {
  const cur: ProjectSettings = {};
  mergeCustomProviders(cur, [authentik, { ...authentik, id: 'custom:pocket-id', issuer: 'https://id.example.test' }], seal);
  mergeCustomProviders(cur, [{ ...authentik, secret: '', name: 'Renamed' }], seal);
  assert.equal(cur.custom_providers!.length, 1);
  assert.equal(cur.custom_providers![0].secret, 'sealed(shh)');
  assert.equal(cur.custom_providers![0].name, 'Renamed');
});

test('a stored secret never follows a changed issuer or URL to another host', () => {
  const cur: ProjectSettings = {};
  mergeCustomProviders(cur, [authentik], seal);
  assert.throws(
    () => mergeCustomProviders(cur, [{ ...authentik, secret: '', issuer: 'https://evil.example.test/' }], seal),
    /enter the client secret again when you change the Issuer URL/,
  );
  assert.equal(cur.custom_providers![0].issuer, authentik.issuer, 'nothing changed');
  mergeCustomProviders(cur, [{ ...authentik, secret: 'new', issuer: 'https://id2.example.test/' }], seal);
  assert.equal(cur.custom_providers![0].secret, 'sealed(new)');

  const ext: ProjectSettings = {};
  mergeBuiltinProviders(ext, { gitlab: { enabled: true, client_id: 'gl', secret: 'gsec', url: 'https://gitlab.example.test' } }, seal);
  assert.throws(() => mergeBuiltinProviders(ext, { gitlab: { enabled: true, client_id: 'gl', url: 'https://evil.example.test' } }, seal), /enter the client secret again/);
  assert.throws(() => mergeBuiltinProviders(ext, { gitlab: { enabled: true, client_id: 'gl', url: '' } }, seal), /enter the client secret again/);
  mergeBuiltinProviders(ext, { gitlab: { enabled: false, client_id: 'gl', url: 'https://gitlab.example.test' } }, seal);
  assert.equal(ext.external!.gitlab!.secret, 'sealed(gsec)', 'the same URL keeps the secret');
});

test('an id without the custom: prefix gets it', () => {
  const cur: ProjectSettings = {};
  mergeCustomProviders(cur, [{ ...authentik, id: 'Keycloak' }], seal);
  assert.equal(cur.custom_providers![0].id, 'custom:keycloak');
});

test('custom providers are validated', () => {
  const bad: [Record<string, unknown>, RegExp][] = [
    [{ id: 'custom:Bad Id' }, /Identifier/],
    [{ id: 'custom:' }, /Identifier/],
    [{ id: `custom:${'a'.repeat(50)}` }, /Identifier/],
    [{ issuer: '' }, /Issuer URL is required/],
    [{ issuer: 'http://auth.example.test' }, /must start with https/],
    [{ issuer: 'https://user:pw@auth.example.test' }, /user name or password/],
    [{ issuer: 'https://auth.example.test/?x=1' }, /query or fragment/],
    [{ issuer: 'javascript:alert(1)', allow_http: true }, /https:\/\/ or http:\/\//],
    [{ client_id: '' }, /Client ID is required/],
    [{ secret: '' }, /Client secret is required/],
    [{ icon_url: 'http://img.example.test/x.png' }, /Icon URL must start with https/],
    [{ scopes: 'email "profile"' }, /Scopes/],
    [{ name: 'x'.repeat(61) }, /Name is too long/],
  ];
  for (const [patch, re] of bad) {
    assert.throws(() => mergeCustomProviders({}, [{ ...authentik, ...patch }], seal), re, JSON.stringify(patch));
  }
  assert.throws(() => mergeCustomProviders({}, [authentik, authentik], seal), /used twice/);
  assert.throws(() => mergeCustomProviders({}, 'nope', seal), /must be a list/);
});

test('plain http is accepted only when allowed for that provider', () => {
  const cur: ProjectSettings = {};
  mergeCustomProviders(cur, [{ ...authentik, issuer: 'http://192.168.1.5:9000/application/o/keel/', allow_http: true }], seal);
  assert.equal(cur.custom_providers![0].allow_http, true);
});

test('built-in providers: secrets sealed, GitLab URL and plain http, Azure tenant URL', () => {
  const cur: ProjectSettings = { external: { github: { enabled: true, client_id: 'gh', secret: 'old-plain' } } };
  mergeBuiltinProviders(
    cur,
    {
      github: { enabled: true, client_id: 'gh2' },
      discord: { enabled: true, client_id: 'dc', secret: 'dsec' },
      gitlab: { enabled: true, client_id: 'gl', secret: 'gsec', url: 'http://gitlab.lan', allow_http: true },
      azure: { enabled: true, client_id: 'az', secret: 'asec', url: 'https://login.microsoftonline.com/00000000-0000-0000-0000-000000000000', allow_http: true },
    },
    seal,
  );
  assert.equal(cur.external!.github!.secret, 'old-plain', 'kept when no new secret is sent');
  assert.equal(cur.external!.github!.client_id, 'gh2');
  assert.equal(cur.external!.discord!.secret, 'sealed(dsec)');
  assert.equal(cur.external!.gitlab!.url, 'http://gitlab.lan');
  assert.equal(cur.external!.azure!.allow_http, undefined, 'Azure never uses plain http');
  assert.throws(() => mergeBuiltinProviders({}, { azure: { url: 'http://login.example.test' } }, seal), /https/);
  const masked = maskProviders(cur);
  assert.equal(masked.external.discord.has_secret, true);
  assert.equal(masked.external.google.enabled, false);
  assert.equal(JSON.stringify(masked).match(/dsec|gsec|asec|old-plain|sealed/), null);
});

test('enabledProviders lists only providers that are on and complete', () => {
  const s: ProjectSettings = {
    external: { github: { enabled: true, client_id: 'a', secret: 'b' }, google: { enabled: true, client_id: 'a' }, gitlab: { enabled: false, client_id: 'a', secret: 'b' } },
    custom_providers: [
      { ...authentik },
      { ...authentik, id: 'custom:off', enabled: false },
      { ...authentik, id: 'not-custom' },
      { ...authentik, id: 'custom:nosecret', secret: undefined },
    ],
  };
  const p = enabledProviders(s);
  assert.deepEqual(Object.keys(p).sort(), ['custom:authentik', 'github']);
  assert.equal(p['custom:authentik'].kind, 'oidc');
  assert.equal(p['custom:authentik'].url, authentik.issuer);
  assert.equal(p['custom:authentik'].scopes, 'email profile groups');
  assert.equal(enabledProviders({}).constructor, Object);
});
