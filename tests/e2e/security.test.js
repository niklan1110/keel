import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import { GATEWAY, PROJECT, PROJECT_URL, STUDIO, deployFunction, ensureSchema, env, keys, studio, uniq } from './helpers.js';

// What strangers can learn or reach: the public API, Studio's sign-in, the
// Docker proxy and the network edge functions run on.

const fn = uniq('netprobe');
const lanFn = uniq('lanprobe');
const rangeFn = uniq('rangeprobe');
const P = `/api/projects/${PROJECT}`;
const created = [];

after(async () => {
  await studio('DELETE', `${P}/functions/${fn}`);
  await studio('DELETE', `${P}/functions/${lanFn}`);
  await studio('DELETE', `${P}/functions/${rangeFn}`);
  for (const id of created) await studio('DELETE', `/api/studio-users/${id}`);
});

test('gateway: no version, and unknown projects look like a wrong key', async () => {
  const root = await (await fetch(`${GATEWAY}/`, { headers: { accept: 'application/json' } })).json();
  assert.equal(root.version, undefined);
  assert.equal(root.name, 'keel');

  const { anon } = await keys();
  const ghost = `${GATEWAY}/${uniq('nope')}`;
  for (const [url, key, message] of [
    [`${ghost}/rest/v1/`, null, 'No API key found in request'],
    [`${ghost}/rest/v1/`, anon, 'Invalid API key'],
    [`${PROJECT_URL}/rest/v1/`, 'not-a-key', 'Invalid API key'],
    [`${ghost}/auth/v1/settings`, anon, 'Invalid API key'],
  ]) {
    const r = await fetch(url, { headers: key ? { apikey: key } : {} });
    assert.equal(r.status, 401, url);
    assert.deepEqual(await r.json(), { message });
  }
  // Open endpoints of a project that doesn't exist: a plain 404.
  const open = await fetch(`${ghost}/auth/v1/.well-known/jwks.json`);
  assert.equal(open.status, 404);
  assert.doesNotMatch(await open.text(), /project/i);
});

test('gateway: auth settings and health need the API key, like on Supabase', async () => {
  const { anon } = await keys();
  assert.equal((await fetch(`${PROJECT_URL}/auth/v1/settings`)).status, 401);
  assert.equal((await fetch(`${PROJECT_URL}/auth/v1/health`)).status, 401);
  assert.equal((await fetch(`${PROJECT_URL}/auth/v1/settings`, { headers: { apikey: anon } })).status, 200);
  assert.equal((await fetch(`${PROJECT_URL}/auth/v1/.well-known/jwks.json`)).status, 200);
});

test('Studio: anything that came through Cloudflare counts as the internet', async () => {
  const username = uniq('edge');
  const password = `pw-${uniq('x')}`;
  const r = await studio('POST', '/api/studio-users', { username, password });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  created.push(r.data.id);

  const login = (headers) =>
    fetch(`${STUDIO}/api/login`, { method: 'POST', headers: { 'x-keel-studio': '1', 'content-type': 'application/json', ...headers }, body: JSON.stringify({ username, password }) });
  // Cloudflare with "Remove visitor IP headers": only cf-ray is left.
  const viaEdge = await login({ 'cf-ray': '8c1f0e2d3a4b5c6d-AMS' });
  assert.equal(viaEdge.status, 403);
  assert.equal((await viaEdge.json()).error, 'two_factor_required');
  // A forged local address behind the edge doesn't help.
  const forged = await login({ 'cdn-loop': 'cloudflare', 'x-forwarded-for': '192.168.1.5' });
  assert.equal(forged.status, 403);
  // From this machine it's the home network: password only.
  assert.equal((await login({})).status, 200);
});

test('Studio: a malformed path is a 400, not a crash', async () => {
  assert.equal((await fetch(`${STUDIO}/%ff`)).status, 400);
});

/** The keel-functions container's default gateway (the Docker host), read from its /proc/net/route. */
function functionsHostGateway() {
  const project = process.env.KEEL_E2E_COMPOSE_PROJECT || 'keel';
  try {
    const id = execFileSync('docker', ['ps', '-q', '--filter', `label=com.docker.compose.project=${project}`, '--filter', 'label=com.docker.compose.service=keel-functions'], { encoding: 'utf8' }).trim().split('\n')[0];
    if (!id) return null;
    const route = execFileSync('docker', ['exec', id, 'cat', '/proc/net/route'], { encoding: 'utf8' });
    const row = route.split('\n').slice(1).map((l) => l.trim().split(/\s+/)).find((c) => c[1] === '00000000');
    if (!row) return null;
    // Little-endian hex, e.g. 0100140A is 10.20.0.1.
    return [6, 4, 2, 0].map((i) => parseInt(row[2].slice(i, i + 2), 16)).join('.');
  } catch {
    return null;
  }
}

