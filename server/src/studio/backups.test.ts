import assert from 'node:assert/strict';
import test from 'node:test';

// config reads KEEL_SECRET once, when it's first imported.
const SECRET = 'e'.repeat(64);
process.env.KEEL_SECRET = SECRET;
const { downloadToken, readDownloadToken, DOWNLOAD_LINK_TTL_S } = await import('./backups.js');
const { sign } = await import('../lib/jwt.js');
const { sessionKey } = await import('./accounts.js');

const SID = '0b7f3c52-5f0e-4a43-9a3c-1f6f3d1c2b11';

test('a download link names the file and the Studio session that asked for it', () => {
  const now = Date.now();
  const token = downloadToken('my-app/20260101-030000.dump', SID, now);
  assert.deepEqual(readDownloadToken(token, now + 1000), { file: 'my-app/20260101-030000.dump', sid: SID });
});

test('download links expire quickly', () => {
  const now = Date.now();
  const token = downloadToken('my-app/x.dump', SID, now);
  assert.throws(() => readDownloadToken(token, now + (DOWNLOAD_LINK_TTL_S + 1) * 1000));
});

test('links signed with KEEL_SECRET itself, or without a session, are refused', () => {
  const iat = Math.floor(Date.now() / 1000);
  assert.throws(() => readDownloadToken(sign({ kind: 'backup-download', file: 'my-app/x.dump', sid: SID, iat, exp: iat + 60 }, SECRET)));
  const noSession = sign({ kind: 'backup-download', file: 'my-app/x.dump', iat, exp: iat + 60 }, SECRET);
  assert.throws(() => readDownloadToken(noSession));
});

test('a Studio session token is not a download link', () => {
  const iat = Math.floor(Date.now() / 1000);
  assert.throws(() => readDownloadToken(sign({ kind: 'studio', sid: SID, sub: 'u', iat, exp: iat + 60 }, sessionKey())));
});
