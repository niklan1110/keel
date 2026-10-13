import { test, before, after } from 'node:test';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { GATEWAY, STUDIO, env, sessionFrom, studioHeaders, uniq } from './helpers.js';
import { createClient } from '@supabase/supabase-js';

let token;
const project = `e2e-${Date.now().toString(36)}`;
const P = `/api/projects/${project}`;

async function call(method, path, body, raw) {
  const res = await fetch(`${STUDIO}${path}`, {
    method,
    headers: {
      ...studioHeaders(token),
      ...(raw ? { 'Content-Type': raw.type } : body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    body: raw ? raw.body : body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }
  // `token` is the session from a sign-in's cookie.
  return { status: res.status, data, token: sessionFrom(res) };
}

before(async () => {
  const bad = await call('POST', '/api/login', { username: 'admin', password: 'wrong' });
  assert.equal(bad.status, 401);
  const r = await call('POST', '/api/login', { username: env.KEEL_DASHBOARD_USERNAME || 'admin', password: env.KEEL_DASHBOARD_PASSWORD });
  assert.equal(r.status, 200);
  token = r.token;
  const c = await call('POST', '/api/projects', { name: project });
  assert.equal(c.status, 201, JSON.stringify(c.data));
});

after(async () => {
  if (token) await call('DELETE', P, { confirm: project });
});

test('API requires a session', async () => {
  const saved = token;
  token = null;
  assert.equal((await call('GET', '/api/projects')).status, 401);
  token = 'not-a-token';
  assert.equal((await call('GET', '/api/projects')).status, 401);
  token = saved;
});

test('project names are validated', async () => {
  assert.equal((await call('POST', '/api/projects', { name: 'Bad Name' })).status, 400);
  assert.equal((await call('POST', '/api/projects', { name: 'api' })).status, 400);
  assert.equal((await call('POST', '/api/projects', { name: project })).status, 409);
});

test('new project is reachable through the gateway', async () => {
  const info = (await call('GET', `${P}/connect`)).data;
  assert.equal(info.apiUrl.endsWith(`/${project}`), true);
  // PostgREST for the new project may take a moment to start.
  let ok = false;
  for (let i = 0; i < 40 && !ok; i++) {
    const res = await fetch(`${GATEWAY}/${project}/rest/v1/`, { headers: { apikey: info.anonKey } });
    ok = res.status === 200;
    if (!ok) await new Promise((r) => setTimeout(r, 500));
  }
  assert.ok(ok, 'REST API for the new project came up');
  // Keys from one project must not work on another.
  const other = await fetch(`${GATEWAY}/my-app/rest/v1/`, { headers: { apikey: info.anonKey } });
  assert.equal(other.status, 401);
});

test('create table, edit rows, policies, realtime toggle', async () => {
  const create = await call('POST', `${P}/tables`, {
    schema: 'public',
    name: 'books',
    rls: true,
    realtime: true,
    columns: [
      { name: 'id', type: 'int8', default: 'identity', pk: true, nullable: false },
      { name: 'title', type: 'text', nullable: false },
      { name: 'pages', type: 'int4' },
      { name: 'meta', type: 'jsonb', default: "'{}'" },
      { name: 'owner', type: 'uuid', default: 'auth.uid()', references: 'auth.users.id' },
    ],
  });
  assert.equal(create.status, 201, JSON.stringify(create.data));

  const schema = (await call('GET', `${P}/schema?schema=public`)).data;
  const books = schema.tables.find((t) => t.name === 'books');
  assert.ok(books);
  assert.equal(books.rls, true);
  assert.equal(books.realtime, true);
  assert.deepEqual(books.columns.find((c) => c.name === 'owner').fk, { schema: 'auth', table: 'users', column: 'id' });

  const ins = await call('POST', `${P}/tables/public/books/rows`, { values: { title: 'Dune', pages: '412', meta: '{"genre":"sf"}' } });
  assert.equal(ins.status, 201, JSON.stringify(ins.data));
  const id = ins.data.row[0];
  await call('POST', `${P}/tables/public/books/rows`, { values: { title: 'Emma', pages: null } });

  const rows = (await call('GET', `${P}/tables/public/books/rows?order=title.desc&filters=${encodeURIComponent(JSON.stringify([{ column: 'pages', op: 'is_null' }]))}`)).data;
  assert.equal(rows.total, 1);
  assert.equal(rows.rows[0][1], 'Emma');

  const up = await call('PATCH', `${P}/tables/public/books/rows`, { key: { id }, values: { pages: '500' } });
  assert.equal(up.status, 200);
  assert.equal(up.data.row[2], '500');

  const pol = await call('POST', `${P}/tables/public/books/policies`, { name: 'Anyone can read', command: 'SELECT', roles: ['anon', 'authenticated'], using: 'true' });
  assert.equal(pol.status, 201, JSON.stringify(pol.data));
  const pols = (await call('GET', `${P}/tables/public/books/policies`)).data;
  assert.equal(pols.policies.length, 1);
  assert.equal(pols.policies[0].cmd, 'SELECT');

  // The new policy is live for API clients.
  const info = (await call('GET', `${P}/connect`)).data;
  await new Promise((r) => setTimeout(r, 700));
  const sb = createClient(info.apiUrl, info.anonKey, { auth: { persistSession: false } });
  const read = await sb.from('books').select('title').order('title');
  assert.equal(read.error, null);
  assert.deepEqual(read.data.map((b) => b.title), ['Dune', 'Emma']);

  const bad = await call('POST', `${P}/tables/public/books/policies`, { name: 'broken', command: 'SELECT', using: 'nonsense(' });
  assert.equal(bad.status, 400);

  assert.equal((await call('PUT', `${P}/tables/public/books/settings`, { realtime: false })).status, 200);
  assert.equal((await call('DELETE', `${P}/tables/public/books/policies/${encodeURIComponent('Anyone can read')}`)).status, 200);
  assert.equal((await call('DELETE', `${P}/tables/public/books/rows`, { keys: [{ id }] })).data.deleted, 1);
  assert.equal((await call('DELETE', `${P}/tables/public/books`, { confirm: 'wrong' })).status, 400);
  assert.equal((await call('DELETE', `${P}/tables/public/books`, { confirm: 'books' })).status, 200);
});

test('SQL editor runs statements and reports errors with position', async () => {
  const ok = await call('POST', `${P}/sql`, { query: "create table t1 (a int); insert into t1 values (1), (2); select a, a * 2 as b, now() as at from t1 order by a" });
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  assert.equal(ok.data.results.length, 3);
  const last = ok.data.results[2];
  assert.deepEqual(last.fields.map((f) => f.type), ['int4', 'int4', 'timestamptz']);
  assert.deepEqual(last.rows.map((r) => r[1]), ['2', '4']);

  const bad = await call('POST', `${P}/sql`, { query: 'select 1;\nselect nope from t1' });
  assert.equal(bad.status, 400);
  assert.match(bad.data.message, /nope/);
  assert.ok(bad.data.position > 10);

  // A dangling BEGIN must not poison later queries.
  await call('POST', `${P}/sql`, { query: 'begin; insert into t1 values (3)' });
  const after = await call('POST', `${P}/sql`, { query: 'select count(*) from t1' });
  assert.equal(after.data.results[0].rows[0][0], '2');

  const saved = await call('POST', `${P}/queries`, { name: 'Count t1', sql: 'select count(*) from t1' });
  assert.equal(saved.status, 201);
  const list = (await call('GET', `${P}/queries`)).data;
  assert.ok(list.some((q) => q.id === saved.data.id));
  assert.equal((await call('DELETE', `${P}/queries/${saved.data.id}`)).status, 200);
});

test('users: create, invite link, recovery link, ban, delete', async () => {
  const email = `${uniq('studio')}@example.com`;
  const c = await call('POST', `${P}/users`, { email, password: 'secret-password' });
  assert.equal(c.status, 201, JSON.stringify(c.data));
  const inv = await call('POST', `${P}/users/invite`, { email: `${uniq('inv')}@example.com` });
  assert.equal(inv.status, 200);
  if (!inv.data.emailed) assert.match(inv.data.link, /\/auth\/v1\/verify\?token=/);
  const list = (await call('GET', `${P}/users?search=${encodeURIComponent(email)}`)).data;
  assert.equal(list.users.length, 1);
  const id = list.users[0].id;
  const rec = await call('POST', `${P}/users/${id}/recovery`);
  assert.equal(rec.status, 200);
  assert.equal((await call('POST', `${P}/users/${id}/ban`, { duration: '24h' })).status, 200);
  const banned = (await call('GET', `${P}/users?search=${encodeURIComponent(email)}`)).data.users[0];
  assert.ok(banned.bannedUntil);
  assert.equal((await call('DELETE', `${P}/users/${id}`)).status, 200);
});

test('auth settings round trip and secrets stay hidden', async () => {
  const put = await call('PUT', `${P}/settings`, {
    site_url: 'http://localhost:5173',
    uri_allow_list: ['http://localhost:5173/**'],
    external: { github: { enabled: true, client_id: 'abc', secret: 'shh' } },
  });
  assert.equal(put.status, 200, JSON.stringify(put.data));
  assert.equal(put.data.external.github.has_secret, true);
  assert.equal(JSON.stringify(put.data).includes('shh'), false);
  const info = (await call('GET', `${P}/connect`)).data;
  const s = await (await fetch(`${info.apiUrl}/auth/v1/settings`, { headers: { apikey: info.anonKey } })).json();
  assert.equal(s.external.github, true);
  assert.equal((await call('PUT', `${P}/settings`, { site_url: 'ftp://nope' })).status, 400);
});

test('storage through Studio: bucket, upload, list, signed URL, delete', async () => {
  assert.equal((await call('POST', `${P}/buckets`, { name: 'docs', public: false })).status, 201);
  const up = await call('POST', `${P}/buckets/docs/upload?path=${encodeURIComponent('a/hello.txt')}`, undefined, { type: 'text/plain', body: 'hi there' });
  assert.equal(up.status, 200, JSON.stringify(up.data));
  const root = (await call('GET', `${P}/buckets/docs/objects?prefix=`)).data;
  assert.deepEqual(root.map((e) => e.name), ['a']);
  const urls = (await call('POST', `${P}/buckets/docs/url`, { path: 'a/hello.txt' })).data;
  assert.equal(urls.publicUrl, null);
  assert.equal(await (await fetch(urls.signedUrl)).text(), 'hi there');
  const buckets = (await call('GET', `${P}/buckets`)).data;
  assert.equal(buckets.find((b) => b.id === 'docs').files, 1);
  assert.equal((await call('POST', `${P}/buckets/docs/delete`, { paths: ['a/'] })).data.deleted, 1);
  assert.equal((await call('DELETE', `${P}/buckets/docs`)).status, 200);
});

test('stack and logs', async () => {
  const stack = (await call('GET', '/api/stack')).data;
  assert.ok(stack.containers.length >= 6);
  const db = stack.containers.find((c) => c.service === 'keel-db');
  assert.equal(db.state, 'running');
  if (stack.docker) {
    const logs = (await call('GET', '/api/stack/keel-gateway/logs?tail=20')).data;
    assert.ok(Array.isArray(logs.lines));
    assert.equal((await call('POST', '/api/stack/keel-studio/stop')).status, 400);
  }
});

test('backup and restore', async () => {
  await call('POST', `${P}/sql`, { query: 'create table if not exists keepme (v text); insert into keepme values (\'before\')' });
  const b = await call('POST', `${P}/backups`);
  assert.equal(b.status, 201, JSON.stringify(b.data));
  assert.equal(b.data.status, 'ok');
  await call('POST', `${P}/sql`, { query: "update keepme set v = 'after'" });

  const link = (await call('POST', `${P}/backups/${b.data.id}/link`)).data;
  const dl = await fetch(`${STUDIO}${link.url}`);
  assert.equal(dl.status, 200);
  assert.ok(Number(dl.headers.get('content-length')) > 1000);
  await dl.arrayBuffer();

  assert.equal((await call('POST', `${P}/backups/${b.data.id}/restore`, { confirm: 'nope' })).status, 400);
  const r = await call('POST', `${P}/backups/${b.data.id}/restore`, { confirm: project });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const v = await call('POST', `${P}/sql`, { query: 'select v from keepme' });
  assert.equal(v.data.results[0].rows[0][0], 'before');
  assert.equal((await call('DELETE', `${P}/backups/${b.data.id}`)).status, 200);
});

test('backup download links work only while the session that made them is signed in', async () => {
  const b = await call('POST', `${P}/backups`);
  assert.equal(b.status, 201, JSON.stringify(b.data));

  // A second session asks for the link, then signs out.
  const second = await call('POST', '/api/login', { username: env.KEEL_DASHBOARD_USERNAME || 'admin', password: env.KEEL_DASHBOARD_PASSWORD });
  assert.equal(second.status, 200);
  const as = (t, method, path) => fetch(`${STUDIO}${path}`, { method, headers: studioHeaders(t) });
  const link = await (await as(second.token, 'POST', `${P}/backups/${b.data.id}/link`)).json();
  assert.match(link.url, /^\/api\/download\//);
  const ok = await fetch(`${STUDIO}${link.url}`);
  assert.equal(ok.status, 200);
  await ok.arrayBuffer();

  assert.equal((await as(second.token, 'POST', '/api/logout')).status, 200);
  const ended = await fetch(`${STUDIO}${link.url}`);
  assert.equal(ended.status, 403, 'the link stops working with its session');
  assert.equal((await ended.json()).error, 'expired');

  // Links signed the old way, with KEEL_SECRET itself and no session, are refused.
  if (env.KEEL_SECRET) {
    const now = Math.floor(Date.now() / 1000);
    const enc = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
    const body = `${enc({ alg: 'HS256', typ: 'JWT' })}.${enc({ kind: 'backup-download', file: `${project}/x.dump`, iat: now, exp: now + 60 })}`;
    const sig = crypto.createHmac('sha256', env.KEEL_SECRET).update(body).digest('base64url');
    assert.equal((await fetch(`${STUDIO}/api/download/${body}.${sig}`)).status, 403);
  }
  assert.equal((await fetch(`${STUDIO}/api/download/not-a-token`)).status, 403);
  assert.equal((await call('DELETE', `${P}/backups/${b.data.id}`)).status, 200);
});

test('successful sign-ins do not count towards the login limit', async () => {
  for (let i = 0; i < 12; i++) {
    const r = await fetch(`${STUDIO}/api/login`, {
      method: 'POST',
      headers: { ...studioHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: env.KEEL_DASHBOARD_USERNAME || 'admin', password: env.KEEL_DASHBOARD_PASSWORD }),
    });
    assert.equal(r.status, 200, `sign-in ${i + 1}`);
  }
});

test('stack lists keel-functions', async () => {
  const r = await call('GET', '/api/stack');
  assert.equal(r.status, 200);
  assert.ok(JSON.stringify(r.data).includes('keel-functions'));
});
