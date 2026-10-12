import type { AuthSettings, ProviderSettings } from './settings.js';
import { err } from './core.js';
import { identityFromClaims, OidcError, oidcAuthorizeUrl, oidcComplete, truthy, type OidcProvider } from './oidc.js';
import { openSecret, providerSecretKey } from './totp.js';

export type ProviderUser = {
  id: string;
  email: string | null;
  emailVerified: boolean;
  name?: string;
  avatarUrl?: string;
  raw: Record<string, unknown>;
};

export type ProviderTokens = { access: string; refresh?: string };

/** One sign-in: what Keel sends the provider and checks on the way back. */
export type Flow = {
  clientId: string;
  secret: string;
  redirectUri: string;
  state: string;
  /** Extra scopes the app asked for (signInWithOAuth's `scopes`). */
  scopes: string;
  /** OpenID Connect nonce, checked in the ID token. */
  nonce: string;
  /** PKCE between Keel and the provider (not the app's own PKCE with Keel). */
  codeVerifier: string;
  codeChallenge: string;
};

type ProviderImpl = {
  authorizeUrl(c: ProviderSettings, f: Flow): Promise<string>;
  complete(c: ProviderSettings, f: Flow, code: string): Promise<{ tokens: ProviderTokens; user: ProviderUser }>;
};

async function json(res: Response, what: string): Promise<any> {
  const text = await res.text();
  let body: any;
  try {
    body = JSON.parse(text);
  } catch {
    body = null;
  }
  if (!res.ok || !body) throw err(502, 'bad_oauth_callback', `${what} failed (${res.status})`);
  return body;
}

/** The provider's id for the user. A missing one must never become the shared string "undefined". */
function providerId(v: unknown, what: string): string {
  const id = typeof v === 'number' && Number.isSafeInteger(v) ? String(v) : v;
  if (typeof id !== 'string' || !id || id.length > 255) throw err(502, 'bad_oauth_callback', `${what} returned no user id`);
  return id;
}

/**
 * The email a new account made by a provider sign-in gets. An address the
 * provider didn't verify is used only when sign-ups are confirmed
 * automatically anyway (then anyone could register it with a password too).
 * Otherwise it would end up in the session's JWT without anyone proving it,
 * a way around email confirmation for apps whose policies trust the email
 * claim. It stays in the identity and user_metadata either way.
 */
export function newAccountEmail(pu: Pick<ProviderUser, 'email' | 'emailVerified'>, autoconfirm: boolean): string | null {
  return pu.email && (pu.emailVerified || autoconfirm) ? pu.email : null;
}

const TIMEOUT_MS = 8000;
const timed = (init: RequestInit = {}): RequestInit => ({ ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });

const github: ProviderImpl = {
  async authorizeUrl(_c, f) {
    const q = new URLSearchParams({ client_id: f.clientId, redirect_uri: f.redirectUri, state: f.state, scope: ['read:user', 'user:email', f.scopes].filter(Boolean).join(' ') });
    return `https://github.com/login/oauth/authorize?${q}`;
  },
  async complete(_c, f, code) {
    const res = await fetch(
      'https://github.com/login/oauth/access_token',
      timed({
        method: 'POST',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify({ client_id: f.clientId, client_secret: f.secret, code, redirect_uri: f.redirectUri }),
      }),
    );
    const body = await json(res, 'GitHub token exchange');
    if (!body.access_token) throw err(502, 'bad_oauth_callback', `GitHub token exchange failed: ${body.error_description || body.error || 'no token'}`);
    const tokens = { access: body.access_token, refresh: body.refresh_token };
    const headers = { Authorization: `Bearer ${tokens.access}`, 'User-Agent': 'keel-auth', Accept: 'application/vnd.github+json' };
    const u = await json(await fetch('https://api.github.com/user', timed({ headers })), 'GitHub user lookup');
    const id = providerId(u.id, 'GitHub');
    let email: string | null = null;
    let verified = false;
    try {
      const emails = await json(await fetch('https://api.github.com/user/emails', timed({ headers })), 'GitHub email lookup');
      const primary = (emails as any[]).find((e) => e.primary && e.verified) || (emails as any[]).find((e) => e.verified);
      if (primary) {
        email = String(primary.email).toLowerCase();
        verified = true;
      }
    } catch {
      /* the user may have hidden their emails; fall back to the public one */
    }
    if (!email && u.email) email = String(u.email).toLowerCase();
    return {
      tokens,
      user: {
        id,
        email,
        emailVerified: verified,
        name: u.name || u.login,
        avatarUrl: u.avatar_url,
        raw: { sub: id, user_name: u.login, preferred_username: u.login, full_name: u.name, name: u.name, avatar_url: u.avatar_url, email, email_verified: verified, provider_id: id, iss: 'https://api.github.com' },
      },
    };
  },
};

