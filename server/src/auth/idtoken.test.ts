import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { halfHash, validateIdToken, type IdTokenCheck, type Jwk } from './idtoken.js';

const ISSUER = 'https://idp.example.test/realms/home';
const CLIENT = 'keel-app';
const NONCE = 'n-0S6_WzA2Mj';
const now = () => Math.floor(Date.now() / 1000);

const rsa = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const other = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const ec = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
const ed = crypto.generateKeyPairSync('ed25519');
const jwk = (k: crypto.KeyObject, kid: string): Jwk => ({ ...k.export({ format: 'jwk' }), kid, use: 'sig' });
const JWKS: Jwk[] = [jwk(rsa.publicKey, 'rsa1'), jwk(ec.publicKey, 'ec1'), jwk(ed.publicKey, 'ed1')];

const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');

function mint(claims: Record<string, unknown>, opts: { alg?: string; kid?: string; key?: crypto.KeyObject; header?: Record<string, unknown> } = {}): string {
  const alg = opts.alg ?? 'RS256';
  const header = { alg, typ: 'JWT', ...(opts.kid !== undefined ? { kid: opts.kid } : { kid: 'rsa1' }), ...(opts.header || {}) };
  const signed = `${enc(header)}.${enc(claims)}`;
  let sig: Buffer;
  if (alg === 'none') sig = Buffer.alloc(0);
  else if (alg.startsWith('HS')) sig = crypto.createHmac('sha256', 'client-secret').update(signed).digest();
  else if (alg === 'ES256') sig = crypto.sign('sha256', Buffer.from(signed), { key: opts.key ?? ec.privateKey, dsaEncoding: 'ieee-p1363' });
  else if (alg === 'EdDSA') sig = crypto.sign(null, Buffer.from(signed), opts.key ?? ed.privateKey);
  else sig = crypto.sign('sha256', Buffer.from(signed), opts.key ?? rsa.privateKey);
  return `${signed}.${sig.toString('base64url')}`;
}

const good = (extra: Record<string, unknown> = {}) => ({
  iss: ISSUER,
  aud: CLIENT,
  sub: 'user-123',
  iat: now(),
  exp: now() + 300,
  nonce: NONCE,
  email: 'person@example.com',
  email_verified: true,
  ...extra,
});

const check: IdTokenCheck = { issuer: ISSUER, clientId: CLIENT, nonce: NONCE };
const keys = async () => JWKS;

test('accepts a valid RS256 ID token and returns its claims', async () => {
  const claims = await validateIdToken(mint(good()), keys, check);
  assert.equal(claims.sub, 'user-123');
  assert.equal(claims.email, 'person@example.com');
});

test('accepts ES256 and EdDSA signatures', async () => {
  assert.equal((await validateIdToken(mint(good(), { alg: 'ES256', kid: 'ec1' }), keys, check)).sub, 'user-123');
  assert.equal((await validateIdToken(mint(good(), { alg: 'EdDSA', kid: 'ed1' }), keys, check)).sub, 'user-123');
});

test('rejects a bad signature', async () => {
  await assert.rejects(validateIdToken(mint(good(), { key: other.privateKey }), keys, check), /signature is invalid/);
  const t = mint(good());
  const tampered = t.split('.');
  tampered[1] = enc(good({ sub: 'admin' }));
  await assert.rejects(validateIdToken(tampered.join('.'), keys, check), /signature is invalid/);
});

test('rejects alg none and the HMAC algorithms', async () => {
  await assert.rejects(validateIdToken(mint(good(), { alg: 'none' }), keys, check), /algorithm "none" is not accepted/);
  await assert.rejects(validateIdToken(mint(good(), { alg: 'HS256' }), keys, check), /algorithm "HS256" is not accepted/);
  await assert.rejects(validateIdToken(mint(good(), { alg: 'NONE' }), keys, check), /not accepted/);
});

test('rejects a key of the wrong type for the algorithm', async () => {
  // An RS256 header pointing at the EC key: no candidate key, even after a refresh.
  await assert.rejects(validateIdToken(mint(good(), { kid: 'ec1' }), keys, check), /no key of the provider matches/);
});

