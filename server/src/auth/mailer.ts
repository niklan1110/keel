import nodemailer, { type Transporter } from 'nodemailer';
import { HttpError } from '../lib/http.js';
import { log, maskEmail, maskEmailsIn } from '../lib/log.js';
import type { AuthSettings, SmtpSettings } from './settings.js';

export type MailKind = 'confirmation' | 'invite' | 'magiclink' | 'recovery' | 'email_change';

const transports = new Map<string, Transporter>();

function transportFor(s: SmtpSettings): Transporter {
  const key = JSON.stringify(s);
  let t = transports.get(key);
  if (!t) {
    t = nodemailer.createTransport({
      host: s.host,
      port: s.port,
      secure: s.secure || s.port === 465,
      auth: s.user ? { user: s.user, pass: s.pass } : undefined,
    });
    transports.set(key, t);
  }
  return t;
}

const COPY: Record<MailKind, { subject: string; heading: string; body: string; cta: string }> = {
  confirmation: {
    subject: 'Confirm your signup',
    heading: 'Confirm your email',
    body: 'Follow the link below to confirm your email address and finish signing up.',
    cta: 'Confirm email',
  },
  invite: {
    subject: 'You have been invited',
    heading: 'You have been invited',
    body: 'You have been invited to create an account. Follow the link below to accept.',
    cta: 'Accept invite',
  },
  magiclink: {
    subject: 'Your sign-in link',
    heading: 'Sign in',
    body: 'Follow the link below to sign in, or enter this code:',
    cta: 'Sign in',
  },
  recovery: {
    subject: 'Reset your password',
    heading: 'Reset your password',
    body: 'Follow the link below to choose a new password. If you did not ask for this, you can ignore this email.',
    cta: 'Reset password',
  },
  email_change: {
    subject: 'Confirm your new email',
    heading: 'Confirm email change',
    body: 'Follow the link below to confirm your new email address.',
    cta: 'Confirm new email',
  },
};

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

function render(kind: MailKind, project: string, link: string, otp: string) {
  const c = COPY[kind];
  const text = `${c.heading}\n\n${c.body}\n\n${link}\n\nCode: ${otp}\n\n— ${project}`;
  const html = `<!doctype html><html><body style="margin:0;padding:32px 16px;background:#f5f6f7;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#141414">
<table role="presentation" width="100%" style="max-width:480px;margin:0 auto;background:#ffffff;border:1px solid #e3e4e7;border-radius:16px">
<tr><td style="padding:28px 28px 8px;font-weight:700;font-size:20px;letter-spacing:-0.03em">${escapeHtml(project)}<span style="color:#f0522e">.</span></td></tr>
<tr><td style="padding:8px 28px 0"><h1 style="margin:0 0 8px;font-size:22px;letter-spacing:-0.02em">${c.heading}</h1>
<p style="margin:0 0 20px;color:#5c5f66;line-height:1.5">${c.body}</p>
<a href="${escapeHtml(link)}" style="display:inline-block;padding:11px 20px;border-radius:999px;background:#141414;color:#ffffff;text-decoration:none;font-weight:600">${c.cta}</a>
<p style="margin:20px 0 0;color:#5c5f66">Or use this code: <strong style="font-family:ui-monospace,monospace;font-size:16px;letter-spacing:0.12em;color:#141414">${otp}</strong></p></td></tr>
<tr><td style="padding:24px 28px 28px;color:#767a82;font-size:12px">If the button does not work, copy this link into your browser:<br><span style="word-break:break-all">${escapeHtml(link)}</span></td></tr>
</table></body></html>`;
  return { subject: c.subject, text, html };
}

/**
 * Sends an auth email. Without SMTP configured nothing is sent, and the link
 * is not written anywhere either: anyone can ask for a recovery or magic link
 * for any address, so a logged link would be a way into that account. Studio
 * shows invite and password reset links to admins instead.
 */
export async function sendMail(
  s: AuthSettings,
  project: string,
  kind: MailKind,
  to: string,
  link: string,
  otp: string,
): Promise<void> {
  if (!s.smtp) {
    log.warn(`SMTP is not configured; ${kind} email was not sent`, { project, to: maskEmail(to) });
    return;
  }
  const { subject, text, html } = render(kind, project, link, otp);
  try {
    // An address object, so nodemailer never parses `to` as a display name or a list.
    await transportFor(s.smtp).sendMail({ from: s.smtp.from, to: { name: '', address: to }, subject, text, html });
    log.info(`sent ${kind} email`, { project, to: maskEmail(to) });
  } catch (err) {
    log.error(`failed to send ${kind} email`, { project, to: maskEmail(to), error: maskEmailsIn((err as Error).message) });
    throw new HttpError(500, 'Error sending email', 'unexpected_failure');
  }
}
