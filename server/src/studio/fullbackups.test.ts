import assert from 'node:assert/strict';
import test from 'node:test';
import { deleteSet, setFile } from './fullbackups.js';

test('backup ids that are not UUIDs are not found, without asking the database', async () => {
  for (const id of ['not-a-uuid', '1', "x' or '1'='1", '00000000-0000-4000-8000-00000000000z']) {
    await assert.rejects(deleteSet(id), (err: Error & { status?: number }) => err.status === 404, id);
    await assert.rejects(setFile(id), (err: Error & { status?: number }) => err.status === 404, id);
  }
});
