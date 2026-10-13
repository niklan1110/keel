import crypto from 'node:crypto';
import { log, maskPhone } from '../lib/log.js';
import type { AuthSettings } from './settings.js';
import { err } from './core.js';

export type SmsChannel = 'sms' | 'whatsapp';

/**
 * Normalises a phone number the way GoTrue does: digits only, no leading +,
 * E.164 length. Stored and returned in this form (e.g. "15555550100").
 */
export function normalizePhone(phone: unknown): string {
  if (typeof phone !== 'string') throw err(400, 'validation_failed', 'A phone number is required');
  const p = phone.trim().replace(/[\s().-]/g, '').replace(/^\+/, '');
  if (!/^[1-9]\d{6,14}$/.test(p)) throw err(400, 'validation_failed', 'Invalid phone number format (E.164 required)');
  return p;
}

export function smsCode(s: AuthSettings, phone: string): string {
  const fixed = s.phone.testOtp[phone];
  if (fixed) return fixed;
  const len = s.phone.otpLength;
  return String(crypto.randomInt(0, 10 ** len)).padStart(len, '0');
}

const TIMEOUT_MS = 10_000;

async function call(url: string, init: RequestInit, provider: string): Promise<any> {
  let res: Response;
  try {
    res = await fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (e) {
    throw new Error(`${provider} is unreachable: ${(e as Error).message}`);
  }
  const text = await res.text();
  let data: any = text;
  try {
    data = JSON.parse(text);
  } catch {
    /* not JSON */
  }
  if (!res.ok) throw new Error(`${provider} answered ${res.status}: ${typeof data === 'string' ? data.slice(0, 200) : data?.message || data?.error_text || JSON.stringify(data).slice(0, 200)}`);
  return data;
}

/**
 * Sends a one-time code by SMS (or WhatsApp with Twilio). Test numbers never
 * reach a provider. Returns a provider message id when there is one.
 */
export async function sendSms(
  s: AuthSettings,
  project: string,
  phone: string,
  code: string,
  opts: { channel?: SmsChannel; kind: string },
): Promise<string> {
  if (s.phone.testOtp[phone]) return 'test-number';
  const message = s.phone.template.replace(/\{\{\s*\.Code\s*\}\}/g, code);
  const to = `+${phone}`;
  const p = s.phone.raw;
  const channel = opts.channel === 'whatsapp' ? 'whatsapp' : 'sms';
  try {
    switch (s.phone.provider) {
      case 'twilio': {
        const t = p.twilio!;
        if (channel === 'whatsapp' && !t.from) throw err(400, 'validation_failed', 'WhatsApp needs a Twilio "From" number (a Messaging Service SID only works for SMS)');
        const form = new URLSearchParams({ To: channel === 'whatsapp' ? `whatsapp:${to}` : to, Body: message });
        if (t.message_service_sid && channel === 'sms') form.set('MessagingServiceSid', t.message_service_sid);
        else form.set('From', channel === 'whatsapp' ? `whatsapp:${t.from}` : t.from || '');
        const data = await call(
          `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(t.account_sid!)}/Messages.json`,
          {
            method: 'POST',
            headers: { Authorization: `Basic ${Buffer.from(`${t.account_sid}:${t.auth_token}`).toString('base64')}`, 'Content-Type': 'application/x-www-form-urlencoded' },
            body: form,
          },
          'Twilio',
        );
        return String(data?.sid || '');
      }
      case 'vonage': {
        if (channel === 'whatsapp') throw err(400, 'validation_failed', 'WhatsApp is only available with Twilio');
        const v = p.vonage!;
        const data = await call(
          'https://rest.nexmo.com/sms/json',
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({ api_key: v.api_key!, api_secret: v.api_secret!, from: v.from!, to: phone, text: message }),
          },
          'Vonage',
        );
        const m = data?.messages?.[0];
        if (!m || m.status !== '0') throw new Error(`Vonage refused the message: ${m?.['error-text'] || 'unknown error'}`);
        return String(m['message-id'] || '');
      }
      case 'messagebird': {
        if (channel === 'whatsapp') throw err(400, 'validation_failed', 'WhatsApp is only available with Twilio');
        const m = p.messagebird!;
        const data = await call(
          'https://rest.messagebird.com/messages',
          {
            method: 'POST',
            headers: { Authorization: `AccessKey ${m.access_key}`, 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({ originator: m.originator!, recipients: phone, body: message }),
          },
          'MessageBird',
        );
        return String(data?.id || '');
      }
      case 'webhook': {
        // Your own gateway: a GSM modem, Home Assistant, an SMS app on a phone...
        const w = p.webhook!;
        const body = JSON.stringify({ phone: to, otp: code, message, channel, type: opts.kind, project, sent_at: new Date().toISOString() });
        const headers: Record<string, string> = { 'Content-Type': 'application/json', 'User-Agent': 'keel-auth' };
        if (w.secret) {
          const ts = Math.floor(Date.now() / 1000).toString();
          headers['X-Keel-Timestamp'] = ts;
          headers['X-Keel-Signature'] = `sha256=${crypto.createHmac('sha256', w.secret).update(`${ts}.${body}`).digest('hex')}`;
        }
        const data = await call(w.url!, { method: 'POST', headers, body }, 'SMS webhook');
        return typeof data === 'object' && data?.message_id ? String(data.message_id) : '';
      }
      case 'log':
        // Testing only. Nothing is sent and the code isn't logged either: anyone
        // can ask for a code for any number. Test numbers have fixed codes.
        log.warn('SMS not sent (testing provider; use test numbers with fixed codes)', { project, to: maskPhone(phone), type: opts.kind });
        return 'logged';
      default:
        throw err(422, 'sms_send_failed', 'No SMS provider is configured for this project');
    }
  } catch (e) {
    if ((e as { status?: number }).status) throw e;
    // Provider answers can contain internal details: they go to the log, not to the caller.
    log.warn('sms send failed', { project, provider: s.phone.provider || 'none', error: (e as Error).message });
    throw err(500, 'sms_send_failed', `Error sending ${channel === 'whatsapp' ? 'WhatsApp message' : 'SMS'}. Check the SMS provider settings; details are in the keel-auth log.`);
  }
}
