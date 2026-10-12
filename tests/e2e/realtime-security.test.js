// Security fixes in keel-realtime: private rooms can't be reached through a
// public topic, postgres_changes are authorized against the row the change
// wrote, and connections are held to resource limits.

import crypto from 'node:crypto';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { GATEWAY, PROJECT, PROJECT_URL, client, ensureSchema, env, keys, newUser, sql, uniq, waitFor } from './helpers.js';

const cleanups = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function join(c, topic, opts = {}) {
  const ch = c.channel(topic, { config: { private: !!opts.private, broadcast: { self: !!opts.self, ack: !!opts.ack }, ...(opts.presence ? { presence: opts.presence } : {}) } });
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

function changes(c, table, token) {
  if (token) c.realtime.setAuth(token);
  const seen = [];
  const ch = c.channel(uniq('sec-pg-')).on('postgres_changes', { event: '*', schema: 'public', table }, (p) => seen.push(p));
  cleanups.push(() => c.removeChannel(ch));
  const ready = new Promise((resolve, reject) => {
    ch.subscribe((status, err) => {
      if (status === 'SUBSCRIBED') resolve();
      else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') reject(err || new Error(status));
    });
  });
  return { seen, ready };
}

/** A bare Phoenix client (vsn 1.0.0) through the gateway, for what supabase-js can't send. */
async function rawSocket() {
  const { anon } = await keys();
  const url = `${GATEWAY.replace(/^http/, 'ws')}/${PROJECT}/realtime/v1/websocket?apikey=${anon}&vsn=1.0.0`;
  const ws = new WebSocket(url);
  const msgs = [];
  const sock = { ws, msgs, closed: null, ref: 0 };
  ws.on('message', (d) => msgs.push(JSON.parse(d.toString())));
  ws.on('close', (code) => (sock.closed = { code }));
  cleanups.push(async () => ws.close());
  await new Promise((resolve, reject) => {
    ws.on('open', resolve);
    ws.on('error', reject);
  });
  sock.push = (topic, event, payload = {}) => {
    const ref = String(++sock.ref);
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ topic, event, payload, ref, join_ref: ref }));
    return ref;
  };
  sock.request = async (topic, event, payload) => {
    const ref = sock.push(topic, event, payload);
    return (await waitFor(() => msgs.find((m) => m.ref === ref && m.event === 'phx_reply'), { label: `${event} reply` })).payload;
  };
  return sock;
}

