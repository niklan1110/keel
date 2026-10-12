import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { PROJECT_URL, client, ensureSchema, keys, newUser, png, sql, uniq } from './helpers.js';

before(async () => {
  await ensureSchema();
  const { service } = await keys();
  const admin = client(service);
  for (const [id, pub] of [['private-docs', false], ['public-images', true]]) {
    const { error } = await admin.storage.createBucket(id, { public: pub });
    if (error && !/exists/i.test(error.message)) throw error;
  }
});

test('buckets: service role manages, anon cannot create', async () => {
  const { service, anon } = await keys();
  const name = uniq('bucket-');
  const admin = client(service);
  const c = await admin.storage.createBucket(name, { public: false, fileSizeLimit: '1MB', allowedMimeTypes: ['text/*'] });
  assert.equal(c.error, null);
  const got = await admin.storage.getBucket(name);
  assert.equal(got.data.file_size_limit, 1024 * 1024);
  const list = await admin.storage.listBuckets();
  assert.ok(list.data.some((b) => b.id === name));

  const tooBig = await admin.storage.from(name).upload('big.txt', new Blob(['x'.repeat(1024 * 1024 + 10)], { type: 'text/plain' }));
  assert.ok(tooBig.error, 'file size limit enforced');
  const wrongType = await admin.storage.from(name).upload('a.png', new Blob(['png'], { type: 'image/png' }));
  assert.ok(wrongType.error, 'mime type allow list enforced');

  const denied = await client(anon).storage.createBucket(uniq('nope-'));
  assert.ok(denied.error);

  assert.equal((await admin.storage.deleteBucket(name)).error, null);
});

test('an oversized multipart upload is refused even when the body arrives slowly', async () => {
  const { service } = await keys();
  const admin = client(service);
  const name = uniq('bucket-');
  assert.equal((await admin.storage.createBucket(name, { fileSizeLimit: '1MB' })).error, null);
  const form = new FormData();
  form.append('', new Blob(['x'.repeat(1024 * 1024 + 10)], { type: 'text/plain' }), 'big.txt');
  const encoded = new Request('http://x/', { method: 'POST', body: form });
  const body = Buffer.from(await encoded.arrayBuffer());
  // Sent in small pieces, as a slow connection or Docker Desktop's port proxy delivers it.
  const status = await new Promise((resolve, reject) => {
    const rq = http.request(
      `${PROJECT_URL}/storage/v1/object/${name}/big.txt`,
      {
        method: 'POST',
        agent: false,
        headers: { 'content-type': encoded.headers.get('content-type'), 'content-length': body.length, authorization: `Bearer ${service}`, apikey: service },
      },
      (res) => {
        res.resume();
        resolve(res.statusCode);
      },
    );
    rq.setTimeout(15_000, () => rq.destroy(new Error('no answer: the upload hung')));
    rq.on('error', reject);
    let off = 0;
    const tick = () => {
      if (rq.destroyed) return;
      if (off >= body.length) return rq.end();
      rq.write(body.subarray(off, (off += 16384)));
      setTimeout(tick, 1);
    };
    tick();
  });
  assert.equal(status, 413);
  assert.equal((await admin.storage.deleteBucket(name)).error, null);
});

