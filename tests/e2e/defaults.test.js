import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { studio, sql } from './helpers.js';

// Project settings > Defaults: save the rows in a project's tables, change
// things, and put every table back with "Restore defaults". Runs in a project
// of its own, since a restore resets every table in the project.

const name = `defaults-${Date.now().toString(36)}`;
const db = name.replace(/-/g, '_');
const base = `/api/projects/${name}/defaults`;
const q = async (text) => (await sql(db, text)).rows;

before(async () => {
  const r = await studio('POST', '/api/projects', { name });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  await sql(
    db,
    `create table public.categories (
       id bigint generated always as identity primary key,
       name text not null unique,
       parent_id bigint references public.categories (id),
       slug text generated always as (lower(name)) stored
     );
     create table public.entries (
       id serial primary key,
       category_id bigint not null references public.categories (id) on delete cascade,
       owner uuid references auth.users (id) on delete cascade,
       note text,
       created_at timestamptz not null default now()
     );
     create schema app;
     create table app.settings (key text primary key, value jsonb not null);
     insert into public.categories (name) values ('Food'), ('Travel');
     insert into public.categories (name, parent_id) values ('Coffee', 1);
     insert into public.entries (category_id, note) values (1, 'lunch'), (3, 'flat white');
     insert into app.settings values ('theme', '{"dark": true}');`,
  );
});

after(async () => {
  await studio('DELETE', `/api/projects/${name}`, { confirm: name });
});

test('a project starts without saved defaults', async () => {
  const d = (await studio('GET', base)).data;
  assert.equal(d.savedAt, null);
  assert.deepEqual(d.tables, []);
  const r = await studio('POST', `${base}/restore`, { confirm: name });
  assert.equal(r.status, 400);
  assert.equal(r.data.error, 'no_defaults');
});

test('save, change things, restore: every table is back as it was', async () => {
  const saved = await studio('POST', `${base}/save`);
  assert.equal(saved.status, 200, JSON.stringify(saved.data));
  assert.ok(saved.data.savedAt);
  assert.equal(saved.data.rows, 6);
  assert.deepEqual(
    saved.data.tables.map((t) => `${t.schema}.${t.name}:${t.rows}`),
    ['app.settings:1', 'public.categories:3', 'public.entries:2'],
  );
  assert.deepEqual(saved.data.addedSince, []);

  // The app changes and deletes things, and a table is added.
  await sql(
    db,
    `delete from public.entries;
     delete from public.categories where name = 'Travel';
     update public.categories set name = 'Tea' where name = 'Coffee';
     insert into public.categories (name) values ('Mine');
     update app.settings set value = '{"dark": false}';
     create table public.later (id int primary key);
     insert into public.later values (1);`,
  );
  const before = (await studio('GET', base)).data;
  assert.deepEqual(before.addedSince, [{ schema: 'public', name: 'later' }]);

  assert.equal((await studio('POST', `${base}/restore`, { confirm: 'nope' })).status, 400);
  const r = await studio('POST', `${base}/restore`, { confirm: name });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.rows, 6);
  assert.deepEqual(r.data.emptied, ['public.later']);
  assert.ok(r.data.backup.id);

  assert.deepEqual(await q('select id::int, name, parent_id::int, slug from public.categories order by id'), [
    { id: 1, name: 'Food', parent_id: null, slug: 'food' },
    { id: 2, name: 'Travel', parent_id: null, slug: 'travel' },
    { id: 3, name: 'Coffee', parent_id: 1, slug: 'coffee' },
  ]);
  assert.deepEqual(await q('select id, category_id::int, note from public.entries order by id'), [
    { id: 1, category_id: 1, note: 'lunch' },
    { id: 2, category_id: 3, note: 'flat white' },
  ]);
  assert.deepEqual(await q('select value from app.settings'), [{ value: { dark: true } }]);
  assert.deepEqual(await q('select count(*)::int as n from public.later'), [{ n: 0 }]);

  // Id counters carry on after the restored rows.
  assert.deepEqual(await q(`insert into public.categories (name) values ('New') returning id::int`), [{ id: 4 }]);
  assert.deepEqual(await q('insert into public.entries (category_id) values (1) returning id'), [{ id: 3 }]);

  // Keel made a backup first, so the restore can be undone.
  const backups = (await studio('GET', `/api/projects/${name}/backups`)).data;
  assert.ok(backups.some((b) => b.id === r.data.backup.id && b.kind === 'before-defaults' && b.status === 'ok'));
});

test('a restore that would leave rows pointing at a deleted user changes nothing', async () => {
  const [u] = await q(`insert into auth.users (id, email) values (gen_random_uuid(), 'owner-${name}@example.com') returning id`);
  await sql(db, `insert into public.entries (category_id, owner, note) values (1, $1, 'mine')`, [u.id]);
  assert.equal((await studio('POST', `${base}/save`)).status, 200);
  await sql(db, 'delete from auth.users where id = $1', [u.id]);
  await sql(db, `insert into public.categories (name) values ('After')`);

  const r = await studio('POST', `${base}/restore`, { confirm: name });
  assert.equal(r.status, 400);
  assert.match(r.data.message, /^Nothing was changed: 1 saved row in public\.entries points at rows of auth\.users that no longer exist\./);
  // Untouched: the category added after saving is still there.
  assert.deepEqual(await q(`select count(*)::int as n from public.categories where name = 'After'`), [{ n: 1 }]);
});

test('restoring a backup keeps the saved defaults; they can be deleted', async () => {
  const saved = await studio('POST', `${base}/save`);
  assert.equal(saved.status, 200);
  const b = await studio('POST', `/api/projects/${name}/backups`);
  assert.equal(b.status, 201);
  await sql(db, `insert into public.categories (name) values ('Later still')`);
  await studio('POST', `${base}/save`);
  const savedAgain = (await studio('GET', base)).data;

  const restored = await studio('POST', `/api/projects/${name}/backups/${b.data.id}/restore`, { confirm: name });
  assert.equal(restored.status, 200, JSON.stringify(restored.data));
  const after = (await studio('GET', base)).data;
  assert.equal(after.savedAt, savedAgain.savedAt);
  assert.equal(after.rows, savedAgain.rows);

  const gone = await studio('DELETE', base);
  assert.equal(gone.status, 200);
  assert.equal(gone.data.savedAt, null);
});
