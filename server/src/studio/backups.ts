import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { config, deriveSecret } from '../lib/config.js';
import { newClient } from '../lib/db.js';
import { sign, verify } from '../lib/jwt.js';
import { log } from '../lib/log.js';
import { effectiveSchedule, loadSettings, markInterrupted, passphraseSet, startFullBackup } from './fullbackups.js';

export type Backup = {
  id: string;
  project: string;
  file: string;
  size_bytes: string;
  kind: string;
  status: string;
  error: string | null;
  created_at: string;
};

const running = new Set<string>();

// ------------------------------------------------------------------ download links
// Browsers can't send a header when they download a file, so Studio hands
// out a link instead. It's signed with its own key, lives for a minute and
// names the Studio session that asked for it: it stops working when that
// session ends.
export const DOWNLOAD_LINK_TTL_S = 60;
const downloadKey = () => deriveSecret(config.secret, 'backup-download');

export function downloadToken(file: string, sid: string, now = Date.now()): string {
  const iat = Math.floor(now / 1000);
  return sign({ kind: 'backup-download', file, sid, iat, exp: iat + DOWNLOAD_LINK_TTL_S }, downloadKey());
}

/** The file and session a download link was made for. Throws when it's invalid or expired. */
export function readDownloadToken(token: string, now = Date.now()): { file: string; sid: string } {
  const claims = verify(token, downloadKey(), now);
  if (claims.kind !== 'backup-download' || typeof claims.exp !== 'number') throw new Error('not a download link');
  if (typeof claims.file !== 'string' || typeof claims.sid !== 'string' || !claims.sid) throw new Error('not a download link');
  return { file: claims.file, sid: claims.sid };
}

function stamp(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function run(cmd: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      env: { ...process.env, PGPASSWORD: config.db.password, PGHOST: config.db.host, PGPORT: String(config.db.port), PGUSER: config.db.superuser },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (d) => (stderr += d.toString()));
    child.on('error', reject);
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(stderr.trim().split('\n').slice(-3).join(' ') || `${cmd} exited with ${code}`))));
  });
}

async function control<T>(fn: (c: ReturnType<typeof newClient>) => Promise<T>): Promise<T> {
  const c = newClient(config.db.controlDb);
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end();
  }
}

export function backupPath(file: string): string {
  const full = path.resolve(config.backups.dir, file);
  if (!full.startsWith(path.resolve(config.backups.dir) + path.sep)) throw new Error('invalid backup path');
  return full;
}

/** Runs pg_dump (custom format) for one project. */
export async function backupProject(project: string, dbName: string, kind: 'manual' | 'scheduled' | 'before-defaults'): Promise<Backup> {
  if (running.has(project)) throw Object.assign(new Error('A backup of this project is already running'), { status: 409 });
  running.add(project);
  const rel = `${project}/${project}-${stamp()}.dump`;
  const file = backupPath(rel);
  try {
    await fs.mkdir(path.dirname(file), { recursive: true });
    const started = Date.now();
    let status = 'ok';
    let error: string | null = null;
    try {
      // Saved defaults stay out of backups, so restoring a backup keeps them.
      await run('pg_dump', ['--format=custom', '--compress=6', '--exclude-schema=_keel_defaults', '--file', file, '--dbname', dbName]);
    } catch (err) {
      status = 'failed';
      error = (err as Error).message;
      await fs.rm(file, { force: true });
    }
    const size = status === 'ok' ? (await fs.stat(file)).size : 0;
    const row = await control(async (c) =>
      (
        await c.query(
          `insert into keel.backups (project, file, size_bytes, kind, status, error) values ($1, $2, $3, $4, $5, $6) returning *`,
          [project, rel, size, kind, status, error],
        )
      ).rows[0] as Backup,
    );
    if (status === 'ok') log.info('backup complete', { project, file: rel, bytes: size, ms: Date.now() - started });
    else log.error('backup failed', { project, error });
    if (status !== 'ok') throw Object.assign(new Error(`Backup failed: ${error}`), { status: 500 });
    return row;
  } finally {
    running.delete(project);
  }
}

export function isRunning(project: string): boolean {
  return running.has(project);
}

export async function listBackups(project: string): Promise<Backup[]> {
  return control(async (c) => (await c.query('select * from keel.backups where project = $1 order by created_at desc limit 100', [project])).rows);
}

