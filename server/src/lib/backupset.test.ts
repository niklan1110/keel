import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { FORMAT, restorableMemberships, restoreProblem, storageTarget, type Manifest } from './backupset.js';

const root = path.resolve('/var/lib/keel/storage');

test('files in a backup are only ever written inside the storage folder', () => {
  assert.equal(storageTarget('storage/my_app/pics/o1/v1', root), path.join(root, 'my_app/pics/o1/v1'));
  for (const bad of ['storage/../etc/passwd', 'storage/my_app/../../x', 'storage/', 'storage//x', 'db/keel.dump', 'storage/a\0b', '/etc/passwd', '../storage/x']) {
    assert.equal(storageTarget(bad, root), null, bad);
  }
});

const manifest = (over: Partial<Manifest> = {}): Manifest => ({
  format: FORMAT,
  formatVersion: 1,
  keelVersion: '0.3.0',
  createdAt: new Date().toISOString(),
  schema: { migration: 12, control: 1 },
  databases: [{ name: 'keel', project: null, file: 'db/keel.dump', bytes: 10 }],
  roles: [],
  memberships: [],
  storage: { files: 0, bytes: 0 },
  ...over,
});

test('a backup from a newer Keel is refused before anything changes', () => {
  assert.equal(restoreProblem(manifest(), { migration: 12, control: 1 }), null);
  assert.equal(restoreProblem(manifest(), { migration: 13, control: 1 }), null);
  assert.match(restoreProblem(manifest({ schema: { migration: 14, control: 1 } }), { migration: 13, control: 1 }) ?? '', /newer than this Keel/);
  assert.match(restoreProblem(manifest({ schema: { migration: 12, control: 2 } }), { migration: 12, control: 1 }) ?? '', /newer/);
});

test('a backup without the control database is refused', () => {
  assert.match(restoreProblem(manifest({ databases: [] }), { migration: 12, control: 1 }) ?? '', /control database/);
});

test("a backup can't name Postgres' own databases, or a dump file that isn't its database's", () => {
  const level = { migration: 12, control: 1 };
  const keel = { name: 'keel', project: null, file: 'db/keel.dump', bytes: 10 };
  for (const name of ['postgres', 'template0', 'template1']) {
    assert.match(restoreProblem(manifest({ databases: [keel, { name, project: 'x', file: `db/${name}.dump`, bytes: 1 }] }), level) ?? '', /won't restore/, name);
  }
  assert.match(restoreProblem(manifest({ databases: [keel, { name: 'other_db', project: 'x', file: 'db/p_app.dump', bytes: 1 }] }), level) ?? '', /won't restore/);
  assert.equal(restoreProblem(manifest({ databases: [keel, { name: 'p_app', project: 'app', file: 'db/p_app.dump', bytes: 1 }] }), level), null);
});

test('a restore only puts back memberships of the roles the backup lists, never of a superuser or pg_ role', () => {
  const m = manifest({
    roles: [{ name: 'p_app_owner', login: true }, { name: 'reporting', login: true }, { name: 'authenticator', login: true }],
    memberships: [
      { role: 'keel_project_owners', member: 'p_app_owner' },
      { role: 'reporting', member: 'p_app_owner' },
      { role: 'postgres', member: 'reporting' },
      { role: 'pg_execute_server_program', member: 'reporting' },
      { role: 'service_role', member: 'anon' },
      { role: 'postgres', member: 'authenticator' },
      { role: 'service_role', member: 'authenticator' },
    ],
  });
  assert.deepEqual(restorableMemberships(m, new Set(['postgres'])), [
    { role: 'keel_project_owners', member: 'p_app_owner' },
    { role: 'reporting', member: 'p_app_owner' },
  ]);
});
