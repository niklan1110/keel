import assert from 'node:assert/strict';
import test from 'node:test';
import { sendMail } from './mailer.js';
import { sendSms } from './sms.js';
import type { AuthSettings } from './settings.js';

/** Runs fn and returns what it wrote to stdout and stderr. */
async function output(fn: () => Promise<unknown>): Promise<string> {
  let out = '';
  const orig = { stdout: process.stdout.write, stderr: process.stderr.write };
  const capture = (chunk: unknown) => {
    out += String(chunk);
    return true;
  };
  process.stdout.write = capture as typeof process.stdout.write;
  process.stderr.write = capture as typeof process.stderr.write;
  try {
    await fn();
  } finally {
    process.stdout.write = orig.stdout;
    process.stderr.write = orig.stderr;
  }
  return out;
}

test('without SMTP, a recovery email is not sent and its link and code are not logged', async () => {
  const s = { smtp: null } as AuthSettings;
  const out = await output(() => sendMail(s, 'my-app', 'recovery', 'ada@example.com', 'http://localhost:8000/my-app/auth/v1/verify?token=tok3n-hash&type=recovery', '482913'));
  assert.match(out, /recovery email was not sent/);
  assert.match(out, /a\*\*\*@example\.com/);
  for (const secret of ['tok3n-hash', '482913', 'ada@example.com']) assert.ok(!out.includes(secret), `log contains ${secret}`);
});

test('the testing SMS provider logs neither the code nor the full number', async () => {
  const s = { phone: { testOtp: {}, template: 'Your code is {{ .Code }}', provider: 'log', raw: { provider: 'log' } } } as unknown as AuthSettings;
  let id = '';
  const out = await output(async () => {
    id = await sendSms(s, 'my-app', '15555550100', '907135', { kind: 'sms' });
  });
  assert.equal(id, 'logged');
  assert.match(out, /SMS not sent/);
  for (const secret of ['907135', '15555550100']) assert.ok(!out.includes(secret), `log contains ${secret}`);
});
