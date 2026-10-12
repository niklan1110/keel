// Sign-in with a custom OpenID Connect provider (provider "custom:<id>").
//
// The provider is a tiny OpenID Connect server deployed as an edge function
// of the project under test. keel-auth reaches it on the Docker network at
// http://keel-gateway:8000/<project>/functions/v1/<name> (plain http on your
// own network, so the provider allows http), the same way the SMS webhook
// test reaches its function. This test plays the browser: it reads the
// state, nonce and PKCE challenge Keel sends to the provider's authorization
// endpoint and comes back to Keel's callback with a code. The code carries
// what the provider should put in the ID token; its token endpoint checks
// the client secret and Keel's PKCE verifier and signs an RS256 ID token.

import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import { PROJECT, PROJECT_URL, deployFunction, keys, newUser, sql, studio, uniq } from './helpers.js';

const AUTH = `${PROJECT_URL}/auth/v1`;
const FN = uniq('oidc');
const ID = `custom:${FN}`;
const ISSUER = `http://keel-gateway:8000/${PROJECT}/functions/v1/${FN}`;
const CLIENT_ID = 'keel-e2e-client';
const CLIENT_SECRET = `e2e-secret-${crypto.randomBytes(8).toString('hex')}`;
const SITE = 'http://localhost:5173';
const COOKIE = `keel-oauth-${PROJECT}`;

const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const PRIVATE_JWK = privateKey.export({ format: 'jwk' });
const PUBLIC_JWK = { ...publicKey.export({ format: 'jwk' }), kid: 'e2e-1', use: 'sig', alg: 'RS256' };

const providerSource = `const ISSUER = ${JSON.stringify(ISSUER)};
const PRIVATE = ${JSON.stringify(PRIVATE_JWK)};
const PUBLIC = ${JSON.stringify(PUBLIC_JWK)};
const BASIC = 'Basic ' + btoa(${JSON.stringify(`${CLIENT_ID}:${CLIENT_SECRET}`)});
const te = new TextEncoder();
const b64u = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\\+/g, '-').replace(/\\//g, '_').replace(/=+$/, '');
const enc = (o) => b64u(te.encode(JSON.stringify(o)));
const key = await crypto.subtle.importKey('jwk', PRIVATE, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);

Deno.serve(async (req) => {
  const path = new URL(req.url).pathname;
  if (path.endsWith('/.well-known/openid-configuration')) {
    return Response.json({
      issuer: ISSUER,
      authorization_endpoint: ISSUER + '/authorize',
      token_endpoint: ISSUER + '/token',
      jwks_uri: ISSUER + '/jwks',
      response_types_supported: ['code'],
      subject_types_supported: ['public'],
      id_token_signing_alg_values_supported: ['RS256'],
    });
  }
  if (path.endsWith('/jwks')) return Response.json({ keys: [PUBLIC] });
  if (path.endsWith('/token') && req.method === 'POST') {
    const form = new URLSearchParams(await req.text());
    if (req.headers.get('authorization') !== BASIC) return Response.json({ error: 'invalid_client' }, { status: 401 });
    const want = JSON.parse(atob((form.get('code') || '').replace(/-/g, '+').replace(/_/g, '/')));
    const challenge = b64u(await crypto.subtle.digest('SHA-256', te.encode(form.get('code_verifier') || '')));
    if (challenge !== want.challenge) return Response.json({ error: 'invalid_grant' }, { status: 400 });
    const access = 'at-' + crypto.randomUUID();
    const atHash = b64u(new Uint8Array(await crypto.subtle.digest('SHA-256', te.encode(access))).slice(0, 16));
    const now = Math.floor(Date.now() / 1000);
    const claims = { iss: want.iss ?? ISSUER, aud: ${JSON.stringify(CLIENT_ID)}, sub: want.sub, iat: now, exp: now + 300, nonce: want.nonce, at_hash: atHash, name: 'E2E Person' };
    if (want.email) Object.assign(claims, { email: want.email, email_verified: want.email_verified });
    const signed = enc({ alg: 'RS256', typ: 'JWT', kid: PUBLIC.kid }) + '.' + enc(claims);
    const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, te.encode(signed));
    return Response.json({ access_token: access, token_type: 'Bearer', expires_in: 300, id_token: signed + '.' + b64u(sig) });
  }
  return new Response('not found', { status: 404 });
});
`;

let original;
const settingsNow = async () => (await sql('keel', 'select settings from keel.projects where name = $1', [PROJECT])).rows[0].settings || {};
const patchSettings = async (patch) => {
  await sql('keel', `update keel.projects set settings = settings || $2::jsonb where name = $1`, [PROJECT, JSON.stringify(patch)]);
  await new Promise((r) => setTimeout(r, 500));
};

before(async () => {
  original = await settingsNow();
  await deployFunction(FN, { [`${FN}/index.ts`]: providerSource }, { verifyJwt: false });
  await patchSettings({ site_url: SITE, disable_signup: false });
});

after(async () => {
  await sql('keel', 'update keel.projects set settings = $2 where name = $1', [PROJECT, JSON.stringify(original)]);
  await studio('DELETE', `/api/projects/${PROJECT}/functions/${FN}`);
});

