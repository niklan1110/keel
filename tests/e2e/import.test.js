import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createClient } from '@supabase/supabase-js';
import { GATEWAY, PROJECT, deployFunction, env, sql, studio, uniq, waitFor } from './helpers.js';

// A Keel project has the same auth/storage layout and APIs as Supabase, so it
// stands in for the Supabase project being imported.
const src = `src-${Date.now().toString(36)}`;
const dst = `dst-${Date.now().toString(36)}`;
// A source that misbehaves on purpose, and the project it's imported into.
const hsrc = `hsrc-${Date.now().toString(36)}`;
const hdst = `hdst-${Date.now().toString(36)}`;
const redirectFn = uniq('redir');
const keysOf = async (name) => (await sql('keel', 'select anon_key, service_key, db_name from keel.projects where name = $1', [name])).rows[0];
const sb = (name, key) => createClient(`${GATEWAY}/${name}`, key, { auth: { persistSession: false, autoRefreshToken: false } });

before(async () => {
  for (const name of [src, dst, hsrc, hdst]) {
    const r = await studio('POST', '/api/projects', { name });
    assert.equal(r.status, 201, JSON.stringify(r.data));
  }
  // The tests sign users up. On a stack whose public URL is on the internet, new projects start with sign-ups off.
  await sql('keel', `update keel.projects set settings = settings - 'disable_signup' - 'mailer_autoconfirm' where name = any($1)`, [[src, dst, hsrc, hdst]]);
  await new Promise((r) => setTimeout(r, 400));
});

after(async () => {
  await studio('DELETE', `/api/projects/${src}`, { confirm: src });
  await studio('DELETE', `/api/projects/${dst}`, { confirm: dst });
  await studio('DELETE', `/api/projects/${hsrc}`, { confirm: hsrc });
  await studio('DELETE', `/api/projects/${hdst}`, { confirm: hdst });
  await studio('DELETE', `/api/projects/${PROJECT}/functions/${redirectFn}`);
});

/** Starts an import into `into` through Studio's API and waits for it to end. */
async function runImport(into, body) {
  const start = await studio('POST', `/api/projects/${into}/import`, body);
  assert.equal(start.status, 202, JSON.stringify(start.data));
  return waitFor(async () => {
    const r = await studio('GET', `/api/projects/${into}/import`);
    return r.data?.status !== 'running' && r.data;
  }, { timeout: 120_000, interval: 500, label: 'import to finish' });
}

