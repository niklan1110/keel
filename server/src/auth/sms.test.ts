import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizePhone } from './sms.js';

test('normalizePhone stores numbers like GoTrue (digits, no plus)', () => {
  assert.equal(normalizePhone('+1 (555) 555-0100'), '15555550100');
  assert.equal(normalizePhone('447700900123'), '447700900123');
  for (const bad of ['', '+0123456', '123', 'abc', '+1234567890123456', 42]) assert.throws(() => normalizePhone(bad), /phone/i);
});
