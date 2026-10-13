import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Transform, type Readable } from 'node:stream';
import { config } from '../lib/config.js';
import { HttpError } from '../lib/http.js';
import { log } from '../lib/log.js';

/**
 * Object bytes live on disk at <root>/<database>/<bucket>/<object id>/<version>.
 * Paths are derived from ids, never from user-supplied object names, so a
 * name like "../../etc/passwd" cannot escape the storage root. The id and
 * version come from storage.objects, which SQL can edit, so they must look
 * like what Keel writes (a UUID, or "v0" for rows without a version) and the
 * result must stay under the root.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A row whose id or version Keel didn't write is treated as having no file. */
const notFound = () => new HttpError(404, 'Object not found', 'not_found');

function checkIds(objectId: string, version: string): void {
  if (!UUID_RE.test(objectId) || !(version === 'v0' || UUID_RE.test(version))) {
    log.warn('storage object with an id or version Keel does not write; not touching its file', { id: String(objectId).slice(0, 64) });
    throw notFound();
  }
}

export function objectPath(dbName: string, bucket: string, objectId: string, version: string): string {
  checkIds(objectId, version);
  const root = path.resolve(config.storage.root);
  const file = path.resolve(root, dbName, bucketDir(bucket), objectId, version);
  if (!file.startsWith(root + path.sep)) throw notFound();
  return file;
}

/** Deletes an object's file. Never throws: a row whose file is gone or whose version is invalid is skipped. */
export async function removeObject(dbName: string, bucket: string, objectId: string, version: string): Promise<void> {
  try {
    await removeFile(objectPath(dbName, bucket, objectId, version));
  } catch {
    // Nothing to delete.
  }
}

export function bucketPath(dbName: string, bucket: string): string {
  return path.join(config.storage.root, dbName, bucketDir(bucket));
}

/** Relative path used for imgproxy's local:// source. */
export function relativeObjectPath(dbName: string, bucket: string, objectId: string, version: string): string {
  checkIds(objectId, version);
  return [dbName, bucketDir(bucket), objectId, version].map(encodeURIComponent).join('/');
}

function bucketDir(bucket: string): string {
  // Bucket ids are validated on creation; hex-encode anything unusual anyway.
  return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(bucket) && bucket !== '..' ? bucket : 'x-' + Buffer.from(bucket).toString('hex');
}

export type Staged = { tmp: string; size: number; etag: string };

/** Streams an upload to a temp file, enforcing a size limit. */
export async function stage(dbName: string, input: Readable, limit: number): Promise<Staged> {
  const dir = path.join(config.storage.root, dbName, '.tmp');
  await fsp.mkdir(dir, { recursive: true });
  const tmp = path.join(dir, crypto.randomUUID());
  const hash = crypto.createHash('md5');
  let size = 0;
  const meter = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      size += chunk.length;
      if (size > limit) return cb(Object.assign(new Error('The object exceeded the maximum allowed size'), { tooLarge: true }));
      hash.update(chunk);
      cb(null, chunk);
    },
  });
  try {
    await pipeline(input, meter, fs.createWriteStream(tmp, { flags: 'wx' }));
  } catch (err) {
    await fsp.rm(tmp, { force: true });
    throw err;
  }
  return { tmp, size, etag: `"${hash.digest('hex')}"` };
}

export async function commitFile(tmp: string, dest: string): Promise<void> {
  await fsp.mkdir(path.dirname(dest), { recursive: true });
  await fsp.rename(tmp, dest);
}

export async function removeFile(file: string): Promise<void> {
  await fsp.rm(file, { force: true });
  // Clean up the now-empty object directory.
  await fsp.rmdir(path.dirname(file)).catch(() => {});
}

export async function copyFile(src: string, dest: string): Promise<void> {
  await fsp.mkdir(path.dirname(dest), { recursive: true });
  await fsp.copyFile(src, dest);
}
