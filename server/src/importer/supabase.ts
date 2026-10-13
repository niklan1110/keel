import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import pg from 'pg';
import { config } from '../lib/config.js';
import { newClient, quoteIdent, quoteLiteral } from '../lib/db.js';
import { ownerRoleFor, type Project } from '../lib/registry.js';
import { DEFAULT_CONTENT_TYPE, normalizeContentType } from '../storage/mime.js';

/**
 * One-way import of a Supabase project into a Keel project: schema and data
 * (pg_dump/pg_restore), auth users with their password hashes, identities and
 * MFA factors, storage buckets, policies and files, triggers on auth.users and
 * realtime publication membership. Supabase is only read, never changed.
 *
 * Works the same for a Keel project as the source (same schemas), which is
 * how it is tested.
 *
 * The source is treated as untrusted input: its schema is restored by a
 * dedicated non-superuser role (keel_import_<db>) that ends up owning the
 * imported objects, so code from the source (functions in CHECK constraints,
 * SECURITY DEFINER functions...) can never act as the Postgres superuser.
 * Definitions read from the source (triggers on auth.users, policies on
 * storage and realtime tables) run on a connection logged in as the table's
 * owner, never the superuser, and with the extended query protocol, which
 * refuses more than one statement (see runSingle). Bucket ids and file names
 * are checked before they become part of a URL.
 */

export type ImportOptions = {
  project: Project;
  /** Postgres connection string of the source (Supabase: Connect > Session pooler). */
  dbUrl: string;
  /** Project URL and service_role key, needed to copy files. */
  apiUrl?: string;
  serviceKey?: string;
  schema?: boolean;
  auth?: boolean;
  storage?: boolean;
  log: (msg: string, level?: 'info' | 'warn' | 'error') => void;
};

export type ImportResult = { warnings: number; tables: number; users: number; files: number };

/** Schemas Supabase (or Keel) manages itself; never copied as user schemas. */
const PLATFORM_SCHEMAS = [
  'auth', 'storage', 'realtime', '_realtime', 'extensions', 'graphql', 'graphql_public', 'net', 'pgbouncer',
  'pgsodium', 'pgsodium_masks', 'supabase_functions', 'supabase_migrations', 'vault', 'cron', '_analytics',
  '_supavisor', 'pgtle', '_keel', '_keel_defaults', 'information_schema', 'tiger', 'tiger_data', 'topology', 'repack', 'pgmq',
];

/** Extensions Keel will create for an import: common, and safe to have in a project database. */
const SAFE_EXTENSIONS = new Set([
  'pgcrypto', 'uuid-ossp', 'pg_trgm', 'citext', 'hstore', 'ltree', 'unaccent', 'fuzzystrmatch', 'btree_gin', 'btree_gist',
  'intarray', 'cube', 'earthdistance', 'tablefunc', 'moddatetime', 'isn', 'seg', 'dict_int', 'tsm_system_rows', 'tsm_system_time',
  // In keel-postgres (keel-db's image).
  'vector', 'postgis',
]);

/** Hides the password in a connection string for log output. */
export function redactUrl(url: string): string {
  try {
    const u = new URL(url);
    if (u.password) u.password = '•••';
    return u.toString();
  } catch {
    return url.replace(/\/\/.*@/, '//•••@');
  }
}

function sourceClient(dbUrl: string): pg.Client {
  const u = new URL(dbUrl);
  const mode = u.searchParams.get('sslmode');
  u.searchParams.delete('sslmode');
  // Like pg_dump's default (sslmode=prefer), use TLS when the server offers it without
  // checking the certificate; sslmode=disable turns it off.
  const local = ['localhost', '127.0.0.1', 'keel-db'].includes(u.hostname);
  return new pg.Client({
    connectionString: u.toString(),
    ssl: mode === 'disable' || (local && !mode) ? false : { rejectUnauthorized: mode === 'verify-full' },
    connectionTimeoutMillis: 15_000,
    application_name: 'keel-import',
    // Catalog lookups must not resolve to look-alike objects in the source's own schemas.
    options: '-c search_path=pg_catalog',
  });
}

