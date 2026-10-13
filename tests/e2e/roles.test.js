import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import pg from 'pg';
import { createClient } from '@supabase/supabase-js';
import { GATEWAY, PROJECT, env, keys, sql, studio, uniq } from './helpers.js';

// Database roles: each Keel service role has its own password and sees only
// the columns of keel.projects it uses; each project has an owner role
// (<database>_owner) that Studio's Connect panel hands out instead of the
// superuser. The owner tests run in a project of their own.

const SERVICE_ROLES = ['authenticator', 'keel_auth_admin', 'keel_storage_admin', 'keel_realtime_admin', 'keel_functions_admin', 'keel_egress_admin'];
const base = env.KEEL_SERVICE_PASSWORD || env.POSTGRES_PASSWORD;
/** The password keel-migrate sets on a service role (deriveSecret in server/src/lib/config.ts). */
const rolePassword = (role) => Buffer.from(crypto.hkdfSync('sha256', base, 'keel', `keel/db-role/${role}/v1`, 32)).toString('hex');

function connect(user, password, database) {
  return new pg.Client({ host: env.KEEL_E2E_DB_HOST || 'localhost', port: Number(env.KEEL_DB_PORT || 5432), user, password, database });
}

async function as(user, password, database, fn) {
  const c = connect(user, password, database);
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end().catch(() => {});
  }
}

const name = `roles-${Date.now().toString(36)}`;
const db = name.replace(/-/g, '_');
const owner = `${db}_owner`;
let ownerPassword;

before(async () => {
  const r = await studio('POST', '/api/projects', { name });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  ownerPassword = (await sql('keel', 'select password from keel.project_owners where project = $1', [name])).rows[0]?.password;
  assert.ok(ownerPassword, 'a new project gets an owner password');
});

after(async () => {
  await studio('DELETE', `/api/projects/${name}`, { confirm: name });
});

test('each service role logs in with its own password, and the shared one no longer works', async () => {
  for (const role of SERVICE_ROLES) {
    const who = await as(role, rolePassword(role), 'keel', async (c) => (await c.query('select current_user as u')).rows[0].u);
    assert.equal(who, role);
  }
  await assert.rejects(as('authenticator', base, 'keel', (c) => c.query('select 1')), { code: '28P01' });
  await assert.rejects(as('keel_auth_admin', rolePassword('authenticator'), 'keel', (c) => c.query('select 1')), { code: '28P01' });
});

test('service roles read only the keel.projects columns they use', async () => {
  const full = (await sql('keel', 'select jwt_secret, anon_key, service_key, settings from keel.projects where name = $1', [PROJECT])).rows[0];
  const seen = {};
  for (const role of SERVICE_ROLES) {
    await as(role, rolePassword(role), 'keel', async (c) => {
      await assert.rejects(c.query('select service_key from keel.projects limit 1'), { code: '42501' }, `${role} reads keel.projects`);
      await assert.rejects(c.query('select password from keel.project_owners limit 1'), { code: '42501' });
      seen[role] = (await c.query('select jwt_secret, anon_key, service_key, settings from keel.visible_projects where name = $1', [PROJECT])).rows[0];
    });
    // keel-egress only needs the project's name and database.
    if (role === 'keel_egress_admin') assert.equal(seen[role].jwt_secret, null, 'keel-egress must not see the JWT secret');
    else assert.equal(seen[role].jwt_secret, full.jwt_secret, `${role} needs the JWT secret`);
  }
  for (const role of ['authenticator', 'keel_auth_admin', 'keel_storage_admin', 'keel_realtime_admin', 'keel_egress_admin']) {
    assert.equal(seen[role].service_key, null, `${role} must not see the service key`);
    assert.equal(seen[role].anon_key, null);
  }
  assert.equal(seen.keel_functions_admin.service_key, full.service_key, 'keel-functions hands it to function code');
  assert.equal(seen.keel_functions_admin.anon_key, full.anon_key);
  assert.deepEqual(seen.keel_auth_admin.settings, full.settings);
  assert.deepEqual(Object.keys(seen.authenticator.settings).filter((k) => k !== 'rest'), []);
  assert.deepEqual(Object.keys(seen.keel_realtime_admin.settings).filter((k) => k !== 'realtime'), []);
  assert.deepEqual(seen.keel_storage_admin.settings, {});
  assert.deepEqual(seen.keel_functions_admin.settings, {});
  assert.deepEqual(seen.keel_egress_admin.settings, {});
});

