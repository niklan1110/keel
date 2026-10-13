import assert from 'node:assert/strict';
import test from 'node:test';
import { isPassiveType, mimeAllowed, normalizeContentType, parseContentType } from './mime.js';

test('normalizeContentType keeps one lowercase type/subtype and a charset for text', () => {
  assert.equal(normalizeContentType('image/png'), 'image/png');
  assert.equal(normalizeContentType('IMAGE/PNG'), 'image/png');
  assert.equal(normalizeContentType('  image/png  '), 'image/png');
  assert.equal(normalizeContentType('image/png;'), 'image/png');
  assert.equal(normalizeContentType('text/plain;charset=UTF-8'), 'text/plain;charset=UTF-8');
  assert.equal(normalizeContentType('Text/Plain; charset="utf-8"; format=flowed'), 'text/plain;charset=utf-8');
  assert.equal(normalizeContentType('application/json; charset=utf-8'), 'application/json');
  assert.equal(normalizeContentType('image/svg+xml'), 'image/svg+xml');
  assert.equal(normalizeContentType('application/vnd.openxmlformats-officedocument.wordprocessingml.document'), 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
  assert.equal(normalizeContentType('text/plain; charset=utf~8'), 'text/plain', 'an odd charset is dropped');
  assert.deepEqual(parseContentType('text/csv; charset=utf-8'), { essence: 'text/csv', type: 'text', subtype: 'csv', charset: 'utf-8', value: 'text/csv;charset=utf-8' });
});

test('normalizeContentType refuses lists, stray characters and malformed values', () => {
  for (const bad of [
    'image/png, text/html',
    'image/png,text/html',
    'text/plain; charset=utf-8, text/html',
    'text/plain; x="a,b"',
    'text/html\0',
    'text/html\r\nx-evil: 1',
    'image/png ',
    'image',
    'image/',
    '/png',
    'image/png/x',
    'image /png',
    'image/ png',
    'image/*',
    '*/*',
    'image/png; charset',
    'image/png; =x',
    'image/png; a=b c',
    'image/png; a="b\\"c"',
    '',
    'x'.repeat(300) + '/png',
    undefined,
    null,
    42,
  ]) {
    assert.equal(normalizeContentType(bad), null, JSON.stringify(bad));
  }
});

test('mimeAllowed compares the normalized type with the bucket allow list', () => {
  assert.equal(mimeAllowed(null, 'text/html'), true);
  assert.equal(mimeAllowed([], 'text/html'), true);
  assert.equal(mimeAllowed(null, 'image/png, text/html'), false, 'an invalid type never passes');
  assert.equal(mimeAllowed(['image/*'], 'image/png'), true);
  assert.equal(mimeAllowed(['image/*'], 'IMAGE/PNG'), true);
  assert.equal(mimeAllowed(['image/*'], 'image/png, text/html'), false);
  assert.equal(mimeAllowed(['image/*'], 'imagex/png'), false);
  assert.equal(mimeAllowed(['image/*'], 'text/html'), false);
  assert.equal(mimeAllowed(['Application/PDF'], 'application/pdf'), true);
  assert.equal(mimeAllowed(['text/plain'], 'text/plain;charset=UTF-8'), true);
  assert.equal(mimeAllowed(['text/plain;charset=utf-8'], 'text/plain'), true);
  assert.equal(mimeAllowed(['text/plain'], 'text/plain-evil'), false);
});

test('isPassiveType: only known inert types skip the sandbox', () => {
  for (const ok of ['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'audio/mpeg', 'video/mp4', 'application/pdf', 'text/plain', 'text/plain;charset=UTF-8', 'text/csv', 'application/json', 'application/octet-stream', 'font/woff2', 'application/zip']) {
    assert.equal(isPassiveType(ok), true, ok);
  }
  for (const active of ['text/html', 'image/svg+xml', 'application/xhtml+xml', 'text/xml', 'application/xml', 'text/javascript', 'application/javascript', 'text/css', 'text/markdown', 'application/x-shockwave-flash', 'application/vnd.example', 'image/png, text/html', 'video/x-ms-asx+xml', '']) {
    assert.equal(isPassiveType(active), false, active);
  }
});
