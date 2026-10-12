import crypto from 'node:crypto';
import net from 'node:net';
import type pg from 'pg';
import bcrypt from 'bcryptjs';
import { tx } from '../lib/db.js';
import { HttpError, clientIp, type Req, type Res } from '../lib/http.js';
import { sha256, sign } from '../lib/jwt.js';
import { log } from '../lib/log.js';
import { signingKey, type Project } from '../lib/registry.js';
import type { AuthSettings } from './settings.js';

export type Ctx = {
  project: Project;
  s: AuthSettings;
  pool: pg.Pool;
  req: Req;
  res: Res;
};

export type UserRow = {
  id: string;
  aud: string | null;
  role: string | null;
  email: string | null;
  encrypted_password: string | null;
  email_confirmed_at: Date | null;
  invited_at: Date | null;
  confirmation_sent_at: Date | null;
  recovery_sent_at: Date | null;
  email_change: string | null;
  email_change_sent_at: Date | null;
  last_sign_in_at: Date | null;
  raw_app_meta_data: Record<string, unknown>;
  raw_user_meta_data: Record<string, unknown>;
  created_at: Date;
  updated_at: Date;
  phone: string | null;
  phone_confirmed_at: Date | null;
  phone_change: string | null;
  phone_change_sent_at: Date | null;
  confirmed_at: Date | null;
  banned_until: Date | null;
  deleted_at: Date | null;
  is_anonymous: boolean;
  /** When the current email address was proven to be the owner's (see emailProven). */
  email_proven_at: Date | null;
};

export type IdentityRow = {
  id: string;
  provider_id: string;
  user_id: string;
  identity_data: Record<string, unknown>;
  provider: string;
  last_sign_in_at: Date | null;
  created_at: Date;
  updated_at: Date;
  email: string | null;
};

export type FactorRow = {
  id: string;
  user_id: string;
  friendly_name: string | null;
  factor_type: 'totp' | 'phone';
  status: 'unverified' | 'verified';
  secret: string | null;
  phone: string | null;
  last_totp_step: string | null;
  created_at: Date;
  updated_at: Date;
  last_challenged_at: Date | null;
};

export const err = (status: number, code: string, msg: string, extra?: Record<string, unknown>) =>
  new HttpError(status, msg, code, extra);

const iso = (d: Date | null | undefined) => (d ? new Date(d).toISOString() : undefined);

export function identityJson(i: IdentityRow) {
  return {
    identity_id: i.id,
    id: i.provider_id,
    user_id: i.user_id,
    identity_data: i.identity_data,
    provider: i.provider,
    last_sign_in_at: iso(i.last_sign_in_at),
    created_at: iso(i.created_at),
    updated_at: iso(i.updated_at),
    email: i.email || undefined,
  };
}

export function factorJson(f: FactorRow) {
  return {
    id: f.id,
    friendly_name: f.friendly_name || '',
    factor_type: f.factor_type,
    status: f.status,
    created_at: iso(f.created_at),
    updated_at: iso(f.updated_at),
    ...(f.factor_type === 'phone' ? { phone: f.phone || '' } : {}),
    last_challenged_at: iso(f.last_challenged_at),
  };
}

export function userJson(u: UserRow, identities: IdentityRow[], admin = false, factors: FactorRow[] = []) {
  return {
    id: u.id,
    aud: u.aud || 'authenticated',
    role: u.role || 'authenticated',
    email: u.email || '',
    email_confirmed_at: iso(u.email_confirmed_at),
    phone: u.phone || '',
    phone_confirmed_at: iso(u.phone_confirmed_at),
    confirmation_sent_at: iso(u.confirmation_sent_at),
    confirmed_at: iso(u.confirmed_at),
    recovery_sent_at: iso(u.recovery_sent_at),
    new_email: u.email_change || undefined,
    email_change_sent_at: iso(u.email_change_sent_at),
    new_phone: u.phone_change || undefined,
    phone_change_sent_at: iso(u.phone_change_sent_at),
    invited_at: iso(u.invited_at),
    last_sign_in_at: iso(u.last_sign_in_at),
    app_metadata: u.raw_app_meta_data || {},
    user_metadata: u.raw_user_meta_data || {},
    identities: identities.map(identityJson),
    // Like GoTrue, only present when the user has enrolled a factor.
    ...(factors.length ? { factors: factors.map(factorJson) } : {}),
    created_at: iso(u.created_at),
    updated_at: iso(u.updated_at),
    is_anonymous: !!u.is_anonymous,
    ...(admin ? { banned_until: iso(u.banned_until), deleted_at: iso(u.deleted_at) } : {}),
  };
}

