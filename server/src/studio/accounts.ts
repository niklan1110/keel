import crypto from 'node:crypto';
import { promisify } from 'node:util';
import { newSecret, otpauthUri, qrSvg, verifyTotp } from '../auth/totp.js';
import { config, deriveSecret, isDocumentedExample } from '../lib/config.js';
import { pool } from '../lib/db.js';
import { HttpError, clientIp, clientKey, fromLocalNetwork, readJson, sendJson, viaTrustedProxy, type Req, type Res, type Router } from '../lib/http.js';
import { sign, verify } from '../lib/jwt.js';
import { log } from '../lib/log.js';
import { SESSION_COOKIE, browserUsesHttps, readCookie, sessionCookie } from './csrf.js';

/**
 * Studio accounts: sign-in with optional two-factor codes, sessions stored
 * on the server (so signing out ends them), and a rule for sign-ins from the
 * internet (KEEL_STUDIO_INTERNET_LOGIN). Every account is a full admin.
 */

export const SESSION_TTL_S = 12 * 3600;
export const USERNAME_RE = /^[A-Za-z0-9][A-Za-z0-9._@-]{1,63}$/;
export const MIN_PASSWORD = 8;
const MAX_PASSWORD = 200;

/** Key that signs Studio session tokens. */
let sessionKeyCache = '';
export const sessionKey = () => (sessionKeyCache ||= deriveSecret(config.secret, 'studio-session'));

// ------------------------------------------------------------------ two-factor secrets
// Stored encrypted with a key derived from KEEL_SECRET, so a copy of the
// database (a backup, a SQL query) doesn't hand out working codes.
// v2 uses the HKDF key for this purpose; v1 (older versions) used a plain
// SHA-256 of KEEL_SECRET and is still read, then resealed as v2.
const totpKey = () => Buffer.from(deriveSecret(config.secret, 'studio-totp'), 'hex');
const legacyTotpKey = () => crypto.createHash('sha256').update(`keel-studio-totp:${config.secret}`).digest();

export function sealTotp(secret: string): string {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', totpKey(), iv);
  const data = Buffer.concat([c.update(secret, 'utf8'), c.final()]);
  return `v2:${iv.toString('base64')}:${c.getAuthTag().toString('base64')}:${data.toString('base64')}`;
}

/** True for secrets stored by older versions (unencrypted or v1). */
export const totpNeedsReseal = (stored: string) => !stored.startsWith('v2:');

/** Older installs stored the secret as is, or as v1. */
export function openTotp(stored: string): string {
  const version = stored.slice(0, 3);
  if (version !== 'v1:' && version !== 'v2:') return stored;
  const [, iv, tag, data] = stored.split(':');
  try {
    const d = crypto.createDecipheriv('aes-256-gcm', version === 'v2:' ? totpKey() : legacyTotpKey(), Buffer.from(iv, 'base64'));
    d.setAuthTag(Buffer.from(tag, 'base64'));
    return Buffer.concat([d.update(Buffer.from(data, 'base64')), d.final()]).toString('utf8');
  } catch {
    throw new HttpError(
      500,
      "This account's two-factor setup can't be read (KEEL_SECRET changed?). Turn it off with ./keel studio-user reset-2fa <name>.",
      'two_factor_unreadable',
    );
  }
}

// ------------------------------------------------------------------ passwords
const scryptAsync = promisify(crypto.scrypt) as (pw: string, salt: Buffer, len: number, opts: crypto.ScryptOptions) => Promise<Buffer>;
const SCRYPT = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.randomBytes(16);
  const key = await scryptAsync(password.normalize('NFKC'), salt, 32, SCRYPT);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64')}$${key.toString('base64')}`;
}

export async function checkPassword(password: string, stored: string): Promise<boolean> {
  const [alg, n, r, p, salt, hash] = stored.split('$');
  if (alg !== 'scrypt' || !salt || !hash) return false;
  const expected = Buffer.from(hash, 'base64');
  const key = await scryptAsync(password.normalize('NFKC'), Buffer.from(salt, 'base64'), expected.length, {
    N: Number(n),
    r: Number(r),
    p: Number(p),
    maxmem: SCRYPT.maxmem,
  });
  return crypto.timingSafeEqual(key, expected);
}

