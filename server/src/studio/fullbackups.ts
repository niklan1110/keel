import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { checkPassphrase } from '../lib/age.js';
import { writeBackupSet } from '../lib/backupset.js';
import { DEFAULT_SETTINGS, cleanPrefix, openSecret, resolveTarget, sealSecret, type BackupSettings, type ResolvedTarget, type StoredTarget } from '../lib/backup-target.js';
import { config } from '../lib/config.js';
import { newClient } from '../lib/db.js';
import { log } from '../lib/log.js';
import { S3Error, s3ConfigProblem, type S3Object } from '../lib/s3.js';
import { backupsToKeep, setName, setTime } from './retention.js';

/**
 * Full backups (see lib/backupset.ts): made after the nightly project dumps
 * or on demand, kept in backups/full (the newest KEEL_BACKUP_KEEP_LOCAL), and
 * copied to the off-machine target, where the daily/weekly retention applies.
 */

export type BackupSet = {
  id: string;
  file: string;
  size_bytes: string;
  kind: string;
  status: string;
  error: string | null;
  remote: string;
  remote_error: string | null;
  created_at: string;
  finished_at: string | null;
};

export const fullDir = () => path.join(config.backups.dir, 'full');
let running: Promise<void> | null = null;

async function control<T>(fn: (c: ReturnType<typeof newClient>) => Promise<T>): Promise<T> {
  const c = newClient(config.db.controlDb);
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end();
  }
}

// ------------------------------------------------------------------ settings
export async function loadSettings(): Promise<BackupSettings> {
  const row = await control(async (c) => (await c.query('select settings from keel.backup_settings where id')).rows[0]);
  return { ...DEFAULT_SETTINGS, ...(row?.settings ?? {}) };
}

const SCHEDULE_RE = /^(off|([01]?\d|2[0-3]):[0-5]\d)$/;
const count = (v: unknown, name: string, max: number) => {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0 || n > max) throw Object.assign(new Error(`${name} must be a whole number from 0 to ${max}.`), { status: 400 });
  return n;
};

export type TargetInput = { endpoint?: string; region?: string; bucket?: string; prefix?: string; accessKeyId?: string; secretAccessKey?: string; pathStyle?: boolean };

/**
 * A target from Studio's form, checked. A blank secret key means "keep the
 * saved one" (Studio never sends it back to the browser).
 */
export function targetFromInput(t: TargetInput, saved: StoredTarget | null): { target: Omit<StoredTarget, 'secretSealed'>; secret: string; sealed: string } {
  const bad = (err: unknown) => Object.assign(err as Error, { status: 400 });
  let prefix: string;
  try {
    prefix = cleanPrefix(t.prefix);
  } catch (err) {
    throw bad(err);
  }
  const target = {
    endpoint: String(t.endpoint ?? '')
      .trim()
      .replace(/\/+$/, ''),
    region: String(t.region ?? '').trim() || 'us-east-1',
    bucket: String(t.bucket ?? '').trim(),
    prefix,
    accessKeyId: String(t.accessKeyId ?? '').trim(),
    pathStyle: t.pathStyle !== false,
  };
  let secret = String(t.secretAccessKey ?? '');
  let sealed = '';
  if (!secret && saved?.secretSealed) {
    sealed = saved.secretSealed;
    try {
      secret = openSecret(sealed);
    } catch (err) {
      throw bad(err);
    }
  }
  const problem = s3ConfigProblem({ ...target, secretAccessKey: secret });
  if (problem) throw bad(new Error(problem));
  return { target, secret, sealed: sealed || sealSecret(secret) };
}

export async function saveSettings(body: { schedule?: unknown; keepDaily?: unknown; keepWeekly?: unknown; target?: TargetInput | null }): Promise<BackupSettings> {
  const cur = await loadSettings();
  const next: BackupSettings = { ...cur };
  // null: back to KEEL_BACKUP_SCHEDULE.
  if (body.schedule === null) delete next.schedule;
  else if (body.schedule !== undefined) {
    const s = String(body.schedule).trim().toLowerCase();
    if (!SCHEDULE_RE.test(s)) throw Object.assign(new Error('The time must look like 03:00 (24-hour clock), or be off.'), { status: 400 });
    next.schedule = s === 'off' ? 'off' : s.padStart(5, '0');
  }
  if (body.keepDaily !== undefined) next.keepDaily = count(body.keepDaily, 'Daily backups to keep', 365);
  if (body.keepWeekly !== undefined) next.keepWeekly = count(body.keepWeekly, 'Weekly backups to keep', 520);
  if (body.target === null) next.target = null;
  else if (body.target) {
    const t = targetFromInput(body.target, cur.target);
    next.target = { ...t.target, secretSealed: t.sealed };
  }
  await control((c) =>
    c.query(
      `insert into keel.backup_settings (id, settings) values (true, $1)
       on conflict (id) do update set settings = excluded.settings, updated_at = now()`,
      [JSON.stringify(next)],
    ),
  );
  log.info('backup settings changed in Studio', { schedule: next.schedule ?? config.backups.schedule, target: next.target ? 's3' : 'none' });
  return next;
}

