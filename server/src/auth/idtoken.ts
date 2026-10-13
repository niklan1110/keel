import crypto from 'node:crypto';

/**
 * OpenID Connect ID token validation (OpenID Connect Core 1.0, 3.1.3.7):
 * https://openid.net/specs/openid-connect-core-1_0.html#IDTokenValidation
 *
 * Only asymmetric signatures are accepted. "none" and the HMAC algorithms
 * (HS256 etc.) are refused: with HS* the client secret would be the key,
 * and anyone holding it could mint tokens.
 */

export class IdTokenError extends Error {}

export type Jwk = crypto.JsonWebKey & { kid?: string; use?: string; alg?: string; kty?: string };

const ALGS: Record<string, { kty: string; hash: string | null; pss?: boolean; crv?: string }> = {
  RS256: { kty: 'RSA', hash: 'sha256' },
  RS384: { kty: 'RSA', hash: 'sha384' },
  RS512: { kty: 'RSA', hash: 'sha512' },
  PS256: { kty: 'RSA', hash: 'sha256', pss: true },
  PS384: { kty: 'RSA', hash: 'sha384', pss: true },
  PS512: { kty: 'RSA', hash: 'sha512', pss: true },
  ES256: { kty: 'EC', hash: 'sha256', crv: 'P-256' },
  ES384: { kty: 'EC', hash: 'sha384', crv: 'P-384' },
  ES512: { kty: 'EC', hash: 'sha512', crv: 'P-521' },
  EdDSA: { kty: 'OKP', hash: null, crv: 'Ed25519' },
};

export const SUPPORTED_ALGS = Object.keys(ALGS);

/** Seconds of clock difference tolerated between Keel and the provider. */
export const CLOCK_SKEW_S = 60;

export type IdTokenCheck = {
  /** The expected "iss". A function gets the unverified claims (Microsoft's multi-tenant issuer depends on "tid"). */
  issuer: string | ((claims: Record<string, unknown>) => string);
  clientId: string;
  nonce: string;
  /** When given and the token has at_hash, it must match. */
  accessToken?: string;
  now?: number;
};

const b64json = (part: string): Record<string, unknown> => {
  let v: unknown;
  try {
    v = JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
  } catch {
    throw new IdTokenError('malformed ID token');
  }
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new IdTokenError('malformed ID token');
  return v as Record<string, unknown>;
};

/** Splits a compact JWS without trusting any of it. */
export function decodeIdToken(token: string): { header: Record<string, unknown>; claims: Record<string, unknown>; signed: string; signature: Buffer } {
  const parts = typeof token === 'string' ? token.split('.') : [];
  if (parts.length !== 3 || parts.some((p) => !/^[A-Za-z0-9_-]*$/.test(p))) throw new IdTokenError('malformed ID token');
  return { header: b64json(parts[0]), claims: b64json(parts[1]), signed: `${parts[0]}.${parts[1]}`, signature: Buffer.from(parts[2], 'base64url') };
}

/** The keys in a JWKS that could have made a signature with this header. */
export function candidateKeys(jwks: Jwk[], header: Record<string, unknown>): Jwk[] {
  const alg = ALGS[String(header.alg)];
  if (!alg) return [];
  return jwks.filter(
    (k) =>
      k &&
      k.kty === alg.kty &&
      (k.use === undefined || k.use === 'sig') &&
      (k.alg === undefined || k.alg === header.alg) &&
      (alg.crv === undefined || k.crv === alg.crv) &&
      (header.kid === undefined || k.kid === header.kid),
  );
}