/**
 * Takes the password out of a connection string, so it can reach pg_dump in
 * PGPASSWORD instead of on its command line, where `ps` would show it.
 */
export function splitPassword(dbUrl: string): { url: string; password: string } {
  const u = new URL(dbUrl);
  const password = u.password ? decodeURIComponent(u.password) : (u.searchParams.get('password') ?? '');
  u.password = '';
  u.searchParams.delete('password');
  return { url: u.toString(), password };
}

function run(cmd: string, args: string[], env: Record<string, string>): Promise<{ code: number; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { env: { ...process.env, ...env }, stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (d) => (stderr += d.toString()));
    child.on('error', reject);
    child.on('exit', (code) => resolve({ code: code ?? 1, stderr }));
  });
}

async function columns(c: pg.ClientBase, schema: string, table: string, writableOnly = false): Promise<string[]> {
  const { rows } = await c.query(
    `select column_name from information_schema.columns
      where table_schema = $1 and table_name = $2
        ${writableOnly ? `and is_generated = 'NEVER' and coalesce(identity_generation, '') <> 'ALWAYS'` : ''}
      order by ordinal_position`,
    [schema, table],
  );
  return rows.map((r) => r.column_name as string);
}

async function tableExists(c: pg.ClientBase, schema: string, table: string): Promise<boolean> {
  const { rows } = await c.query('select to_regclass($1) as t', [`${quoteIdent(schema)}.${quoteIdent(table)}`]);
  return !!rows[0].t;
}

/** Copies rows between same-named tables using the columns both sides have. */
async function copyTable(src: pg.ClientBase, dst: pg.ClientBase, schema: string, table: string, opts: { where?: string; conflict?: string } = {}): Promise<number> {
  if (!(await tableExists(src, schema, table)) || !(await tableExists(dst, schema, table))) return 0;
  const want = new Set(await columns(dst, schema, table, true));
  const cols = (await columns(src, schema, table)).filter((c) => want.has(c));
  if (!cols.length) return 0;
  const list = cols.map(quoteIdent).join(', ');
  const rel = `${quoteIdent(schema)}.${quoteIdent(table)}`;
  let copied = 0;
  let offset = 0;
  for (;;) {
    // Cast to text and back so every type (jsonb, arrays, enums, inet...) round-trips exactly.
    const { rows } = await src.query(
      `select ${cols.map((c) => `${quoteIdent(c)}::text`).join(', ')} from ${rel} ${opts.where ? `where ${opts.where}` : ''} order by 1 limit 500 offset ${offset}`,
    );
    if (!rows.length) break;
    const types = await dst.query(
      `select a.attname, format_type(a.atttypid, a.atttypmod) as t from pg_attribute a where a.attrelid = $1::regclass and a.attnum > 0 and not a.attisdropped`,
      [rel],
    );
    const typeOf = new Map(types.rows.map((r) => [r.attname, r.t]));
    const values: unknown[] = [];
    const tuples = rows.map((r) => `(${cols.map((c) => (values.push(r[c]), `$${values.length}::${typeOf.get(c) || 'text'}`)).join(', ')})`);
    const res = await dst.query(`insert into ${rel} (${list}) values ${tuples.join(', ')} ${opts.conflict ?? 'on conflict do nothing'}`, values);
    copied += res.rowCount || 0;
    offset += rows.length;
    if (rows.length < 500) break;
  }
  return copied;
}

const encodePath = (name: string) => name.split('/').map(encodeURIComponent).join('/');

/** Roles that own Keel's auth, storage and realtime tables: the only ones source SQL may run as. */
const PLATFORM_OWNERS = new Set(['keel_auth_admin', 'keel_storage_admin', 'keel_realtime_admin']);
/** Platform tables whose policies are copied. */
const POLICY_TABLES = new Set(['storage.objects', 'storage.buckets', 'realtime.messages']);

const CONTROL_RE = /[\x00-\x1f\x7f]/;

/**
 * Bucket ids and file names come from the source and become URL paths for the
 * download and the upload: refuse anything that could change which URL is
 * requested (`.` and `..` segments, backslashes, a slash in a bucket id) or
 * that has control characters.
 */
