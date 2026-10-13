import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { config } from '../lib/config.js';
import { quoteIdent } from '../lib/db.js';
import { HttpError, type Req, type Res, type Router } from '../lib/http.js';
import type { Claims } from '../lib/jwt.js';
import { log } from '../lib/log.js';
import type { Registry } from '../lib/registry.js';
import type { Staged } from './files.js';
import { DEFAULT_CONTENT_TYPE } from './mime.js';
import type { Bucket, Ctx } from './index.js';

const e = (status: number, error: string, message: string) => new HttpError(status, message, error);

/**
 * Resumable uploads with the TUS 1.0.0 protocol, at the same URL as Supabase
 * Storage (/storage/v1/upload/resumable), so tus-js-client and Uppy work:
 *
 *   POST   /upload/resumable        create (Upload-Length, Upload-Metadata)
 *   HEAD   /upload/resumable/:id    current offset
 *   PATCH  /upload/resumable/:id    append bytes at Upload-Offset
 *   DELETE /upload/resumable/:id    cancel
 *
 * Partial uploads live next to the project's objects in .uploads/ and expire
 * after 24 hours. When the last byte arrives the file becomes an object,
 * written as the uploader so storage policies apply.
 */

/**
 * Where an upload continues: a path without a host, under the path of the
 * public URL (when Keel is served below one).
 */
export function uploadLocation(publicUrl: string, project: string, id: string): string {
  let base = '';
  try {
    base = new URL(publicUrl).pathname.replace(/\/+$/, '');
  } catch {
    // No usable public URL: Keel is at the root.
  }
  return `${base}/${project}/storage/v1/upload/resumable/${id}`;
}

type Deps = {
  ctxOf: (req: Req, res: Res) => Ctx;
  claimsOf: (ctx: Ctx) => Claims;
  getBucket: (ctx: Ctx, id: string) => Promise<Bucket>;
  storeStaged: (
    ctx: Ctx,
    bucket: Bucket,
    name: string,
    mode: 'create' | 'upsert' | 'update',
    claims: Claims,
    bypass: boolean,
    upload: { staged: Staged; contentType: string; cacheControl: string; userMeta: unknown },
  ) => Promise<unknown>;
  sizeLimit: (b: Bucket) => number;
  validName: (name: string) => string;
  /** Normalizes the content type and checks the bucket's allowed types (415 otherwise). */
  acceptType: (bucket: Bucket, contentType: string) => string;
  registry: Registry;
};

type Upload = {
  id: string;
  bucket: string;
  name: string;
  contentType: string;
  cacheControl: string;
  userMeta: unknown;
  length: number;
  upsert: boolean;
  /** Who created it: later requests must come from the same user. */
  sub: string | null;
  role: string;
  createdAt: number;
};

const TUS_VERSION = '1.0.0';
const EXPIRY_MS = 24 * 3600_000;
const ID_RE = /^[A-Za-z0-9_-]{20,64}$/;
const API_ROLES = new Set(['anon', 'authenticated', 'service_role']);

const uploadsDir = (dbName: string) => path.join(config.storage.root, dbName, '.uploads');

function tusHeaders(extra: Record<string, string> = {}) {
  return { 'Tus-Resumable': TUS_VERSION, 'Cache-Control': 'no-store', ...extra };
}

/** Upload-Metadata: comma-separated "key base64value" pairs. */
export function parseMetadata(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of String(header || '').split(',')) {
    const [k, v] = part.trim().split(/\s+/, 2);
    if (!k) continue;
    out[k] = v ? Buffer.from(v, 'base64').toString('utf8') : '';
  }
  return out;
}