test('private bucket: owner folder policy, download, list, sign, move, delete', async () => {
  const a = await newUser();
  const b = await newUser();
  const store = a.client.storage.from('private-docs');
  const path = `${a.user.id}/notes/hello.txt`;

  const up = await store.upload(path, new Blob(['hello keel'], { type: 'text/plain' }));
  assert.equal(up.error, null);
  assert.equal(up.data.path, path);

  const dup = await store.upload(path, new Blob(['again'], { type: 'text/plain' }));
  assert.ok(dup.error, 'upload without upsert must not overwrite');
  const ups = await store.upload(path, new Blob(['hello again'], { type: 'text/plain' }), { upsert: true });
  assert.equal(ups.error, null);

  const dl = await store.download(path);
  assert.equal(dl.error, null);
  assert.equal(await dl.data.text(), 'hello again');

  const ls = await store.list(`${a.user.id}`);
  assert.equal(ls.error, null);
  assert.deepEqual(ls.data.map((x) => x.name), ['notes']);
  const ls2 = await store.list(`${a.user.id}/notes`);
  assert.equal(ls2.data[0].name, 'hello.txt');
  assert.equal(ls2.data[0].metadata.size, 11);

  const other = await b.client.storage.from('private-docs').download(path);
  assert.ok(other.error, 'another user cannot read the file');
  const intrude = await b.client.storage.from('private-docs').upload(`${a.user.id}/evil.txt`, new Blob(['x']));
  assert.ok(intrude.error, 'another user cannot write into the folder');

  const signed = await store.createSignedUrl(path, 60);
  assert.equal(signed.error, null);
  const res = await fetch(signed.data.signedUrl);
  assert.equal(res.status, 200);
  assert.equal(await res.text(), 'hello again');
  const tampered = await fetch(signed.data.signedUrl.replace('hello.txt', 'other.txt'));
  assert.notEqual(tampered.status, 200);

  const moved = await store.move(path, `${a.user.id}/notes/renamed.txt`);
  assert.equal(moved.error, null);
  const copied = await store.copy(`${a.user.id}/notes/renamed.txt`, `${a.user.id}/notes/copy.txt`);
  assert.equal(copied.error, null);
  assert.equal(await (await store.download(`${a.user.id}/notes/copy.txt`)).data.text(), 'hello again');

  const rm = await store.remove([`${a.user.id}/notes/renamed.txt`, `${a.user.id}/notes/copy.txt`]);
  assert.equal(rm.error, null);
  assert.equal(rm.data.length, 2);
});

test('public bucket serves files without a key, with safe headers', async () => {
  const { service } = await keys();
  const store = client(service).storage.from('public-images');
  const name = `${uniq('img')}.svg`;
  const svg = '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>';
  const up = await store.upload(name, new Blob([svg], { type: 'image/svg+xml' }));
  assert.equal(up.error, null);
  const { data } = store.getPublicUrl(name);
  const res = await fetch(data.publicUrl);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'image/svg+xml');
  assert.equal(res.headers.get('content-security-policy'), "sandbox; default-src 'none'");
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  const ranged = await fetch(data.publicUrl, { headers: { Range: 'bytes=0-3' } });
  assert.equal(ranged.status, 206);
  assert.equal(await ranged.text(), '<svg');
  await store.remove([name]);
});

test('signed upload URLs', async () => {
  const { service, anon } = await keys();
  const store = client(service).storage.from('public-images');
  const name = `${uniq('signed')}.txt`;
  const s = await store.createSignedUploadUrl(name);
  assert.equal(s.error, null);
  const up = await client(anon).storage.from('public-images').uploadToSignedUrl(name, s.data.token, new Blob(['via signed url'], { type: 'text/plain' }));
  assert.equal(up.error, null);
  const res = await fetch(store.getPublicUrl(name).data.publicUrl);
  assert.equal(await res.text(), 'via signed url');
  await store.remove([name]);
});

test('image transformations through imgproxy', async () => {
  const { service } = await keys();
  const { png } = await import('./helpers.js');
  const store = client(service).storage.from('public-images');
  const name = `${uniq('photo')}.png`;
  const up = await store.upload(name, new Blob([await png(400, 300)], { type: 'image/png' }));
  assert.equal(up.error, null);
  const { data } = store.getPublicUrl(name, { transform: { width: 100, height: 100, resize: 'cover' } });
  assert.match(data.publicUrl, /render\/image\/public/);
  const res = await fetch(data.publicUrl, { headers: { Accept: 'image/webp,image/*' } });
  assert.equal(res.status, 200, await res.clone().text());
  assert.equal(res.headers.get('content-type'), 'image/webp');
  const bytes = Buffer.from(await res.arrayBuffer());
  assert.equal(bytes.subarray(8, 12).toString(), 'WEBP');
  const orig = await fetch(store.getPublicUrl(name).data.publicUrl);
  assert.equal(orig.headers.get('content-type'), 'image/png');
  await store.remove([name]);
});

