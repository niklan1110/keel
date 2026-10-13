import { config } from './config.js';

type Level = 'debug' | 'info' | 'warn' | 'error';
const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const threshold = ORDER[(config.logLevel as Level) in ORDER ? (config.logLevel as Level) : 'info'];

function fmt(extra?: Record<string, unknown>): string {
  if (!extra) return '';
  const parts: string[] = [];
  for (const [k, v] of Object.entries(extra)) {
    if (v === undefined) continue;
    const s = typeof v === 'string' ? v : v instanceof Error ? v.message : JSON.stringify(v);
    parts.push(`${k}=${/\s/.test(s) ? JSON.stringify(s) : s}`);
  }
  return parts.length ? ' ' + parts.join(' ') : '';
}

function write(level: Level, msg: string, extra?: Record<string, unknown>) {
  if (ORDER[level] < threshold) return;
  const line = `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} ${msg}${fmt(extra)}\n`;
  (level === 'error' || level === 'warn' ? process.stderr : process.stdout).write(line);
}

export const log = {
  debug: (msg: string, extra?: Record<string, unknown>) => write('debug', msg, extra),
  info: (msg: string, extra?: Record<string, unknown>) => write('info', msg, extra),
  warn: (msg: string, extra?: Record<string, unknown>) => write('warn', msg, extra),
  error: (msg: string, extra?: Record<string, unknown>) => write('error', msg, extra),
};

/*
 * Personal data in logs. Logs are read in Studio, with `docker logs`, from
 * the json-file on the host and by log shippers, so email addresses and phone
 * numbers are masked unless KEEL_LOG_PII is on. Sign-in links and one-time
 * codes are never logged, whatever the setting.
 */

/** "ada@example.com" -> "a***@example.com". */
export function maskEmail(email: string, pii = config.logPii): string {
  if (pii) return email;
  const at = email.lastIndexOf('@');
  if (at < 0) return '***';
  return `${email.slice(0, Math.min(1, at))}***${email.slice(at)}`;
}

/** Masks every email address in a free text, such as a mail server's error. */
export function maskEmailsIn(text: string, pii = config.logPii): string {
  return pii ? text : text.replace(/[^\s<>"'(),;:]+@[^\s<>"'(),;:]+/g, (m) => maskEmail(m, false));
}

/** "15555550100" -> "+15*******00". */
export function maskPhone(phone: string, pii = config.logPii): string {
  const digits = phone.replace(/^\+/, '');
  if (pii) return `+${digits}`;
  if (digits.length < 6) return '+***';
  return `+${digits.slice(0, 2)}${'*'.repeat(digits.length - 4)}${digits.slice(-2)}`;
}
