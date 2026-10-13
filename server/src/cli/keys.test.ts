import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseKeysArgs } from './keys.js';

test('keys arguments: command, project and options in any order', () => {
  assert.deepEqual(parseKeysArgs(['roll', 'my-app', '--grace', '48']), { cmd: 'roll', project: 'my-app', grace: '48', emergency: false, yes: false });
  assert.deepEqual(parseKeysArgs(['--emergency', 'roll', '--yes', 'my-app']), { cmd: 'roll', project: 'my-app', grace: undefined, emergency: true, yes: true });
  assert.equal(parseKeysArgs(['roll', 'my-app', '--grace=2']).grace, '2');
  assert.throws(() => parseKeysArgs(['roll', 'my-app', '--force']), /unknown option --force/);
});