test('Studio Connect shows the project owner role, not the superuser', async () => {
  const r = await studio('GET', `/api/projects/${name}/connect`);
  assert.equal(r.status, 200);
  assert.equal(r.data.db.user, owner);
  assert.equal(r.data.db.database, db);
  assert.equal(r.data.db.password, ownerPassword);
  assert.notEqual(r.data.db.password, env.POSTGRES_PASSWORD);
  const role = (await sql('postgres', 'select rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolcanlogin from pg_roles where rolname = $1', [owner])).rows[0];
  assert.deepEqual(role, { rolsuper: false, rolcreatedb: false, rolcreaterole: false, rolreplication: false, rolcanlogin: true });
  // Projects that existed before owner roles get one too.
  const { db: mainDb } = await keys();
  assert.equal((await studio('GET', `/api/projects/${PROJECT}/connect`)).data.db.user, `${mainDb}_owner`);
});

test('the owner role runs a typical Supabase migration', async () => {
  // A table made in Studio (as the superuser) is handed to the owner role, so the migration can change it.
  await sql(db, `create table public.studio_made (id bigint generated always as identity primary key, title text)`);
  assert.equal((await sql(db, `select tableowner from pg_tables where tablename = 'studio_made'`)).rows[0].tableowner, owner);

  await as(owner, ownerPassword, db, (c) =>
    c.query(`
      create extension if not exists pgcrypto with schema extensions;
      create table public.profiles (
        id uuid primary key references auth.users (id) on delete cascade,
        username text,
        created_at timestamptz not null default now()
      );
      alter table public.profiles enable row level security;
      create policy "profiles are public" on public.profiles for select to anon, authenticated using (true);
      create policy "users update their own profile" on public.profiles for update to authenticated
        using ((select auth.uid()) = id) with check ((select auth.uid()) = id);
      grant select on public.profiles to anon, authenticated;

      create function public.handle_new_user() returns trigger
      language plpgsql security definer set search_path = '' as $$
      begin
        insert into public.profiles (id, username) values (new.id, new.raw_user_meta_data ->> 'username');
        return new;
      end
      $$;
      create trigger t_on_auth_user_created after insert on auth.users
        for each row execute function public.handle_new_user();

      alter publication supabase_realtime add table public.profiles;
      insert into storage.buckets (id, name, public) values ('avatars', 'avatars', true);

      alter table public.studio_made add column done boolean not null default false;
      create policy "studio rows are public" on public.studio_made for select to anon using (true);

      create schema private;
      create table private.secrets (id int primary key);
    `),
  );
  await new Promise((r) => setTimeout(r, 800));

  const { anon_key: anon, service_key: service } = (await sql('keel', 'select anon_key, service_key from keel.projects where name = $1', [name])).rows[0];
  const opts = { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } };
  const admin = createClient(`${GATEWAY}/${name}`, service, opts);
  const username = uniq('name');
  const made = await admin.auth.admin.createUser({ email: `${uniq('owner')}@example.com`, password: 'correct-horse-battery', email_confirm: true, user_metadata: { username } });
  assert.equal(made.error, null);

  const { data, error } = await createClient(`${GATEWAY}/${name}`, anon, opts).from('profiles').select('id, username').eq('id', made.data.user.id);
  assert.equal(error, null);
  assert.deepEqual(data, [{ id: made.data.user.id, username }], 'the security definer trigger on auth.users made the profile');

  const bucket = await admin.storage.getBucket('avatars');
  assert.equal(bucket.error, null);
  assert.equal(bucket.data.public, true);
  const pub = await sql(db, `select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'profiles'`);
  assert.equal(pub.rowCount, 1);
  const owners = (await sql(db, `select proowner::regrole::text as o from pg_proc where proname = 'handle_new_user'`)).rows[0].o;
  assert.equal(owners, owner, 'the security definer function runs as the owner role, not a superuser');
});

