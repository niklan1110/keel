import { spawn } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { Readable, type Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { decryptStream, encryptStream } from './age.js';
import { config } from './config.js';
import { newClient, quoteIdent } from './db.js';
import { log } from './log.js';
import { imageLevel, type SchemaLevel } from './schema-guard.js';
import { readTar, tarStream, type TarEntry, type TarSource } from './tar.js';

/**
 * A full backup ("backup set") is one file, keel-<time>.tar.age: an age
 * encrypted tar archive holding
 *
 *   manifest.json        what is inside, from which Keel version
 *   db/<database>.dump   pg_dump (custom format) of the control database
 *                        (keel: projects, keys, settings, Studio accounts,
 *                        functions) and of every project database
 *   storage/...          every uploaded file, as stored on disk
 *
 * The databases are dumped first and the files copied after, so every file
 * a restored database refers to is in the set (files uploaded during the
 * backup may be there without a database record, which is harmless).
 */

export const MANIFEST = 'manifest.json';
export const FORMAT = 'keel-backup';
export const FORMAT_VERSION = 1;

export type Manifest = {
  format: typeof FORMAT;
  formatVersion: number;
  keelVersion: string;
  createdAt: string;
  /** The name the set was written as (keel-<time>.tar.age), to spot a renamed file. */
  file?: string;
  schema: SchemaLevel;
  /** The control database first, then every project. */
  databases: { name: string; project: string | null; file: string; bytes: number }[];
  /** Roles the databases refer to that Keel doesn't create itself (project owners, imports, your own). */
  roles: { name: string; login: boolean }[];
  memberships: { role: string; member: string }[];
  storage: { files: number; bytes: number };
};

/** Roles every Keel install creates on its own; a restore never touches them. */
const BUILT_IN_ROLES = new Set(['anon', 'authenticated', 'service_role', 'authenticator', 'keel_auth_admin', 'keel_storage_admin', 'keel_realtime_admin', 'keel_functions_admin', 'keel_project_owners']);

const dbEnv = () => ({ ...process.env, PGPASSWORD: config.db.password, PGHOST: config.db.host, PGPORT: String(config.db.port), PGUSER: config.db.superuser });

/** Runs a Postgres tool. Its standard input is `input`, if given. */
export function runPg(cmd: string, args: string[], input?: Readable): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { env: dbEnv(), stdio: [input ? 'pipe' : 'ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr!.on('data', (d) => (stderr = (stderr + d.toString()).slice(-4000)));
    child.on('error', reject);
    if (input) {
      input.on('error', (err) => {
        child.kill();
        reject(err);
      });
      (child.stdin as Writable).on('error', () => {}); // the exit code tells what went wrong
      input.pipe(child.stdin as Writable);
    }
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(stderr.trim().split('\n').slice(-3).join(' ') || `${cmd} exited with ${code}`))));
  });
}

async function query<T = Record<string, unknown>>(database: string, sql: string, params: unknown[] = []): Promise<T[]> {
  const c = newClient(database);
  await c.connect();
  try {
    return (await c.query(sql, params)).rows as T[];
  } finally {
    await c.end();
  }
}

type StorageFile = { rel: string; size: number; mtime: Date; mode: number };

/** Every uploaded file under the storage folder, except unfinished uploads. */
async function storageFiles(root: string): Promise<StorageFile[]> {
  const out: StorageFile[] = [];
  const walk = async (dir: string, rel: string): Promise<void> => {
    let entries: fs.Dirent[];
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw err;
    }
    for (const e of entries) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (e.name === '.uploads') continue;
        await walk(path.join(dir, e.name), r);
      } else if (e.isFile()) {
        const st = await fsp.stat(path.join(dir, e.name)).catch(() => null);
        if (st) out.push({ rel: r, size: st.size, mtime: st.mtime, mode: st.mode & 0o777 });
      }
    }
  };
  await walk(root, '');
  return out;
}

