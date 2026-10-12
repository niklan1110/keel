import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import type pg from 'pg';
import busboy from 'busboy';
import { config, requireRolePassword } from '../lib/config.js';
import { asRole, pool, tx } from '../lib/db.js';
import { HttpError, Router, bearer, createServer, limitServer, listen, readJson, sendJson, type Req, type Res } from '../lib/http.js';
import { JwtError, sign, verify, type Claims } from '../lib/jwt.js';
import { log } from '../lib/log.js';
import { Registry, signingKey, type Project } from '../lib/registry.js';
import { registerTus } from './tus.js';
import { bucketPath, commitFile, copyFile, objectPath, relativeObjectPath, removeFile, removeObject, stage, type Staged } from './files.js';
import { DEFAULT_CONTENT_TYPE, SANDBOX_CSP, isPassiveType, mimeAllowed, normalizeContentType } from './mime.js';

export type Ctx = { project: Project; pool: pg.Pool; req: Req; res: Res };

export type Bucket = {
  id: string;
  name: string;
  owner: string | null;
  owner_id: string | null;
  public: boolean;
  file_size_limit: string | number | null;
  allowed_mime_types: string[] | null;
  created_at: Date;
  updated_at: Date;
};

type ObjectRow = {
  id: string;
  bucket_id: string;
  name: string;
  owner: string | null;
  owner_id: string | null;
  version: string | null;
  metadata: Record<string, any> | null;
  user_metadata: Record<string, any> | null;
  created_at: Date;
  updated_at: Date;
  last_accessed_at: Date;
};

const e = (status: number, error: string, message: string) => new HttpError(status, message, error);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const BUCKET_RE = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,99}$/;
const RESERVED_BUCKETS = new Set(['public', 'authenticated', 'sign', 'info', 'list', 'move', 'copy', 'upload', 'render']);

function validName(name: string): string {
  if (!name || name.length > 1024 || name.startsWith('/') || name.includes('\0') || name.includes('\\')) {
    throw e(400, 'InvalidKey', `Invalid key: ${name}`);
  }
  if (name.split('/').some((seg) => seg === '..' || seg === '.')) throw e(400, 'InvalidKey', `Invalid key: ${name}`);
  return name;
}

function bucketJson(b: Bucket) {
  return {
    id: b.id,
    name: b.name,
    owner: b.owner_id || b.owner || '',
    public: b.public,
    file_size_limit: b.file_size_limit === null ? null : Number(b.file_size_limit),
    allowed_mime_types: b.allowed_mime_types,
    created_at: b.created_at,
    updated_at: b.updated_at,
  };
}

function objectJson(o: ObjectRow) {
  return {
    name: o.name,
    id: o.id,
    bucket_id: o.bucket_id,
    owner: o.owner_id || o.owner,
    version: o.version,
    metadata: o.metadata,
    user_metadata: o.user_metadata,
    created_at: o.created_at,
    updated_at: o.updated_at,
    last_accessed_at: o.last_accessed_at,
  };
}

/**
 * The content type a file is stored with: the declared one, normalized (see
 * mime.ts), if the bucket's allowed types include it. Refused with 415 otherwise.
 */
function acceptType(bucket: Pick<Bucket, 'allowed_mime_types'>, declared: string): string {
  const type = normalizeContentType(declared);
  if (!type) throw e(415, 'invalid_mime_type', `invalid mime type ${JSON.stringify(declared.slice(0, 100))}`);
  if (!mimeAllowed(bucket.allowed_mime_types, type)) throw e(415, 'invalid_mime_type', `mime type ${type} is not supported`);
  return type;
}

/** Longest lifetime of a signed URL. */
const MAX_SIGNED_URL_SECONDS = 10 * 365 * 24 * 3600;

