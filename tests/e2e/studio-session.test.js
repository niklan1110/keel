import { test } from 'node:test';
import assert from 'node:assert/strict';
import { STUDIO, STUDIO_COOKIE, env, sessionFrom, studioHeaders } from './helpers.js';

// Studio keeps its session in an HttpOnly cookie that page scripts (an
// injected script, or the documentation served on the same origin) can't
// read. Because the browser sends a cookie by itself, every API call must
// also carry X-Keel-Studio, and calls that say they came from another site
// are refused (cross-site request forgery).

const host = new URL(STUDIO).host;
const credentials = JSON.stringify({ username: env.KEEL_DASHBOARD_USERNAME || 'admin', password: env.KEEL_DASHBOARD_PASSWORD });
const signIn = (headers = {}) =>
  fetch(`${STUDIO}/api/login`, { method: 'POST', headers: { ...studioHeaders(), 'Content-Type': 'application/json', ...headers }, body: credentials });
const cookieOf = (res) => res.headers.getSetCookie().find((c) => c.startsWith(`${STUDIO_COOKIE}=`));

test('signing in sets an HttpOnly, SameSite=Strict cookie and returns no token', async () => {
  const r = await signIn();
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.equal(body.token, undefined, 'page scripts never see the session token');
  const cookie = cookieOf(r);
  assert.ok(cookie, 'a session cookie is set');
  assert.match(cookie, /; HttpOnly/);
  assert.match(cookie, /; SameSite=Strict/);
  assert.match(cookie, /; Path=\/api/);
  if (STUDIO.startsWith('http:')) assert.doesNotMatch(cookie, /Secure/, 'plain http on the LAN keeps working');
});

test('the cookie is Secure when the browser is on https', async () => {
  const r = await signIn({ Origin: `https://${host}` });
  assert.equal(r.status, 200);
  assert.match(cookieOf(r), /; Secure/);
});

test('API calls without the X-Keel-Studio header are refused, even with a session', async () => {
  const session = sessionFrom(await signIn());
  const ok = await fetch(`${STUDIO}/api/session`, { headers: studioHeaders(session) });
  assert.equal(ok.status, 200);
  const bare = await fetch(`${STUDIO}/api/session`, { headers: { Cookie: `${STUDIO_COOKIE}=${session}` } });
  assert.equal(bare.status, 403);
  const post = await fetch(`${STUDIO}/api/projects`, {
    method: 'POST',
    headers: { Cookie: `${STUDIO_COOKIE}=${session}`, 'Content-Type': 'text/plain' },
    body: JSON.stringify({ name: 'csrf-made-this' }),
  });
  assert.equal(post.status, 403);
  // Signing in needs it too (login CSRF).
  const login = await fetch(`${STUDIO}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: credentials });
  assert.equal(login.status, 403);
});

test('calls from another site are refused, even with the header', async () => {
  const session = sessionFrom(await signIn());
  const as = (headers) => fetch(`${STUDIO}/api/projects`, { method: 'POST', headers: { ...studioHeaders(session), 'Content-Type': 'application/json', ...headers }, body: JSON.stringify({ name: 'csrf-made-this' }) });
  assert.equal((await as({ Origin: 'https://attacker.example' })).status, 403);
  assert.equal((await as({ Origin: 'null' })).status, 403);
  assert.equal((await as({ 'Sec-Fetch-Site': 'cross-site' })).status, 403);
  assert.equal((await as({ 'Sec-Fetch-Site': 'same-site' })).status, 403);
  const same = await fetch(`${STUDIO}/api/session`, { headers: { ...studioHeaders(session), Origin: `http://${host}`, 'Sec-Fetch-Site': 'same-origin' } });
  assert.equal(same.status, 200);
});

test('the session is not accepted as a bearer token', async () => {
  const session = sessionFrom(await signIn());
  const r = await fetch(`${STUDIO}/api/session`, { headers: { 'X-Keel-Studio': '1', Authorization: `Bearer ${session}` } });
  assert.equal(r.status, 401);
});

test('signing out ends the session and clears the cookie', async () => {
  const session = sessionFrom(await signIn());
  const out = await fetch(`${STUDIO}/api/logout`, { method: 'POST', headers: studioHeaders(session) });
  assert.equal(out.status, 200);
  assert.match(cookieOf(out), /Max-Age=0/);
  assert.equal((await fetch(`${STUDIO}/api/session`, { headers: studioHeaders(session) })).status, 401);
});

test('pages and docs need no header', async () => {
  assert.equal((await fetch(`${STUDIO}/`)).status, 200);
  assert.equal((await fetch(`${STUDIO}/health`)).status, 200);
});