/** A file's bytes, at most `size` of them (a file that grows isn't read past that). */
async function* fileBytes(file: string, size: number): AsyncGenerator<Buffer> {
  let fh: fsp.FileHandle;
  try {
    fh = await fsp.open(file, 'r');
  } catch (err) {
    // Deleted since the listing: the archive gets zeros; the restored database won't refer to it.
    log.warn('a file disappeared during the backup', { file: path.basename(file), error: (err as Error).message });
    return;
  }
  try {
    for await (const chunk of fh.createReadStream({ start: 0, end: Math.max(0, size - 1), autoClose: false })) {
      if (size === 0) break;
      yield chunk as Buffer;
    }
  } finally {
    await fh.close();
  }
}

/**
 * Writes a full backup to `outFile`, encrypted with the passphrase. Plain
 * dumps go to a folder next to it while the backup runs, and are removed.
 */
export async function writeBackupSet(outFile: string, passphrase: string): Promise<Manifest> {
  const work = await fsp.mkdtemp(path.join(path.dirname(outFile), '.work-'));
  await fsp.chmod(work, 0o700);
  try {
    const projects = await query<{ name: string; db_name: string }>(config.db.controlDb, 'select name, db_name from keel.projects order by created_at');
    const databases: Manifest['databases'] = [];
    for (const db of [{ name: config.db.controlDb, project: null as string | null }, ...projects.map((p) => ({ name: p.db_name, project: p.name }))]) {
      const file = path.join(work, `${db.name}.dump`);
      const args = ['--format=custom', '--compress=6', '--file', file, '--dbname', db.name];
      // Signed-in Studio sessions don't belong in a backup.
      if (db.project === null) args.push('--exclude-table-data=keel.studio_sessions');
      await runPg('pg_dump', args);
      databases.push({ name: db.name, project: db.project, file: `db/${db.name}.dump`, bytes: (await fsp.stat(file)).size });
    }

    const roleRows = await query<{ rolname: string; rolcanlogin: boolean }>(
      'postgres',
      `select rolname, rolcanlogin from pg_roles where rolname !~ '^pg_' and not rolsuper order by rolname`,
    );
    const roles = roleRows.filter((r) => !BUILT_IN_ROLES.has(r.rolname)).map((r) => ({ name: r.rolname, login: r.rolcanlogin }));
    const names = new Set(roles.map((r) => r.name));
    const memberships = (
      await query<{ role: string; member: string }>(
        'postgres',
        `select g.rolname as role, m.rolname as member from pg_auth_members a
           join pg_roles g on g.oid = a.roleid join pg_roles m on m.oid = a.member
          where g.rolname !~ '^pg_' and m.rolname !~ '^pg_' order by 1, 2`,
      )
    ).filter((x) => names.has(x.member));

    const files = await storageFiles(config.storage.root);
    // An older compose file doesn't give Studio the storage folder: don't pass off a backup without the files as complete.
    if (!files.length) {
      for (const p of projects) {
        const has = await query<{ any: boolean }>(p.db_name, `select exists (select 1 from storage.objects) as any`).catch(() => [{ any: false }]);
        if (has[0]?.any) {
          throw new Error(`Studio can't see the uploaded files (project ${p.name} has some): update the compose file so keel-studio mounts the storage folder.`);
        }
      }
    }
    const manifest: Manifest = {
      format: FORMAT,
      formatVersion: FORMAT_VERSION,
      keelVersion: config.version,
      createdAt: new Date().toISOString(),
      file: path.basename(outFile),
      schema: await imageLevel(),
      databases,
      roles,
      memberships,
      storage: { files: files.length, bytes: files.reduce((n, f) => n + f.size, 0) },
    };
    const manifestBytes = Buffer.from(JSON.stringify(manifest, null, 2));

    function* entries(): Generator<TarSource> {
      yield { name: MANIFEST, size: manifestBytes.length, body: () => [manifestBytes] };
      for (const d of databases) {
        const file = path.join(work, `${d.name}.dump`);
        yield { name: d.file, size: d.bytes, body: () => fileBytes(file, d.bytes) };
      }
      for (const f of files) {
        yield { name: `storage/${f.rel}`, size: f.size, mtime: f.mtime, mode: f.mode, body: () => fileBytes(path.join(config.storage.root, f.rel), f.size) };
      }
    }

    const tmp = `${outFile}.partial`;
    try {
      await pipeline(Readable.from(tarStream(entries())), encryptStream(passphrase), fs.createWriteStream(tmp, { mode: 0o600 }));
      await fsp.rename(tmp, outFile);
    } catch (err) {
      await fsp.rm(tmp, { force: true });
      throw err;
    }
    return manifest;
  } finally {
    await fsp.rm(work, { recursive: true, force: true });
  }
}