test('import a project: tables, users, triggers, policies, realtime and files', async () => {
  const s = await keysOf(src);
  await sql(
    s.db_name,
    `create table public.profiles (id uuid primary key references auth.users (id) on delete cascade, display_name text);
     create table public.posts (id bigint generated always as identity primary key, author uuid not null default auth.uid() references auth.users (id), body text not null);
     create policy "own posts" on public.posts for all to authenticated using (author = auth.uid()) with check (author = auth.uid());
     create policy "own profile" on public.profiles for select to authenticated using (id = auth.uid());
     create function public.handle_new_user() returns trigger language plpgsql security definer set search_path = '' as $$
     begin insert into public.profiles (id, display_name) values (new.id, new.raw_user_meta_data ->> 'name'); return new; end $$;
     create trigger on_auth_user_created after insert on auth.users for each row execute function public.handle_new_user();
     alter publication supabase_realtime add table public.posts;
     insert into storage.buckets (id, name, public) values ('avatars', 'avatars', false);
     create policy "own avatar" on storage.objects for all to authenticated
       using (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text)
       with check (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text);`,
  );
  await new Promise((r) => setTimeout(r, 800));

  const email = `${uniq('mover')}@example.com`;
  const c = sb(src, s.anon_key);
  const up = await c.auth.signUp({ email, password: 'moving-day-2026', options: { data: { name: 'Mover' } } });
  assert.equal(up.error, null);
  const userId = up.data.user.id;
  assert.equal((await c.from('posts').insert([{ body: 'first' }, { body: 'second' }])).error, null);
  const file = Buffer.from('avatar bytes ' + 'x'.repeat(5000));
  assert.equal((await c.storage.from('avatars').upload(`${userId}/me.png`, file, { contentType: 'image/png' })).error, null);

  const start = await studio('POST', `/api/projects/${dst}/import`, {
    dbUrl: `postgresql://postgres:${env.POSTGRES_PASSWORD}@keel-db:5432/${s.db_name}`,
    apiUrl: `http://keel-gateway:8000/${src}`,
    serviceKey: s.service_key,
  });
  assert.equal(start.status, 202, JSON.stringify(start.data));
  const job = await waitFor(async () => {
    const r = await studio('GET', `/api/projects/${dst}/import`);
    return r.data?.status !== 'running' && r.data;
  }, { timeout: 120_000, interval: 500, label: 'import to finish' });
  assert.equal(job.status, 'done', JSON.stringify(job.lines.slice(-10)));
  assert.ok(!job.lines.some((l) => l.msg.includes(env.POSTGRES_PASSWORD)), 'the password is never logged');
  assert.deepEqual({ users: job.result.users, files: job.result.files }, { users: 1, files: 1 });
  assert.equal(job.result.warnings, 0, JSON.stringify(job.lines.filter((l) => l.level !== 'info')));

  const d = await keysOf(dst);
  await new Promise((r) => setTimeout(r, 800));
  const dc = sb(dst, d.anon_key);
  const signIn = await dc.auth.signInWithPassword({ email, password: 'moving-day-2026' });
  assert.equal(signIn.error, null, 'same password works after the move');
  assert.equal(signIn.data.user.id, userId);
  const posts = await dc.from('posts').select('body').order('id');
  assert.deepEqual(posts.data, [{ body: 'first' }, { body: 'second' }]);
  assert.deepEqual((await dc.from('profiles').select('display_name')).data, [{ display_name: 'Mover' }]);
  const dl = await dc.storage.from('avatars').download(`${userId}/me.png`);
  assert.equal(dl.error, null);
  assert.ok(Buffer.from(await dl.data.arrayBuffer()).equals(file));

  // The sign-up trigger came along, and so did realtime and storage policies.
  const other = await sb(dst, d.anon_key).auth.signUp({ email: `${uniq('new')}@example.com`, password: 'new-user-pass', options: { data: { name: 'Newbie' } } });
  assert.equal(other.error, null);
  const prof = await sql(d.db_name, 'select display_name from public.profiles where id = $1', [other.data.user.id]);
  assert.equal(prof.rows[0]?.display_name, 'Newbie');
  const pub = await sql(d.db_name, `select tablename from pg_publication_tables where pubname = 'supabase_realtime'`);
  assert.ok(pub.rows.some((r) => r.tablename === 'posts'));
  const pol = await sql(d.db_name, `select policyname from pg_policies where schemaname = 'storage' and tablename = 'objects'`);
  assert.ok(pol.rows.some((r) => r.policyname === 'own avatar'));

  // Imported code is owned by a non-superuser role that can't log in, so a
  // SECURITY DEFINER function from the source never runs as the superuser.
  const owner = await sql(
    d.db_name,
    `select r.rolname, r.rolsuper, r.rolcanlogin from pg_proc p join pg_roles r on r.oid = p.proowner where p.proname = 'handle_new_user'`,
  );
  assert.equal(owner.rows[0].rolname, `keel_import_${d.db_name}`);
  assert.equal(owner.rows[0].rolsuper, false);
  assert.equal(owner.rows[0].rolcanlogin, false);
});

