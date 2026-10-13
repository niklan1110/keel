import { EventEmitter } from 'node:events';
import { config, setServerOverrides } from './config.js';
import { newClient } from './db.js';
import type { JwtKey } from './jwt.js';
import { log } from './log.js';

/**
 * A built-in sign-in provider. `secret` is sealed (v1:...) with a key derived
 * from the project's secret; older settings may hold it in plain text.
 * `url` is GitLab's base URL (self-hosted) or Azure's tenant URL.
 * `allow_http` lets a provider on your own network be reached over plain http.
 */
export type OAuthProvider = { enabled?: boolean; client_id?: string; secret?: string; url?: string; allow_http?: boolean };

/** Any OpenID Connect provider, signed in to as provider "custom:<id>" (as in Supabase). */
export type CustomOidcProvider = {
  /** "custom:" followed by lowercase letters, digits and hyphens. */
  id: string;
  enabled?: boolean;
  name?: string;
  icon_url?: string;
  issuer: string;
  client_id: string;
  secret?: string;
  /** Space separated; openid is always added. Default "openid email profile". */
  scopes?: string;
  allow_http?: boolean;
};

export const BUILTIN_PROVIDERS = ['github', 'google', 'discord', 'gitlab', 'azure'] as const;
export type BuiltinProvider = (typeof BUILTIN_PROVIDERS)[number];

export type ProjectSettings = {
  /** Where users land after confirming email, resetting passwords etc. */
  site_url?: string;
  /** Extra redirect URLs allowed for auth flows. Supports * wildcards. */
  uri_allow_list?: string[];
  jwt_exp?: number;
  disable_signup?: boolean;
  /** Skip email confirmation on signup. Defaults to true when SMTP is not configured. */
  mailer_autoconfirm?: boolean;
  anonymous_users?: boolean;
  password_min_length?: number;
  external?: Partial<Record<BuiltinProvider, OAuthProvider>>;
  custom_providers?: CustomOidcProvider[];
  smtp?: { host?: string; port?: number; user?: string; pass?: string; from?: string; secure?: boolean };
  rest?: { schemas?: string[]; max_rows?: number };
  /** Phone sign-in with SMS (or WhatsApp) one-time codes. */
  phone?: PhoneSettings;
  mfa?: { totp?: boolean; phone?: boolean; max_enrolled_factors?: number };
  realtime?: { private_only?: boolean };
};

export type SmsProvider = 'twilio' | 'vonage' | 'messagebird' | 'webhook' | 'log';

export type PhoneSettings = {
  enabled?: boolean;
  /** Skip the confirmation code on phone + password sign-up. */
  autoconfirm?: boolean;
  provider?: SmsProvider;
  /** Message text; {{ .Code }} is replaced with the code. */
  template?: string;
  otp_exp?: number;
  otp_length?: number;
  /** Fixed codes for test numbers (no SMS is sent), e.g. {"15555550100": "123456"}. */
  test_otp?: Record<string, string>;
  twilio?: { account_sid?: string; auth_token?: string; message_service_sid?: string; from?: string };
  vonage?: { api_key?: string; api_secret?: string; from?: string };
  messagebird?: { access_key?: string; originator?: string };
  /** POSTs {phone, otp, message, ...} to your own endpoint, signed with HMAC-SHA256. */
  webhook?: { url?: string; secret?: string };
};

/** Keys are empty in services whose role may not read them (see keel.visible_projects). */
export type Project = {
  name: string;
  dbName: string;
  /**
   * The project's internal secret: seals MFA secrets and derives refresh
   * tokens and one-time codes. It is not rolled. Tokens are signed and
   * verified with `jwtKeys`, whose first key started out as this secret.
   */
  jwtSecret: string;
  /** Keys that verify the project's JWTs, newest (the signing key) first. */
  jwtKeys: JwtKey[];
  anonKey: string;
  serviceKey: string;
  settings: ProjectSettings;
  createdAt: string;
};

/**
 * In-memory copy of keel.projects, kept fresh with LISTEN/NOTIFY.
 * Every service uses this to resolve a project slug to its database and JWT secret.
 */
export class Registry extends EventEmitter {
  private projects = new Map<string, Project>();
  private client: ReturnType<typeof newClient> | null = null;
  private stopped = false;
  private expiryTimer: NodeJS.Timeout | null = null;
  ready: Promise<void>;
  private markReady!: () => void;

  constructor(private user: string) {
    super();
    this.ready = new Promise((r) => (this.markReady = r));
  }

  get(name: string): Project | undefined {
    return this.projects.get(name);
  }

