import crypto from 'node:crypto';
import type pg from 'pg';
import { config, requireRolePassword } from '../lib/config.js';
import { pool, tx } from '../lib/db.js';
import { AccountBackoff, HttpError, RateLimiter, Router, bearer, clientIp, clientKey, createServer, fromLocalNetwork, listen, readJson, redirect, sendJson, type Req, type Res } from '../lib/http.js';
import { JwtError, sign, sha256, verify, type Claims } from '../lib/jwt.js';
import { log, maskEmail, maskPhone } from '../lib/log.js';
import { Registry, signingKey } from '../lib/registry.js';
import {
  applyVerification,
  assertCanSignIn,
  checkPassword,
  comparePassword,
  consumeOtp,
  createFlowState,
  createOtp,
  emailProven,
  err,
  evictUnprovenClaimants,
  otpHash,
  factorJson,
  fullUser,
  hashPassword,
  issueAuthCode,
  issueSession,
  knownAddress,
  loadFactors,
  loadUser,
  loadUserByEmail,
  loadUserByPhone,
  normalizeEmail,
  obfuscatedUser,
  pkceMatches,
  refreshSession,
  reissueSession,
  sessionFragment,
  txCommitThenThrow,
  upgradePasswordHash,
  upsertPhoneIdentity,
  userJson,
  userPayload,
  type Ctx,
  type FactorRow,
  type OtpType,
  type UserRow,
} from './core.js';
import { normalizePhone, sendSms, smsCode } from './sms.js';
import { newSecret, oauthFlowKey, openSecret, otpauthUri, qrSvg, sealSecret, totpKey, verifyTotp } from './totp.js';
import { sendMail, type MailKind } from './mailer.js';
import { newAccountEmail, providerConfig, type Flow, type ResolvedProvider } from './oauth.js';
import { resolveSettings, safeRedirect } from './settings.js';

const EMAIL_COOLDOWN_SECONDS = 60;
const MFA_CHALLENGE_TTL_S = 300;
const FLOW_CODE_TTL_MS = 10 * 60 * 1000;
const OAUTH_STATE_TTL_S = 600;
/** Sessions not refreshed for this long are deleted, with the IP address and browser they stored. */
const SESSION_RETENTION_DAYS = 90;
/**
 * Callers on your own network (KEEL_LOCAL_NETWORKS: LAN, Tailscale, this
 * machine) get this many times the per-IP allowance. One address there is a
 * developer or a test suite signing up users, not someone abusing the API.
 */
const LOCAL_NETWORK_FACTOR = 10;

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