/** A LAN address to probe: this machine's own, else a typical router. */
function lanAddress() {
  const own = Object.values(os.networkInterfaces())
    .flat()
    .find((i) => i && !i.internal && i.family === 'IPv4' && /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(i.address));
  return own?.address || '192.168.1.1';
}

test('edge functions reach their own API but no private address, by any name', async () => {
  const compose = process.env.KEEL_E2E_COMPOSE_PROJECT || 'keel';
  await deployFunction(fn, {
    [`${fn}/index.ts`]: `
import { createClient } from 'npm:@supabase/supabase-js@2';
const denied = (e) => e?.name === 'NotCapable' || /Requires net access/.test(String(e?.cause?.message ?? e?.message ?? ''));
const outcome = (e) => (denied(e) ? 'denied' : e?.name || 'error');
const http = async (url) => {
  try { const r = await fetch(url, { signal: AbortSignal.timeout(4000) }); await r.body?.cancel(); return 'reached'; }
  catch (e) { return outcome(e); }
};
const tcp = async (hostname, port) => {
  try { (await Deno.connect({ hostname, port })).close(); return 'reached'; }
  catch (e) { return outcome(e); }
};
// Module imports are checked by --deny-import, not --deny-net: a JSON import reads the answer.
const imp = async (url) => {
  try { await import(url, { with: { type: 'json' } }); return 'reached'; }
  catch (e) { return /Requires import access|NotCapable/.test(String(e?.message ?? '')) || e?.name === 'NotCapable' ? 'denied' : e?.name || 'error'; }
};
const ws = (url) => new Promise((resolve) => {
  let s;
  try { s = new WebSocket(url); } catch (e) { return resolve(outcome(e)); }
  s.onopen = () => { s.close(); resolve('reached'); };
  s.onerror = (e) => resolve(denied(e?.error) || /Requires net access/.test(String(e?.message)) ? 'denied' : 'error');
  setTimeout(() => resolve('timeout'), 4000);
});
Deno.serve(async (req) => {
  const q = new URL(req.url).searchParams;
  // The Docker host, as given by the test, else the first address of this container's network.
  const own = Deno.networkInterfaces().find((i) => i.family === 'IPv4' && !i.address.startsWith('127.'));
  const first = own ? own.address.split('.').slice(0, 3).join('.') + '.1' : '172.17.0.1';
  const gw = q.get('gw') || first;
  const dashed = (ip) => ip.replaceAll('.', '-');
  const supabase = createClient(Deno.env.get('SUPABASE_URL'), Deno.env.get('SUPABASE_SERVICE_ROLE_KEY'));
  const { data: sum, error } = await supabase.rpc('add_numbers', { a: 2, b: 3 });
  const other = await fetch(new URL(Deno.env.get('SUPABASE_URL')).origin + '/' + q.get('other') + '/rest/v1/');
  return Response.json({
    gw,
    supabase: error ? error.message : sum,
    otherProject: other.status,
    hostStudio: await http('http://' + gw + ':3000/api/session'),
    hostGateway: await http('http://' + gw + ':8000/'),
    hostPostgres: await tcp(gw, 5432),
    hostGatewayWs: await ws('ws://' + gw + ':8000/'),
    ownAddress: own ? await http('http://' + own.address + ':9000/health') : 'denied',
    lan: await http('http://' + q.get('lan') + '/'),
    dbByService: await tcp('keel-db', 5432),
    dbByContainer: await tcp(q.get('dbAlias'), 5432),
    studioByService: await http('http://keel-studio:3000/health'),
    hostNipIo: await http('http://' + dashed(gw) + '.nip.io:3000/'),
    hostNipIoTcp: await tcp(dashed(gw) + '.nip.io', 5432),
    loopback: await http('http://127.0.0.1:9000/_keel/status'),
    loopbackMapped: await http('http://[::ffff:127.0.0.1]:9000/_keel/status'),
    hostMapped: await tcp('::ffff:' + gw, 5432),
    // IPv4-compatible IPv6: Deno doesn't deny it, but Linux can't route it. Watched in case that changes.
    loopbackCompat: await tcp('::127.0.0.1', 9000),
    localhost: await http('http://localhost:9000/_keel/status'),
    metadata: await http('http://169.254.169.254/latest/meta-data/'),
    importHostGateway: await imp('http://' + gw + ':8000/'),
    importLoopback: await imp('http://127.0.0.1:9000/health'),
    importLocalhost: await imp('http://localhost:9000/health'),
    importLan: await imp('http://' + q.get('lan') + '/x.json'),
    importMetadata: await imp('http://169.254.169.254/latest/meta-data/'),
  });
});`,
  }, { verifyJwt: false });
  await ensureSchema();
  const qs = new URLSearchParams({ gw: functionsHostGateway() || '', lan: lanAddress(), dbAlias: `${compose}-keel-db-1`, other: uniq('other') });
  if (!qs.get('gw')) qs.delete('gw');
  let out;
  for (let i = 0; i < 60; i++) {
    const r = await fetch(`${PROJECT_URL}/functions/v1/${fn}?${qs}`);
    if (r.status === 200) {
      out = await r.json();
      break;
    }
    await new Promise((res) => setTimeout(res, 1000));
  }
  assert.ok(out, 'function answered');
  // supabase-js inside the function works against its own project...
  assert.equal(out.supabase, 5, JSON.stringify(out));
  // ...and only its own project.
  assert.equal(out.otherProject, 403);
  for (const k of ['hostStudio', 'hostGateway', 'hostPostgres', 'hostGatewayWs', 'ownAddress', 'lan', 'dbByService', 'dbByContainer', 'studioByService', 'loopback', 'loopbackMapped', 'hostMapped', 'localhost', 'metadata', 'importHostGateway', 'importLoopback', 'importLocalhost', 'importLan', 'importMetadata']) {
    assert.equal(out[k], 'denied', `${k} (host gateway ${out.gw}): ${JSON.stringify(out)}`);
  }
  assert.notEqual(out.loopbackCompat, 'reached', JSON.stringify(out));
  // nip.io needs public DNS; without it the name doesn't resolve, which is fine too.
  for (const k of ['hostNipIo', 'hostNipIoTcp']) assert.notEqual(out[k], 'reached', k);
});