  list(): Project[] {
    return [...this.projects.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  async start(): Promise<void> {
    void this.connectLoop();
    await this.ready;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.expiryTimer) clearTimeout(this.expiryTimer);
    await this.client?.end().catch(() => {});
  }

  async reload(): Promise<void> {
    const c = this.client;
    if (!c) return;
    // Service roles may only read their own columns, through keel.visible_projects.
    const source = this.user === config.db.superuser ? 'keel.projects' : 'keel.visible_projects';
    const { rows } = await c.query(
      `select name, db_name, jwt_secret, anon_key, service_key, settings, created_at from ${source}`,
    );
    // Older control databases don't have the keys table yet; their projects
    // sign with jwt_secret, which the upgrade names "legacy".
    const keyRows = await c
      .query(
        `select project, kid, secret, expires_at from keel.project_jwt_keys
          where expires_at is null or expires_at > now()
          order by created_at desc, kid`,
      )
      .catch(() => ({ rows: [] as { project: string; kid: string; secret: string; expires_at: Date | null }[] }));
    const keys = new Map<string, JwtKey[]>();
    for (const k of keyRows.rows) {
      const list = keys.get(k.project) || [];
      list.push({ kid: k.kid, secret: k.secret, expiresAt: k.expires_at ? new Date(k.expires_at).getTime() : null });
      keys.set(k.project, list);
    }
    const next = new Map<string, Project>();
    for (const r of rows) {
      next.set(r.name, {
        name: r.name,
        dbName: r.db_name,
        jwtSecret: r.jwt_secret ?? '',
        jwtKeys: keys.get(r.name) || [{ kid: 'legacy', secret: r.jwt_secret ?? '', expiresAt: null }],
        anonKey: r.anon_key ?? '',
        serviceKey: r.service_key ?? '',
        settings: r.settings || {},
        createdAt: new Date(r.created_at).toISOString(),
      });
    }
    // Older control databases don't have the table yet.
    const settings = await c.query(`select key, value from keel.server_settings`).catch(() => ({ rows: [] as { key: string; value: string }[] }));
    const s = Object.fromEntries(settings.rows.map((r) => [r.key, r.value]));
    const serverChanged = setServerOverrides({ publicUrl: s.public_url, publicDbHost: s.public_db_host });
    if (serverChanged) log.info('server settings changed', { public_url: config.publicUrl });

    const before = this.projects;
    this.projects = next;
    this.scheduleExpiry();
    const changed = before.size !== next.size || [...next.keys()].some((k) => !before.has(k) || JSON.stringify(before.get(k)) !== JSON.stringify(next.get(k)));
    if (changed || serverChanged) this.emit('change', this.list());
  }

  /**
   * Reloads when the next key's grace period ends, so services (and the
   * PostgREST workers, which get the key set at start) drop it on time.
   * verify() also skips expired keys in between.
   */
  private scheduleExpiry(): void {
    if (this.expiryTimer) clearTimeout(this.expiryTimer);
    this.expiryTimer = null;
    const next = nextKeyExpiry(this.list(), Date.now());
    if (next == null) return;
    // setTimeout can't wait longer than about 24 days; check again by then.
    const wait = Math.min(Math.max(next - Date.now(), 0) + 1000, 6 * 3600_000);
    this.expiryTimer = setTimeout(() => {
      this.reload().catch((err) => log.warn('registry reload failed', { error: err.message }));
    }, wait);
    this.expiryTimer.unref();
  }

  private async connectLoop(): Promise<void> {
    let delay = 1000;
    while (!this.stopped) {
      const c = newClient(config.db.controlDb, this.user);
      try {
        await c.connect();
        this.client = c;
        c.on('notification', () => {
          this.reload().catch((err) => log.warn('registry reload failed', { error: err.message }));
        });
        await c.query('listen keel_projects');
        await this.reload();
        log.info('project registry loaded', { projects: this.projects.size });
        this.markReady();
        delay = 1000;
        await new Promise<void>((resolve) => {
          c.on('error', (err) => {
            log.warn('registry connection lost', { error: err.message });
            resolve();
          });
          c.on('end', () => resolve());
        });
      } catch (err) {
        log.info('waiting for project registry', { error: (err as Error).message });
      } finally {
        this.client = null;
        await c.end().catch(() => {});
      }
      if (this.stopped) return;
      await new Promise((r) => setTimeout(r, delay));
      delay = Math.min(delay * 2, 15_000);
    }
  }
}

/** When the next key of any project stops verifying (ms), or null. */
export function nextKeyExpiry(projects: Pick<Project, 'jwtKeys'>[], now: number): number | null {
  let next: number | null = null;
  for (const p of projects) {
    for (const k of p.jwtKeys) {
      if (k.expiresAt != null && k.expiresAt > now && (next == null || k.expiresAt < next)) next = k.expiresAt;
    }
  }
  return next;
}

/** The key new tokens for a project are signed with. */
export function signingKey(p: Pick<Project, 'jwtKeys'>): JwtKey {
  return p.jwtKeys[0];
}

/** Project slug used in URLs, e.g. "recipe-box". */
export const PROJECT_NAME_RE = /^[a-z][a-z0-9-]{1,38}[a-z0-9]$/;
export const RESERVED_NAMES = new Set([
  'api', 'auth', 'rest', 'storage', 'realtime', 'functions', 'studio', 'health', 'keel',
  'postgres', 'template0', 'template1', 'admin', 'assets', 'static', 'graphql', 'docs',
]);

export function dbNameFor(project: string): string {
  return project.replace(/-/g, '_');
}

/** The role a project's developers and coding agents connect as (see sql/project/011_owner_role.sql). */
export const ownerRoleFor = (dbName: string) => `${dbName}_owner`;
