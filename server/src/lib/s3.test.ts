import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import http from 'node:http';
import { S3, endpointProblem, s3ConfigProblem, signV4 } from './s3.js';

test('requests are signed as in the AWS Signature Version 4 example (GET Object)', () => {
  // The "Example: GET Object" in Amazon's SigV4 header authentication docs.
  const h = signV4({
    method: 'GET',
    url: new URL('https://examplebucket.s3.amazonaws.com/test.txt'),
    headers: { Range: 'bytes=0-9' },
    payloadHash: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
    secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
    region: 'us-east-1',
    now: new Date('2013-05-24T00:00:00Z'),
  });
  assert.equal(
    h.Authorization,
    'AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41',
  );
});

test('target settings are checked before use', () => {
  const ok = { endpoint: 'https://s3.us-east-1.amazonaws.com', region: 'us-east-1', bucket: 'my-backups', accessKeyId: 'a', secretAccessKey: 'b', pathStyle: true };
  assert.equal(s3ConfigProblem(ok), null);
  assert.match(s3ConfigProblem({ ...ok, endpoint: 'ftp://x' }) ?? '', /https/);
  assert.match(s3ConfigProblem({ ...ok, endpoint: 'https://user:pw@s3.example.test' }) ?? '', /only the address/);
  assert.match(s3ConfigProblem({ ...ok, endpoint: 'https://s3.example.test/bucket' }) ?? '', /only the address/);
  assert.match(s3ConfigProblem({ ...ok, bucket: '' }) ?? '', /bucket/);
  assert.match(s3ConfigProblem({ ...ok, secretAccessKey: '' }) ?? '', /secret/);
});

// Against a real S3-compatible server, e.g. the Versity S3 gateway:
//   docker run -d --name keel-test-s3 -p 127.0.0.1:19000:7070 -e ROOT_ACCESS_KEY=testaccess \
//     -e ROOT_SECRET_KEY=testsecret123 versity/versitygw:v1.8.0 posix /tmp
//   KEEL_TEST_S3=http://testaccess:testsecret123@127.0.0.1:19000/keel-test npm test
const target = process.env.KEEL_TEST_S3;
test('uploads, lists, downloads and deletes objects on an S3-compatible server', { skip: !target && 'set KEEL_TEST_S3 to run' }, async () => {
  const u = new URL(target!);
  const s3 = new S3({
    endpoint: u.origin,
    region: 'us-east-1',
    bucket: u.pathname.slice(1),
    accessKeyId: decodeURIComponent(u.username),
    secretAccessKey: decodeURIComponent(u.password),
    pathStyle: true,
  }, 4, async () => null); // a test server on this machine is allowed here
  // The bucket may not exist yet.
  await (s3 as any).send('PUT', '').catch(() => {});
  const prefix = `test-${crypto.randomUUID()}/`;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'keel-s3-'));
  const big = path.join(dir, 'big.bin');
  const data = crypto.randomBytes(16 * 1024 * 1024 + 4321);
  fs.writeFileSync(big, data);
  try {
    await s3.uploadFile(`${prefix}keel 20261003 (big).bin`, big);
    await s3.put(`${prefix}small.txt`, Buffer.from('hello'));
    const list = await s3.list(prefix);
    assert.deepEqual(list.map((o) => o.key).sort(), [`${prefix}keel 20261003 (big).bin`, `${prefix}small.txt`]);
    assert.equal(list.find((o) => o.key.endsWith('.bin'))!.size, data.length);
    const parts: Buffer[] = [];
    for await (const c of await s3.get(`${prefix}keel 20261003 (big).bin`)) parts.push(c as Buffer);
    assert.ok(Buffer.concat(parts).equals(data));
    await s3.delete(`${prefix}keel 20261003 (big).bin`);
    await s3.delete(`${prefix}small.txt`);
    assert.deepEqual(await s3.list(prefix), []);
    const wrong = new S3({ ...(s3 as any).c, secretAccessKey: 'wrong-secret' }, 4, async () => null);
    await assert.rejects(wrong.list(prefix), /SignatureDoesNotMatch|InvalidAccessKeyId|AccessDenied/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('backups are never sent to loopback, link-local or Keel\'s own services', async () => {
  const lookup = async (name: string) => {
    const table: Record<string, string[]> = {
      'minio.lan': ['192.168.1.20'],
      's3.example.test': ['203.0.113.7'],
      'metadata.example.test': ['169.254.169.254'],
      'sneaky.example.test': ['203.0.113.7', '127.0.0.1'],
      'keel-docker.': ['172.20.0.5'],
      'docker-alias.example.test': ['172.20.0.5'],
    };
    if (!table[name]) throw new Error('ENOTFOUND');
    return table[name];
  };
  // A NAS or MinIO on the home network is fine, and so is the internet.
  assert.equal(await endpointProblem('minio.lan', lookup), null);
  assert.equal(await endpointProblem('s3.example.test', lookup), null);
  assert.equal(await endpointProblem('10.0.0.8', lookup), null);
  for (const bad of ['127.0.0.1', 'localhost', 'LOCALHOST.', 'x.localhost', '[::1]', '::ffff:127.0.0.1', '0.0.0.0', '169.254.169.254', '[fe80::1]', 'metadata.example.test', 'sneaky.example.test', 'docker-alias.example.test', '172.20.0.5']) {
    assert.match((await endpointProblem(bad, lookup)) ?? '', /never sent/, bad);
  }
  // A name that doesn't resolve is left to the request to report.
  assert.equal(await endpointProblem('nowhere.example.test', lookup), null);

  // The client checks before every request, without retrying.
  const s3 = new S3({ endpoint: 'http://127.0.0.1:9', region: 'us-east-1', bucket: 'b', accessKeyId: 'a', secretAccessKey: 's', pathStyle: true });
  await assert.rejects(s3.list('keel-'), /never sent/);
});

test('redirects from the storage are refused, not followed', async () => {
  let followed = false;
  const server = http.createServer((req, res) => {
    if (req.url?.startsWith('/elsewhere')) {
      followed = true;
      res.end('<ListBucketResult></ListBucketResult>');
      return;
    }
    res.writeHead(307, { Location: '/elsewhere' }).end();
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  try {
    const port = (server.address() as { port: number }).port;
    const s3 = new S3({ endpoint: `http://127.0.0.1:${port}`, region: 'us-east-1', bucket: 'b', accessKeyId: 'a', secretAccessKey: 's', pathStyle: true }, 1, async () => null);
    await assert.rejects(s3.list('keel-'), /redirect/);
    assert.equal(followed, false);
  } finally {
    server.close();
  }
});