async function httpBroadcast(body, token, path = '') {
  const { anon } = await keys();
  return fetch(`${PROJECT_URL}/realtime/v1/api/broadcast${path}`, {
    method: 'POST',
    headers: { apikey: anon, Authorization: `Bearer ${token || anon}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

before(async () => {
  await ensureSchema();
  const { db } = await keys();
  await sql(
    db,
    `drop policy if exists "e2e security read" on realtime.messages;
     drop policy if exists "e2e security write" on realtime.messages;
     create policy "e2e security read" on realtime.messages for select to authenticated
       using (realtime.topic() = 'sec:' || auth.uid()::text);
     create policy "e2e security write" on realtime.messages for insert to authenticated
       with check (realtime.topic() like 'sec:%');

     create table if not exists public.rt_big (
       id bigint generated always as identity primary key,
       owner uuid not null,
       body text,
       n int not null default 0,
       shout text generated always as (upper(owner::text)) stored
     );
     alter table public.rt_big enable row level security;
     alter table public.rt_big alter column body set storage external;
     drop policy if exists "own big rows" on public.rt_big;
     create policy "own big rows" on public.rt_big for select to authenticated using (owner = auth.uid());
     do $$ begin
       if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'rt_big') then
         alter publication supabase_realtime add table public.rt_big;
       end if;
     end $$;`,
  );
  await sleep(600);
});

after(async () => {
  for (const fn of cleanups) await fn().catch(() => {});
  const { db } = await keys();
  await sql(db, `drop policy if exists "e2e security read" on realtime.messages; drop policy if exists "e2e security write" on realtime.messages;`).catch(() => {});
});

// ---------------------------------------------------------------- private rooms

test('a public topic ending in "\\0private" is refused and never reaches the private room', async () => {
  const a = await newUser();
  const b = await newUser();
  const topic = `sec:${a.user.id}`;
  const owner = join(a.client, topic, { private: true });
  assert.deepEqual(await owner.ready, { ok: true });

  // Before the fix this public join landed in the private room with every permission.
  const trick = join(b.client, `${topic}\u0000private`, { ack: true });
  const r = await trick.ready;
  assert.equal(r.ok, false);
  assert.match(r.error, /InvalidTopic: Topic contains control characters/);
  const anonTrick = await join(client((await keys()).anon), `${topic}\u0000private`).ready;
  assert.equal(anonTrick.ok, false);

  // The same trick over HTTP.
  const batch = await httpBroadcast({ messages: [{ topic: `${topic}\u0000private`, event: 'evil', payload: { n: 1 } }] }, b.session.access_token);
  assert.equal(batch.status, 400);
  assert.match((await batch.json()).message, /control characters/);
  const single = await httpBroadcast({ n: 2 }, b.session.access_token, `/${encodeURIComponent(`${topic}\u0000private`)}/events/evil`);
  assert.equal(single.status, 400);

  await sleep(500);
  assert.equal(owner.got.length, 0, 'nothing reached the private room');

  // The private room itself still works over HTTP for someone allowed to send.
  const ok = await httpBroadcast({ messages: [{ topic, event: 'hello', payload: { n: 3 }, private: true }] }, a.session.access_token);
  assert.equal(ok.status, 202);
  await waitFor(() => owner.got.find((m) => m.event === 'hello' && m.payload.n === 3), { label: 'private HTTP broadcast' });
});

test('topics are limited to 255 bytes and must start with realtime:', async () => {
  const { anon } = await keys();
  const long = await join(client(anon), 'x'.repeat(300)).ready;
  assert.equal(long.ok, false);
  assert.match(long.error, /InvalidTopic: Topic is longer than 255 bytes/);
  const fits = await join(client(anon), 'y'.repeat(246)).ready;
  assert.equal(fits.ok, true, fits.error);

  const sock = await rawSocket();
  const noPrefix = await sock.request('room-without-prefix', 'phx_join', { config: {} });
  assert.equal(noPrefix.status, 'error');
  assert.equal(noPrefix.response.reason, 'unmatched topic');

  const http = await httpBroadcast({ messages: [{ topic: 'z'.repeat(300), event: 'e', payload: {} }] });
  assert.equal(http.status, 400);
  assert.match((await http.json()).message, /longer than 255 bytes/);
  const malformed = await fetch(`${PROJECT_URL}/realtime/v1/api/broadcast/%E0%A4%A/events/e`, {
    method: 'POST',
    headers: { apikey: anon, 'Content-Type': 'application/json' },
    body: '{}',
  });
  assert.equal(malformed.status, 400);
});

// ---------------------------------------------------------------- postgres_changes

test('postgres_changes are checked against the row the change wrote, not the current row', async () => {
  const a = await newUser();
  const b = await newUser();
  const { db } = await keys();
  const seenA = changes(a.client, 'todos', a.session.access_token);
  const seenB = changes(b.client, 'todos', b.session.access_token);
  await Promise.all([seenA.ready, seenB.ready]);
  await sleep(1000);

  // B writes a row, and the same transaction hands it to A. When the checks
  // run the row is A's, but the INSERT event carries B's row: A must not get it.
  const tag = uniq('handover-');
  await sql(
    db,
    `begin;
     insert into public.todos (title, user_id) values ('${tag} b-secret', '${b.user.id}');
     update public.todos set user_id = '${a.user.id}', title = '${tag} now-a' where title = '${tag} b-secret';
     commit;`,
  );
  const upd = await waitFor(() => seenA.seen.find((p) => p.eventType === 'UPDATE' && p.new.title === `${tag} now-a`), { label: 'A gets the handover UPDATE' });
  await waitFor(() => seenB.seen.find((p) => p.eventType === 'INSERT' && p.new.title === `${tag} b-secret`), { label: 'B gets its own INSERT' });
  await sleep(500);
  assert.ok(!seenA.seen.some((p) => p.eventType === 'INSERT' && p.new.title?.startsWith(tag)), "A must not see B's insert");
  assert.ok(!seenB.seen.some((p) => p.eventType === 'UPDATE' && p.new.title?.startsWith(tag)), 'B must not see the row after it was handed over');
  // On a table with RLS, updates only carry the old row's primary key.
  assert.deepEqual(Object.keys(upd.old), ['id']);
  assert.equal(upd.old.id, upd.new.id);

  // The other way round: written as A's, then handed to B. A was allowed to see the INSERT.
  const tag2 = uniq('giveaway-');
  await sql(
    db,
    `begin;
     insert into public.todos (title, user_id) values ('${tag2}', '${a.user.id}');
     update public.todos set user_id = '${b.user.id}' where title = '${tag2}';
     commit;`,
  );
  await waitFor(() => seenA.seen.find((p) => p.eventType === 'INSERT' && p.new.title === tag2), { label: "A's own INSERT, even though the row is B's now" });
  await sleep(300);
  assert.ok(!seenA.seen.some((p) => p.eventType === 'UPDATE' && p.new.title === tag2));
});

test('postgres_changes: the service role still gets full old rows, and DELETE stays policy-checked', async () => {
  const a = await newUser();
  const { service, db } = await keys();
  const svc = changes(client(service), 'todos');
  const own = changes(a.client, 'todos', a.session.access_token);
  await Promise.all([svc.ready, own.ready]);
  await sleep(1000);
  const { rows } = await sql(db, `insert into public.todos (title, user_id) values ('before', $1) returning id`, [a.user.id]);
  const id = Number(rows[0].id);
  await sql(db, `update public.todos set title = 'after' where id = $1`, [id]);
  const s = await waitFor(() => svc.seen.find((p) => p.eventType === 'UPDATE' && p.new.id === id), { label: 'service UPDATE' });
  assert.equal(s.old.title, 'before', 'service role: whole old row (replica identity full)');
  const u = await waitFor(() => own.seen.find((p) => p.eventType === 'UPDATE' && p.new.id === id), { label: 'owner UPDATE' });
  assert.deepEqual(u.old, { id });
  await sql(db, `delete from public.todos where id = $1`, [id]);
  const d = await waitFor(() => own.seen.find((p) => p.eventType === 'DELETE' && p.old.id === id), { label: 'owner DELETE' });
  assert.equal(d.old.title, 'after', 'deletes carry the old row the policies were checked against');
});

test('postgres_changes: large rows arrive intact, and TOASTed / generated columns are handled', async () => {
  const a = await newUser();
  const b = await newUser();
  const { db } = await keys();
  const seen = changes(a.client, 'rt_big', a.session.access_token);
  await seen.ready;
  await sleep(1000);
  // Several big rows in one statement: their WAL messages span many network reads.
  const bodies = Array.from({ length: 6 }, () => crypto.randomBytes(20_000).toString('hex'));
  const owners = bodies.map((_, i) => (i % 2 ? b.user.id : a.user.id));
  const { rows } = await sql(
    db,
    `insert into public.rt_big (owner, body) select * from unnest($1::uuid[], $2::text[]) returning id, owner, body`,
    [owners, bodies],
  );
  const mine = rows.filter((r) => r.owner === a.user.id);
  await waitFor(() => seen.seen.filter((p) => p.eventType === 'INSERT').length >= mine.length, { label: 'big inserts' });
  await sleep(500);
  const inserts = seen.seen.filter((p) => p.eventType === 'INSERT');
  assert.equal(inserts.length, mine.length, 'only own rows, each once');
  for (const r of mine) {
    const evt = inserts.find((p) => p.new.id === Number(r.id));
    assert.ok(evt, `row ${r.id} delivered`);
    assert.equal(evt.new.owner, a.user.id);
    assert.equal(evt.new.body, r.body, 'body belongs to this row');
  }

  // Updates that leave the big column alone: its value isn't in the WAL (default replica identity).
  await sql(db, `update public.rt_big set n = n + 1 where id = any($1::bigint[])`, [rows.map((r) => r.id)]);
  await waitFor(() => seen.seen.filter((p) => p.eventType === 'UPDATE').length >= mine.length, { label: 'big updates' });
  await sleep(500);
  const updates = seen.seen.filter((p) => p.eventType === 'UPDATE');
  assert.equal(updates.length, mine.length);
  assert.ok(updates.every((p) => p.new.owner === a.user.id && p.new.n === 1));
});

// ---------------------------------------------------------------- limits

test('limits: 100 channels per connection', async () => {
  const sock = await rawSocket();
  for (let i = 0; i < 100; i++) sock.push(`realtime:${uniq('cap-')}-${i}`, 'phx_join', { config: {} });
  await waitFor(() => sock.msgs.filter((m) => m.event === 'phx_reply' && m.payload.status === 'ok').length === 100, { label: '100 joins' });
  const r = await sock.request(`realtime:${uniq('cap-')}`, 'phx_join', { config: {} });
  assert.equal(r.status, 'error');
  assert.equal(r.response.reason, 'ChannelRateLimitReached: Too many channels');
});

test('limits: presence state up to 64 KB, on up to 10 channels per connection', async () => {
  const { anon } = await keys();
  const c = client(anon);
  const room = join(c, uniq('sec-lobby-'), { presence: { key: 'me' } });
  await room.ready;
  assert.equal(await room.ch.track({ blob: 'x'.repeat(70 * 1024) }), 'error');
  assert.equal(await room.ch.track({ name: 'Ada' }), 'ok');
  for (let i = 0; i < 9; i++) {
    const other = join(c, uniq(`sec-p${i}-`));
    await other.ready;
    assert.equal(await other.ch.track({ i }), 'ok');
  }
  const eleventh = join(c, uniq('sec-p10-'));
  await eleventh.ready;
  assert.equal(await eleventh.ch.track({}), 'error');
  // Updating an entry that already exists is fine.
  assert.equal(await room.ch.track({ name: 'Ada', status: 'away' }), 'ok');
});

test('limits: message rate per connection', async () => {
  const sock = await rawSocket();
  // A burst of 200 is allowed, then about 100 per second.
  for (let i = 0; i < 350; i++) sock.push('phoenix', 'heartbeat');
  await waitFor(() => sock.msgs.filter((m) => m.event === 'phx_reply').length >= 350, { label: 'replies' });
  const errors = sock.msgs.filter((m) => m.event === 'phx_reply' && m.payload.status === 'error');
  assert.ok(errors.length >= 20 && errors.length <= 150, `refused ${errors.length} of 350`);
  assert.equal(errors[0].payload.response.reason, 'RateLimitReached: Too many messages per second');
  // Keeping it up gets the connection closed.
  for (let i = 0; i < 2000 && !sock.closed; i++) sock.push('phoenix', 'heartbeat');
  await waitFor(() => sock.closed, { label: 'disconnected' });
  assert.equal(sock.closed.code, 1008);
});

test('limits: WebSocket messages over 1 MB close the connection', async () => {
  const sock = await rawSocket();
  sock.ws.send(JSON.stringify({ topic: 'phoenix', event: 'heartbeat', payload: { pad: 'x'.repeat(1024 * 1024 + 16) }, ref: '1' }));
  await waitFor(() => sock.closed, { label: 'closed' });
  // 1009 (message too big), or 1006 when the server closes while the client is still writing.
  assert.ok([1009, 1006].includes(sock.closed.code), String(sock.closed.code));
  // Below the limit is fine.
  const ok = await rawSocket();
  const r = await ok.request('phoenix', 'heartbeat', { pad: 'x'.repeat(900 * 1024) });
  assert.equal(r.status, 'ok');
});

test('limits: HTTP broadcast takes up to 100 messages and 20 private topics per request', async () => {
  const a = await newUser();
  const msg = (i, isPrivate = false) => ({ topic: `sec:${i}`, event: 'e', payload: {}, private: isPrivate });
  assert.equal((await httpBroadcast({ messages: Array.from({ length: 100 }, (_, i) => msg(i % 3)) })).status, 202);
  const tooMany = await httpBroadcast({ messages: Array.from({ length: 101 }, (_, i) => msg(i)) });
  assert.equal(tooMany.status, 400);
  assert.match((await tooMany.json()).message, /at most 100 per request/);
  const twenty = await httpBroadcast({ messages: Array.from({ length: 40 }, (_, i) => msg(i % 20, true)) }, a.session.access_token);
  assert.equal(twenty.status, 202);
  const tooManyPrivate = await httpBroadcast({ messages: Array.from({ length: 21 }, (_, i) => msg(i, true)) }, a.session.access_token);
  assert.equal(tooManyPrivate.status, 400);
  assert.match((await tooManyPrivate.json()).message, /at most 20 per request/);
  assert.equal((await httpBroadcast({ messages: [{ topic: 42 }] })).status, 400);
});

test('idle anonymous sockets filling a project do not keep a signed-in user out', async (t) => {
  // Opening 10,000 sockets is too much for a test run: this needs a stack with a
  // small cap, e.g. KEEL_REALTIME_MAX_PER_PROJECT=20 in .env.
  const cap = Number(env.KEEL_REALTIME_MAX_PER_PROJECT || 10000);
  const perAddress = Number(env.KEEL_REALTIME_MAX_PER_IP || 200);
  if (cap > 50 || perAddress < cap + 3) return t.skip('set KEEL_REALTIME_MAX_PER_PROJECT=20 to run this test');
  // Someone with the public anon key fills the project with idle sockets.
  for (let i = 0; i < cap; i++) await rawSocket();
  const u = await newUser();
  const user = await rawSocket();
  const stranger = await rawSocket();
  const joined = await user.request(`realtime:${uniq('cap-')}`, 'phx_join', { config: {}, access_token: u.session.access_token });
  assert.equal(joined.status, 'ok', JSON.stringify(joined));
  assert.equal((await stranger.request(`realtime:${uniq('cap-')}`, 'phx_join', { config: {} })).status, 'ok');
  await sleep(11_000);
  assert.equal(user.closed, null, 'the signed-in user is still connected');
  assert.equal(stranger.closed?.code, 1008, 'an anonymous socket over the cap was closed');
});
