import { after, before, beforeEach, mock, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { JWKS_STALE_MAX_MS, clearOidcCache, discover, identityFromClaims, oidcAuthorizeUrl, oidcComplete, providerKeys, scopesFor, type OidcProvider } from './oidc.js';

// A small identity provider on 127.0.0.1, as a homelab one on the LAN would be.
const key = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
let server: http.Server;
let issuer = '';
let tweak: { discoveryIssuer?: string; idClaims?: Record<string, unknown>; userinfo?: Record<string, unknown>; tokenStatus?: number; jwksStatus?: number } = {};
const tokenRequests: { auth?: string; form: URLSearchParams }[] = [];
let jwksHits = 0;

const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
function idToken(claims: Record<string, unknown>) {
  const signed = `${enc({ alg: 'RS256', kid: 'k1' })}.${enc(claims)}`;
  return `${signed}.${crypto.sign('sha256', Buffer.from(signed), key.privateKey).toString('base64url')}`;
}

before(async () => {
  server = http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', issuer);
    const json = (status: number, body: unknown) => res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(body));
    if (url.pathname === '/realm/.well-known/openid-configuration') {
      return json(200, {
        issuer: tweak.discoveryIssuer ?? `${issuer}/realm`,
        authorization_endpoint: `${issuer}/realm/auth?prompt=login`,
        token_endpoint: `${issuer}/realm/token`,
        jwks_uri: `${issuer}/realm/jwks`,
        userinfo_endpoint: `${issuer}/realm/userinfo`,
      });
    }
    if (url.pathname === '/realm/jwks') {
      jwksHits++;
      if (tweak.jwksStatus) return json(tweak.jwksStatus, {});
      return json(200, { keys: [{ ...key.publicKey.export({ format: 'jwk' }), kid: 'k1', use: 'sig', alg: 'RS256' }] });
    }
    if (url.pathname === '/realm/token') {
      let body = '';
      for await (const chunk of req) body += chunk;
      const form = new URLSearchParams(body);
      tokenRequests.push({ auth: req.headers.authorization, form });
      if (tweak.tokenStatus) return json(tweak.tokenStatus, { error: 'invalid_grant' });
      // The code carries what the test wants in the ID token (a real provider remembers it).
      const want = JSON.parse(Buffer.from(form.get('code') || '', 'base64url').toString());
      const now = Math.floor(Date.now() / 1000);
      return json(200, {
        access_token: 'at-123',
        refresh_token: 'rt-456',
        token_type: 'Bearer',
        id_token: idToken({ iss: `${issuer}/realm`, aud: 'keel', sub: 'u-1', iat: now, exp: now + 60, nonce: want.nonce, ...(tweak.idClaims || {}) }),
      });
    }
    if (url.pathname === '/realm/userinfo') {
      if (req.headers.authorization !== 'Bearer at-123') return json(401, {});
      return json(200, tweak.userinfo ?? { sub: 'u-1', email: 'Person@Example.com', email_verified: true, name: 'A Person' });
    }
    json(404, {});
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  issuer = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(() => {
  server.closeAllConnections();
  server.close();
});

beforeEach(() => {
  tweak = {};
  tokenRequests.length = 0;
  clearOidcCache();
});

const provider = (extra: Partial<OidcProvider> = {}): OidcProvider => ({
  issuer: `${issuer}/realm/`,
  clientId: 'keel',
  secret: 's3cret: with/odd chars',
  scopes: 'email profile',
  policy: { allowHttp: true },
  ...extra,
});
const codeFor = (nonce: string) => Buffer.from(JSON.stringify({ nonce })).toString('base64url');

test('builds the authorization URL from discovery, with PKCE and nonce', async () => {
  const url = new URL(
    await oidcAuthorizeUrl(provider(), { redirectUri: 'https://keel.example.test/app/auth/v1/callback', state: 'st', nonce: 'nn', codeChallenge: 'cc', scopes: 'groups' }),
  );
  assert.equal(url.origin + url.pathname, `${issuer}/realm/auth`);
  const q = url.searchParams;
  assert.equal(q.get('prompt'), 'login', "keeps the provider's own query");
  assert.equal(q.get('response_type'), 'code');
  assert.equal(q.get('client_id'), 'keel');
  assert.equal(q.get('scope'), 'openid email profile groups');
  assert.equal(q.get('state'), 'st');
  assert.equal(q.get('nonce'), 'nn');
  assert.equal(q.get('code_challenge'), 'cc');
  assert.equal(q.get('code_challenge_method'), 'S256');
});

test('completes a sign-in: code exchange with the verifier, ID token checked, user info merged', async () => {
  const out = await oidcComplete(provider(), { redirectUri: 'https://cb.example.test/', code: codeFor('nonce-1'), nonce: 'nonce-1', codeVerifier: 'v'.repeat(43) });
  assert.equal(out.claims.sub, 'u-1');
  assert.equal(out.claims.email, 'Person@Example.com');
  assert.equal(out.tokens.access, 'at-123');
  assert.equal(out.tokens.refresh, 'rt-456');
  const [req] = tokenRequests;
  assert.equal(req.form.get('code_verifier'), 'v'.repeat(43));
  assert.equal(req.form.get('client_secret'), null, 'the secret goes in the Authorization header, not the body');
  const [id, secret] = Buffer.from(req.auth!.replace(/^Basic /, ''), 'base64').toString().split(':');
  assert.equal(decodeURIComponent(id), 'keel');
  assert.equal(decodeURIComponent(secret.replace(/\+/g, ' ')), 's3cret: with/odd chars');

  const ident = identityFromClaims(out.claims);
  assert.equal(ident.email, 'person@example.com');
  assert.equal(ident.emailVerified, true);
  assert.equal(ident.raw.provider_id, 'u-1');
});

test('a nonce that does not match the sign-in fails it', async () => {
  await assert.rejects(oidcComplete(provider(), { redirectUri: 'x', code: codeFor('other'), nonce: 'nonce-1', codeVerifier: 'v' }), /nonce does not match/);
});

test('user info for another subject is ignored', async () => {
  tweak.userinfo = { sub: 'someone-else', email: 'victim@example.com', email_verified: true };
  const out = await oidcComplete(provider(), { redirectUri: 'x', code: codeFor('n'), nonce: 'n', codeVerifier: 'v' });
  assert.equal(out.claims.email, undefined);
});

test('user info never overrides what the ID token says', async () => {
  tweak.idClaims = { email: 'a@example.com', email_verified: false };
  tweak.userinfo = { sub: 'u-1', email: 'b@example.com', email_verified: true };
  const out = await oidcComplete(provider(), { redirectUri: 'x', code: codeFor('n'), nonce: 'n', codeVerifier: 'v' });
  assert.equal(out.claims.email, 'a@example.com');
  assert.equal(identityFromClaims(out.claims).emailVerified, false);
});

test("user info's email_verified is not applied to a different address from the ID token", async () => {
  tweak.idClaims = { email: 'a@example.com' };
  tweak.userinfo = { sub: 'u-1', email: 'b@example.com', email_verified: true };
  const out = await oidcComplete(provider(), { redirectUri: 'x', code: codeFor('n'), nonce: 'n', codeVerifier: 'v' });
  assert.equal(out.claims.email, 'a@example.com');
  assert.equal(identityFromClaims(out.claims).emailVerified, false);
});

test("the ID token's email_verified is not applied to an address that came from user info", async () => {
  tweak.idClaims = { email_verified: true };
  tweak.userinfo = { sub: 'u-1', email: 'b@example.com' };
  const out = await oidcComplete(provider(), { redirectUri: 'x', code: codeFor('n'), nonce: 'n', codeVerifier: 'v' });
  assert.equal(out.claims.email, 'b@example.com');
  assert.equal(identityFromClaims(out.claims).emailVerified, false);
});

test('an address and its email_verified both from user info are used together', async () => {
  tweak.userinfo = { sub: 'u-1', email: 'b@example.com', email_verified: true };
  const out = await oidcComplete(provider(), { redirectUri: 'x', code: codeFor('n'), nonce: 'n', codeVerifier: 'v' });
  assert.equal(identityFromClaims(out.claims).emailVerified, true);
});

test('a discovery document for another issuer is refused', async () => {
  tweak.discoveryIssuer = 'https://evil.example.test/realm';
  await assert.rejects(discover(provider()), /different issuer/);
});

test('plain http needs the per-provider opt-in', async () => {
  await assert.rejects(discover(provider({ policy: { allowHttp: false } })), /must use https/);
});

test('a failed token exchange reports the error code only', async () => {
  tweak.tokenStatus = 400;
  await assert.rejects(oidcComplete(provider(), { redirectUri: 'x', code: 'c', nonce: 'n', codeVerifier: 'v' }), /token exchange failed: invalid_grant/);
});

test('the key set is cached between sign-ins', async () => {
  const before = jwksHits;
  await oidcComplete(provider(), { redirectUri: 'x', code: codeFor('n'), nonce: 'n', codeVerifier: 'v' });
  await oidcComplete(provider(), { redirectUri: 'x', code: codeFor('n'), nonce: 'n', codeVerifier: 'v' });
  assert.equal(jwksHits - before, 1);
});

test('cached keys outlive a failing key set endpoint for a day, not longer', async () => {
  const uri = `${issuer}/realm/jwks`;
  const policy = { allowHttp: true };
  mock.timers.enable({ apis: ['Date'], now: Date.now() });
  try {
    assert.equal((await providerKeys(uri, policy, false))[0].kid, 'k1');
    tweak.jwksStatus = 500;
    mock.timers.tick(2 * 60 * 60_000); // past the hour the keys are cached for
    assert.equal((await providerKeys(uri, policy, false))[0].kid, 'k1', 'the provider is down: recent keys still work');
    mock.timers.tick(JWKS_STALE_MAX_MS);
    await assert.rejects(providerKeys(uri, policy, false), /could not load the provider key set/);
    await assert.rejects(providerKeys(uri, policy, true), /could not load the provider key set/);
  } finally {
    mock.timers.reset();
  }
});

test('openid is always asked for, once', () => {
  assert.equal(scopesFor(provider({ scopes: 'openid,email' }), 'openid profile'), 'openid email profile');
});

test('an unverified or missing email is never reported as verified', () => {
  assert.equal(identityFromClaims({ sub: 'x', email: 'a@example.com' }).emailVerified, false);
  assert.equal(identityFromClaims({ sub: 'x', email: 'a@example.com', email_verified: 'true' }).emailVerified, true);
  assert.equal(identityFromClaims({ sub: 'x', email_verified: true }).emailVerified, false);
  assert.equal(identityFromClaims({ sub: 'x', email: 'a@example.com', email_verified: true }, { emailVerified: false }).emailVerified, false);
});

test("a custom provider never gets Microsoft's any-tenant issuer, not even from the cache", async () => {
  tweak.discoveryIssuer = `${issuer}/realm/{tenantid}`;
  // The Azure provider accepts the {tenantid} template and caches the document...
  assert.equal((await discover(provider({ tenantIssuer: true }))).issuer, `${issuer}/realm/{tenantid}`);
  // ...which a custom provider with the same issuer URL must not reuse.
  await assert.rejects(discover(provider()), /different issuer/);
});
