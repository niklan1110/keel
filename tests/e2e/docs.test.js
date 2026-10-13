import { test } from 'node:test';
import assert from 'node:assert/strict';
import { STUDIO } from './helpers.js';

// Studio serves the documentation site (website/) at /docs without a login.

test('docs: home, clean URLs and assets', async () => {
  const redirect = await fetch(`${STUDIO}/docs`, { redirect: 'manual' });
  assert.equal(redirect.status, 301);
  assert.equal(redirect.headers.get('location'), '/docs/');

  const home = await fetch(`${STUDIO}/docs/`);
  assert.equal(home.status, 200);
  assert.match(home.headers.get('content-type'), /text\/html/);
  // Inline scripts are allowed by their hashes only.
  assert.match(home.headers.get('content-security-policy'), /script-src 'self' 'sha256-/);
  assert.doesNotMatch(home.headers.get('content-security-policy'), /script-src[^;]*unsafe-inline/);
  const html = await home.text();
  assert.match(html, /Your backend, on your own server/);

  const page = await fetch(`${STUDIO}/docs/guide/quickstart`);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Quickstart/);

  const asset = /\/docs\/assets\/[^"]+\.js/.exec(html)?.[0];
  assert.ok(asset, 'home page references a script');
  const js = await fetch(`${STUDIO}${asset}`);
  assert.equal(js.status, 200);
  assert.match(js.headers.get('cache-control'), /immutable/);
});

test('docs: unknown pages get the 404 page, and paths cannot escape', async () => {
  const missing = await fetch(`${STUDIO}/docs/no/such/page`);
  assert.equal(missing.status, 404);
  assert.match(missing.headers.get('content-type'), /text\/html/);

  for (const p of ['/docs/..%2f..%2fpackage.json', '/docs/..%2F..%2Fserver%2Fpackage.json', '/docs/..%2Fstudio%2Findex.html']) {
    const r = await fetch(`${STUDIO}${p}`);
    assert.equal(r.status, 404, p);
    assert.doesNotMatch(await r.text(), /"name":\s*"@keel/, p);
  }

  // The Studio app keeps its stricter policy.
  const app = await fetch(`${STUDIO}/`);
  assert.doesNotMatch(app.headers.get('content-security-policy'), /script-src/);
});

test('docs: Markdown for coding agents (llms.txt)', async () => {
  const index = await fetch(`${STUDIO}/docs/llms.txt`);
  assert.equal(index.status, 200);
  assert.match(index.headers.get('content-type'), /text\/plain/);
  const text = await index.text();
  assert.match(text, /^# Keel\n/);
  assert.match(text, /## Getting started/);
  assert.match(text, /\(\/docs\/guide\/quickstart\.md\): /);
  assert.match(text, /\(\/docs\/api\/auth\.md\)/);

  const full = await (await fetch(`${STUDIO}/docs/llms-full.txt`)).text();
  assert.match(full, /Source: \/docs\/auth\/mfa\.md/);
  assert.match(full, /alter publication supabase_realtime add table/);
  assert.doesNotMatch(full, /^:::/m, 'containers are converted');
  assert.doesNotMatch(full, /<div class="cards">/);

  const page = await fetch(`${STUDIO}/docs/guide/quickstart.md`);
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-type'), /text\/markdown/);
  assert.match(await page.text(), /^# Quickstart\n/);

  // The agent prompt is included as text, ready to copy.
  const agents = await (await fetch(`${STUDIO}/docs/guide/ai-agents.md`)).text();
  assert.match(agents, /This app uses Keel as its backend/);
});
