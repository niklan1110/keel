import crypto from 'node:crypto';
import { config, deriveSecret } from './config.js';
import { S3, s3ConfigProblem, type S3Config } from './s3.js';

/**
 * Where full backups are copied off the machine: an S3-compatible bucket,
 * set in Studio (stored in keel.backup_settings, the secret key sealed with
 * a key derived from KEEL_SECRET) or in .env (KEEL_BACKUP_S3_*, which wins,
 * and is what ./keel restore uses on a fresh machine).
 */

export type TargetSettings = Omit<S3Config, 'secretAccessKey'> & {
  /** Folder in the bucket, such as "keel/" (may be empty). */
  prefix: string;
};

export type StoredTarget = TargetSettings & { secretSealed: string };

export type BackupSettings = {
  /** HH:MM or "off"; unset means KEEL_BACKUP_SCHEDULE. */
  schedule?: string;
  keepDaily: number;
  keepWeekly: number;
  target: StoredTarget | null;
};

export const DEFAULT_SETTINGS: BackupSettings = { keepDaily: 7, keepWeekly: 4, target: null };

const sealKey = () => Buffer.from(deriveSecret(config.secret, 'backup-target'), 'hex');

export function sealSecret(secret: string): string {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', sealKey(), iv);
  const data = Buffer.concat([c.update(secret, 'utf8'), c.final()]);
  return `v1:${iv.toString('base64')}:${c.getAuthTag().toString('base64')}:${data.toString('base64')}`;
}

export function openSecret(sealed: string): string {
  const [v, iv, tag, data] = sealed.split(':');
  if (v !== 'v1') throw new Error('unknown format');
  const d = crypto.createDecipheriv('aes-256-gcm', sealKey(), Buffer.from(iv, 'base64'));
  d.setAuthTag(Buffer.from(tag, 'base64'));
  try {
    return Buffer.concat([d.update(Buffer.from(data, 'base64')), d.final()]).toString('utf8');
  } catch {
    throw new Error("The backup target's secret key can't be read (KEEL_SECRET changed?). Enter it again in Studio.");
  }
}

/** A prefix as stored: no leading slash, a trailing one unless empty. */
export function cleanPrefix(p: unknown): string {
  const s = String(p ?? '')
    .trim()
    .replace(/^\/+/, '')
    .replace(/\/+$/, '');
  if (s && (!/^[A-Za-z0-9._\-/]{1,200}$/.test(s) || s.split('/').some((p) => p === '' || p === '.' || p === '..'))) {
    throw new Error('The folder may only contain letters, digits, dots, dashes, underscores and single slashes.');
  }
  return s ? `${s}/` : '';
}

/** The target from KEEL_BACKUP_S3_* (null when KEEL_BACKUP_S3_BUCKET isn't set). */
export function envTarget(env: NodeJS.ProcessEnv = process.env): (TargetSettings & { secretAccessKey: string }) | null {
  if (!env.KEEL_BACKUP_S3_BUCKET) return null;
  const region = env.KEEL_BACKUP_S3_REGION || 'us-east-1';
  return {
    endpoint: env.KEEL_BACKUP_S3_ENDPOINT || `https://s3.${region}.amazonaws.com`,
    region,
    bucket: env.KEEL_BACKUP_S3_BUCKET,
    prefix: cleanPrefix(env.KEEL_BACKUP_S3_PREFIX),
    accessKeyId: env.KEEL_BACKUP_S3_ACCESS_KEY_ID || '',
    secretAccessKey: env.KEEL_BACKUP_S3_SECRET_ACCESS_KEY || '',
    pathStyle: !/^(off|false|0|no)$/i.test(env.KEEL_BACKUP_S3_PATH_STYLE || 'on'),
  };
}

export type ResolvedTarget = { s3: S3; prefix: string; source: 'env' | 'studio'; describe: string };

/** The client for a target, or an error saying what's wrong with it. */
export function connectTarget(t: TargetSettings & { secretAccessKey: string }, source: ResolvedTarget['source'], attempts?: number): ResolvedTarget {
  const problem = s3ConfigProblem(t);
  if (problem) throw new Error(problem);
  return { s3: new S3(t, attempts), prefix: t.prefix, source, describe: `${t.bucket}/${t.prefix} at ${new URL(t.endpoint).host}` };
}

/** The target to use: .env first, then Studio's settings. Null when there is none. */
export function resolveTarget(settings: BackupSettings | null, attempts?: number): ResolvedTarget | null {
  const env = envTarget();
  if (env) return connectTarget(env, 'env', attempts);
  const t = settings?.target;
  if (!t) return null;
  return connectTarget({ ...t, secretAccessKey: openSecret(t.secretSealed) }, 'studio', attempts);
}
