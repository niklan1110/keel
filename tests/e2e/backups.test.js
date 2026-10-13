// Full backups through Studio's API: settings, the off-machine target, and a
// full backup run.
//
// The full backup tests need KEEL_BACKUP_PASSPHRASE set for the stack. The
// upload test also needs an S3-compatible server that keel-studio can reach,
// given as KEEL_E2E_S3=http://<access key>:<secret>@<host>:<port>/<bucket>
// (the address as seen from the keel-studio container). In CI, for example:
//
//   docker run -d --name keel-e2e-s3 --network keel_default \
//     -e ROOT_ACCESS_KEY=e2eaccess -e ROOT_SECRET_KEY=e2esecret123 \
//     versity/versitygw:v1.8.0 posix /tmp
//   docker exec keel-e2e-s3 mkdir -p /tmp/keel-e2e
//   KEEL_E2E_S3=http://e2eaccess:e2esecret123@keel-e2e-s3:7070/keel-e2e npm run test:e2e
//
// Without them those tests are skipped (or fail with KEEL_E2E_REQUIRE_ALL=1).

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { STUDIO, env, needsConfig, studio } from './helpers.js';

let original;

before(async () => {
  const r = await studio('GET', '/api/backups');
  assert.equal(r.status, 200, JSON.stringify(r.data));
  original = r.data;
});

after(async () => {
  // Put the stack's own settings back.
  if (!original) return;
  await studio('PUT', '/api/backups/settings', { schedule: original.scheduleSetHere ? original.schedule : null, keepDaily: original.keepDaily, keepWeekly: original.keepWeekly });
  if (!original.target) await studio('PUT', '/api/backups/settings', { target: null });
});

async function waitForFullBackup(id) {
  for (let i = 0; i < 120; i++) {
    const r = await studio('GET', '/api/backups');
    const s = r.data.sets.find((x) => x.id === id);
    if (s && s.status !== 'running' && s.remote !== 'uploading') return s;
    await new Promise((res) => setTimeout(res, 500));
  }
  throw new Error('the full backup did not finish in time');
}

test('backup settings: the schedule and retention are checked and saved', async () => {
  for (const schedule of ['25:00', '3am', '']) {
    const bad = await studio('PUT', '/api/backups/settings', { schedule });
    assert.equal(bad.status, 400, `schedule ${JSON.stringify(schedule)}`);
  }
  assert.equal((await studio('PUT', '/api/backups/settings', { keepDaily: -1 })).status, 400);
  const ok = await studio('PUT', '/api/backups/settings', { schedule: '4:30', keepDaily: 3, keepWeekly: 2 });
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  assert.equal(ok.data.schedule, '04:30');
  assert.equal(ok.data.scheduleSetHere, true);
  assert.equal(ok.data.keepDaily, 3);
  const instance = await studio('GET', '/api/instance');
  assert.equal(instance.data.backupSchedule, '04:30');
  const back = await studio('PUT', '/api/backups/settings', { schedule: null });
  assert.equal(back.data.scheduleSetHere, false);
});

test('the backup target keeps its secret key on the server', async (t) => {
  if (original.target || original.envTarget) return needsConfig(t, 'this stack already has a backup target');
  const secret = `e2e-secret-${Date.now()}`;
  const target = { endpoint: 'http://127.0.0.1:9', region: 'us-east-1', bucket: 'e2e-bucket', prefix: '/e2e/', accessKeyId: 'e2e-access', secretAccessKey: secret, pathStyle: true };
  assert.equal((await studio('PUT', '/api/backups/settings', { target: { ...target, endpoint: 'ftp://nope' } })).status, 400);
  assert.equal((await studio('PUT', '/api/backups/settings', { target: { ...target, prefix: '../x' } })).status, 400);
  const saved = await studio('PUT', '/api/backups/settings', { target });
  assert.equal(saved.status, 200, JSON.stringify(saved.data));
  assert.equal(saved.data.target.prefix, 'e2e/');
  assert.equal(saved.data.target.hasSecret, true);
  const all = JSON.stringify((await studio('GET', '/api/backups')).data);
  assert.ok(!all.includes(secret), 'the secret key is never sent back');
  assert.ok(!all.includes('secretSealed'));

  // Nothing listens there: the test says so instead of failing the request.
  const tried = await studio('POST', '/api/backups/test', {});
  assert.equal(tried.status, 200);
  assert.equal(tried.data.ok, false);
  assert.match(tried.data.error, /reach|ECONNREFUSED/i);
  assert.ok(!tried.data.error.includes(secret));

  // A blank secret keeps the saved one.
  const again = await studio('PUT', '/api/backups/settings', { target: { ...target, secretAccessKey: '' } });
  assert.equal(again.status, 200);
  assert.equal(again.data.target.hasSecret, true);
  const removed = await studio('PUT', '/api/backups/settings', { target: null });
  assert.equal(removed.data.target, null);
});

