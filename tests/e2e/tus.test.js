import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import * as tus from 'tus-js-client';
import { PROJECT_URL, client, keys, newUser, sql } from './helpers.js';

const BUCKET = 'tus-e2e';
const endpoint = `${PROJECT_URL}/storage/v1/upload/resumable`;

before(async () => {
  const { service, db } = await keys();
  const admin = client(service);
  const { error } = await admin.storage.createBucket(BUCKET, { public: false });
  if (error && !/exists/i.test(error.message)) throw error;
  await sql(
    db,
    `drop policy if exists "tus own folder" on storage.objects;
     create policy "tus own folder" on storage.objects for all to authenticated
       using (bucket_id = '${BUCKET}' and (storage.foldername(name))[1] = auth.uid()::text)
       with check (bucket_id = '${BUCKET}' and (storage.foldername(name))[1] = auth.uid()::text);`,
  );
});

function upload(data, opts) {
  return new Promise((resolve, reject) => {
    const u = new tus.Upload(data, {
      endpoint,
      retryDelays: [0, 200],
      chunkSize: opts.chunkSize ?? 6 * 1024 * 1024,
      uploadDataDuringCreation: true,
      uploadUrl: opts.uploadUrl,
      headers: { authorization: `Bearer ${opts.token}`, 'x-upsert': opts.upsert ? 'true' : 'false' },
      metadata: { bucketName: BUCKET, objectName: opts.name, contentType: 'application/octet-stream', cacheControl: '3600' },
      onError: reject,
      onProgress: opts.onProgress,
      onChunkComplete: (chunk, sent, total) => opts.onChunk?.(u, sent, total),
      onSuccess: () => resolve(u),
    });
    if (opts.started) opts.started(u, reject);
    u.start();
  });
}

test('resumable upload with tus-js-client, interrupted and resumed', async () => {
  const a = await newUser();
  const data = crypto.randomBytes(1_500_000);
  const name = `${a.user.id}/big.bin`;

  // Stop after the second chunk, as if the network dropped.
  let firstUrl = null;
  await new Promise((resolve, reject) => {
    upload(data, {
      token: a.session.access_token,
      name,
      chunkSize: 256 * 1024,
      onChunk: (u, sent) => {
        if (sent >= 512 * 1024 && !firstUrl) {
          firstUrl = u.url;
          u.abort().then(resolve, reject);
        }
      },
    }).then(() => reject(new Error('upload should have been interrupted')), reject);
  });
  assert.match(firstUrl, /\/storage\/v1\/upload\/resumable\/[A-Za-z0-9_-]+$/);

  const head = await fetch(firstUrl, { method: 'HEAD', headers: { authorization: `Bearer ${a.session.access_token}`, 'tus-resumable': '1.0.0' } });
  assert.equal(head.status, 200);
  const offset = Number(head.headers.get('upload-offset'));
  assert.ok(offset >= 512 * 1024 && offset < data.length, `server kept ${offset} bytes`);
  assert.equal(Number(head.headers.get('upload-length')), data.length);

  // Someone else can't see or continue it.
  const b = await newUser();
  const other = await fetch(firstUrl, { method: 'HEAD', headers: { authorization: `Bearer ${b.session.access_token}`, 'tus-resumable': '1.0.0' } });
  assert.equal(other.status, 404);

  let resumedFrom = null;
  await upload(data, {
    token: a.session.access_token,
    name,
    uploadUrl: firstUrl,
    chunkSize: 256 * 1024,
    onProgress: (sent) => {
      if (resumedFrom === null) resumedFrom = sent;
    },
  });
  assert.ok(resumedFrom >= offset, 'continued where it stopped instead of starting over');

  const dl = await a.client.storage.from(BUCKET).download(name);
  assert.equal(dl.error, null);
  const got = Buffer.from(await dl.data.arrayBuffer());
  assert.equal(got.length, data.length);
  assert.ok(got.equals(data), 'downloaded bytes match');
  const gone = await fetch(firstUrl, { method: 'HEAD', headers: { authorization: `Bearer ${a.session.access_token}` } });
  assert.equal(gone.status, 404, 'finished uploads are cleaned up');
});