export function registerTus(router: Router, d: Deps): void {
  const locks = new Set<string>();

  const load = async (ctx: Ctx, id: string): Promise<Upload> => {
    if (!ID_RE.test(id)) throw e(404, 'not_found', 'Upload not found');
    const raw = await fsp.readFile(path.join(uploadsDir(ctx.project.dbName), `${id}.json`), 'utf8').catch(() => null);
    if (!raw) throw e(404, 'not_found', 'Upload not found');
    const u = JSON.parse(raw) as Upload;
    if (Date.now() - u.createdAt > EXPIRY_MS) {
      await discard(ctx, id);
      throw e(410, 'expired', 'Upload expired');
    }
    return u;
  };

  /** Each request must carry a valid token for the user who started the upload. */
  const authorize = (ctx: Ctx, u: Upload): Claims => {
    const claims = d.claimsOf(ctx);
    const sub = typeof claims.sub === 'string' ? claims.sub : null;
    if (sub !== u.sub || String(claims.role || 'anon') !== u.role) throw e(404, 'not_found', 'Upload not found');
    return claims;
  };

  const discard = async (ctx: Ctx, id: string) => {
    const dir = uploadsDir(ctx.project.dbName);
    await fsp.rm(path.join(dir, `${id}.json`), { force: true });
    await fsp.rm(path.join(dir, `${id}.bin`), { force: true });
  };

  const offsetOf = async (ctx: Ctx, id: string) => (await fsp.stat(path.join(uploadsDir(ctx.project.dbName), `${id}.bin`)).catch(() => null))?.size ?? 0;

  // A path without a host: TUS clients resolve it against the address they
  // reached Keel on, which works from any address (a phone on the LAN, the
  // tunnel), and no request header can send the upload to another host.
  const location = (ctx: Ctx, id: string) => uploadLocation(config.publicUrl, ctx.project.name, id);

  /** Checks up front that the caller may create (or overwrite) the object, so nobody uploads gigabytes for nothing. */
  const dryRun = async (ctx: Ctx, claims: Claims, bucket: string, name: string, upsert: boolean) => {
    const role = String(claims.role || 'anon');
    if (!API_ROLES.has(role)) throw e(403, 'Unauthorized', 'Invalid role');
    const sub = typeof claims.sub === 'string' ? claims.sub : null;
    const c = await ctx.pool.connect();
    try {
      await c.query('begin');
      await c.query(`set local role ${quoteIdent(role)}`);
      await c.query(`select set_config('request.jwt.claims', $1, true), set_config('request.jwt.claim.sub', $2, true), set_config('request.jwt.claim.role', $3, true)`, [
        JSON.stringify(claims),
        sub || '',
        role,
      ]);
      const prev = (await c.query('select 1 from storage.objects where bucket_id = $1 and name = $2', [bucket, name])).rowCount;
      if (prev && !upsert) throw e(409, 'Duplicate', 'The resource already exists');
      if (prev) {
        const r = await c.query('update storage.objects set updated_at = now() where bucket_id = $1 and name = $2', [bucket, name]);
        if (!r.rowCount) throw e(403, 'Unauthorized', 'new row violates row-level security policy');
      } else {
        const owner = sub && /^[0-9a-f-]{36}$/i.test(sub) ? sub : null;
        await c.query('insert into storage.objects (bucket_id, name, owner, owner_id) values ($1, $2, $3, $4)', [bucket, name, owner, sub]);
      }
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code === '42501') throw e(403, 'Unauthorized', 'new row violates row-level security policy');
      if (code === '23505') throw e(409, 'Duplicate', 'The resource already exists');
      throw err;
    } finally {
      await c.query('rollback').catch(() => {});
      c.release();
    }
  };

  /** Appends the request body at the expected offset; returns the new offset. */
  const append = async (ctx: Ctx, u: Upload): Promise<number> => {
    const { req } = ctx;
    if (!String(req.headers['content-type'] || '').startsWith('application/offset+octet-stream')) {
      throw e(415, 'invalid_content_type', 'Content-Type must be application/offset+octet-stream');
    }
    const given = Number(req.headers['upload-offset']);
    const current = await offsetOf(ctx, u.id);
    if (!Number.isInteger(given) || given !== current) throw e(409, 'conflict', `Upload-Offset ${req.headers['upload-offset']} does not match the current offset ${current}`);
    let size = current;
    const meter = new Transform({
      transform(chunk: Buffer, _enc, cb) {
        size += chunk.length;
        if (size > u.length) return cb(Object.assign(new Error('Upload is larger than Upload-Length'), { tooLarge: true }));
        cb(null, chunk);
      },
    });
    try {
      await pipeline(req, meter, fs.createWriteStream(path.join(uploadsDir(ctx.project.dbName), `${u.id}.bin`), { flags: 'a' }));
    } catch (err) {
      if ((err as { tooLarge?: boolean }).tooLarge) {
        // Keep what fits; the client must not send past the declared length.
        await fsp.truncate(path.join(uploadsDir(ctx.project.dbName), `${u.id}.bin`), current);
        throw e(413, 'Payload too large', 'The upload exceeded its Upload-Length');
      }
      // Connection dropped mid-chunk: whatever arrived is kept, and the client resumes from HEAD.
    }
    return offsetOf(ctx, u.id);
  };

  /** Turns a complete upload into an object. */
  const finish = async (ctx: Ctx, u: Upload, claims: Claims) => {
    const file = path.join(uploadsDir(ctx.project.dbName), `${u.id}.bin`);
    const hash = crypto.createHash('md5');
    await pipeline(fs.createReadStream(file), hash);
    const bucket = await d.getBucket(ctx, u.bucket);
    try {
      await d.storeStaged(ctx, bucket, u.name, u.upsert ? 'upsert' : 'create', claims, false, {
        staged: { tmp: file, size: u.length, etag: `"${hash.digest('hex')}"` },
        contentType: u.contentType,
        cacheControl: u.cacheControl,
        userMeta: u.userMeta,
      });
    } finally {
      await discard(ctx, u.id);
    }
  };

  const withLock = async <T>(id: string, fn: () => Promise<T>): Promise<T> => {
    if (locks.has(id)) throw e(423, 'locked', 'Another request is writing to this upload');
    locks.add(id);
    try {
      return await fn();
    } finally {
      locks.delete(id);
    }
  };

  router.post('/upload/resumable', async (req, res) => {
    const ctx = d.ctxOf(req, res);
    const claims = d.claimsOf(ctx);
    const length = Number(req.headers['upload-length']);
    if (req.headers['upload-defer-length']) throw e(400, 'invalid_request', 'Upload-Defer-Length is not supported');
    if (!Number.isInteger(length) || length < 0) throw e(400, 'invalid_request', 'Upload-Length is required');
    const meta = parseMetadata(req.headers['upload-metadata'] as string | undefined);
    const bucketId = meta.bucketName || '';
    const name = d.validName(meta.objectName || '');
    const bucket = await d.getBucket(ctx, bucketId);
    if (length > d.sizeLimit(bucket)) throw e(413, 'Payload too large', 'The object exceeded the maximum allowed size');
    // Stored normalized; checked again when the upload completes.
    const contentType = d.acceptType(bucket, meta.contentType || DEFAULT_CONTENT_TYPE);
    const upsert = String(req.headers['x-upsert'] || '') === 'true';
    await dryRun(ctx, claims, bucketId, name, upsert);

    let userMeta: unknown = null;
    if (meta.metadata) {
      try {
        userMeta = JSON.parse(meta.metadata);
      } catch {
        /* ignore malformed metadata */
      }
    }
    const cc = /(\d+)/.exec(meta.cacheControl || '');
    const u: Upload = {
      id: crypto.randomBytes(24).toString('base64url'),
      bucket: bucketId,
      name,
      contentType,
      cacheControl: cc ? cc[1] : '3600',
      userMeta,
      length,
      upsert,
      sub: typeof claims.sub === 'string' ? claims.sub : null,
      role: String(claims.role || 'anon'),
      createdAt: Date.now(),
    };
    const dir = uploadsDir(ctx.project.dbName);
    await fsp.mkdir(dir, { recursive: true });
    await fsp.writeFile(path.join(dir, `${u.id}.bin`), '');
    await fsp.writeFile(path.join(dir, `${u.id}.json`), JSON.stringify(u));
    const headers: Record<string, string> = tusHeaders({
      Location: location(ctx, u.id),
      'Upload-Expires': new Date(u.createdAt + EXPIRY_MS).toUTCString(),
    });
    // creation-with-upload: the first chunk can come with the POST.
    if (String(req.headers['content-type'] || '').startsWith('application/offset+octet-stream')) {
      req.headers['upload-offset'] = '0';
      const offset = await withLock(u.id, () => append(ctx, u));
      headers['Upload-Offset'] = String(offset);
      if (offset === u.length) await finish(ctx, u, claims);
    } else {
      req.resume();
      if (length === 0) await finish(ctx, u, claims);
    }
    res.writeHead(201, headers).end();
  });

  const patch = async (req: Req, res: Res) => {
    const ctx = d.ctxOf(req, res);
    const u = await load(ctx, req.params.id);
    const claims = authorize(ctx, u);
    const offset = await withLock(u.id, async () => {
      const off = await append(ctx, u);
      if (off === u.length) await finish(ctx, u, claims);
      return off;
    });
    res.writeHead(204, tusHeaders({ 'Upload-Offset': String(offset), 'Upload-Expires': new Date(u.createdAt + EXPIRY_MS).toUTCString() })).end();
  };

  router.patch('/upload/resumable/:id', patch);
  // tus-js-client's overridePatchMethod sends POST + X-HTTP-Method-Override.
  router.post('/upload/resumable/:id', async (req, res) => {
    if (String(req.headers['x-http-method-override'] || '').toUpperCase() !== 'PATCH') throw e(405, 'method_not_allowed', 'Use PATCH to append to an upload');
    return patch(req, res);
  });

  router.head('/upload/resumable/:id', async (req, res) => {
    const ctx = d.ctxOf(req, res);
    const u = await load(ctx, req.params.id);
    authorize(ctx, u);
    res
      .writeHead(200, tusHeaders({ 'Upload-Offset': String(await offsetOf(ctx, u.id)), 'Upload-Length': String(u.length), 'Upload-Expires': new Date(u.createdAt + EXPIRY_MS).toUTCString() }))
      .end();
  });

  router.delete('/upload/resumable/:id', async (req, res) => {
    const ctx = d.ctxOf(req, res);
    const u = await load(ctx, req.params.id);
    authorize(ctx, u);
    await withLock(u.id, () => discard(ctx, u.id));
    res.writeHead(204, tusHeaders()).end();
  });

  router.add('OPTIONS', '/upload/resumable', (_req, res) => {
    res.writeHead(204, tusHeaders({ 'Tus-Version': TUS_VERSION, 'Tus-Extension': 'creation,creation-with-upload,termination,expiration', 'Tus-Max-Size': String(config.storage.maxFileSize) })).end();
  });

  // Expired partial uploads.
  setInterval(async () => {
    for (const p of d.registry.list()) {
      const dir = uploadsDir(p.dbName);
      const names = await fsp.readdir(dir).catch(() => [] as string[]);
      for (const n of names.filter((x) => x.endsWith('.json'))) {
        const raw = await fsp.readFile(path.join(dir, n), 'utf8').catch(() => null);
        const created = raw ? (JSON.parse(raw) as Upload).createdAt : 0;
        if (Date.now() - created > EXPIRY_MS) {
          const id = n.slice(0, -5);
          await fsp.rm(path.join(dir, `${id}.json`), { force: true });
          await fsp.rm(path.join(dir, `${id}.bin`), { force: true });
          log.info('removed expired resumable upload', { project: p.name, id });
        }
      }
    }
  }, 60 * 60_000).unref();
}