test('uploads need only an INSERT policy, as on Supabase', async () => {
  const { service, db } = await keys();
  const { sql } = await import('./helpers.js');
  const admin = client(service);
  const { error } = await admin.storage.createBucket('drop-box', { public: false });
  if (error && !/exists/i.test(error.message)) throw error;
  await sql(
    db,
    `drop policy if exists "drop box upload" on storage.objects;
     create policy "drop box upload" on storage.objects for insert to authenticated
       with check (bucket_id = 'drop-box' and (storage.foldername(name))[1] = auth.uid()::text);`,
  );
  const a = await newUser();
  const path = `${a.user.id}/${uniq('report')}.txt`;
  const up = await a.client.storage.from('drop-box').upload(path, new Blob(['for your eyes'], { type: 'text/plain' }));
  assert.equal(up.error, null, up.error?.message);
  // No SELECT policy: the uploader can't read it back, the service role can.
  assert.ok((await a.client.storage.from('drop-box').download(path)).error);
  const dl = await admin.storage.from('drop-box').download(path);
  assert.equal(await dl.data.text(), 'for your eyes');
  // Another user's folder is still refused.
  const b = await newUser();
  assert.ok((await b.client.storage.from('drop-box').upload(`${a.user.id}/x.txt`, new Blob(['x']))).error);
});

test('list search matches the start of names; cacheControl must be seconds', async () => {
  const { service } = await keys();
  const store = client(service).storage.from('public-images');
  const dir = uniq('search');
  for (const n of ['apple.txt', 'pineapple.txt', 'apricot.txt']) {
    const r = await store.upload(`${dir}/${n}`, new Blob([n], { type: 'text/plain' }), { cacheControl: n === 'apple.txt' ? 'no-cache' : '60' });
    assert.equal(r.error, null);
  }
  const ls = await store.list(dir, { search: 'ap' });
  assert.deepEqual(ls.data.map((x) => x.name).sort(), ['apple.txt', 'apricot.txt']);
  const odd = await fetch(store.getPublicUrl(`${dir}/apple.txt`).data.publicUrl);
  assert.equal(odd.headers.get('cache-control'), 'max-age=3600', 'invalid cacheControl falls back to the default');
  const ok = await fetch(store.getPublicUrl(`${dir}/apricot.txt`).data.publicUrl);
  assert.equal(ok.headers.get('cache-control'), 'max-age=60');
  await store.remove(['apple.txt', 'pineapple.txt', 'apricot.txt'].map((n) => `${dir}/${n}`));
});