test('backup settings need a Studio session', async () => {
  for (const [method, path] of [
    ['GET', '/api/backups'],
    ['PUT', '/api/backups/settings'],
    ['POST', '/api/backups/full'],
    ['POST', '/api/backups/test'],
    ['GET', '/api/backups/remote'],
  ]) {
    const r = await fetch(`${STUDIO}${path}`, { method, headers: { 'X-Keel-Studio': '1', 'Content-Type': 'application/json' }, body: method === 'GET' ? undefined : '{}' });
    assert.equal(r.status, 401, `${method} ${path}`);
  }
});

test('backup ids that are not ids are not found', async () => {
  for (const id of ['not-a-uuid', '1', "x' or '1'='1"]) {
    assert.equal((await studio('DELETE', `/api/backups/full/${encodeURIComponent(id)}`)).status, 404, id);
    assert.equal((await studio('POST', `/api/backups/full/${encodeURIComponent(id)}/link`)).status, 404, id);
  }
  assert.equal((await studio('DELETE', '/api/backups/full/00000000-0000-4000-8000-000000000000')).status, 404);
});

test('a full backup is one encrypted file', async (t) => {
  if (!original.passphrase) return needsConfig(t, 'KEEL_BACKUP_PASSPHRASE is not set for this stack');
  const started = await studio('POST', '/api/backups/full');
  assert.equal(started.status, 202, JSON.stringify(started.data));
  assert.equal((await studio('POST', '/api/backups/full')).status, 409, 'one at a time');
  const s = await waitForFullBackup(started.data.id);
  assert.equal(s.status, 'ok', s.error);
  assert.match(s.file, /^keel-\d{8}-\d{6}\.tar\.age$/);

  const link = await studio('POST', `/api/backups/full/${s.id}/link`);
  assert.equal(link.status, 200);
  const dl = await fetch(`${STUDIO}${link.data.url}`);
  assert.equal(dl.status, 200);
  const head = Buffer.from(await dl.arrayBuffer());
  assert.equal(head.length, Number(s.size_bytes));
  assert.equal(head.subarray(0, 21).toString(), 'age-encryption.org/v1');
  if (env.KEEL_BACKUP_PASSPHRASE) assert.ok(!head.includes(Buffer.from(env.KEEL_BACKUP_PASSPHRASE)), 'the passphrase is not in the backup');
  assert.ok(!head.includes(Buffer.from('PGDMP')), 'no plain dump inside');

  assert.equal((await studio('DELETE', `/api/backups/full/${s.id}`)).status, 200);
});

test('a full backup is copied to an S3-compatible target and listed there', async (t) => {
  if (!original.passphrase) return needsConfig(t, 'KEEL_BACKUP_PASSPHRASE is not set for this stack');
  if (!env.KEEL_E2E_S3) return needsConfig(t, 'KEEL_E2E_S3 is not set');
  if (original.envTarget) return needsConfig(t, 'this stack has a target in .env');
  const u = new URL(env.KEEL_E2E_S3);
  const target = {
    endpoint: u.origin,
    region: 'us-east-1',
    bucket: u.pathname.slice(1),
    prefix: `e2e-${Date.now().toString(36)}`,
    accessKeyId: decodeURIComponent(u.username),
    secretAccessKey: decodeURIComponent(u.password),
    pathStyle: true,
  };
  const tested = await studio('POST', '/api/backups/test', { target });
  assert.equal(tested.data.ok, true, tested.data.error);
  assert.equal((await studio('PUT', '/api/backups/settings', { target })).status, 200);
  try {
    const started = await studio('POST', '/api/backups/full');
    assert.equal(started.status, 202, JSON.stringify(started.data));
    const s = await waitForFullBackup(started.data.id);
    assert.equal(s.status, 'ok', s.error);
    assert.equal(s.remote, 'uploaded', s.remote_error);
    const remote = await studio('GET', '/api/backups/remote');
    assert.equal(remote.status, 200, JSON.stringify(remote.data));
    const found = remote.data.backups.find((b) => b.name === s.file);
    assert.ok(found, 'the backup is in the bucket');
    assert.equal(found.size, Number(s.size_bytes));
    await studio('DELETE', `/api/backups/full/${s.id}`);
  } finally {
    await studio('PUT', '/api/backups/settings', { target: null });
  }
});