test('edge functions reach LAN addresses in KEEL_FUNCTIONS_ALLOW_LAN, and no others', async (t) => {
  // Runs when the stack under test has an allowed single address, e.g.
  // KEEL_FUNCTIONS_ALLOW_LAN=192.168.1.50:11434 in .env.
  const entries = String(env.KEEL_FUNCTIONS_ALLOW_LAN || '').split(',').map((x) => x.trim()).filter(Boolean);
  const single = entries.map((e) => /^(\d+\.\d+\.\d+\.\d+)(?::(\d+))?$/.exec(e)).find(Boolean);
  if (!single) return t.skip('set KEEL_FUNCTIONS_ALLOW_LAN to a LAN address to run this test');
  const allowed = single[1];
  const port = single[2] || '80';
  const parts = allowed.split('.').map(Number);
  parts[3] = parts[3] === 254 ? 253 : parts[3] + 1;
  const neighbour = parts.join('.');
  if (entries.some((e) => e.startsWith(neighbour + ':') || e === neighbour || e.includes('/'))) return t.skip('the neighbouring address is allowed too');
  await deployFunction(lanFn, {
    [`${lanFn}/index.ts`]: `
const denied = (e) => e?.name === 'NotCapable' || /Requires net access/.test(String(e?.cause?.message ?? e?.message ?? ''));
const tcp = async (hostname, port) => {
  try { (await Deno.connect({ hostname, port })).close(); return 'reached'; }
  catch (e) { return denied(e) ? 'denied' : 'not denied (' + e.name + ')'; }
};
Deno.serve(async (req) => {
  const q = new URL(req.url).searchParams;
  const port = Number(q.get('port'));
  return Response.json({
    allowed: await tcp(q.get('allowed'), port),
    neighbour: await tcp(q.get('neighbour'), port),
    router: await tcp('192.168.0.1', 80),
    keelDb: await tcp('keel-db', 5432),
  });
});`,
  }, { verifyJwt: false });
  const qs = new URLSearchParams({ allowed, neighbour, port });
  let out;
  for (let i = 0; i < 40; i++) {
    const r = await fetch(`${PROJECT_URL}/functions/v1/${lanFn}?${qs}`);
    if (r.status === 200) {
      out = await r.json();
      break;
    }
    await new Promise((res) => setTimeout(res, 1000));
  }
  assert.ok(out, 'function answered');
  // Allowed: the connection is attempted (it may still fail if nothing listens there).
  assert.notEqual(out.allowed, 'denied', JSON.stringify(out));
  assert.equal(out.neighbour, 'denied', JSON.stringify(out));
  assert.equal(out.keelDb, 'denied', JSON.stringify(out));
  if (!allowed.startsWith('192.168.0.')) assert.equal(out.router, 'denied', JSON.stringify(out));
});