export async function getBackup(project: string, id: string): Promise<Backup> {
  const rows = await control(async (c) => (await c.query('select * from keel.backups where project = $1 and id = $2', [project, id])).rows);
  if (!rows[0]) throw Object.assign(new Error('Backup not found'), { status: 404 });
  return rows[0];
}

export async function deleteBackup(project: string, id: string): Promise<void> {
  const b = await getBackup(project, id);
  await fs.rm(backupPath(b.file), { force: true });
  await control((c) => c.query('delete from keel.backups where id = $1', [id]));
}

/** Restores a dump over the project database (drops and recreates its objects). */
export async function restoreBackup(project: string, dbName: string, id: string): Promise<void> {
  const b = await getBackup(project, id);
  if (b.status !== 'ok') throw Object.assign(new Error('Only successful backups can be restored'), { status: 400 });
  await run('pg_restore', ['--clean', '--if-exists', '--single-transaction', '--exit-on-error', '--dbname', dbName, backupPath(b.file)]);
  // A backup from before owner roles has public owned by the superuser: hand it back to the project's owner role.
  const c = newClient(dbName);
  try {
    await c.connect();
    const { rows } = await c.query(`select to_regprocedure('_keel.adopt_public()') is not null as ok`);
    if (rows[0].ok) await c.query('select _keel.adopt_public()');
  } catch (err) {
    log.warn('could not give restored objects to the project owner role', { project, error: (err as Error).message });
  } finally {
    await c.end().catch(() => {});
  }
  log.info('backup restored', { project, file: b.file });
}

async function prune(project: string) {
  const old = await control(
    async (c) =>
      (
        await c.query(
          `select id, file from keel.backups where project = $1 and kind = 'scheduled' order by created_at desc offset $2`,
          [project, config.backups.retention],
        )
      ).rows as { id: string; file: string }[],
  );
  for (const b of old) {
    await fs.rm(backupPath(b.file), { force: true }).catch(() => {});
    await control((c) => c.query('delete from keel.backups where id = $1', [b.id]));
  }
}

/** Milliseconds until the next HH:MM, or null when the schedule is off. */
export function msUntil(schedule: string, now = new Date()): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(schedule);
  if (!m) return null;
  const at = new Date(now);
  at.setHours(Number(m[1]), Number(m[2]), 0, 0);
  if (at <= now) at.setDate(at.getDate() + 1);
  return at.getTime() - now.getTime();
}

let listProjects: () => { name: string; dbName: string }[] = () => [];
let timer: NodeJS.Timeout | null = null;

/** The nightly run: a dump of every project, then a full backup when a passphrase is set. */
async function nightly(): Promise<void> {
  for (const p of listProjects()) {
    try {
      await backupProject(p.name, p.dbName, 'scheduled');
      await prune(p.name);
    } catch (err) {
      log.error('scheduled backup failed', { project: p.name, error: (err as Error).message });
    }
  }
  if (!passphraseSet()) {
    log.warn('full backups are off: set KEEL_BACKUP_PASSPHRASE to back up every database and the uploaded files, encrypted');
    return;
  }
  try {
    await (await startFullBackup('scheduled')).done;
  } catch (err) {
    log.error('scheduled full backup failed', { error: (err as Error).message });
  }
}

/** (Re)arms the nightly timer from the current settings; returns the schedule in force. */
export async function reschedule(): Promise<string> {
  if (timer) clearTimeout(timer);
  timer = null;
  const schedule = effectiveSchedule(
    await loadSettings().catch((err) => {
      log.warn('could not read the backup settings', { error: (err as Error).message });
      return null;
    }),
  );
  const wait = msUntil(schedule);
  if (wait === null) {
    log.info('scheduled backups are off', { schedule });
    return schedule;
  }
  timer = setTimeout(() => void nightly().finally(() => void reschedule()), wait);
  return schedule;
}

/** Nightly backups of every project (and full backups) at the scheduled time. */
export async function startSchedule(list: () => { name: string; dbName: string }[]): Promise<void> {
  listProjects = list;
  await markInterrupted().catch((err) => log.warn('could not tidy up interrupted full backups', { error: (err as Error).message }));
  const at = await reschedule();
  if (at !== 'off') log.info('scheduled backups enabled', { at, retention: config.backups.retention, full: passphraseSet() ? 'on' : 'off (no KEEL_BACKUP_PASSPHRASE)' });
}
