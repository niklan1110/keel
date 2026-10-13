import net from 'node:net';
import { config } from '../lib/config.js';
import { isLocalAddress, parseNetworks } from '../lib/net.js';
import { BUILTIN_PROVIDERS, type BuiltinProvider, type PhoneSettings, type Project, type ProjectSettings, type SmsProvider } from '../lib/registry.js';

export type SmtpSettings = { host: string; port: number; user: string; pass: string; from: string; secure: boolean };

export type AuthSettings = {
  siteUrl: string;
  allowList: string[];
  jwtExp: number;
  disableSignup: boolean;
  autoconfirm: boolean;
  anonymousUsers: boolean;
  passwordMinLength: number;
  smtp: SmtpSettings | null;
  /** Enabled sign-in providers by name ("github", "custom:authentik", ...). Secrets may still be sealed. */
  providers: Record<string, ProviderSettings>;
  /** Public base URL of this project's auth API, e.g. http://host:8000/my-app/auth/v1 */
  apiUrl: string;
  otpExpSeconds: number;
  phone: {
    enabled: boolean;
    autoconfirm: boolean;
    provider: SmsProvider | null;
    template: string;
    otpExpSeconds: number;
    otpLength: number;
    testOtp: Record<string, string>;
    raw: PhoneSettings;
  };
  mfa: { totp: boolean; phone: boolean; maxFactors: number };
};

export type ProviderSettings = {
  kind: BuiltinProvider | 'oidc';
  clientId: string;
  /** Possibly sealed; open it with openProviderSecret. */
  secret: string;
  /** GitLab base URL, Azure tenant URL, or the issuer of a custom provider. */
  url: string;
  allowHttp: boolean;
  scopes: string;
};

export const DEFAULT_SMS_TEMPLATE = 'Your code is {{ .Code }}';

/** Supabase's identifiers for custom providers: "custom:" and lowercase letters, digits and hyphens, at most 50 characters. */
export const CUSTOM_PROVIDER_ID = /^custom:[a-z0-9](?:[a-z0-9-]{0,41}[a-z0-9])?$/;

/** The providers that are turned on and have their credentials filled in. */
export function enabledProviders(s: ProjectSettings): Record<string, ProviderSettings> {
  const out: Record<string, ProviderSettings> = {};
  for (const kind of BUILTIN_PROVIDERS) {
    const p = s.external?.[kind];
    if (!p?.enabled || !p.client_id || !p.secret) continue;
    out[kind] = { kind, clientId: p.client_id, secret: p.secret, url: (p.url || '').replace(/\/+$/, ''), allowHttp: !!p.allow_http, scopes: '' };
  }
  for (const p of Array.isArray(s.custom_providers) ? s.custom_providers : []) {
    if (!p?.enabled || !CUSTOM_PROVIDER_ID.test(String(p.id)) || !p.issuer || !p.client_id || !p.secret || out[p.id]) continue;
    out[p.id] = { kind: 'oidc', clientId: p.client_id, secret: p.secret, url: p.issuer, allowHttp: !!p.allow_http, scopes: p.scopes ?? 'email profile' };
  }
  return out;
}

/** A provider counts as configured only when its credentials are filled in. */
export function smsConfigured(p: PhoneSettings | undefined): boolean {
  switch (p?.provider) {
    case 'twilio':
      return !!(p.twilio?.account_sid && p.twilio?.auth_token && (p.twilio?.message_service_sid || p.twilio?.from));
    case 'vonage':
      return !!(p.vonage?.api_key && p.vonage?.api_secret && p.vonage?.from);
    case 'messagebird':
      return !!(p.messagebird?.access_key && p.messagebird?.originator);
    case 'webhook':
      return !!p.webhook?.url;
    case 'log':
      return true;
    default:
      return false;
  }
}

export function resolveSettings(p: Project): AuthSettings {
  const s = p.settings || {};
  const smtpHost = s.smtp?.host || config.smtp.host;
  const smtp: SmtpSettings | null = smtpHost
    ? {
        host: smtpHost,
        port: s.smtp?.port || config.smtp.port,
        user: s.smtp?.user ?? config.smtp.user,
        pass: s.smtp?.pass ?? config.smtp.pass,
        from: s.smtp?.from || config.smtp.from,
        secure: s.smtp?.secure ?? config.smtp.secure,
      }
    : null;
  return {
    siteUrl: (s.site_url || '').replace(/\/+$/, ''),
    allowList: s.uri_allow_list || [],
    jwtExp: s.jwt_exp && s.jwt_exp > 0 ? s.jwt_exp : 3600,
    disableSignup: !!s.disable_signup,
    // Without a mail server there is no way to deliver confirmation emails,
    // so default to confirming new accounts immediately.
    autoconfirm: s.mailer_autoconfirm ?? !smtp,
    anonymousUsers: !!s.anonymous_users,
    passwordMinLength: s.password_min_length && s.password_min_length > 0 ? s.password_min_length : 6,
    smtp,
    providers: enabledProviders(s),
    apiUrl: `${config.publicUrl}/${p.name}/auth/v1`,
    otpExpSeconds: 3600,
    phone: {
      enabled: !!s.phone?.enabled && smsConfigured(s.phone),
      autoconfirm: !!s.phone?.autoconfirm,
      provider: smsConfigured(s.phone) ? s.phone!.provider! : null,
      template: s.phone?.template?.trim() || DEFAULT_SMS_TEMPLATE,
      otpExpSeconds: clampInt(s.phone?.otp_exp, 30, 3600, 60),
      otpLength: clampInt(s.phone?.otp_length, 6, 10, 6),
      testOtp: s.phone?.test_otp || {},
      raw: s.phone || {},
    },
    mfa: {
      totp: s.mfa?.totp ?? true,
      phone: !!s.mfa?.phone && smsConfigured(s.phone),
      maxFactors: clampInt(s.mfa?.max_enrolled_factors, 1, 50, 10),
    },
  };
}

