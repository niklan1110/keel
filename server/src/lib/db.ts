import pg from 'pg';
import { config, isServiceRole, rolePassword } from './config.js';
import { log } from './log.js';
import type { Claims } from './jwt.js';

export type Client = pg.PoolClient | pg.Client;

const pools = new Map<string, pg.Pool>();

/** The password for a role: the superuser's, or a service role's own. */
const passwordFor = (user: string) => (user === config.db.superuser ? config.db.password : isServiceRole(user) ? rolePassword(user) : config.db.servicePassword);

/**
 * Connection options for a role. The superuser's connections resolve
 * unqualified names in pg_catalog only. A project database's search_path is
 * "$user", public, extensions, and its owner role can create functions and
 * operators in public and extensions (and a schema named after the
 * superuser): with that path, an overload such as public.make_interval(text)
 * or public.format(text, text) would win over the built-in for a query with
 * an untyped parameter, and run as the superuser. Keel's own queries name
 * everything they use outside pg_catalog. Only SQL a Studio admin writes
 * (the SQL editor, new tables and policies) runs with the project's path, by
 * asking for it (projectPath).
 */
export function connectionOptions(user: string, projectPath = false): string | undefined {
  return user === config.db.superuser && !projectPath ? '-c search_path=pg_catalog' : undefined;
}

/** The search_path a project database gives its sessions (see migrateProjectDb). */
export const PROJECT_SEARCH_PATH = '"$user", public, extensions';

/** Limits for a background pool's queries, so a locked table can't hold its connections. */
export type PoolLimits = { name: string; statementTimeoutMs: number; lockTimeoutMs: number };

/** Returns a shared pool for (database, role), or a separate one with its own limits. */
export function pool(database: string, user: string, max = 10, limits?: PoolLimits): pg.Pool {
  const key = `${user}@${database}${limits ? `#${limits.name}` : ''}`;
  let p = pools.get(key);
  if (!p) {
    p = new pg.Pool({
      ...(limits ? { statement_timeout: limits.statementTimeoutMs, lock_timeout: limits.lockTimeoutMs } : {}),
      host: config.db.host,
      port: config.db.port,
      user,
      password: passwordFor(user),
      database,
      ssl: config.db.ssl,
      options: connectionOptions(user),
      max,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
      application_name: `keel-${process.argv[2] || 'service'}`,
    });
    p.on('error', (err) => log.warn('idle database client error', { database, user, error: err.message }));
    pools.set(key, p);
  }
  return p;
}

export async function closePool(database: string): Promise<void> {
  for (const [key, p] of pools) {
    if (key.endsWith(`@${database}`) || key.includes(`@${database}#`)) {
      pools.delete(key);
      await p.end().catch(() => {});
    }
  }
}

export function newClient(database: string, user = config.db.superuser, opts: { projectPath?: boolean } = {}): pg.Client {
  return new pg.Client({
    host: config.db.host,
    port: config.db.port,
    user,
    password: passwordFor(user),
    database,
    ssl: config.db.ssl,
    options: connectionOptions(user, opts.projectPath),
    application_name: `keel-${process.argv[2] || 'service'}`,
  });
}

export async function tx<T>(p: pg.Pool, fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const c = await p.connect();
  try {
    await c.query('begin');
    const out = await fn(c);
    await c.query('commit');
    return out;
  } catch (err) {
    await c.query('rollback').catch(() => {});
    throw err;
  } finally {
    c.release();
  }
}

const API_ROLES = new Set(['anon', 'authenticated', 'service_role']);

/**
 * Runs fn inside a transaction as the API role named in the JWT claims, with
 * request.jwt.claims set, so row level security applies exactly as it does
 * for PostgREST requests.
 */
export async function asRole<T>(p: pg.Pool, claims: Claims, fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const role = typeof claims.role === 'string' ? claims.role : 'anon';
  if (!API_ROLES.has(role)) throw Object.assign(new Error(`role "${role}" is not allowed`), { code: '42501' });
  return tx(p, async (c) => {
    await c.query(`set local role ${quoteIdent(role)}`);
    await c.query(
      `select set_config('request.jwt.claims', $1, true),
              set_config('request.jwt.claim.sub', $2, true),
              set_config('request.jwt.claim.role', $3, true)`,
      [JSON.stringify(claims), typeof claims.sub === 'string' ? claims.sub : '', role],
    );
    return fn(c);
  });
}

export function quoteIdent(name: string): string {
  return '"' + String(name).replace(/"/g, '""') + '"';
}

export function quoteLiteral(value: string): string {
  return "'" + String(value).replace(/'/g, "''") + "'";
}

/** Waits until Postgres accepts connections. */
export async function waitForDb(database = 'postgres', user = config.db.superuser, timeoutMs = 120_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let attempt = 0;
  for (;;) {
    const c = newClient(database, user);
    try {
      await c.connect();
      await c.query('select 1');
      await c.end();
      return;
    } catch (err) {
      await c.end().catch(() => {});
      // A wrong password won't fix itself by waiting.
      if ((err as { code?: string }).code === '28P01') throw err;
      if (Date.now() > deadline) throw err;
      if (attempt++ % 5 === 0) log.info('waiting for database', { database, user, error: (err as Error).message });
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
}
