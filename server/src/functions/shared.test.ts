import assert from 'node:assert/strict';
import test from 'node:test';
import { RESERVED_SECRET_RE, safeRelPath, validateBundle } from './shared.js';

test('safeRelPath keeps bundle paths inside the bundle', () => {
  assert.equal(safeRelPath('hello/index.ts'), 'hello/index.ts');
  assert.equal(safeRelPath('_shared/cors.ts'), '_shared/cors.ts');
  for (const bad of ['../etc/passwd', '/abs.ts', 'a/../../b', 'a//b', 'a\\b', './x.ts', 'a/./b', '', 'x\0y']) {
    assert.equal(safeRelPath(bad), null, bad);
  }
});

test('validateBundle finds the entrypoint and rejects bad input', () => {
  const b = validateBundle('hello', { files: { 'hello/index.ts': 'Deno.serve(() => new Response())' } });
  assert.equal(b.entrypoint, 'hello/index.ts');
  assert.equal(b.verifyJwt, true);
  assert.throws(() => validateBundle('hello', { files: { 'other/index.ts': '' } }), /Entrypoint/);
  assert.throws(() => validateBundle('../x', { files: { 'x/index.ts': '' } }), /Function names/);
  assert.throws(() => validateBundle('hello', { files: { '../hello/index.ts': '' } }), /Invalid file path/);
  assert.throws(() => validateBundle('hello', { files: { 'hello/index.ts': '', '.keel/import_map.json': '{}' } }), /reserved/);
});

test("secrets can't set names that change how the runtime loads code, resolves names or writes files", () => {
  // SSLKEYLOGFILE made Deno append TLS secrets to any file the worker's user
  // could write, another project's deployed code included.
  for (const name of ['SSLKEYLOGFILE', 'sslkeylogfile', 'NPM_CONFIG_REGISTRY', 'npm_config_registry', 'LD_PRELOAD', 'DENO_DIR', 'NODE_OPTIONS', 'HTTPS_PROXY', 'GLIBC_TUNABLES', 'GCONV_PATH', 'HOSTALIASES', 'RES_OPTIONS', 'LOCALDOMAIN', 'RUST_LOG', 'MALLOC_ARENA_MAX', 'PATH', 'SUPABASE_SERVICE_ROLE_KEY', 'KEEL_URL']) {
    assert.ok(RESERVED_SECRET_RE.test(name), name);
  }
  for (const name of ['STRIPE_KEY', 'OPENAI_API_KEY', 'MY_PATH', 'SSL_MODE']) assert.ok(!RESERVED_SECRET_RE.test(name), name);
});