export async function main(): Promise<void> {
  requireRolePassword('keel_auth_admin');
  const registry = new Registry('keel_auth_admin');
  await registry.start();

  const loginLimiter = new RateLimiter(10, 5 * 60_000);
  // Wrong passwords per account from all addresses together: 20 an hour, then slower and slower.
  const accountLimiter = new AccountBackoff(20, 60 * 60_000, 5 * 60_000);
  /**
   * Starts a password check under the account's backoff. True when it was
   * counted (end it with accountLimiter.end). While the account is waiting,
   * addresses it signed in from recently still get through, uncounted and
   * under their per-address limits: someone guessing slows the account down
   * for strangers but can't lock its owner out.
   */
  const startGuess = async (ctx: Ctx, account: string, by: 'email' | 'phone', value: string, ip: string): Promise<boolean> => {
    if (accountLimiter.begin(account)) return true;
    if (await knownAddress(ctx.pool, by, value, ip)) return false;
    throw err(429, 'over_request_rate_limit', 'Too many sign-in attempts for this account, try again later');
  };
  const ipLimiter = new RateLimiter(120, 5 * 60_000);
  const verifyLimiter = new RateLimiter(30, 5 * 60_000);
  // Email codes are 6 digits, so cap guesses per address no matter where they come from.
  const codeLimiter = new RateLimiter(10, 60 * 60_000);
  const emailLimiter = new RateLimiter(6, 60 * 60_000);
  // SMS costs money and attracts toll fraud: cap per number and per project.
  const smsPhoneLimiter = new RateLimiter(6, 60 * 60_000);
  const smsProjectLimiter = new RateLimiter(60, 60 * 60_000);
  const smsIpLimiter = new RateLimiter(10, 60 * 60_000);
  const mfaLimiter = new RateLimiter(10, 5 * 60_000);
  // Every email keel-auth sends through SMTP, per project.
  const emailProjectLimiter = new RateLimiter(100, 60 * 60_000);
  // One /recover or /resend per address and minute, whether or not the address has an account.
  const addressCooldownLimiter = new RateLimiter(1, EMAIL_COOLDOWN_SECONDS * 1000);

  /** A per-IP limit for one kind of request, per project. */
  const perIp = (limit: number, windowMs: number, message: string) => {
    const internet = new RateLimiter(limit, windowMs);
    const local = new RateLimiter(limit * LOCAL_NETWORK_FACTOR, windowMs);
    return (ctx: Ctx) => {
      const key = `${ctx.project.name}:${clientKey(ctx.req)}`;
      if (!(fromLocalNetwork(ctx.req) ? local : internet).take(key)) throw err(429, 'over_request_rate_limit', message);
    };
  };
  const limitSignup = perIp(30, 60 * 60_000, 'Too many sign-ups from this IP address, try again later');
  const limitAnonymous = perIp(30, 60 * 60_000, 'Too many anonymous sign-ins from this IP address, try again later');
  const limitOtp = perIp(30, 60 * 60_000, 'Too many sign-in codes requested from this IP address, try again later');
  const limitRecover = perIp(30, 60 * 60_000, 'Too many password resets requested from this IP address, try again later');
  const limitResend = perIp(30, 60 * 60_000, 'Too many emails or codes requested from this IP address, try again later');
  const limitAuthorize = perIp(60, 5 * 60_000, 'Too many sign-in attempts from this IP address, try again later');

  // OAuth state values that were used, until they expire anyway.
  const usedOauthStates = new Map<string, number>();

  const ctxOf = (req: Req, res: Res): Ctx => {
    const name = String(req.headers['x-keel-project'] || '');
    const project = registry.get(name);
    if (!project) throw err(404, 'project_not_found', name ? `Unknown project "${name}"` : 'Missing project');
    return { project, s: resolveSettings(project), pool: pool(project.dbName, 'keel_auth_admin', 10), req, res };
  };

  const claimsOf = (ctx: Ctx): Claims => {
    const token = bearer(ctx.req);
    if (!token) throw err(401, 'no_authorization', 'This endpoint requires a Bearer token');
    try {
      const claims = verify(token, ctx.project.jwtKeys);
      if (claims.ref && claims.ref !== ctx.project.name) throw new JwtError('token is for another project');
      return claims;
    } catch (e) {
      throw err(403, 'bad_jwt', `invalid JWT: unable to parse or verify signature, ${(e as Error).message}`);
    }
  };

  const userClaims = async (ctx: Ctx, c: pg.ClientBase): Promise<{ claims: Claims; user: UserRow; sessionId: string | null; aal: string }> => {
    const claims = claimsOf(ctx);
    if (!claims.sub) throw err(403, 'bad_jwt', 'invalid claim: missing sub claim');
    let aal = 'aal1';
    let sessionId: string | null = null;
    if (claims.session_id) {
      const s = await c.query('select aal from auth.sessions where id = $1 and user_id = $2', [claims.session_id, claims.sub]);
      if (!s.rowCount) throw err(403, 'session_not_found', 'Session from session_id claim in JWT does not exist');
      aal = s.rows[0].aal;
      sessionId = String(claims.session_id);
    }
    const user = await loadUser(c, String(claims.sub));
    if (!user || user.deleted_at) throw err(403, 'user_not_found', 'User from sub claim in JWT does not exist');
    return { claims, user, sessionId, aal };
  };

  /** With MFA enrolled, changing credentials needs a session that passed MFA. */
  const requireAal2IfMfa = async (c: pg.ClientBase, user: UserRow, aal: string) => {
    if (aal === 'aal2') return;
    const { rowCount } = await c.query(`select 1 from auth.mfa_factors where user_id = $1 and status = 'verified'`, [user.id]);
    if (rowCount) throw err(401, 'insufficient_aal', 'AAL2 session is required to update email or password when MFA is enabled.');
  };

  const requireAdmin = (ctx: Ctx) => {
    const claims = claimsOf(ctx);
    if (claims.role !== 'service_role') throw err(403, 'not_admin', 'User not allowed');
  };

  /**
   * Counts one email to `to` against the per-address limit and, when it will
   * really be sent (SMTP is set up), the per-project one.
   */
  const takeEmailBudget = (ctx: Ctx, to: string) => {
    if (!emailLimiter.take(`${ctx.project.name}:${to}`)) {
      throw err(429, 'over_email_send_rate_limit', 'Email rate limit exceeded');
    }
    if (ctx.s.smtp && !emailProjectLimiter.take(ctx.project.name)) {
      log.warn('project email limit reached (100 per hour); not sending more', { project: ctx.project.name });
      throw err(429, 'over_email_send_rate_limit', 'Email rate limit exceeded');
    }
  };

  /**
   * For endpoints whose answer must not reveal whether an address has an
   * account (/recover, /resend): limits keyed by the address alone, taken
   * before looking the address up.
   */
  const takeAddressLimits = (ctx: Ctx, kind: string, email: string) => {
    if (!addressCooldownLimiter.take(`${kind}:${ctx.project.name}:${email}`)) {
      throw err(429, 'over_email_send_rate_limit', `For security purposes, you can only request this once every ${EMAIL_COOLDOWN_SECONDS} seconds.`);
    }
    takeEmailBudget(ctx, email);
  };

  const coolingDown = (sentAt: Date | null | undefined) =>
    !!sentAt && Date.now() - new Date(sentAt).getTime() < EMAIL_COOLDOWN_SECONDS * 1000;

  const cooldown = (sentAt: Date | null | undefined, code = 'over_email_send_rate_limit') => {
    if (!sentAt) return;
    const left = EMAIL_COOLDOWN_SECONDS - Math.floor((Date.now() - new Date(sentAt).getTime()) / 1000);
    if (left > 0) throw err(429, code, `For security purposes, you can only request this after ${left} seconds.`);
  };

  /**
   * Issues a one-time token, records it, and emails the link + code. Pass
   * `counted` when the caller already took the email limits (takeEmailBudget).
   */
  const sendTokenMail = async (
    ctx: Ctx,
    c: pg.ClientBase,
    user: UserRow,
    otpType: OtpType,
    verifyType: string,
    mailKind: MailKind,
    to: string,
    redirectTo: string,
    counted = false,
  ) => {
    if (!counted) takeEmailBudget(ctx, to);
    const { otp, tokenHash } = await createOtp(c, ctx.project.jwtSecret, user.id, otpType, to);
    const q = new URLSearchParams({ token: tokenHash, type: verifyType });
    if (redirectTo) q.set('redirect_to', redirectTo);
    await sendMail(ctx.s, ctx.project.name, mailKind, to, `${ctx.s.apiUrl}/verify?${q}`, otp);
    return { otp, tokenHash, link: `${ctx.s.apiUrl}/verify?${q}` };
  };

  const isTestNumber = (ctx: Ctx, phone: string) => !!ctx.s.phone.testOtp[phone];

  const requirePhone = (ctx: Ctx, code = 'phone_provider_disabled') => {
    if (!ctx.s.phone.enabled) throw err(422, code, 'Phone sign-in is disabled for this project. Turn it on in Studio under Users > Settings.');
  };

  /** Counts one SMS against the per-IP and per-project limits (test numbers are free). */
  const takeSmsBudget = (ctx: Ctx, phone: string) => {
    if (isTestNumber(ctx, phone)) return;
    if (!smsIpLimiter.take(`${ctx.project.name}:${clientKey(ctx.req)}`) || !smsProjectLimiter.take(ctx.project.name)) {
      throw err(429, 'over_sms_send_rate_limit', 'SMS rate limit exceeded');
    }
  };

  /**
   * Stores a one-time code for a phone number and sends it by SMS. Returns
   * the provider message id. Pass `counted` when the caller already took the
   * per-IP and per-project limits (takeSmsBudget); the per-number one is
   * always checked here.
   */
  const sendPhoneCode = async (ctx: Ctx, c: pg.ClientBase, user: UserRow, otpType: OtpType, phone: string, channel?: unknown, counted = false) => {
    if (!isTestNumber(ctx, phone)) {
      if (!counted) takeSmsBudget(ctx, phone);
      if (!smsPhoneLimiter.take(`${ctx.project.name}:${phone}`)) throw err(429, 'over_sms_send_rate_limit', 'SMS rate limit exceeded');
    }
    const code = smsCode(ctx.s, phone);
    await createOtp(c, ctx.project.jwtSecret, user.id, otpType, phone, code);
    return sendSms(ctx.s, ctx.project.name, phone, code, { channel: channel === 'whatsapp' ? 'whatsapp' : 'sms', kind: otpType });
  };

  const phoneCooldown = (ctx: Ctx, phone: string, sentAt: Date | null | undefined) => {
    if (!isTestNumber(ctx, phone)) cooldown(sentAt, 'over_sms_send_rate_limit');
  };

  const maybeFlow = async (ctx: Ctx, c: pg.ClientBase, body: Record<string, any>, userId: string, authMethod: string, redirectTo: string) => {
    if (typeof body.code_challenge === 'string' && body.code_challenge) {
      await createFlowState(c, {
        userId,
        challenge: body.code_challenge,
        method: String(body.code_challenge_method || 's256'),
        provider: 'email',
        authMethod,
        redirectTo,
      });
    }
  };

  const createEmailUser = async (
    c: pg.ClientBase,
    email: string,
    opts: {
      passwordHash?: string | null;
      confirmed: boolean;
      /** The address is known to be the owner's (an admin said so), not just confirmed. */
      proven?: boolean;
      data?: Record<string, unknown>;
      invited?: boolean;
      appMeta?: Record<string, unknown>;
      role?: string;
    },
  ): Promise<UserRow> => {
    const { rows } = await c.query(
      `insert into auth.users (aud, role, email, encrypted_password, email_confirmed_at, invited_at, raw_app_meta_data, raw_user_meta_data, email_proven_at)
       values ('authenticated', $1, $2, $3, case when $4 then now() end, case when $5 then now() end, $6, $7, case when $8 then now() end) returning *`,
      [
        opts.role || 'authenticated',
        email,
        opts.passwordHash || null,
        opts.confirmed,
        !!opts.invited,
        { provider: 'email', providers: ['email'], ...(opts.appMeta || {}) },
        opts.data || {},
        !!(opts.confirmed && opts.proven),
      ],
    );
    const u = rows[0] as UserRow;
    await c.query(
      `insert into auth.identities (provider_id, user_id, identity_data, provider) values ($1, $2, $3, 'email')`,
      [u.id, u.id, { sub: u.id, email, email_verified: opts.confirmed, phone_verified: false }],
    );
    return u;
  };

  const createPhoneUser = async (
    c: pg.ClientBase,
    phone: string,
    opts: { passwordHash?: string | null; confirmed: boolean; data?: Record<string, unknown>; appMeta?: Record<string, unknown>; role?: string },
  ): Promise<UserRow> => {
    const { rows } = await c.query(
      `insert into auth.users (aud, role, phone, encrypted_password, phone_confirmed_at, raw_app_meta_data, raw_user_meta_data)
       values ('authenticated', $1, $2, $3, case when $4 then now() end, $5, $6) returning *`,
      [opts.role || 'authenticated', phone, opts.passwordHash || null, opts.confirmed, { provider: 'phone', providers: ['phone'], ...(opts.appMeta || {}) }, opts.data || {}],
    );
    const u = rows[0] as UserRow;
    await upsertPhoneIdentity(c, u.id, phone, opts.confirmed);
    return u;
  };

  const router = new Router();

  // Unauthenticated, so it says nothing about the version.
  router.get('/health', (_req, res) => sendJson(res, 200, { status: 'ok' }));

  router.get('/settings', (req, res) => {
    const ctx = ctxOf(req, res);
    sendJson(res, 200, {
      external: {
        anonymous_users: ctx.s.anonymousUsers,
        email: true,
        phone: ctx.s.phone.enabled,
        github: !!ctx.s.providers.github,
        google: !!ctx.s.providers.google,
        discord: !!ctx.s.providers.discord,
        gitlab: !!ctx.s.providers.gitlab,
        azure: !!ctx.s.providers.azure,
        ...Object.fromEntries(Object.keys(ctx.s.providers).filter((k) => k.startsWith('custom:')).map((k) => [k, true])),
      },
      disable_signup: ctx.s.disableSignup,
      mailer_autoconfirm: ctx.s.autoconfirm,
      phone_autoconfirm: ctx.s.phone.autoconfirm,
      sms_provider: ctx.s.phone.enabled ? ctx.s.phone.provider : '',
      saml_enabled: false,
    });
  });

  router.get('/.well-known/jwks.json', (_req, res) => sendJson(res, 200, { keys: [] }));

  // ---------------------------------------------------------------- signup
  /**
   * Sign-up never changes an existing account: someone signing up with an
   * address or number proves nothing about owning it. Without autoconfirm,
   * an existing account gets the same answer as a new one (obfuscatedUser),
   * and only an unconfirmed one gets a new confirmation. If the new sign-up's
   * password differs from the stored one, nobody can tell which sign-up the
   * owner made, so the stored password is dropped: confirming then signs the
   * owner in without one, and neither sign-up's password works.
   */
  router.post('/signup', async (req, res) => {
    const ctx = ctxOf(req, res);
    const body = await readJson(req);
    const data = isObject(body.data) ? body.data : {};

    if (!body.email && !body.phone && !body.password) {
      limitAnonymous(ctx);
      if (!ctx.s.anonymousUsers) throw err(422, 'anonymous_provider_disabled', 'Anonymous sign-ins are disabled');
      const out = await tx(ctx.pool, async (c) => {
        const { rows } = await c.query(
          `insert into auth.users (aud, role, is_anonymous, raw_app_meta_data, raw_user_meta_data)
           values ('authenticated', 'authenticated', true, '{}'::jsonb, $1) returning id`,
          [data],
        );
        return issueSession(ctx, c, rows[0].id, 'anonymous');
      });
      return sendJson(res, 200, out);
    }
    limitSignup(ctx);
    const started = new Date();

    /** One bcrypt either way: a hash for a new account, a comparison for an existing one. */
    const passwordCheck = async (existing: { id: string; encrypted_password: string | null } | undefined, password: string) =>
      existing
        ? { hash: null, matches: { id: existing.id, same: await comparePassword(password, existing.encrypted_password) } }
        : { hash: await hashPassword(password), matches: null };

    /** Drops the stored password when this sign-up's differs (see above). */
    const dropDisputedPassword = async (c: pg.ClientBase, existing: UserRow, matches: { id: string; same: boolean } | null) => {
      if (!existing.encrypted_password || (matches && matches.id === existing.id && matches.same)) return;
      await c.query('update auth.users set encrypted_password = null, updated_at = now() where id = $1', [existing.id]);
      log.warn('repeated sign-up with a different password for an unconfirmed account; password removed', { project: ctx.project.name, user: existing.id });
    };

    if (body.phone) {
      requirePhone(ctx);
      if (ctx.s.disableSignup) throw err(422, 'signup_disabled', 'Signups not allowed for this instance');
      const phone = normalizePhone(body.phone);
      const password = checkPassword(ctx.s, body.password);
      const autoconfirm = ctx.s.phone.autoconfirm;
      // Taken before the lookup, so a 429 means the same for every number.
      if (!autoconfirm) takeSmsBudget(ctx, phone);
      const known = (await ctx.pool.query('select id, encrypted_password from auth.users where phone = $1', [phone])).rows[0];
      const pw = await passwordCheck(known, password);
      const out = await tx(ctx.pool, async (c) => {
        const existing = (await c.query('select * from auth.users where phone = $1 for update', [phone])).rows[0] as UserRow | undefined;
        if (existing) {
          if (autoconfirm) throw err(422, 'user_already_exists', 'User already registered');
          if (!existing.phone_confirmed_at && !existing.email_confirmed_at) {
            await dropDisputedPassword(c, existing, pw.matches);
            if (isTestNumber(ctx, phone) || !coolingDown(existing.confirmation_sent_at)) {
              try {
                await sendPhoneCode(ctx, c, existing, 'phone_confirmation', phone, body.channel, true);
                await c.query('update auth.users set confirmation_sent_at = now() where id = $1', [existing.id]);
              } catch (e) {
                // Over the per-number limit: say nothing, as for any other existing account.
                if (!(e instanceof HttpError && e.status === 429)) throw e;
              }
            }
          }
          return obfuscatedUser('phone', phone, data, started);
        }
        const u = await createPhoneUser(c, phone, { passwordHash: pw.hash ?? (await hashPassword(password)), confirmed: autoconfirm, data });
        if (autoconfirm) return issueSession(ctx, c, u.id, 'password', { provider: 'phone' });
        await sendPhoneCode(ctx, c, u, 'phone_confirmation', phone, body.channel, true);
        await c.query('update auth.users set confirmation_sent_at = now() where id = $1', [u.id]);
        return fullUser(c, u.id);
      });
      log.info('signup', { project: ctx.project.name, phone: maskPhone(phone) });
      return sendJson(res, 200, out);
    }
    if (ctx.s.disableSignup) throw err(422, 'signup_disabled', 'Signups not allowed for this instance');

    const email = normalizeEmail(body.email);
    const password = checkPassword(ctx.s, body.password);
    const redirectTo = safeRedirect(ctx.s, req.query.get('redirect_to') || body.redirect_to);
    // Taken before the lookup, so a 429 means the same for every address.
    if (!ctx.s.autoconfirm) takeEmailBudget(ctx, email);
    const known = (await ctx.pool.query('select id, encrypted_password from auth.users where lower(email) = lower($1)', [email])).rows[0];
    const pw = await passwordCheck(known, password);

    const out = await tx(ctx.pool, async (c) => {
      const existing = (await c.query('select * from auth.users where lower(email) = lower($1) for update', [email])).rows[0] as UserRow | undefined;
      if (existing) {
        // A new sign-up would get a session here, so there is no hiding it.
        if (ctx.s.autoconfirm) throw err(422, 'user_already_exists', 'User already registered');
        if (!existing.email_confirmed_at && !existing.phone_confirmed_at) {
          await dropDisputedPassword(c, existing, pw.matches);
          if (!coolingDown(existing.confirmation_sent_at)) {
            await maybeFlow(ctx, c, body, existing.id, 'email/signup', redirectTo);
            await sendTokenMail(ctx, c, existing, 'confirmation', 'signup', 'confirmation', email, redirectTo, true);
            await c.query('update auth.users set confirmation_sent_at = now() where id = $1', [existing.id]);
          }
        }
        return obfuscatedUser('email', email, data, started);
      }
      const u = await createEmailUser(c, email, { passwordHash: pw.hash ?? (await hashPassword(password)), confirmed: ctx.s.autoconfirm, data });
      if (ctx.s.autoconfirm) return issueSession(ctx, c, u.id, 'password');
      await maybeFlow(ctx, c, body, u.id, 'email/signup', redirectTo);
      await sendTokenMail(ctx, c, u, 'confirmation', 'signup', 'confirmation', email, redirectTo, true);
      await c.query('update auth.users set confirmation_sent_at = now() where id = $1', [u.id]);
      return fullUser(c, u.id);
    });
    log.info('signup', { project: ctx.project.name, email: maskEmail(email) });
    sendJson(res, 200, out);
  });

  // ---------------------------------------------------------------- token
  router.post('/token', async (req, res) => {
    const ctx = ctxOf(req, res);
    const grant = req.query.get('grant_type');
    const body = await readJson(req);
    const ip = clientKey(req);
    if (!ipLimiter.take(`${ctx.project.name}:${ip}`)) throw err(429, 'over_request_rate_limit', 'Request rate limit reached');

    if (grant === 'password') {
      if (body.phone) {
        if (!ctx.s.phone.enabled) throw err(400, 'phone_provider_disabled', 'Phone logins are disabled');
        const phone = normalizePhone(body.phone);
        if (typeof body.password !== 'string' || !body.password) throw err(400, 'validation_failed', 'A password is required');
        if (!loginLimiter.take(`${ctx.project.name}:${ip}:${phone}`)) throw err(429, 'over_request_rate_limit', 'Too many sign-in attempts, try again later');
        const account = `${ctx.project.name}:phone:${phone}`;
        const counted = await startGuess(ctx, account, 'phone', phone, ip);
        let outcome: 'success' | 'failure' | 'none' = 'none';
        try {
          const out = await tx(ctx.pool, async (c) => {
            const u = await loadUserByPhone(c, phone);
            const ok = await comparePassword(body.password, u?.encrypted_password ?? null);
            outcome = u && ok ? 'success' : 'failure';
            if (!u || !ok) throw err(400, 'invalid_credentials', 'Invalid login credentials');
            if (!u.phone_confirmed_at) throw err(400, 'phone_not_confirmed', 'Phone not confirmed');
            assertCanSignIn(u);
            await upgradePasswordHash(c, u, body.password);
            return issueSession(ctx, c, u.id, 'password', { provider: 'phone' });
          });
          return sendJson(res, 200, out);
        } finally {
          if (counted) accountLimiter.end(account, outcome);
        }
      }
      const email = normalizeEmail(body.email);
      if (typeof body.password !== 'string' || !body.password) throw err(400, 'validation_failed', 'A password is required');
      if (!loginLimiter.take(`${ctx.project.name}:${ip}:${email}`)) throw err(429, 'over_request_rate_limit', 'Too many sign-in attempts, try again later');
      const account = `${ctx.project.name}:email:${email}`;
      const counted = await startGuess(ctx, account, 'email', email, ip);
      let outcome: 'success' | 'failure' | 'none' = 'none';
      try {
        const out = await tx(ctx.pool, async (c) => {
          const u = await loadUserByEmail(c, email);
          const ok = await comparePassword(body.password, u?.encrypted_password ?? null);
          outcome = u && ok ? 'success' : 'failure';
          if (!u || !ok) throw err(400, 'invalid_credentials', 'Invalid login credentials');
          if (!u.email_confirmed_at) throw err(400, 'email_not_confirmed', 'Email not confirmed');
          assertCanSignIn(u);
          await upgradePasswordHash(c, u, body.password);
          return issueSession(ctx, c, u.id, 'password');
        });
        return sendJson(res, 200, out);
      } finally {
        if (counted) accountLimiter.end(account, outcome);
      }
    }

    if (grant === 'refresh_token') {
      // A replayed token ends its session; that must stick although the request fails.
      const out = await txCommitThenThrow(ctx.pool, (c) => refreshSession(ctx, c, body.refresh_token));
      return sendJson(res, 200, out);
    }

    if (grant === 'pkce') {
      if (typeof body.auth_code !== 'string' || !body.auth_code) throw err(400, 'validation_failed', 'invalid request: both auth code and code verifier should be non-empty');
      // A code is used up by any attempt, right or wrong, so the delete must commit either way.
      const out = await txCommitThenThrow(ctx.pool, async (c) => {
        const { rows } = await c.query('select * from auth.flow_state where auth_code = $1 for update', [body.auth_code]);
        const flow = rows[0];
        if (!flow) throw err(404, 'flow_state_not_found', 'invalid flow state, no valid flow state found');
        await c.query('delete from auth.flow_state where id = $1', [flow.id]);
        if (!flow.auth_code_issued_at || Date.now() - new Date(flow.auth_code_issued_at).getTime() > FLOW_CODE_TTL_MS) {
          return err(400, 'flow_state_expired', 'invalid flow state, flow state has expired');
        }
        if (!pkceMatches(flow.code_challenge_method, flow.code_challenge, body.code_verifier)) {
          return err(403, 'bad_code_verifier', 'code challenge does not match previously saved code verifier');
        }
        const u = await loadUser(c, flow.user_id);
        if (!u) return err(404, 'user_not_found', 'User not found');
        try {
          assertCanSignIn(u);
        } catch (e) {
          if (e instanceof HttpError) return e;
          throw e;
        }
        const method = flow.provider_type === 'email' ? amrForFlow(flow.authentication_method) : 'oauth';
        return issueSession(ctx, c, u.id, method, {
          provider: flow.provider_type,
          provider_token: flow.provider_access_token || undefined,
          provider_refresh_token: flow.provider_refresh_token || undefined,
        });
      });
      return sendJson(res, 200, out);
    }

    throw err(400, 'unsupported_grant_type', 'unsupported_grant_type');
  });

  // ---------------------------------------------------------------- user
  router.get('/user', async (req, res) => {
    const ctx = ctxOf(req, res);
    const c = await ctx.pool.connect();
    try {
      const { user } = await userClaims(ctx, c);
      sendJson(res, 200, await userPayload(c, user));
    } finally {
      c.release();
    }
  });

  router.put('/user', async (req, res) => {
    const ctx = ctxOf(req, res);
    const body = await readJson(req);
    const redirectTo = safeRedirect(ctx.s, req.query.get('redirect_to'));
    claimsOf(ctx); // a valid token before spending a bcrypt hash on the request
    const passwordHash = body.password !== undefined ? await hashPassword(checkPassword(ctx.s, body.password)) : null;
    const out = await tx(ctx.pool, async (c) => {
      const { user, aal, sessionId } = await userClaims(ctx, c);
      if (passwordHash || (body.email !== undefined && body.email !== null) || body.phone) await requireAal2IfMfa(c, user, aal);
      if (isObject(body.data)) {
        await c.query(
          `update auth.users set raw_user_meta_data = jsonb_strip_nulls(raw_user_meta_data || $2::jsonb), updated_at = now() where id = $1`,
          [user.id, body.data],
        );
      }
      if (passwordHash) {
        await c.query('update auth.users set encrypted_password = $2, updated_at = now() where id = $1', [user.id, passwordHash]);
        // A new password (say after a recovery link) ends every other session; this one stays.
        await c.query('delete from auth.sessions where user_id = $1 and id is distinct from $2', [user.id, sessionId]);
      }
      if (body.email !== undefined && body.email !== null) {
        const email = normalizeEmail(body.email);
        if (email !== (user.email || '').toLowerCase()) {
          const taken = await loadUserByEmail(c, email);
          if (taken && taken.id !== user.id) throw err(422, 'email_exists', 'A user with this email address has already been registered');
          if (ctx.s.autoconfirm || !user.email) {
            if (!ctx.s.autoconfirm && !user.email) {
              // Anonymous user adding an email: confirm it first.
              cooldown(user.email_change_sent_at);
              await sendTokenMail(ctx, c, user, 'email_change', 'email_change', 'email_change', email, redirectTo);
              await c.query('update auth.users set email_change = $2, email_change_sent_at = now() where id = $1', [user.id, email]);
            } else {
              // Confirmed without a link: nobody proved the address (see emailProven).
              await c.query(
                `update auth.users set email = $2, email_confirmed_at = now(), email_proven_at = null, is_anonymous = false, updated_at = now() where id = $1`,
                [user.id, email],
              );
              await upsertEmailIdentity(c, user.id, email);
            }
          } else {
            cooldown(user.email_change_sent_at);
            await sendTokenMail(ctx, c, user, 'email_change', 'email_change', 'email_change', email, redirectTo);
            await c.query('update auth.users set email_change = $2, email_change_sent_at = now() where id = $1', [user.id, email]);
          }
        }
      }
      if (body.phone) {
        const phone = normalizePhone(body.phone);
        if (phone !== user.phone) {
          const taken = await loadUserByPhone(c, phone);
          if (taken && taken.id !== user.id) throw err(422, 'phone_exists', 'A user with this phone number has already been registered');
          if (ctx.s.phone.autoconfirm) {
            await c.query(`update auth.users set phone = $2, phone_confirmed_at = now(), is_anonymous = false, updated_at = now() where id = $1`, [user.id, phone]);
            await upsertPhoneIdentity(c, user.id, phone);
          } else {
            requirePhone(ctx);
            phoneCooldown(ctx, phone, user.phone_change_sent_at);
            await sendPhoneCode(ctx, c, user, 'phone_change', phone, body.channel);
            await c.query('update auth.users set phone_change = $2, phone_change_sent_at = now() where id = $1', [user.id, phone]);
          }
        }
      }
      return fullUser(c, user.id);
    });
    sendJson(res, 200, out);
  });

  router.post('/logout', async (req, res) => {
    const ctx = ctxOf(req, res);
    const scope = req.query.get('scope') || 'global';
    await tx(ctx.pool, async (c) => {
      const claims = claimsOf(ctx);
      if (!claims.sub) return;
      if (scope === 'local' && claims.session_id) {
        await c.query('delete from auth.sessions where id = $1', [claims.session_id]);
      } else if (scope === 'others' && claims.session_id) {
        await c.query('delete from auth.sessions where user_id = $1 and id <> $2', [claims.sub, claims.session_id]);
      } else {
        await c.query('delete from auth.sessions where user_id = $1', [claims.sub]);
      }
    });
    res.writeHead(204).end();
  });

  // ---------------------------------------------------------------- email flows
  router.post('/recover', async (req, res) => {
    const ctx = ctxOf(req, res);
    limitRecover(ctx);
    const body = await readJson(req);
    const email = normalizeEmail(body.email);
    const redirectTo = safeRedirect(ctx.s, req.query.get('redirect_to') || body.redirect_to);
    // Never reveal whether an account exists: the limits are keyed by the
    // address alone, and an account that just got an email is skipped quietly.
    takeAddressLimits(ctx, 'recover', email);
    await tx(ctx.pool, async (c) => {
      const u = await loadUserByEmail(c, email);
      if (!u || u.deleted_at || coolingDown(u.recovery_sent_at)) return;
      await maybeFlow(ctx, c, body, u.id, 'recovery', redirectTo);
      await sendTokenMail(ctx, c, u, 'recovery', 'recovery', 'recovery', email, redirectTo, true);
      await c.query('update auth.users set recovery_sent_at = now() where id = $1', [u.id]);
    });
    sendJson(res, 200, {});
  });

  router.post('/otp', async (req, res) => {
    const ctx = ctxOf(req, res);
    limitOtp(ctx);
    const body = await readJson(req);
    if (body.phone) {
      requirePhone(ctx);
      const phone = normalizePhone(body.phone);
      const createUser = body.create_user !== false;
      const messageId = await tx(ctx.pool, async (c) => {
        let u = await loadUserByPhone(c, phone);
        if (!u) {
          if (!createUser || ctx.s.disableSignup) throw err(422, 'otp_disabled', 'Signups not allowed for otp');
          u = await createPhoneUser(c, phone, { confirmed: false, data: isObject(body.data) ? body.data : {} });
        }
        assertCanSignIn(u);
        const recent = await c.query(`select created_at from auth.one_time_tokens where user_id = $1 and token_type = 'phone_otp'`, [u.id]);
        phoneCooldown(ctx, phone, recent.rows[0]?.created_at);
        return sendPhoneCode(ctx, c, u, 'phone_otp', phone, body.channel);
      });
      return sendJson(res, 200, { message_id: messageId });
    }
    const email = normalizeEmail(body.email);
    const redirectTo = safeRedirect(ctx.s, req.query.get('redirect_to') || body.redirect_to);
    const createUser = body.create_user !== false;
    await tx(ctx.pool, async (c) => {
      let u = await loadUserByEmail(c, email);
      if (!u) {
        if (!createUser || ctx.s.disableSignup) throw err(422, 'otp_disabled', 'Signups not allowed for otp');
        u = await createEmailUser(c, email, { confirmed: false, data: isObject(body.data) ? body.data : {} });
      }
      assertCanSignIn(u);
      const confirmed = !!u.email_confirmed_at;
      const recent = await c.query(`select created_at from auth.one_time_tokens where user_id = $1 and token_type = 'magiclink'`, [u.id]);
      cooldown(recent.rows[0]?.created_at);
      await maybeFlow(ctx, c, body, u.id, 'magiclink', redirectTo);
      // Always a magic-link token: verifying it confirms the address and, if
      // nobody had proven the address before, removes the password and other
      // sign-in methods set up until then (see evictUnprovenClaimants).
      await sendTokenMail(ctx, c, u, 'magiclink', 'magiclink', confirmed ? 'magiclink' : 'confirmation', email, redirectTo);
      if (!confirmed) await c.query('update auth.users set confirmation_sent_at = now() where id = $1', [u.id]);
    });
    sendJson(res, 200, {});
  });

  router.post('/resend', async (req, res) => {
    const ctx = ctxOf(req, res);
    limitResend(ctx);
    const body = await readJson(req);
    if (body.type === 'sms' || body.type === 'phone_change') {
      requirePhone(ctx);
      const phone = normalizePhone(body.phone);
      // Limits keyed by the number alone, so a 429 doesn't depend on there being
      // an account; per-account ones are skipped quietly. (message_id is still
      // null when nothing was sent, as with GoTrue.)
      if (!isTestNumber(ctx, phone)) {
        if (!addressCooldownLimiter.take(`resend:${body.type}:${ctx.project.name}:${phone}`)) {
          throw err(429, 'over_sms_send_rate_limit', `For security purposes, you can only request this once every ${EMAIL_COOLDOWN_SECONDS} seconds.`);
        }
        takeSmsBudget(ctx, phone);
      }
      const messageId = await tx(ctx.pool, async (c) => {
        let u: UserRow | undefined;
        let otpType: OtpType;
        let sentAt: Date | null | undefined;
        if (body.type === 'sms') {
          u = (await loadUserByPhone(c, phone)) ?? undefined;
          if (!u || u.phone_confirmed_at) return null;
          otpType = 'phone_confirmation';
          sentAt = u.confirmation_sent_at;
        } else {
          u = (await c.query('select * from auth.users where phone_change = $1', [phone])).rows[0] as UserRow | undefined;
          if (!u) return null;
          otpType = 'phone_change';
          sentAt = u.phone_change_sent_at;
        }
        if (!isTestNumber(ctx, phone) && coolingDown(sentAt)) return null;
        try {
          const id = await sendPhoneCode(ctx, c, u, otpType, phone, body.channel, true);
          await c.query(`update auth.users set ${otpType === 'phone_change' ? 'phone_change_sent_at' : 'confirmation_sent_at'} = now() where id = $1`, [u.id]);
          return id;
        } catch (e) {
          if (e instanceof HttpError && e.status === 429) return null; // over the per-number limit
          throw e;
        }
      });
      return sendJson(res, 200, { message_id: messageId });
    }
    if (body.type !== 'signup' && body.type !== 'email_change') {
      throw err(400, 'validation_failed', 'Missing one of these types: signup, email_change, sms, phone_change');
    }
    const email = normalizeEmail(body.email);
    const redirectTo = safeRedirect(ctx.s, req.query.get('redirect_to') || body.options?.emailRedirectTo);
    // As for /recover: the same answer whether or not there is anything to resend.
    takeAddressLimits(ctx, `resend:${body.type}`, email);
    await tx(ctx.pool, async (c) => {
      const u = await loadUserByEmail(c, email);
      if (body.type === 'signup') {
        if (!u || u.email_confirmed_at || coolingDown(u.confirmation_sent_at)) return;
        await sendTokenMail(ctx, c, u, 'confirmation', 'signup', 'confirmation', email, redirectTo, true);
        await c.query('update auth.users set confirmation_sent_at = now() where id = $1', [u.id]);
      } else {
        if (!u || !u.email_change || coolingDown(u.email_change_sent_at)) return;
        if (!emailLimiter.take(`${ctx.project.name}:${u.email_change}`)) return; // the new address has had enough
        await sendTokenMail(ctx, c, u, 'email_change', 'email_change', 'email_change', u.email_change, redirectTo, true);
        await c.query('update auth.users set email_change_sent_at = now() where id = $1', [u.id]);
      }
    });
    sendJson(res, 200, { message_id: null });
  });

  const tokenHashFrom = (ctx: Ctx, body: Record<string, any>): string => {
    const smsType = body.type === 'sms' || body.type === 'phone_change';
    if (smsType) {
      // SMS codes are only ever checked as phone + code, under the per-number limit.
      if (typeof body.token !== 'string' || !body.token || !body.phone) throw err(400, 'validation_failed', 'Verify requires a phone number and the code');
      const phone = normalizePhone(body.phone);
      if (!codeLimiter.take(`${ctx.project.name}:${phone}`)) throw err(429, 'over_request_rate_limit', 'Too many attempts for this phone number. Request a new code later.');
      return otpHash(ctx.project.jwtSecret, phone, body.token.trim());
    }
    if (typeof body.token_hash === 'string' && body.token_hash) return body.token_hash;
    if (typeof body.token === 'string' && body.token) {
      if (body.email) {
        const email = normalizeEmail(body.email);
        if (!codeLimiter.take(`${ctx.project.name}:${email}`)) throw err(429, 'over_request_rate_limit', 'Too many attempts for this email address. Request a new code later.');
        return otpHash(ctx.project.jwtSecret, email, body.token.trim());
      }
      return body.token;
    }
    throw err(400, 'validation_failed', 'Verify requires a token or a token hash');
  };

  router.post('/verify', async (req, res) => {
    const ctx = ctxOf(req, res);
    if (!verifyLimiter.take(`${ctx.project.name}:${clientKey(req)}`)) throw err(429, 'over_request_rate_limit', 'Too many verification attempts');
    const body = await readJson(req);
    const type = String(body.type || '');
    const hash = tokenHashFrom(ctx, body);
    const out = await tx(ctx.pool, async (c) => {
      const row = await consumeOtp(c, type, hash, ctx.s.otpExpSeconds, ctx.s.phone.otpExpSeconds);
      const method = await applyVerification(c, row, ctx.project.name);
      const u = await loadUser(c, row.user_id);
      if (!u) throw err(404, 'user_not_found', 'User not found');
      assertCanSignIn(u);
      if (row.token_type === 'email_change' && u.is_anonymous) {
        await c.query('update auth.users set is_anonymous = false where id = $1', [u.id]);
        await upsertEmailIdentity(c, u.id, row.relates_to);
      }
      if (row.token_type === 'phone_change' && u.is_anonymous) await c.query('update auth.users set is_anonymous = false where id = $1', [u.id]);
      const phoneFlow = row.token_type === 'phone_confirmation' || row.token_type === 'phone_otp' || row.token_type === 'phone_change';
      return issueSession(ctx, c, u.id, method, phoneFlow ? { provider: 'phone' } : {});
    });
    sendJson(res, 200, out);
  });

  router.get('/verify', async (req, res) => {
    const ctx = ctxOf(req, res);
    const type = req.query.get('type') || '';
    const token = req.query.get('token') || '';
    const target = safeRedirect(ctx.s, req.query.get('redirect_to'));
    const fail = (code: string, description: string) => {
      const q = new URLSearchParams({ error: 'access_denied', error_code: code, error_description: description });
      if (target) return redirect(res, `${target}#${q}`);
      return page(res, 400, 'Link expired', `${description}. Request a new link and try again.`);
    };
    if (!verifyLimiter.take(`${ctx.project.name}:${clientKey(req)}`)) return fail('over_request_rate_limit', 'Too many verification attempts');
    // Links are for email flows; SMS codes are verified with POST /verify.
    if (type === 'sms' || type === 'phone_change') return fail('validation_failed', 'Phone codes cannot be verified with a link');
    let location: string | null = null;
    try {
      location = await tx(ctx.pool, async (c) => {
        const row = await consumeOtp(c, type, token, ctx.s.otpExpSeconds);
        const method = await applyVerification(c, row, ctx.project.name);
        const u = await loadUser(c, row.user_id);
        if (!u) throw err(404, 'user_not_found', 'User not found');
        assertCanSignIn(u);
        if (row.token_type === 'email_change' && u.is_anonymous) {
          await c.query('update auth.users set is_anonymous = false where id = $1', [u.id]);
          await upsertEmailIdentity(c, u.id, row.relates_to);
        }
        if (!target) return null;
        const flowMethod = ({ confirmation: 'email/signup', invite: 'invite', magiclink: 'magiclink', recovery: 'recovery', email_change: 'email_change' } as Record<string, string>)[row.token_type];
        const flow = await c.query(
          `select id from auth.flow_state where user_id = $1 and authentication_method = $2 and auth_code is null
             and created_at > now() - interval '1 hour' order by created_at desc limit 1`,
          [u.id, flowMethod],
        );
        if (flow.rows[0]) {
          const code = await issueAuthCode(c, flow.rows[0].id, u.id);
          return `${target}${target.includes('?') ? '&' : '?'}code=${encodeURIComponent(code)}`;
        }
        const session = await issueSession(ctx, c, u.id, method);
        return `${target}#${sessionFragment(session as Record<string, unknown>, type)}`;
      });
    } catch (e) {
      if (e instanceof HttpError && e.status < 500) return fail(e.code || 'otp_expired', 'Email link is invalid or has expired');
      throw e;
    }
    if (location) return redirect(res, location, 303);
    const msg = type === 'recovery'
      ? 'Your link worked, but this project has no Site URL to send you to. Set one in Keel Studio under Users > Settings.'
      : 'Your email address is confirmed. You can close this tab and sign in.';
    page(res, 200, type === 'recovery' ? 'Almost there' : 'Email confirmed', msg);
  });

  router.post('/invite', async (req, res) => {
    const ctx = ctxOf(req, res);
    requireAdmin(ctx);
    const body = await readJson(req);
    const email = normalizeEmail(body.email);
    const redirectTo = safeRedirect(ctx.s, req.query.get('redirect_to') || body.redirect_to);
    const out = await tx(ctx.pool, async (c) => {
      let u = await loadUserByEmail(c, email);
      if (u && u.email_confirmed_at) throw err(422, 'email_exists', 'A user with this email address has already been registered');
      if (!u) u = await createEmailUser(c, email, { confirmed: false, invited: true, data: isObject(body.data) ? body.data : {} });
      else await c.query('update auth.users set invited_at = now() where id = $1', [u.id]);
      await sendTokenMail(ctx, c, u, 'invite', 'invite', 'invite', email, redirectTo);
      await c.query('update auth.users set confirmation_sent_at = now() where id = $1', [u.id]);
      return fullUser(c, u.id);
    });
    sendJson(res, 200, out);
  });

  // ---------------------------------------------------------------- OAuth
  /**
   * The browser that starts a sign-in gets a short-lived cookie with a random
   * nonce that is also in the signed state. The callback only accepts the
   * state together with that cookie, once, so nobody can finish their own
   * sign-in in someone else's browser (login CSRF) or replay a callback URL.
   */
  const oauthCookie = (ctx: Ctx, value: string, maxAge: number) =>
    `keel-oauth-${ctx.project.name}=${value}; Path=/; Max-Age=${maxAge}; HttpOnly; SameSite=Lax${/^https:/i.test(config.publicUrl) ? '; Secure' : ''}`;

  const readCookie = (req: Req, name: string): string | null => {
    for (const part of String(req.headers.cookie || '').split(';')) {
      const i = part.indexOf('=');
      if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
    }
    return null;
  };

  /**
   * What Keel sends the provider for one sign-in. The OIDC nonce and the PKCE
   * verifier are derived from the state's own nonce with a key only Keel
   * has, so the callback can check them without storing anything, and
   * someone who sees the callback URL still can't compute the verifier.
   */
  const providerFlow = (ctx: Ctx, p: ResolvedProvider, state: string, stateNonce: string, scopes: string): Flow => {
    const key = oauthFlowKey(ctx.project.jwtSecret);
    const derive = (label: string) => crypto.createHmac('sha256', key).update(`${label}:${ctx.project.name}:${stateNonce}`).digest('base64url');
    const codeVerifier = derive('pkce');
    return {
      clientId: p.clientId,
      secret: p.secret,
      redirectUri: `${ctx.s.apiUrl}/callback`,
      state,
      scopes,
      nonce: derive('nonce'),
      codeVerifier,
      codeChallenge: crypto.createHash('sha256').update(codeVerifier).digest('base64url'),
    };
  };

  /** Marks an OAuth state as used. False if it was used before. */
  const useOauthState = (ctx: Ctx, nonce: string, exp: number): boolean => {
    const now = Date.now();
    for (const [k, until] of usedOauthStates) if (until < now) usedOauthStates.delete(k);
    const key = `${ctx.project.name}:${nonce}`;
    if (usedOauthStates.has(key)) return false;
    usedOauthStates.set(key, exp * 1000);
    return true;
  };

  router.get('/authorize', async (req, res) => {
    const ctx = ctxOf(req, res);
    limitAuthorize(ctx);
    const provider = req.query.get('provider') || '';
    const p = providerConfig(ctx.s, provider, ctx.project.jwtSecret);
    const redirectTo = safeRedirect(ctx.s, req.query.get('redirect_to'));
    let flowId: string | null = null;
    const challenge = req.query.get('code_challenge');
    if (challenge) {
      flowId = await tx(ctx.pool, (c) =>
        createFlowState(c, { challenge, method: req.query.get('code_challenge_method') || 's256', provider, authMethod: 'oauth', redirectTo }),
      );
    }
    const now = Math.floor(Date.now() / 1000);
    const nonce = crypto.randomBytes(24).toString('base64url');
    const state = sign(
      { kind: 'oauth_state', provider, redirect_to: redirectTo, flow_id: flowId, nonce, iat: now, exp: now + OAUTH_STATE_TTL_S, ref: ctx.project.name },
      signingKey(ctx.project),
    );
    const scopes = (req.query.get('scopes') || '').slice(0, 1000);
    const location = await p.impl.authorizeUrl(p.settings, providerFlow(ctx, p, state, nonce, scopes));
    res.setHeader('Set-Cookie', oauthCookie(ctx, nonce, OAUTH_STATE_TTL_S));
    redirect(res, location, 302);
  });

  router.get('/callback', async (req, res) => {
    const ctx = ctxOf(req, res);
    let state: Claims;
    try {
      state = verify(req.query.get('state') || '', ctx.project.jwtKeys);
      if (state.kind !== 'oauth_state' || state.ref !== ctx.project.name || typeof state.nonce !== 'string' || typeof state.exp !== 'number') {
        throw new Error('bad state');
      }
    } catch {
      return page(res, 400, 'Sign-in failed', 'The sign-in request is invalid or has expired. Please start again.');
    }
    const nonce = state.nonce as string;
    const cookie = readCookie(req, `keel-oauth-${ctx.project.name}`) || '';
    // A missing or different cookie: this browser didn't start this sign-in.
    // Leave its cookie alone, it may belong to a sign-in it did start.
    if (cookie.length !== nonce.length || !crypto.timingSafeEqual(Buffer.from(cookie), Buffer.from(nonce))) {
      return page(res, 400, 'Sign-in failed', 'This sign-in was started in a different browser, or has expired. Please start again.');
    }
    res.setHeader('Set-Cookie', oauthCookie(ctx, '', 0));
    if (!useOauthState(ctx, nonce, state.exp as number)) {
      return page(res, 400, 'Sign-in failed', 'The sign-in request is invalid or has expired. Please start again.');
    }
    const target = String(state.redirect_to || '');
    const fail = (description: string, code = 'server_error') => {
      const q = new URLSearchParams({ error: code, error_code: code, error_description: description });
      if (target) return redirect(res, `${target}#${q}`, 302);
      return page(res, 400, 'Sign-in failed', description);
    };
    if (req.query.get('error')) return fail(req.query.get('error_description') || req.query.get('error') || 'Provider error', 'access_denied');

    const provider = String(state.provider);
    let location: string | null = null;
    try {
      const p = providerConfig(ctx.s, provider, ctx.project.jwtSecret);
      const code = req.query.get('code') || '';
      if (!code) throw err(400, 'bad_oauth_callback', 'The provider sent no authorization code');
      const { tokens, user: pu } = await p.impl.complete(p.settings, providerFlow(ctx, p, req.query.get('state') || '', nonce, ''), code);
      location = await tx(ctx.pool, async (c) => {
        let user: UserRow | null = null;
        const ident = await c.query('select user_id from auth.identities where provider = $1 and provider_id = $2', [provider, pu.id]);
        if (ident.rows[0]) {
          user = await loadUser(c, ident.rows[0].user_id);
          await c.query(
            'update auth.identities set identity_data = $3, updated_at = now() where provider = $1 and provider_id = $2',
            [provider, pu.id, pu.raw],
          );
        } else {
          if (pu.email && pu.emailVerified) user = await loadUserByEmail(c, pu.email);
          if (!user) {
            if (ctx.s.disableSignup) throw err(422, 'signup_disabled', 'Signups not allowed for this instance');
            if (pu.email) {
              const clash = await loadUserByEmail(c, pu.email);
              if (clash) throw err(422, 'email_exists', 'An account with this email already exists. Sign in with your password first.');
            }
            const email = newAccountEmail(pu, ctx.s.autoconfirm);
            const { rows } = await c.query(
              `insert into auth.users (aud, role, email, email_confirmed_at, email_proven_at, raw_app_meta_data, raw_user_meta_data)
               values ('authenticated', 'authenticated', $1, case when $2 then now() end, case when $2 then now() end, $3, $4) returning *`,
              [email, !!email && pu.emailVerified, { provider, providers: [provider] }, pu.raw],
            );
            user = rows[0] as UserRow;
          } else {
            // The provider just proved the address. If nobody had before (it
            // was auto-confirmed, or never confirmed), whoever registered it
            // may not be its owner: take away what they could sign in with.
            if (!(await emailProven(c, user))) await evictUnprovenClaimants(c, user, `${provider} sign-in`, ctx.project.name);
            await c.query(
              `update auth.users set raw_app_meta_data = jsonb_set(raw_app_meta_data, '{providers}',
                 (select to_jsonb(array(select distinct jsonb_array_elements_text(coalesce(raw_app_meta_data->'providers', '[]'::jsonb) || to_jsonb($2::text)))))),
                 email_confirmed_at = coalesce(email_confirmed_at, now()), email_proven_at = coalesce(email_proven_at, now()), updated_at = now() where id = $1`,
              [user.id, provider],
            );
            await c.query(
              `update auth.identities set identity_data = identity_data || '{"email_verified": true}'::jsonb where user_id = $1 and provider = 'email'`,
              [user.id],
            );
          }
          await c.query(
            `insert into auth.identities (provider_id, user_id, identity_data, provider, last_sign_in_at) values ($1, $2, $3, $4, now())`,
            [pu.id, user!.id, pu.raw, provider],
          );
        }
        if (!user) throw err(500, 'unexpected_failure', 'User lookup failed');
        assertCanSignIn(user);
        if (state.flow_id) {
          const code = await issueAuthCode(c, String(state.flow_id), user.id, tokens);
          return target ? `${target}${target.includes('?') ? '&' : '?'}code=${encodeURIComponent(code)}` : null;
        }
        const session = await issueSession(ctx, c, user.id, 'oauth', { provider, provider_token: tokens.access, provider_refresh_token: tokens.refresh });
        return target ? `${target}#${sessionFragment(session as Record<string, unknown>)}` : null;
      });
    } catch (e) {
      log.warn('oauth callback failed', { project: ctx.project.name, provider, error: (e as Error).message });
      return fail(e instanceof HttpError ? e.message : 'Unable to complete sign-in with the provider');
    }
    if (location) return redirect(res, location, 302);
    page(res, 200, 'Signed in', 'Sign-in worked, but this project has no Site URL to return you to. Set one in Keel Studio under Users > Settings.');
  });

  // ---------------------------------------------------------------- admin
  router.get('/admin/users', async (req, res) => {
    const ctx = ctxOf(req, res);
    requireAdmin(ctx);
    const page = Math.max(1, Number(req.query.get('page')) || 1);
    const perPage = Math.min(1000, Math.max(1, Number(req.query.get('per_page')) || 50));
    const c = await ctx.pool.connect();
    try {
      const total = Number((await c.query('select count(*) from auth.users')).rows[0].count);
      const { rows } = await c.query('select * from auth.users order by created_at desc limit $1 offset $2', [perPage, (page - 1) * perPage]);
      const ids = rows.map((r) => r.id);
      const idents = ids.length ? (await c.query('select * from auth.identities where user_id = any($1)', [ids])).rows : [];
      const factors = ids.length ? ((await c.query('select * from auth.mfa_factors where user_id = any($1) order by created_at', [ids])).rows as FactorRow[]) : [];
      const users = rows.map((u) => userJson(u as UserRow, idents.filter((i) => i.user_id === u.id), true, factors.filter((f) => f.user_id === u.id)));
      // auth-js reads the total only when a Link header is present (as GoTrue sends it).
      const last = Math.max(1, Math.ceil(total / perPage));
      const link = (n: number, rel: string) => `</auth/v1/admin/users?page=${n}&per_page=${perPage}>; rel="${rel}"`;
      const links = [...(page < last ? [link(page + 1, 'next')] : []), link(last, 'last')].join(', ');
      sendJson(res, 200, { users, aud: 'authenticated' }, { 'X-Total-Count': String(total), Link: links });
    } finally {
      c.release();
    }
  });

  router.post('/admin/users', async (req, res) => {
    const ctx = ctxOf(req, res);
    requireAdmin(ctx);
    const body = await readJson(req);
    const email = body.email || !body.phone ? normalizeEmail(body.email) : null;
    const phone = body.phone ? normalizePhone(body.phone) : null;
    const passwordHash = body.password ? await hashPassword(checkPassword(ctx.s, body.password)) : null;
    const out = await tx(ctx.pool, async (c) => {
      if (email && (await loadUserByEmail(c, email))) throw err(422, 'email_exists', 'A user with this email address has already been registered');
      if (phone && (await loadUserByPhone(c, phone))) throw err(422, 'phone_exists', 'A user with this phone number has already been registered');
      const common = {
        passwordHash,
        data: isObject(body.user_metadata) ? body.user_metadata : {},
        appMeta: isObject(body.app_metadata) ? body.app_metadata : {},
        role: typeof body.role === 'string' ? body.role : undefined,
      };
      let u: UserRow;
      if (email) {
        u = await createEmailUser(c, email, { ...common, confirmed: !!body.email_confirm, proven: !!body.email_confirm });
        if (phone) {
          await c.query('update auth.users set phone = $2, phone_confirmed_at = case when $3 then now() end where id = $1', [u.id, phone, !!body.phone_confirm]);
          await upsertPhoneIdentity(c, u.id, phone, !!body.phone_confirm);
        }
      } else {
        u = await createPhoneUser(c, phone!, { ...common, confirmed: !!body.phone_confirm });
      }
      if (body.ban_duration) await applyBan(c, u.id, String(body.ban_duration));
      return fullUser(c, u.id, true);
    });
    sendJson(res, 200, out);
  });

  router.get('/admin/users/:id', async (req, res) => {
    const ctx = ctxOf(req, res);
    requireAdmin(ctx);
    const c = await ctx.pool.connect();
    try {
      sendJson(res, 200, await fullUser(c, uuidParam(req.params.id), true));
    } finally {
      c.release();
    }
  });

  router.get('/admin/users/:id/factors', async (req, res) => {
    const ctx = ctxOf(req, res);
    requireAdmin(ctx);
    const c = await ctx.pool.connect();
    try {
      sendJson(res, 200, (await loadFactors(c, uuidParam(req.params.id))).map(factorJson));
    } finally {
      c.release();
    }
  });

  router.put('/admin/users/:id/factors/:factor', async (req, res) => {
    const ctx = ctxOf(req, res);
    requireAdmin(ctx);
    const body = await readJson(req);
    const out = await tx(ctx.pool, async (c) => {
      const { rows } = await c.query(
        `update auth.mfa_factors set friendly_name = coalesce($3, friendly_name), updated_at = now() where id = $1 and user_id = $2 returning *`,
        [factorParam(req.params.factor), uuidParam(req.params.id), typeof body.friendly_name === 'string' ? body.friendly_name.trim() : null],
      );
      if (!rows[0]) throw err(404, 'mfa_factor_not_found', 'Factor not found');
      return factorJson(rows[0] as FactorRow);
    });
    sendJson(res, 200, out);
  });

  router.delete('/admin/users/:id/factors/:factor', async (req, res) => {
    const ctx = ctxOf(req, res);
    requireAdmin(ctx);
    const out = await tx(ctx.pool, async (c) => {
      const userId = uuidParam(req.params.id);
      const { rows } = await c.query('delete from auth.mfa_factors where id = $1 and user_id = $2 returning *', [factorParam(req.params.factor), userId]);
      if (!rows[0]) throw err(404, 'mfa_factor_not_found', 'Factor not found');
      await downgradeIfNoFactors(c, userId);
      return factorJson(rows[0] as FactorRow);
    });
    sendJson(res, 200, out);
  });

  // ---------------------------------------------------------------- MFA
  router.post('/factors', async (req, res) => {
    const ctx = ctxOf(req, res);
    const body = await readJson(req);
    const out = await tx(ctx.pool, async (c) => {
      const { user, aal, sessionId } = await userClaims(ctx, c);
      if (!sessionId) throw err(403, 'session_not_found', 'A signed-in session is required to enroll a factor');
      const type = body.factor_type;
      if (type !== 'totp' && type !== 'phone') throw err(400, 'validation_failed', 'factor_type needs to be totp or phone');
      if (type === 'totp' && !ctx.s.mfa.totp) throw err(422, 'mfa_totp_enroll_not_enabled', 'MFA enroll is disabled for TOTP');
      if (type === 'phone' && !ctx.s.mfa.phone) throw err(422, 'mfa_phone_enroll_not_enabled', 'MFA enroll is disabled for Phone');
      // Abandoned enrollments don't count against the limit forever.
      await c.query(`delete from auth.mfa_factors where user_id = $1 and status = 'unverified' and created_at < now() - interval '1 day'`, [user.id]);
      const factors = await loadFactors(c, user.id);
      if (factors.some((f) => f.status === 'verified') && aal !== 'aal2') throw err(422, 'insufficient_aal', 'AAL2 required to enroll a new factor');
      if (factors.length >= ctx.s.mfa.maxFactors) throw err(422, 'too_many_enrolled_mfa_factors', 'Maximum number of verified factors reached, unenroll to continue');
      const friendly = typeof body.friendly_name === 'string' ? body.friendly_name.trim().slice(0, 100) : '';
      if (friendly && factors.some((f) => f.friendly_name === friendly)) {
        throw err(422, 'mfa_factor_name_conflict', `A factor with the friendly name "${friendly}" for this user already exists`);
      }
      if (type === 'totp') {
        const secret = newSecret();
        const issuer = (typeof body.issuer === 'string' && body.issuer.trim()) || hostOf(ctx.s.siteUrl) || ctx.project.name;
        const uri = otpauthUri(secret, issuer, user.email || (user.phone ? `+${user.phone}` : user.id));
        const { rows } = await c.query(
          `insert into auth.mfa_factors (user_id, friendly_name, factor_type, secret) values ($1, $2, 'totp', $3) returning id`,
          [user.id, friendly, sealSecret(secret, totpKey(ctx.project.jwtSecret))],
        );
        return { id: rows[0].id, type: 'totp', friendly_name: friendly, totp: { qr_code: qrSvg(uri), secret, uri } };
      }
      const phone = normalizePhone(body.phone);
      if (factors.some((f) => f.factor_type === 'phone' && f.phone === phone)) {
        throw err(422, 'phone_factor_already_exists', 'A phone factor with this number already exists for this user');
      }
      const { rows } = await c.query(
        `insert into auth.mfa_factors (user_id, friendly_name, factor_type, phone) values ($1, $2, 'phone', $3) returning id`,
        [user.id, friendly, phone],
      );
      return { id: rows[0].id, type: 'phone', friendly_name: friendly, phone };
    });
    sendJson(res, 200, out);
  });

  const ownFactor = async (c: pg.ClientBase, userId: string, id: string): Promise<FactorRow> => {
    const { rows } = await c.query('select * from auth.mfa_factors where id = $1 and user_id = $2 for update', [factorParam(id), userId]);
    if (!rows[0]) throw err(404, 'mfa_factor_not_found', 'Factor not found');
    return rows[0] as FactorRow;
  };

  router.post('/factors/:id/challenge', async (req, res) => {
    const ctx = ctxOf(req, res);
    const body = await readJson(req);
    const out = await tx(ctx.pool, async (c) => {
      const { user } = await userClaims(ctx, c);
      const f = await ownFactor(c, user.id, req.params.id);
      let challengeHash: string | null = null;
      const { rows } = await c.query(`select gen_random_uuid() as id`);
      const challengeId = rows[0].id as string;
      if (f.factor_type === 'phone') {
        if (!ctx.s.mfa.phone) throw err(422, 'mfa_phone_verify_not_enabled', 'MFA verification is disabled for Phone');
        if (f.last_challenged_at && Date.now() - new Date(f.last_challenged_at).getTime() < 15_000 && !isTestNumber(ctx, f.phone!)) {
          throw err(429, 'over_sms_send_rate_limit', 'For security purposes, you can only request a new code every 15 seconds');
        }
        if (!isTestNumber(ctx, f.phone!) && (!smsPhoneLimiter.take(`${ctx.project.name}:${f.phone}`) || !smsProjectLimiter.take(ctx.project.name))) {
          throw err(429, 'over_sms_send_rate_limit', 'SMS rate limit exceeded');
        }
        const code = smsCode(ctx.s, f.phone!);
        challengeHash = sha256(challengeId + code);
        await sendSms(ctx.s, ctx.project.name, f.phone!, code, { channel: body.channel === 'whatsapp' ? 'whatsapp' : 'sms', kind: 'mfa' });
      } else if (!ctx.s.mfa.totp) {
        throw err(422, 'mfa_totp_verify_not_enabled', 'MFA verification is disabled for TOTP');
      }
      const ip = clientIp(req);
      await c.query(`insert into auth.mfa_challenges (id, factor_id, ip_address, otp_code) values ($1, $2, $3, $4)`, [
        challengeId,
        f.id,
        /^[0-9a-f.:]+$/i.test(ip) ? ip : null,
        challengeHash,
      ]);
      await c.query('update auth.mfa_factors set last_challenged_at = now() where id = $1', [f.id]);
      await c.query(`delete from auth.mfa_challenges where factor_id = $1 and created_at < now() - interval '1 day'`, [f.id]);
      return { id: challengeId, type: f.factor_type, expires_at: Math.floor(Date.now() / 1000) + MFA_CHALLENGE_TTL_S };
    });
    sendJson(res, 200, out);
  });

  router.post('/factors/:id/verify', async (req, res) => {
    const ctx = ctxOf(req, res);
    const body = await readJson(req);
    const code = typeof body.code === 'string' ? body.code.trim() : '';
    const out = await tx(ctx.pool, async (c) => {
      const { user, sessionId, aal } = await userClaims(ctx, c);
      if (!sessionId) throw err(403, 'session_not_found', 'A signed-in session is required');
      // Per user, not per spelling of the factor id.
      if (!mfaLimiter.take(`${ctx.project.name}:${user.id}`)) throw err(429, 'over_request_rate_limit', 'Too many verification attempts, try again in a few minutes');
      const f = await ownFactor(c, user.id, req.params.id);
      if (f.status === 'unverified' && aal !== 'aal2') {
        // A factor added (perhaps by someone else) but never finished must not
        // become a way past MFA once the user has a working factor.
        const { rowCount } = await c.query(`select 1 from auth.mfa_factors where user_id = $1 and status = 'verified'`, [user.id]);
        if (rowCount) throw err(422, 'insufficient_aal', 'AAL2 required to verify a new factor');
      }
      const challengeId = typeof body.challenge_id === 'string' && /^[0-9a-f-]{36}$/i.test(body.challenge_id) ? body.challenge_id : null;
      const { rows } = challengeId
        ? await c.query('select * from auth.mfa_challenges where id = $1 and factor_id = $2 for update', [challengeId, f.id])
        : { rows: [] };
      const ch = rows[0];
      if (!ch) throw err(404, 'mfa_challenge_not_found', 'MFA factor with the provided challenge ID not found');
      if (ch.verified_at || Date.now() - new Date(ch.created_at).getTime() > MFA_CHALLENGE_TTL_S * 1000) {
        await c.query('delete from auth.mfa_challenges where id = $1', [ch.id]);
        throw err(422, 'mfa_challenge_expired', `MFA challenge ${ch.id} has expired, verify against another challenge or create a new challenge.`);
      }
      let step: number | null = null;
      if (f.factor_type === 'totp') {
        let secret: string;
        try {
          secret = openSecret(f.secret || '', totpKey(ctx.project.jwtSecret));
        } catch {
          log.error('a TOTP factor could not be decrypted (was the project secret changed?)', { project: ctx.project.name, factor: f.id });
          throw err(500, 'unexpected_failure', 'This factor can no longer be verified. Remove it and enroll again.');
        }
        step = verifyTotp(secret, code);
        if (step === null || (f.last_totp_step !== null && step <= Number(f.last_totp_step))) {
          throw err(422, 'mfa_verification_failed', 'Invalid TOTP code entered');
        }
      } else {
        const want = Buffer.from(ch.otp_code || '');
        const got = Buffer.from(sha256(ch.id + code));
        if (!code || want.length !== got.length || !crypto.timingSafeEqual(want, got)) throw err(422, 'mfa_verification_failed', 'Invalid MFA Phone code entered');
      }
      await c.query('update auth.mfa_challenges set verified_at = now() where id = $1', [ch.id]);
      await c.query(
        `update auth.mfa_factors set status = 'verified', last_totp_step = coalesce($2, last_totp_step), updated_at = now() where id = $1`,
        [f.id, step],
      );
      // Like GoTrue: other unfinished enrollments go once a factor works.
      await c.query(`delete from auth.mfa_factors where user_id = $1 and status = 'unverified' and id <> $2`, [user.id, f.id]);
      await c.query(
        `update auth.sessions set aal = 'aal2', amr = amr || $2::jsonb, updated_at = now() where id = $1`,
        [sessionId, JSON.stringify([{ method: f.factor_type === 'totp' ? 'totp' : 'mfa/phone', timestamp: Math.floor(Date.now() / 1000) }])],
      );
      return reissueSession(ctx, c, user.id, sessionId);
    });
    sendJson(res, 200, out);
  });

  router.delete('/factors/:id', async (req, res) => {
    const ctx = ctxOf(req, res);
    const out = await tx(ctx.pool, async (c) => {
      const { user, aal } = await userClaims(ctx, c);
      const f = await ownFactor(c, user.id, req.params.id);
      if (f.status === 'verified' && aal !== 'aal2') throw err(422, 'insufficient_aal', 'AAL2 required to unenroll verified factor');
      await c.query('delete from auth.mfa_factors where id = $1', [f.id]);
      await downgradeIfNoFactors(c, user.id);
      return { id: f.id };
    });
    sendJson(res, 200, out);
  });

  router.put('/admin/users/:id', async (req, res) => {
    const ctx = ctxOf(req, res);
    requireAdmin(ctx);
    const id = uuidParam(req.params.id);
    const body = await readJson(req);
    const passwordHash = body.password ? await hashPassword(checkPassword(ctx.s, body.password)) : null;
    const out = await tx(ctx.pool, async (c) => {
      const u = await loadUser(c, id);
      if (!u) throw err(404, 'user_not_found', 'User not found');
      if (body.email !== undefined && body.email !== null) {
        const email = normalizeEmail(body.email);
        const other = await loadUserByEmail(c, email);
        if (other && other.id !== id) throw err(422, 'email_exists', 'A user with this email address has already been registered');
        // A different address is only proven if the admin says so (email_confirm, below).
        await c.query(
          `update auth.users set email = $2::text, email_proven_at = case when lower(email) is not distinct from $2::text then email_proven_at end, updated_at = now() where id = $1`,
          [id, email],
        );
        await upsertEmailIdentity(c, id, email);
      }
      if (body.phone !== undefined && body.phone !== null) {
        if (body.phone === '') {
          await c.query(`update auth.users set phone = null, phone_confirmed_at = null, updated_at = now() where id = $1`, [id]);
          await c.query(`delete from auth.identities where user_id = $1 and provider = 'phone'`, [id]);
        } else {
          const phone = normalizePhone(body.phone);
          const other = await loadUserByPhone(c, phone);
          if (other && other.id !== id) throw err(422, 'phone_exists', 'A user with this phone number has already been registered');
          if (phone !== u.phone) {
            await c.query('update auth.users set phone = $2, phone_confirmed_at = null, updated_at = now() where id = $1', [id, phone]);
            await upsertPhoneIdentity(c, id, phone, false);
          }
        }
      }
      if (body.phone_confirm === true) {
        await c.query('update auth.users set phone_confirmed_at = coalesce(phone_confirmed_at, now()) where id = $1 and phone is not null', [id]);
        await c.query(`update auth.identities set identity_data = identity_data || '{"phone_verified": true}'::jsonb where user_id = $1 and provider = 'phone'`, [id]);
      }
      if (passwordHash) {
        await c.query('update auth.users set encrypted_password = $2, updated_at = now() where id = $1', [id, passwordHash]);
        // Whoever was signed in with the old password isn't any more.
        await c.query('delete from auth.sessions where user_id = $1', [id]);
      }
      if (body.email_confirm === true) {
        await c.query(
          `update auth.users set email_confirmed_at = coalesce(email_confirmed_at, now()),
                  email_proven_at = case when email is not null then coalesce(email_proven_at, now()) end where id = $1`,
          [id],
        );
      }
      if (isObject(body.user_metadata)) {
        await c.query('update auth.users set raw_user_meta_data = jsonb_strip_nulls(raw_user_meta_data || $2::jsonb), updated_at = now() where id = $1', [id, body.user_metadata]);
      }
      if (isObject(body.app_metadata)) {
        await c.query('update auth.users set raw_app_meta_data = jsonb_strip_nulls(raw_app_meta_data || $2::jsonb), updated_at = now() where id = $1', [id, body.app_metadata]);
      }
      if (typeof body.role === 'string' && body.role) await c.query('update auth.users set role = $2 where id = $1', [id, body.role]);
      if (body.ban_duration) await applyBan(c, id, String(body.ban_duration));
      return fullUser(c, id, true);
    });
    sendJson(res, 200, out);
  });

  router.delete('/admin/users/:id', async (req, res) => {
    const ctx = ctxOf(req, res);
    requireAdmin(ctx);
    const id = uuidParam(req.params.id);
    const body = await readJson(req);
    await tx(ctx.pool, async (c) => {
      const u = await loadUser(c, id);
      if (!u) throw err(404, 'user_not_found', 'User not found');
      if (body.should_soft_delete) {
        await c.query(
          `update auth.users set deleted_at = now(), email = null, phone = null, encrypted_password = null,
                  raw_user_meta_data = '{}'::jsonb, updated_at = now() where id = $1`,
          [id],
        );
        await c.query('delete from auth.sessions where user_id = $1', [id]);
        await c.query('delete from auth.identities where user_id = $1', [id]);
      } else {
        await c.query('delete from auth.users where id = $1', [id]);
      }
    });
    sendJson(res, 200, {});
  });

  router.post('/admin/generate_link', async (req, res) => {
    const ctx = ctxOf(req, res);
    requireAdmin(ctx);
    const body = await readJson(req);
    const type = String(body.type || '');
    const email = normalizeEmail(body.email);
    const redirectTo = safeRedirect(ctx.s, body.redirect_to || body.options?.redirect_to || req.query.get('redirect_to'));
    const out = await tx(ctx.pool, async (c) => {
      let u = await loadUserByEmail(c, email);
      let otpType: OtpType;
      let verifyType: string;
      let to = email;
      switch (type) {
        case 'signup':
          if (u && u.email_confirmed_at) throw err(422, 'email_exists', 'A user with this email address has already been registered');
          if (!u) {
            const ph = body.password ? await hashPassword(checkPassword(ctx.s, body.password)) : null;
            u = await createEmailUser(c, email, { passwordHash: ph, confirmed: false, data: isObject(body.data) ? body.data : {} });
          }
          otpType = 'confirmation';
          verifyType = 'signup';
          break;
        case 'invite':
          if (u && u.email_confirmed_at) throw err(422, 'email_exists', 'A user with this email address has already been registered');
          if (!u) u = await createEmailUser(c, email, { confirmed: false, invited: true, data: isObject(body.data) ? body.data : {} });
          otpType = 'invite';
          verifyType = 'invite';
          break;
        case 'magiclink':
          if (!u) throw err(404, 'user_not_found', 'User with this email not found');
          otpType = 'magiclink';
          verifyType = 'magiclink';
          break;
        case 'recovery':
          if (!u) throw err(404, 'user_not_found', 'User with this email not found');
          otpType = 'recovery';
          verifyType = 'recovery';
          break;
        case 'email_change_new':
        case 'email_change_current':
          if (!u) throw err(404, 'user_not_found', 'User with this email not found');
          to = normalizeEmail(body.new_email);
          await c.query('update auth.users set email_change = $2, email_change_sent_at = now() where id = $1', [u.id, to]);
          otpType = 'email_change';
          verifyType = 'email_change';
          break;
        default:
          throw err(400, 'validation_failed', 'Invalid email action link type requested');
      }
      const { otp, tokenHash } = await createOtp(c, ctx.project.jwtSecret, u.id, otpType, to);
      const q = new URLSearchParams({ token: tokenHash, type: verifyType });
      if (redirectTo) q.set('redirect_to', redirectTo);
      const user = await fullUser(c, u.id, true);
      return {
        ...user,
        action_link: `${ctx.s.apiUrl}/verify?${q}`,
        email_otp: otp,
        hashed_token: tokenHash,
        verification_type: verifyType,
        redirect_to: redirectTo,
      };
    });
    sendJson(res, 200, out);
  });

  /**
   * Hourly upkeep for every project:
   * - /authorize needs no API key and stores a flow for PKCE sign-ins; flows
   *   that never finished (and used ones) go after a day.
   * - Sessions record the IP address and browser they were created from.
   *   Expired ones, and ones nobody has refreshed for SESSION_RETENTION_DAYS,
   *   are deleted (the user signs in again), as are refresh tokens that were
   *   rotated that long ago.
   * - TOTP secrets stored before they were encrypted (or imported) get encrypted.
   */
  const upkeep = async () => {
    for (const p of registry.list()) {
      const db = pool(p.dbName, 'keel_auth_admin', 10);
      try {
        const flows = await db.query(`delete from auth.flow_state where created_at < now() - interval '1 day'`);
        const sessions = await db.query(
          'delete from auth.sessions where not_after < now() or updated_at < now() - make_interval(days => $1)',
          [SESSION_RETENTION_DAYS],
        );
        const tokens = await db.query('delete from auth.refresh_tokens where revoked and updated_at < now() - make_interval(days => $1)', [SESSION_RETENTION_DAYS]);
        if (flows.rowCount || sessions.rowCount || tokens.rowCount) {
          log.debug('auth cleanup', { project: p.name, flows: flows.rowCount, sessions: sessions.rowCount, refresh_tokens: tokens.rowCount });
        }
        const plain = await db.query(`select id, secret from auth.mfa_factors where factor_type = 'totp' and secret is not null and secret not like 'v1:%'`);
        const key = totpKey(p.jwtSecret);
        for (const f of plain.rows) {
          await db.query('update auth.mfa_factors set secret = $3 where id = $1 and secret = $2', [f.id, f.secret, sealSecret(f.secret, key)]);
        }
        if (plain.rowCount) log.info('encrypted stored TOTP secrets', { project: p.name, factors: plain.rowCount });
      } catch (e) {
        log.warn('auth cleanup failed', { project: p.name, error: (e as Error).message });
      }
    }
  };
  setTimeout(() => void upkeep(), 60_000).unref();
  setInterval(() => void upkeep(), 60 * 60_000).unref();

  const server = createServer('keel-auth', router, (e) => ({
    status: e.status,
    body: { code: e.status, error_code: e.code || 'unexpected_failure', msg: e.message, ...(e.extra || {}) },
  }));
  await listen(server, config.ports.auth, 'keel-auth');
}