/** The time of day backups run (HH:MM) or "off": Studio's setting, else KEEL_BACKUP_SCHEDULE. */
export function effectiveSchedule(s: BackupSettings | null): string {
  return s?.schedule ?? config.backups.schedule;
}

/** Checks a target can be listed and written to, with a small test object it removes again. */
export async function testTarget(t: ResolvedTarget): Promise<{ canDelete: boolean }> {
  await t.s3.list(`${t.prefix}keel-`);
  const key = `${t.prefix}.keel-connection-test-${crypto.randomBytes(4).toString('hex')}`;
  await t.s3.put(key, Buffer.from('Keel checks it can write here. This file is removed right away.\n'));
  // A key without delete rights passes (it's the safer kind); old backups then stay in the bucket.
  try {
    await t.s3.delete(key);
    return { canDelete: true };
  } catch (err) {
    if (err instanceof S3Error && (err.status === 403 || err.code === 'AccessDenied')) return { canDelete: false };
    throw err;
  }
}

// ------------------------------------------------------------------ runs
export const passphraseSet = () => {
  try {
    checkPassphrase(config.backups.passphrase);
    return true;
  } catch {
    return false;
  }
};

export function fullBackupRunning(): boolean {
  return running !== null;
}

/** Recent full backups, and whether each is still on this machine. */
export async function listSets(): Promise<(BackupSet & { local: boolean })[]> {
  const rows: BackupSet[] = await control(async (c) => (await c.query('select * from keel.backup_sets order by created_at desc limit 100')).rows);
  const here = new Set(await fs.readdir(fullDir()).catch(() => [] as string[]));
  return rows.map((r) => ({ ...r, local: r.status === 'ok' && here.has(r.file) }));
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function getSet(id: string): Promise<BackupSet> {
  // Not a backup id at all: not found, rather than a database error.
  if (!UUID_RE.test(id)) throw Object.assign(new Error('Backup not found'), { status: 404 });
  const rows = await control(async (c) => (await c.query('select * from keel.backup_sets where id = $1', [id])).rows);
  if (!rows[0]) throw Object.assign(new Error('Backup not found'), { status: 404 });
  // The row may come from a restored database or the SQL editor: its file is only ever a set name in backups/full.
  if (!setTime(rows[0].file)) throw Object.assign(new Error('This backup record names an unexpected file'), { status: 400 });
  return rows[0];
}

export async function setFile(id: string): Promise<string> {
  const s = await getSet(id);
  if (s.status !== 'ok') throw Object.assign(new Error('This backup did not finish'), { status: 400 });
  return `full/${s.file}`;
}

export async function deleteSet(id: string): Promise<void> {
  const s = await getSet(id);
  if (s.status === 'running') throw Object.assign(new Error('This backup is still running'), { status: 409 });
  await fs.rm(path.join(fullDir(), s.file), { force: true });
  await control((c) => c.query('delete from keel.backup_sets where id = $1', [id]));
}

/** Rows left "running" by a Studio that stopped mid-backup. */
export async function markInterrupted(): Promise<void> {
  await control((c) => c.query(`update keel.backup_sets set status = 'failed', error = 'Studio stopped during the backup', finished_at = now() where status = 'running'`));
  const dir = fullDir();
  for (const name of await fs.readdir(dir).catch(() => [] as string[])) {
    if (name.startsWith('.work-') || name.endsWith('.partial')) await fs.rm(path.join(dir, name), { recursive: true, force: true });
  }
}

async function pruneLocal(): Promise<void> {
  const names = (await fs.readdir(fullDir()).catch(() => [] as string[])).filter((n) => setTime(n));
  names.sort((a, b) => setTime(b)!.getTime() - setTime(a)!.getTime());
  for (const name of names.slice(Math.max(1, config.backups.keepLocal))) await fs.rm(path.join(fullDir(), name), { force: true });
}

/** Full backups in the target, newest first. */
export async function listRemote(t: ResolvedTarget): Promise<(S3Object & { name: string })[]> {
  const objects = await t.s3.list(`${t.prefix}keel-`);
  return objects
    // Keys come from the storage's answer: only those under the prefix count.
    .filter((o) => o.key.startsWith(t.prefix))
    .map((o) => ({ ...o, name: o.key.slice(t.prefix.length) }))
    .filter((o) => !o.name.includes('/') && setTime(o.name))
    .sort((a, b) => setTime(b.name)!.getTime() - setTime(a.name)!.getTime());
}

async function pruneRemote(t: ResolvedTarget, s: BackupSettings): Promise<number> {
  const list = await listRemote(t);
  const keep = backupsToKeep(
    list.map((o) => o.name),
    s.keepDaily,
    s.keepWeekly,
  );
  let removed = 0;
  for (const o of list) {
    if (keep.has(o.name)) continue;
    await t.s3.delete(o.key);
    removed++;
  }
  return removed;
}

async function run(id: string, name: string): Promise<void> {
  const started = Date.now();
  const file = path.join(fullDir(), name);
  try {
    const m = await writeBackupSet(file, checkPassphrase(config.backups.passphrase));
    const size = (await fs.stat(file)).size;
    await control((c) => c.query(`update keel.backup_sets set status = 'ok', size_bytes = $2, finished_at = now() where id = $1`, [id, size]));
    log.info('full backup complete', { file: name, bytes: size, databases: m.databases.length, files: m.storage.files, ms: Date.now() - started });
  } catch (err) {
    const error = (err as Error).message;
    await control((c) => c.query(`update keel.backup_sets set status = 'failed', error = $2, finished_at = now() where id = $1`, [id, error]));
    log.error('full backup failed', { error });
    return;
  }

  // Off the machine, then retention there.
  let settings: BackupSettings | null = null;
  let target: ResolvedTarget | null = null;
  try {
    settings = await loadSettings();
    target = resolveTarget(settings);
  } catch (err) {
    await control((c) => c.query(`update keel.backup_sets set remote = 'failed', remote_error = $2 where id = $1`, [id, (err as Error).message]));
    log.error('full backup not uploaded', { error: (err as Error).message });
  }
  if (target && settings) {
    try {
      await control((c) => c.query(`update keel.backup_sets set remote = 'uploading' where id = $1`, [id]));
      const t0 = Date.now();
      await target.s3.uploadFile(`${target.prefix}${name}`, file);
      await control((c) => c.query(`update keel.backup_sets set remote = 'uploaded', remote_error = null where id = $1`, [id]));
      log.info('full backup uploaded', { file: name, to: target.describe, ms: Date.now() - t0 });
      // A key without delete rights (or Object Lock) keeps old backups: the upload still counts.
      await pruneRemote(target, settings).then(
        (removed) => void (removed && log.info('old backups removed from the backup target', { removed })),
        (err) => log.warn('could not remove old backups from the backup target', { error: (err as Error).message }),
      );
    } catch (err) {
      await control((c) => c.query(`update keel.backup_sets set remote = 'failed', remote_error = $2 where id = $1`, [id, (err as Error).message]));
      log.error('full backup upload failed', { file: name, error: (err as Error).message });
    }
  }
  await pruneLocal().catch((err) => log.warn('could not remove old full backups', { error: (err as Error).message }));
}

/** Starts a full backup and returns its row; it runs in the background. */
export async function startFullBackup(kind: 'manual' | 'scheduled'): Promise<{ row: BackupSet; done: Promise<void> }> {
  if (running) throw Object.assign(new Error('A full backup is already running'), { status: 409 });
  try {
    checkPassphrase(config.backups.passphrase);
  } catch (err) {
    throw Object.assign(err as Error, { status: 400 });
  }
  let release!: () => void;
  running = new Promise<void>((r) => (release = r));
  try {
    await fs.mkdir(fullDir(), { recursive: true, mode: 0o700 });
    const name = setName();
    const row = await control(async (c) => (await c.query(`insert into keel.backup_sets (file, kind) values ($1, $2) returning *`, [name, kind])).rows[0] as BackupSet);
    const done = run(row.id, name)
      .catch((err) => log.error('full backup failed', { error: (err as Error).message }))
      .finally(() => {
        running = null;
        release();
      });
    return { row, done };
  } catch (err) {
    running = null;
    release();
    throw err;
  }
}
