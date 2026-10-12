import assert from 'node:assert/strict';
import test from 'node:test';
import { parseMetadata, uploadLocation } from './tus.js';

test('parseMetadata decodes TUS Upload-Metadata', () => {
  const b64 = (s: string) => Buffer.from(s).toString('base64');
  assert.deepEqual(parseMetadata(`bucketName ${b64('avatars')},objectName ${b64('a/b c.png')}, empty`), {
    bucketName: 'avatars',
    objectName: 'a/b c.png',
    empty: '',
  });
  assert.deepEqual(parseMetadata(undefined), {});
});

test('uploadLocation is a path, so clients continue on the address they used', () => {
  assert.equal(uploadLocation('http://localhost:8000', 'my-app', 'abc'), '/my-app/storage/v1/upload/resumable/abc');
  assert.equal(uploadLocation('https://example.com/keel/', 'my-app', 'abc'), '/keel/my-app/storage/v1/upload/resumable/abc');
  assert.equal(uploadLocation('', 'my-app', 'abc'), '/my-app/storage/v1/upload/resumable/abc');
});
