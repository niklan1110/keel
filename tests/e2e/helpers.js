// Shared setup for the end-to-end tests. They run against a live stack
// (./keel up) and talk to it exactly like an app would: through the gateway
// with @supabase/supabase-js.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import pg from 'pg';
import { createClient } from '@supabase/supabase-js';

const root = path.resolve(import.meta.dirname, '../..');

function loadEnv() {
  const env = {};
  const file = path.join(root, '.env');
  if (fs.existsSync(file)) {
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
      if (m) env[m[1]] = m[2];
    }
  }
  return { ...env, ...process.env };
}

export const env = loadEnv();
export const GATEWAY = (env.KEEL_E2E_GATEWAY || 'http://localhost:' + (env.KEEL_GATEWAY_PORT || 8000)).replace(/\/$/, '');
export const STUDIO = (env.KEEL_E2E_STUDIO || 'http://localhost:' + (env.KEEL_STUDIO_PORT || 3000)).replace(/\/$/, '');
export const PROJECT = env.KEEL_E2E_PROJECT || env.KEEL_DEFAULT_PROJECT || 'my-app';
export const PROJECT_URL = `${GATEWAY}/${PROJECT}`;

export function superuser(database) {
  return new pg.Client({
    host: env.KEEL_E2E_DB_HOST || 'localhost',
    port: Number(env.KEEL_DB_PORT || 5432),
    user: 'postgres',
    password: env.POSTGRES_PASSWORD,
    database,
  });
}

export async function sql(database, text, params) {
  const c = superuser(database);
  await c.connect();
  try {
    return await c.query(text, params);
  } finally {
    await c.end();
  }
}

let keysCache;
export async function keys() {
  if (!keysCache) {
    const { rows } = await sql('keel', 'select anon_key, service_key, db_name from keel.projects where name = $1', [PROJECT]);
    if (!rows[0]) throw new Error(`project ${PROJECT} not found`);
    keysCache = { anon: rows[0].anon_key, service: rows[0].service_key, db: rows[0].db_name };
  }
  return keysCache;
}

export function client(key, opts = {}) {
  return createClient(PROJECT_URL, key, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    ...opts,
  });
}