function pkceClient(anon) {
  return createClient(PROJECT_URL, anon, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false, flowType: 'pkce' },
  });
}

/**
 * Runs a sign-in up to Keel's callback, as a browser would. `idToken` says
 * what the provider puts in the ID token; `tamper` can change the code's
 * contents (a wrong nonce, another issuer) before it goes back to Keel.
 */
async function signInThroughProvider(c, idToken, tamper = (x) => x) {
  const { data, error } = await c.auth.signInWithOAuth({ provider: ID, options: { redirectTo: `${SITE}/welcome`, skipBrowserRedirect: true } });
  assert.equal(error, null, error?.message);
  const start = await fetch(data.url, { redirect: 'manual' });
  assert.equal(start.status, 302, await start.text());
  const to = new URL(start.headers.get('location'));
  assert.equal(`${to.origin}${to.pathname}`, `${ISSUER}/authorize`);
  const q = to.searchParams;
  const cookie = new RegExp(`^${COOKIE}=([^;]+)`).exec(start.headers.get('set-cookie') || '')?.[1];
  assert.ok(cookie, 'the browser gets the sign-in cookie');
  const code = Buffer.from(JSON.stringify(tamper({ ...idToken, nonce: q.get('nonce'), challenge: q.get('code_challenge') }))).toString('base64url');
  const back = await fetch(`${AUTH}/callback?code=${code}&state=${encodeURIComponent(q.get('state'))}`, {
    redirect: 'manual',
    headers: { Cookie: `${COOKIE}=${cookie}` },
  });
  return { authorize: q, back, location: back.headers.get('location') || '' };
}

/** The error a failed sign-in sends back to the app, in the redirect's fragment. */
function errorOf(location) {
  assert.ok(location.includes('#'), `expected an error redirect, got ${location}`);
  return new URLSearchParams(new URL(location).hash.slice(1)).get('error_description') || '';
}

test('Studio stores a custom provider with a sealed secret and never returns it', async () => {
  const put = await studio('PUT', `/api/projects/${PROJECT}/settings`, {
    custom_providers: [{ id: ID, enabled: true, name: 'E2E IdP', issuer: ISSUER, client_id: CLIENT_ID, secret: CLIENT_SECRET, scopes: 'email profile', allow_http: true }],
  });
  assert.equal(put.status, 200, JSON.stringify(put.data));
  const p = put.data.custom_providers.find((x) => x.id === ID);
  assert.equal(p.has_secret, true);
  assert.equal(p.secret, undefined);
  assert.equal(JSON.stringify(put.data).includes(CLIENT_SECRET), false);
  const get = await studio('GET', `/api/projects/${PROJECT}/settings`);
  assert.equal(JSON.stringify(get.data).includes(CLIENT_SECRET), false);
  const stored = (await settingsNow()).custom_providers.find((x) => x.id === ID);
  assert.match(stored.secret, /^v1:/, 'sealed in the database');
  assert.equal(stored.secret.includes(CLIENT_SECRET), false);

  // Plain http is refused unless allowed for the provider.
  const http = await studio('PUT', `/api/projects/${PROJECT}/settings`, {
    custom_providers: [{ id: ID, enabled: true, issuer: ISSUER, client_id: CLIENT_ID, allow_http: false }],
  });
  assert.equal(http.status, 400);
  assert.match(http.data.message || http.data.error || JSON.stringify(http.data), /https/);

  await new Promise((r) => setTimeout(r, 500));
  const s = await (await fetch(`${AUTH}/settings`, { headers: { apikey: (await keys()).anon } })).json();
  assert.equal(s.external[ID], true, 'listed in /settings');
});

test('signs in a new user through the provider with supabase-js (PKCE)', async () => {
  const { anon } = await keys();
  const c = pkceClient(anon);
  const email = `${uniq('oidc')}@example.com`;
  const { authorize, back, location } = await signInThroughProvider(c, { sub: uniq('sub'), email, email_verified: true });
  assert.equal(authorize.get('client_id'), CLIENT_ID);
  assert.equal(authorize.get('code_challenge_method'), 'S256');
  assert.equal(authorize.get('scope'), 'openid email profile');
  assert.match(authorize.get('redirect_uri'), new RegExp(`/${PROJECT}/auth/v1/callback$`));
  assert.ok(authorize.get('nonce'));

  assert.equal(back.status, 302, await back.text());
  const target = new URL(location);
  assert.equal(`${target.origin}${target.pathname}`, `${SITE}/welcome`);
  const code = target.searchParams.get('code');
  assert.ok(code, location);
  const { data, error } = await c.auth.exchangeCodeForSession(code);
  assert.equal(error, null, error?.message);
  assert.equal(data.user.email, email);
  assert.equal(data.user.app_metadata.provider, ID);
  assert.ok(data.user.email_confirmed_at);
  assert.equal(data.user.identities[0].provider, ID);
  assert.equal(data.user.identities[0].identity_data.name, 'E2E Person');
});