const google: ProviderImpl = {
  async authorizeUrl(_c, f) {
    const q = new URLSearchParams({
      client_id: f.clientId,
      redirect_uri: f.redirectUri,
      response_type: 'code',
      scope: ['openid', 'email', 'profile', f.scopes].filter(Boolean).join(' '),
      state: f.state,
      access_type: 'offline',
      include_granted_scopes: 'true',
    });
    return `https://accounts.google.com/o/oauth2/v2/auth?${q}`;
  },
  async complete(_c, f, code) {
    const res = await fetch(
      'https://oauth2.googleapis.com/token',
      timed({
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ code, client_id: f.clientId, client_secret: f.secret, redirect_uri: f.redirectUri, grant_type: 'authorization_code' }),
      }),
    );
    const body = await json(res, 'Google token exchange');
    const tokens = { access: body.access_token, refresh: body.refresh_token };
    const u = await json(
      await fetch('https://openidconnect.googleapis.com/v1/userinfo', timed({ headers: { Authorization: `Bearer ${tokens.access}` } })),
      'Google user lookup',
    );
    const sub = providerId(u.sub, 'Google');
    return {
      tokens,
      user: {
        id: sub,
        email: u.email ? String(u.email).toLowerCase() : null,
        emailVerified: !!u.email_verified,
        name: u.name,
        avatarUrl: u.picture,
        raw: { sub, full_name: u.name, name: u.name, avatar_url: u.picture, picture: u.picture, email: u.email, email_verified: !!u.email_verified, provider_id: sub, iss: 'https://accounts.google.com' },
      },
    };
  },
};

// Discord: OAuth 2 with a user endpoint. https://discord.com/developers/docs/topics/oauth2
const discord: ProviderImpl = {
  async authorizeUrl(_c, f) {
    const q = new URLSearchParams({
      client_id: f.clientId,
      redirect_uri: f.redirectUri,
      response_type: 'code',
      scope: ['identify', 'email', f.scopes].filter(Boolean).join(' '),
      state: f.state,
      prompt: 'consent',
    });
    return `https://discord.com/oauth2/authorize?${q}`;
  },
  async complete(_c, f, code) {
    const res = await fetch(
      'https://discord.com/api/oauth2/token',
      timed({
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
        body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: f.redirectUri, client_id: f.clientId, client_secret: f.secret }),
      }),
    );
    const body = await json(res, 'Discord token exchange');
    if (!body.access_token) throw err(502, 'bad_oauth_callback', 'Discord token exchange failed: no token');
    const tokens = { access: body.access_token, refresh: body.refresh_token };
    const u = await json(await fetch('https://discord.com/api/users/@me', timed({ headers: { Authorization: `Bearer ${tokens.access}` } })), 'Discord user lookup');
    const id = providerId(u.id, 'Discord');
    const email = u.email ? String(u.email).toLowerCase() : null;
    const verified = !!email && u.verified === true;
    const name = u.global_name || u.username;
    const avatar = typeof u.avatar === 'string' && /^[a-z0-9_]+$/i.test(u.avatar) && /^\d+$/.test(id) ? `https://cdn.discordapp.com/avatars/${id}/${u.avatar}.png` : undefined;
    return {
      tokens,
      user: {
        id,
        email,
        emailVerified: verified,
        name,
        avatarUrl: avatar,
        raw: { iss: 'https://discord.com/api', sub: id, provider_id: id, email, email_verified: verified, name, full_name: name, user_name: u.username, preferred_username: u.username, ...(avatar ? { avatar_url: avatar, picture: avatar } : {}) },
      },
    };
  },
};