test('resumable uploads follow storage policies, upsert and termination', async () => {
  const a = await newUser();
  const b = await newUser();
  // b may not write into a's folder: refused before any bytes are sent.
  await assert.rejects(upload(Buffer.from('nope'), { token: b.session.access_token, name: `${a.user.id}/x.txt` }), (err) => {
    assert.equal(err.originalResponse.getStatus(), 403);
    return true;
  });

  const name = `${a.user.id}/small.txt`;
  await upload(Buffer.from('first'), { token: a.session.access_token, name });
  await assert.rejects(upload(Buffer.from('second'), { token: a.session.access_token, name }), (err) => err.originalResponse.getStatus() === 409);
  await upload(Buffer.from('second'), { token: a.session.access_token, name, upsert: true });
  const dl = await a.client.storage.from(BUCKET).download(name);
  assert.equal(await dl.data.text(), 'second');

  // Create without data, then cancel. The upload URL is a path, never built from
  // headers the client sends.
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${a.session.access_token}`,
      'x-forwarded-host': 'evil.example',
      'x-forwarded-proto': 'https',
      'tus-resumable': '1.0.0',
      'upload-length': '10',
      'upload-metadata': `bucketName ${Buffer.from(BUCKET).toString('base64')},objectName ${Buffer.from(`${a.user.id}/cancel.txt`).toString('base64')}`,
    },
  });
  assert.equal(res.status, 201);
  const location = res.headers.get('location');
  // A path without a host, so the client continues on the address it used (this one).
  assert.match(location, /^\/[^/].*\/storage\/v1\/upload\/resumable\/[^/]+$/);
  const url = new URL(location, endpoint).href;
  assert.equal(new URL(url).host, new URL(endpoint).host);
  const wrongOffset = await fetch(url, {
    method: 'PATCH',
    headers: { authorization: `Bearer ${a.session.access_token}`, 'tus-resumable': '1.0.0', 'upload-offset': '5', 'content-type': 'application/offset+octet-stream' },
    body: 'hello',
  });
  assert.equal(wrongOffset.status, 409);
  const del = await fetch(url, { method: 'DELETE', headers: { authorization: `Bearer ${a.session.access_token}`, 'tus-resumable': '1.0.0' } });
  assert.equal(del.status, 204);
  assert.equal((await fetch(url, { method: 'HEAD', headers: { authorization: `Bearer ${a.session.access_token}` } })).status, 404);
});

test('resumable uploads store a normalized content type and refuse a list of types', async () => {
  const { db } = await keys();
  const a = await newUser();
  const b64 = (v) => Buffer.from(v).toString('base64');
  const create = (name, contentType, body) =>
    fetch(endpoint, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${a.session.access_token}`,
        'tus-resumable': '1.0.0',
        'upload-length': String(body.length),
        'upload-metadata': `bucketName ${b64(BUCKET)},objectName ${b64(name)},contentType ${b64(contentType)}`,
        'content-type': 'application/offset+octet-stream',
      },
      body,
    });
  // Refused when the upload is created, before any bytes are kept.
  const evil = await create(`${a.user.id}/evil.png`, 'image/png, text/html', '<script>alert(1)</script>');
  assert.equal(evil.status, 415);
  assert.equal((await sql(db, 'select 1 from storage.objects where bucket_id = $1 and name = $2', [BUCKET, `${a.user.id}/evil.png`])).rowCount, 0);

  const name = `${a.user.id}/typed.png`;
  const ok = await create(name, 'IMAGE/PNG; name=typed.png', 'png!');
  assert.equal(ok.status, 201, await ok.text());
  const row = await sql(db, `select metadata->>'mimetype' as type from storage.objects where bucket_id = $1 and name = $2`, [BUCKET, name]);
  assert.equal(row.rows[0]?.type, 'image/png');
});
