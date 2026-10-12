import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { SERVICE_ROLES, config, rolePassword, rolePasswordFile, type ServiceRole } from './config.js';
import { newClient, quoteIdent, quoteLiteral } from './db.js';
import { sign, type JwtKey } from './jwt.js';
import { log } from './log.js';
import { PROJECT_NAME_RE, RESERVED_NAMES, dbNameFor, ownerRoleFor, type ProjectSettings } from './registry.js';

const SQL_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../sql');

/** Roles that connect to project databases (keel_functions_admin only reads the control database). */
const PROJECT_DB_ROLES = SERVICE_ROLES.filter((r) => r !== 'keel_functions_admin');

function sqlFile(name: string): Promise<string> {
  return fs.readFile(path.join(SQL_DIR, name), 'utf8');
}

async function sqlFiles(dir: string): Promise<{ version: number; name: string; sql: string }[]> {
  const files = (await fs.readdir(path.join(SQL_DIR, dir))).filter((f) => f.endsWith('.sql')).sort();
  return Promise.all(
    files.map(async (f) => ({
      version: Number.parseInt(f, 10),
      name: f,
      sql: await fs.readFile(path.join(SQL_DIR, dir, f), 'utf8'),
    })),
  );
}

/**
 * Leaves a role's password where the service that logs in as it reads it
 * (see rolePassword): in keel-migrate, which has the credentials folder (one
 * volume per role, or one host folder). Without that folder (development)
 * there is nothing to do.
 */
async function writeRolePassword(role: ServiceRole): Promise<void> {
  const file = rolePasswordFile(role);
  const root = await fs.stat(config.db.credentialsDir).catch(() => null);
  if (!root?.isDirectory()) return;
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(tmp, `${rolePassword(role)}\n`, { mode: 0o600 });
  await fs.rename(tmp, file);
}

/** Creates cluster roles and the control database. Safe to run on every start. */
export async function migrateCluster(): Promise<void> {
  const c = newClient('postgres');
  await c.connect();
  try {
    await c.query(await sqlFile('cluster/roles.sql'));
    for (const role of SERVICE_ROLES) {
      await c.query(`alter role ${quoteIdent(role)} with login password ${quoteLiteral(rolePassword(role))}`);
      await writeRolePassword(role);
    }
    const { rowCount } = await c.query('select 1 from pg_database where datname = $1', [config.db.controlDb]);
    if (!rowCount) {
      await c.query(`create database ${quoteIdent(config.db.controlDb)}`);
      log.info('created control database', { database: config.db.controlDb });
    }
  } finally {
    await c.end();
  }

  const k = newClient(config.db.controlDb);
  await k.connect();
  try {
    await k.query(await sqlFile('cluster/control.sql'));
  } finally {
    await k.end();
  }
}

/**
 * Creates a project's owner role if it doesn't exist (without a login until
 * ensureOwnerLogin) and keeps its attributes and memberships as they should
 * be: never a superuser, no new databases or roles, no replication, and no
 * BYPASSRLS: that attribute holds in every database, including the control
 * database, where row level security keeps each owner to its own project's
 * functions and secrets. In its project it owns the tables in public, and
 * policies give it every row of storage and realtime (012_owner_policies.sql).
 * It may switch to the API roles; may deploy its project's functions (keel_project_owners); and may
 * change what the Supabase importer created (keel_import_<db>).
 */
async function ensureOwnerRole(c: ReturnType<typeof newClient>, dbName: string): Promise<void> {
  const name = ownerRoleFor(dbName);
  const role = quoteIdent(name);
  const attrs = 'nosuperuser nocreatedb nocreaterole noreplication nobypassrls inherit';
  const exists = (await c.query('select 1 from pg_roles where rolname = $1', [name])).rowCount;
  await c.query(exists ? `alter role ${role} ${attrs}` : `create role ${role} nologin ${attrs}`);
  await c.query(`grant anon, authenticated, service_role, keel_project_owners to ${role}`);
  const importer = `keel_import_${dbName}`.slice(0, 63);
  if ((await c.query('select 1 from pg_roles where rolname = $1', [importer])).rowCount) {
    await c.query(`grant ${quoteIdent(importer)} to ${role}`);
  }
}

/**
 * Gives a project's owner role its password (made once, kept in
 * keel.project_owners for Studio to show) and lets it log in.
 */