export function safeStorageKey(bucket: unknown, name: unknown): boolean {
  if (typeof bucket !== 'string' || typeof name !== 'string') return false;
  if (!bucket || bucket === '.' || bucket === '..' || /[/\\]/.test(bucket) || CONTROL_RE.test(bucket)) return false;
  if (!name || name.length > 1024 || name.startsWith('/') || name.includes('\\') || CONTROL_RE.test(name)) return false;
  return !name.split('/').some((seg) => seg === '.' || seg === '..');
}

/**
 * Runs one statement built from source-controlled text. node-pg sends a query
 * without parameters with the simple protocol, which runs every statement in
 * the string, so a definition ending in `; reset role; …` would continue as
 * the session user. With the extended protocol Postgres refuses more than one.
 */
function runSingle(c: pg.ClientBase, text: string): Promise<pg.QueryResult> {
  return c.query({ text, queryMode: 'extended' } as pg.QueryConfig);
}

export async function importFromSupabase(o: ImportOptions): Promise<ImportResult> {
  const result: ImportResult = { warnings: 0, tables: 0, users: 0, files: 0 };
  const warn = (msg: string) => {
    result.warnings++;
    o.log(msg, 'warn');
  };
  const doSchema = o.schema !== false;
  const doAuth = o.auth !== false;
  const doStorage = o.storage !== false && !!o.apiUrl && !!o.serviceKey;

  let parsed: URL;
  try {
    parsed = new URL(o.dbUrl);
    if (!/^postgres(ql)?:$/.test(parsed.protocol)) throw new Error();
  } catch {
    throw new Error('The database URL should look like postgresql://postgres.<ref>:<password>@<host>:5432/postgres');
  }

  o.log(`Connecting to ${redactUrl(o.dbUrl)}`);
  let role: { name: string; password: string } | null = null;
  const src = sourceClient(o.dbUrl);
  await src.connect();
  // The project's search_path, as before: extensions that can't go in `extensions` land in public.
  const dst = newClient(o.project.dbName, undefined, { projectPath: true });
  await dst.connect();
  try {
    const srcVersion = Number((await src.query(`select current_setting('server_version_num') as v`)).rows[0].v);
    const dstVersion = Number((await dst.query(`select current_setting('server_version_num') as v`)).rows[0].v);
    o.log(`Source runs Postgres ${Math.floor(srcVersion / 10000)}, Keel runs Postgres ${Math.floor(dstVersion / 10000)}`);
    if (Math.floor(srcVersion / 10000) > Math.floor(dstVersion / 10000)) {
      throw new Error(`The source runs a newer Postgres (${Math.floor(srcVersion / 10000)}) than Keel (${Math.floor(dstVersion / 10000)}). Update Keel first.`);
    }
    const existing = Number((await dst.query(`select count(*) from pg_tables where schemaname = 'public'`)).rows[0].count);
    if (existing > 0) warn(`The target project already has ${existing} table(s) in public. Same-named objects will clash; a fresh project is best.`);

    // ------------------------------------------------------------ extensions
    if (doSchema) {
      const exts = (await src.query(`select extname from pg_catalog.pg_extension where extname <> 'plpgsql' order by 1`)).rows.map((r) => r.extname as string);
      const available = new Set((await dst.query('select name from pg_available_extensions')).rows.map((r) => r.name as string));
      const missing: string[] = [];
      for (const ext of exts) {
        if (!available.has(ext) || !SAFE_EXTENSIONS.has(ext)) {
          missing.push(ext);
          continue;
        }
        await dst.query(`create extension if not exists ${quoteIdent(ext)} with schema extensions`).catch(async () => {
          await dst.query(`create extension if not exists ${quoteIdent(ext)}`).catch((err) => warn(`Extension ${ext}: ${err.message}`));
        });
      }
      const platform = new Set(['pg_graphql', 'pg_net', 'pgsodium', 'supabase_vault', 'pg_stat_statements', 'pgjwt', 'pg_cron', 'pgaudit', 'wrappers', 'pg_tle']);
      const relevant = missing.filter((m) => !platform.has(m));
      if (relevant.length) warn(`Extensions not available in Keel: ${relevant.join(', ')}. Objects that use them won't import.`);
    }

    // ------------------------------------------------------------ auth (before tables, so foreign keys to auth.users hold)
    if (doAuth) {
      o.log('Copying auth users, identities and MFA factors…');
      result.users = await copyTable(src, dst, 'auth', 'users');
      const idents = await copyTable(src, dst, 'auth', 'identities');
      const factors = await copyTable(src, dst, 'auth', 'mfa_factors', { where: `factor_type::text in ('totp', 'phone')` });
      o.log(`Imported ${result.users} users, ${idents} identities and ${factors} MFA factors (passwords keep working; users sign in again).`);
    }

    // ------------------------------------------------------------ schema and data
    if (doSchema) {
      const schemas = (
        await src.query(
          `select nspname from pg_namespace where nspname <> all($1) and nspname not like 'pg\\_%' and nspname not like '\\_timescaledb%' order by nspname = 'public' desc, nspname`,
          [PLATFORM_SCHEMAS],
        )
      ).rows.map((r) => r.nspname as string);
      result.tables = Number(
        (await src.query(`select count(*) from pg_tables where schemaname = any($1)`, [schemas])).rows[0].count,
      );
      o.log(`Dumping ${schemas.join(', ')} (${result.tables} tables)…`);
      role = await prepareImportRole(dst, o.project.dbName);
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'keel-import-'));
      const file = path.join(dir, 'source.dump');
      try {
        const source = splitPassword(o.dbUrl);
        const dump = await run(
          'pg_dump',
          [
            '--format=custom',
            '--no-owner',
            '--no-publications',
            '--no-subscriptions',
            '--no-security-labels',
            '--file',
            file,
            ...schemas.map((s) => `--schema=${JSON.stringify(s)}`),
            '--dbname',
            source.url,
          ],
          // Always set, even when empty, so a PGPASSWORD Keel itself has never goes to the source.
          { PGPASSWORD: source.password },
        );
        if (dump.code !== 0) throw new Error(`pg_dump failed: ${dump.stderr.trim().split('\n').slice(-3).join(' ')}`);
        o.log('Restoring into Keel…');
        const restore = await run('pg_restore', ['--no-owner', '--dbname', o.project.dbName, file], {
          PGPASSWORD: role.password,
          PGHOST: config.db.host,
          PGPORT: String(config.db.port),
          PGUSER: role.name,
          // Keep each table's row level security exactly as it was in the source.
          PGOPTIONS: '-c keel.auto_rls=off',
        });
        const errors = restore.stderr.split('\n').filter((l) => /error:/i.test(l));
        // Grants to Supabase's internal roles can't apply here and don't matter.
        const missingRoles = errors.filter((l) => /role "[^"]+" does not exist|permission denied to change default privileges|must be able to SET ROLE/.test(l));
        const real = errors.filter((l) => !missingRoles.includes(l) && !/schema "public" already exists|must be owner of schema public/.test(l));
        if (missingRoles.length) o.log(`Skipped ${missingRoles.length} grant(s) involving Supabase-internal roles.`);
        for (const l of real.slice(0, 25)) warn(l.replace(/^pg_restore: /, '').trim());
        if (real.length > 25) warn(`…and ${real.length - 25} more restore errors.`);
      } finally {
        await fs.rm(dir, { recursive: true, force: true });
      }

      // Tables that were in the realtime publication keep streaming changes.
      const pub = await src.query(
        `select schemaname, tablename from pg_catalog.pg_publication_tables where pubname in ('supabase_realtime', 'keel_realtime') and schemaname <> all($1)`,
        [PLATFORM_SCHEMAS.filter((s) => s !== 'public')],
      );
      for (const r of pub.rows) {
        await runSingle(dst, `alter publication supabase_realtime add table ${quoteIdent(r.schemaname)}.${quoteIdent(r.tablename)}`)
          .catch((err) => !/already member/.test(err.message) && warn(`Realtime for ${r.schemaname}.${r.tablename}: ${err.message}`));
      }
      if (pub.rows.length) o.log(`Enabled realtime on ${pub.rows.length} table(s).`);
    }

    // ------------------------------------------------------------ triggers on auth.users (e.g. create a profile on sign-up)
    if (doAuth && doSchema) {
      const trg = await src.query(
        `select t.tgname, pg_catalog.pg_get_triggerdef(t.oid) as def from pg_catalog.pg_trigger t join pg_catalog.pg_class c on c.oid = t.tgrelid
           join pg_catalog.pg_namespace n on n.oid = c.relnamespace where n.nspname = 'auth' and c.relname = 'users' and not t.tgisinternal`,
      );
      for (const r of trg.rows) {
        try {
          const def = String(r.def);
          const name = String(r.tgname);
          // Keel's own triggers (from its migrations, also present in a Keel source) are never replaced.
          if (name.startsWith('keel_')) continue;
          if (!/^CREATE (CONSTRAINT )?TRIGGER /.test(def) || !/ ON auth\.users /.test(def)) throw new Error('unexpected trigger definition');
          // As the auth.users owner, one statement only.
          await asOwner(dst, o.project.dbName, 'keel_auth_admin', async (c) => {
            await c.query(`drop trigger if exists ${quoteIdent(name)} on auth.users`);
            await runSingle(c, def);
            // It must have made this trigger on auth.users, not one on another table.
            const made = await c.query(`select 1 from pg_catalog.pg_trigger where tgrelid = 'auth.users'::regclass and tgname = $1`, [name]);
            if (!made.rowCount) throw new Error('the definition does not create this trigger on auth.users');
          });
          o.log(`Recreated trigger ${r.tgname} on auth.users`);
        } catch (err) {
          warn(`Trigger ${r.tgname} on auth.users: ${(err as Error).message}`);
        }
      }
    }

    // ------------------------------------------------------------ policies on platform tables
    if (doSchema) {
      const roles = new Set((await dst.query('select rolname from pg_roles')).rows.map((r) => r.rolname as string));
      const pol = await src.query(
        `select schemaname, tablename, policyname, permissive, roles::text[] as roles, cmd, qual, with_check from pg_catalog.pg_policies
          where (schemaname, tablename) in (('storage', 'objects'), ('storage', 'buckets'), ('realtime', 'messages'))`,
      );
      let n = 0;
      for (const p of pol.rows) {
        const rel = `${quoteIdent(p.schemaname)}.${quoteIdent(p.tablename)}`;
        if (!(await tableExists(dst, p.schemaname, p.tablename))) continue;
        try {
          if (!POLICY_TABLES.has(`${p.schemaname}.${p.tablename}`)) throw new Error('unexpected table');
          if (!['ALL', 'SELECT', 'INSERT', 'UPDATE', 'DELETE'].includes(p.cmd)) throw new Error(`unexpected command ${p.cmd}`);
          const to = (Array.isArray(p.roles) ? (p.roles as string[]) : []).filter((r) => r === 'public' || roles.has(r));
          const sql =
            `create policy ${quoteIdent(p.policyname)} on ${rel} as ${p.permissive === 'PERMISSIVE' ? 'permissive' : 'restrictive'} for ${p.cmd.toLowerCase()}` +
            ` to ${to.length ? to.map((r) => (r === 'public' ? 'public' : quoteIdent(r))).join(', ') : 'public'}` +
            (p.qual ? ` using (${p.qual})` : '') +
            (p.with_check ? ` with check (${p.with_check})` : '');
          const owner = (await dst.query(`select pg_get_userbyid(relowner) as owner from pg_class where oid = $1::regclass`, [rel])).rows[0].owner as string;
          if (!PLATFORM_OWNERS.has(owner)) throw new Error(`refusing to act as ${owner}`);
          // Policies usually call auth.uid() / auth.jwt(); the owner needs to see that schema.
          await dst.query(`grant usage on schema auth to ${quoteIdent(owner)}`);
          // As the table's owner (never the superuser), one statement only.
          await asOwner(dst, o.project.dbName, owner, async (c) => {
            await c.query(`drop policy if exists ${quoteIdent(p.policyname)} on ${rel}`);
            await runSingle(c, sql);
          });
          n++;
        } catch (err) {
          warn(`Policy "${p.policyname}" on ${p.schemaname}.${p.tablename}: ${(err as Error).message}`);
        }
      }
      if (n) o.log(`Copied ${n} storage/realtime polic${n === 1 ? 'y' : 'ies'}.`);
    }

    // ------------------------------------------------------------ storage
    if (o.storage !== false && !doStorage) {
      o.log('Files were not copied: give the project URL and service_role key to include them.', 'warn');
    }
    if (doStorage) {
      const buckets = await copyTable(src, dst, 'storage', 'buckets');
      const cols = new Set(await columns(src, 'storage', 'objects'));
      const objs = (
        await src.query(
          `select bucket_id, name, owner::text, ${cols.has('owner_id') ? 'owner_id' : 'null as owner_id'}, metadata,
                  ${cols.has('user_metadata') ? 'user_metadata' : 'null as user_metadata'}, created_at, updated_at
             from storage.objects where name is not null order by bucket_id, name`,
        )
      ).rows;
      o.log(`Copying ${objs.length} file(s) from ${buckets ? `${buckets} new bucket(s)` : 'existing buckets'}…`);
      const base = o.apiUrl!.replace(/\/+$/, '');
      let failed = 0;
      let next = 0;
      const worker = async () => {
        while (next < objs.length) {
          const obj = objs[next++];
          const key = JSON.stringify(`${obj.bucket_id}/${obj.name}`).slice(1, -1);
          try {
            if (!safeStorageKey(obj.bucket_id, obj.name)) throw new Error('skipped: the bucket or file name is not allowed');
            const down = await fetch(`${base}/storage/v1/object/authenticated/${encodePath(obj.bucket_id)}/${encodePath(obj.name)}`, {
              headers: { Authorization: `Bearer ${o.serviceKey}`, apikey: o.serviceKey! },
              // The service_role key must only ever go to the URL given.
              redirect: 'error',
              signal: AbortSignal.timeout(10 * 60_000),
            }).catch((err) => {
              if (/redirect/.test(String(err?.cause?.message))) {
                throw Object.assign(new Error('the project URL answered with a redirect; give the final https:// URL'), { fatal: true });
              }
              throw err;
            });
            if (down.status === 401 || down.status === 403) throw Object.assign(new Error('the service_role key was refused'), { fatal: true });
            if (!down.ok || !down.body) throw new Error(`download failed (${down.status})`);
            const meta = (obj.metadata || {}) as Record<string, any>;
            // Keel's storage refuses a malformed type; fall back to a harmless one instead.
            const type = normalizeContentType(meta.mimetype) ?? normalizeContentType(down.headers.get('content-type')) ?? DEFAULT_CONTENT_TYPE;
            const up = await fetch(`${config.services.storage}/object/${encodePath(obj.bucket_id)}/${encodePath(obj.name)}`, {
              method: 'POST',
              redirect: 'error',
              headers: {
                Authorization: `Bearer ${o.project.serviceKey}`,
                'x-keel-project': o.project.name,
                'x-upsert': 'true',
                'Content-Type': type,
                ...(meta.cacheControl ? { 'Cache-Control': String(meta.cacheControl) } : {}),
              },
              body: down.body,
              duplex: 'half',
              signal: AbortSignal.timeout(10 * 60_000),
            } as RequestInit);
            if (!up.ok) throw new Error(`upload failed (${up.status}): ${(await up.text()).slice(0, 200)}`);
            await dst.query(
              `update storage.objects set owner = $3::uuid, owner_id = $4, user_metadata = coalesce($5, user_metadata),
                      created_at = coalesce($6, created_at), updated_at = coalesce($7, updated_at)
                where bucket_id = $1 and name = $2`,
              [obj.bucket_id, obj.name, obj.owner && /^[0-9a-f-]{36}$/i.test(obj.owner) ? obj.owner : null, obj.owner_id, obj.user_metadata, obj.created_at, obj.updated_at],
            );
            result.files++;
            if (result.files % 25 === 0) o.log(`…${result.files} of ${objs.length} files`);
          } catch (err) {
            if ((err as { fatal?: boolean }).fatal) throw err;
            failed++;
            if (failed <= 20) warn(`${key}: ${(err as Error).message}`);
          }
        }
      };
      await Promise.all(Array.from({ length: 4 }, worker));
      o.log(`Copied ${result.files} file(s)${failed ? `, ${failed} failed` : ''}.`);
      if (failed > 20) warn(`…and ${failed - 20} more files failed.`);
    }
  } finally {
    if (role) await dst.query(`alter role ${quoteIdent(role.name)} nologin password null`).catch(() => {});
    await src.end().catch(() => {});
    await dst.end().catch(() => {});
  }
  // Have PostgREST pick up the new tables.
  const n = newClient(o.project.dbName);
  await n.connect().then(() => n.query(`notify pgrst, 'reload schema'`)).catch(() => {});
  await n.end().catch(() => {});
  o.log(`Done: ${result.tables} tables, ${result.users} users, ${result.files} files${result.warnings ? `, ${result.warnings} warning(s)` : ''}.`);
  return result;
}

