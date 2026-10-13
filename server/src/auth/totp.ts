import crypto from 'node:crypto';
import qrcode from 'qrcode-generator';

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const STEP_SECONDS = 30;
const DIGITS = 6;

export function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(s: string): Buffer {
  const clean = s.toUpperCase().replace(/=+$/, '').replace(/\s/g, '');
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = ALPHABET.indexOf(ch);
    if (idx < 0) throw new Error('invalid base32');
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

export function newSecret(): string {
  return base32Encode(crypto.randomBytes(20));
}

/** RFC 4226 HOTP with HMAC-SHA1, as used by authenticator apps. */
export function hotp(secret: string, counter: number): string {
  const key = base32Decode(secret);
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const mac = crypto.createHmac('sha1', key).update(msg).digest();
  const offset = mac[mac.length - 1] & 0xf;
  const code = (mac.readUInt32BE(offset) & 0x7fffffff) % 10 ** DIGITS;
  return String(code).padStart(DIGITS, '0');
}

export const currentStep = (now = Date.now()) => Math.floor(now / 1000 / STEP_SECONDS);

export function totp(secret: string, now = Date.now()): string {
  return hotp(secret, currentStep(now));
}

/**
 * Checks a code against the current step and one step either side (clock
 * drift). Returns the matching step so callers can refuse replays, or null.
 */
export function verifyTotp(secret: string, code: string, now = Date.now()): number | null {
  if (!/^\d{6}$/.test(code)) return null;
  const step = currentStep(now);
  for (const s of [step, step - 1, step + 1]) {
    const expected = Buffer.from(hotp(secret, s));
    if (crypto.timingSafeEqual(expected, Buffer.from(code))) return s;
  }
  return null;
}

export function otpauthUri(secret: string, issuer: string, account: string): string {
  const label = encodeURIComponent(`${issuer}:${account}`);
  const q = new URLSearchParams({ secret, issuer, algorithm: 'SHA1', digits: String(DIGITS), period: String(STEP_SECONDS) });
  return `otpauth://totp/${label}?${q}`;
}

/** SVG markup of a QR code (GoTrue returns raw SVG; supabase-js turns it into a data URL). */
export function qrSvg(text: string): string {
  const qr = qrcode(0, 'M');
  qr.addData(text);
  qr.make();
  return qr.createSvgTag({ cellSize: 4, margin: 4, scalable: true });
}

/*
 * TOTP secrets at rest: AES-256-GCM, in the same "v1:iv:tag:data" form as
 * Studio's own two-factor secrets, so a copy of the database (a backup, an
 * export, a SQL query) doesn't hand out working codes. App users' secrets
 * are sealed with a key derived from their project's secret, which lives in
 * the control database, not in the project's.
 */

/** A 32-byte key for one purpose, derived from a project's secret. */
export function totpKey(projectSecret: string): Buffer {
  return Buffer.from(crypto.hkdfSync('sha256', projectSecret, 'keel', 'auth-mfa-totp', 32));
}

/** Seals sign-in providers' client secrets in the project settings. */
export function providerSecretKey(projectSecret: string): Buffer {
  return Buffer.from(crypto.hkdfSync('sha256', projectSecret, 'keel', 'auth-provider-secret', 32));
}

/** Derives the PKCE verifier and nonce Keel sends to a provider from the sign-in's own state nonce. */
export function oauthFlowKey(projectSecret: string): Buffer {
  return Buffer.from(crypto.hkdfSync('sha256', projectSecret, 'keel', 'auth-oauth-flow', 32));
}

export const isSealed =(stored: string) => stored.startsWith('v1:');

export function sealSecret(secret: string, key: Buffer): string {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([c.update(secret, 'utf8'), c.final()]);
  return `v1:${iv.toString('base64')}:${c.getAuthTag().toString('base64')}:${data.toString('base64')}`;
}

/** Secrets stored before encryption (or imported from Supabase) are plain base32 and come back as they are. Throws when the key is wrong. */
export function openSecret(stored: string, key: Buffer): string {
  if (!isSealed(stored)) return stored;
  const [, iv, tag, data] = stored.split(':');
  const d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64'));
  d.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([d.update(Buffer.from(data, 'base64')), d.final()]).toString('utf8');
}
