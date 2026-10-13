import crypto from 'node:crypto';

export type Claims = Record<string, unknown> & {
  role?: string;
  sub?: string;
  ref?: string;
  exp?: number;
  iat?: number;
  session_id?: string;
};

export class JwtError extends Error {}

/**
 * A project signing key. A project can have several at once while keys are
 * rolled: tokens carry the key id in their `kid` header, and a key stops
 * verifying at `expiresAt` (milliseconds) when one is set.
 */
export type JwtKey = { kid: string; secret: string; expiresAt?: number | null };

const b64url = (buf: Buffer | string) => Buffer.from(buf).toString('base64url');

/** Signs with a plain secret, or with a key (its id goes in the `kid` header). */
export function sign(claims: Claims, key: string | JwtKey): string {
  const secret = typeof key === 'string' ? key : key.secret;
  const head = typeof key === 'string' ? { alg: 'HS256', typ: 'JWT' } : { alg: 'HS256', typ: 'JWT', kid: key.kid };
  const header = b64url(JSON.stringify(head));
  const body = b64url(JSON.stringify(claims));
  const sig = crypto.createHmac('sha256', secret).update(`${header}.${body}`).digest('base64url');
  return `${header}.${body}.${sig}`;
}

/** The keys that still verify at `now`. */
export function usableKeys(keys: JwtKey[], now = Date.now()): JwtKey[] {
  return keys.filter((k) => k.expiresAt == null || k.expiresAt > now);
}

/**
 * The usable keys as a JSON Web Key Set, the form PostgREST accepts in
 * jwt-secret when more than one key verifies. PostgREST tries every key in
 * the set (jose's JWKSet key store does no kid filtering).
 */
export function jwks(keys: JwtKey[], now = Date.now()): string {
  return JSON.stringify({ keys: usableKeys(keys, now).map((k) => ({ kty: 'oct', kid: k.kid, alg: 'HS256', k: b64url(k.secret) })) });
}

/**
 * PostgREST's jwt-secret for a key set: the plain secret while one key is
 * usable (what it always got), a JWKS while keys are being rolled.
 */
export function postgrestSecret(keys: JwtKey[], now = Date.now()): string {
  const usable = usableKeys(keys, now);
  return usable.length === 1 ? usable[0].secret : jwks(usable, now);
}

function signatureMatches(secret: string, signed: string, given: Buffer): boolean {
  const expected = crypto.createHmac('sha256', secret).update(signed).digest();
  return given.length === expected.length && crypto.timingSafeEqual(given, expected);
}

/** Decodes a token without checking the signature. Only for routing decisions. */
export function decodeUnverified(token: string): Claims | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  try {
    const claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    return claims && typeof claims === 'object' ? (claims as Claims) : null;
  } catch {
    return null;
  }
}

/**
 * Verifies an HS256 token and its expiry. Throws JwtError on any problem.
 * With a key set, a token naming a key (`kid`) must be signed by that key,
 * and a token without one (issued before keys had ids) by any usable key.
 */
export function verify(token: string, secret: string | JwtKey[], now = Date.now()): Claims {
  const parts = token.split('.');
  if (parts.length !== 3) throw new JwtError('malformed token');
  const [h, b, s] = parts;
  let header: { alg?: string; kid?: unknown };
  try {
    header = JSON.parse(Buffer.from(h, 'base64url').toString('utf8'));
  } catch {
    throw new JwtError('malformed token header');
  }
  if (header.alg !== 'HS256') throw new JwtError('unsupported token algorithm');
  const given = Buffer.from(s, 'base64url');
  let candidates: string[];
  if (typeof secret === 'string') candidates = [secret];
  else {
    const keys = usableKeys(secret, now);
    candidates = (typeof header.kid === 'string' ? keys.filter((k) => k.kid === header.kid) : keys).map((k) => k.secret);
  }
  if (!candidates.some((c) => signatureMatches(c, `${h}.${b}`, given))) throw new JwtError('invalid token signature');
  let claims: Claims;
  try {
    claims = JSON.parse(Buffer.from(b, 'base64url').toString('utf8'));
  } catch {
    throw new JwtError('malformed token payload');
  }
  // An exp that isn't a number (null from an infinite lifetime) must not mean "never".
  if (claims.exp !== undefined && typeof claims.exp !== 'number') throw new JwtError('malformed token expiry');
  if (typeof claims.exp === 'number' && claims.exp * 1000 < now) throw new JwtError('token has expired');
  return claims;
}

export function randomToken(bytes = 32): string {
  return crypto.randomBytes(bytes).toString('base64url');
}

export function sha256(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}