export const importJobId = () => crypto.randomBytes(6).toString('hex');

/**
 * The role that restores (and owns) imported objects: may create things in
 * this project's database and use the auth/storage tables the way Supabase's
 * postgres role can, but is not a superuser. It can only log in during an import.
 */
async function prepareImportRole(dst: pg.Client, dbName: string): Promise<{ name: string; password: string }> {
  const name = `keel_import_${dbName}`.slice(0, 63);
  const password = crypto.randomBytes(24).toString('hex');
  const r = quoteIdent(name);
  const exists = (await dst.query('select 1 from pg_roles where rolname = $1', [name])).rowCount;
  await dst.query(
    `${exists ? 'alter' : 'create'} role ${r} login password ${quoteLiteral(password)} nosuperuser nocreatedb nocreaterole noreplication nobypassrls`,
  );
  await dst.query(`grant connect, create, temporary on database ${quoteIdent(dbName)} to ${r}`);
  await dst.query(`grant usage, create on schema public to ${r}`);
  await dst.query(`grant usage on schema extensions, auth, storage to ${r}`);
  await dst.query(`grant select, references, trigger on auth.users to ${r}`);
  await dst.query(`grant select, references on auth.identities to ${r}`);
  await dst.query(`grant select, references on storage.objects, storage.buckets to ${r}`);
  // The project's owner role may change what the import creates.
  const owner = ownerRoleFor(dbName);
  if ((await dst.query('select 1 from pg_roles where rolname = $1', [owner])).rowCount) await dst.query(`grant ${r} to ${quoteIdent(owner)}`);
  return { name, password };
}