export async function ensureOwnerLogin(k: ReturnType<typeof newClient>, project: string, dbName: string): Promise<void> {
  await k.query('insert into keel.project_owners (project, password) values ($1, $2) on conflict (project) do nothing', [
    project,
    crypto.randomBytes(24).toString('hex'),
  ]);
  const { rows } = await k.query('select password from keel.project_owners where project = $1', [project]);
  await k.query(`alter role ${quoteIdent(ownerRoleFor(dbName))} login password ${quoteLiteral(rows[0].password)}`);
}

/** Applies pending project migrations to one project database. */
export async function migrateProjectDb(dbName: string): Promise<number> {
  const c = newClient(dbName);
  await c.connect();
  let applied = 0;
  try {
    await ensureOwnerRole(c, dbName);
    await c.query(`create schema if not exists _keel`);
    await c.query(
      `create table if not exists _keel.migrations (version int primary key, name text not null, applied_at timestamptz not null default now())`,
    );
    const done = new Set((await c.query('select version from _keel.migrations')).rows.map((r) => r.version as number));
    for (const f of await sqlFiles('project')) {
      if (done.has(f.version)) continue;
      await c.query('begin');
      try {
        await c.query(f.sql);
        await c.query('insert into _keel.migrations (version, name) values ($1, $2)', [f.version, f.name]);
        await c.query('commit');
        applied++;
      } catch (err) {
        await c.query('rollback').catch(() => {});
        throw new Error(`migration ${f.name} failed on ${dbName}: ${(err as Error).message}`);
      }
    }
    await c.query(`alter database ${quoteIdent(dbName)} set search_path to "$user", public, extensions`);
    await c.query(`revoke connect on database ${quoteIdent(dbName)} from public`);
    await c.query(`grant connect on database ${quoteIdent(dbName)} to ${PROJECT_DB_ROLES.map(quoteIdent).join(', ')}`);
    await c.query(`grant connect, create, temporary on database ${quoteIdent(dbName)} to ${quoteIdent(ownerRoleFor(dbName))}`);
  } finally {
    await c.end();
  }
  return applied;
}

export function validateProjectName(name: string): string | null {
  if (!PROJECT_NAME_RE.test(name)) {
    return 'Use 3-40 lowercase letters, digits and dashes, starting with a letter.';
  }
  if (RESERVED_NAMES.has(name)) return `"${name}" is reserved.`;
  if (name.includes('--')) return 'Avoid consecutive dashes.';
  return null;
}

/**
 * The anon and service role keys. They are long-lived like Supabase's (an
 * app ships the anon key); rolling the project's keys replaces them.
 */
export function generateKeys(name: string, key: JwtKey) {
  const iat = Math.floor(Date.now() / 1000);
  const exp = iat + 10 * 365 * 24 * 3600;
  return {
    anonKey: sign({ iss: 'keel', ref: name, role: 'anon', iat, exp }, key),
    serviceKey: sign({ iss: 'keel', ref: name, role: 'service_role', iat, exp }, key),
  };
}

/** A new signing key: 48 random bytes, and a short random id for the kid header. */
export function newJwtKey(): JwtKey {
  return { kid: crypto.randomBytes(6).toString('hex'), secret: crypto.randomBytes(48).toString('base64url') };
}

/**
 * Settings a new project starts with. Projects created before a default
 * changed keep what they had (an unset value means the old default).
 */
const NEW_PROJECT_SETTINGS: ProjectSettings = { password_min_length: 8 };

export async function createProject(name: string, settings: ProjectSettings = {}): Promise<void> {
  const problem = validateProjectName(name);
  if (problem) throw Object.assign(new Error(problem), { status: 400 });
  const dbName = dbNameFor(name);

  const k = newClient(config.db.controlDb);
  await k.connect();
  try {
    const exists = await k.query('select 1 from keel.projects where name = $1 or db_name = $2', [name, dbName]);
    if (exists.rowCount) throw Object.assign(new Error(`Project "${name}" already exists.`), { status: 409 });

    const c = newClient('postgres');
    await c.connect();
    try {
      const has = await c.query('select 1 from pg_database where datname = $1', [dbName]);
      if (!has.rowCount) await c.query(`create database ${quoteIdent(dbName)}`);
    } finally {
      await c.end();
    }

    await migrateProjectDb(dbName);

    // The internal secret (jwt_secret) never signs tokens, so it never
    // needs to leave the server. Projects created before keys could be
    // rolled used it as their first signing key ("legacy").
    const internal = crypto.randomBytes(48).toString('base64url');
    const key = newJwtKey();
    const { anonKey, serviceKey } = generateKeys(name, key);
    await k.query('begin');
    try {
      await k.query(
        `insert into keel.projects (name, db_name, jwt_secret, anon_key, service_key, settings)
         values ($1, $2, $3, $4, $5, $6)`,
        [name, dbName, internal, anonKey, serviceKey, { ...NEW_PROJECT_SETTINGS, ...settings }],
      );
      await k.query('insert into keel.project_jwt_keys (project, kid, secret) values ($1, $2, $3)', [name, key.kid, key.secret]);
      await k.query('commit');
    } catch (err) {
      await k.query('rollback').catch(() => {});
      throw err;
    }
    await ensureOwnerLogin(k, name, dbName);
    log.info('created project', { project: name, database: dbName });
  } finally {
    await k.end();
  }
}

