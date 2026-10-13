import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isPrivateServer, isPrivateUrl, newProjectSettings, safeRedirect, type AuthSettings } from './settings.js';

const base = { siteUrl: 'http://localhost:5173', allowList: ['http://192.168.1.20:3000/**', 'https://*.example.com/auth', 'myapp://callback'] } as AuthSettings;

test('allows the site URL origin', () => {
  assert.equal(safeRedirect(base, 'http://localhost:5173/welcome?x=1'), 'http://localhost:5173/welcome?x=1');
});

test('allows allow-list matches, including globs and custom schemes', () => {
  assert.equal(safeRedirect(base, 'http://192.168.1.20:3000/a/b/c'), 'http://192.168.1.20:3000/a/b/c');
  assert.equal(safeRedirect(base, 'https://app.example.com/auth'), 'https://app.example.com/auth');
  assert.equal(safeRedirect(base, 'myapp://callback'), 'myapp://callback');
});

test('falls back to the site URL for anything else', () => {
  assert.equal(safeRedirect(base, 'https://evil.test/'), 'http://localhost:5173');
  assert.equal(safeRedirect(base, 'https://a.b.example.com/auth'), 'http://localhost:5173', '* in the host matches one label');
  assert.equal(safeRedirect(base, 'https://evil.test?.example.com/auth'), 'http://localhost:5173', 'wildcards never spill into the host');
  assert.equal(safeRedirect(base, 'https://evil.test#.example.com/auth'), 'http://localhost:5173');
  assert.equal(safeRedirect(base, 'https://x@evil.test/auth'), 'http://localhost:5173');
  assert.equal(safeRedirect(base, 'http://192.168.1.20:3000.evil.test/'), 'http://localhost:5173');
  assert.equal(safeRedirect(base, 'http://localhost:5173.evil.test/'), 'http://localhost:5173');
  assert.equal(safeRedirect(base, 'javascript:alert(1)'), 'http://localhost:5173');
  assert.equal(safeRedirect(base, 'not a url'), 'http://localhost:5173');
  assert.equal(safeRedirect(base, undefined), 'http://localhost:5173');
  assert.equal(safeRedirect({ ...base, siteUrl: '' }, 'https://evil.test/'), '');
});

test('isPrivateUrl: this machine, private ranges and LAN names are private', () => {
  for (const url of [
    'http://localhost:8000',
    'http://127.0.0.1:8000',
    'http://192.168.1.20:8000',
    'http://10.0.0.5',
    'http://172.20.1.1:8000',
    'http://100.101.102.103:8000',
    'http://[::1]:8000',
    'http://[fd12:3456::1]:8000',
    'http://nas:8000',
    'http://keel.local:8000',
    'http://keel.lan',
    'http://keel.home.arpa',
  ]) {
    assert.equal(isPrivateUrl(url), true, url);
  }
  for (const url of ['https://api.example.com', 'http://203.0.113.10:8000', 'http://[2001:db8::1]:8000', 'https://keel.tail1234.ts.net', 'not a url']) {
    assert.equal(isPrivateUrl(url), false, url);
  }
});

test('new projects on a public URL do not start with open, auto-confirmed sign-ups', () => {
  assert.deepEqual(newProjectSettings('http://192.168.1.20:8000', false), {});
  assert.deepEqual(newProjectSettings('https://api.example.com', false), { disable_signup: true, mailer_autoconfirm: false });
  assert.deepEqual(newProjectSettings('https://api.example.com', true), { mailer_autoconfirm: false });
});

test('KEEL_EXPOSURE=internet makes a private-looking URL public (a cloud server behind 1:1 NAT)', () => {
  assert.deepEqual(newProjectSettings('http://10.0.0.5:8000', false, 'internet'), { disable_signup: true, mailer_autoconfirm: false });
  assert.deepEqual(newProjectSettings('http://10.0.0.5:8000', true, 'internet'), { mailer_autoconfirm: false });
  assert.equal(isPrivateServer('http://10.0.0.5:8000', 'internet'), false);
  // "lan" says the server is not reachable from the internet, whatever the URL looks like.
  assert.equal(isPrivateServer('https://keel.example.com', 'lan'), true);
  assert.deepEqual(newProjectSettings('https://keel.example.com', false, 'lan'), {});
  // Anything else: decided from the URL.
  assert.equal(isPrivateServer('http://10.0.0.5:8000', ''), true);
  assert.equal(isPrivateServer('https://keel.example.com', 'bogus'), false);
});