function amrForFlow(authMethod: string): string {
  return { 'email/signup': 'otp', magiclink: 'magiclink', recovery: 'recovery', invite: 'invite', email_change: 'email_change' }[authMethod] || 'otp';
}

function factorParam(id: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) throw err(404, 'mfa_factor_not_found', 'Factor not found');
  return id;
}

function hostOf(url: string): string {
  try {
    return url ? new URL(url).host : '';
  } catch {
    return '';
  }
}

/** Without verified factors, sessions can't stay at aal2. */
async function downgradeIfNoFactors(c: pg.ClientBase, userId: string) {
  const { rowCount } = await c.query(`select 1 from auth.mfa_factors where user_id = $1 and status = 'verified'`, [userId]);
  if (!rowCount) await c.query(`update auth.sessions set aal = 'aal1' where user_id = $1`, [userId]);
}

function uuidParam(id: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) throw err(404, 'user_not_found', 'User not found');
  return id;
}

async function upsertEmailIdentity(c: pg.ClientBase, userId: string, email: string) {
  const r = await c.query(
    `update auth.identities set identity_data = identity_data || jsonb_build_object('email', $2::text, 'email_verified', true), updated_at = now()
      where user_id = $1 and provider = 'email'`,
    [userId, email],
  );
  if (!r.rowCount) {
    await c.query(
      `insert into auth.identities (provider_id, user_id, identity_data, provider) values ($1, $2, $3, 'email')`,
      [userId, userId, { sub: userId, email, email_verified: true, phone_verified: false }],
    );
  }
}

