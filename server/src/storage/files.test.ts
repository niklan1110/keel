import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { config } from '../lib/config.js';
import { objectPath, relativeObjectPath, removeObject } from './files.js';

const ID = '3f1c2d4e-5a6b-4c7d-8e9f-0a1b2c3d4e5f';

test('objectPath accepts the versions Keel writes: a UUID, or v0 for rows without one', () => {
  const root = path.resolve(config.storage.root);
  const file = objectPath('my_app', 'avatars', ID, 'b2c3d4e5-f6a7-4b8c-9d0e-1f2a3b4c5d6e');
  assert.equal(file, path.join(root, 'my_app', 'avatars', ID, 'b2c3d4e5-f6a7-4b8c-9d0e-1f2a3b4c5d6e'));
  assert.equal(objectPath('my_app', 'avatars', ID, 'v0'), path.join(root, 'my_app', 'avatars', ID, 'v0'));
});

test('objectPath refuses a version or id that is not one Keel writes', () => {
  for (const bad of ['../../../../etc/passwd', '..', '.', '', 'v0/../../x', 'a/b', 'a\\b', '/etc/passwd', 'v1', `${ID}\n`, `${ID}/..`]) {
    assert.throws(() => objectPath('my_app', 'avatars', ID, bad), { status: 404 }, `version ${JSON.stringify(bad)}`);
    assert.throws(() => relativeObjectPath('my_app', 'avatars', ID, bad), { status: 404 }, `version ${JSON.stringify(bad)}`);
  }
  assert.throws(() => objectPath('my_app', 'avatars', '../x', 'v0'), { status: 404 });
});

test('objectPath keeps unusual bucket ids inside the storage root', () => {
  const root = path.resolve(config.storage.root);
  for (const bucket of ['..', '../..', 'a/../../b', '.hidden']) {
    const file = objectPath('my_app', bucket, ID, 'v0');
    assert.ok(file.startsWith(path.join(root, 'my_app') + path.sep), `${bucket} -> ${file}`);
  }
});

test('removeObject ignores rows with a crafted version instead of deleting elsewhere', async () => {
  await assert.doesNotReject(removeObject('my_app', 'avatars', ID, '../../../../etc/passwd'));
});