export function verifySignature(alg: string, jwk: Jwk, signed: string, signature: Buffer): boolean {
  const a = ALGS[alg];
  if (!a) return false;
  let key: crypto.KeyObject;
  try {
    // Only the public members, so a JWKS that leaks a private key can't make us sign with it.
    const { kty, n, e, crv, x, y } = jwk;
    key = crypto.createPublicKey({ key: { kty, n, e, crv, x, y } as crypto.JsonWebKey, format: 'jwk' });
  } catch {
    return false;
  }
  const data = Buffer.from(signed);
  try {
    if (a.kty === 'OKP') return crypto.verify(null, data, key, signature);
    if (a.kty === 'EC') return crypto.verify(a.hash, data, { key, dsaEncoding: 'ieee-p1363' }, signature);
    if (a.pss) return crypto.verify(a.hash, data, { key, padding: crypto.constants.RSA_PKCS1_PSS_PADDING, saltLength: crypto.constants.RSA_PSS_SALTLEN_DIGEST }, signature);
    return crypto.verify(a.hash, data, key, signature);
  } catch {
    return false;
  }
}

/** at_hash / c_hash: the left half of the access token's hash, base64url (Core 3.1.3.6). */
export function halfHash(alg: string, value: string): string {
  const hash = ALGS[alg]?.hash ?? 'sha512'; // EdDSA with Ed25519 uses SHA-512
  const d = crypto.createHash(hash).update(value, 'ascii').digest();
  return d.subarray(0, d.length / 2).toString('base64url');
}

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

/**
 * Validates an ID token against the provider's keys. `keys` is asked for the
 * key set and is called again with `refresh` set when no key matches, so a
 * provider that rotated its keys keeps working. Returns the claims.
 */
export async function validateIdToken(
  token: string,
  keys: (refresh: boolean) => Promise<Jwk[]>,
  check: IdTokenCheck,
): Promise<Record<string, unknown>> {
  const { header, claims, signed, signature } = decodeIdToken(token);
  const alg = String(header.alg ?? '');
  if (!ALGS[alg]) throw new IdTokenError(`ID token algorithm "${alg}" is not accepted`);
  if (header.crit !== undefined) throw new IdTokenError('ID token has unsupported critical headers');

  let candidates = candidateKeys(await keys(false), header);
  let ok = candidates.some((k) => verifySignature(alg, k, signed, signature));
  if (!ok && (candidates.length === 0 || header.kid === undefined)) {
    candidates = candidateKeys(await keys(true), header);
    ok = candidates.some((k) => verifySignature(alg, k, signed, signature));
  }
  if (!candidates.length) throw new IdTokenError('no key of the provider matches the ID token');
  if (!ok) throw new IdTokenError('ID token signature is invalid');

  const now = Math.floor((check.now ?? Date.now()) / 1000);
  const issuer = typeof check.issuer === 'function' ? check.issuer(claims) : check.issuer;
  if (typeof claims.iss !== 'string' || claims.iss !== issuer) throw new IdTokenError('ID token issuer does not match');
  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!aud.includes(check.clientId)) throw new IdTokenError('ID token audience does not match');
  if (aud.length > 1 && claims.azp !== check.clientId) throw new IdTokenError('ID token authorized party does not match');
  if (claims.azp !== undefined && claims.azp !== check.clientId) throw new IdTokenError('ID token authorized party does not match');
  if (typeof claims.exp !== 'number' || claims.exp + CLOCK_SKEW_S <= now) throw new IdTokenError('ID token has expired');
  if (typeof claims.iat !== 'number' || claims.iat - CLOCK_SKEW_S > now) throw new IdTokenError('ID token is issued in the future');
  if (claims.nbf !== undefined && (typeof claims.nbf !== 'number' || claims.nbf - CLOCK_SKEW_S > now)) throw new IdTokenError('ID token is not valid yet');
  if (typeof claims.nonce !== 'string' || !safeEqual(claims.nonce, check.nonce)) throw new IdTokenError('ID token nonce does not match');
  if (typeof claims.sub !== 'string' || !claims.sub || claims.sub.length > 255) throw new IdTokenError('ID token has no subject');
  if (claims.at_hash !== undefined && check.accessToken !== undefined) {
    if (typeof claims.at_hash !== 'string' || !safeEqual(claims.at_hash, halfHash(alg, check.accessToken))) {
      throw new IdTokenError('ID token at_hash does not match the access token');
    }
  }
  return claims;
}
