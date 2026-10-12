import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SERVICE_ROLES, deriveSecret, requireSecret, sslFromDbUrl } from './config.js';

test('requireSecret refuses empty, example and short values', () => {
  assert.throws(() => requireSecret('KEEL_SECRET', ''), /not set/);
  assert.throws(() => requireSecret('POSTGRES_PASSWORD', 'CHANGE_ME_POSTGRES_PASSWORD'), /example value/);
  assert.throws(() => requireSecret('KEEL_DASHBOARD_PASSWORD', 'change-me'), /example value/);
  assert.throws(() => requireSecret('KEEL_SECRET', 'abc123'), /at least 32/);
  assert.equal(requireSecret('KEEL_SECRET', 'a'.repeat(64)), 'a'.repeat(64));
  assert.equal(requireSecret('KEEL_DASHBOARD_PASSWORD', 'Zr7xK2pqLm'), 'Zr7xK2pqLm');
});

test('requireSecret refuses passwords shown as examples in the documentation', () => {
  assert.throws(() => requireSecret('KEEL_DASHBOARD_PASSWORD', 'q4XbV2mN8rTz1kLw9sPd'), /example value/);
  assert.throws(() => requireSecret('KEEL_DASHBOARD_PASSWORD', 'MyNewPassword2026'), /example value/);
  assert.throws(() => requireSecret('KEEL_DASHBOARD_PASSWORD', '<generated>'), /example value/);
});

test('KEEL_DB_URL replaces the separate database settings', () => {
  // config is read once at import, so load it in a child process with the URL set.
  const load = (env: Record<string, string>) => {
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', `import { config } from ${JSON.stringify(new URL('./config.js', import.meta.url).href)}; console.log(JSON.stringify(config.db))`], {
      env: { PATH: process.env.PATH ?? '', ...env },
      encoding: 'utf8',
    });
    if (r.status !== 0) throw new Error(r.stderr);
    return JSON.parse(r.stdout);
  };
  assert.deepEqual(load({ KEEL_DB_URL: 'postgresql://postgres:p%40ss%2Fw@192.168.1.20:15432/my_app' }), {
    host: '192.168.1.20',
    port: 15432,
    superuser: 'postgres',
    password: 'p@ss/w',
    servicePassword: 'p@ss/w',
    controlDb: 'keel',
    credentialsDir: '/var/lib/keel/credentials',
  });
  assert.equal(load({ KEEL_DB_URL: 'postgres://postgres:x@nas.local/my_app' }).port, 5432);
  assert.deepEqual(load({ KEEL_DB_URL: 'postgresql://my_app_owner:x@192.168.1.20:5432/my_app?sslmode=require' }).ssl, { rejectUnauthorized: false });
  assert.deepEqual(load({ POSTGRES_PASSWORD: 'secret' }), { host: 'keel-db', port: 5432, superuser: 'postgres', password: 'secret', servicePassword: 'secret', controlDb: 'keel', credentialsDir: '/var/lib/keel/credentials' });
  assert.equal(load({ POSTGRES_PASSWORD: 'secret', KEEL_SERVICE_PASSWORD: 'other' }).servicePassword, 'other');
  assert.throws(() => load({ KEEL_DB_URL: 'http://example.com' }), /KEEL_DB_URL must be/);
});