export async function main(): Promise<void> {
  requireRolePassword('keel_storage_admin');
  const registry = new Registry('keel_storage_admin');
  await registry.start();

  const ctxOf = (req: Req, res: Res): Ctx => {
    const name = String(req.headers['x-keel-project'] || '');
    const project = registry.get(name);
    if (!project) throw e(404, 'not_found', name ? `Unknown project "${name}"` : 'Missing project');
    return { project, pool: pool(project.dbName, 'keel_storage_admin', 10), req, res };
  };

  const claimsOf = (ctx: Ctx): Claims => {
    const apikey = ctx.req.headers['apikey'];
    const token = bearer(ctx.req) || (typeof apikey === 'string' ? apikey : null);
    if (!token) throw e(400, 'Unauthorized', 'headers must have required property \'authorization\'');
    try {
      const claims = verify(token, ctx.project.jwtKeys);
      if (claims.ref && claims.ref !== ctx.project.name) throw new JwtError('token is for another project');
      return claims;
    } catch (err) {
      throw e(400, 'Unauthorized', err instanceof JwtError && /expired/.test(err.message) ? '"exp" claim timestamp check failed' : 'Invalid JWT');
    }
  };

  const owner = (claims: Claims) => {
    const sub = typeof claims.sub === 'string' ? claims.sub : null;
    return { owner: sub && UUID_RE.test(sub) ? sub : null, owner_id: sub };
  };

  /** Reads a bucket bypassing RLS (for public flag and limits). */
  const getBucket = async (ctx: Ctx, id: string): Promise<Bucket> => {
    const { rows } = await ctx.pool.query('select * from storage.buckets where id = $1', [id]);
    if (!rows[0]) throw e(404, 'Bucket not found', 'Bucket not found');
    return rows[0];
  };

  const signToken = (ctx: Ctx, claims: Record<string, unknown>, expiresIn: number) => {
    const iat = Math.floor(Date.now() / 1000);
    // A finite lifetime, at most ten years (as long as the API keys): {"expiresIn": 1e400}
    // parses as Infinity, which became "exp": null, a link that never expired.
    const seconds = Number.isFinite(expiresIn) ? Math.min(Math.max(1, Math.floor(expiresIn)), MAX_SIGNED_URL_SECONDS) : 60;
    return sign({ ...claims, iat, exp: iat + seconds }, signingKey(ctx.project));
  };

  const readSigned = (ctx: Ctx, kind: string, url: string): Claims => {
    const token = ctx.req.query.get('token');
    if (!token) throw e(400, 'InvalidSignature', 'Missing token');
    let c: Claims;
    try {
      c = verify(token, ctx.project.jwtKeys);
    } catch (err) {
      throw e(400, 'InvalidJWT', err instanceof JwtError && /expired/.test(err.message) ? '"exp" claim timestamp check failed' : 'Invalid signature');
    }
    if (c.kind !== kind || c.url !== url) throw e(400, 'InvalidSignature', 'The url do not match the signature');
    return c;
  };

  // ---------------------------------------------------------------- download helpers
  const streamObject = async (ctx: Ctx, o: ObjectRow, opts: { download?: string | null } = {}) => {
    const { req, res } = ctx;
    const file = objectPath(ctx.project.dbName, o.bucket_id, o.id, o.version || 'v0');
    let stat: fs.Stats;
    try {
      stat = await fs.promises.stat(file);
    } catch {
      throw e(404, 'not_found', 'Object not found');
    }
    const meta = o.metadata || {};
    // Normalized again on the way out, for rows stored before types were checked (or edited in SQL).
    const type = normalizeContentType(meta.mimetype) ?? DEFAULT_CONTENT_TYPE;
    const etag = String(meta.eTag || `"${o.version}"`);
    const headers: Record<string, string> = {
      'Content-Type': type,
      'Cache-Control': String(meta.cacheControl || 'max-age=3600'),
      ETag: etag,
      'Last-Modified': new Date(o.updated_at).toUTCString(),
      'Accept-Ranges': 'bytes',
      'X-Content-Type-Options': 'nosniff',
    };
    // Files are served from the API's origin: anything that might be active (HTML, SVG, XML,
    // scripts, unknown types) is sandboxed so it can't run script there.
    if (!isPassiveType(type)) headers['Content-Security-Policy'] = SANDBOX_CSP;
    if (opts.download !== undefined && opts.download !== null) {
      const filename = opts.download || o.name.split('/').pop() || 'download';
      headers['Content-Disposition'] = `attachment; filename="${filename.replace(/["\\\r\n]/g, '_')}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
    }
    if (req.headers['if-none-match'] === etag) {
      res.writeHead(304, headers).end();
      return;
    }
    const range = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range || ''));
    if (range && (range[1] || range[2])) {
      let start = range[1] ? Number(range[1]) : stat.size - Number(range[2]);
      let end = range[1] && range[2] ? Number(range[2]) : stat.size - 1;
      start = Math.max(0, start);
      end = Math.min(end, stat.size - 1);
      if (start > end || start >= stat.size) {
        res.writeHead(416, { 'Content-Range': `bytes */${stat.size}` }).end();
        return;
      }
      res.writeHead(206, { ...headers, 'Content-Range': `bytes ${start}-${end}/${stat.size}`, 'Content-Length': String(end - start + 1) });
      if (req.method === 'HEAD') return void res.end();
      fs.createReadStream(file, { start, end }).pipe(res);
      return;
    }
    res.writeHead(200, { ...headers, 'Content-Length': String(stat.size) });
    if (req.method === 'HEAD') return void res.end();
    fs.createReadStream(file).pipe(res);
  };

  const findAsUser = async (ctx: Ctx, bucket: string, name: string): Promise<ObjectRow> => {
    const claims = claimsOf(ctx);
    const rows = await asRole(ctx.pool, claims, async (c) =>
      (await c.query('select * from storage.objects where bucket_id = $1 and name = $2', [bucket, name])).rows,
    );
    if (!rows[0]) throw e(404, 'not_found', 'Object not found');
    return rows[0];
  };

  const findAsAdmin = async (ctx: Ctx, bucket: string, name: string): Promise<ObjectRow> => {
    const { rows } = await ctx.pool.query('select * from storage.objects where bucket_id = $1 and name = $2', [bucket, name]);
    if (!rows[0]) throw e(404, 'not_found', 'Object not found');
    return rows[0];
  };

  // ---------------------------------------------------------------- upload helpers
  const readUpload = (ctx: Ctx, limit: number): Promise<{ staged: Staged; contentType: string; cacheControl: string; userMeta: unknown }> => {
    const { req } = ctx;
    const ct = String(req.headers['content-type'] || '');
    const parseMeta = (s: string | undefined) => {
      if (!s) return null;
      try {
        return JSON.parse(s);
      } catch {
        return null;
      }
    };
    if (ct.toLowerCase().startsWith('multipart/form-data')) {
      return new Promise((resolve, reject) => {
        let bb: busboy.Busboy;
        try {
          bb = busboy({ headers: req.headers, limits: { files: 1, fileSize: limit + 1 } });
        } catch {
          return reject(e(400, 'InvalidRequest', 'Malformed multipart body'));
        }
        let cacheControl = '3600';
        let userMeta: unknown = null;
        let contentType = DEFAULT_CONTENT_TYPE;
        let file: Promise<Staged> | null = null;
        bb.on('field', (name, val) => {
          // Seconds, as supabase-js sends it ("3600"); anything else keeps the default.
          if (name === 'cacheControl' && /^\d{1,10}$/.test(val.trim())) cacheControl = val.trim();
          if (name === 'metadata') userMeta = parseMeta(val);
          if (name === 'contentType' && val) contentType = val;
        });
        bb.on('file', (_name, stream, info) => {
          if (info.mimeType && info.mimeType !== 'application/octet-stream') contentType = info.mimeType;
          file = stage(ctx.project.dbName, stream, limit);
          // Over the limit: stop reading and answer now. busboy would wait for the
          // destroyed file stream forever when the body arrives in pieces.
          file.catch((err) => {
            req.unpipe(bb);
            req.resume();
            reject(err);
          });
        });
        bb.on('close', () => {
          if (!file) return reject(e(400, 'InvalidRequest', 'No file was found in the request'));
          file.then((staged) => resolve({ staged, contentType, cacheControl, userMeta }), reject);
        });
        bb.on('error', (err) => reject(e(400, 'InvalidRequest', (err as Error).message)));
        req.pipe(bb);
      });
    }
    const cc = /max-age=(\d+)/.exec(String(req.headers['cache-control'] || ''));
    const xm = req.headers['x-metadata'];
    const userMeta = typeof xm === 'string' ? parseMeta(Buffer.from(xm, 'base64').toString('utf8')) : null;
    return stage(ctx.project.dbName, req, limit).then((staged) => ({
      staged,
      contentType: ct || DEFAULT_CONTENT_TYPE,
      cacheControl: cc ? cc[1] : '3600',
      userMeta,
    }));
  };

  /**
   * Stores an upload. `mode` is 'create' (fail if exists), 'upsert', or
   * 'update' (must exist). With `bypass` the row is written as the storage
   * admin (used by signed upload URLs); otherwise RLS applies.
   */
  const sizeLimit = (bucket: Bucket) => Math.min(config.storage.maxFileSize, bucket.file_size_limit === null ? Infinity : Number(bucket.file_size_limit));

  const store = async (ctx: Ctx, bucketId: string, name: string, mode: 'create' | 'upsert' | 'update', claims: Claims, bypass = false) => {
    validName(name);
    const bucket = await getBucket(ctx, bucketId);
    // A raw body's type is known before any data arrives: refuse it up front.
    const declared = String(ctx.req.headers['content-type'] || '');
    if (!declared.toLowerCase().startsWith('multipart/form-data')) acceptType(bucket, declared || DEFAULT_CONTENT_TYPE);
    let upload;
    try {
      upload = await readUpload(ctx, sizeLimit(bucket));
    } catch (err) {
      if ((err as { tooLarge?: boolean }).tooLarge) throw e(413, 'Payload too large', 'The object exceeded the maximum allowed size');
      throw err;
    }
    return storeStaged(ctx, bucket, name, mode, claims, bypass, upload);
  };

  /** Records an upload that is already on disk (staged) as an object, as the caller (RLS) unless bypass. */
  const storeStaged = async (
    ctx: Ctx,
    bucket: Bucket,
    name: string,
    mode: 'create' | 'upsert' | 'update',
    claims: Claims,
    bypass: boolean,
    upload: { staged: Staged; contentType: string; cacheControl: string; userMeta: unknown },
  ) => {
    const bucketId = bucket.id;
    const { staged, cacheControl, userMeta } = upload;
    let finalFile: string | null = null;
    let replaced: ObjectRow | null = null;
    try {
      // Every upload path (multipart, raw, TUS, signed URLs) ends here: store only the normalized type.
      const contentType = acceptType(bucket, upload.contentType);
      const version = crypto.randomUUID();
      const metadata = {
        eTag: staged.etag,
        size: staged.size,
        mimetype: contentType,
        cacheControl: `max-age=${cacheControl}`,
        lastModified: new Date().toISOString(),
        contentLength: staged.size,
        httpStatusCode: 200,
      };
      const who = owner(claims);
      const run = async (c: pg.ClientBase) => {
        const prev = (await c.query('select * from storage.objects where bucket_id = $1 and name = $2', [bucketId, name])).rows[0] as ObjectRow | undefined;
        if (mode === 'update' && !prev) throw e(404, 'not_found', 'Object not found');
        if (mode === 'create' && prev) throw e(409, 'Duplicate', 'The resource already exists');
        let row: ObjectRow;
        if (prev) {
          const r = await c.query(
            `update storage.objects set metadata = $3, version = $4, user_metadata = $5, owner = $6, owner_id = $7,
                    updated_at = now(), last_accessed_at = now()
              where bucket_id = $1 and name = $2 returning *`,
            [bucketId, name, metadata, version, userMeta, who.owner, who.owner_id],
          );
          if (!r.rows[0]) throw e(403, 'Unauthorized', 'new row violates row-level security policy');
          row = r.rows[0];
          replaced = prev;
        } else {
          // No `returning`: as on Supabase, a new upload needs only an INSERT
          // policy (returning rows would also require a SELECT policy).
          const id = crypto.randomUUID();
          await c.query(
            `insert into storage.objects (id, bucket_id, name, owner, owner_id, metadata, version, user_metadata)
             values ($1, $2, $3, $4, $5, $6, $7, $8)`,
            [id, bucketId, name, who.owner, who.owner_id, metadata, version, userMeta],
          );
          row = { id, bucket_id: bucketId, name, version } as ObjectRow;
        }
        finalFile = objectPath(ctx.project.dbName, bucketId, row.id, version);
        await commitFile(staged.tmp, finalFile);
        return row;
      };
      const row = bypass ? await tx(ctx.pool, run) : await asRole(ctx.pool, claims, run);
      if (replaced) {
        const old = replaced as ObjectRow;
        await removeObject(ctx.project.dbName, bucketId, old.id, old.version || 'v0');
      }
      log.info(`PUT ${bucketId}/${name} ${formatBytes(staged.size)}`, { project: ctx.project.name });
      return { Id: row.id, Key: `${bucketId}/${name}` };
    } catch (err) {
      await fs.promises.rm(staged.tmp, { force: true });
      if (finalFile) await removeFile(finalFile).catch(() => {});
      if ((err as { code?: string }).code === '42501') throw e(403, 'Unauthorized', 'new row violates row-level security policy');
      if ((err as { code?: string }).code === '23505') throw e(409, 'Duplicate', 'The resource already exists');
      throw err;
    }
  };

  const deleteRows = async (ctx: Ctx, rows: ObjectRow[]) => {
    for (const o of rows) await removeObject(ctx.project.dbName, o.bucket_id, o.id, o.version || 'v0');
  };

  const router = new Router();
  router.get('/health', (_req, res) => sendJson(res, 200, { status: 'ok' }));

  registerTus(router, { ctxOf, claimsOf, getBucket, storeStaged, sizeLimit, validName, acceptType, registry });

  // ---------------------------------------------------------------- buckets
  router.get('/bucket', async (req, res) => {
    const ctx = ctxOf(req, res);
    const claims = claimsOf(ctx);
    const search = req.query.get('search') || '';
    const limit = Math.min(1000, Number(req.query.get('limit')) || 1000);
    const offset = Number(req.query.get('offset')) || 0;
    const sortCol = ['id', 'name', 'created_at', 'updated_at'].includes(req.query.get('sortColumn') || '') ? req.query.get('sortColumn')! : 'name';
    const order = req.query.get('sortOrder') === 'desc' ? 'desc' : 'asc';
    const rows = await asRole(ctx.pool, claims, async (c) =>
      (await c.query(`select * from storage.buckets where ($1 = '' or name ilike '%' || $1 || '%') order by ${sortCol} ${order} limit $2 offset $3`, [search, limit, offset])).rows,
    );
    sendJson(res, 200, rows.map(bucketJson));
  });

  router.get('/bucket/:id', async (req, res) => {
    const ctx = ctxOf(req, res);
    const claims = claimsOf(ctx);
    const rows = await asRole(ctx.pool, claims, async (c) => (await c.query('select * from storage.buckets where id = $1', [req.params.id])).rows);
    if (!rows[0]) throw e(404, 'Bucket not found', 'Bucket not found');
    sendJson(res, 200, bucketJson(rows[0]));
  });

  router.post('/bucket', async (req, res) => {
    const ctx = ctxOf(req, res);
    const claims = claimsOf(ctx);
    const body = await readJson(req);
    const name = String(body.name || body.id || '');
    const id = String(body.id || name);
    if (!BUCKET_RE.test(name) || !BUCKET_RE.test(id) || RESERVED_BUCKETS.has(id)) {
      throw e(400, 'Invalid Input', 'Bucket name invalid: use letters, numbers, dots, dashes, underscores and spaces');
    }
    const who = owner(claims);
    try {
      await asRole(ctx.pool, claims, (c) =>
        c.query(
          `insert into storage.buckets (id, name, owner, owner_id, public, file_size_limit, allowed_mime_types) values ($1, $2, $3, $4, $5, $6, $7)`,
          [id, name, who.owner, who.owner_id, !!body.public, parseSize(body.file_size_limit), Array.isArray(body.allowed_mime_types) && body.allowed_mime_types.length ? body.allowed_mime_types.map(String) : null],
        ),
      );
    } catch (err) {
      if ((err as { code?: string }).code === '23505') throw e(409, 'Duplicate', 'The resource already exists');
      if ((err as { code?: string }).code === '42501') throw e(403, 'Unauthorized', 'new row violates row-level security policy');
      throw err;
    }
    sendJson(res, 200, { name: id });
  });

  router.put('/bucket/:id', async (req, res) => {
    const ctx = ctxOf(req, res);
    const claims = claimsOf(ctx);
    const body = await readJson(req);
    const result = await asRole(ctx.pool, claims, (c) =>
      c.query(
        `update storage.buckets set public = coalesce($2, public),
                file_size_limit = case when $5 then $3 else file_size_limit end,
                allowed_mime_types = case when $6 then $4 else allowed_mime_types end,
                updated_at = now()
          where id = $1`,
        [
          req.params.id,
          typeof body.public === 'boolean' ? body.public : null,
          parseSize(body.file_size_limit),
          Array.isArray(body.allowed_mime_types) && body.allowed_mime_types.length ? body.allowed_mime_types.map(String) : null,
          'file_size_limit' in body,
          'allowed_mime_types' in body,
        ],
      ),
    );
    if (!result.rowCount) throw e(404, 'Bucket not found', 'Bucket not found');
    sendJson(res, 200, { message: 'Successfully updated' });
  });

  router.post('/bucket/:id/empty', async (req, res) => {
    const ctx = ctxOf(req, res);
    const claims = claimsOf(ctx);
    await getBucket(ctx, req.params.id);
    const rows = await asRole(ctx.pool, claims, async (c) =>
      (await c.query('delete from storage.objects where bucket_id = $1 returning *', [req.params.id])).rows,
    );
    await deleteRows(ctx, rows);
    sendJson(res, 200, { message: 'Successfully emptied' });
  });

  router.delete('/bucket/:id', async (req, res) => {
    const ctx = ctxOf(req, res);
    const claims = claimsOf(ctx);
    await getBucket(ctx, req.params.id);
    const { rows } = await ctx.pool.query('select 1 from storage.objects where bucket_id = $1 limit 1', [req.params.id]);
    if (rows.length) throw e(409, 'InvalidRequest', 'The bucket you tried to delete is not empty');
    const result = await asRole(ctx.pool, claims, (c) => c.query('delete from storage.buckets where id = $1', [req.params.id]));
    if (!result.rowCount) throw e(403, 'Unauthorized', 'You do not have permission to delete this bucket');
    await fs.promises.rm(bucketPath(ctx.project.dbName, req.params.id), { recursive: true, force: true });
    sendJson(res, 200, { message: 'Successfully deleted' });
  });

  // ---------------------------------------------------------------- object listing and management
  router.post('/object/list/:bucket', async (req, res) => {
    const ctx = ctxOf(req, res);
    const claims = claimsOf(ctx);
    const body = await readJson(req);
    let prefix = String(body.prefix || '');
    if (prefix && !prefix.endsWith('/')) prefix += '/';
    const limit = Math.min(1000, Math.max(1, Number(body.limit) || 100));
    const offset = Math.max(0, Number(body.offset) || 0);
    const col = ['name', 'updated_at', 'created_at', 'last_accessed_at'].includes(body.sortBy?.column) ? body.sortBy.column : 'name';
    const order = String(body.sortBy?.order || 'asc').toLowerCase() === 'desc' ? 'desc' : 'asc';
    const search = String(body.search || '');
    const like = prefix.replace(/[\\%_]/g, '\\$&') + '%';
    const rows = await asRole(ctx.pool, claims, async (c) =>
      (
        await c.query(
          `with o as (
             select id, updated_at, created_at, last_accessed_at, metadata, substr(name, $3::int) as rest
               from storage.objects where bucket_id = $1 and name like $2 escape '\\'
           ), entries as (
             select split_part(rest, '/', 1) as name, null::uuid as id, null::timestamptz as updated_at,
                    null::timestamptz as created_at, null::timestamptz as last_accessed_at, null::jsonb as metadata
               from o where position('/' in rest) > 0
             group by split_part(rest, '/', 1)
             union all
             select rest, id, updated_at, created_at, last_accessed_at, metadata from o where position('/' in rest) = 0
           )
           select * from entries where ($4 = '' or name ilike $4 || '%' escape '\\')
           order by ${col} ${order} nulls ${order === 'asc' ? 'first' : 'last'}, name
           limit $5 offset $6`,
          // search matches the start of names, as on Supabase.
          [req.params.bucket, like, prefix.length + 1, search.replace(/[\\%_]/g, '\\$&'), limit, offset],
        )
      ).rows,
    );
    sendJson(res, 200, rows);
  });

  router.post('/object/move', async (req, res) => {
    const ctx = ctxOf(req, res);
    const claims = claimsOf(ctx);
    const body = await readJson(req);
    const bucket = String(body.bucketId || '');
    const dest = String(body.destinationBucket || bucket);
    const from = validName(String(body.sourceKey || ''));
    const to = validName(String(body.destinationKey || ''));
    if (dest !== bucket) throw e(400, 'InvalidRequest', 'Moving objects between buckets is not supported yet');
    try {
      const r = await asRole(ctx.pool, claims, (c) =>
        c.query('update storage.objects set name = $3, updated_at = now() where bucket_id = $1 and name = $2', [bucket, from, to]),
      );
      if (!r.rowCount) throw e(404, 'not_found', 'Object not found');
    } catch (err) {
      if ((err as { code?: string }).code === '23505') throw e(409, 'Duplicate', 'The resource already exists');
      throw err;
    }
    sendJson(res, 200, { message: 'Successfully moved' });
  });

  router.post('/object/copy', async (req, res) => {
    const ctx = ctxOf(req, res);
    const claims = claimsOf(ctx);
    const body = await readJson(req);
    const bucket = String(body.bucketId || '');
    const dest = String(body.destinationBucket || bucket);
    const from = validName(String(body.sourceKey || ''));
    const to = validName(String(body.destinationKey || ''));
    const destBucket = await getBucket(ctx, dest);
    const who = owner(claims);
    let newFile: string | null = null;
    try {
      const row = await asRole(ctx.pool, claims, async (c) => {
        const src = (await c.query('select * from storage.objects where bucket_id = $1 and name = $2', [bucket, from])).rows[0] as ObjectRow | undefined;
        if (!src) throw e(404, 'not_found', 'Object not found');
        const srcFile = objectPath(ctx.project.dbName, bucket, src.id, src.version || 'v0');
        const stat = await fs.promises.stat(srcFile).catch(() => null);
        if (!stat) throw e(404, 'not_found', 'Object not found');
        // The copy must fit the destination bucket's limits, as an upload there would.
        if (stat.size > sizeLimit(destBucket)) throw e(413, 'Payload too large', 'The object exceeded the maximum allowed size');
        const meta = src.metadata || {};
        const mimetype = acceptType(destBucket, normalizeContentType(meta.mimetype) ?? DEFAULT_CONTENT_TYPE);
        const version = crypto.randomUUID();
        const id = crypto.randomUUID();
        // Copying needs SELECT on the source and only INSERT on the destination.
        await c.query(
          `insert into storage.objects (id, bucket_id, name, owner, owner_id, metadata, version, user_metadata)
           values ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [id, dest, to, who.owner, who.owner_id, { ...meta, mimetype }, version, src.user_metadata],
        );
        newFile = objectPath(ctx.project.dbName, dest, id, version);
        await copyFile(srcFile, newFile);
        return { id };
      });
      sendJson(res, 200, { Id: row.id, Key: `${dest}/${to}` });
    } catch (err) {
      if (newFile) await removeFile(newFile).catch(() => {});
      if ((err as { code?: string }).code === '42501') throw e(403, 'Unauthorized', 'new row violates row-level security policy');
      if ((err as { code?: string }).code === '23505') throw e(409, 'Duplicate', 'The resource already exists');
      throw err;
    }
  });

  // ---------------------------------------------------------------- signed URLs
  router.post('/object/sign/:bucket', async (req, res) => {
    const ctx = ctxOf(req, res);
    const claims = claimsOf(ctx);
    const body = await readJson(req);
    const paths: string[] = Array.isArray(body.paths) ? body.paths.map(String) : [];
    const expiresIn = Number(body.expiresIn) || 60;
    const found = await asRole(ctx.pool, claims, async (c) =>
      (await c.query('select name from storage.objects where bucket_id = $1 and name = any($2)', [req.params.bucket, paths])).rows.map((r) => r.name as string),
    );
    sendJson(
      res,
      200,
      paths.map((p) =>
        found.includes(p)
          ? { error: null, path: p, signedURL: `/object/sign/${encodePath(req.params.bucket)}/${encodePath(p)}?token=${signToken(ctx, { kind: 'storage-sign', url: `${req.params.bucket}/${p}` }, expiresIn)}` }
          : { error: 'Either the object does not exist or you do not have access to it', path: p, signedURL: null },
      ),
    );
  });

  router.post('/object/sign/:bucket/*', async (req, res) => {
    const ctx = ctxOf(req, res);
    const body = await readJson(req);
    const name = validName(req.params['*']);
    await findAsUser(ctx, req.params.bucket, name);
    const url = `${req.params.bucket}/${name}`;
    const transform = body.transform && typeof body.transform === 'object' && Object.keys(body.transform).length ? body.transform : undefined;
    const token = signToken(ctx, { kind: 'storage-sign', url, transform }, Number(body.expiresIn) || 60);
    // With a transform the link points at the image renderer, as on Supabase.
    const route = transform ? '/render/image/sign' : '/object/sign';
    sendJson(res, 200, { signedURL: `${route}/${encodePath(req.params.bucket)}/${encodePath(name)}?token=${token}` });
  });

  router.get('/object/sign/:bucket/*', async (req, res) => {
    const ctx = ctxOf(req, res);
    const name = validName(req.params['*']);
    readSigned(ctx, 'storage-sign', `${req.params.bucket}/${name}`);
    const o = await findAsAdmin(ctx, req.params.bucket, name);
    await streamObject(ctx, o, { download: req.query.get('download') });
  });

  router.post('/object/upload/sign/:bucket/*', async (req, res) => {
    const ctx = ctxOf(req, res);
    const claims = claimsOf(ctx);
    const name = validName(req.params['*']);
    await getBucket(ctx, req.params.bucket);
    const upsert = String(req.headers['x-upsert'] || '') === 'true';
    // Prove now that the caller may write this key: try the insert under RLS, with the role and
    // claims set up exactly as for any other request (asRole), and roll it back.
    const who = owner(claims);
    const rolledBack = Symbol('probe rolled back');
    try {
      await asRole(ctx.pool, claims, async (c) => {
        await c.query(
          upsert
            ? `insert into storage.objects (bucket_id, name, owner, owner_id) values ($1, $2, $3, $4)
               on conflict (bucket_id, name) do update set updated_at = now()`
            : `insert into storage.objects (bucket_id, name, owner, owner_id) values ($1, $2, $3, $4)`,
          [req.params.bucket, name, who.owner, who.owner_id],
        );
        throw rolledBack; // makes asRole roll the transaction back
      });
    } catch (err) {
      if (err !== rolledBack) {
        const code = (err as { code?: string }).code;
        // 42501 also covers a token whose role isn't an API role.
        if (code === '42501') throw e(403, 'Unauthorized', 'new row violates row-level security policy');
        if (code === '23505') throw e(409, 'Duplicate', 'The resource already exists');
        throw err;
      }
    }
    const url = `${req.params.bucket}/${name}`;
    const token = signToken(ctx, { kind: 'storage-upload', url, upsert, owner: claims.sub || null }, 2 * 3600);
    sendJson(res, 200, { url: `/object/upload/sign/${encodePath(req.params.bucket)}/${encodePath(name)}?token=${token}`, token });
  });

  router.put('/object/upload/sign/:bucket/*', async (req, res) => {
    const ctx = ctxOf(req, res);
    const name = validName(req.params['*']);
    const t = readSigned(ctx, 'storage-upload', `${req.params.bucket}/${name}`);
    const out = await store(ctx, req.params.bucket, name, t.upsert ? 'upsert' : 'create', { role: 'service_role', sub: (t.owner as string) || undefined }, true);
    sendJson(res, 200, { Key: out.Key, Id: out.Id });
  });

  // ---------------------------------------------------------------- public and authenticated reads
  router.get('/object/public/:bucket/*', async (req, res) => {
    const ctx = ctxOf(req, res);
    const name = validName(req.params['*']);
    const bucket = await getBucket(ctx, req.params.bucket);
    if (!bucket.public) throw e(400, 'not_found', 'Object not found');
    const o = await findAsAdmin(ctx, bucket.id, name);
    await streamObject(ctx, o, { download: req.query.get('download') });
  });

  router.get('/object/authenticated/:bucket/*', async (req, res) => {
    const ctx = ctxOf(req, res);
    const o = await findAsUser(ctx, req.params.bucket, validName(req.params['*']));
    await streamObject(ctx, o, { download: req.query.get('download') });
  });

  const info = async (ctx: Ctx, publicOnly: boolean) => {
    const name = validName(ctx.req.params['*']);
    let o: ObjectRow;
    if (publicOnly) {
      const bucket = await getBucket(ctx, ctx.req.params.bucket);
      if (!bucket.public) throw e(404, 'not_found', 'Object not found');
      o = await findAsAdmin(ctx, bucket.id, name);
    } else {
      o = await findAsUser(ctx, ctx.req.params.bucket, name);
    }
    const m = o.metadata || {};
    sendJson(ctx.res, 200, {
      id: o.id,
      name: o.name,
      version: o.version,
      size: m.size,
      content_type: m.mimetype,
      cache_control: m.cacheControl,
      etag: m.eTag,
      metadata: o.user_metadata,
      last_modified: o.updated_at,
      created_at: o.created_at,
      bucket_id: o.bucket_id,
    });
  };
  router.get('/object/info/public/:bucket/*', (req, res) => info(ctxOf(req, res), true));
  router.get('/object/info/authenticated/:bucket/*', (req, res) => info(ctxOf(req, res), false));
  router.get('/object/info/:bucket/*', (req, res) => info(ctxOf(req, res), false));

  // ---------------------------------------------------------------- image transformations
  const render = async (ctx: Ctx, o: ObjectRow, transform?: Record<string, unknown>) => {
    // A signed URL's transform is fixed by its token; otherwise use the query.
    const q = ctx.req.query;
    const opt = (k: string): unknown => (transform ? transform[k] : q.get(k)) ?? undefined;
    const width = clampInt(opt('width'), 1, 2500);
    const height = clampInt(opt('height'), 1, 2500);
    const quality = clampInt(opt('quality'), 20, 100) || 80;
    const resize = String(opt('resize') ?? 'cover');
    const format = String(opt('format') ?? '');
    const rt = resize === 'contain' ? 'fit' : resize === 'fill' ? 'force' : 'fill';
    const src = `local:///${relativeObjectPath(ctx.project.dbName, o.bucket_id, o.id, o.version || 'v0')}`;
    const wantsWebp = format !== 'origin' && /image\/webp/.test(String(ctx.req.headers.accept || ''));
    const pathPart = `/rs:${rt}:${width || 0}:${height || 0}/q:${quality}/plain/${src}${wantsWebp ? '@webp' : ''}`;
    const signature = imgproxySignature(pathPart);
    await new Promise<void>((resolve) => {
      const up = http.get(new URL(`/${signature}${pathPart}`, config.services.imgproxy), (r) => {
        if ((r.statusCode || 500) >= 400) {
          r.resume();
          const status = r.statusCode === 404 ? 404 : 422;
          sendJson(ctx.res, status, { statusCode: String(status), error: 'transformation_failed', message: 'Unable to transform this image' });
          return resolve();
        }
        const type = normalizeContentType(r.headers['content-type'] || 'image/webp') ?? DEFAULT_CONTENT_TYPE;
        ctx.res.writeHead(200, {
          'Content-Type': type,
          'Cache-Control': String(o.metadata?.cacheControl || 'max-age=3600'),
          'X-Content-Type-Options': 'nosniff',
          // imgproxy can pass an SVG through.
          ...(isPassiveType(type) ? {} : { 'Content-Security-Policy': SANDBOX_CSP }),
          ...(r.headers['content-length'] ? { 'Content-Length': String(r.headers['content-length']) } : {}),
        });
        r.pipe(ctx.res);
        r.on('end', resolve);
      });
      up.on('error', () => {
        sendJson(ctx.res, 503, { statusCode: '503', error: 'transformation_unavailable', message: 'Image transformation service (keel-imgproxy) is not running' });
        resolve();
      });
    });
  };

  router.get('/render/image/public/:bucket/*', async (req, res) => {
    const ctx = ctxOf(req, res);
    const bucket = await getBucket(ctx, req.params.bucket);
    if (!bucket.public) throw e(400, 'not_found', 'Object not found');
    await render(ctx, await findAsAdmin(ctx, bucket.id, validName(req.params['*'])));
  });
  router.get('/render/image/authenticated/:bucket/*', async (req, res) => {
    const ctx = ctxOf(req, res);
    await render(ctx, await findAsUser(ctx, req.params.bucket, validName(req.params['*'])));
  });
  router.get('/render/image/sign/:bucket/*', async (req, res) => {
    const ctx = ctxOf(req, res);
    const name = validName(req.params['*']);
    const t = readSigned(ctx, 'storage-sign', `${req.params.bucket}/${name}`);
    // The token decides the size: a link signed without a transform can't be resized via the query.
    await render(ctx, await findAsAdmin(ctx, req.params.bucket, name), (t.transform as Record<string, unknown>) || {});
  });

  // ---------------------------------------------------------------- generic object routes (keep last)
  router.post('/object/:bucket/*', async (req, res) => {
    const ctx = ctxOf(req, res);
    const claims = claimsOf(ctx);
    const upsert = String(req.headers['x-upsert'] || '') === 'true';
    sendJson(res, 200, await store(ctx, req.params.bucket, req.params['*'], upsert ? 'upsert' : 'create', claims));
  });

  router.put('/object/:bucket/*', async (req, res) => {
    const ctx = ctxOf(req, res);
    const claims = claimsOf(ctx);
    sendJson(res, 200, await store(ctx, req.params.bucket, req.params['*'], 'update', claims));
  });

  router.delete('/object/:bucket', async (req, res) => {
    const ctx = ctxOf(req, res);
    const claims = claimsOf(ctx);
    const body = await readJson(req);
    const prefixes: string[] = Array.isArray(body.prefixes) ? body.prefixes.map(String) : [];
    if (!prefixes.length) throw e(400, 'InvalidRequest', 'prefixes must not be empty');
    const rows = await asRole(ctx.pool, claims, async (c) =>
      (await c.query('delete from storage.objects where bucket_id = $1 and name = any($2) returning *', [req.params.bucket, prefixes])).rows as ObjectRow[],
    );
    await deleteRows(ctx, rows);
    sendJson(res, 200, rows.map(objectJson));
  });

  router.delete('/object/:bucket/*', async (req, res) => {
    const ctx = ctxOf(req, res);
    const claims = claimsOf(ctx);
    const name = validName(req.params['*']);
    const rows = await asRole(ctx.pool, claims, async (c) =>
      (await c.query('delete from storage.objects where bucket_id = $1 and name = $2 returning *', [req.params.bucket, name])).rows as ObjectRow[],
    );
    if (!rows.length) throw e(404, 'not_found', 'Object not found');
    await deleteRows(ctx, rows);
    sendJson(res, 200, { message: 'Successfully deleted' });
  });

  router.get('/object/:bucket/*', async (req, res) => {
    const ctx = ctxOf(req, res);
    const o = await findAsUser(ctx, req.params.bucket, validName(req.params['*']));
    await streamObject(ctx, o, { download: req.query.get('download') });
  });

  const server = createServer('keel-storage', router, (err) => ({
    status: err.status,
    body: { statusCode: String(err.status), error: err.code || 'error', message: err.message },
  }));
  server.requestTimeout = 0; // large uploads
  limitServer(server, 'keel-storage', { bodyIdleMs: config.limits.bodyIdleTimeout * 1000, connectionsPerIp: config.limits.connectionsPerIp });
  await listen(server, config.ports.storage, 'keel-storage');
}

