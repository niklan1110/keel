import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SESSION_COOKIE, csrfProblem, readCookie, sessionCookie, browserUsesHttps } from './csrf.js';

const req = (method: string, url: string, headers: Record<string, string> = {}) => ({ method, url, headers: { host: 'studio.lan:3000', ...headers } });
const studio = { 'x-keel-studio': '1' };

test('Studio API calls need the X-Keel-Studio header', () => {
  assert.equal(csrfProblem(req('GET', '/api/projects', studio), ['studio.lan:3000']), null);
  assert.match(csrfProblem(req('GET', '/api/projects'), ['studio.lan:3000'])!, /X-Keel-Studio/);
  assert.match(csrfProblem(req('POST', '/api/login'), ['studio.lan:3000'])!, /X-Keel-Studio/);
});

test('pages, docs, health and download links need no header', () => {
  for (const url of ['/', '/assets/app.js', '/docs/', '/health', '/api/download/abc.def']) assert.equal(csrfProblem(req('GET', url), ['studio.lan:3000']), null, url);
});

test('requests from another site are refused even with the header', () => {
  const hosts = ['studio.lan:3000'];
  assert.match(csrfProblem(req('POST', '/api/projects', { ...studio, origin: 'https://evil.example' }), hosts)!, /another site/);
  assert.match(csrfProblem(req('POST', '/api/projects', { ...studio, origin: 'null' }), hosts)!, /another site/);
  assert.match(csrfProblem(req('POST', '/api/projects', { ...studio, 'sec-fetch-site': 'cross-site' }), hosts)!, /another site/);
  assert.match(csrfProblem(req('POST', '/api/projects', { ...studio, 'sec-fetch-site': 'same-site' }), hosts)!, /another site/);
  assert.equal(csrfProblem(req('POST', '/api/projects', { ...studio, origin: 'http://studio.lan:3000', 'sec-fetch-site': 'same-origin' }), hosts), null);
});

test('the origin may be a name Studio is configured for, behind a proxy that rewrites Host', () => {
  const r = req('POST', '/api/projects', { ...studio, origin: 'https://studio.example.org' });
  assert.equal(csrfProblem(r, ['studio.lan:3000', 'studio.example.org']), null);
  assert.match(csrfProblem(r, ['studio.lan:3000', 'studio.example.org:8443'])!, /another site/, 'a name with a port must match the port');
  assert.match(csrfProblem(req('POST', '/api/projects', { ...studio, origin: 'https://studio.example.org.evil.test' }), ['studio.example.org'])!, /another site/);
});

test('the session cookie is HttpOnly, SameSite=Strict, scoped to /api, and Secure on https', () => {
  const c = sessionCookie('tok', 3600, false);
  assert.equal(c, `${SESSION_COOKIE}=tok; Path=/api; Max-Age=3600; HttpOnly; SameSite=Strict`);
  assert.match(sessionCookie('tok', 3600, true), /; Secure$/);
  assert.match(sessionCookie('', 0, false), /Max-Age=0/);
});

test('reads the session cookie among others', () => {
  assert.equal(readCookie(`a=1; ${SESSION_COOKIE}=xyz; b=2`, SESSION_COOKIE), 'xyz');
  assert.equal(readCookie(undefined, SESSION_COOKIE), null);
  assert.equal(readCookie(`x${SESSION_COOKIE}=no`, SESSION_COOKIE), null);
});

test('https is what the browser used: its Origin, or a trusted proxy saying so', () => {
  assert.equal(browserUsesHttps({ origin: 'https://studio.example.org' }, false), true);
  assert.equal(browserUsesHttps({ origin: 'http://192.168.1.20:3000' }, false), false);
  assert.equal(browserUsesHttps({ 'x-forwarded-proto': 'https' }, true), true);
  assert.equal(browserUsesHttps({ 'x-forwarded-proto': 'https' }, false), false, 'only a trusted proxy is believed');
});