test('rejects the wrong issuer', async () => {
  await assert.rejects(validateIdToken(mint(good({ iss: 'https://evil.example.test/realms/home' })), keys, check), /issuer does not match/);
  await assert.rejects(validateIdToken(mint(good({ iss: `${ISSUER}/` })), keys, check), /issuer does not match/);
});

test('rejects the wrong audience, and several audiences without a matching azp', async () => {
  await assert.rejects(validateIdToken(mint(good({ aud: 'some-other-app' })), keys, check), /audience does not match/);
  await assert.rejects(validateIdToken(mint(good({ aud: [CLIENT, 'other'] })), keys, check), /authorized party/);
  await assert.rejects(validateIdToken(mint(good({ azp: 'other' })), keys, check), /authorized party/);
  assert.ok(await validateIdToken(mint(good({ aud: [CLIENT, 'other'], azp: CLIENT })), keys, check));
});

test('rejects expired tokens, allowing a minute of clock skew', async () => {
  await assert.rejects(validateIdToken(mint(good({ exp: now() - 120 })), keys, check), /expired/);
  assert.ok(await validateIdToken(mint(good({ exp: now() - 30 })), keys, check));
  await assert.rejects(validateIdToken(mint(good({ exp: undefined })), keys, check), /expired/);
});

test('rejects tokens issued in the future or not valid yet', async () => {
  await assert.rejects(validateIdToken(mint(good({ iat: now() + 600 })), keys, check), /in the future/);
  await assert.rejects(validateIdToken(mint(good({ nbf: now() + 600 })), keys, check), /not valid yet/);
});

test('rejects a nonce mismatch or a missing nonce', async () => {
  await assert.rejects(validateIdToken(mint(good({ nonce: 'someone-elses' })), keys, check), /nonce does not match/);
  await assert.rejects(validateIdToken(mint(good({ nonce: undefined })), keys, check), /nonce does not match/);
});

test('checks at_hash against the access token when present', async () => {
  const access = 'ya29.access-token-value';
  const token = mint(good({ at_hash: halfHash('RS256', access) }));
  assert.ok(await validateIdToken(token, keys, { ...check, accessToken: access }));
  await assert.rejects(validateIdToken(token, keys, { ...check, accessToken: 'swapped-token' }), /at_hash/);
});

test('rejects a token without a subject', async () => {
  await assert.rejects(validateIdToken(mint(good({ sub: '' })), keys, check), /no subject/);
});

test('rejects malformed tokens', async () => {
  for (const t of ['', 'a.b', 'a.b.c.d', '!!.??.**', `${enc([1])}.${enc({})}.x`]) {
    await assert.rejects(validateIdToken(t, keys, check), /malformed|not accepted/, t);
  }
});

test('fetches the keys again when the kid is unknown (rotation), but not for a bad signature', async () => {
  const rotated = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const calls: boolean[] = [];
  const rotating = async (refresh: boolean) => {
    calls.push(refresh);
    return refresh ? [...JWKS, jwk(rotated.publicKey, 'rsa2')] : JWKS;
  };
  assert.ok(await validateIdToken(mint(good(), { kid: 'rsa2', key: rotated.privateKey }), rotating, check));
  assert.deepEqual(calls, [false, true]);

  calls.length = 0;
  await assert.rejects(validateIdToken(mint(good(), { key: other.privateKey }), rotating, check), /signature is invalid/);
  assert.deepEqual(calls, [false], 'a known kid with a bad signature does not refetch');
});

test("supports an issuer that depends on the token's claims (Microsoft's multi-tenant endpoint)", async () => {
  const tid = '9188040d-6c67-4c5b-b112-36a304b66dad';
  const iss = `https://login.microsoftonline.com/${tid}/v2.0`;
  const byTenant = { ...check, issuer: (c: Record<string, unknown>) => `https://login.microsoftonline.com/${String(c.tid)}/v2.0` };
  assert.ok(await validateIdToken(mint(good({ iss, tid })), keys, byTenant));
  await assert.rejects(validateIdToken(mint(good({ iss, tid: 'another-tenant' })), keys, byTenant), /issuer does not match/);
});