export function validatePassword(password: unknown): string {
  if (typeof password !== 'string' || password.length < MIN_PASSWORD) {
    throw new HttpError(400, `Use at least ${MIN_PASSWORD} characters for the password`, 'weak_password');
  }
  if (password.length > MAX_PASSWORD) throw new HttpError(400, 'That password is too long', 'bad_request');
  if (isDocumentedExample(password)) throw new HttpError(400, 'That password is an example from the documentation. Choose your own.', 'weak_password');
  return password;
}

export function validateUsername(username: unknown): string {
  if (typeof username !== 'string' || !USERNAME_RE.test(username)) {
    throw new HttpError(400, 'Usernames are 2 to 64 letters, digits, ".", "_", "-" or "@", starting with a letter or digit', 'bad_request');
  }
  return username;
}

// ------------------------------------------------------------------ data
export type StudioUser = {
  id: string;
  username: string;
  password_hash: string;
  is_owner: boolean;
  totp_secret: string | null;
  totp_last_step: string | null;
  created_at: Date;
  last_login_at: Date | null;
};

export const control = () => pool(config.db.controlDb, config.db.superuser, 4);

const userJson = (u: StudioUser) => ({
  id: u.id,
  username: u.username,
  isOwner: u.is_owner,
  twoFactor: !!u.totp_secret,
  createdAt: u.created_at,
  lastLoginAt: u.last_login_at,
});

/**
 * Makes sure the owner account (KEEL_DASHBOARD_USERNAME) exists. Its password
 * is set from KEEL_DASHBOARD_PASSWORD when the account is created and again
 * whenever that .env value changes, so editing .env and restarting Studio is
 * always a way back in. A password changed in Studio stays until then.
 */
export async function ensureOwner(): Promise<void> {
  const c = await control().connect();
  try {
    await c.query('begin');
    await c.query('lock table keel.studio_users in share row exclusive mode');
    const envUser = config.dashboard.username;
    const envPassword = config.dashboard.password;
    const owner = (await c.query('select * from keel.studio_users where is_owner limit 1')).rows[0] as StudioUser | undefined;
    const seen = (await c.query(`select value from keel.studio_state where key = 'env_password'`)).rows[0]?.value as string | undefined;
    const envChanged = !seen || !(await checkPassword(envPassword, seen));
    const remember = async () =>
      c.query(
        `insert into keel.studio_state (key, value) values ('env_password', $1)
         on conflict (key) do update set value = excluded.value`,
        [await hashPassword(envPassword)],
      );

    if (!owner) {
      const taken = (await c.query('select id from keel.studio_users where lower(username) = lower($1)', [envUser])).rows[0];
      if (taken) {
        await c.query('update keel.studio_users set is_owner = true, password_hash = $2, updated_at = now() where id = $1', [taken.id, await hashPassword(envPassword)]);
      } else {
        await c.query('insert into keel.studio_users (username, password_hash, is_owner) values ($1, $2, true)', [envUser, await hashPassword(envPassword)]);
      }
      await remember();
      log.info('created the Studio owner account', { username: envUser });
    } else {
      if (owner.username.toLowerCase() !== envUser.toLowerCase()) {
        const clash = (await c.query('select 1 from keel.studio_users where lower(username) = lower($1) and id <> $2', [envUser, owner.id])).rowCount;
        if (clash) log.warn('KEEL_DASHBOARD_USERNAME matches another Studio account; the owner keeps its name', { owner: owner.username });
        else await c.query('update keel.studio_users set username = $2, updated_at = now() where id = $1', [owner.id, envUser]);
      }
      if (envChanged) {
        await c.query('update keel.studio_users set password_hash = $2, updated_at = now() where id = $1', [owner.id, await hashPassword(envPassword)]);
        await c.query('delete from keel.studio_sessions where user_id = $1', [owner.id]);
        await remember();
        if (seen) log.info('KEEL_DASHBOARD_PASSWORD changed: the owner password was reset and its sessions ended', { username: envUser });
      }
    }
    await c.query('commit');
  } catch (err) {
    await c.query('rollback').catch(() => {});
    throw err;
  } finally {
    c.release();
  }
}

/**
 * Reseals two-factor secrets stored by older versions with the current key,
 * so nobody has to set up two-factor again after an upgrade. A secret that
 * can't be read (KEEL_SECRET changed) is left alone: reset-2fa clears it.
 */
