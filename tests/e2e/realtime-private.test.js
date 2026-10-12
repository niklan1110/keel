import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { client, keys, newUser, setProjectSettings, sql, uniq, waitFor } from './helpers.js';

const cleanups = [];
const feed = uniq('feed-');

function join(c, topic, opts = {}) {
  const ch = c.channel(topic, { config: { private: !!opts.private, broadcast: { self: !!opts.self, ack: !!opts.ack } } });
  const got = [];
  ch.on('broadcast', { event: '*' }, (m) => got.push(m));
  cleanups.push(() => c.removeChannel(ch));
  const ready = new Promise((resolve) => {
    ch.subscribe((status, err) => {
      if (status === 'SUBSCRIBED') resolve({ ok: true });
      else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') resolve({ ok: false, error: err?.message || status });
    });
  });
  return { ch, got, ready };
}

before(async () => {
  const { db } = await keys();
  await sql(
    db,
    `drop policy if exists "e2e read" on realtime.messages;
     drop policy if exists "e2e write" on realtime.messages;
     create policy "e2e read" on realtime.messages for select to authenticated
       using (realtime.topic() = 'own:' || auth.uid()::text or realtime.topic() = '${feed}');
     create policy "e2e write" on realtime.messages for insert to authenticated
       with check (realtime.topic() = 'own:' || auth.uid()::text);

     create table if not exists public.rt_items (id bigint generated always as identity primary key, title text, feed text);
     drop policy if exists "rt items" on public.rt_items;
     create policy "rt items" on public.rt_items for all to authenticated using (true) with check (true);
     create or replace function public.rt_items_broadcast() returns trigger
       language plpgsql security definer set search_path = '' as $$
     begin
       perform realtime.broadcast_changes(coalesce(new.feed, old.feed), tg_op, tg_op, tg_table_name, tg_table_schema, new, old);
       return null;
     end $$;
     drop trigger if exists rt_items_broadcast on public.rt_items;
     create trigger rt_items_broadcast after insert or update or delete on public.rt_items
       for each row execute function public.rt_items_broadcast();`,
  );
  await new Promise((r) => setTimeout(r, 600));
});

after(async () => {
  for (const fn of cleanups) await fn().catch(() => {});
  await setProjectSettings({ realtime: {} });
});

test('private channels are authorized by RLS policies on realtime.messages', async () => {
  const a = await newUser();
  const b = await newUser();
  const { anon } = await keys();
  const topic = `own:${a.user.id}`;

  const mine = join(a.client, topic, { private: true });
  assert.deepEqual(await mine.ready, { ok: true });
  const intruder = join(b.client, topic, { private: true });
  const r = await intruder.ready;
  assert.equal(r.ok, false);
  assert.match(r.error, /do not have permissions to read/);
  const anonymous = await join(client(anon), topic, { private: true }).ready;
  assert.equal(anonymous.ok, false);
});

test('private broadcasts reach authorized subscribers only, and stay out of the public room', async () => {
  const a = await newUser();
  const topic = `own:${a.user.id}`;
  const { anon } = await keys();

  // A second device of the same user.
  const a2 = client(anon);
  await a2.auth.signInWithPassword({ email: a.email, password: a.password });
  const receiver = join(a2, topic, { private: true });
  const publicRoom = join(client(anon), topic);
  const sender = join(a.client, topic, { private: true, ack: true });
  await Promise.all([receiver.ready, publicRoom.ready, sender.ready]);

  assert.equal(await sender.ch.send({ type: 'broadcast', event: 'hello', payload: { n: 1 } }), 'ok');
  await waitFor(() => receiver.got.find((m) => m.event === 'hello' && m.payload.n === 1), { label: 'private broadcast' });
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(publicRoom.got.length, 0);

  // Read-only topic: users can receive but not send.
  const feedSender = join(a.client, feed, { private: true, ack: true });
  assert.deepEqual(await feedSender.ready, { ok: true });
  assert.notEqual(await feedSender.ch.send({ type: 'broadcast', event: 'nope', payload: {} }), 'ok');
});

test('broadcast from the database with realtime.send and realtime.broadcast_changes', async () => {
  const a = await newUser();
  const { anon, db } = await keys();
  const priv = join(a.client, feed, { private: true });
  const pub = join(client(anon), feed);
  await Promise.all([priv.ready, pub.ready]);

  await sql(db, `select realtime.send('{"from":"sql"}'::jsonb, 'note', $1, true)`, [feed]);
  await waitFor(() => priv.got.find((m) => m.event === 'note' && m.payload.from === 'sql'), { label: 'private send from SQL' });
  await sql(db, `select realtime.send('{"from":"sql-public"}'::jsonb, 'note', $1, false)`, [feed]);
  await waitFor(() => pub.got.find((m) => m.payload.from === 'sql-public'), { label: 'public send from SQL' });
  assert.ok(!pub.got.some((m) => m.payload.from === 'sql'), 'private message must not reach the public room');
  assert.ok(!priv.got.some((m) => m.payload.from === 'sql-public'), 'public message must not reach the private room');

  // A trigger broadcasting row changes (the Supabase pattern).
  const ins = await a.client.from('rt_items').insert({ title: 'via trigger', feed }).select().single();
  assert.equal(ins.error, null);
  const evt = await waitFor(() => priv.got.find((m) => m.event === 'INSERT'), { label: 'broadcast_changes' });
  assert.equal(evt.payload.record.title, 'via trigger');
  assert.equal(evt.payload.operation, 'INSERT');
  assert.equal(evt.payload.table, 'rt_items');
  assert.equal(evt.payload.old_record, null);
});

test('private_only rejects public channels', async () => {
  await setProjectSettings({ realtime: { private_only: true } });
  const a = await newUser();
  const pub = await join(a.client, uniq('pub-')).ready;
  assert.equal(pub.ok, false);
  assert.match(pub.error, /only allows private channels/);
  const priv = await join(a.client, `own:${a.user.id}`, { private: true }).ready;
  assert.equal(priv.ok, true);
  await setProjectSettings({ realtime: {} });
});

test('httpSend on a private channel is authorized and stays private', async () => {
  const a = await newUser();
  const topic = `own:${a.user.id}`;
  const { anon } = await keys();
  const receiver = join(a.client, topic, { private: true });
  const publicRoom = join(client(anon), topic);
  await Promise.all([receiver.ready, publicRoom.ready]);

  const r = await a.client.channel(topic, { config: { private: true } }).httpSend('via-http', { n: 2 });
  assert.equal(r.success, true);
  await waitFor(() => receiver.got.find((m) => m.event === 'via-http' && m.payload.n === 2), { label: 'private httpSend' });
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(publicRoom.got.length, 0, 'not delivered to the public room');

  // Not allowed to write to the feed topic: nothing is delivered.
  const feedReceiver = join(a.client, feed, { private: true });
  await feedReceiver.ready;
  await a.client.channel(feed, { config: { private: true } }).httpSend('nope', {}).catch(() => {});
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(feedReceiver.got.length, 0);
});
