import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { PROJECT, PROJECT_URL, client, deployFunction, keys, newUser, studio, uniq, waitFor } from './helpers.js';

const name = uniq('fn');
const P = `/api/projects/${PROJECT}`;

after(async () => {
  await studio('DELETE', `${P}/functions/${name}`);
  await studio('DELETE', `${P}/functions/${name}-ws`);
  await studio('DELETE', `${P}/functions/${name}-legacy`);
  await studio('DELETE', `${P}/secrets/E2E_GREETING`);
});

const source = (greeting) => `
import { corsHeaders } from '../_shared/cors.ts';
Deno.serve(async (req) => {
  const url = new URL(req.url);
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (url.pathname.endsWith('/sandbox')) {
    const tryIt = async (fn) => { try { await fn(); return 'allowed'; } catch (e) { return e.name; } };
    return Response.json({
      readEtc: await tryIt(() => Deno.readTextFile('/etc/hostname')),
      // Deno keeps compiled code of every function here; it must stay private.
      readGen: await tryIt(() => Deno.readDir(Deno.env.get('DENO_DIR') + '/gen')[Symbol.asyncIterator]().next()),
      run: await tryIt(() => new Deno.Command('id').output()),
      dbPassword: Deno.env.get('POSTGRES_PASSWORD') ?? null,
    });
  }
  if (url.pathname.endsWith('/whoami')) {
    // Functions get the project URL and keys, like on Supabase.
    const auth = req.headers.get('Authorization') ?? '';
    const r = await fetch(Deno.env.get('SUPABASE_URL') + '/auth/v1/user', {
      headers: { apikey: Deno.env.get('SUPABASE_ANON_KEY'), Authorization: auth },
    });
    return Response.json({ status: r.status, user: (await r.json()).email ?? null });
  }
  const body = req.method === 'POST' ? await req.json() : {};
  console.log('called with', JSON.stringify(body));
  return Response.json(
    { message: '${greeting} ' + (body.name ?? 'nobody'), secret: Deno.env.get('E2E_GREETING') ?? null, path: url.pathname, method: req.method },
    { headers: corsHeaders },
  );
});
`;
const shared = { '_shared/cors.ts': "export const corsHeaders = { 'Access-Control-Allow-Origin': '*', 'X-From': 'function' };\n" };

test('deploy and invoke an edge function with supabase-js', async () => {
  const { anon } = await keys();
  const v = await deployFunction(name, { [`${name}/index.ts`]: source('Hello'), ...shared });
  assert.equal(v, 1);
  const c = client(anon);
  const { data, error } = await c.functions.invoke(name, { body: { name: 'Keel' } });
  assert.equal(error, null);
  assert.equal(data.message, 'Hello Keel');
  assert.equal(data.path, `/${name}`);

  // Sub-paths and query strings reach the function.
  const res = await fetch(`${PROJECT_URL}/functions/v1/${name}/a/b?x=1`, { headers: { Authorization: `Bearer ${anon}` } });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).path, `/${name}/a/b`);
  assert.equal(res.headers.get('x-from'), 'function');
});

test('JWT verification, unknown functions and the sandbox', async () => {
  const { anon } = await keys();
  const none = await fetch(`${PROJECT_URL}/functions/v1/${name}`, { method: 'POST', body: '{}' });
  assert.equal(none.status, 401);
  assert.equal((await none.json()).message, 'Missing authorization header');
  const bad = await fetch(`${PROJECT_URL}/functions/v1/${name}`, { method: 'POST', body: '{}', headers: { Authorization: 'Bearer nope' } });
  assert.equal(bad.status, 401);
  const missing = await fetch(`${PROJECT_URL}/functions/v1/does-not-exist`, { headers: { Authorization: `Bearer ${anon}` } });
  assert.equal(missing.status, 404);
  const internal = await fetch(`${PROJECT_URL}/functions/v1/_keel/logs?project=${PROJECT}&name=${name}`);
  assert.equal(internal.status, 404);

  const sb = await fetch(`${PROJECT_URL}/functions/v1/${name}/sandbox`, { headers: { Authorization: `Bearer ${anon}` } });
  assert.deepEqual(await sb.json(), { readEtc: 'NotCapable', readGen: 'NotCapable', run: 'NotCapable', dbPassword: null });

  // The caller's token is passed through, so functions can act as the user.
  const u = await newUser();
  const who = await u.client.functions.invoke(`${name}/whoami`, { method: 'GET' });
  assert.equal(who.data.status, 200);
  assert.equal(who.data.user, u.email);
});