/**
 * Runs fn in a transaction as `owner`, one of the (non-superuser) roles that
 * own Keel's platform tables. It logs in as that role, so nothing in source
 * SQL can get back to the superuser, not even `reset role`. If that login
 * fails (a service password Keel can't use here), it falls back to `set local
 * role` on the superuser connection, where runSingle() still keeps source SQL
 * to one statement.
 */
async function asOwner(dst: pg.Client, dbName: string, owner: string, fn: (c: pg.ClientBase) => Promise<void>): Promise<void> {
  if (!PLATFORM_OWNERS.has(owner)) throw new Error(`refusing to act as ${owner}`);
  let own: pg.Client | null = newClient(dbName, owner);
  try {
    await own.connect();
  } catch {
    await own.end().catch(() => {});
    own = null;
  }
  const c = own ?? dst;
  try {
    await c.query('begin');
    if (!own) await c.query(`set local role ${quoteIdent(owner)}`);
    const me = (await c.query('select rolsuper from pg_catalog.pg_roles where rolname = current_user')).rows[0];
    if (me?.rolsuper !== false) throw new Error(`refusing to act as ${owner}`);
    await fn(c);
    await c.query('commit');
  } catch (err) {
    await c.query('rollback').catch(() => {});
    throw err;
  } finally {
    await own?.end().catch(() => {});
  }
}
