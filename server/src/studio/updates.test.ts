import assert from 'node:assert/strict';
import test from 'node:test';
import { isNewer, releaseVersion, updateStatus } from './updates.js';

test('only plain release versions count', () => {
  assert.deepEqual(releaseVersion('v0.2.0'), [0, 2, 0]);
  assert.deepEqual(releaseVersion('1.10.3'), [1, 10, 3]);
  assert.equal(releaseVersion('0.2.0-rc.1'), null);
  assert.equal(releaseVersion('0.1.0-edge+1a2b3c4'), null);
  assert.equal(releaseVersion('0.1.0-dev'), null);
  assert.equal(releaseVersion('latest'), null);
});

test('isNewer compares numerically', () => {
  assert.equal(isNewer('v0.10.0', '0.9.9'), true);
  assert.equal(isNewer('v1.0.0', '0.99.0'), true);
  assert.equal(isNewer('v0.2.0', '0.2.0'), false);
  assert.equal(isNewer('v0.1.9', '0.2.0'), false);
  // Development and edge builds never see a notice.
  assert.equal(isNewer('v0.2.0', '0.1.0-edge+1a2b3c4'), false);
});

test('development builds do not ask GitHub', () => {
  // The test process has no KEEL_BUILD_VERSION, so this is a -dev build.
  assert.equal(updateStatus().check === 'on', false);
});