/** Parses Go-style durations ("24h", "1h30m", "none") and applies them as a ban. */
async function applyBan(c: pg.ClientBase, userId: string, duration: string) {
  if (duration === 'none') {
    await c.query('update auth.users set banned_until = null where id = $1', [userId]);
    return;
  }
  const re = /(\d+(?:\.\d+)?)(ms|h|m|s)/g;
  let ms = 0;
  let matched = '';
  for (const m of duration.matchAll(re)) {
    matched += m[0];
    const n = Number(m[1]);
    ms += m[2] === 'h' ? n * 3600_000 : m[2] === 'm' ? n * 60_000 : m[2] === 's' ? n * 1000 : n;
  }
  if (!ms || matched !== duration) throw err(400, 'validation_failed', 'invalid format for ban duration');
  await c.query(`update auth.users set banned_until = now() + ($2 || ' milliseconds')::interval where id = $1`, [userId, String(Math.round(ms))]);
  await c.query('delete from auth.sessions where user_id = $1', [userId]);
}

function page(res: Res, status: number, title: string, message: string) {
  const esc = (s: string) => s.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!);
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>
<style>body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#f5f6f7;background-image:radial-gradient(#d3d5da 1px,transparent 1px);background-size:22px 22px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#141414;padding:16px}
.card{max-width:420px;background:#fff;border:1px solid #e3e4e7;border-radius:16px;padding:28px;box-shadow:0 18px 40px rgba(20,20,20,.08)}h1{margin:0 0 8px;font-size:24px;letter-spacing:-0.03em}p{margin:0;color:#5c5f66;line-height:1.5}.logo{font-weight:700;font-size:20px;letter-spacing:-0.04em;margin-bottom:18px}.logo span{color:#f0522e}</style></head>
<body><div class="card"><div class="logo">keel<span>.</span></div><h1>${esc(title)}</h1><p>${esc(message)}</p></div></body></html>`;
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': Buffer.byteLength(html), 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'" });
  res.end(html);
}
