import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import test from 'node:test';
import { AccountBackoff, HttpError, dbErrorFields, limitServer, toHttpError } from './http.js';

test('AccountBackoff: wrong passwords count, then doubling waits up to a cap', () => {
  let now = 1_000_000;
  const b = new AccountBackoff(3, 60 * 60_000, 8_000, () => now);
  const guess = () => {
    if (!b.begin('a')) return false;
    b.end('a', 'failure');
    return true;
  };
  for (let i = 0; i < 3; i++) assert.equal(guess(), true, `guess ${i + 1}`);
  // Then each one waits twice as long as the one before: 1 s, 2 s, 4 s, 8 s, 8 s.
  assert.equal(guess(), false, 'right after the free ones');
  for (const wait of [1_000, 2_000, 4_000, 8_000, 8_000]) {
    now += wait - 1;
    assert.equal(guess(), false, `before ${wait} ms`);
    now += 1;
    assert.equal(guess(), true, `after ${wait} ms`);
  }
  // Other accounts are not affected.
  assert.equal(b.begin('b'), true);
});

test('AccountBackoff: right passwords, errors and refused attempts are not failures', () => {
  let now = 0;
  const b = new AccountBackoff(2, 60 * 60_000, 60_000, () => now);
  for (let i = 0; i < 50; i++) {
    assert.equal(b.begin('a'), true, `sign-in ${i + 1}`);
    b.end('a', 'success');
  }
  // Errors that say nothing about the password (the database was down) don't count.
  for (let i = 0; i < 5; i++) {
    assert.equal(b.begin('a'), true);
    b.end('a', 'none');
  }
  for (let i = 0; i < 2; i++) {
    assert.equal(b.begin('a'), true);
    b.end('a', 'failure');
  }
  // Refused attempts don't make the wait any longer.
  for (let i = 0; i < 10; i++) assert.equal(b.begin('a'), false);
  now += 1_000;
  assert.equal(b.begin('a'), true, 'one second after the last real attempt');
  b.end('a', 'success');
  assert.equal(b.begin('a'), true, 'a right password starts over');
});

test('AccountBackoff: a parallel burst is held to the free attempts', () => {
  const b = new AccountBackoff(5, 60 * 60_000, 60_000, () => 0);
  let started = 0;
  for (let i = 0; i < 100; i++) if (b.begin('a')) started++;
  assert.equal(started, 5, 'attempts in flight count before they finish');
  for (let i = 0; i < started; i++) b.end('a', 'failure');
  assert.equal(b.begin('a'), false);
});

test('AccountBackoff: the failures expire with the window', () => {
  let now = 0;
  const b = new AccountBackoff(2, 10_000, 60_000, () => now);
  for (let i = 0; i < 3; i++) if (b.begin('a')) b.end('a', 'failure');
  assert.equal(b.begin('a'), false);
  now += 70_000;
  assert.equal(b.begin('a'), true);
  b.end('a', 'failure');
  assert.equal(b.begin('a'), true);
});

test('toHttpError: Postgres errors keep their status and code but not their text', () => {
  const pg = (code: string, message: string) => Object.assign(new Error(message), { code });
  const cases: [string, string, number, string][] = [
    ['42501', 'permission denied for table secret_salaries', 403, 'permission_denied'],
    ['23505', 'duplicate key value violates unique constraint "users_phone_key"', 409, 'duplicate'],
    ['23503', 'insert or update on table "orders" violates foreign key constraint "orders_user_fkey"', 409, 'foreign_key_violation'],
    ['23514', 'new row for relation "accounts" violates check constraint "balance_positive"', 400, 'invalid_input'],
    ['22P02', 'invalid input syntax for type uuid: "x"', 400, 'invalid_input'],
  ];
  for (const [code, message, status, name] of cases) {
    const e = toHttpError(pg(code, message));
    assert.equal(e.status, status, code);
    assert.equal(e.code, name, code);
    assert.doesNotMatch(e.message, /salaries|users_phone_key|orders|accounts|uuid/, code);
    // Studio (admins only) still sees the details.
    assert.equal(toHttpError(pg(code, message), true).message, message);
  }
  // Keel's own errors pass through; anything else is a plain 500.
  assert.equal(toHttpError(new HttpError(404, 'Bucket not found', 'not_found')).message, 'Bucket not found');
  assert.equal(toHttpError(new Error('connect ECONNREFUSED 172.18.0.2:5432')).message, 'Internal server error');
});

test('limitServer closes requests whose body stalls, and caps connections per address', async () => {
  const server = http.createServer(async (req, res) => {
    try {
      for await (const _ of req) void _;
    } catch {
      return; // closed for stalling
    }
    res.end('ok');
  });
  limitServer(server, 'test', { bodyIdleMs: 150, connectionsPerIp: 2, exempt: () => false });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as net.AddressInfo).port;
  const connect = () =>
    new Promise<net.Socket>((resolve) => {
      const s = net.connect(port, '127.0.0.1', () => resolve(s));
    });
  const closed = (s: net.Socket) => new Promise<void>((r) => (s.destroyed ? r() : s.once('close', () => r())));
  try {
    // A body that stops arriving is closed.
    const slow = await connect();
    slow.write('POST / HTTP/1.1\r\nHost: x\r\nContent-Length: 10\r\n\r\nabc');
    const started = Date.now();
    await closed(slow);
    assert.ok(Date.now() - started >= 100);

    // A complete request is answered, and a third connection from the same address is refused.
    const a = await connect();
    const b = await connect();
    const c = await connect();
    await closed(c);
    let answer = '';
    a.on('data', (d) => (answer += d));
    a.write('POST / HTTP/1.1\r\nHost: x\r\nContent-Length: 2\r\n\r\nhi');
    await new Promise((r) => setTimeout(r, 300));
    assert.match(answer, /^HTTP\/1.1 200/);
    assert.equal(a.destroyed, false, 'the body timer stops once the body has arrived');
    a.destroy();
    b.destroy();
  } finally {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  }
});

test('dbErrorFields leaves the values a client sent out of the logs unless KEEL_LOG_PII is on', () => {
  const e = Object.assign(new Error('invalid input syntax for type uuid: "alice@example.com"'), { code: '22P02' });
  assert.deepEqual(dbErrorFields(e, false), { code: '22P02' });
  assert.deepEqual(dbErrorFields(e, true), { code: '22P02', error: 'invalid input syntax for type uuid: "alice@example.com"' });
  const dup = Object.assign(new Error('duplicate key value violates unique constraint "users_email_key"'), { code: '23505', table: 'users', constraint: 'users_email_key' });
  assert.deepEqual(dbErrorFields(dup, false), { code: '23505', table: 'users', constraint: 'users_email_key' });
});
