import assert from 'node:assert/strict';
import test from 'node:test';
import { nameMismatch, olderThanName } from './restore.js';

const madeAt = (d: Date) => d.toISOString();

test('a backup whose name matches what is inside gives no warning', () => {
  const t = new Date(2026, 9, 3, 3, 0, 5);
  assert.equal(nameMismatch('keel-20261003-030005.tar.age', { createdAt: madeAt(t), file: 'keel-20261003-030005.tar.age' }), null);
  // Without a recorded name, a time within a time zone's difference is fine.
  assert.equal(nameMismatch('keel-20261003-030005.tar.age', { createdAt: madeAt(new Date(t.getTime() + 9 * 3600_000)) }), null);
});

test('an older backup renamed to look newer is pointed out', () => {
  const old = new Date(2026, 8, 1, 3, 0, 0);
  assert.match(nameMismatch('keel-20261003-030005.tar.age', { createdAt: madeAt(old), file: 'keel-20260901-030000.tar.age' }) ?? '', /written as keel-20260901-030000/);
  assert.match(nameMismatch('keel-20261003-030005.tar.age', { createdAt: madeAt(old) }) ?? '', /made 2026-09-01/);
});

test('--list points out files saved before the time in their name', () => {
  const name = 'keel-20261003-030005.tar.age';
  assert.equal(olderThanName(name, new Date(2026, 9, 3, 3, 1)), false);
  assert.equal(olderThanName(name, new Date(2026, 9, 10)), false, 'copied later is fine');
  assert.equal(olderThanName(name, new Date(2026, 8, 1)), true);
  assert.equal(olderThanName('other.tar.age', new Date(2000, 0, 1)), false);
});

test('files with other names are not judged by their name', () => {
  assert.equal(nameMismatch('my-backup.tar.age', { createdAt: madeAt(new Date(2020, 0, 1)) }), null);
});
