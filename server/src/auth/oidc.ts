import { IdTokenError, validateIdToken, type Jwk } from './idtoken.js';
import { ProviderFetchError, checkBrowserUrl, providerFetch, type FetchPolicy } from './fetch.js';

/**
 * A generic OpenID Connect client for the authorization code flow with
 * PKCE, state and nonce (OpenID Connect Core 1.0 and Discovery 1.0):
 * https://openid.net/specs/openid-connect-core-1_0.html#CodeFlowAuth
 * https://openid.net/specs/openid-connect-discovery-1_0.html
 */

export class OidcError extends Error {}

export type Discovery = {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
  userinfo_endpoint?: string;
  /** client_secret_post when the provider doesn't take client_secret_basic. */
  secretInBody: boolean;
};

export type OidcProvider = {
  /** The issuer as configured, e.g. https://auth.example.test/application/o/keel/ */
  issuer: string;
  clientId: string;
  secret: string;
  /** Extra scopes; openid is always asked for. */
  scopes: string;
  policy: FetchPolicy;
  /**
   * Microsoft's multi-tenant endpoints publish an issuer with a {tenantid}
   * placeholder, filled from each token's "tid" claim.
   */
  tenantIssuer?: boolean;
};

export type OidcResult = {
  claims: Record<string, unknown>;
  tokens: { access: string; refresh?: string; idToken: string };
};

const DISCOVERY_TTL_MS = 60 * 60_000;
const JWKS_TTL_MS = 60 * 60_000;
/** Unknown key ids refetch the key set, at most this often per provider. */
const JWKS_REFRESH_MIN_MS = 30_000;
/** Keys older than this are not used when the provider can't be reached. */
export const JWKS_STALE_MAX_MS = 24 * 60 * 60_000;
const CACHE_LIMIT = 200;

const discoveryCache = new Map<string, { doc: Discovery; at: number }>();
const jwksCache = new Map<string, { keys: Jwk[]; at: number }>();

function remember<T>(map: Map<string, T>, key: string, value: T) {
  if (map.size >= CACHE_LIMIT) map.delete(map.keys().next().value as string);
  map.set(key, value);
}

const trimSlash = (s: string) => s.replace(/\/+$/, '');

/** Where the discovery document of an issuer lives. */
export function discoveryUrl(issuer: string): string {
  return `${trimSlash(issuer)}/.well-known/openid-configuration`;
}

/** Microsoft's {tenantid} issuer template, as a matcher for the tenant's real issuer. */
function tenantTemplate(issuer: string): boolean {
  return issuer.includes('{tenantid}');
}

/** Fetches (and caches) the provider's discovery document, checking that it is for this issuer. */
export async function discover(p: OidcProvider): Promise<Discovery> {
  const url = discoveryUrl(p.issuer);
  // Whether a {tenantid} issuer is accepted is part of the key: a custom provider
  // with Microsoft's issuer must not get the document cached for the Azure one.
  const key = `${p.policy.allowHttp ? 'http' : 'https'}|${p.tenantIssuer ? 'tenant' : 'exact'}|${url}`;
  const hit = discoveryCache.get(key);
  if (hit && Date.now() - hit.at < DISCOVERY_TTL_MS) return hit.doc;
  const r = await providerFetch(url, p.policy, 'The provider discovery document');
  const d = r.body;
  if (!r.ok || !d || typeof d !== 'object') throw new OidcError(`could not load the provider discovery document (${r.status})`);
  for (const k of ['issuer', 'authorization_endpoint', 'token_endpoint', 'jwks_uri'] as const) {
    if (typeof d[k] !== 'string' || !d[k]) throw new OidcError(`the provider discovery document has no ${k}`);
  }
  // The document must be about the issuer it was fetched for (Discovery 4.3).
  // A trailing slash typed or left out in the settings doesn't matter.
  const sameIssuer = trimSlash(d.issuer) === trimSlash(p.issuer);
  const tenant = p.tenantIssuer && (tenantTemplate(d.issuer) || new URL(d.issuer).host === new URL(p.issuer).host);
  if (!sameIssuer && !tenant) throw new OidcError('the provider discovery document is for a different issuer');
  checkBrowserUrl(d.authorization_endpoint, p.policy, 'The provider authorization endpoint');
  const doc: Discovery = {
    issuer: d.issuer,
    authorization_endpoint: d.authorization_endpoint,
    token_endpoint: d.token_endpoint,
    jwks_uri: d.jwks_uri,
    userinfo_endpoint: typeof d.userinfo_endpoint === 'string' && d.userinfo_endpoint ? d.userinfo_endpoint : undefined,
    secretInBody:
      Array.isArray(d.token_endpoint_auth_methods_supported) &&
      !d.token_endpoint_auth_methods_supported.includes('client_secret_basic') &&
      d.token_endpoint_auth_methods_supported.includes('client_secret_post'),
  };
  remember(discoveryCache, key, { doc, at: Date.now() });
  return doc;
}