/** The entries of a backup set; the first one is checked to be its manifest. */
export async function* readBackupSet(src: Readable, passphrase: string): AsyncGenerator<TarEntry & { manifest?: Manifest }> {
  const plain = src.pipe(decryptStream(passphrase));
  src.on('error', (err) => plain.destroy(err));
  let first = true;
  for await (const e of readTar(plain)) {
    if (first) {
      first = false;
      if (e.name !== MANIFEST || e.size > 10 * 1024 * 1024) throw new Error('This is not a Keel backup (no manifest).');
      const parts: Buffer[] = [];
      for await (const b of e.body) parts.push(b);
      const manifest = JSON.parse(Buffer.concat(parts).toString('utf8')) as Manifest;
      if (manifest.format !== FORMAT) throw new Error('This is not a Keel backup.');
      if (manifest.formatVersion > FORMAT_VERSION) throw new Error(`This backup was made by a newer Keel (${manifest.keelVersion}). Update Keel first.`);
      yield { ...e, manifest };
      continue;
    }
    yield e;
  }
  if (first) throw new Error('This is not a Keel backup (empty).');
}

/** Reads the whole set without changing anything: right passphrase, nothing damaged or missing. */
export async function verifyBackupSet(open: () => Readable, passphrase: string): Promise<Manifest> {
  let manifest: Manifest | undefined;
  const seen = new Set<string>();
  for await (const e of readBackupSet(open(), passphrase)) {
    if (e.manifest) manifest = e.manifest;
    else {
      seen.add(e.name);
      for await (const _ of e.body);
    }
  }
  for (const d of manifest!.databases) if (!seen.has(d.file)) throw new Error(`The backup is missing ${d.file}.`);
  return manifest!;
}

/** Why this Keel can't restore the set, or null. */
export function restoreProblem(m: Manifest, image: SchemaLevel): string | null {
  if (m.schema.migration > image.migration || m.schema.control > image.control) {
    return `This backup was made by Keel ${m.keelVersion}, which is newer than this Keel (${config.version}). Update Keel first (./keel update), then restore.`;
  }
  if (!m.databases.some((d) => d.name === config.db.controlDb)) return "This backup doesn't contain Keel's control database.";
  // Each database is dropped and recreated by name: never Postgres' own.
  const bad = m.databases.find((d) => typeof d.name !== 'string' || SYSTEM_DATABASES.has(d.name) || d.file !== `db/${d.name}.dump`);
  if (bad) return `This backup lists a database Keel won't restore (${String(bad.name).slice(0, 64)}).`;
  return null;
}

const SYSTEM_DATABASES = new Set(['postgres', 'template0', 'template1']);

/**
 * The role memberships of a backup that a restore puts back: only for roles
 * the backup itself lists (not Keel's built-in ones), and never membership
 * of a superuser or a pg_ role, which would hand out more than a role had.
 */
export function restorableMemberships(m: Manifest, superusers: Set<string>): Manifest['memberships'] {
  const listed = new Set(m.roles.map((r) => r.name).filter((n) => !BUILT_IN_ROLES.has(n) && !n.startsWith('pg_')));
  return m.memberships.filter((x) => listed.has(x.member) && !x.role.startsWith('pg_') && !superusers.has(x.role));
}

/** A storage path from the archive, as a path inside the storage folder (or null when it would leave it). */
export function storageTarget(name: string, root = config.storage.root): string | null {
  if (!name.startsWith('storage/')) return null;
  const rel = name.slice('storage/'.length);
  if (!rel || rel.includes('\0') || rel.split('/').some((p) => p === '..' || p === '')) return null;
  const full = path.resolve(root, rel);
  return full.startsWith(path.resolve(root) + path.sep) ? full : null;
}

async function emptyFolder(dir: string): Promise<void> {
  for (const name of await fsp.readdir(dir).catch(() => [] as string[])) await fsp.rm(path.join(dir, name), { recursive: true, force: true });
}

/**
 * Replaces this install's databases and uploaded files with the backup set.
 * Keel's services must be stopped (keel-db running). Call verifyBackupSet
 * first: this reads the set once more and changes things as it goes.
 */