export async function resealTotpSecrets(): Promise<void> {
  const { rows } = await control().query(`select id, username, totp_secret from keel.studio_users where totp_secret is not null and totp_secret not like 'v2:%'`);
  for (const r of rows) {
    let plain: string;
    try {
      plain = openTotp(r.totp_secret);
    } catch {
      log.warn("a Studio account's two-factor setup can't be read; reset it with ./keel studio-user reset-2fa", { username: r.username });
      continue;
    }
    await control().query('update keel.studio_users set totp_secret = $2 where id = $1 and totp_secret = $3', [r.id, sealTotp(plain), r.totp_secret]);
  }
  if (rows.length) log.info('resealed two-factor secrets with the current key', { accounts: rows.length });
}

// ------------------------------------------------------------------ attempt limits
/** Counts failures only; a key is blocked once it reaches `limit` within the window. */
class FailureCounter {
  private hits = new Map<string, { count: number; reset: number }>();
  constructor(
    private limit: number,
    private windowMs: number,
  ) {
    setInterval(() => {
      const now = Date.now();
      for (const [k, v] of this.hits) if (v.reset < now) this.hits.delete(k);
    }, 60_000).unref();
  }
  blocked(key: string): boolean {
    const cur = this.hits.get(key);
    return !!cur && cur.reset >= Date.now() && cur.count >= this.limit;
  }
  fail(key: string): void {
    const now = Date.now();
    const cur = this.hits.get(key);
    if (!cur || cur.reset < now) this.hits.set(key, { count: 1, reset: now + this.windowMs });
    else cur.count++;
  }
  clear(key: string): void {
    this.hits.delete(key);
  }
}

// ------------------------------------------------------------------ sessions
type Session = { id: string; userId: string; username: string; expiresAt: number; seenAt: number; checkedAt: number };
export type StudioRequest = Req & { studio?: { userId: string; username: string; sessionId: string } };

const DUMMY_HASH = 'scrypt$16384$8$1$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';

