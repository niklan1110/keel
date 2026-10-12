import assert from 'node:assert/strict';
import test from 'node:test';
import { maskEmail, maskEmailsIn, maskPhone } from './log.js';

test('email addresses are masked in logs unless KEEL_LOG_PII is on', () => {
  assert.equal(maskEmail('ada@example.com', false), 'a***@example.com');
  assert.equal(maskEmail('a@example.com', false), 'a***@example.com');
  assert.equal(maskEmail('not-an-address', false), '***');
  assert.equal(maskEmail('ada@example.com', true), 'ada@example.com');
});

test('phone numbers keep only their first and last two digits', () => {
  assert.equal(maskPhone('15555550100', false), '+15*******00');
  assert.equal(maskPhone('+4915112345678', false), '+49*********78');
  assert.equal(maskPhone('123', false), '+***');
  assert.equal(maskPhone('15555550100', true), '+15555550100');
});

test('addresses inside free text, such as a mail server error, are masked', () => {
  assert.equal(maskEmailsIn('550 5.1.1 <ada@example.com>: Recipient address rejected', false), '550 5.1.1 <a***@example.com>: Recipient address rejected');
  assert.equal(maskEmailsIn('no address here', false), 'no address here');
});