const LAN_ONLY_NAMES = /(^|\.)(localhost|local|lan|internal|home\.arpa)$/i;
const privateNetworks = parseNetworks('private');

/**
 * True when a public URL only reaches this machine or your own network:
 * localhost, a private, Tailscale or link-local address, a single-label
 * name, or a LAN-only domain (.local, .lan, .internal, .home.arpa).
 * Anything else may be on the internet.
 */
export function isPrivateUrl(url: string): boolean {
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    return false;
  }
  const ip = host.replace(/^\[|\]$/g, '');
  if (net.isIP(ip)) return isLocalAddress(ip, privateNetworks);
  return !host.includes('.') || LAN_ONLY_NAMES.test(host.replace(/\.$/, ''));
}

/**
 * True when the server only serves this machine or your own network.
 * KEEL_EXPOSURE decides when set: "internet" (the installer writes it on a
 * cloud server, whose own address is private behind 1:1 NAT) or "lan".
 * Otherwise it's decided from the public URL.
 */
export function isPrivateServer(publicUrl: string, exposure: string): boolean {
  if (exposure === 'internet') return false;
  if (exposure === 'lan') return true;
  return isPrivateUrl(publicUrl);
}

/**
 * Auth settings for a new project. On a server the internet can reach,
 * anyone could otherwise sign up and be signed in at once (confirmation is
 * off without a mail server), and policies "to authenticated" would let
 * them in. So there, new accounts must confirm their address, and without a
 * mail server sign-ups start turned off. Existing projects are not changed.
 */
export function newProjectSettings(publicUrl: string, smtp: boolean, exposure = ''): ProjectSettings {
  if (isPrivateServer(publicUrl, exposure)) return {};
  return smtp ? { mailer_autoconfirm: false } : { disable_signup: true, mailer_autoconfirm: false };
}

function clampInt(v: unknown, min: number, max: number, fallback: number): number {
  const n = Number(v);
  return Number.isInteger(n) && n >= min && n <= max ? n : fallback;
}

function globToRegex(pattern: string, one: string, many: string): RegExp {
  let re = '';
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === '*') {
      if (pattern[i + 1] === '*') {
        re += many;
        i++;
      } else {
        re += one;
      }
    } else {
      re += ch.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${re}$`, 'i');
}

const SPLIT = /^([a-z][a-z0-9+.-]*:\/\/)([^/?#]*)(.*)$/i;

/**
 * Matches a redirect URL against an allow-list entry. Scheme, host and path
 * are compared separately so a wildcard can never spill from the path into
 * the host (e.g. "https://*.example.com" must not allow
 * "https://evil.test?.example.com"). In the host, * matches one DNS label;
 * in the path, * matches one segment and ** anything.
 */
export function redirectAllowed(pattern: string, candidate: string): boolean {
  if (pattern === candidate) return true;
  const p = SPLIT.exec(pattern);
  const c = SPLIT.exec(candidate);
  if (!p || !c) return false;
  if (p[1].toLowerCase() !== c[1].toLowerCase()) return false;
  if (c[2].includes('@') || c[2].includes('\\')) return false;
  if (!globToRegex(p[2], '[a-z0-9-]*', '[a-z0-9.-]*').test(c[2])) return false;
  return globToRegex(p[3], '[^/?#]*', '.*').test(c[3]);
}

/**
 * Returns redirectTo when it is allowed for this project, otherwise the site
 * URL (or '' when no site URL is configured). Mirrors GoTrue's behaviour.
 */
export function safeRedirect(s: AuthSettings, redirectTo: string | null | undefined): string {
  if (!redirectTo) return s.siteUrl;
  let url: URL;
  try {
    url = new URL(redirectTo);
  } catch {
    return s.siteUrl;
  }
  // Custom schemes (myapp://callback) are fine for mobile apps; script-ish ones never are.
  if (/^(javascript|data|vbscript|file|blob):$/i.test(url.protocol)) return s.siteUrl;
  if (s.siteUrl && (url.protocol === 'http:' || url.protocol === 'https:')) {
    try {
      if (new URL(s.siteUrl).origin === url.origin) return redirectTo;
    } catch {
      /* malformed site url: fall through to the allow list */
    }
  }
  for (const pattern of s.allowList) {
    if (redirectAllowed(pattern, redirectTo)) return redirectTo;
  }
  return s.siteUrl;
}