export async function restoreBackupSet(open: () => Readable, passphrase: string, say: (msg: string) => void = () => {}): Promise<Manifest> {
  let manifest: Manifest | null = null;
  let current: string[] = [];
  let storageCleared = false;
  const restored = new Set<string>();
  const clearStorage = async () => {
    if (storageCleared) return;
    storageCleared = true;
    say('Replacing uploaded files ...');
    await fsp.mkdir(config.storage.root, { recursive: true });
    await emptyFolder(config.storage.root);
  };

  for await (const e of readBackupSet(open(), passphrase)) {
    if (e.manifest) {
      manifest = e.manifest;
      const problem = restoreProblem(manifest, await imageLevel());
      if (problem) throw new Error(problem);
      // The projects of the install being replaced, so none are left behind.
      const hasControl = (await query('postgres', 'select 1 from pg_database where datname = $1', [config.db.controlDb])).length > 0;
      if (hasControl) {
        current = (await query<{ db_name: string }>(config.db.controlDb, `select db_name from keel.projects`).catch(() => [])).map((r) => r.db_name);
      }
      const roleRows = await query<{ rolname: string; rolsuper: boolean }>('postgres', 'select rolname, rolsuper from pg_roles');
      const existing = new Set(roleRows.map((r) => r.rolname));
      const superusers = new Set(roleRows.filter((r) => r.rolsuper).map((r) => r.rolname));
      const c = newClient('postgres');
      await c.connect();
      try {
        // Without a login: project owners get theirs back when Keel starts; your own roles need a new password.
        for (const r of manifest.roles) if (!existing.has(r.name) && !BUILT_IN_ROLES.has(r.name) && !r.name.startsWith('pg_')) await c.query(`create role ${quoteIdent(r.name)} nologin`);
        for (const m of restorableMemberships(manifest, superusers)) {
          await c.query(`grant ${quoteIdent(m.role)} to ${quoteIdent(m.member)}`).catch((err) => log.warn('could not restore a role membership', { role: m.role, member: m.member, error: (err as Error).message }));
        }
      } finally {
        await c.end();
      }
      continue;
    }
    if (!manifest) throw new Error('This is not a Keel backup.');
    const db = manifest.databases.find((d) => d.file === e.name);
    if (db) {
      say(`Restoring database ${db.name}${db.project ? ` (project ${db.project})` : ''} ...`);
      await query('postgres', `drop database if exists ${quoteIdent(db.name)} with (force)`);
      await runPg('pg_restore', ['--create', '--exit-on-error', '--dbname', 'postgres'], Readable.from(e.body));
      restored.add(db.name);
      continue;
    }
    const target = storageTarget(e.name);
    if (target && (e.type === '0' || e.type === '\0')) {
      await clearStorage();
      await fsp.mkdir(path.dirname(target), { recursive: true });
      await pipeline(Readable.from(e.body), fs.createWriteStream(target, { mode: (e.mode & 0o755) || 0o644 }));
    } else if (!target) {
      log.warn('skipped an unexpected entry in the backup', { entry: e.name.slice(0, 200) });
    }
  }
  if (!manifest) throw new Error('This is not a Keel backup.');
  await clearStorage();

  for (const name of current) {
    if (restored.has(name)) continue;
    say(`Removing database ${name} (a project that isn't in the backup) ...`);
    await query('postgres', `drop database if exists ${quoteIdent(name)} with (force)`);
  }
  // Records of backups that aren't on this machine, and backups that were running.
  const k = newClient(config.db.controlDb);
  await k.connect();
  try {
    const rows = (await k.query('select id, file from keel.backups')).rows as { id: string; file: string }[];
    for (const r of rows) {
      const exists = await fsp.stat(path.join(config.backups.dir, r.file)).catch(() => null);
      if (!exists) await k.query('delete from keel.backups where id = $1', [r.id]);
    }
    if ((await k.query(`select to_regclass('keel.backup_sets') as t`)).rows[0].t) {
      await k.query(`update keel.backup_sets set status = 'failed', error = 'Stopped by a restore', finished_at = now() where status = 'running'`);
    }
  } finally {
    await k.end();
  }
  return manifest;
}
