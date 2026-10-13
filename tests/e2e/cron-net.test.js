import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import pg from 'pg';
import { PROJECT, deployFunction, env, keys, sql, studio, superuser, uniq, waitFor } from './helpers.js';

// Scheduled jobs (pg_cron's API) and outgoing requests (pg_net's API and
// Supabase's Database Webhooks), run by keel-studio for every project.

const fn = uniq('hook');
const table = uniq('cron_ticks');
const hooked = uniq('hooked');
const job = uniq('job');
// The gateway's address inside Keel: calls to the project's own functions are routed there.
const FUNCTION_URL = `http://keel-gateway:8000/${PROJECT}/functions/v1/${fn}`;

after(async () => {
  const { db } = await keys();
  await sql(db, `select cron.unschedule(jobid) from cron.job where jobname = $1`, [job]).catch(() => {});
  await sql(db, `drop table if exists public.${table}; drop table if exists public.${hooked}`);
  await studio('DELETE', `/api/projects/${PROJECT}/functions/${fn}`);
});

/** Waits for pg_net's response to a request and returns it. */
async function response(db, id) {
  return waitFor(async () => (await sql(db, 'select * from net._http_response where id = $1', [id])).rows[0], { timeout: 20_000, interval: 300, label: `response ${id}` });
}

test('a cron job runs as the project owner role and records its runs', async () => {
  const { db } = await keys();
  await sql(db, `create table public.${table} (who text not null, at timestamptz not null default now())`);
  const { rows } = await sql(db, `select cron.schedule($1, '1 seconds', $2) as id`, [job, `insert into public.${table} (who) select current_user`]);
  const id = rows[0].id;
  assert.ok(id);
  const tick = await waitFor(async () => (await sql(db, `select who from public.${table} limit 1`)).rows[0], { timeout: 20_000, interval: 300, label: 'a cron run' });
  assert.equal(tick.who, `${db}_owner`);
  const run = await waitFor(
    async () => (await sql(db, `select * from cron.job_run_details where jobid = $1 and status = 'succeeded' limit 1`, [id])).rows[0],
    { timeout: 10_000, label: 'a recorded run' },
  );
  assert.equal(run.return_message, 'INSERT 0 1');
  assert.equal(run.username, `${db}_owner`);

  // Studio lists it.
  const r = await studio('GET', `/api/projects/${PROJECT}/cron`);
  assert.equal(r.status, 200);
  assert.ok(r.data.jobs.some((j) => j.jobname === job && j.schedule === '1 seconds'));

  assert.equal((await sql(db, 'select cron.unschedule($1) as ok', [job])).rows[0].ok, true);
});

test('bad schedules are refused, and the API roles cannot use cron or net', async () => {
  const { db } = await keys();
  await assert.rejects(sql(db, `select cron.schedule('x', '61 * * * *', 'select 1')`), /invalid schedule/);
  for (const role of ['anon', 'authenticated', 'service_role']) {
    await assert.rejects(sql(db, `set role ${role}; select cron.schedule('x', '* * * * *', 'select 1')`), /permission denied for schema cron/, role);
    await assert.rejects(sql(db, `set role ${role}; select net.http_get('https://example.com')`), /permission denied for schema net/, role);
  }
});

test("net.http_post reaches the project's own edge function, and database webhooks work", async () => {
  const { db, service } = await keys();
  await deployFunction(fn, {
    [`${fn}/index.ts`]: `Deno.serve(async (req) => Response.json({ method: req.method, body: await req.json().catch(() => null) }));\n`,
  });
  const headers = JSON.stringify({ 'Content-Type': 'application/json', Authorization: `Bearer ${service}` });
  const { rows } = await sql(db, `select net.http_post($1, '{"hello":"keel"}'::jsonb, '{}'::jsonb, $2::jsonb) as id`, [FUNCTION_URL, headers]);
  const res = await response(db, rows[0].id);
  assert.equal(res.status_code, 200, res.error_msg || res.content);
  assert.deepEqual(JSON.parse(res.content), { method: 'POST', body: { hello: 'keel' } });

  // A Database Webhook, as Supabase's dashboard creates it, fired by an insert through the API.
  await sql(
    db,
    `create table public.${hooked} (id int primary key, note text);
     create trigger ${hooked}_hook after insert on public.${hooked} for each row
       execute function supabase_functions.http_request('${FUNCTION_URL}', 'POST', '${headers.replace(/'/g, "''")}', '{}', '5000')`,
  );
  await sql(db, `set role service_role; insert into public.${hooked} values (1, 'hi')`);
  const hook = await waitFor(async () => (await sql(db, `select request_id from supabase_functions.hooks where hook_name = $1`, [`${hooked}_hook`])).rows[0], { label: 'a hook row' });
  const sent = await response(db, hook.request_id);
  assert.equal(sent.status_code, 200, sent.error_msg || sent.content);
  const body = JSON.parse(sent.content).body;
  assert.equal(body.type, 'INSERT');
  assert.equal(body.table, hooked);
  assert.deepEqual(body.record, { id: 1, note: 'hi' });
});

