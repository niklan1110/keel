import assert from 'node:assert/strict';
import test from 'node:test';

process.env.KEEL_SECRET = 'f'.repeat(64);
const { cleanPrefix, envTarget, openSecret, sealSecret } = await import('./backup-target.js');

test('folder names in the bucket are tidied and checked', () => {
  assert.equal(cleanPrefix(''), '');
  assert.equal(cleanPrefix(undefined), '');
  assert.equal(cleanPrefix('/keel/'), 'keel/');
  assert.equal(cleanPrefix('backups/nas-1'), 'backups/nas-1/');
  for (const bad of ['../x', 'a/../b', 'a//b', './a', 'a b', 'a?b', 'x'.repeat(201)]) assert.throws(() => cleanPrefix(bad), /folder/, bad);
});

test("the target's secret key is sealed, and can't be read with another KEEL_SECRET", () => {
  const sealed = sealSecret('my-secret-key');
  assert.ok(!sealed.includes('my-secret-key'));
  assert.equal(openSecret(sealed), 'my-secret-key');
  const [v, iv, tag, data] = sealed.split(':');
  const flipped = Buffer.from(data, 'base64');
  flipped[0] ^= 1;
  assert.throws(() => openSecret([v, iv, tag, flipped.toString('base64')].join(':')), /KEEL_SECRET/);
});

test('a target in .env needs only the bucket; the rest has defaults', () => {
  assert.equal(envTarget({}), null);
  const t = envTarget({ KEEL_BACKUP_S3_BUCKET: 'b', KEEL_BACKUP_S3_REGION: 'eu-central-1', KEEL_BACKUP_S3_PREFIX: 'nas' });
  assert.equal(t?.endpoint, 'https://s3.eu-central-1.amazonaws.com');
  assert.equal(t?.prefix, 'nas/');
  assert.equal(t?.pathStyle, true);
  assert.equal(envTarget({ KEEL_BACKUP_S3_BUCKET: 'b', KEEL_BACKUP_S3_PATH_STYLE: 'off' })?.pathStyle, false);
});