/** Providers that speak OpenID Connect: GitLab, Microsoft and any custom one. */
function oidcImpl(toProvider: (c: ProviderSettings, f: Flow) => OidcProvider, emailVerified?: (claims: Record<string, unknown>) => boolean): ProviderImpl {
  return {
    async authorizeUrl(c, f) {
      try {
        return await oidcAuthorizeUrl(toProvider(c, f), { redirectUri: f.redirectUri, state: f.state, nonce: f.nonce, codeChallenge: f.codeChallenge, scopes: f.scopes });
      } catch (e) {
        throw asHttp(e);
      }
    },
    async complete(c, f, code) {
      try {
        const out = await oidcComplete(toProvider(c, f), { redirectUri: f.redirectUri, code, nonce: f.nonce, codeVerifier: f.codeVerifier });
        return { tokens: { access: out.tokens.access, refresh: out.tokens.refresh }, user: identityFromClaims(out.claims, emailVerified ? { emailVerified: emailVerified(out.claims) } : {}) };
      } catch (e) {
        throw asHttp(e);
      }
    },
  };
}

function asHttp(e: unknown): unknown {
  return e instanceof OidcError ? err(502, 'bad_oauth_callback', `Sign-in provider error: ${e.message}`) : e;
}

// GitLab is an OpenID Connect provider at its base URL: https://docs.gitlab.com/integration/openid_connect_provider/
const gitlab = oidcImpl((c, f) => ({
  issuer: c.url || 'https://gitlab.com',
  clientId: f.clientId,
  secret: f.secret,
  scopes: 'email profile',
  policy: { allowHttp: c.allowHttp },
}));

// Microsoft Entra ID (Azure): https://learn.microsoft.com/entra/identity-platform/v2-protocols-oidc
// Its "email" claim is not verified by Microsoft unless the optional claim
// xms_edov (email domain owner verified) says so; without it, the address is
// never used to link to an existing account.
const azure = oidcImpl(
  (c, f) => ({
    issuer: `${c.url || 'https://login.microsoftonline.com/common'}/v2.0`,
    clientId: f.clientId,
    secret: f.secret,
    scopes: 'email profile',
    policy: { allowHttp: false },
    tenantIssuer: true,
  }),
  (claims) => truthy(claims.xms_edov) || claims.xms_edov === 1 || claims.xms_edov === '1',
);

const custom = oidcImpl((c, f) => ({ issuer: c.url, clientId: f.clientId, secret: f.secret, scopes: c.scopes, policy: { allowHttp: c.allowHttp } }));

const IMPLS: Record<ProviderSettings['kind'], ProviderImpl> = { github, google, discord, gitlab, azure, oidc: custom };

export type ResolvedProvider = { impl: ProviderImpl; settings: ProviderSettings; clientId: string; secret: string };

/** The provider's implementation and settings, with its secret opened. */
export function providerConfig(s: AuthSettings, name: string, projectSecret: string): ResolvedProvider {
  const c = Object.hasOwn(s.providers, name) ? s.providers[name] : undefined;
  if (!c) throw err(400, 'validation_failed', 'Unsupported provider: Provider is not enabled');
  let secret: string;
  try {
    secret = openSecret(c.secret, providerSecretKey(projectSecret));
  } catch {
    throw err(500, 'unexpected_failure', 'The provider secret could not be read; enter it again in Studio');
  }
  return { impl: IMPLS[c.kind], settings: c, clientId: c.clientId, secret };
}
