import { test } from 'node:test';
import assert from 'node:assert/strict';
import { upstreamUrl } from './proxy.js';

test('upstream URLs keep the configured host', () => {
  assert.equal(upstreamUrl('http://keel-rest:3000', '/my-app/todos?select=*')?.href, 'http://keel-rest:3000/my-app/todos?select=*');
  assert.equal(upstreamUrl('http://keel-storage:5000', '/object/public/b/a%2F..%2Fx')?.host, 'keel-storage:5000');
});

test('scheme-relative and backslash paths are rejected', () => {
  assert.equal(upstreamUrl('http://keel-storage:5000', '//keel-docker:2375/containers/json'), null);
  assert.equal(upstreamUrl('http://keel-storage:5000', '/\\\\evil.test/x'), null);
  assert.equal(upstreamUrl('http://keel-storage:5000', '\\\\evil.test/x'), null);
  assert.equal(upstreamUrl('http://keel-storage:5000', 'http://evil.test/'), null);
  assert.equal(upstreamUrl('http://keel-storage:5000', '/a\r\nHost: x'), null);
});