/** The provider's signing keys, cached; `refresh` refetches them (rate-limited) for an unknown key id. */
export async function providerKeys(jwksUri: string, policy: FetchPolicy, refresh: boolean): Promise<Jwk[]> {
  const hit = jwksCache.get(jwksUri);
  const age = hit ? Date.now() - hit.at : Infinity;
  if (hit && (refresh ? age < JWKS_REFRESH_MIN_MS : age < JWKS_TTL_MS)) return hit.keys;
  // While the provider can't be reached, recently fetched keys still work,
  // but only for a day: blocking the key set must not keep a rotated-out key
  // trusted for ever.
  const stale = (reason: string): Jwk[] => {
    if (hit && age < JWKS_STALE_MAX_MS) return hit.keys;
    throw new OidcError(`could not load the provider key set (${reason})`);
  };
  let r: Awaited<ReturnType<typeof providerFetch>>;
  try {
    r = await providerFetch(jwksUri, policy, 'The provider key set');
  } catch (e) {
    return stale((e as Error).message);
  }
  if (!r.ok || !Array.isArray(r.body?.keys)) return stale(String(r.status));
  const keys = (r.body.keys as unknown[]).filter((k): k is Jwk => !!k && typeof k === 'object');
  remember(jwksCache, jwksUri, { keys, at: Date.now() });
  return keys;
}

/** Forgets cached discovery documents and keys (for tests and after settings change). */
export function clearOidcCache() {
  discoveryCache.clear();
  jwksCache.clear();
}

export function scopesFor(p: OidcProvider, extra: string): string {
  const all = ['openid', ...`${p.scopes} ${extra}`.split(/[\s,]+/)].filter(Boolean);
  return [...new Set(all)].join(' ');
}

export async function oidcAuthorizeUrl(
  p: OidcProvider,
  f: { redirectUri: string; state: string; nonce: string; codeChallenge: string; scopes: string },
): Promise<string> {
  const d = await discover(p);
  const url = checkBrowserUrl(d.authorization_endpoint, p.policy, 'The provider authorization endpoint');
  const q = url.searchParams;
  q.set('response_type', 'code');
  q.set('client_id', p.clientId);
  q.set('redirect_uri', f.redirectUri);
  q.set('scope', scopesFor(p, f.scopes));
  q.set('state', f.state);
  q.set('nonce', f.nonce);
  q.set('code_challenge', f.codeChallenge);
  q.set('code_challenge_method', 'S256');
  return url.href;
}