export const uniq = (p = 'u') => `${p}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;

export function waitFor(fn, { timeout = 10_000, interval = 100, label = 'condition' } = {}) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = async () => {
      try {
        const v = await fn();
        if (v) return resolve(v);
      } catch {
        /* retry */
      }
      if (Date.now() - start > timeout) return reject(new Error(`timed out waiting for ${label}`));
      setTimeout(tick, interval);
    };
    tick();
  });
}

/** Signs up a fresh confirmed user and returns a client acting as them. */
export async function newUser() {
  const { anon } = await keys();
  const email = `${uniq('user')}@example.com`;
  const password = 'correct-horse-battery';
  const c = client(anon);
  const { data, error } = await c.auth.signUp({ email, password });
  if (error) throw error;
  if (!data.session) throw new Error('expected a session (autoconfirm)');
  return { client: c, email, password, user: data.user, session: data.session };
}

/** Creates the tables and policies the tests use (idempotent). */
export async function ensureSchema() {
  const { db } = await keys();
  await sql(
    db,
    `
    create table if not exists public.todos (
      id bigint generated always as identity primary key,
      title text not null,
      done boolean not null default false,
      user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
      created_at timestamptz not null default now()
    );
    drop policy if exists "own todos" on public.todos;
    create policy "own todos" on public.todos for all to authenticated
      using (user_id = auth.uid()) with check (user_id = auth.uid());

    create table if not exists public.notes (
      id bigint generated always as identity primary key,
      body text not null,
      tags text[] not null default '{}',
      meta jsonb
    );
    drop policy if exists "anyone can read notes" on public.notes;
    create policy "anyone can read notes" on public.notes for select using (true);

    create or replace function public.add_numbers(a int, b int) returns int
      language sql immutable as $$ select a + b $$;

    alter table public.todos replica identity full;
    do $$ begin
      if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'todos') then
        alter publication supabase_realtime add table public.todos;
      end if;
      if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'notes') then
        alter publication supabase_realtime add table public.notes;
      end if;
    end $$;

    drop policy if exists "users manage own folder" on storage.objects;
    create policy "users manage own folder" on storage.objects for all to authenticated
      using (bucket_id = 'private-docs' and (storage.foldername(name))[1] = auth.uid()::text)
      with check (bucket_id = 'private-docs' and (storage.foldername(name))[1] = auth.uid()::text);
    `,
  );
  // Give PostgREST a moment to pick up the new schema.
  await new Promise((r) => setTimeout(r, 600));
}

/** A small solid-colour PNG, for image transformation tests. */
export async function png(width, height, rgb = [240, 82, 46]) {
  const zlib = await import('node:zlib');
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(zlib.crc32(body) >>> 0);
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // truecolour
  const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: width }, () => rgb).flat())]);
  const raw = Buffer.concat(Array.from({ length: height }, () => row));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** Updates a project's settings directly (as Studio would) and waits for services to reload. */
export async function setProjectSettings(patch) {
  await sql('keel', `update keel.projects set settings = settings || $2::jsonb where name = $1`, [PROJECT, JSON.stringify(patch)]);
  await new Promise((r) => setTimeout(r, 400));
}

/** Studio's session cookie. Page scripts can't read it (HttpOnly). */
export const STUDIO_COOKIE = 'keel_studio_session';

/** The Studio session a sign-in response set in its cookie, or null. */
export function sessionFrom(res) {
  for (const c of res.headers.getSetCookie()) {
    const m = new RegExp(`^${STUDIO_COOKIE}=([^;]*)`).exec(c);
    if (m) return m[1] || null;
  }
  return null;
}

/**
 * Headers for a Studio API call: the X-Keel-Studio header every call needs
 * (cross-site request forgery protection) and, when signed in, the session
 * cookie a browser would send.
 */
export function studioHeaders(session) {
  return { 'X-Keel-Studio': '1', ...(session ? { Cookie: `${STUDIO_COOKIE}=${session}` } : {}) };
}

/** Signs in to Studio as the owner and returns the session. */
export async function studioSignIn(username = env.KEEL_DASHBOARD_USERNAME || 'admin', password = env.KEEL_DASHBOARD_PASSWORD) {
  const r = await fetch(`${STUDIO}/api/login`, {
    method: 'POST',
    headers: { ...studioHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  if (r.status !== 200) throw new Error(`Studio sign-in failed: ${r.status} ${await r.text()}`);
  return sessionFrom(r);
}

let studioSession;
/** Calls the Studio management API, signing in on first use. */
export async function studio(method, path, body) {
  if (!studioSession) studioSession = await studioSignIn();
  const res = await fetch(`${STUDIO}${path}`, {
    method,
    headers: { ...studioHeaders(studioSession), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }
  return { status: res.status, data };
}

/** Deploys an edge function through Studio's API. `files` paths are relative to the functions folder. */
export async function deployFunction(name, files, opts = {}) {
  const r = await studio('PUT', `/api/projects/${PROJECT}/functions/${name}`, { files, verify_jwt: opts.verifyJwt ?? true });
  if (r.status !== 200) throw new Error(`deploy ${name} failed: ${JSON.stringify(r.data)}`);
  return r.data.version;
}

// Whether a service believes X-Forwarded-For from this machine, i.e. this
// machine is one of its trusted proxies (KEEL_TRUSTED_PROXIES=host, or the
// port published on 127.0.0.1, which makes the Docker host trusted). Studio
// and the gateway decide separately: by default Studio is published on
// 127.0.0.1 and the gateway on 0.0.0.0, so Studio trusts this machine and the
// gateway doesn't. Tests that pose as other addresses need a service that
// trusts this machine; tests of forged addresses need one that doesn't.

let studioTrusted;
/** Whether Studio believes X-Forwarded-For from this machine. */
export async function studioTrustsForwarding() {
  if (studioTrusted === undefined) {
    await studio('GET', '/api/session');
    const ip = '203.0.113.77';
    const r = await fetch(`${STUDIO}/api/account`, { headers: { ...studioHeaders(studioSession), 'X-Forwarded-For': ip } });
    studioTrusted = (await r.json()).address === ip;
  }
  return studioTrusted;
}

let gatewayTrusted;
/** Whether the gateway (and so auth, storage and the other APIs) believes X-Forwarded-For from this machine. */
export async function gatewayTrustsForwarding() {
  if (gatewayTrusted === undefined) {
    const { anon, db } = await keys();
    const u = await newUser();
    const ip = '2001:db8:77::77';
    const r = await fetch(`${PROJECT_URL}/auth/v1/token?grant_type=password`, {
      method: 'POST',
      headers: { apikey: anon, 'Content-Type': 'application/json', 'X-Forwarded-For': ip },
      body: JSON.stringify({ email: u.email, password: u.password }),
    });
    if (r.status !== 200) throw new Error(`sign-in for the trust probe failed: ${r.status}`);
    const session = JSON.parse(Buffer.from((await r.json()).access_token.split('.')[1], 'base64url').toString()).session_id;
    const { rows } = await sql(db, 'select host(ip) as ip from auth.sessions where id = $1', [session]);
    gatewayTrusted = rows[0]?.ip === ip;
  }
  return gatewayTrusted;
}

/**
 * Skips a test that this stack's configuration can't run, or fails it when
 * KEEL_E2E_REQUIRE_ALL=1 (a CI run that is set up to run every test).
 */
export function needsConfig(t, reason) {
  if (process.env.KEEL_E2E_REQUIRE_ALL === '1') assert.fail(`not run: ${reason} (KEEL_E2E_REQUIRE_ALL=1)`);
  return t.skip(reason);
}

/**
 * Runs a Node script inside one of Keel's containers (by compose service
 * name) and returns what it printed, parsed as JSON. Null when Docker can't
 * be reached from here.
 */
export function inContainer(service, script) {
  const project = process.env.KEEL_E2E_COMPOSE_PROJECT || 'keel';
  let id;
  try {
    id = execFileSync('docker', ['ps', '-q', '--filter', `label=com.docker.compose.project=${project}`, '--filter', `label=com.docker.compose.service=${service}`], { encoding: 'utf8' }).trim().split('\n')[0];
  } catch {
    return null;
  }
  if (!id) return null;
  return JSON.parse(execFileSync('docker', ['exec', id, 'node', '--input-type=module', '-e', script], { encoding: 'utf8' }));
}