test('a hostile source: definitions with extra statements, path-like file names and malformed types', async () => {
  const s = await keysOf(hsrc);
  // Pretend to be a hostile server: the catalog hands the importer three statements as the
  // definition of a trigger on auth.users, the last two meant to run as the superuser.
  await sql(
    s.db_name,
    `create function public.noop() returns trigger language plpgsql as $$ begin return new; end $$;
     create trigger hostile after insert on auth.users for each row execute function public.noop();
     do $d$ begin
       execute format($f$create or replace function pg_catalog.pg_get_triggerdef(oid) returns text language sql stable as $b$
         select case when $1 = %s
           then 'CREATE TRIGGER hostile AFTER INSERT ON auth.users FOR EACH ROW EXECUTE FUNCTION public.noop(); RESET ROLE; CREATE TABLE public.pwned (who text default current_user)'
           else pg_catalog.pg_get_triggerdef($1, false) end $b$$f$,
         (select oid from pg_catalog.pg_trigger where tgname = 'hostile'));
     end $d$;
     insert into storage.buckets (id, name, public) values ('docs', 'docs', false);`,
  );
  const sc = sb(hsrc, s.service_key);
  assert.equal((await sc.storage.from('docs').upload('ok/readme.txt', 'hello', { contentType: 'text/plain' })).error, null);
  assert.equal((await sc.storage.from('docs').upload('ok/legacy.png', '<script>alert(1)</script>', { contentType: 'image/png' })).error, null);
  // Rows a hostile source could have: a type that is a list, and names that walk out of their URL.
  await sql(
    s.db_name,
    `update storage.objects set metadata = metadata || '{"mimetype": "image/png, text/html"}' where bucket_id = 'docs' and name = 'ok/legacy.png';
     insert into storage.objects (bucket_id, name, metadata) values
       ('docs', 'x/../../../bucket/docs/empty', '{}'), ('docs', 'x\\..\\y', '{}'), ('docs', 'x/./y', '{}'), ('docs', E'x\\ny', '{}');`,
  );

  const job = await runImport(hdst, {
    dbUrl: `postgresql://postgres:${env.POSTGRES_PASSWORD}@keel-db:5432/${s.db_name}`,
    apiUrl: `http://keel-gateway:8000/${hsrc}`,
    serviceKey: s.service_key,
  });
  assert.equal(job.status, 'done', JSON.stringify(job.lines.slice(-10)));
  const warnings = job.lines.filter((l) => l.level === 'warn').map((l) => l.msg);
  assert.ok(warnings.some((w) => /^Trigger hostile on auth\.users: cannot insert multiple commands/.test(w)), JSON.stringify(warnings));
  assert.equal(warnings.filter((w) => /bucket or file name is not allowed/.test(w)).length, 4, JSON.stringify(warnings));
  assert.equal(job.result.files, 2);

  const d = await keysOf(hdst);
  assert.equal((await sql(d.db_name, `select to_regclass('public.pwned') as t`)).rows[0].t, null, 'the extra statements never ran');
  const trg = await sql(d.db_name, `select 1 from pg_trigger where tgrelid = 'auth.users'::regclass and tgname = 'hostile'`);
  assert.equal(trg.rowCount, 0);
  const files = await sql(d.db_name, `select name, metadata->>'mimetype' as type from storage.objects where bucket_id = 'docs' order by name`);
  assert.deepEqual(files.rows, [
    // The source serves its malformed type as application/octet-stream, and that's what is kept.
    { name: 'ok/legacy.png', type: 'application/octet-stream' },
    { name: 'ok/readme.txt', type: 'text/plain' },
  ]);
});

test('the importer does not follow redirects from the source API', async () => {
  const s = await keysOf(hsrc);
  assert.equal((await sb(hsrc, s.service_key).storage.from('docs').upload('ok/readme.txt', 'hello', { contentType: 'text/plain', upsert: true })).error, null);
  // An "API" that answers every file request with a redirect to the real one. A client that
  // followed it would also send the service_role key wherever the redirect pointed.
  await deployFunction(
    redirectFn,
    {
      [`${redirectFn}/index.ts`]: `Deno.serve((req) => {
        const path = new URL(req.url).pathname;
        const i = path.indexOf('/storage/v1/');
        if (i < 0) return new Response('not found', { status: 404 });
        return Response.redirect('http://keel-gateway:8000/${hsrc}' + path.slice(i), 302);
      });`,
    },
    { verifyJwt: false },
  );
  const job = await runImport(hdst, {
    dbUrl: `postgresql://postgres:${env.POSTGRES_PASSWORD}@keel-db:5432/${s.db_name}`,
    apiUrl: `http://keel-gateway:8000/${PROJECT}/functions/v1/${redirectFn}`,
    serviceKey: s.service_key,
    schema: false,
    auth: false,
  });
  assert.equal(job.status, 'failed', JSON.stringify(job.lines.slice(-10)));
  assert.match(job.error, /redirect/);
});