test('signing in again with the same subject reaches the same user', async () => {
  const { anon } = await keys();
  const who = { sub: uniq('sub'), email: `${uniq('oidc')}@example.com`, email_verified: true };
  const ids = [];
  for (let i = 0; i < 2; i++) {
    const c = pkceClient(anon);
    const { location } = await signInThroughProvider(c, who);
    const { data, error } = await c.auth.exchangeCodeForSession(new URL(location).searchParams.get('code'));
    assert.equal(error, null, error?.message);
    ids.push(data.user.id);
  }
  assert.equal(ids[0], ids[1]);
});

test('links to an existing account only when the provider says the email is verified', async () => {
  const { anon } = await keys();
  const existing = await newUser();
  const unverified = await signInThroughProvider(pkceClient(anon), { sub: uniq('sub'), email: existing.email, email_verified: false });
  assert.equal(unverified.back.status, 302);
  assert.match(errorOf(unverified.location), /account with this email already exists/, 'an unverified address neither links nor takes over the account');

  const c = pkceClient(anon);
  const verified = await signInThroughProvider(c, { sub: uniq('sub'), email: existing.email, email_verified: true });
  const { data, error } = await c.auth.exchangeCodeForSession(new URL(verified.location).searchParams.get('code'));
  assert.equal(error, null, error?.message);
  assert.equal(data.user.id, existing.user.id);
  assert.deepEqual(data.user.identities.map((i) => i.provider).sort(), ['email', ID].sort());
});

test('with email confirmation on, an address the provider did not verify stays off the new account', async () => {
  const { anon } = await keys();
  const before = await settingsNow();
  await patchSettings({ mailer_autoconfirm: false });
  try {
    const c = pkceClient(anon);
    const email = `${uniq('oidc')}@example.com`;
    const { back, location } = await signInThroughProvider(c, { sub: uniq('sub'), email, email_verified: false });
    assert.equal(back.status, 302);
    const { data, error } = await c.auth.exchangeCodeForSession(new URL(location).searchParams.get('code'));
    assert.equal(error, null, error?.message);
    assert.ok(data.session, 'signed in');
    assert.equal(data.user.email || '', '', 'no unproven address on the account');
    assert.equal(data.user.email_confirmed_at ?? null, null);
    const claims = JSON.parse(Buffer.from(data.session.access_token.split('.')[1], 'base64url').toString());
    assert.equal(claims.email || '', '', 'nor in the session token');
    // The provider's address is kept where it belongs: in the identity and the profile.
    assert.equal(data.user.identities[0].identity_data.email, email);
    assert.equal(data.user.identities[0].identity_data.email_verified, false);
    assert.equal(data.user.user_metadata.email, email);
  } finally {
    if (before.mailer_autoconfirm === undefined) {
      await sql('keel', `update keel.projects set settings = settings - 'mailer_autoconfirm' where name = $1`, [PROJECT]);
      await new Promise((r) => setTimeout(r, 500));
    } else {
      await patchSettings({ mailer_autoconfirm: before.mailer_autoconfirm });
    }
  }
});

test('an ID token with the wrong nonce or issuer is refused', async () => {
  const { anon } = await keys();
  for (const tamper of [(x) => ({ ...x, nonce: 'not-the-nonce' }), (x) => ({ ...x, iss: 'http://keel-gateway:8000/someone-else' })]) {
    const { back, location } = await signInThroughProvider(pkceClient(anon), { sub: uniq('sub'), email: `${uniq('oidc')}@example.com`, email_verified: true }, tamper);
    assert.equal(back.status, 302);
    assert.match(errorOf(location), /ID token (nonce|issuer) does not match/);
  }
});

test('a code exchanged with the wrong PKCE verifier is refused by the provider', async () => {
  const { anon } = await keys();
  const { location } = await signInThroughProvider(pkceClient(anon), { sub: uniq('sub'), email: `${uniq('oidc')}@example.com`, email_verified: true }, (x) => ({
    ...x,
    challenge: 'a-challenge-keel-did-not-send',
  }));
  assert.match(errorOf(location), /token exchange failed: invalid_grant/);
});

test('respects "Allow new sign-ups" being off', async () => {
  const { anon } = await keys();
  await patchSettings({ disable_signup: true });
  try {
    const { location } = await signInThroughProvider(pkceClient(anon), { sub: uniq('sub'), email: `${uniq('oidc')}@example.com`, email_verified: true });
    assert.match(errorOf(location), /Signups not allowed/);
  } finally {
    await patchSettings({ disable_signup: false });
  }
});

test('a disabled custom provider cannot be used', async () => {
  const s = await settingsNow();
  await patchSettings({ custom_providers: s.custom_providers.map((p) => (p.id === ID ? { ...p, enabled: false } : p)) });
  try {
    const r = await fetch(`${AUTH}/authorize?provider=${encodeURIComponent(ID)}`, { redirect: 'manual' });
    assert.equal(r.status, 400);
    assert.match((await r.json()).msg, /Provider is not enabled/);
  } finally {
    await patchSettings({ custom_providers: s.custom_providers });
  }
});
