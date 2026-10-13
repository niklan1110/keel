import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function str(name: string, fallback = ''): string {
  const v = process.env[name];
  return v === undefined || v === '' ? fallback : v;
}

function int(name: string, fallback: number): number {
  const v = process.env[name];
  if (v === undefined || v === '') return fallback;
  const n = Number.parseInt(v, 10);
  if (Number.isNaN(n)) throw new Error(`${name} must be an integer, got "${v}"`);
  return n;
}

function bool(name: string, fallback: boolean): boolean {
  const v = process.env[name];
  if (v === undefined || v === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(v.toLowerCase());
}

/** The version in server/package.json, the base of development builds' version. */
function packageVersion(): string {
  try {
    return JSON.parse(fs.readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version || '0.0.0';
  } catch {
    return '0.0.0';
  }
}

const envPublicUrl = str('KEEL_PUBLIC_URL', 'http://localhost:8000').replace(/\/+$/, '');

/** Values set in Studio (keel.server_settings); the project registry loads them. */
export type ServerOverrides = { publicUrl?: string; publicDbHost?: string };
let overrides: ServerOverrides = {};

/** Applies settings from Studio. Returns true when something changed. */
export function setServerOverrides(next: ServerOverrides): boolean {
  const clean: ServerOverrides = {};
  if (next.publicUrl) clean.publicUrl = next.publicUrl.replace(/\/+$/, '');
  if (next.publicDbHost) clean.publicDbHost = next.publicDbHost;
  const changed = JSON.stringify(clean) !== JSON.stringify(overrides);
  overrides = clean;
  return changed;
}

export const serverOverrides = (): ServerOverrides => ({ ...overrides });

/**
 * KEEL_DB_URL (postgresql://user:password@host:port/any_db) can replace the
 * separate database settings, so the CLI (`fn deploy`, `secrets`) can run on
 * another machine against a Keel server's published Postgres port.
 */
function dbUrl(): URL | null {
  const v = str('KEEL_DB_URL');
  if (!v) return null;
  let u: URL;
  try {
    u = new URL(v);
  } catch {
    throw new Error('KEEL_DB_URL must be a postgresql://user:password@host:port/database URL');
  }
  if (!/^postgres(ql)?:$/.test(u.protocol) || !u.hostname) {
    throw new Error('KEEL_DB_URL must be a postgresql://user:password@host:port/database URL');
  }
  return u;
}
const dbFromUrl = dbUrl();

export type DbSsl = false | { rejectUnauthorized?: boolean; ca?: string; checkServerIdentity?: () => undefined };

/**
 * The TLS settings for node-postgres from KEEL_DB_URL's sslmode, with libpq's
 * meanings (Studio's connection strings say sslmode=require, which psql reads
 * the same way). node-postgres would otherwise treat require as verify-full,
 * which keel-db's self-signed certificate fails. allow and prefer can't fall
 * back in node-postgres, so like no sslmode they leave TLS to the driver's
 * default (PGSSLMODE, else off).
 * Source: https://www.postgresql.org/docs/current/libpq-ssl.html#LIBPQ-SSL-PROTECTION
 */
export function sslFromDbUrl(u: URL): DbSsl | undefined {
  // libpq keeps the last of a repeated setting, URLSearchParams.get the first:
  // refuse the ambiguity rather than pick a different one than psql would.
  for (const k of ['sslmode', 'sslrootcert']) {
    if (u.searchParams.getAll(k).length > 1) throw new Error(`KEEL_DB_URL: ${k} is given more than once`);
  }
  const mode = u.searchParams.get('sslmode');
  const rootCert = u.searchParams.get('sslrootcert');
  // sslrootcert=system (libpq 16+): the operating system's CAs, only with verify-full.
  if (rootCert === 'system') {
    if (mode !== 'verify-full') throw new Error('KEEL_DB_URL: sslrootcert=system needs sslmode=verify-full');
    return {};
  }
  const ca = rootCert ? { ca: fs.readFileSync(rootCert, 'utf8') } : {};
  const anyHost = { checkServerIdentity: () => undefined };
  switch (mode) {
    case null:
    case 'allow':
    case 'prefer':
      return undefined;
    case 'disable':
      return false;
    case 'require':
      // With a root certificate, libpq checks the certificate (but not the host name).
      return rootCert ? { ...ca, ...anyHost } : { rejectUnauthorized: false };
    case 'verify-ca':
      if (!rootCert) throw new Error('KEEL_DB_URL: sslmode=verify-ca needs sslrootcert=<file> (the server certificate, or the CA that signed it)');
      return { ...ca, ...anyHost };
    case 'verify-full':
      return ca;
    default:
      throw new Error(`KEEL_DB_URL: unknown sslmode "${mode}" (use disable, require, verify-ca or verify-full)`);
  }
}

export const config = {
  /**
   * The running version: set by the release build from the git tag (e.g.
   * 0.2.0, or 0.2.0-edge+1a2b3c4 for builds of the default branch); local
   * builds report the package version with -dev.
   */
  version: str('KEEL_BUILD_VERSION', `${packageVersion()}-dev`),

  release: {
    /** GitHub repository the image was built from (owner/name), set by the release build. */
    sourceRepo: str('KEEL_SOURCE_REPO'),
    /**
     * Studio asks GitHub at most once a day whether a newer release exists,
     * unless this is "off". Nothing about the install is sent.
     */
    updateCheck: !/^(off|false|0|no)$/i.test(str('KEEL_UPDATE_CHECK', 'on')),
  },

  db: {
    host: dbFromUrl ? dbFromUrl.hostname.replace(/^\[|\]$/g, '') : str('KEEL_DB_HOST', 'keel-db'),
    port: dbFromUrl ? Number(dbFromUrl.port || 5432) : int('KEEL_DB_PORT', 5432),
    superuser: dbFromUrl?.username ? decodeURIComponent(dbFromUrl.username) : str('POSTGRES_USER', 'postgres'),
    password: dbFromUrl ? decodeURIComponent(dbFromUrl.password) : str('POSTGRES_PASSWORD'),
    /** TLS for connections to KEEL_DB_URL (its sslmode); unset otherwise. */
    ssl: dbFromUrl ? sslFromDbUrl(dbFromUrl) : undefined,
    /**
     * Base secret of Keel's service roles (authenticator, keel_*_admin): each
     * role's password is derived from it (see rolePassword), so the services
     * that face the internet never hold the superuser password. Older installs
     * without it use POSTGRES_PASSWORD. Only keel-migrate and keel-studio need
     * it; the other services read their own role's password from a file.
     */
    servicePassword: str('KEEL_SERVICE_PASSWORD') || (dbFromUrl ? decodeURIComponent(dbFromUrl.password) : str('POSTGRES_PASSWORD')),
    controlDb: str('KEEL_CONTROL_DB', 'keel'),
    /**
     * keel-migrate writes each service role's password to <dir>/<role>/password;
     * each service mounts only its own role's folder.
     */
    credentialsDir: str('KEEL_CREDENTIALS_DIR', '/var/lib/keel/credentials'),
  },

  /**
   * Base URL clients use to reach the gateway, e.g. https://api.example.com:
   * the one set in Studio, else KEEL_PUBLIC_URL.
   */
  get publicUrl(): string {
    return overrides.publicUrl || envPublicUrl;
  },
  /** KEEL_PUBLIC_URL as given in the environment. */
  envPublicUrl,
  /**
   * Whether the internet can reach this server: "internet", "lan", or empty
   * to decide from the public URL (see isPrivateServer).
   */
  exposure: str('KEEL_EXPOSURE').toLowerCase(),
  /**
   * Host shown in Postgres connection strings. It doesn't follow an address
   * set in Studio: that's usually a tunnel or proxy, which carries only HTTP.
   */
  get publicDbHost(): string {
    return overrides.publicDbHost || str('KEEL_PUBLIC_DB_HOST', safeHostname(envPublicUrl));
  },
  publicDbPort: int('KEEL_PUBLIC_DB_PORT', 5432),
  get hostLabel(): string {
    return str('KEEL_HOST_LABEL', safeHostname(this.publicUrl) || os.hostname());
  },

  /**
   * Studio's master secret. Never used as a key directly: each use gets its
   * own key from deriveSecret(), and only keel-studio is given it.
   */
  secret: str('KEEL_SECRET'),
  /**
   * Token Studio sends to keel-functions' internal endpoints (logs, status).
   * KEEL_FUNCTIONS_TOKEN when set; installs without it derive one from the
   * password of keel_functions_admin, which both containers can get.
   */
  get functionsToken(): string {
    if (str('KEEL_FUNCTIONS_TOKEN')) return str('KEEL_FUNCTIONS_TOKEN');
    const password = rolePassword('keel_functions_admin');
    return password ? deriveSecret(password, 'functions-internal') : '';
  },
  defaultProject: str('KEEL_DEFAULT_PROJECT', 'my-app'),

  dashboard: {
    username: str('KEEL_DASHBOARD_USERNAME', 'admin'),
    password: str('KEEL_DASHBOARD_PASSWORD'),
  },

  services: {
    rest: str('KEEL_REST_URL', 'http://keel-rest:3000'),
    auth: str('KEEL_AUTH_URL', 'http://keel-auth:9999'),
    storage: str('KEEL_STORAGE_URL', 'http://keel-storage:5000'),
    realtime: str('KEEL_REALTIME_URL', 'http://keel-realtime:4000'),
    imgproxy: str('KEEL_IMGPROXY_URL', 'http://keel-imgproxy:8080'),
    gateway: str('KEEL_GATEWAY_URL', 'http://keel-gateway:8000'),
    functions: str('KEEL_FUNCTIONS_URL', 'http://keel-functions:9000'),
  },

  ports: {
    gateway: int('KEEL_GATEWAY_PORT', 8000),
    rest: int('KEEL_REST_PORT', 3000),
    auth: int('KEEL_AUTH_PORT', 9999),
    storage: int('KEEL_STORAGE_PORT', 5000),
    realtime: int('KEEL_REALTIME_PORT', 4000),
    studio: int('KEEL_STUDIO_PORT', 3000),
    functions: int('KEEL_FUNCTIONS_PORT', 9000),
    egress: int('KEEL_EGRESS_PORT', 9100),
  },

  rest: {
    binary: str('KEEL_POSTGREST_BIN', 'postgrest'),
    basePort: int('KEEL_POSTGREST_BASE_PORT', 3100),
    maxRows: int('KEEL_POSTGREST_MAX_ROWS', 1000),
    poolSize: int('KEEL_POSTGREST_POOL', 10),
  },

  storage: {
    root: str('KEEL_STORAGE_ROOT', '/var/lib/keel/storage'),
    maxFileSize: int('KEEL_STORAGE_MAX_FILE_SIZE', 50 * 1024 * 1024),
    imgproxyKey: str('IMGPROXY_KEY'),
    imgproxySalt: str('IMGPROXY_SALT'),
  },

  smtp: {
    host: str('SMTP_HOST'),
    port: int('SMTP_PORT', 587),
    user: str('SMTP_USER'),
    pass: str('SMTP_PASS'),
    from: str('SMTP_FROM', 'Keel <no-reply@keel.local>'),
    secure: bool('SMTP_SECURE', false),
  },

  functions: {
    /** Deployed code (code/) and Deno's module cache (cache/). */
    root: str('KEEL_FUNCTIONS_ROOT', '/var/lib/keel/functions'),
    deno: str('KEEL_DENO_BIN', 'deno'),
    /** Directory holding bootstrap.js. */
    runtime: str('KEEL_FUNCTIONS_RUNTIME', new URL('../../runtime', import.meta.url).pathname),
    memoryMb: int('KEEL_FUNCTIONS_MEMORY_MB', 256),
    /** Wall-clock limit per request, in seconds. */
    timeout: int('KEEL_FUNCTIONS_TIMEOUT', 150),
    /** Stop a function's process after this many idle seconds. */
    idle: int('KEEL_FUNCTIONS_IDLE', 300),
    maxWorkers: int('KEEL_FUNCTIONS_MAX_WORKERS', 20),
    /** First boot downloads npm:/jsr: imports, so allow a while. */
    bootTimeout: int('KEEL_FUNCTIONS_BOOT_TIMEOUT', 90),
    /**
     * More addresses function code may not connect to (comma separated IPv4
     * addresses or ranges, IPv6 addresses), on top of every private range:
     * e.g. this server's public IP when Keel can't tell it.
     */
    denyNet: str('KEEL_FUNCTIONS_DENY_NET'),
    /**
     * LAN addresses function code may connect to (comma separated, e.g.
     * 192.168.1.50:11434,10.0.0.7,192.168.1.48/29), such as a local Ollama
     * or a NAS. Empty: none. Every port of an allowed address is reachable.
     */
    allowLan: str('KEEL_FUNCTIONS_ALLOW_LAN'),
    /**
     * This server's own LAN addresses (comma separated), written by the
     * installer and ./keel init. They stay closed to function code inside
     * allowed ranges; without them only single addresses can be allowed.
     */
    hostAddresses: str('KEEL_HOST_ADDRESSES'),
  },

  backups: {
    dir: str('KEEL_BACKUP_DIR', '/var/lib/keel/backups'),
    /** Daily time (HH:MM, container local time) for automatic backups, or "off". */
    schedule: str('KEEL_BACKUP_SCHEDULE', '03:00'),
    retention: int('KEEL_BACKUP_RETENTION', 7),
    /**
     * Passphrase that encrypts full backups (every database and the uploaded
     * files, see studio/fullbackups.ts). Without one, full backups are off.
     * Never stored in a database or a backup.
     */
    get passphrase(): string {
      const file = str('KEEL_BACKUP_PASSPHRASE_FILE');
      if (file) {
        try {
          return fs.readFileSync(file, 'utf8').replace(/\r?\n$/, '');
        } catch {
          return '';
        }
      }
      return str('KEEL_BACKUP_PASSPHRASE');
    },
    /** Full backups kept on this machine (the newest ones). */
    keepLocal: int('KEEL_BACKUP_KEEP_LOCAL', 2),
  },

  /** Scheduled jobs (cron.schedule), run by keel-studio. */
  cron: {
    /** Seconds a job may run before it is stopped. */
    timeout: int('KEEL_CRON_TIMEOUT', 300),
    /** Days cron.job_run_details keeps a run. */
    historyDays: int('KEEL_CRON_HISTORY_DAYS', 7),
    /** Jobs of one project running at the same time; more wait for their next turn. */
    maxRunning: int('KEEL_CRON_MAX_RUNNING', 4),
  },

  /** Outgoing requests from SQL (net.http_get/http_post, database webhooks), sent by keel-egress. */
  net: {
    /** Requests of one project in flight at the same time. */
    concurrency: int('KEEL_NET_CONCURRENCY', 8),
    /** Longest time a request may take, whatever timeout_milliseconds asks for. */
    maxTimeoutMs: int('KEEL_NET_MAX_TIMEOUT_MS', 60_000),
    /** Largest response body kept in net._http_response. */
    maxResponseBytes: int('KEEL_NET_MAX_RESPONSE_BYTES', 1024 * 1024),
    /** Hours net._http_response keeps a response (pg_net's pg_net.ttl). */
    ttlHours: int('KEEL_NET_TTL_HOURS', 6),
  },

  docker: {
    /** unix:///var/run/docker.sock, tcp://keel-docker:2375, or empty to disable. */
    // Set but empty means "no Docker access" (str() would treat it as unset).
    host: process.env.DOCKER_HOST ?? 'unix:///var/run/docker.sock',
    composeProject: str('KEEL_COMPOSE_PROJECT'),
  },

  limits: {
    /** Seconds a request body may send nothing before the gateway and storage close it. */
    bodyIdleTimeout: int('KEEL_BODY_IDLE_TIMEOUT', 120),
    /** Open connections per client address at the gateway (trusted proxies don't count). */
    connectionsPerIp: int('KEEL_MAX_CONNECTIONS_PER_IP', 500),
    /** Realtime (WebSocket) connections per client address, per project. */
    realtimePerIp: int('KEEL_REALTIME_MAX_PER_IP', 200),
    /** Realtime connections per project. */
    realtimePerProject: int('KEEL_REALTIME_MAX_PER_PROJECT', 10_000),
  },

  /** Addresses that count as "your network". Anything else is the internet. */
  localNetworks: str('KEEL_LOCAL_NETWORKS', 'private'),
  /**
   * Proxies whose X-Forwarded-For is believed besides Keel's own (see
   * ProxyTrust). The Docker host is one of them when this service's port is
   * published on 127.0.0.1 only (KEEL_PUBLISHED_ON), since then only a proxy
   * on the server itself can connect.
   */
  trustedProxies: [str('KEEL_TRUSTED_PROXIES'), /^(127\.|::1$|\[::1\]$|localhost$)/.test(str('KEEL_PUBLISHED_ON')) ? 'host' : ''].filter(Boolean).join(','),
  /**
   * Host names Studio answers to besides IP addresses, localhost, names that
   * only resolve locally and the public addresses (comma-separated, "*.x" for
   * subdomains, "*" for any).
   */
  studioHosts: str('KEEL_STUDIO_HOSTS'),
  /** Studio sign-ins from the internet: "2fa" (only with two-factor), "on" or "off". */
  studioInternetLogin: str('KEEL_STUDIO_INTERNET_LOGIN', '2fa'),
  /** The gateway serves the documentation at /docs unless this is "off". Studio always does. */
  gatewayDocs: !/^(off|false|0|no)$/i.test(str('KEEL_GATEWAY_DOCS', 'on')),

  tunnel: {
    /** Shared with keel-tunnel: Studio writes the token here, the tunnel its status. */
    dir: str('KEEL_TUNNEL_DIR', '/var/lib/keel/tunnel'),
    bin: str('KEEL_CLOUDFLARED_BIN', 'cloudflared'),
  },

  studioStatic: str('KEEL_STUDIO_STATIC', new URL('../../../studio/dist', import.meta.url).pathname),
  /** The built documentation site (website/), served by Studio at /docs. */
  docsStatic: str('KEEL_DOCS_STATIC', new URL('../../../website/.vitepress/dist', import.meta.url).pathname),
  logLevel: str('KEEL_LOG_LEVEL', 'info'),
  /** Write email addresses, phone numbers and full request paths to the logs (for debugging). Links and codes never are. */
  logPii: bool('KEEL_LOG_PII', false),
};

function safeHostname(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

/** Roles Keel's services log in as. Each has its own password (see rolePassword). */
export const SERVICE_ROLES = ['authenticator', 'keel_auth_admin', 'keel_storage_admin', 'keel_realtime_admin', 'keel_functions_admin', 'keel_egress_admin'] as const;
export type ServiceRole = (typeof SERVICE_ROLES)[number];
export const isServiceRole = (role: string): role is ServiceRole => (SERVICE_ROLES as readonly string[]).includes(role);

/** What a derived key is for. Each purpose gets an unrelated key. */
export type KeyPurpose = 'studio-session' | 'studio-totp' | 'backup-download' | 'backup-target' | 'functions-internal' | `db-role/${ServiceRole}`;

/**
 * Derives the key for one purpose from a master secret (HKDF-SHA256 with the
 * purpose as label), as 64 hex characters. A key leaked or misused for one
 * purpose (say, a download link) says nothing about the others.
 */
export function deriveSecret(secret: string, purpose: KeyPurpose): string {
  return Buffer.from(crypto.hkdfSync('sha256', secret, 'keel', `keel/${purpose}/v1`, 32)).toString('hex');
}

/** Shortest value accepted for each secret. */
const MIN_SECRET_LENGTH: Record<string, number> = { KEEL_SECRET: 32, KEEL_FUNCTIONS_TOKEN: 32, POSTGRES_PASSWORD: 12, KEEL_SERVICE_PASSWORD: 12, KEEL_DASHBOARD_PASSWORD: 8 };

/** Passwords that appeared in Keel's documentation as examples: anyone can look them up. */
const DOCUMENTED_EXAMPLES = new Set(['q4xbv2mn8rtz1klw9spd', 'mynewpassword2026']);
export const isDocumentedExample = (value: string) => DOCUMENTED_EXAMPLES.has(value.trim().toLowerCase());

export function requireSecret(name: string, value: string): string {
  if (!value) throw new Error(`${name} is not set. Run ./keel init to generate a .env file.`);
  // Example values are public: refuse to run with them.
  if (/^change[-_ ]?me|^<.*>$|^(password|secret|changeme|example)$/i.test(value) || isDocumentedExample(value)) {
    throw new Error(`${name} still has its example value. Set it to a long random string (./keel init, or generate-env, makes one).`);
  }
  const min = MIN_SECRET_LENGTH[name] ?? 1;
  if (value.length < min) throw new Error(`${name} must be at least ${min} characters long.`);
  return value;
}

/** For keel-migrate, which sets every service role's password. */
export function requireServicePassword(): string {
  return requireSecret(process.env.KEEL_SERVICE_PASSWORD ? 'KEEL_SERVICE_PASSWORD' : 'POSTGRES_PASSWORD', config.db.servicePassword);
}

/** Where keel-migrate leaves a service role's password for the service that uses it. */
export const rolePasswordFile = (role: ServiceRole) => path.join(config.db.credentialsDir, role, 'password');

/**
 * The password of one service role. Derived from the service password when
 * this container has it (keel-migrate, keel-studio, and compose files from
 * before per-role passwords); otherwise read from the role's file, which is
 * all the other services get. Empty when neither is there.
 */
export function rolePassword(role: ServiceRole): string {
  if (config.db.servicePassword) return deriveSecret(config.db.servicePassword, `db-role/${role}`);
  try {
    return fs.readFileSync(rolePasswordFile(role), 'utf8').trim();
  } catch {
    return '';
  }
}

/** For a service that logs in as `role`: its password must be available. */
export function requireRolePassword(role: ServiceRole): string {
  if (config.db.servicePassword) {
    requireServicePassword();
    return rolePassword(role);
  }
  const password = rolePassword(role);
  if (!password) {
    throw new Error(`No database password for ${role}: ${rolePasswordFile(role)} is missing and KEEL_SERVICE_PASSWORD is not set. keel-migrate writes that file; mount the folder it writes to (see docker-compose.yml).`);
  }
  return password;
}
