import assert from 'node:assert/strict';
import test from 'node:test';
import { ConnectionLimits, LIMITS, RateLimiter, bindingsProblem, presenceBytes, roomKey, topicProblem } from './limits.js';

test('room keys never collide between public and private channels', () => {
  // The old scheme used topic + "\0private" for private rooms, so a public
  // join to "realtime:x\0private" landed in the private room of "realtime:x".
  const topics = ['realtime:room', 'realtime:room\u0000private', 'realtime:priv:room', 'realtime:pub:room', 'realtime:', ''];
  const keys = new Set<string>();
  for (const t of topics) {
    keys.add(roomKey(t, false));
    keys.add(roomKey(t, true));
  }
  assert.equal(keys.size, topics.length * 2);
  assert.notEqual(roomKey('realtime:room\u0000private', false), roomKey('realtime:room', true));
  assert.ok(roomKey('realtime:a', true).startsWith('priv:'));
  assert.ok(roomKey('realtime:a', false).startsWith('pub:'));
});

test('topics must be realtime:<name>, short and free of control characters', () => {
  assert.equal(topicProblem('realtime:room-1'), null);
  assert.equal(topicProblem('realtime:room:42'), null);
  assert.equal(topicProblem('realtime:Zürich 🚀'), null);
  assert.equal(topicProblem('realtime:'), null);
  assert.equal(topicProblem('room-1'), 'unmatched topic');
  assert.equal(topicProblem('phoenix'), 'unmatched topic');
  assert.equal(topicProblem(42), 'unmatched topic');
  assert.match(topicProblem('realtime:room\u0000private')!, /^InvalidTopic: .*control characters/);
  assert.match(topicProblem('realtime:a\nb')!, /control characters/);
  assert.match(topicProblem('realtime:a\u007fb')!, /control characters/);
  assert.match(topicProblem('realtime:a\u0085b')!, /control characters/);
  assert.match(topicProblem('realtime:a\ud800b')!, /control characters/, 'lone surrogate');
  const max = 'realtime:' + 'x'.repeat(LIMITS.maxTopicBytes - 'realtime:'.length);
  assert.equal(topicProblem(max), null);
  assert.match(topicProblem(max + 'x')!, /^InvalidTopic: Topic is longer than 255 bytes/);
  // Bytes, not characters: binary frames carry the length in one byte.
  assert.match(topicProblem('realtime:' + 'é'.repeat(124))!, /longer than/);
});

test('presence size counts the key and the JSON state', () => {
  assert.equal(presenceBytes('k', { a: 1 }), JSON.stringify(['k', { a: 1 }]).length);
  assert.ok(presenceBytes('k', { s: 'x'.repeat(LIMITS.maxPresenceBytes) }) > LIMITS.maxPresenceBytes);
  assert.ok(presenceBytes('é', {}) > presenceBytes('e', {}));
});

test('rate limiter allows bursts, drops above the rate and asks to close persistent floods', () => {
  let now = 1_000_000;
  const r = new RateLimiter(100, 200, now);
  for (let i = 0; i < 200; i++) assert.equal(r.hit(now), 'ok', `burst message ${i}`);
  assert.equal(r.hit(now), 'drop');
  // Refills at 100 per second.
  now += 100;
  for (let i = 0; i < 10; i++) assert.equal(r.hit(now), 'ok');
  assert.equal(r.hit(now), 'drop');
  // Steady 100/s is fine indefinitely.
  const steady = new RateLimiter(100, 200, now);
  for (let i = 0; i < 2000; i++) {
    now += 10;
    assert.equal(steady.hit(now), 'ok');
  }
  // A flood keeps being dropped, then gets the connection closed.
  const flood = new RateLimiter(100, 200, now);
  const seen = new Set<string>();
  let closedAt = -1;
  for (let i = 0; i < 1000; i++) {
    const d = flood.hit(now);
    seen.add(d);
    if (d === 'close') {
      closedAt = i;
      break;
    }
  }
  assert.deepEqual([...seen].sort(), ['close', 'drop', 'ok']);
  assert.equal(closedAt, 400, '200 allowed, 200 dropped, then close');
  // A client that backs off recovers.
  const backoff = new RateLimiter(100, 200, now);
  for (let i = 0; i < 300; i++) backoff.hit(now);
  now += 5000;
  assert.equal(backoff.hit(now), 'ok');
});

test('anonymous sockets filling a project do not keep out signed-in users or the service role', () => {
  const limits = new ConnectionLimits(2, 4);
  // Someone with the public anon key holds sockets from many addresses until the project is full.
  const held = ['a', 'a', 'b', 'b'].map((ip) => limits.admit('app', ip, false));
  assert.ok(held.every((t) => t && !t.probation));
  // A new visitor still gets in, on probation: it has to sign in on a channel soon or it is closed.
  const visitor = limits.admit('app', 'c', false);
  assert.ok(visitor && visitor.probation);
  visitor.signedIn();
  assert.equal(visitor.probation, false, 'signed in: off probation');
  // The service role (the app's own server) never waits.
  const server = limits.admit('app', 'd', true);
  assert.ok(server && !server.probation);
  // Each address is still capped, whoever it is.
  assert.equal(limits.admit('app', 'a', false), null);
  assert.equal(limits.admit('app', 'a', true), null);
  // Other projects are not affected.
  assert.ok(!limits.admit('other', 'e', false)!.probation);
});

test('signed-in and closed sockets free their place in the project', () => {
  const limits = new ConnectionLimits(10, 2);
  const one = limits.admit('app', 'a', false)!;
  const two = limits.admit('app', 'b', false)!;
  assert.ok(limits.admit('app', 'c', false)!.probation);
  one.signedIn();
  assert.equal(limits.admit('app', 'c', false)!.probation, false, 'a signed-in socket no longer counts');
  two.close();
  two.close();
  assert.equal(limits.admit('app', 'd', false)!.probation, false, 'closing frees the place, once');
  assert.ok(limits.admit('app', 'e', false)!.probation);
});

test('a join may hold only so many postgres_changes bindings', () => {
  // Each binding is matched against every change of the project; one join
  // with half a million of them stalled realtime for every project.
  const one = { event: '*', schema: 'public' };
  assert.equal(bindingsProblem(undefined), null);
  assert.equal(bindingsProblem('not a list'), null);
  assert.equal(bindingsProblem(Array(LIMITS.maxBindingsPerChannel).fill(one)), null);
  assert.match(bindingsProblem(Array(LIMITS.maxBindingsPerChannel + 1).fill(one)) || '', /TooManyBindings/);
  assert.match(bindingsProblem(Array(500_000).fill(1)) || '', /TooManyBindings/);
});
