import assert from 'node:assert/strict';
import test from 'node:test';
import { backupsToKeep, setName, setTime } from './retention.js';

const at = (y: number, m: number, d: number, h = 3) => setName(new Date(y, m - 1, d, h, 0, 0));

test('backup names carry their time', () => {
  const name = setName(new Date(2026, 9, 3, 3, 0, 5));
  assert.equal(name, 'keel-20261003-030005.tar.age');
  assert.equal(setTime(name)?.getTime(), new Date(2026, 9, 3, 3, 0, 5).getTime());
  assert.equal(setTime('notes.txt'), null);
  assert.equal(setTime('keel-20261003-030005.tar'), null);
});

test('keeps the newest backup of each of the last N days', () => {
  const names = [at(2026, 10, 1), at(2026, 10, 2), at(2026, 10, 2, 15), at(2026, 10, 3), at(2026, 10, 4)];
  const keep = backupsToKeep(names, 2, 0);
  assert.deepEqual([...keep].sort(), [at(2026, 10, 3), at(2026, 10, 4)]);
});

test('keeps the newest backup of each of the last N weeks as well', () => {
  // 2026-09-14 and 2026-09-21 are Mondays.
  const names = [at(2026, 9, 14), at(2026, 9, 16), at(2026, 9, 20), at(2026, 9, 21), at(2026, 9, 22), at(2026, 9, 23)];
  const keep = backupsToKeep(names, 1, 2);
  // Newest overall (Sep 23, also its week's), and the newest of the week before (Sunday Sep 20).
  assert.deepEqual([...keep].sort(), [at(2026, 9, 20), at(2026, 9, 23)]);
});

test('always keeps the newest backup, and never touches other files', () => {
  const names = [at(2026, 10, 1), 'README.txt', at(2026, 10, 2)];
  const keep = backupsToKeep(names, 0, 0);
  assert.deepEqual([...keep].sort(), ['README.txt', at(2026, 10, 2)].sort());
});

test('nothing to keep from nothing', () => {
  assert.equal(backupsToKeep([], 7, 4).size, 0);
});