export async function deleteProject(name: string): Promise<void> {
  const k = newClient(config.db.controlDb);
  await k.connect();
  try {
    const { rows } = await k.query('select db_name from keel.projects where name = $1', [name]);
    if (!rows.length) throw Object.assign(new Error(`Project "${name}" not found.`), { status: 404 });
    const dbName = rows[0].db_name as string;
    // Unregister first so services stop routing to it and release connections.
    await k.query('delete from keel.projects where name = $1', [name]);
    await new Promise((r) => setTimeout(r, 1500));
    const c = newClient('postgres');
    await c.connect();
    try {
      await c.query(`drop database if exists ${quoteIdent(dbName)} with (force)`);
      // Owner of anything imported from Supabase into this project (see importer).
      await c.query(`drop role if exists ${quoteIdent(`keel_import_${dbName}`.slice(0, 63))}`).catch(() => {});
      await c.query(`drop role if exists ${quoteIdent(ownerRoleFor(dbName))}`).catch((err) => log.warn('could not drop the project owner role', { role: ownerRoleFor(dbName), error: (err as Error).message }));
    } finally {
      await c.end();
    }
    log.info('deleted project', { project: name, database: dbName });
  } finally {
    await k.end();
  }
}

export const DEFAULT_KEY_GRACE_HOURS = 24;
const MAX_KEY_GRACE_HOURS = 30 * 24;

/** Hours the old keys keep verifying after a planned roll: a number from 1 to 720. */
export function keyGraceHours(input: unknown): number {
  if (input === undefined || input === null || input === '') return DEFAULT_KEY_GRACE_HOURS;
  const n = typeof input === 'number' ? input : Number(input);
  if (!Number.isInteger(n) || n < 1 || n > MAX_KEY_GRACE_HOURS) {
    throw Object.assign(new Error(`The grace period is a whole number of hours from 1 to ${MAX_KEY_GRACE_HOURS}.`), { status: 400 });
  }
  return n;
}

export type KeyInfo = { kid: string; createdAt: string; expiresAt: string | null; current: boolean };
export type KeyEvent = { action: string; kid: string | null; actor: string; detail: Record<string, unknown>; createdAt: string };

async function withControl<T>(fn: (k: ReturnType<typeof newClient>) => Promise<T>): Promise<T> {
  const k = newClient(config.db.controlDb);
  await k.connect();
  try {
    return await fn(k);
  } finally {
    await k.end();
  }
}

async function inTx<T>(k: ReturnType<typeof newClient>, fn: () => Promise<T>): Promise<T> {
  await k.query('begin');
  try {
    const out = await fn();
    await k.query('commit');
    return out;
  } catch (err) {
    await k.query('rollback').catch(() => {});
    throw err;
  }
}

async function lockProject(k: ReturnType<typeof newClient>, name: string): Promise<string> {
  const { rows } = await k.query('select db_name from keel.projects where name = $1 for update', [name]);
  if (!rows.length) throw Object.assign(new Error(`Project "${name}" not found.`), { status: 404 });
  // Keys whose grace period is over have no use left.
  await k.query('delete from keel.project_jwt_keys where project = $1 and expires_at <= now()', [name]);
  return rows[0].db_name as string;
}

