import crypto from 'node:crypto';
import { config, isDocumentedExample } from '../lib/config.js';
import { newClient, waitForDb } from '../lib/db.js';
import { USERNAME_RE, hashPassword, MIN_PASSWORD } from '../studio/accounts.js';

/**
 * Studio account recovery from the server's command line, for when nobody
 * can sign in (lost phone, forgotten password):
 *
 *   keel studio-user list
 *   keel studio-user add <name> [--password P]
 *   keel studio-user reset-password <name> [--password P]   (prints a new one if omitted)
 *   keel studio-user reset-2fa <name>
 *   keel studio-user remove <name>
 *
 * Changing a password or two-factor setting ends that account's sessions.
 */

const out = (s: string) => process.stdout.write(s + '\n');
const fail = (s: string): never => {
  process.stderr.write(`keel: ${s}\n`);
  process.exit(1);
};

function parse(argv: string[]) {
  const positional: string[] = [];
  let password: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--password') password = argv[++i];
    else if (argv[i].startsWith('--password=')) password = argv[i].slice('--password='.length);
    else positional.push(argv[i]);
  }
  return { positional, password };
}

const generated = () => crypto.randomBytes(15).toString('base64url');

export async function main(): Promise<void> {
  const [cmd, ...rest] = process.argv.slice(3);
  const { positional, password } = parse(rest);
  const name = positional[0];
  if (password !== undefined && password.length < MIN_PASSWORD) fail(`passwords need at least ${MIN_PASSWORD} characters`);
  if (password !== undefined && isDocumentedExample(password)) fail('that password is an example from the documentation; choose your own');

  await waitForDb(config.db.controlDb, config.db.superuser, 30_000);
  const c = newClient(config.db.controlDb);
  await c.connect();
  try {
    const find = async () => {
      if (!name) fail(`usage: keel studio-user ${cmd} <username>`);
      const u = (await c.query('select * from keel.studio_users where lower(username) = lower($1)', [name])).rows[0];
      if (!u) fail(`no Studio account named ${name} (see: keel studio-user list)`);
      return u;
    };
    switch (cmd) {
      case 'list': {
        const { rows } = await c.query(
          `select username, is_owner, totp_secret is not null as two_factor, last_login_at,
                  (select count(*) from keel.studio_sessions s where s.user_id = u.id and s.expires_at > now())::int as sessions
             from keel.studio_users u order by is_owner desc, lower(username)`,
        );
        if (!rows.length) {
          out('No Studio accounts yet: keel-studio creates the owner from KEEL_DASHBOARD_USERNAME on its first start.');
          return;
        }
        for (const r of rows) {
          const flags = [r.is_owner ? 'owner' : 'admin', r.two_factor ? '2FA on' : '2FA off', `${r.sessions} session(s)`];
          out(`${r.username.padEnd(32)} ${flags.join(', ')}${r.last_login_at ? `, last sign-in ${new Date(r.last_login_at).toISOString()}` : ''}`);
        }
        return;
      }
      case 'add': {
        if (!name || !USERNAME_RE.test(name)) fail('usage: keel studio-user add <username> [--password P] (letters, digits, ".", "_", "-", "@")');
        const pw = password ?? generated();
        await c
          .query('insert into keel.studio_users (username, password_hash) values ($1, $2)', [name, await hashPassword(pw)])
          .catch((err: { code?: string }) => fail(err.code === '23505' ? `an account named ${name} already exists` : String(err)));
        out(`Added ${name}.`);
        if (password === undefined) out(`Password: ${pw}`);
        return;
      }
      case 'reset-password': {
        const u = await find();
        const pw = password ?? generated();
        await c.query('update keel.studio_users set password_hash = $2, updated_at = now() where id = $1', [u.id, await hashPassword(pw)]);
        await c.query('delete from keel.studio_sessions where user_id = $1', [u.id]);
        out(`New password for ${u.username}${password === undefined ? `: ${pw}` : ' set.'}`);
        if (u.is_owner) out('Note: changing KEEL_DASHBOARD_PASSWORD in .env later resets the owner password again.');
        return;
      }
      case 'reset-2fa': {
        const u = await find();
        await c.query('update keel.studio_users set totp_secret = null, totp_last_step = null, updated_at = now() where id = $1', [u.id]);
        await c.query('delete from keel.studio_sessions where user_id = $1', [u.id]);
        out(`Two-factor authentication is off for ${u.username}. Sign in with the password, then set it up again under Account and security.`);
        return;
      }
      case 'remove': {
        const u = await find();
        if (u.is_owner) fail('the owner account (KEEL_DASHBOARD_USERNAME) can’t be removed');
        await c.query('delete from keel.studio_users where id = $1', [u.id]);
        out(`Removed ${u.username}.`);
        return;
      }
      default:
        fail('usage: keel studio-user <list|add|reset-password|reset-2fa|remove> [username] [--password P]');
    }
  } finally {
    await c.end();
  }
}
