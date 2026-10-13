import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';

// config reads KEEL_SECRET once, when it's first imported.
const SECRET = 'f'.repeat(64);
process.env.KEEL_SECRET = SECRET;
const { openTotp, sealTotp, totpNeedsReseal } = await import('./accounts.js');

/** How two-factor secrets were sealed before keys were derived per purpose. */
function sealLegacyV1(secret: string): string {
  const key = crypto.createHash('sha256').update(`keel-studio-totp:${SECRET}`).digest();
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([c.update(secret, 'utf8'), c.final()]);
  return `v1:${iv.toString('base64')}:${c.getAuthTag().toString('base64')}:${data.toString('base64')}`;
}

test('two-factor secrets are sealed with the current format and open again', () => {
  const sealed = sealTotp('JBSWY3DPEHPK3PXP');
  assert.match(sealed, /^v2:/);
  assert.ok(!sealed.includes('JBSWY3DPEHPK3PXP'));
  assert.equal(openTotp(sealed), 'JBSWY3DPEHPK3PXP');
  assert.equal(totpNeedsReseal(sealed), false);
});

test('two-factor secrets sealed by older versions still open, and are marked for resealing', () => {
  const v1 = sealLegacyV1('JBSWY3DPEHPK3PXP');
  assert.equal(openTotp(v1), 'JBSWY3DPEHPK3PXP');
  assert.equal(totpNeedsReseal(v1), true);
  assert.equal(openTotp('JBSWY3DPEHPK3PXP'), 'JBSWY3DPEHPK3PXP');
  assert.equal(totpNeedsReseal('JBSWY3DPEHPK3PXP'), true);
});

test('the current format uses a different key than the old one', () => {
  const sealed = sealTotp('JBSWY3DPEHPK3PXP');
  // Relabelled as v1, it must not open with the old key.
  assert.throws(() => openTotp(sealed.replace(/^v2:/, 'v1:')), /can't be read/);
});