test('secrets, redeploys and public (verify_jwt off) functions', async () => {
  const { anon } = await keys();
  const s = await studio('PUT', `/api/projects/${PROJECT}/secrets`, { secrets: { E2E_GREETING: 'top-secret' } });
  assert.equal(s.status, 200);
  const reserved = await studio('PUT', `/api/projects/${PROJECT}/secrets`, { secrets: { SUPABASE_URL: 'x' } });
  assert.equal(reserved.status, 400);
  await waitFor(async () => (await client(anon).functions.invoke(name, { body: {} })).data?.secret === 'top-secret', { label: 'secret applied' });

  const v2 = await deployFunction(name, { [`${name}/index.ts`]: source('Howdy'), ...shared }, { verifyJwt: false });
  assert.equal(v2, 2);
  await waitFor(async () => {
    const r = await fetch(`${PROJECT_URL}/functions/v1/${name}`, { method: 'POST', body: JSON.stringify({ name: 'webhook' }) });
    return r.status === 200 && (await r.json()).message === 'Howdy webhook';
  }, { label: 'new version served without a JWT' });

  const logs = await studio('GET', `/api/projects/${PROJECT}/functions/${name}/logs`);
  assert.ok(logs.data.logs.some((l) => l.msg.includes('called with')), 'console output is captured');
  assert.ok(logs.data.invocations.length > 0);

  const list = await studio('GET', `/api/projects/${PROJECT}/functions`);
  const fn = list.data.functions.find((f) => f.name === name);
  assert.equal(fn.version, 2);
  assert.equal(fn.verifyJwt, false);
});

test('older std/http serve() functions and WebSockets work', async () => {
  const { anon } = await keys();
  await deployFunction(`${name}-legacy`, {
    [`${name}-legacy/index.ts`]: `import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';\nserve(() => new Response('legacy ok'));\n`,
  });
  const r = await fetch(`${PROJECT_URL}/functions/v1/${name}-legacy`, { headers: { Authorization: `Bearer ${anon}` } });
  assert.equal(await r.text(), 'legacy ok');

  await deployFunction(
    `${name}-ws`,
    {
      [`${name}-ws/index.ts`]: `Deno.serve((req) => {
  if (req.headers.get('upgrade') !== 'websocket') return new Response('expected a websocket', { status: 400 });
  const { socket, response } = Deno.upgradeWebSocket(req);
  socket.onmessage = (e) => socket.send('echo:' + e.data);
  return response;
});
`,
    },
    { verifyJwt: false },
  );
  const url = `${PROJECT_URL.replace(/^http/, 'ws')}/functions/v1/${name}-ws`;
  const reply = await new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.on('open', () => ws.send('ping'));
    ws.on('message', (m) => {
      resolve(String(m));
      ws.close();
    });
    ws.on('error', reject);
    setTimeout(() => reject(new Error('no websocket reply')), 15000);
  });
  assert.equal(reply, 'echo:ping');
});

test('deleting a function makes it 404', async () => {
  const d = await studio('DELETE', `/api/projects/${PROJECT}/functions/${name}-legacy`);
  assert.equal(d.status, 200);
  const { anon } = await keys();
  await waitFor(async () => (await fetch(`${PROJECT_URL}/functions/v1/${name}-legacy`, { headers: { Authorization: `Bearer ${anon}` } })).status === 404, {
    label: 'deleted function returns 404',
  });
});
