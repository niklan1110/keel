import assert from 'node:assert/strict';
import test from 'node:test';
import { config } from './config.js';
import { connectionOptions } from './db.js';

test("the superuser's connections resolve names in pg_catalog only", () => {
  // With a project's search_path, an owner role's public.make_interval(text)
  // or public.format(text, text) ran as the superuser in Keel's own queries.
  assert.equal(connectionOptions(config.db.superuser), '-c search_path=pg_catalog');
  // SQL a Studio admin writes asks for the project's path.
  assert.equal(connectionOptions(config.db.superuser, true), undefined);
  // Service roles keep the database's path.
  assert.equal(connectionOptions('keel_auth_admin'), undefined);
});