/** The project's signing keys that still verify (newest first) and the latest key events. */
export async function listKeys(name: string): Promise<{ keys: KeyInfo[]; events: KeyEvent[] }> {
  return withControl(async (k) => {
    const { rows } = await k.query(
      `select kid, created_at, expires_at from keel.project_jwt_keys
        where project = $1 and (expires_at is null or expires_at > now())
        order by created_at desc, kid`,
      [name],
    );
    const ev = await k.query(
      `select action, kid, actor, detail, created_at from keel.project_key_events
        where project = $1 order by created_at desc limit 50`,
      [name],
    );
    return {
      keys: rows.map((r, i) => ({ kid: r.kid, createdAt: new Date(r.created_at).toISOString(), expiresAt: r.expires_at ? new Date(r.expires_at).toISOString() : null, current: i === 0 })),
      events: ev.rows.map((r) => ({ action: r.action, kid: r.kid, actor: r.actor, detail: r.detail || {}, createdAt: new Date(r.created_at).toISOString() })),
    };
  });
}

/**
 * Rolls a project's keys: a new signing key, and new anon and service role
 * keys signed with it.
 *
 * Planned (default): the old keys keep verifying for `graceHours`, so apps
 * still using the old anon key and signed-in users carry on; sessions
 * refresh onto the new key.
 *
 * Emergency: the old keys stop verifying at once and every user session of
 * the project ends (refresh tokens would otherwise mint tokens with the new
 * key), so everyone signs in again.
 */
export async function rollKeys(
  name: string,
  opts: { emergency?: boolean; graceHours?: number; actor: string },
): Promise<{ kid: string; anonKey: string; serviceKey: string; revoked: string[]; endedSessions: number }> {
  const grace = opts.emergency ? 0 : keyGraceHours(opts.graceHours);
  const key = newJwtKey();
  const { anonKey, serviceKey, dbName, revoked } = await withControl((k) =>
    inTx(k, async () => {
      const dbName = await lockProject(k, name);
      let revoked: string[] = [];
      if (opts.emergency) {
        const del = await k.query('delete from keel.project_jwt_keys where project = $1 returning kid', [name]);
        revoked = del.rows.map((r) => r.kid as string);
      } else {
        await k.query(
          `update keel.project_jwt_keys
              set expires_at = least(coalesce(expires_at, 'infinity'::timestamptz), now() + make_interval(hours => $2))
            where project = $1`,
          [name, grace],
        );
      }
      await k.query('insert into keel.project_jwt_keys (project, kid, secret) values ($1, $2, $3)', [name, key.kid, key.secret]);
      const keys = generateKeys(name, key);
      await k.query('update keel.projects set anon_key = $2, service_key = $3 where name = $1', [name, keys.anonKey, keys.serviceKey]);
      await k.query(
        'insert into keel.project_key_events (project, action, kid, actor, detail) values ($1, $2, $3, $4, $5)',
        [name, opts.emergency ? 'roll_emergency' : 'roll', key.kid, opts.actor, opts.emergency ? { revoked } : { grace_hours: grace }],
      );
      return { ...keys, dbName, revoked };
    }),
  );
  let endedSessions = 0;
  if (opts.emergency) endedSessions = await endUserSessions(name, dbName, opts.actor);
  log.info('rolled project keys', { project: name, kid: key.kid, emergency: !!opts.emergency, grace_hours: grace, actor: opts.actor });
  return { kid: key.kid, anonKey, serviceKey, revoked, endedSessions };
}

/** Stops the old keys verifying now, instead of at the end of their grace period. */
export async function revokeOldKeys(name: string, actor: string): Promise<{ revoked: string[] }> {
  const revoked = await withControl((k) =>
    inTx(k, async () => {
      await lockProject(k, name);
      const del = await k.query(
        `delete from keel.project_jwt_keys
          where project = $1
            and kid <> (select kid from keel.project_jwt_keys where project = $1 order by created_at desc, kid limit 1)
          returning kid`,
        [name],
      );
      const kids = del.rows.map((r) => r.kid as string);
      if (kids.length) {
        await k.query('insert into keel.project_key_events (project, action, kid, actor, detail) values ($1, $2, null, $3, $4)', [name, 'revoke', actor, { revoked: kids }]);
      }
      return kids;
    }),
  );
  if (revoked.length) log.info('revoked old project keys', { project: name, revoked, actor });
  return { revoked };
}

async function endUserSessions(name: string, dbName: string, actor: string): Promise<number> {
  const c = newClient(dbName);
  await c.connect();
  try {
    // Refresh tokens and MFA state go with their session (on delete cascade).
    const { rowCount } = await c.query('delete from auth.sessions');
    await withControl((k) =>
      k.query('insert into keel.project_key_events (project, action, kid, actor, detail) values ($1, $2, null, $3, $4)', [name, 'end_sessions', actor, { sessions: rowCount || 0 }]),
    );
    return rowCount || 0;
  } finally {
    await c.end();
  }
}
