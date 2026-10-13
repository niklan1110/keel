import { BUILTIN_PROVIDERS, type CustomOidcProvider, type OAuthProvider, type ProjectSettings } from '../lib/registry.js';
import { CUSTOM_PROVIDER_ID } from '../auth/settings.js';

/**
 * Sign-in provider settings as Studio reads and writes them. Client secrets
 * go in sealed and never come back out: reads only say whether one is set,
 * and a write without a secret keeps the one there was.
 */

export class ProviderSettingsError extends Error {}

export const MAX_CUSTOM_PROVIDERS = 20;

/** Built-ins whose base URL can be changed (self-hosted GitLab, an Azure tenant). */
const WITH_URL = new Set(['gitlab', 'azure']);
/** Built-ins that may live on your own network. */
const WITH_HTTP = new Set(['gitlab']);

type Seal = (secret: string) => string;

const fail = (msg: string): never => {
  throw new ProviderSettingsError(msg);
};

const text = (v: unknown, max: number, what: string): string | undefined => {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'string') return fail(`${what} must be text`);
  const s = v.trim();
  if (s.length > max) fail(`${what} is too long`);
  if (/[\u0000-\u001f\u007f]/.test(s)) fail(`${what} contains control characters`);
  return s;
};

/** A provider URL: https, or http when the admin allowed plain http for this provider. */
function providerUrl(v: unknown, allowHttp: boolean, what: string): string {
  const s = text(v, 500, what) ?? '';
  if (!s) return '';
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    return fail(`${what} must be a URL`);
  }
  if (u.username || u.password) fail(`${what} must not contain a user name or password`);
  if (u.search || u.hash) fail(`${what} must not have a query or fragment`);
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && allowHttp)) {
    fail(allowHttp ? `${what} must start with https:// or http://` : `${what} must start with https:// (or allow plain http for a provider on your own network)`);
  }
  // Kept as typed: some issuers end in a slash (Authentik) and the ID token's iss must match exactly.
  return s;
}

function iconUrl(v: unknown): string {
  const s = text(v, 500, 'Icon URL') ?? '';
  if (!s) return '';
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    return fail('Icon URL must be a URL');
  }
  if (u.protocol !== 'https:') fail('Icon URL must start with https://');
  return s;
}

function scopes(v: unknown): string | undefined {
  const s = text(v, 500, 'Scopes');
  if (s === undefined) return undefined;
  if (s && !/^[\x21\x23-\x5b\x5d-\x7e]+(?:[ ,]+[\x21\x23-\x5b\x5d-\x7e]+)*$/.test(s)) fail('Scopes must be scope names separated by spaces');
  return s.split(/[ ,]+/).filter(Boolean).join(' ');
}

/** Applies a Studio update to the built-in providers in `cur` (mutates it). */
export function mergeBuiltinProviders(cur: ProjectSettings, external: unknown, seal: Seal) {
  if (!external || typeof external !== 'object') return;
  for (const prov of BUILTIN_PROVIDERS) {
    const b = (external as Record<string, any>)[prov];
    if (!b || typeof b !== 'object') continue;
    cur.external ||= {};
    const prev: OAuthProvider = cur.external[prov] || {};
    const allowHttp = WITH_HTTP.has(prov) ? (typeof b.allow_http === 'boolean' ? b.allow_http : !!prev.allow_http) : false;
    const newSecret = typeof b.secret === 'string' && b.secret.trim() ? seal(b.secret.trim()) : undefined;
    const next: OAuthProvider = {
      enabled: !!b.enabled,
      client_id: text(b.client_id, 500, 'Client ID') ?? prev.client_id,
      secret: newSecret ?? prev.secret,
    };
    if (WITH_URL.has(prov)) {
      next.url = b.url !== undefined ? providerUrl(b.url, allowHttp, 'URL') : prev.url;
      if (!newSecret && prev.secret && (next.url || '') !== (prev.url || '')) fail(`${prov}: enter the client secret again when you change the URL`);
    }
    if (WITH_HTTP.has(prov)) next.allow_http = allowHttp;
    cur.external[prov] = next;
  }
}

/**
 * Replaces the custom OpenID Connect providers with `list`. A provider sent
 * without a secret keeps the secret it had under the same id, unless its
 * issuer changed.
 */
export function mergeCustomProviders(cur: ProjectSettings, list: unknown, seal: Seal) {
  if (list === undefined) return;
  if (!Array.isArray(list)) fail('custom_providers must be a list');
  const items = list as unknown[];
  if (items.length > MAX_CUSTOM_PROVIDERS) fail(`At most ${MAX_CUSTOM_PROVIDERS} custom providers`);
  const prev = new Map((cur.custom_providers || []).map((p) => [p.id, p]));
  const seen = new Set<string>();
  const out: CustomOidcProvider[] = [];
  for (const raw of items) {
    if (!raw || typeof raw !== 'object') fail('Each custom provider must be an object');
    const b = raw as Record<string, unknown>;
    let id = (text(b.id, 50, 'Identifier') ?? '').toLowerCase();
    if (id && !id.startsWith('custom:')) id = `custom:${id}`;
    if (!CUSTOM_PROVIDER_ID.test(id)) fail('Identifier must be "custom:" followed by lowercase letters, digits and hyphens (at most 50 characters)');
    if (seen.has(id)) fail(`Identifier ${id} is used twice`);
    seen.add(id);
    const allowHttp = b.allow_http === true;
    const issuer = providerUrl(b.issuer, allowHttp, 'Issuer URL');
    if (!issuer) fail(`${id}: Issuer URL is required`);
    const clientId = text(b.client_id, 500, 'Client ID') ?? '';
    if (!clientId) fail(`${id}: Client ID is required`);
    const before = prev.get(id);
    const typed = typeof b.secret === 'string' && b.secret.trim() ? seal(b.secret.trim()) : undefined;
    // A stored secret is only ever sent to the issuer it was entered for.
    if (!typed && before?.secret && before.issuer !== issuer) fail(`${id}: enter the client secret again when you change the Issuer URL`);
    const secret = typed ?? before?.secret;
    const enabled = b.enabled === true;
    if (enabled && !secret) fail(`${id}: Client secret is required`);
    out.push({
      id,
      enabled,
      name: text(b.name, 60, 'Name') || undefined,
      icon_url: iconUrl(b.icon_url) || undefined,
      issuer,
      client_id: clientId,
      secret,
      scopes: scopes(b.scopes) ?? 'email profile',
      allow_http: allowHttp,
    });
  }
  cur.custom_providers = out;
}

const maskBuiltin = (o?: OAuthProvider) => ({
  enabled: !!o?.enabled,
  client_id: o?.client_id || '',
  has_secret: !!o?.secret,
  url: o?.url || '',
  allow_http: !!o?.allow_http,
});

/** Provider settings for Studio, without secrets. */
export function maskProviders(s: ProjectSettings) {
  return {
    external: Object.fromEntries(BUILTIN_PROVIDERS.map((p) => [p, maskBuiltin(s.external?.[p])])) as Record<(typeof BUILTIN_PROVIDERS)[number], ReturnType<typeof maskBuiltin>>,
    custom_providers: (s.custom_providers || []).map((p) => ({
      id: p.id,
      enabled: !!p.enabled,
      name: p.name || '',
      icon_url: p.icon_url || '',
      issuer: p.issuer,
      client_id: p.client_id,
      scopes: p.scopes ?? 'email profile',
      allow_http: !!p.allow_http,
      has_secret: !!p.secret,
    })),
  };
}