test('the owner role cannot leave its project or the database', async () => {
  const { db: mainDb } = await keys();
  await as(owner, ownerPassword, db, async (c) => {
    await assert.rejects(c.query(`copy (select 1) to program 'id'`), { code: '42501' });
    await assert.rejects(c.query(`create temp table t (x text); copy t from program 'id'`), { code: '42501' });
    await assert.rejects(c.query(`select pg_read_file('/etc/passwd')`), { code: '42501' });
    await assert.rejects(c.query(`create extension dblink`), (err) => ['42501', '0A000', '58P01'].includes(err.code));
    await assert.rejects(c.query(`set role postgres`), { code: '42501' });
    await assert.rejects(c.query(`alter role ${owner} superuser`), { code: '42501' });
    await assert.rejects(c.query(`select count(*) from _keel.migrations`), { code: '42501' });
  });
  await assert.rejects(as(owner, ownerPassword, mainDb, (c) => c.query('select 1')), (err) => ['42501', '28000'].includes(err.code), 'another project');

  await as(owner, ownerPassword, 'keel', async (c) => {
    await assert.rejects(c.query('select name from keel.projects'), { code: '42501' });
    await assert.rejects(c.query('select password from keel.project_owners'), { code: '42501' });
    await assert.rejects(c.query('select username from keel.studio_users'), { code: '42501' });
    const visible = (await c.query('select name, jwt_secret, service_key from keel.visible_projects')).rows;
    assert.deepEqual(visible, [{ name, jwt_secret: null, service_key: null }]);
  });
});

test('the owner role deploys functions and secrets for its own project only', async () => {
  await as(owner, ownerPassword, 'keel', async (c) => {
    await c.query(`insert into keel.functions (project, name, entrypoint, files) values ($1, 'hello', 'hello/index.ts', '{}')`, [name]);
    await c.query(`insert into keel.function_secrets (project, name, value) values ($1, 'API_KEY', 'x')`, [name]);
    await assert.rejects(
      c.query(`insert into keel.functions (project, name, entrypoint, files) values ($1, $2, 'x/index.ts', '{}')`, [PROJECT, uniq('fn')]),
      { code: '42501' },
    );
    await assert.rejects(c.query(`insert into keel.function_secrets (project, name, value) values ($1, 'STOLEN', 'x')`, [PROJECT]), { code: '42501' });
    const projects = (await c.query('select distinct project from keel.functions union select distinct project from keel.function_secrets')).rows.map((r) => r.project);
    assert.deepEqual(projects, [name]);
    assert.equal((await c.query(`delete from keel.function_secrets where project = $1`, [PROJECT])).rowCount, 0);
    await c.query(`delete from keel.functions where project = $1`, [name]);
    await c.query(`delete from keel.function_secrets where project = $1`, [name]);
  });
});

test("the owner role's look-alike functions and triggers never run as the superuser", async () => {
  // Each one makes the owner a superuser if a superuser runs it. They used to:
  // the scheduler's cleanup called make_interval(days => $1) with an untyped
  // parameter every minute, the automatic-RLS event trigger called format()
  // when Studio created a table, and the table editor wrote as the superuser.
  const escalate = `begin
      if (select rolsuper from pg_catalog.pg_roles where rolname = current_user) then
        execute pg_catalog.format('alter role %I superuser', '${owner}');
      end if;`;
  await as(owner, ownerPassword, db, async (c) => {
    await c.query(`create function public.make_interval(days text) returns interval language plpgsql as $$ ${escalate} return interval '1 day'; end $$`);
    await c.query(`create function public.format(text, text) returns text language plpgsql as $$ ${escalate} return pg_catalog.format($1, $2); end $$`);
    await c.query(`create table public.planted (id int primary key, note text)`);
    await c.query(`create function public.planted_trigger() returns trigger language plpgsql as $$ ${escalate} return new; end $$`);
    await c.query(`create trigger planted before insert or update on public.planted for each row execute function public.planted_trigger()`);
  });
  const isSuper = async () => (await sql('postgres', 'select rolsuper from pg_roles where rolname = $1', [owner])).rows[0].rolsuper;

  // Studio creates a table and a policy (event triggers fire as the superuser).
  const table = uniq('t');
  const made = await studio('POST', `/api/projects/${name}/tables`, { name: table, columns: [{ name: 'id', type: 'bigint', pk: true, default: 'identity' }] });
  assert.equal(made.status, 201, JSON.stringify(made.data));
  assert.equal(await isSuper(), false, 'creating a table in Studio');

  // The table editor writes a row (the owner's trigger fires).
  const row = await studio('POST', `/api/projects/${name}/tables/public/planted/rows`, { values: { id: 1, note: 'x' } });
  assert.equal(row.status, 201, JSON.stringify(row.data));
  const edit = await studio('PATCH', `/api/projects/${name}/tables/public/planted/rows`, { key: { id: 1 }, values: { note: 'y' } });
  assert.equal(edit.status, 200, JSON.stringify(edit.data));
  assert.equal(await isSuper(), false, 'editing rows in Studio');

  // The scheduler cleans up every minute.
  await new Promise((r) => setTimeout(r, 65_000));
  assert.equal(await isSuper(), false, "the scheduler's cleanup");
});