test('requests to this server, Keel, the LAN and cloud metadata are refused', async () => {
  const { db } = await keys();
  const urls = [
    'http://127.0.0.1:3000/api/projects',
    'http://localhost:5432/',
    'http://169.254.169.254/latest/meta-data/',
    'http://192.168.1.1/',
    'http://10.0.0.1/',
    'http://[::1]:8000/',
    'http://keel-db:5432/',
    // Not on keel-egress's network at all: the name doesn't even resolve there.
    'http://keel-studio:3000/api/projects',
    'http://keel-docker:2375/containers/json',
    // The gateway, but for another project's functions or another API.
    `http://keel-gateway:8000/other-project/functions/v1/${fn}`,
    `http://keel-gateway:8000/${PROJECT}/rest/v1/`,
  ];
  for (const url of urls) {
    const { rows } = await sql(db, `select net.http_get($1) as id`, [url]);
    const res = await response(db, rows[0].id);
    assert.equal(res.status_code, null, url);
    assert.match(res.error_msg, /^(refused|could not resolve)/, url);
  }
  await assert.rejects(sql(db, `select net.http_get('file:///etc/passwd')`), /only http and https/);
});

test('a full request queue skips the webhook instead of failing the write', async () => {
  const { db } = await keys();
  const t = uniq('fullq');
  await sql(db, `create table public.${t} (id int primary key);
    create trigger ${t}_hook after insert on public.${t} for each row
      execute function supabase_functions.http_request('https://example.com/hook', 'POST', '{}', '{}', '1000')`);
  const c = superuser(db);
  await c.connect();
  try {
    // Filled and rolled back in one transaction, so keel-egress never sees these requests.
    await c.query('begin');
    await c.query(`insert into net.http_request_queue (method, url, headers, timeout_milliseconds)
                   select 'GET', 'https://example.com/', '{}', 1000 from generate_series(1, 10000)`);
    await c.query(`set local role service_role; insert into public.${t} values (1); reset role`);
    const hook = (await c.query(`select request_id from supabase_functions.hooks where hook_name = $1`, [`${t}_hook`])).rows[0];
    assert.ok(hook, 'the hook is recorded');
    assert.equal(hook.request_id, null, 'without a request');
    await assert.rejects(c.query(`select net.http_get('https://example.com/')`), /already waiting/);
  } finally {
    await c.query('rollback').catch(() => {});
    await c.end();
    await sql(db, `drop table if exists public.${t}`);
  }
});

test("keel-egress's database role can only work the request queue", async () => {
  const { db } = await keys();
  const base = env.KEEL_SERVICE_PASSWORD || env.POSTGRES_PASSWORD;
  const password = Buffer.from(crypto.hkdfSync('sha256', base, 'keel', 'keel/db-role/keel_egress_admin/v1', 32)).toString('hex');
  const c = new pg.Client({ host: env.KEEL_E2E_DB_HOST || 'localhost', port: Number(env.KEEL_DB_PORT || 5432), user: 'keel_egress_admin', password, database: db });
  await c.connect();
  try {
    await c.query('select count(*) from net.http_request_queue');
    await assert.rejects(c.query('select count(*) from auth.users'), { code: '42501' });
    await assert.rejects(c.query('select count(*) from cron.job'), { code: '42501' });
    await assert.rejects(c.query(`insert into net.http_request_queue (method, url, timeout_milliseconds) values ('GET', 'https://example.com/', 1000)`), { code: '42501' });
    await assert.rejects(c.query(`select net.http_get('https://example.com/')`), { code: '42501' });
  } finally {
    await c.end();
  }
});