test('signed URLs with a transform serve the resized image, and the size is fixed by the token', async () => {
  const { service } = await keys();
  const { png } = await import('./helpers.js');
  const store = client(service).storage.from('private-docs');
  const name = `${uniq('signed-photo')}.png`;
  assert.equal((await store.upload(name, new Blob([await png(400, 300)], { type: 'image/png' }))).error, null);
  const s = await store.createSignedUrl(name, 60, { transform: { width: 40, height: 30 } });
  assert.equal(s.error, null);
  assert.match(s.data.signedUrl, /\/render\/image\/sign\//);
  const width = (buf) => buf.readUInt32BE(16); // PNG IHDR
  const res = await fetch(s.data.signedUrl);
  assert.equal(res.status, 200);
  assert.equal(width(Buffer.from(await res.arrayBuffer())), 40);
  const tampered = await fetch(`${s.data.signedUrl}&width=400`);
  assert.equal(width(Buffer.from(await tampered.arrayBuffer())), 40, 'query parameters cannot change a signed transform');
  // A link signed without a transform can't be turned into a resize request.
  const plain = await store.createSignedUrl(name, 60);
  const resized = await fetch(`${plain.data.signedUrl.replace('/object/sign/', '/render/image/sign/')}&width=40`);
  assert.equal(width(Buffer.from(await resized.arrayBuffer())), 400);
  await store.remove([name]);
});

test('content types are normalized: a list of types is refused, anything not known to be inert is sandboxed', async () => {
  const { service, db } = await keys();
  const admin = client(service);
  const imgs = uniq('mime-img-');
  const any = uniq('mime-any-');
  assert.equal((await admin.storage.createBucket(imgs, { public: true, allowedMimeTypes: ['image/*'] })).error, null);
  assert.equal((await admin.storage.createBucket(any, { public: true })).error, null);
  const html = '<script>document.title = document.cookie</script>';
  const url = (bucket, name) => admin.storage.from(bucket).getPublicUrl(name).data.publicUrl;
  try {
    // "image/png, text/html" looks like an image to a prefix check, but browsers render it as HTML.
    for (const bucket of [imgs, any]) {
      const r = await admin.storage.from(bucket).upload('evil.png', html, { contentType: 'image/png, text/html' });
      assert.equal(r.error?.status, 415, `raw upload into ${bucket}: ${r.error?.message}`);
    }
    const form = new FormData();
    form.append('contentType', 'image/png, text/html');
    form.append('', new Blob([html]), 'evil.png');
    const mp = await fetch(`${PROJECT_URL}/storage/v1/object/${imgs}/evil.png`, { method: 'POST', headers: { Authorization: `Bearer ${service}` }, body: form });
    assert.equal(mp.status, 415, 'multipart contentType field');
    const s = await admin.storage.from(imgs).createSignedUploadUrl('signed-evil.png');
    assert.equal(s.error, null);
    const su = await admin.storage.from(imgs).uploadToSignedUrl('signed-evil.png', s.data.token, html, { contentType: 'image/png, text/html' });
    assert.equal(su.error?.status, 415, 'signed upload');

    // Valid types are stored lowercase; text types keep only their charset.
    assert.equal((await admin.storage.from(imgs).upload('ok.png', await png(2, 2), { contentType: 'IMAGE/PNG' })).error, null);
    let res = await fetch(url(imgs, 'ok.png'));
    assert.equal(res.headers.get('content-type'), 'image/png');
    assert.equal(res.headers.get('content-security-policy'), null, 'images are served as they are');
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    assert.equal((await admin.storage.from(any).upload('note.txt', 'hi', { contentType: 'Text/Plain; charset=UTF-8; format=flowed' })).error, null);
    res = await fetch(url(any, 'note.txt'));
    assert.equal(res.headers.get('content-type'), 'text/plain;charset=UTF-8');
    assert.equal(res.headers.get('content-security-policy'), null);
    const info = await fetch(`${PROJECT_URL}/storage/v1/object/info/${any}/note.txt`, { headers: { Authorization: `Bearer ${service}` } });
    assert.equal((await info.json()).content_type, 'text/plain;charset=UTF-8');

    // HTML, XML and types Keel doesn't know get the sandbox.
    for (const [name, type] of [['page.html', 'text/html'], ['data.xml', 'application/xml'], ['thing.bin', 'application/x-keel-unknown']]) {
      assert.equal((await admin.storage.from(any).upload(name, html, { contentType: type })).error, null, type);
      const r = await fetch(url(any, name));
      assert.equal(r.headers.get('content-type'), type);
      assert.equal(r.headers.get('content-security-policy'), "sandbox; default-src 'none'", type);
    }

    // A malformed type stored earlier (or set in SQL) is served as a plain download.
    await sql(db, `update storage.objects set metadata = metadata || '{"mimetype": "image/png, text/html"}' where bucket_id = $1 and name = 'ok.png'`, [imgs]);
    res = await fetch(url(imgs, 'ok.png'));
    assert.equal(res.headers.get('content-type'), 'application/octet-stream');
  } finally {
    for (const b of [imgs, any]) {
      await admin.storage.emptyBucket(b);
      await admin.storage.deleteBucket(b);
    }
  }
});

test("copy honors the destination bucket's allowed types and size limit", async () => {
  const { service } = await keys();
  const admin = client(service);
  const from = uniq('copy-src-');
  const to = uniq('copy-dst-');
  assert.equal((await admin.storage.createBucket(from, { public: false })).error, null);
  assert.equal((await admin.storage.createBucket(to, { public: false, allowedMimeTypes: ['image/*'], fileSizeLimit: 100 })).error, null);
  try {
    const src = admin.storage.from(from);
    assert.equal((await src.upload('page.html', '<p>hi</p>', { contentType: 'text/html' })).error, null);
    assert.equal((await src.upload('big.png', Buffer.alloc(500, 7), { contentType: 'image/png' })).error, null);
    assert.equal((await src.upload('small.png', Buffer.from('tiny'), { contentType: 'image/png' })).error, null);

    const wrongType = await src.copy('page.html', 'page.html', { destinationBucket: to });
    assert.equal(wrongType.error?.status, 415, wrongType.error?.message);
    const tooBig = await src.copy('big.png', 'big.png', { destinationBucket: to });
    assert.equal(tooBig.error?.status, 413, tooBig.error?.message);
    const ok = await src.copy('small.png', 'small.png', { destinationBucket: to });
    assert.equal(ok.error, null, ok.error?.message);
    assert.equal(await (await admin.storage.from(to).download('small.png')).data.text(), 'tiny');
    const listed = await admin.storage.from(to).list();
    assert.deepEqual(listed.data.map((x) => x.name), ['small.png'], 'nothing else reached the destination');
  } finally {
    for (const b of [from, to]) {
      await admin.storage.emptyBucket(b);
      await admin.storage.deleteBucket(b);
    }
  }
});

test("signed upload URLs check policies with the caller's claims on reused connections", async () => {
  const { anon } = await keys();
  const a = await newUser();
  const store = a.client.storage.from('private-docs');
  const made = [];
  // Each round first runs a normal request, so the signing request reuses a database
  // connection that has served another request: auth.uid() must still be this user.
  for (let i = 0; i < 4; i++) {
    const warm = `${a.user.id}/warm-${i}.txt`;
    assert.equal((await store.upload(warm, 'warm', { contentType: 'text/plain', upsert: true })).error, null);
    const name = `${a.user.id}/${uniq('signed')}.txt`;
    const s = await store.createSignedUploadUrl(name);
    assert.equal(s.error, null, `round ${i}: ${s.error?.message}`);
    const up = await client(anon).storage.from('private-docs').uploadToSignedUrl(name, s.data.token, 'via signed url', { contentType: 'text/plain' });
    assert.equal(up.error, null);
    assert.equal(await (await store.download(name)).data.text(), 'via signed url');
    made.push(warm, name);
  }
  const b = await newUser();
  const intrude = await b.client.storage.from('private-docs').createSignedUploadUrl(`${a.user.id}/intruder.txt`);
  assert.equal(intrude.error?.status, 403, "another user's folder is refused");
  await store.remove(made);
});

test('a version edited in SQL cannot point an object at another file', async () => {
  const { service, db } = await keys();
  const admin = client(service);
  const bucket = uniq('bucket-');
  assert.equal((await admin.storage.createBucket(bucket)).error, null);
  assert.equal((await admin.storage.from(bucket).upload('victim.txt', new Blob(['victim bytes'], { type: 'text/plain' }))).error, null);
  assert.equal((await admin.storage.from(bucket).upload('crafted.txt', new Blob(['crafted'], { type: 'text/plain' }))).error, null);
  const { rows } = await sql(db, `select name, id::text, version from storage.objects where bucket_id = $1`, [bucket]);
  const victim = rows.find((r) => r.name === 'victim.txt');
  // <root>/<db>/<bucket>/<crafted id>/../<victim id>/<victim version> is the victim's file.
  await sql(db, `update storage.objects set version = $2 where bucket_id = $1 and name = 'crafted.txt'`, [bucket, `../${victim.id}/${victim.version}`]);

  const read = await admin.storage.from(bucket).download('crafted.txt');
  assert.ok(read.error, 'the crafted row has no file');
  assert.notEqual(await read.data?.text?.(), 'victim bytes');

  assert.equal((await admin.storage.from(bucket).remove(['crafted.txt'])).error, null);
  const still = await admin.storage.from(bucket).download('victim.txt');
  assert.equal(still.error, null);
  assert.equal(await still.data.text(), 'victim bytes', 'deleting the crafted row left the other file alone');

  await admin.storage.from(bucket).remove(['victim.txt']);
  await admin.storage.deleteBucket(bucket);
});