test('sslmode in KEEL_DB_URL works as in libpq', () => {
  const ssl = (q: string) => sslFromDbUrl(new URL(`postgresql://u:p@192.168.1.20:5432/my_app${q}`));
  // No sslmode (and allow/prefer, which node-postgres can't fall back from): the driver's default, no TLS.
  assert.equal(ssl(''), undefined);
  assert.equal(ssl('?sslmode=prefer'), undefined);
  assert.equal(ssl('?sslmode=disable'), false);
  // keel-db's certificate is self-signed: require encrypts without checking it, as psql does.
  assert.deepEqual(ssl('?sslmode=require'), { rejectUnauthorized: false });
  assert.deepEqual(ssl('?sslmode=verify-full'), {});
  assert.throws(() => ssl('?sslmode=verify-ca'), /sslrootcert/);
  assert.throws(() => ssl('?sslmode=no-verify'), /sslmode/);
  // A repeated setting is refused: libpq would take the last one, URLSearchParams the first.
  assert.throws(() => ssl('?sslmode=disable&sslmode=require'), /more than once/);
  assert.throws(() => ssl('?sslmode=verify-ca&sslrootcert=a&sslrootcert=b'), /more than once/);
  // sslrootcert=system: the system's CAs, and (as in libpq) only with verify-full.
  assert.deepEqual(ssl('?sslmode=verify-full&sslrootcert=system'), {});
  assert.throws(() => ssl('?sslmode=require&sslrootcert=system'), /verify-full/);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'keel-ca-'));
  try {
    const ca = path.join(dir, 'server.crt');
    fs.writeFileSync(ca, 'CERT');
    const root = `&sslrootcert=${encodeURIComponent(ca)}`;
    const verifyCa = ssl(`?sslmode=verify-ca${root}`);
    assert.ok(verifyCa && verifyCa.ca === 'CERT' && typeof verifyCa.checkServerIdentity === 'function' && verifyCa.checkServerIdentity() === undefined);
    // require with a root certificate checks the certificate but not the host name, like verify-ca.
    assert.equal((ssl(`?sslmode=require${root}`) as { ca?: string }).ca, 'CERT');
    assert.deepEqual(ssl(`?sslmode=verify-full${root}`), { ca: 'CERT' });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('deriveSecret gives each purpose its own key', () => {
  const secret = 'k'.repeat(64);
  const session = deriveSecret(secret, 'studio-session');
  assert.match(session, /^[0-9a-f]{64}$/);
  assert.equal(deriveSecret(secret, 'studio-session'), session);
  assert.notEqual(deriveSecret(secret, 'studio-totp'), session);
  assert.notEqual(deriveSecret(secret, 'backup-download'), session);
  assert.notEqual(deriveSecret('j'.repeat(64), 'studio-session'), session);
  assert.ok(!session.includes(secret.slice(0, 8)));
});

test('the functions token is KEEL_FUNCTIONS_TOKEN, else derived from the service password, never from KEEL_SECRET', () => {
  const load = (env: Record<string, string>) => {
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', `import { config } from ${JSON.stringify(new URL('./config.js', import.meta.url).href)}; console.log(JSON.stringify(config.functionsToken))`], {
      env: { PATH: process.env.PATH ?? '', ...env },
      encoding: 'utf8',
    });
    if (r.status !== 0) throw new Error(r.stderr);
    return JSON.parse(r.stdout);
  };
  const secret = 's'.repeat(64);
  assert.equal(load({ KEEL_SECRET: secret, KEEL_FUNCTIONS_TOKEN: 't'.repeat(48) }), 't'.repeat(48));
  const derived = load({ KEEL_SECRET: secret, KEEL_SERVICE_PASSWORD: 'service-password-1' });
  assert.match(derived, /^[0-9a-f]{64}$/);
  assert.equal(load({ KEEL_SERVICE_PASSWORD: 'service-password-1' }), derived);
  assert.notEqual(load({ KEEL_SERVICE_PASSWORD: 'service-password-2' }), derived);
  assert.equal(load({ KEEL_CREDENTIALS_DIR: path.join(os.tmpdir(), 'keel-no-such-dir') }), '');

  // keel-functions only has its own role's password file; Studio has the service password. Both get the same token.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'keel-cred-'));
  try {
    fs.mkdirSync(path.join(dir, 'keel_functions_admin'));
    fs.writeFileSync(path.join(dir, 'keel_functions_admin', 'password'), deriveSecret('service-password-1', 'db-role/keel_functions_admin') + '\n');
    assert.equal(load({ KEEL_CREDENTIALS_DIR: dir }), derived);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/** Runs code against a fresh copy of config.js with only the given environment. */
function inChild(env: Record<string, string>, expr: string): unknown {
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', `import * as m from ${JSON.stringify(new URL('./config.js', import.meta.url).href)}; console.log(JSON.stringify(${expr}))`], {
    env: { PATH: process.env.PATH ?? '', ...env },
    encoding: 'utf8',
  });
  if (r.status !== 0) throw new Error(r.stderr);
  return JSON.parse(r.stdout);
}

test('each service role gets its own password, derived from the service password', () => {
  const passwords = inChild({ KEEL_SERVICE_PASSWORD: 'service-password-1' }, 'm.SERVICE_ROLES.map((r) => m.rolePassword(r))') as string[];
  assert.equal(new Set(passwords).size, SERVICE_ROLES.length);
  for (const [i, role] of SERVICE_ROLES.entries()) {
    assert.match(passwords[i], /^[0-9a-f]{64}$/);
    assert.equal(passwords[i], deriveSecret('service-password-1', `db-role/${role}`));
    assert.notEqual(passwords[i], 'service-password-1');
  }
  // Installs without KEEL_SERVICE_PASSWORD derive from POSTGRES_PASSWORD, as before.
  assert.equal(inChild({ POSTGRES_PASSWORD: 'pg-password-123' }, `m.rolePassword('authenticator')`), deriveSecret('pg-password-123', 'db-role/authenticator'));
});

test('a service without the service password reads only its own role password file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'keel-cred-'));
  try {
    fs.mkdirSync(path.join(dir, 'authenticator'));
    fs.writeFileSync(path.join(dir, 'authenticator', 'password'), 'a'.repeat(64) + '\n');
    const env = { KEEL_CREDENTIALS_DIR: dir };
    assert.equal(inChild(env, `m.rolePassword('authenticator')`), 'a'.repeat(64));
    assert.equal(inChild(env, `m.requireRolePassword('authenticator')`), 'a'.repeat(64));
    assert.equal(inChild(env, `m.rolePassword('keel_auth_admin')`), '');
    assert.throws(() => inChild(env, `m.requireRolePassword('keel_auth_admin')`), /No database password for keel_auth_admin/);
    // With the service password set (keel-migrate, Studio, older compose files), a stale file is ignored.
    assert.equal(inChild({ ...env, KEEL_SERVICE_PASSWORD: 'service-password-1' }, `m.rolePassword('authenticator')`), deriveSecret('service-password-1', 'db-role/authenticator'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