/**
 * What sign-up returns for an email address or phone number that already has
 * an account, when it can't just say so (with confirmation on, a new sign-up
 * gets no session either): a made-up unconfirmed user shaped like a real new
 * one, with a random id, the caller's own `data` as user_metadata and, as in
 * GoTrue, no identities. Nothing in it comes from the existing account.
 */
export function obfuscatedUser(provider: 'email' | 'phone', address: string, data: Record<string, unknown>, createdAt: Date) {
  const sentAt = new Date(Math.max(Date.now(), createdAt.getTime()));
  return userJson(
    {
      id: crypto.randomUUID(),
      aud: 'authenticated',
      role: 'authenticated',
      email: provider === 'email' ? address : null,
      phone: provider === 'phone' ? address : null,
      encrypted_password: null,
      email_confirmed_at: null,
      phone_confirmed_at: null,
      confirmed_at: null,
      invited_at: null,
      confirmation_sent_at: sentAt,
      recovery_sent_at: null,
      email_change: null,
      email_change_sent_at: null,
      phone_change: null,
      phone_change_sent_at: null,
      last_sign_in_at: null,
      raw_app_meta_data: { provider, providers: [provider] },
      raw_user_meta_data: data,
      created_at: createdAt,
      updated_at: createdAt,
      banned_until: null,
      deleted_at: null,
      is_anonymous: false,
      email_proven_at: null,
    },
    [],
  );
}

/**
 * Like tx(), but fn can fail the request without undoing what it wrote: it
 * returns the HttpError instead of throwing it, the transaction commits, and
 * the error is thrown afterwards. For revocations that must stick although
 * the request fails (a replayed refresh token, a wrong PKCE verifier).
 */
export async function txCommitThenThrow<T>(p: pg.Pool, fn: (c: pg.PoolClient) => Promise<T | HttpError>): Promise<T> {
  const out = await tx(p, fn);
  if (out instanceof HttpError) throw out;
  return out;
}

export async function loadUser(c: pg.ClientBase, id: string): Promise<UserRow | null> {
  const { rows } = await c.query('select * from auth.users where id = $1', [id]);
  return (rows[0] as UserRow) || null;
}

export async function loadUserByEmail(c: pg.ClientBase, email: string): Promise<UserRow | null> {
  const { rows } = await c.query('select * from auth.users where lower(email) = lower($1)', [email]);
  return (rows[0] as UserRow) || null;
}

export async function loadUserByPhone(c: pg.ClientBase, phone: string): Promise<UserRow | null> {
  const { rows } = await c.query('select * from auth.users where phone = $1', [phone]);
  return (rows[0] as UserRow) || null;
}

/** How long a sign-in from an address keeps it known to the account. */
const KNOWN_ADDRESS_DAYS = 30;

/**
 * True when the account had a session started from this rate-limit key (an
 * IPv4 address or an IPv6 /64) in the last 30 days. Only someone who could
 * sign in to the account creates one, so it shows the address is the owner's.
 */
export async function knownAddress(pool: pg.Pool, by: 'email' | 'phone', value: string, key: string): Promise<boolean> {
  const range = key.endsWith('::/64') ? key.slice(0, -3) : key;
  if (!net.isIP(range)) return false;
  const match = by === 'email' ? 'lower(u.email) = lower($1)' : 'u.phone = $1';
  const { rows } = await pool.query(
    `select 1 from auth.users u join auth.sessions s on s.user_id = u.id
      where ${match} and s.ip <<= $2::inet and s.updated_at > now() - make_interval(days => $3)
      limit 1`,
    [value, key, KNOWN_ADDRESS_DAYS],
  );
  return rows.length > 0;
}