function encodePath(p: string): string {
  return p.split('/').map(encodeURIComponent).join('/');
}

function parseSize(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number') return v > 0 ? Math.floor(v) : null;
  const m = /^(\d+(?:\.\d+)?)\s*(b|kb|mb|gb)?$/i.exec(String(v).trim());
  if (!m) throw new HttpError(400, 'Invalid file size limit', 'Invalid Input');
  const mult = { b: 1, kb: 1024, mb: 1024 ** 2, gb: 1024 ** 3 }[(m[2] || 'b').toLowerCase() as 'b'];
  return Math.floor(Number(m[1]) * mult);
}

function clampInt(v: unknown, min: number, max: number): number {
  const n = Number.parseInt(String(v ?? ''), 10);
  // 0 (or less) means "not set", like a missing value.
  if (Number.isNaN(n) || n <= 0) return 0;
  return Math.max(min, Math.min(max, n));
}

function imgproxySignature(pathPart: string): string {
  const { imgproxyKey, imgproxySalt } = config.storage;
  if (!imgproxyKey || !imgproxySalt) return 'insecure';
  const hmac = crypto.createHmac('sha256', Buffer.from(imgproxyKey, 'hex'));
  hmac.update(Buffer.from(imgproxySalt, 'hex'));
  hmac.update(pathPart);
  return hmac.digest('base64url');
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}
