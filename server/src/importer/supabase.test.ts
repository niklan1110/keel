import assert from 'node:assert/strict';
import test from 'node:test';
import { safeStorageKey, splitPassword } from './supabase.js';

test('safeStorageKey accepts ordinary bucket ids and file names', () => {
  assert.equal(safeStorageKey('avatars', 'a1b2/me.png'), true);
  assert.equal(safeStorageKey('my bucket', 'folder/sub folder/file name (1).pdf'), true);
  assert.equal(safeStorageKey('avatars', '.hidden/..file..'), true, 'dots inside a segment are fine');
  assert.equal(safeStorageKey('avatars', 'ünïcode/文件.txt'), true);
});

test('safeStorageKey refuses names that could change the URL they are copied through', () => {
  for (const [bucket, name] of [
    ['avatars', '../other/x.png'],
    ['avatars', 'a/../../bucket/avatars/empty'],
    ['avatars', 'a/./b'],
    ['avatars', '..'],
    ['avatars', 'a\\..\\b'],
    ['avatars', '/abs'],
    ['avatars', 'a\nb'],
    ['avatars', 'a\0b'],
    ['avatars', 'a\x7fb'],
    ['avatars', ''],
    ['avatars', 'x'.repeat(1025)],
    ['..', 'x.png'],
    ['.', 'x.png'],
    ['a/b', 'x.png'],
    ['a\\b', 'x.png'],
    ['a\tb', 'x.png'],
    ['', 'x.png'],
    [null, 'x.png'],
    ['avatars', null],
  ]) {
    assert.equal(safeStorageKey(bucket, name), false, JSON.stringify([bucket, name]));
  }
});

test('splitPassword moves the password out of the connection string', () => {
  assert.deepEqual(splitPassword('postgresql://postgres.abcd:p%40ss%2Fw0rd@aws-0-eu.pooler.supabase.com:5432/postgres?sslmode=require'), {
    url: 'postgresql://postgres.abcd@aws-0-eu.pooler.supabase.com:5432/postgres?sslmode=require',
    password: 'p@ss/w0rd',
  });
  assert.deepEqual(splitPassword('postgres://u@h/db?password=secret&sslmode=disable'), { url: 'postgres://u@h/db?sslmode=disable', password: 'secret' });
  assert.deepEqual(splitPassword('postgresql://u@h:5432/db'), { url: 'postgresql://u@h:5432/db', password: '' });
});