/** Exchanges the code, validates the ID token, and adds what the user info endpoint knows. */
export async function oidcComplete(
  p: OidcProvider,
  f: { redirectUri: string; code: string; nonce: string; codeVerifier: string },
): Promise<OidcResult> {
  try {
    const d = await discover(p);
    const form = new URLSearchParams({ grant_type: 'authorization_code', code: f.code, redirect_uri: f.redirectUri, code_verifier: f.codeVerifier });
    const headers: Record<string, string> = { 'Content-Type': 'application/x-www-form-urlencoded' };
    if (d.secretInBody) {
      form.set('client_id', p.clientId);
      form.set('client_secret', p.secret);
    } else {
      // client_secret_basic (Core 9, RFC 6749 2.3.1): form-encoded id and secret, joined by a colon.
      const enc = (s: string) => encodeURIComponent(s).replace(/%20/g, '+');
      headers.Authorization = `Basic ${Buffer.from(`${enc(p.clientId)}:${enc(p.secret)}`).toString('base64')}`;
    }
    const r = await providerFetch(d.token_endpoint, p.policy, 'The provider token endpoint', { method: 'POST', headers, body: form });
    const t = r.body;
    if (!r.ok || !t || typeof t.access_token !== 'string') {
      const reason = typeof t?.error === 'string' ? `: ${String(t.error).slice(0, 100)}` : ` (${r.status})`;
      throw new OidcError(`token exchange failed${reason}`);
    }
    if (typeof t.id_token !== 'string') throw new OidcError('the provider returned no ID token');
    const claims = await validateIdToken(t.id_token, (refresh) => providerKeys(d.jwks_uri, p.policy, refresh), {
      issuer: p.tenantIssuer && tenantTemplate(d.issuer) ? (c) => d.issuer.replace('{tenantid}', tenantId(c.tid)) : d.issuer,
      clientId: p.clientId,
      nonce: f.nonce,
      accessToken: t.access_token,
    });
    const merged = { ...claims };
    if (d.userinfo_endpoint) {
      // Some providers (Authelia, for one) keep email and profile out of the ID
      // token. Fill in what's missing from user info, for the same subject only.
      try {
        const u = await providerFetch(d.userinfo_endpoint, p.policy, 'The provider user info endpoint', { headers: { Authorization: `Bearer ${t.access_token}` } });
        if (u.ok && u.body && typeof u.body === 'object' && u.body.sub === claims.sub) {
          for (const [k, v] of Object.entries(u.body)) if (!(k in merged)) merged[k] = v;
          // email_verified is about one address: take it only from whichever
          // source supplied the email, never one's flag with the other's address.
          const source = 'email' in claims ? claims : 'email' in u.body ? (u.body as Record<string, unknown>) : null;
          if (source && 'email_verified' in source) merged.email_verified = source.email_verified;
          else delete merged.email_verified;
        }
      } catch {
        /* user info is optional; the ID token is enough */
      }
    }
    return {
      claims: merged,
      tokens: { access: t.access_token, refresh: typeof t.refresh_token === 'string' ? t.refresh_token : undefined, idToken: t.id_token },
    };
  } catch (e) {
    if (e instanceof IdTokenError || e instanceof ProviderFetchError || e instanceof OidcError) throw new OidcError(e.message);
    throw e;
  }
}

function tenantId(tid: unknown): string {
  // A tenant id is a GUID; anything else must not end up inside the issuer.
  if (typeof tid !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(tid)) return '{invalid-tenant}';
  return tid;
}

const str = (v: unknown, max = 2048): string | undefined => (typeof v === 'string' && v && v.length <= max ? v : undefined);

/** email_verified is a boolean, but a few providers send the string "true". */
export const truthy = (v: unknown) => v === true || v === 'true';

/** Turns OIDC claims into the identity Keel stores (the shape Supabase uses). */
export function identityFromClaims(claims: Record<string, unknown>, opts: { emailVerified?: boolean } = {}) {
  const sub = String(claims.sub);
  const email = str(claims.email, 320)?.toLowerCase() ?? null;
  const verified = !!email && (opts.emailVerified ?? truthy(claims.email_verified));
  const name = str(claims.name, 256) ?? str(claims.preferred_username, 256);
  const picture = str(claims.picture);
  const username = str(claims.preferred_username, 256);
  return {
    id: sub,
    email,
    emailVerified: verified,
    name,
    avatarUrl: picture,
    raw: {
      iss: claims.iss,
      sub,
      provider_id: sub,
      email,
      email_verified: verified,
      name,
      full_name: name,
      ...(username ? { preferred_username: username, user_name: username } : {}),
      ...(picture ? { picture, avatar_url: picture } : {}),
    } as Record<string, unknown>,
  };
}