export async function loadIdentities(c: pg.ClientBase, userId: string): Promise<IdentityRow[]> {
  const { rows } = await c.query('select * from auth.identities where user_id = $1 order by created_at', [userId]);
  return rows as IdentityRow[];
}

export async function loadFactors(c: pg.ClientBase, userId: string): Promise<FactorRow[]> {
  const { rows } = await c.query('select * from auth.mfa_factors where user_id = $1 order by created_at', [userId]);
  return rows as FactorRow[];
}

/** The user object every endpoint returns, with identities and MFA factors. */
export async function userPayload(c: pg.ClientBase, u: UserRow, admin = false) {
  return userJson(u, await loadIdentities(c, u.id), admin, await loadFactors(c, u.id));
}

export async function fullUser(c: pg.ClientBase, id: string, admin = false) {
  const u = await loadUser(c, id);
  if (!u) throw err(404, 'user_not_found', 'User not found');
  return userPayload(c, u, admin);
}

/**
 * Characters that turn an address into something else for a mail library:
 * display names (`victim <attacker@evil.test>`), lists (`a@x.test, b@y.test`),
 * groups (`team: a@x.test;`), comments, quoting and whitespace.
 */
const EMAIL_SPECIALS = /[\s<>()[\]\\,;:"\x00-\x1f\x7f]/;

export function normalizeEmail(email: unknown): string {
  if (typeof email !== 'string') throw err(400, 'validation_failed', 'An email address is required');
  const e = email.trim().toLowerCase();
  if (e.length > 255 || EMAIL_SPECIALS.test(e) || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) {
    throw err(400, 'validation_failed', 'Unable to validate email address: invalid format');
  }
  return e;
}

export function checkPassword(s: AuthSettings, password: unknown): string {
  if (typeof password !== 'string' || password.length < s.passwordMinLength) {
    throw err(422, 'weak_password', `Password should be at least ${s.passwordMinLength} characters.`, {
      weak_password: { reasons: ['length'], message: `Password should be at least ${s.passwordMinLength} characters.` },
    });
  }
  if (password.length > 72) throw err(422, 'weak_password', 'Password cannot be longer than 72 characters');
  return password;
}

/**
 * Runs at most `size` jobs at once. Others wait in line, up to `maxQueue` of
 * them for at most `waitMs`; past that they fail with `busy()`.
 */
export class WorkQueue {
  private running = 0;
  private waiting: { start: () => void; timer: NodeJS.Timeout }[] = [];
  constructor(
    private size: number,
    private maxQueue: number,
    private waitMs: number,
    private busy: () => Error,
  ) {}

  async run<T>(job: () => Promise<T>): Promise<T> {
    if (this.running < this.size) this.running++;
    else {
      if (this.waiting.length >= this.maxQueue) throw this.busy();
      await new Promise<void>((resolve, reject) => {
        const entry = {
          start: resolve,
          timer: setTimeout(() => {
            this.waiting.splice(this.waiting.indexOf(entry), 1);
            reject(this.busy());
          }, this.waitMs),
        };
        this.waiting.push(entry);
      });
      // The job that finished handed its place over (see below).
    }
    try {
      return await job();
    } finally {
      const next = this.waiting.shift();
      if (next) {
        clearTimeout(next.timer);
        next.start();
      } else this.running--;
    }
  }
}

export const BCRYPT_COST = 12;
/**
 * bcrypt in JavaScript takes about 0.2 s of keel-auth's only thread per
 * password. A few at a time keep the service answering everything else; a
 * flood of sign-ins (unknown emails cost as much) is turned away quickly
 * with 503 instead of slowing every project down.
 */
const bcryptQueue = new WorkQueue(4, 64, 2_000, () => err(503, 'request_timeout', 'Too many sign-ins at once, try again in a moment'));
export const hashPassword = (pw: string) => bcryptQueue.run(() => bcrypt.hash(pw, BCRYPT_COST));
// Compared against when there is no stored hash, so a missing account takes as long as a wrong password.
const DUMMY_HASH = bcrypt.hashSync('keel-timing-equaliser', BCRYPT_COST);
export const comparePassword = async (pw: string, hash: string | null) => {
  const ok = await bcryptQueue.run(() => bcrypt.compare(pw, hash || DUMMY_HASH));
  return !!hash && ok;
};

/** Hashes from older Keel versions (cost 10) or an import keep working; they are upgraded at the next sign-in. */
export function needsRehash(hash: string | null): boolean {
  if (!hash) return false;
  try {
    return bcrypt.getRounds(hash) < BCRYPT_COST;
  } catch {
    return false;
  }
}

/** After a successful password sign-in: stores a stronger hash when the stored one is weaker. */
export async function upgradePasswordHash(c: pg.ClientBase, u: UserRow, password: string): Promise<void> {
  if (!needsRehash(u.encrypted_password)) return;
  await c.query('update auth.users set encrypted_password = $2 where id = $1 and encrypted_password = $3', [u.id, await hashPassword(password), u.encrypted_password]);
}

export function isBanned(u: UserRow): boolean {
  return !!u.banned_until && new Date(u.banned_until).getTime() > Date.now();
}

export function assertCanSignIn(u: UserRow) {
  if (u.deleted_at) throw err(400, 'user_not_found', 'User not found');
  if (isBanned(u)) throw err(400, 'user_banned', 'User is banned');
}

export type Amr = { method: string; timestamp: number }[];
export type Aal = 'aal1' | 'aal2';

export function accessToken(ctx: Ctx, u: UserRow, sessionId: string, amr: Amr, aal: Aal = 'aal1'): { token: string; exp: number } {
  const iat = Math.floor(Date.now() / 1000);
  const exp = iat + ctx.s.jwtExp;
  const token = sign(
    {
      aud: u.aud || 'authenticated',
      exp,
      iat,
      iss: ctx.s.apiUrl,
      sub: u.id,
      email: u.email || '',
      phone: u.phone || '',
      app_metadata: u.raw_app_meta_data || {},
      user_metadata: u.raw_user_meta_data || {},
      role: u.role || 'authenticated',
      aal,
      // Most recent method first, as GoTrue does.
      amr: [...amr].sort((a, b) => b.timestamp - a.timestamp),
      session_id: sessionId,
      is_anonymous: !!u.is_anonymous,
      ref: ctx.project.name,
    },
    signingKey(ctx.project),
  );
  return { token, exp };
}

/**
 * The refresh token for row `id` of a session. Tokens are derived from the
 * row with the project secret rather than random, so the session's current
 * token can be handed out again during the reuse window (see refreshSession)
 * while the database still only holds their SHA-256 hashes.
 */
export function refreshTokenFor(secret: string, sessionId: string, id: string): string {
  return crypto.createHmac('sha256', secret).update(`refresh_token:${sessionId}:${id}`).digest('base64url').slice(0, 32);
}

async function newRefreshToken(c: pg.ClientBase, secret: string, userId: string, sessionId: string, parent: string | null): Promise<string> {
  const { rows } = await c.query(`select nextval(pg_get_serial_sequence('auth.refresh_tokens', 'id'))::text as id`);
  const id = rows[0].id as string;
  const token = refreshTokenFor(secret, sessionId, id);
  await c.query(
    'insert into auth.refresh_tokens (id, token, user_id, session_id, parent) values ($1, $2, $3, $4, $5)',
    [id, sha256(token), userId, sessionId, parent],
  );
  return token;
}

export async function sessionResponse(ctx: Ctx, c: pg.ClientBase, u: UserRow, sessionId: string, amr: Amr, refreshToken: string, extra: Record<string, unknown> = {}, aal: Aal = 'aal1') {
  const { token, exp } = accessToken(ctx, u, sessionId, amr, aal);
  return {
    access_token: token,
    token_type: 'bearer',
    expires_in: ctx.s.jwtExp,
    expires_at: exp,
    refresh_token: refreshToken,
    user: await userPayload(c, u),
    ...extra,
  };
}

/** Creates a session and returns the GoTrue-shaped session payload. */
export async function issueSession(ctx: Ctx, c: pg.ClientBase, userId: string, method: string, extra: Record<string, unknown> = {}) {
  const amr: Amr = [{ method, timestamp: Math.floor(Date.now() / 1000) }];
  const ua = String(ctx.req.headers['user-agent'] || '').slice(0, 500);
  const ip = clientIp(ctx.req);
  const { rows } = await c.query(
    `insert into auth.sessions (user_id, user_agent, ip, amr) values ($1, $2, $3, $4) returning id`,
    [userId, ua, /^[0-9a-f.:]+$/i.test(ip) ? ip : null, JSON.stringify(amr)],
  );
  const sessionId = rows[0].id as string;
  const u = (await c.query('update auth.users set last_sign_in_at = now(), updated_at = now() where id = $1 returning *', [userId])).rows[0] as UserRow;
  await c.query('update auth.identities set last_sign_in_at = now() where user_id = $1 and provider = $2', [userId, (extra.provider as string) || 'email']);
  const refresh = await newRefreshToken(c, ctx.project.jwtSecret, userId, sessionId, null);
  const { provider: _provider, ...rest } = extra;
  return sessionResponse(ctx, c, u, sessionId, amr, refresh, rest);
}

/** Time window in which a just-rotated refresh token may still be used (concurrent tabs). */
const REUSE_INTERVAL_MS = 10_000;

/**
 * The refresh_token grant. Each token works once and is replaced by a new
 * one. Within REUSE_INTERVAL_MS of being replaced, a token still works but
 * returns the session's current token instead of a new one, so the session
 * keeps a single chain (two tabs refreshing at once end up with the same
 * token). Later reuse means the token leaked: the session is ended, and the
 * error is returned rather than thrown so that this commits (run it with
 * txCommitThenThrow).
 */
export async function refreshSession(ctx: Ctx, c: pg.ClientBase, refreshToken: unknown) {
  if (typeof refreshToken !== 'string' || !refreshToken) throw err(400, 'refresh_token_not_found', 'Invalid Refresh Token: Refresh Token Not Found');
  const hash = sha256(refreshToken);
  const { rows } = await c.query(
    `select t.id, t.revoked, t.updated_at, t.session_id, t.user_id, s.amr, s.aal
       from auth.refresh_tokens t join auth.sessions s on s.id = t.session_id
      where t.token = $1 for update of t`,
    [hash],
  );
  const row = rows[0];
  if (!row) throw err(400, 'refresh_token_not_found', 'Invalid Refresh Token: Refresh Token Not Found');
  if (row.revoked && Date.now() - new Date(row.updated_at).getTime() > REUSE_INTERVAL_MS) {
    await c.query('delete from auth.sessions where id = $1', [row.session_id]);
    log.warn('refresh token reused after rotation; session ended', { project: ctx.project.name, user: row.user_id, session: row.session_id });
    return err(400, 'refresh_token_already_used', 'Invalid Refresh Token: Already Used');
  }
  const u = await loadUser(c, row.user_id);
  if (!u) throw err(400, 'user_not_found', 'User not found');
  assertCanSignIn(u);
  let next: string;
  if (row.revoked) {
    const { rows: cur } = await c.query(
      'select id::text as id, token from auth.refresh_tokens where session_id = $1 and not revoked order by id desc limit 1',
      [row.session_id],
    );
    if (!cur[0]) throw err(400, 'refresh_token_not_found', 'Invalid Refresh Token: Refresh Token Not Found');
    const current = refreshTokenFor(ctx.project.jwtSecret, row.session_id, cur[0].id);
    // Tokens issued before tokens were derived can't be recomputed; for those
    // (only within seconds of upgrading) fall back to issuing a new one.
    next = sha256(current) === cur[0].token ? current : await newRefreshToken(c, ctx.project.jwtSecret, u.id, row.session_id, hash);
  } else {
    await c.query('update auth.refresh_tokens set revoked = true, updated_at = now() where id = $1', [row.id]);
    next = await newRefreshToken(c, ctx.project.jwtSecret, u.id, row.session_id, hash);
  }
  await c.query('update auth.sessions set refreshed_at = now(), updated_at = now() where id = $1', [row.session_id]);
  return sessionResponse(ctx, c, u, row.session_id, row.amr || [], next, {}, row.aal === 'aal2' ? 'aal2' : 'aal1');
}

/** Re-issues tokens for an existing session after it was upgraded (MFA). */
export async function reissueSession(ctx: Ctx, c: pg.ClientBase, userId: string, sessionId: string) {
  const { rows } = await c.query('select amr, aal from auth.sessions where id = $1', [sessionId]);
  const u = await loadUser(c, userId);
  if (!rows[0] || !u) throw err(404, 'session_not_found', 'Session not found');
  await c.query('update auth.refresh_tokens set revoked = true, updated_at = now() where session_id = $1 and not revoked', [sessionId]);
  const refresh = await newRefreshToken(c, ctx.project.jwtSecret, userId, sessionId, null);
  return sessionResponse(ctx, c, u, sessionId, rows[0].amr || [], refresh, {}, rows[0].aal === 'aal2' ? 'aal2' : 'aal1');
}

export type OtpType =
  | 'confirmation'
  | 'invite'
  | 'magiclink'
  | 'recovery'
  | 'email_change'
  /** Phone + password sign-up confirmation. */
  | 'phone_confirmation'
  /** Passwordless phone sign-in. */
  | 'phone_otp'
  | 'phone_change';

/**
 * Hash stored for a one-time code, and sent in email links. Keyed with the
 * project's secret, so nobody can compute it from a guessed code and skip
 * the per-address limit on code guesses.
 */
export function otpHash(secret: string, relatesTo: string, code: string): string {
  return crypto.createHmac('sha256', secret).update(`otp:${relatesTo.toLowerCase()}:${code}`).digest('hex');
}

/**
 * Stores a one-time code for an email address or phone number. Only its
 * keyed hash is kept. Pass `code` to use a fixed code (SMS test numbers,
 * configurable code length).
 */
export async function createOtp(c: pg.ClientBase, secret: string, userId: string, type: OtpType, relatesTo: string, code?: string) {
  const otp = code ?? String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
  const tokenHash = otpHash(secret, relatesTo, otp);
  await c.query(
    `insert into auth.one_time_tokens (user_id, token_type, token_hash, relates_to) values ($1, $2, $3, $4)
     on conflict (user_id, token_type) do update
       set token_hash = excluded.token_hash, relates_to = excluded.relates_to, created_at = now(), updated_at = now()`,
    [userId, type, tokenHash, relatesTo.toLowerCase()],
  );
  return { otp, tokenHash };
}

/** Which stored token types each verify `type` accepts. */
export const VERIFY_TYPES: Record<string, OtpType[]> = {
  signup: ['confirmation'],
  invite: ['invite'],
  magiclink: ['magiclink', 'confirmation'],
  email: ['magiclink', 'confirmation', 'invite'],
  recovery: ['recovery'],
  email_change: ['email_change'],
  sms: ['phone_confirmation', 'phone_otp'],
  phone_change: ['phone_change'],
};

const PHONE_TYPES = new Set<OtpType>(['phone_confirmation', 'phone_otp', 'phone_change']);

export async function consumeOtp(c: pg.ClientBase, type: string, tokenHash: string, expSeconds: number, smsExpSeconds = expSeconds) {
  const types = VERIFY_TYPES[type];
  if (!types) throw err(400, 'validation_failed', `Verify requires a valid type`);
  const { rows } = await c.query(
    `delete from auth.one_time_tokens where token_hash = $1 and token_type = any($2)
     returning user_id, token_type, relates_to, created_at`,
    [tokenHash, types],
  );
  const row = rows[0];
  const limit = row && PHONE_TYPES.has(row.token_type) ? smsExpSeconds : expSeconds;
  if (!row || Date.now() - new Date(row.created_at).getTime() > limit * 1000) {
    throw err(403, 'otp_expired', 'Token has expired or is invalid');
  }
  return row as { user_id: string; token_type: OtpType; relates_to: string };
}

/**
 * Whether the account's email address is known to be its owner's: proven by
 * a link or code sent to it, a provider that verified it, or an admin
 * (email_proven_at), or an OAuth identity that verified this same address
 * (accounts imported from Supabase). email_confirmed_at isn't enough: without
 * a mail server, sign-ups are confirmed without anyone proving anything.
 */
export async function emailProven(c: pg.ClientBase, u: UserRow): Promise<boolean> {
  if (!u.email) return false;
  if (u.email_proven_at) return true;
  const { rowCount } = await c.query(
    `select 1 from auth.identities
      where user_id = $1 and provider not in ('email', 'phone') and email = lower($2) and identity_data ->> 'email_verified' = 'true'`,
    [u.id, u.email],
  );
  return !!rowCount;
}

/**
 * Someone just proved they own the account's email address (with a link or
 * code sent to it, or a provider such as Google), and nobody had before. The
 * account may have been registered or changed to that address by someone else
 * (a pre-registration attack), so remove every way back in they could have
 * set up: the password, the phone number, identities of other providers,
 * pending email and phone changes, unused codes and links, issued PKCE codes
 * and all sessions. MFA factors stay: they can't be used to sign in.
 */
export async function evictUnprovenClaimants(c: pg.ClientBase, u: UserRow, via: string, project: string) {
  await c.query(
    `update auth.users
        set encrypted_password = null, phone = null, phone_confirmed_at = null, phone_change = '', phone_change_sent_at = null,
            email_change = null, email_change_sent_at = null,
            raw_app_meta_data = raw_app_meta_data || '{"provider": "email", "providers": ["email"]}'::jsonb, updated_at = now()
      where id = $1`,
    [u.id],
  );
  const identities = await c.query(`delete from auth.identities where user_id = $1 and provider <> 'email'`, [u.id]);
  await c.query('delete from auth.one_time_tokens where user_id = $1', [u.id]);
  await c.query('delete from auth.flow_state where user_id = $1 and auth_code is not null', [u.id]);
  const sessions = await c.query('delete from auth.sessions where user_id = $1', [u.id]);
  const removed = {
    password: !!u.encrypted_password,
    phone: !!u.phone,
    identities: identities.rowCount || 0,
    sessions: sessions.rowCount || 0,
  };
  // A brand-new passwordless account has nothing to remove; that's the common case.
  if (removed.password || removed.phone || removed.identities || removed.sessions) {
    log.warn('email address proven for the first time; removed the sign-in methods set up before it was', { project, user: u.id, via, removed });
  }
}

/** Applies the effect of a verified token and returns the amr method for the new session. */
export async function applyVerification(c: pg.ClientBase, row: { user_id: string; token_type: OtpType; relates_to: string }, project = ''): Promise<string> {
  switch (row.token_type) {
    case 'confirmation':
    case 'invite':
    case 'magiclink':
    case 'recovery': {
      if (row.token_type !== 'confirmation') {
        // A confirmation link confirms the sign-up that sent it (sign-up drops
        // a password that two sign-ups disagreed on). The other links can be
        // requested by anyone for any address, so the account's credentials
        // are only trusted if the address had been proven before.
        const u = await loadUser(c, row.user_id);
        if (u && !(await emailProven(c, u))) await evictUnprovenClaimants(c, u, `${row.token_type} link`, project);
      }
      await c.query(
        `update auth.users set email_confirmed_at = coalesce(email_confirmed_at, now()),
                email_proven_at = case when lower(email) = $2 then coalesce(email_proven_at, now()) else email_proven_at end,
                updated_at = now()
          where id = $1`,
        [row.user_id, row.relates_to],
      );
      await c.query(
        `update auth.identities set identity_data = identity_data || '{"email_verified": true}'::jsonb where user_id = $1 and provider = 'email'`,
        [row.user_id],
      );
      return { confirmation: 'otp', invite: 'invite', magiclink: 'magiclink', recovery: 'recovery' }[row.token_type]!;
    }
    case 'phone_confirmation':
    case 'phone_otp':
      if (row.token_type === 'phone_otp') {
        // Same pre-registration protection as for email: whoever set a
        // password on a never-confirmed number didn't prove they own it.
        await c.query(
          `update auth.users set encrypted_password = null where id = $1 and phone_confirmed_at is null and email_confirmed_at is null`,
          [row.user_id],
        );
      }
      await c.query(`update auth.users set phone_confirmed_at = coalesce(phone_confirmed_at, now()), updated_at = now() where id = $1`, [row.user_id]);
      await c.query(
        `update auth.identities set identity_data = identity_data || '{"phone_verified": true}'::jsonb where user_id = $1 and provider = 'phone'`,
        [row.user_id],
      );
      return 'otp';
    case 'phone_change': {
      await c.query(
        `update auth.users set phone = $2, phone_change = '', phone_change_sent_at = null,
                phone_confirmed_at = now(), updated_at = now() where id = $1`,
        [row.user_id, row.relates_to],
      );
      await upsertPhoneIdentity(c, row.user_id, row.relates_to);
      return 'phone_change';
    }
    case 'email_change': {
      await c.query(
        `update auth.users set email = $2, email_change = null, email_change_sent_at = null,
                email_confirmed_at = now(), email_proven_at = now(), updated_at = now() where id = $1`,
        [row.user_id, row.relates_to],
      );
      await c.query(
        `update auth.identities set identity_data = identity_data || jsonb_build_object('email', $2::text, 'email_verified', true)
          where user_id = $1 and provider = 'email'`,
        [row.user_id, row.relates_to],
      );
      return 'email_change';
    }
  }
}

export function pkceMatches(method: string | null, challenge: string | null, verifier: unknown): boolean {
  if (typeof verifier !== 'string' || !challenge) return false;
  if ((method || 's256').toLowerCase() === 'plain') return verifier === challenge;
  const digest = crypto.createHash('sha256').update(verifier).digest('base64url');
  return digest === challenge;
}

export async function createFlowState(
  c: pg.ClientBase,
  opts: { userId?: string | null; challenge: string; method: string; provider: string; authMethod: string; redirectTo?: string },
): Promise<string> {
  const m = (opts.method || 's256').toLowerCase();
  if (m !== 's256' && m !== 'plain') throw err(400, 'validation_failed', 'code_challenge_method must be s256 or plain');
  const { rows } = await c.query(
    `insert into auth.flow_state (user_id, code_challenge, code_challenge_method, provider_type, authentication_method, redirect_to)
     values ($1, $2, $3, $4, $5, $6) returning id`,
    [opts.userId || null, opts.challenge, m, opts.provider, opts.authMethod, opts.redirectTo || null],
  );
  return rows[0].id;
}

/** Marks a flow as completed by a user and returns the one-time auth code for ?code=. */
export async function issueAuthCode(c: pg.ClientBase, flowId: string, userId: string, providerTokens?: { access?: string; refresh?: string }): Promise<string> {
  const code = crypto.randomUUID();
  await c.query(
    `update auth.flow_state set user_id = $2, auth_code = $3, auth_code_issued_at = now(), updated_at = now(),
            provider_access_token = $4, provider_refresh_token = $5 where id = $1`,
    [flowId, userId, code, providerTokens?.access || null, providerTokens?.refresh || null],
  );
  return code;
}

export function sessionFragment(session: Record<string, unknown>, type?: string): string {
  const p = new URLSearchParams();
  for (const k of ['access_token', 'expires_at', 'expires_in', 'refresh_token', 'token_type', 'provider_token', 'provider_refresh_token']) {
    if (session[k] !== undefined && session[k] !== null) p.set(k, String(session[k]));
  }
  if (type) p.set('type', type);
  return p.toString();
}

export async function upsertPhoneIdentity(c: pg.ClientBase, userId: string, phone: string, verified = true) {
  const r = await c.query(
    `update auth.identities set identity_data = identity_data || jsonb_build_object('phone', $2::text, 'phone_verified', $3::boolean), updated_at = now()
      where user_id = $1 and provider = 'phone'`,
    [userId, phone, verified],
  );
  if (!r.rowCount) {
    await c.query(
      `insert into auth.identities (provider_id, user_id, identity_data, provider) values ($1, $2, $3, 'phone')`,
      [userId, userId, { sub: userId, phone, email_verified: false, phone_verified: verified }],
    );
  }
}
