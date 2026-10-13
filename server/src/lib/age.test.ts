import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { Readable, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import test from 'node:test';
import { DecryptError, checkPassphrase, decryptStream, encryptStream } from './age.js';

const PASS = 'correct horse battery staple';
// A low work factor keeps the tests fast; the format is the same.
const WF = 10;

async function run(input: Buffer, t: NodeJS.ReadWriteStream, pieces = 7919): Promise<Buffer> {
  const out: Buffer[] = [];
  const parts: Buffer[] = [];
  for (let i = 0; i < input.length; i += pieces) parts.push(input.subarray(i, i + pieces));
  await pipeline(
    Readable.from(parts),
    t,
    new Writable({
      write(chunk, _e, cb) {
        out.push(chunk);
        cb();
      },
    }),
  );
  return Buffer.concat(out);
}

const encrypt = (b: Buffer, pass = PASS) => run(b, encryptStream(pass, WF));
const decrypt = (b: Buffer, pass = PASS) => run(b, decryptStream(pass));

test('encrypting and decrypting gives back the same bytes, for every size around a chunk', async () => {
  const CHUNK = 64 * 1024;
  for (const size of [0, 1, 100, CHUNK - 1, CHUNK, CHUNK + 1, 2 * CHUNK, 3 * CHUNK + 17]) {
    const plain = crypto.randomBytes(size);
    const sealed = await encrypt(plain);
    assert.deepEqual(await decrypt(sealed), plain, `size ${size}`);
  }
});

test('the file is an age file with a single scrypt stanza and does not contain the passphrase', async () => {
  const sealed = await encrypt(Buffer.from('hello'));
  const text = sealed.toString('latin1');
  assert.match(text, /^age-encryption\.org\/v1\n-> scrypt [A-Za-z0-9+/]{22} 10\n[A-Za-z0-9+/]{43}\n--- [A-Za-z0-9+/]{43}\n/);
  assert.ok(!text.includes(PASS));
  assert.ok(!text.includes('hello'));
});

test('two encryptions of the same data differ (fresh salt, key and nonce)', async () => {
  const plain = Buffer.from('same data');
  assert.notDeepEqual(await encrypt(plain), await encrypt(plain));
});

test('a wrong passphrase is refused', async () => {
  const sealed = await encrypt(Buffer.from('secret rows'));
  await assert.rejects(decrypt(sealed, 'not the right passphrase'), DecryptError);
});

test('a changed byte anywhere in the payload is detected', async () => {
  const plain = crypto.randomBytes(200_000);
  const sealed = await encrypt(plain);
  const headerEnd = sealed.indexOf('\n', sealed.indexOf('\n---')) + 1;
  for (const at of [headerEnd + 3, headerEnd + 16 + 10, headerEnd + 70_000, sealed.length - 1]) {
    const bad = Buffer.from(sealed);
    bad[at] ^= 0x01;
    await assert.rejects(decrypt(bad), DecryptError, `byte ${at}`);
  }
});

test('a changed header is detected', async () => {
  const sealed = await encrypt(Buffer.from('rows'));
  const bad = Buffer.from(sealed);
  // Flip a character of the header MAC.
  const macAt = sealed.indexOf('--- ') + 5;
  bad[macAt] = bad[macAt] === 0x41 ? 0x42 : 0x41;
  await assert.rejects(decrypt(bad), DecryptError);
});

test('a file cut short, even at a chunk boundary, is detected', async () => {
  const CHUNK = 64 * 1024;
  const sealed = await encrypt(crypto.randomBytes(3 * CHUNK));
  const headerEnd = sealed.indexOf('\n', sealed.indexOf('\n---')) + 1;
  for (const len of [sealed.length - 1, headerEnd + 16 + 2 * (CHUNK + 16), headerEnd + 16 + CHUNK + 16, headerEnd + 16, headerEnd - 5]) {
    await assert.rejects(decrypt(sealed.subarray(0, len)), DecryptError, `length ${len}`);
  }
});

test('extra bytes appended after the last chunk are detected', async () => {
  const sealed = await encrypt(Buffer.from('rows'));
  await assert.rejects(decrypt(Buffer.concat([sealed, Buffer.from('more')])), DecryptError);
});

test('chunks swapped around are detected', async () => {
  const CHUNK = 64 * 1024;
  const sealed = await encrypt(crypto.randomBytes(3 * CHUNK + 5));
  const start = sealed.indexOf('\n', sealed.indexOf('\n---')) + 1 + 16;
  const c = CHUNK + 16;
  const swapped = Buffer.concat([sealed.subarray(0, start), sealed.subarray(start + c, start + 2 * c), sealed.subarray(start, start + c), sealed.subarray(start + 2 * c)]);
  await assert.rejects(decrypt(swapped), DecryptError);
});

test('files that are not age files, or ask for too much work, are refused', async () => {
  await assert.rejects(decrypt(Buffer.from('PGDMP not encrypted at all\n')), DecryptError);
  const sealed = (await encrypt(Buffer.from('x'))).toString('latin1').replace(' 10\n', ' 30\n');
  await assert.rejects(decrypt(Buffer.from(sealed, 'latin1')), /too much work/);
});

test('the work factor Keel writes is accepted, one step more is refused before scrypt runs', async () => {
  const sealed = (await encrypt(Buffer.from('x'))).toString('latin1');
  // The MAC no longer matches after the edit, but the work factor is checked first.
  const at18 = Buffer.from(sealed.replace(' 10\n', ' 18\n'), 'latin1');
  await assert.rejects(decrypt(at18), (err: Error) => err instanceof DecryptError && !/too much work/.test(err.message));
  const at19 = Buffer.from(sealed.replace(' 10\n', ' 19\n'), 'latin1');
  const started = Date.now();
  await assert.rejects(decrypt(at19), /too much work/);
  assert.ok(Date.now() - started < 500, 'refused without deriving a key');
});

test('short or missing passphrases are refused', () => {
  assert.throws(() => checkPassphrase(undefined), /No backup passphrase/);
  assert.throws(() => checkPassphrase('short'), /at least 12/);
  assert.equal(checkPassphrase(PASS), PASS);
});
