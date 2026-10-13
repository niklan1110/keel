import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { client, ensureSchema, keys, newUser, uniq, waitFor } from './helpers.js';

const cleanups = [];
before(ensureSchema);
after(async () => {
  for (const fn of cleanups) await fn().catch(() => {});
});

function subscribed(channel) {
  return new Promise((resolve, reject) => {
    channel.subscribe((status, err) => {
      if (status === 'SUBSCRIBED') resolve(channel);
      else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') reject(err || new Error(status));
    });
  });
}

test('postgres_changes respects row level security', async () => {
  const a = await newUser();
  const b = await newUser();
  a.client.realtime.setAuth(a.session.access_token);
  const seen = [];
  const ch = a.client
    .channel(uniq('todos-'))
    .on('postgres_changes', { event: '*', schema: 'public', table: 'todos' }, (p) => seen.push(p));
  cleanups.push(() => a.client.removeChannel(ch));
  await subscribed(ch);
  // Let the replication slot come up.
  await new Promise((r) => setTimeout(r, 1500));

  const mine = await a.client.from('todos').insert({ title: 'from a' }).select().single();
  assert.equal(mine.error, null);
  await b.client.from('todos').insert({ title: 'from b' });

  await waitFor(() => seen.find((p) => p.eventType === 'INSERT' && p.new.title === 'from a'), { label: 'own insert' });
  const evt = seen.find((p) => p.new.title === 'from a');
  assert.equal(evt.table, 'todos');
  assert.equal(evt.new.id, mine.data.id, 'int8 converted to number');
  assert.equal(evt.new.done, false, 'bool converted');

  await a.client.from('todos').update({ done: true }).eq('id', mine.data.id);
  await waitFor(() => seen.find((p) => p.eventType === 'UPDATE' && p.new.id === mine.data.id), { label: 'update' });
  await a.client.from('todos').delete().eq('id', mine.data.id);
  await waitFor(() => seen.find((p) => p.eventType === 'DELETE' && p.old.id === mine.data.id), { label: 'delete' });

  await new Promise((r) => setTimeout(r, 500));
  assert.ok(!seen.some((p) => p.new?.title === 'from b'), "must not receive other users' rows");
});

test('delete events are checked against policies', async () => {
  const a = await newUser();
  const b = await newUser();
  b.client.realtime.setAuth(b.session.access_token);
  const seenByB = [];
  const ch = b.client.channel(uniq('del-')).on('postgres_changes', { event: 'DELETE', schema: 'public', table: 'todos' }, (p) => seenByB.push(p));
  cleanups.push(() => b.client.removeChannel(ch));
  await subscribed(ch);
  await new Promise((r) => setTimeout(r, 1500));
  const mine = await b.client.from('todos').insert({ title: 'b owns this' }).select().single();
  const theirs = await a.client.from('todos').insert({ title: 'a owns this' }).select().single();
  await a.client.from('todos').delete().eq('id', theirs.data.id);
  await b.client.from('todos').delete().eq('id', mine.data.id);
  await waitFor(() => seenByB.some((p) => p.old.id === mine.data.id), { label: 'own delete' });
  await new Promise((r) => setTimeout(r, 500));
  assert.ok(!seenByB.some((p) => p.old.id === theirs.data.id), "must not learn about other users' deletes");
  assert.equal(seenByB.find((p) => p.old.id === mine.data.id).old.title, 'b owns this');
});

test('filters on postgres_changes', async () => {
  const { anon, service } = await keys();
  const c = client(anon);
  const tag = uniq('f');
  const seen = [];
  const ch = c
    .channel(uniq('notes-'))
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'notes', filter: `body=eq.${tag}-match` }, (p) => seen.push(p));
  cleanups.push(() => c.removeChannel(ch));
  await subscribed(ch);
  await new Promise((r) => setTimeout(r, 1500));
  const admin = client(service);
  const ins = await admin
    .from('notes')
    .insert([{ body: `${tag}-other` }, { body: `${tag}-match`, tags: ['a', 'b'], meta: { k: 1 } }], { defaultToNull: false });
  assert.equal(ins.error, null);
  await waitFor(() => seen.length >= 1, { label: 'filtered insert' });
  await new Promise((r) => setTimeout(r, 400));
  assert.equal(seen.length, 1);
  assert.deepEqual(seen[0].new.tags, ['a', 'b']);
  assert.deepEqual(seen[0].new.meta, { k: 1 });
});

test('broadcast between clients', async () => {
  const { anon } = await keys();
  const room = uniq('room-');
  const c1 = client(anon);
  const c2 = client(anon);
  const got = [];
  const ch1 = c1.channel(room).on('broadcast', { event: 'cursor' }, (m) => got.push(m.payload));
  const ch2 = c2.channel(room, { config: { broadcast: { ack: true } } });
  cleanups.push(() => c1.removeChannel(ch1), () => c2.removeChannel(ch2));
  await subscribed(ch1);
  await subscribed(ch2);
  const status = await ch2.send({ type: 'broadcast', event: 'cursor', payload: { x: 1, y: 2 } });
  assert.equal(status, 'ok');
  await waitFor(() => got.length === 1, { label: 'broadcast' });
  assert.deepEqual(got[0], { x: 1, y: 2 });
});

test('presence sync', async () => {
  const { anon } = await keys();
  const room = uniq('lobby-');
  const c1 = client(anon);
  const c2 = client(anon);
  const ch1 = c1.channel(room, { config: { presence: { key: 'one' } } });
  ch1.on('presence', { event: 'sync' }, () => {});
  const ch2 = c2.channel(room, { config: { presence: { key: 'two' } } });
  ch2.on('presence', { event: 'sync' }, () => {});
  cleanups.push(() => c1.removeChannel(ch1), () => c2.removeChannel(ch2));
  await subscribed(ch1);
  await subscribed(ch2);
  await ch1.track({ name: 'Maren' });
  await ch2.track({ name: 'Tomasz' });
  await waitFor(() => Object.keys(ch1.presenceState()).length === 2, { label: 'presence of both' });
  assert.equal(ch1.presenceState().two[0].name, 'Tomasz');
  await ch2.untrack();
  await waitFor(() => !ch1.presenceState().two, { label: 'untrack' });
});

test('a change committed right after SUBSCRIBED arrives, even for the first subscriber of a project', async () => {
  const { GATEWAY, studio, sql } = await import('./helpers.js');
  const { createClient } = await import('@supabase/supabase-js');
  const name = `rt-${Date.now().toString(36)}`;
  const made = await studio('POST', '/api/projects', { name });
  assert.equal(made.status, 201, JSON.stringify(made.data));
  try {
    const info = await studio('GET', `/api/projects/${name}/connect`);
    const db = name.replace(/-/g, '_');
    await sql(db, `create table public.pings (id int primary key); alter publication supabase_realtime add table public.pings;`);
    const c = createClient(`${GATEWAY}/${name}`, info.data.serviceKey, { auth: { persistSession: false } });
    const seen = [];
    const ch = c.channel('pings').on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'pings' }, (p) => seen.push(p));
    await subscribed(ch);
    await sql(db, 'insert into public.pings values (1)');
    await waitFor(() => seen.find((p) => p.new.id === 1), { label: 'first insert', timeout: 5000 });
    await c.removeChannel(ch);
  } finally {
    await studio('DELETE', `/api/projects/${name}`, { confirm: name });
  }
});