test("a range in KEEL_FUNCTIONS_ALLOW_LAN never opens this server's own address", async (t) => {
  // Runs when the stack under test allows a range, e.g. KEEL_FUNCTIONS_ALLOW_LAN=192.168.1.0/24.
  const range = String(env.KEEL_FUNCTIONS_ALLOW_LAN || '').split(',').map((x) => x.trim()).find((e) => /^\d+\.\d+\.\d+\.\d+\/\d+$/.test(e));
  if (!range || Number(range.split('/')[1]) > 30) return t.skip('set KEEL_FUNCTIONS_ALLOW_LAN to a LAN range to run this test');
  const toInt = (ip) => ip.split('.').reduce((n, p) => n * 256 + Number(p), 0);
  const [base, bits] = range.split('/');
  const inRange = (ip) => Math.floor(toInt(ip) / 2 ** (32 - Number(bits))) === Math.floor(toInt(base) / 2 ** (32 - Number(bits)));
  const hosts = String(env.KEEL_HOST_ADDRESSES || '').split(',').map((x) => x.trim()).filter((ip) => /^\d+\.\d+\.\d+\.\d+$/.test(ip));
  const host = hosts.find(inRange);
  const other = [1, 2, 3].map((n) => base.replace(/\d+$/, String(Number(base.split('.')[3]) + n))).find((ip) => !hosts.includes(ip));
  await deployFunction(rangeFn, {
    [`${rangeFn}/index.ts`]: `
const denied = (e) => e?.name === 'NotCapable' || /Requires net access/.test(String(e?.cause?.message ?? e?.message ?? ''));
const tcp = async (hostname, port) => {
  try { (await Deno.connect({ hostname, port })).close(); return 'reached'; }
  catch (e) { return denied(e) ? 'denied' : 'not denied (' + e.name + ')'; }
};
Deno.serve(async (req) => {
  const q = new URL(req.url).searchParams;
  const out = { other: await tcp(q.get('other'), 80) };
  if (q.get('host')) for (const port of [3000, 5432, 8000]) out['host' + port] = await tcp(q.get('host'), port);
  return Response.json(out);
});`,
  }, { verifyJwt: false });
  const qs = new URLSearchParams({ other, host: host || '' });
  let out;
  for (let i = 0; i < 40; i++) {
    const r = await fetch(`${PROJECT_URL}/functions/v1/${rangeFn}?${qs}`);
    if (r.status === 200) {
      out = await r.json();
      break;
    }
    await new Promise((res) => setTimeout(res, 1000));
  }
  assert.ok(out, 'function answered');
  if (!hosts.length) {
    // Without this server's addresses Keel can't keep it closed, so the range isn't opened at all.
    assert.equal(out.other, 'denied', JSON.stringify(out));
    return;
  }
  assert.notEqual(out.other, 'denied', JSON.stringify(out));
  if (!host) return t.skip(`none of KEEL_HOST_ADDRESSES is inside ${range}`);
  for (const port of [3000, 5432, 8000]) assert.equal(out['host' + port], 'denied', `${host}:${port} ${JSON.stringify(out)}`);
});

/** Runs a script inside the Studio container, which is the only one that can reach keel-docker. */
function inStudio(script) {
  const project = process.env.KEEL_E2E_COMPOSE_PROJECT || 'keel';
  let id;
  try {
    id = execFileSync('docker', ['ps', '-q', '--filter', `label=com.docker.compose.project=${project}`, '--filter', 'label=com.docker.compose.service=keel-studio'], { encoding: 'utf8' }).trim().split('\n')[0];
  } catch {
    return null;
  }
  if (!id) return null;
  return JSON.parse(execFileSync('docker', ['exec', id, 'node', '--input-type=module', '-e', script], { encoding: 'utf8' }));
}

test('keel-docker shows only this install and no secrets', async (t) => {
  const out = inStudio(`
const d = (path, method = 'GET') => fetch('http://keel-docker:2375/v1.41' + path, { method }).then(async (r) => ({ status: r.status, body: await r.text() }));
const list = JSON.parse((await d('/containers/json?all=1')).body);
const db = list.find((c) => c.Labels['com.docker.compose.service'] === 'keel-db');
const inspect = JSON.parse((await d('/containers/' + db.Id + '/json')).body);
console.log(JSON.stringify({
  projects: [...new Set(list.map((c) => c.Labels['com.docker.compose.project']))],
  inspectKeys: Object.keys(inspect),
  hasEnv: JSON.stringify(inspect).includes('POSTGRES_PASSWORD'),
  images: (await d('/images/json')).status,
  archive: (await d('/containers/' + db.Id + '/archive?path=/')).status,
  exec: (await d('/containers/' + db.Id + '/exec', 'POST')).status,
  create: (await d('/containers/create', 'POST')).status,
  logs: (await d('/containers/' + db.Id + '/logs?stdout=1&tail=1')).status,
}));`);
  if (!out) return t.skip('docker CLI not available here');
  assert.equal(out.projects.length, 1);
  assert.equal(out.hasEnv, false);
  assert.deepEqual(out.inspectKeys.sort(), ['Config', 'Created', 'Id', 'Name', 'State']);
  for (const k of ['images', 'archive', 'exec', 'create']) assert.equal(out[k], 403, k);
  assert.equal(out.logs, 200);
});