export function registerAccountRoutes(router: Router) {
  const policy = ['on', 'off', '2fa'].includes(config.studioInternetLogin) ? config.studioInternetLogin : '2fa';
  // Per address (per /64 for IPv6): 10 failed sign-ins per 15 minutes. Per
  // account, from the internet only: 20 per hour, so strangers can't lock you
  // out at home. Plus 100 per hour per account from anywhere, in case a
  // device on your own network rotates addresses.
  const byAddress = new FailureCounter(10, 15 * 60_000);
  const byAccount = new FailureCounter(20, 60 * 60_000);
  const byAccountAll = new FailureCounter(100, 60 * 60_000);
  const cache = new Map<string, Session>();

  const loadSession = async (id: string): Promise<Session | null> => {
    const hit = cache.get(id);
    if (hit && Date.now() - hit.checkedAt < 5_000) return hit;
    const row = (
      await control().query(
        `select s.id, s.user_id, u.username, s.expires_at, s.last_seen_at
           from keel.studio_sessions s join keel.studio_users u on u.id = s.user_id
          where s.id = $1 and s.expires_at > now()`,
        [id],
      )
    ).rows[0];
    if (!row) {
      cache.delete(id);
      return null;
    }
    const s: Session = {
      id: row.id,
      userId: row.user_id,
      username: row.username,
      expiresAt: new Date(row.expires_at).getTime(),
      seenAt: new Date(row.last_seen_at).getTime(),
      checkedAt: Date.now(),
    };
    cache.set(id, s);
    return s;
  };

  const endSessions = async (where: string, params: unknown[]) => {
    const { rows } = await control().query(`delete from keel.studio_sessions where ${where} returning id`, params);
    for (const r of rows) cache.delete(r.id);
    return rows.length;
  };

  /** Wraps a handler so it runs only for a signed-in Studio session. */
  const authed =
    (fn: (req: Req, res: Res) => unknown) =>
    async (req: Req, res: Res) => {
      // The session lives in an HttpOnly cookie (see csrf.ts); tokens aren't handed to page scripts.
      const token = readCookie(req.headers.cookie, SESSION_COOKIE);
      if (!token) throw new HttpError(401, 'Sign in required', 'unauthorized');
      let sid: unknown;
      try {
        const claims = verify(token, sessionKey());
        if (claims.kind !== 'studio') throw new Error('wrong token kind');
        sid = claims.sid;
      } catch {
        throw new HttpError(401, 'Your session has expired. Sign in again.', 'unauthorized');
      }
      const s = typeof sid === 'string' ? await loadSession(sid) : null;
      if (!s) throw new HttpError(401, 'Your session has ended. Sign in again.', 'unauthorized');
      if (Date.now() - s.seenAt > 60_000) {
        s.seenAt = Date.now();
        void control()
          .query('update keel.studio_sessions set last_seen_at = now() where id = $1', [s.id])
          .catch(() => {});
      }
      (req as StudioRequest).studio = { userId: s.userId, username: s.username, sessionId: s.id };
      return fn(req, res);
    };

  const me = (req: Req) => (req as StudioRequest).studio!;
  const getUser = async (id: string): Promise<StudioUser> => {
    const u = (await control().query('select * from keel.studio_users where id = $1', [id])).rows[0] as StudioUser | undefined;
    if (!u) throw new HttpError(404, 'No such Studio account', 'not_found');
    return u;
  };

  // ---------------------------------------------------------------- sign in
  router.post('/api/login', async (req, res) => {
    const ip = clientIp(req);
    const addr = clientKey(req);
    const internet = !fromLocalNetwork(req);
    if (internet && policy === 'off') {
      throw new HttpError(403, 'Studio sign-in from the internet is turned off on this server. Use your home network or Tailscale.', 'internet_login_disabled');
    }
    const body = await readJson(req);
    const username = String(body.username || '').trim();
    const accountKey = username.toLowerCase();
    if (byAddress.blocked(addr) || (internet && byAccount.blocked(accountKey)) || byAccountAll.blocked(accountKey)) {
      throw new HttpError(429, 'Too many sign-in attempts. Wait a few minutes.', 'rate_limited');
    }
    // The typed name is logged only when it is an account's: people sometimes type their password there.
    const failed = (message: string, code: string, account?: string) => {
      byAddress.fail(addr);
      byAccountAll.fail(accountKey);
      if (internet) byAccount.fail(accountKey);
      log.warn('studio sign-in failed', { ip, username: account, reason: code, internet });
      return new HttpError(401, message, code);
    };

    const user = (await control().query('select * from keel.studio_users where lower(username) = lower($1)', [username])).rows[0] as StudioUser | undefined;
    const ok = await checkPassword(String(body.password || ''), user?.password_hash || DUMMY_HASH);
    if (!user || !ok) throw failed('Wrong username or password', 'invalid_credentials', user?.username);

    if (user.totp_secret) {
      const code = String(body.code || '').replace(/\s/g, '');
      if (!code) throw new HttpError(401, 'Enter the 6-digit code from your authenticator app.', 'mfa_required');
      const step = verifyTotp(openTotp(user.totp_secret), code);
      // Claiming the step in the same statement stops two sign-ins racing with one code.
      const claimed =
        step !== null &&
        (
          await control().query(
            `update keel.studio_users set totp_last_step = $2,
                    totp_secret = case when totp_secret like 'v2:%' then totp_secret else $3 end
              where id = $1 and (totp_last_step is null or totp_last_step < $2)`,
            [user.id, step, sealTotp(openTotp(user.totp_secret))],
          )
        ).rowCount === 1;
      if (!claimed) throw failed('That code is wrong or was already used. Wait for the next one.', 'invalid_code', user.username);
    } else if (internet && policy === '2fa') {
      throw new HttpError(
        403,
        'Sign-ins from the internet need two-factor authentication. Sign in once from your home network or Tailscale and turn it on under Account and security.',
        'two_factor_required',
      );
    }

    byAddress.clear(addr);
    if (internet) byAccount.clear(accountKey);
    const now = Math.floor(Date.now() / 1000);
    const session = (
      await control().query(
        `insert into keel.studio_sessions (user_id, expires_at, ip, user_agent, from_internet)
         values ($1, now() + make_interval(secs => $2), $3, $4, $5) returning id`,
        [user.id, SESSION_TTL_S, ip, String(req.headers['user-agent'] || '').slice(0, 300), internet],
      )
    ).rows[0];
    await control().query('update keel.studio_users set last_login_at = now() where id = $1', [user.id]);
    // Old sessions are cleaned up as people sign in.
    void control()
      .query('delete from keel.studio_sessions where expires_at < now()')
      .catch(() => {});
    const token = sign({ kind: 'studio', sid: session.id, sub: user.id, iat: now, exp: now + SESSION_TTL_S }, sessionKey());
    log.info('studio sign-in', { username: user.username, ip, internet });
    res.setHeader('Set-Cookie', sessionCookie(token, SESSION_TTL_S, browserUsesHttps(req.headers, viaTrustedProxy(req))));
    sendJson(res, 200, { expiresAt: now + SESSION_TTL_S, username: user.username, user: userJson(user) });
  });

  router.post(
    '/api/logout',
    authed(async (req, res) => {
      await endSessions('id = $1', [me(req).sessionId]);
      res.setHeader('Set-Cookie', sessionCookie('', 0, browserUsesHttps(req.headers, viaTrustedProxy(req))));
      sendJson(res, 200, { ok: true });
    }),
  );

  router.get(
    '/api/session',
    authed(async (req, res) => {
      const u = await getUser(me(req).userId);
      sendJson(res, 200, { username: u.username, user: userJson(u), sessionId: me(req).sessionId });
    }),
  );

  // ---------------------------------------------------------------- your account
  router.get(
    '/api/account',
    authed(async (req, res) => {
      const u = await getUser(me(req).userId);
      sendJson(res, 200, { ...userJson(u), internetLogin: policy, fromInternet: !fromLocalNetwork(req), address: clientIp(req) });
    }),
  );

  router.post(
    '/api/account/password',
    authed(async (req, res) => {
      const body = await readJson(req);
      const u = await getUser(me(req).userId);
      if (!(await checkPassword(String(body.current || ''), u.password_hash))) throw new HttpError(400, 'Your current password is wrong', 'invalid_credentials');
      const next = validatePassword(body.password);
      await control().query('update keel.studio_users set password_hash = $2, updated_at = now() where id = $1', [u.id, await hashPassword(next)]);
      const ended = await endSessions('user_id = $1 and id <> $2', [u.id, me(req).sessionId]);
      sendJson(res, 200, { ok: true, endedSessions: ended });
    }),
  );

  router.post(
    '/api/account/2fa/setup',
    authed(async (req, res) => {
      const u = await getUser(me(req).userId);
      const secret = newSecret();
      const uri = otpauthUri(secret, 'Keel Studio', `${u.username}@${config.hostLabel}`);
      sendJson(res, 200, { secret, uri, qr: qrSvg(uri) });
    }),
  );

  router.post(
    '/api/account/2fa/enable',
    authed(async (req, res) => {
      const body = await readJson(req);
      const secret = String(body.secret || '');
      if (!/^[A-Z2-7]{32}$/.test(secret)) throw new HttpError(400, 'Start the setup again', 'bad_request');
      const step = verifyTotp(secret, String(body.code || '').replace(/\s/g, ''));
      if (step === null) throw new HttpError(400, "That code doesn't match. Check the time on your phone and try the next code.", 'invalid_code');
      // Replacing a working setup takes turning it off first, which asks for the password.
      const { rowCount } = await control().query(
        'update keel.studio_users set totp_secret = $2, totp_last_step = $3, updated_at = now() where id = $1 and totp_secret is null',
        [me(req).userId, sealTotp(secret), step],
      );
      if (!rowCount) throw new HttpError(409, 'Two-factor authentication is already on. Turn it off first to set it up again.', 'already_enabled');
      sendJson(res, 200, { ok: true });
    }),
  );

  router.post(
    '/api/account/2fa/disable',
    authed(async (req, res) => {
      const body = await readJson(req);
      const u = await getUser(me(req).userId);
      if (!(await checkPassword(String(body.password || ''), u.password_hash))) throw new HttpError(400, 'Your password is wrong', 'invalid_credentials');
      await control().query('update keel.studio_users set totp_secret = null, totp_last_step = null, updated_at = now() where id = $1', [u.id]);
      sendJson(res, 200, { ok: true });
    }),
  );

  router.get(
    '/api/account/sessions',
    authed(async (req, res) => {
      const { rows } = await control().query(
        `select id, created_at, last_seen_at, expires_at, ip, user_agent, from_internet
           from keel.studio_sessions where user_id = $1 and expires_at > now() order by last_seen_at desc`,
        [me(req).userId],
      );
      sendJson(
        res,
        200,
        rows.map((r) => ({
          id: r.id,
          createdAt: r.created_at,
          lastSeenAt: r.last_seen_at,
          expiresAt: r.expires_at,
          ip: r.ip,
          userAgent: r.user_agent,
          fromInternet: r.from_internet,
          current: r.id === me(req).sessionId,
        })),
      );
    }),
  );

  router.delete(
    '/api/account/sessions/:id',
    authed(async (req, res) => {
      const n = await endSessions('id = $1 and user_id = $2', [req.params.id, me(req).userId]);
      if (!n) throw new HttpError(404, 'No such session', 'not_found');
      sendJson(res, 200, { ok: true });
    }),
  );

  router.post(
    '/api/account/sessions/end-others',
    authed(async (req, res) => {
      const n = await endSessions('user_id = $1 and id <> $2', [me(req).userId, me(req).sessionId]);
      sendJson(res, 200, { ended: n });
    }),
  );

  // ---------------------------------------------------------------- other accounts
  router.get(
    '/api/studio-users',
    authed(async (_req, res) => {
      const { rows } = await control().query(
        `select u.*, (select count(*) from keel.studio_sessions s where s.user_id = u.id and s.expires_at > now())::int as sessions
           from keel.studio_users u order by u.is_owner desc, lower(u.username)`,
      );
      sendJson(
        res,
        200,
        rows.map((u) => ({ ...userJson(u as StudioUser), sessions: u.sessions })),
      );
    }),
  );

  router.post(
    '/api/studio-users',
    authed(async (req, res) => {
      const body = await readJson(req);
      const username = validateUsername(body.username);
      const password = validatePassword(body.password);
      const r = await control()
        .query('insert into keel.studio_users (username, password_hash) values ($1, $2) returning *', [username, await hashPassword(password)])
        .catch((err: { code?: string }) => {
          if (err.code === '23505') throw new HttpError(409, `There is already an account named ${username}`, 'conflict');
          throw err;
        });
      log.info('studio account created', { username, by: me(req).username });
      sendJson(res, 201, userJson(r.rows[0]));
    }),
  );

  /** The owner account is managed through .env and its own Account page only. */
  const other = async (req: Req): Promise<StudioUser> => {
    const u = await getUser(req.params.id);
    if (u.id === me(req).userId) throw new HttpError(400, 'Use Account and security to change your own account', 'bad_request');
    if (u.is_owner) throw new HttpError(403, 'The owner account can only be changed by the owner, or with KEEL_DASHBOARD_PASSWORD in .env', 'forbidden');
    return u;
  };

  router.delete(
    '/api/studio-users/:id',
    authed(async (req, res) => {
      const u = await other(req);
      await endSessions('user_id = $1', [u.id]);
      await control().query('delete from keel.studio_users where id = $1', [u.id]);
      log.info('studio account deleted', { username: u.username, by: me(req).username });
      sendJson(res, 200, { ok: true });
    }),
  );

  router.post(
    '/api/studio-users/:id/password',
    authed(async (req, res) => {
      const u = await other(req);
      const password = validatePassword((await readJson(req)).password);
      await control().query('update keel.studio_users set password_hash = $2, updated_at = now() where id = $1', [u.id, await hashPassword(password)]);
      await endSessions('user_id = $1', [u.id]);
      sendJson(res, 200, { ok: true });
    }),
  );

  router.delete(
    '/api/studio-users/:id/2fa',
    authed(async (req, res) => {
      const u = await other(req);
      await control().query('update keel.studio_users set totp_secret = null, totp_last_step = null, updated_at = now() where id = $1', [u.id]);
      await endSessions('user_id = $1', [u.id]);
      sendJson(res, 200, { ok: true });
    }),
  );

  /** Whether a Studio session is still signed in (for links that can't carry a token). */
  const sessionActive = async (sid: string) => /^[0-9a-f-]{36}$/i.test(sid) && !!(await loadSession(sid));

  return { authed, sessionActive, policy };
}

export type Authed = ReturnType<typeof registerAccountRoutes>['authed'];
