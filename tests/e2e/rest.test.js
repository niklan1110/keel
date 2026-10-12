import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { client, ensureSchema, keys, newUser, uniq } from './helpers.js';

before(ensureSchema);

test('row level security isolates users and anon', async () => {
  const { anon, service } = await keys();
  const a = await newUser();
  const b = await newUser();

  const ins = await a.client.from('todos').insert({ title: 'buy leeks' }).select().single();
  assert.equal(ins.error, null);
  assert.equal(ins.data.user_id, a.user.id);
  assert.equal(ins.data.done, false);

  const mine = await a.client.from('todos').select('*').eq('id', ins.data.id);
  assert.equal(mine.data.length, 1);

  const theirs = await b.client.from('todos').select('*').eq('id', ins.data.id);
  assert.equal(theirs.error, null);
  assert.equal(theirs.data.length, 0, 'other users must not see the row');

  const sneaky = await b.client.from('todos').update({ title: 'hacked' }).eq('id', ins.data.id).select();
  assert.equal(sneaky.data.length, 0);

  const forged = await b.client.from('todos').insert({ title: 'x', user_id: a.user.id });
  assert.ok(forged.error, 'inserting as someone else must fail');

  const anonRead = await client(anon).from('todos').select('*');
  assert.equal(anonRead.data.length, 0);

  const all = await client(service).from('todos').select('id').eq('id', ins.data.id);
  assert.equal(all.data.length, 1, 'service role bypasses RLS');
});

test('PostgREST query features work through the gateway', async () => {
  const { anon, service } = await keys();
  const admin = client(service);
  const tag = uniq('t');
  const rows = [
    { body: `${tag} alpha`, tags: ['x', 'y'], meta: { n: 1 } },
    { body: `${tag} beta`, tags: ['y'], meta: { n: 2 } },
    { body: `${tag} gamma`, tags: [], meta: null },
  ];
  const ins = await admin.from('notes').insert(rows).select();
  assert.equal(ins.error, null);
  assert.equal(ins.data.length, 3);

  const pub = client(anon);
  const filtered = await pub
    .from('notes')
    .select('body, meta', { count: 'exact' })
    .like('body', `${tag}%`)
    .contains('tags', ['y'])
    .order('body', { ascending: false });
  assert.equal(filtered.error, null);
  assert.equal(filtered.count, 2);
  assert.deepEqual(filtered.data.map((r) => r.body), [`${tag} beta`, `${tag} alpha`]);

  const one = await pub.from('notes').select('meta->n').eq('body', `${tag} beta`).single();
  assert.equal(one.data.n, 2);

  const ranged = await pub.from('notes').select('id').like('body', `${tag}%`).range(0, 1);
  assert.equal(ranged.data.length, 2);

  const rpc = await pub.rpc('add_numbers', { a: 2, b: 40 });
  assert.equal(rpc.error, null);
  assert.equal(rpc.data, 42);

  const denied = await pub.from('notes').insert({ body: 'nope' });
  assert.ok(denied.error, 'anon has no insert policy on notes');
});

test('new tables get row level security automatically', async () => {
  const { service, anon } = await keys();
  const { sql } = await import('./helpers.js');
  const name = uniq('auto_rls_');
  const { db } = await keys();
  await sql(db, `create table public.${name} (id int primary key, v text); insert into public.${name} values (1, 'secret');`);
  const { rows } = await sql(db, `select relrowsecurity from pg_class where relname = $1`, [name]);
  assert.equal(rows[0].relrowsecurity, true);
  await new Promise((r) => setTimeout(r, 700)); // schema cache reload
  const anonRead = await client(anon).from(name).select('*');
  assert.equal(anonRead.error, null);
  assert.equal(anonRead.data.length, 0);
  const svc = await client(service).from(name).select('*');
  assert.equal(svc.data.length, 1);
  await sql(db, `drop table public.${name}`);
});
