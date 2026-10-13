import assert from 'node:assert/strict';
import test from 'node:test';
import { CONTROL_SCHEMA, imageLevel, newerThanImage } from './schema-guard.js';

const image = { migration: 10, control: 1 };

test('a fresh or older database is fine', () => {
  assert.equal(newerThanImage(image, { recorded: null, projects: [] }), null);
  assert.equal(newerThanImage(image, { recorded: null, projects: [{ name: 'my-app', migration: 8 }] }), null);
  assert.equal(newerThanImage(image, { recorded: { version: '0.1.0', migration: 10, control: 1 }, projects: [{ name: 'my-app', migration: 10 }] }), null);
});

test('a project with upgrades this image does not know stops it', () => {
  const msg = newerThanImage(image, { recorded: null, projects: [{ name: 'crm', migration: 12 }] }, '0.1.0');
  assert.match(msg ?? '', /project crm has schema upgrade 12/);
  assert.match(msg ?? '', /\.\/keel rollback --restore/);
  assert.match(msg ?? '', /\.\/keel update/);
});

test('a newer recorded control schema stops it', () => {
  const msg = newerThanImage(image, { recorded: { version: '0.3.0', migration: 10, control: 2 }, projects: [] });
  assert.match(msg ?? '', /last upgraded by Keel 0\.3\.0/);
});

test('the image level is the highest numbered project migration', async () => {
  const level = await imageLevel();
  assert.ok(level.migration >= 10);
  assert.equal(level.control, CONTROL_SCHEMA);
});
