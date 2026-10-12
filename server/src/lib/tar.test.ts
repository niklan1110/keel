import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { readTar, tarStream, type TarSource } from './tar.js';

async function collect(gen: AsyncIterable<Buffer>): Promise<Buffer> {
  const parts: Buffer[] = [];
  for await (const b of gen) parts.push(b);
  return Buffer.concat(parts);
}

const file = (name: string, data: Buffer): TarSource => ({ name, size: data.length, body: () => [data] });

async function* chunks(b: Buffer, size: number) {
  for (let i = 0; i < b.length; i += size) yield b.subarray(i, i + size);
}

test('files written to a tar stream come back with their names and bytes', async () => {
  const long = `storage/my_app/avatars/${'a'.repeat(40)}/${crypto.randomUUID()}/${crypto.randomUUID()}`;
  const files = [file('manifest.json', Buffer.from('{"a":1}')), file('db/keel.dump', crypto.randomBytes(70_000)), file(long, crypto.randomBytes(513)), file('empty', Buffer.alloc(0))];
  const tar = await collect(tarStream(files));
  assert.equal(tar.length % 512, 0);
  const got: { name: string; data: Buffer }[] = [];
  // Odd chunk sizes, as from a decrypting stream.
  for await (const e of readTar(chunks(tar, 1000))) got.push({ name: e.name, data: await collect(e.body) });
  assert.deepEqual(
    got.map((g) => g.name),
    files.map((f) => f.name),
  );
  for (let i = 0; i < files.length; i++) assert.deepEqual(got[i].data, (files[i].body() as Buffer[])[0]);
});

test('entries the reader skips are passed over', async () => {
  const tar = await collect(tarStream([file('a', crypto.randomBytes(5000)), file('b', Buffer.from('second'))]));
  const names: string[] = [];
  let b = '';
  for await (const e of readTar(chunks(tar, 333))) {
    names.push(e.name);
    if (e.name === 'b') b = (await collect(e.body)).toString();
  }
  assert.deepEqual(names, ['a', 'b']);
  assert.equal(b, 'second');
});

test('a file that delivers fewer bytes than announced is padded, more are cut off', async () => {
  const tar = await collect(
    tarStream([
      { name: 'short', size: 10, body: () => [Buffer.from('abc')] },
      { name: 'long', size: 3, body: () => [Buffer.from('abcdef')] },
    ]),
  );
  const got: Buffer[] = [];
  for await (const e of readTar(chunks(tar, 512))) got.push(await collect(e.body));
  assert.deepEqual(got[0], Buffer.concat([Buffer.from('abc'), Buffer.alloc(7)]));
  assert.equal(got[1].toString(), 'abc');
});

test('a tar stream cut short is an error', async () => {
  const tar = await collect(tarStream([file('a', crypto.randomBytes(5000))]));
  await assert.rejects(async () => {
    for await (const e of readTar(chunks(tar.subarray(0, 3000), 700))) await collect(e.body);
  }, /cut short/);
  await assert.rejects(async () => {
    for await (const e of readTar(chunks(tar.subarray(0, tar.length - 1024), 700))) await collect(e.body);
  }, /end marker/);
});

/** A raw ustar header block, for archives the writer would never make. */
function rawHeader(name: string, size: number, type: string): Buffer {
  const h = Buffer.alloc(512);
  h.write(name, 0);
  h.write('0000644\0', 100);
  h.write(size.toString(8).padStart(11, '0') + '\0', 124);
  h.write('00000000000\0', 136);
  h.write(type, 156);
  h.write('ustar\0', 257);
  h.write('00', 263);
  h.fill(' ', 148, 156);
  let sum = 0;
  for (const b of h) sum += b;
  h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148);
  return h;
}
const pad = (n: number) => Buffer.alloc((512 - (n % 512)) % 512);

async function readAll(tar: Buffer) {
  const out: string[] = [];
  for await (const e of readTar(chunks(tar, 512))) {
    out.push(e.name);
    await collect(e.body);
  }
  return out;
}

function withPax(records: string, body = Buffer.from('data')) {
  const pax = Buffer.from(records);
  return Buffer.concat([rawHeader('PaxHeader', pax.length, 'x'), pax, pad(pax.length), rawHeader('file', body.length, '0'), body, pad(body.length), Buffer.alloc(1024)]);
}

test('pax headers set long names', async () => {
  assert.deepEqual(await readAll(withPax('18 path=long/name\n')), ['long/name']);
});

test('pax headers with a bad size or a broken record are refused', async () => {
  for (const records of [
    '17 size=-1000000\n',
    '14 size=1e400\n',
    '26 size=99999999999999999\n',
    '15 size=0x1234\n',
    '8 path=\n',
    '99 path=x\n',
    '0 path=x\n',
    '-5 path=x\n',
    '12 path=abc', // no newline
  ]) {
    await assert.rejects(readAll(withPax(records)), /pax header/, JSON.stringify(records));
  }
});

test('oversized pax headers are refused before they are read', async () => {
  const big = 1024 * 1024;
  const tar = Buffer.concat([rawHeader('PaxHeader', big, 'x'), Buffer.alloc(big), Buffer.alloc(1024)]);
  await assert.rejects(readAll(tar), /too large/);
});

test('the system tar program reads the stream', { skip: spawnSync('tar', ['--version']).status !== 0 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'keel-tar-'));
  const long = `storage/${'x'.repeat(120)}/file.bin`;
  const data = crypto.randomBytes(1234);
  fs.writeFileSync(path.join(dir, 'a.tar'), await collect(tarStream([file('db/keel.dump', Buffer.from('dump')), file(long, data)])));
  const r = spawnSync('tar', ['-xf', 'a.tar'], { cwd: dir, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(fs.readFileSync(path.join(dir, 'db/keel.dump'), 'utf8'), 'dump');
  assert.deepEqual(fs.readFileSync(path.join(dir, long)), data);
  fs.rmSync(dir, { recursive: true, force: true });
});
