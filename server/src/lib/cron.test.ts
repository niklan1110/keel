import assert from 'node:assert/strict';
import test from 'node:test';
import { matchesMinute, parseSchedule } from './cron.js';

const at = (iso: string) => new Date(iso);
const fires = (schedule: string, iso: string) => matchesMinute(parseSchedule(schedule), at(iso));

test('every N seconds', () => {
  assert.deepEqual(parseSchedule('10 seconds'), { kind: 'seconds', seconds: 10 });
  assert.deepEqual(parseSchedule(' 1 second '), { kind: 'seconds', seconds: 1 });
  assert.throws(() => parseSchedule('0 seconds'), /1 to 59/);
  assert.throws(() => parseSchedule('60 seconds'), /1 to 59/);
  assert.throws(() => parseSchedule('100 seconds'));
});

test('stars, steps, ranges and lists', () => {
  assert.ok(fires('* * * * *', '2026-03-04T05:06:00Z'));
  assert.ok(fires('*/5 * * * *', '2026-03-04T05:10:30Z'));
  assert.ok(!fires('*/5 * * * *', '2026-03-04T05:11:00Z'));
  assert.ok(fires('0 0 * * 1-5', '2026-03-02T00:00:00Z')); // a Monday
  assert.ok(!fires('0 0 * * 1-5', '2026-03-01T00:00:00Z')); // a Sunday
  assert.ok(fires('0 13 2 6 *', '2026-06-02T13:00:00Z'));
  assert.ok(fires('15,45 8-10/2 * * *', '2026-01-01T10:45:00Z'));
  assert.ok(!fires('15,45 8-10/2 * * *', '2026-01-01T09:45:00Z'));
  // "5/20" is 5, 25, 45.
  assert.ok(fires('5/20 * * * *', '2026-01-01T00:45:00Z'));
  assert.ok(!fires('5/20 * * * *', '2026-01-01T00:40:00Z'));
});

test('month and weekday names, and 7 for Sunday', () => {
  assert.ok(fires('0 9 * jan-mar sun', '2026-02-01T09:00:00Z'));
  assert.ok(fires('0 9 * * 7', '2026-02-01T09:00:00Z'));
  assert.ok(fires('0 9 * * MON', '2026-02-02T09:00:00Z'));
  assert.throws(() => parseSchedule('0 9 * * funday'), /day of week/);
});

test('either day field may match when both are restricted, both when one is a star', () => {
  // The 1st, or any Monday.
  assert.ok(fires('0 0 1 * 1', '2026-03-09T00:00:00Z'));
  assert.ok(fires('0 0 1 * 1', '2026-03-01T00:00:00Z'));
  assert.ok(!fires('0 0 1 * 1', '2026-03-10T00:00:00Z'));
  // Every day of the month, but only Mondays.
  assert.ok(!fires('0 0 * * 1', '2026-03-10T00:00:00Z'));
});

test('$ is the last day of the month', () => {
  assert.ok(fires('0 0 $ * *', '2026-02-28T00:00:00Z'));
  assert.ok(fires('0 0 $ * *', '2028-02-29T00:00:00Z'));
  assert.ok(!fires('0 0 $ * *', '2028-02-28T00:00:00Z'));
  assert.ok(fires('0 0 15,$ * *', '2026-04-30T00:00:00Z'));
  assert.throws(() => parseSchedule('$ * * * *'));
});

test('macros', () => {
  assert.ok(fires('@daily', '2026-05-05T00:00:00Z'));
  assert.ok(fires('@hourly', '2026-05-05T07:00:00Z'));
  assert.ok(!fires('@hourly', '2026-05-05T07:01:00Z'));
  assert.ok(fires('@weekly', '2026-05-03T00:00:00Z'));
  assert.throws(() => parseSchedule('@reboot'), /not supported/);
});

test('bad schedules are refused with a reason', () => {
  for (const bad of ['', '* * * *', '* * * * * *', '60 * * * *', '* 24 * * *', '* * 0 * *', '* * * 13 *', '5-1 * * * *', '*/0 * * * *', 'a b c d e', '1-2-3 * * * *', '* * * * 8']) {
    assert.throws(() => parseSchedule(bad), Error, bad);
  }
});
