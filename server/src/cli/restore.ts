import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { DecryptError, checkPassphrase } from '../lib/age.js';
import { restoreBackupSet, verifyBackupSet, type Manifest } from '../lib/backupset.js';
import { resolveTarget, type BackupSettings, type ResolvedTarget } from '../lib/backup-target.js';
import { config } from '../lib/config.js';
import { newClient, waitForDb } from '../lib/db.js';
import { fullDir, listRemote } from '../studio/fullbackups.js';
import { setTime } from '../studio/retention.js';

/**
 * keel restore --list | keel restore <backup>
 *
 * Run by ./keel restore, with Keel's other services stopped. <backup> is a
 * file (mounted into the container by ./keel), the name of a full backup in
 * backups/full, or the name of one in the off-machine target, which is
 * downloaded into backups/full first. The whole file is decrypted and checked
 * before anything is changed.
 */

const say = (msg: string) => process.stdout.write(`${msg}\n`);

async function settingsIfAny(): Promise<BackupSettings | null> {
  const c = newClient(config.db.controlDb);
  try {
    await c.connect();
    const r = await c.query(`select settings from keel.backup_settings where id`);
    return r.rows[0] ? { keepDaily: 7, keepWeekly: 4, target: null, ...r.rows[0].settings } : null;
  } catch {
    return null; // a fresh or half-restored install
  } finally {
    await c.end().catch(() => {});
  }
}

async function target(): Promise<ResolvedTarget | null> {
  const settings = await settingsIfAny();
  try {
    return resolveTarget(settings);
  } catch (err) {
    throw new Error(`The backup target can't be used: ${(err as Error).message} (or set KEEL_BACKUP_S3_* in .env)`);
  }
}

const mb = (n: number) => `${(n / 1024 / 1024).toFixed(1)} MB`;

/** Time zones differ by at most 14 hours from UTC, so names (local time) may be that far off. */
const NAME_TOLERANCE_MS = 15 * 3600_000;

/**
 * A file saved well before the time in its name was renamed: a backup is
 * written (and uploaded) at its name's time or later, never before.
 */
export function olderThanName(name: string, saved: Date): boolean {
  const named = setTime(name);
  return !!named && Number.isFinite(saved.getTime()) && named.getTime() - saved.getTime() > NAME_TOLERANCE_MS;
}

async function list(): Promise<void> {
  const local = (await fsp.readdir(fullDir()).catch(() => [] as string[])).filter((n) => setTime(n)).sort().reverse();
  say('On this machine (backups/full):');
  if (!local.length) say('  none');
  for (const n of local) {
    const st = await fsp.stat(path.join(fullDir(), n));
    say(`  ${n}  ${mb(st.size)}${olderThanName(n, st.mtime) ? '  (WARNING: the file is older than its name says)' : ''}`);
  }
  const t = await target();
  say('');
  if (!t) {
    say('No off-machine target is set up (Studio > Backups, or KEEL_BACKUP_S3_* in .env).');
    return;
  }
  say(`In ${t.describe}:`);
  const remote = await listRemote(t);
  if (!remote.length) say('  none');
  for (const o of remote) say(`  ${o.name}  ${mb(o.size)}${olderThanName(o.name, new Date(o.lastModified)) ? '  (WARNING: stored before the time in its name)' : ''}`);
  say('');
  say('./keel restore checks that each backup is the one its name says before it changes anything.');
}

/** A local file for the backup: the path given, one in backups/full, or a download. */
async function locate(arg: string): Promise<string> {
  if (arg.startsWith('/')) {
    if (!fs.existsSync(arg)) throw new Error(`No such file: ${arg}`);
    return arg;
  }
  const name = path.basename(arg);
  if (name !== arg || !setTime(name)) throw new Error(`"${arg}" isn't a backup name (keel-YYYYMMDD-HHMMSS.tar.age) or a file. See ./keel restore --list.`);
  const local = path.join(fullDir(), name);
  if (fs.existsSync(local)) return local;
  const t = await target();
  if (!t) throw new Error(`${name} isn't in backups/full, and no off-machine target is set up.`);
  await fsp.mkdir(fullDir(), { recursive: true, mode: 0o700 });
  say(`Downloading ${name} from ${t.describe} ...`);
  const tmp = `${local}.partial`;
  try {
    await pipeline(await t.s3.get(`${t.prefix}${name}`), fs.createWriteStream(tmp, { mode: 0o600 }));
  } catch (err) {
    await fsp.rm(tmp, { force: true });
    throw new Error(`Download failed: ${(err as Error).message}`);
  }
  await fsp.rename(tmp, local);
  return local;
}

/**
 * A warning when a file's name says one time and the backup inside says
 * another: an older backup renamed to look newer, or files mixed up.
 */
export function nameMismatch(fileName: string, m: Pick<Manifest, 'createdAt' | 'file'>): string | null {
  const named = setTime(fileName);
  if (!named) return null;
  const made = Date.parse(m.createdAt);
  if (m.file && m.file !== fileName) {
    return `This file is named ${fileName}, but the backup inside was written as ${m.file} (made ${m.createdAt}). It may be another backup renamed.`;
  }
  if (!Number.isFinite(made) || Math.abs(made - named.getTime()) > NAME_TOLERANCE_MS) {
    return `This file is named ${fileName}, but the backup inside was made ${m.createdAt}. It may be another backup renamed.`;
  }
  return null;
}

function describe(m: Manifest, fileName: string): void {
  const warning = nameMismatch(fileName, m);
  if (warning) say(`WARNING: ${warning}`);
  say(`Backup made ${m.createdAt} by Keel ${m.keelVersion}:`);
  for (const d of m.databases) say(`  ${d.project ? `project ${d.project}` : 'Keel settings, keys and accounts'} (${d.name})`);
  say(`  ${m.storage.files} uploaded files, ${mb(m.storage.bytes)}`);
}

export async function main(): Promise<void> {
  const args = process.argv.slice(3);
  if (args[0] === '--list') {
    await waitForDb();
    return list();
  }
  const verifyOnly = args.includes('--verify-only');
  const arg = args.find((a) => !a.startsWith('--'));
  if (!arg) throw new Error('usage: keel restore --list | keel restore <backup file or name> [--verify-only | --checked]');
  const passphrase = checkPassphrase(config.backups.passphrase);
  await waitForDb();
  const file = await locate(arg);
  const open = () => fs.createReadStream(file);

  // --checked: ./keel restore has just run --verify-only on the same file.
  if (!args.includes('--checked')) {
    say(`Checking ${path.basename(file)} (decrypting it once without changing anything) ...`);
    let manifest: Manifest;
    try {
      manifest = await verifyBackupSet(open, passphrase);
    } catch (err) {
      if (err instanceof DecryptError) throw new Error(`${err.message} Check KEEL_BACKUP_PASSPHRASE.`);
      throw err;
    }
    describe(manifest, process.env.KEEL_RESTORE_NAME || path.basename(file));
    if (verifyOnly) {
      say('The backup is complete and the passphrase is right.');
      return;
    }
  }
  try {
    await restoreBackupSet(open, passphrase, say);
  } catch (err) {
    if (err instanceof DecryptError) throw new Error(`${err.message} Check KEEL_BACKUP_PASSPHRASE.`);
    throw err;
  }
  say('Restore complete.');
}
