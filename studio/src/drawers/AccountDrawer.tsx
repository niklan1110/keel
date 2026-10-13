import { useState } from 'react';
import { Desktop, Globe, Plus, ShieldCheck, Trash } from '@phosphor-icons/react';
import { del, get, post } from '../api';
import { CopyButton, Loading, Modal, Notice, useAction, useConfirm } from '../components/ui';
import { stamp } from '../lib/format';
import { useLoad } from '../lib/hooks';
import { Shell } from './Shell';

type Account = {
  id: string;
  username: string;
  isOwner: boolean;
  twoFactor: boolean;
  createdAt: string;
  lastLoginAt: string | null;
  internetLogin: 'on' | 'off' | '2fa';
  fromInternet: boolean;
  address: string;
};
type Session = { id: string; createdAt: string; lastSeenAt: string; ip: string | null; userAgent: string | null; fromInternet: boolean; current: boolean };
type StudioUser = { id: string; username: string; isOwner: boolean; twoFactor: boolean; lastLoginAt: string | null; sessions: number };

const POLICY: Record<Account['internetLogin'], string> = {
  '2fa': 'Sign-ins from the internet need two-factor authentication. Your home network and Tailscale only need the password (and the code, once two-factor is on).',
  on: 'Sign-ins from the internet are allowed with the password (and the code, if two-factor is on).',
  off: 'Sign-ins from the internet are turned off. Studio only accepts sign-ins from your home network and Tailscale.',
};

export function AccountDrawer() {
  const account = useLoad(() => get<Account>('/api/account'), []);
  const a = account.data;
  return (
    <Shell label="Account and security" title="Account and security" sub={a ? `Signed in as ${a.username}` : undefined}>
      {!a ? (
        account.error ? (
          <div className="section">
            <Notice kind="err">{account.error.message}</Notice>
          </div>
        ) : (
          <Loading />
        )
      ) : (
        <>
          <div className="section">
            <h3>Sign-in rules</h3>
            <div className="muted" style={{ fontSize: 12.5 }}>
              {POLICY[a.internetLogin]} Change this with <span className="mono">KEEL_STUDIO_INTERNET_LOGIN</span> in .env.
            </div>
            <div className="muted" style={{ fontSize: 12.5, display: 'flex', gap: 6, alignItems: 'center' }}>
              {a.fromInternet ? <Globe size={14} /> : <Desktop size={14} />}
              You're connected from {a.address || 'an unknown address'} ({a.fromInternet ? 'the internet' : 'your network'}).
            </div>
          </div>
          <TwoFactor account={a} onChange={() => account.reload()} />
          <Password />
          <Sessions />
          <Accounts me={a} />
        </>
      )}
    </Shell>
  );
}

function TwoFactor({ account, onChange }: { account: Account; onChange: () => void }) {
  const [setup, setSetup] = useState<{ secret: string; uri: string; qr: string } | null>(null);
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [disabling, setDisabling] = useState(false);
  const { busy, run } = useAction();

  return (
    <div className="section">
      <h3>Two-factor authentication</h3>
      {account.twoFactor ? (
        <>
          <Notice kind="ok">
            <ShieldCheck size={15} /> On. Studio asks for a code from your authenticator app each time you sign in.
          </Notice>
          {!disabling ? (
            <button className="pill md" style={{ alignSelf: 'flex-start' }} onClick={() => setDisabling(true)}>
              Turn off two-factor
            </button>
          ) : (
            <form
              style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}
              onSubmit={async (e) => {
                e.preventDefault();
                const r = await run('off', () => post('/api/account/2fa/disable', { password }), 'Two-factor authentication is off');
                if (r) {
                  setDisabling(false);
                  setPassword('');
                  onChange();
                }
              }}
            >
              <input className="input" type="password" placeholder="Your password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" required style={{ flex: 1, minWidth: 160 }} />
              <button className="pill md danger" disabled={busy === 'off'}>
                Turn off
              </button>
            </form>
          )}
        </>
      ) : !setup ? (
        <>
          <div className="muted" style={{ fontSize: 12.5 }}>
            Protect your account with a 6-digit code from an authenticator app (Google Authenticator, 1Password, Authy, Bitwarden…). Needed to sign in from the internet.
          </div>
          <button
            className="btn-dark md"
            style={{ alignSelf: 'flex-start' }}
            disabled={busy === 'setup'}
            onClick={async () => {
              const r = await run('setup', () => post<{ secret: string; uri: string; qr: string }>('/api/account/2fa/setup'));
              if (r) setSetup(r);
            }}
          >
            Set up two-factor
          </button>
        </>
      ) : (
        <form
          style={{ display: 'flex', flexDirection: 'column', gap: 10 }}
          onSubmit={async (e) => {
            e.preventDefault();
            const r = await run('enable', () => post('/api/account/2fa/enable', { secret: setup.secret, code }), 'Two-factor authentication is on');
            if (r) {
              setSetup(null);
              setCode('');
              onChange();
            }
          }}
        >
          <div className="muted" style={{ fontSize: 12.5 }}>
            1. Scan this code with your authenticator app, or enter the key by hand.
          </div>
          <img
            src={`data:image/svg+xml;utf8,${encodeURIComponent(setup.qr)}`}
            alt="QR code for your authenticator app"
            width={168}
            height={168}
            style={{ background: '#fff', borderRadius: 12, border: '1px solid var(--border)', padding: 6 }}
          />
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <span className="mono" style={{ fontSize: 12, overflowWrap: 'anywhere' }}>
              {setup.secret.replace(/(.{4})/g, '$1 ').trim()}
            </span>
            <CopyButton text={setup.secret} />
          </div>
          <div className="muted" style={{ fontSize: 12.5 }}>
            2. Enter the 6-digit code the app shows.
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <input
              className="input mono"
              inputMode="numeric"
              autoComplete="one-time-code"
              placeholder="123456"
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
              required
              style={{ width: 120 }}
            />
            <button className="btn-dark md" disabled={code.length !== 6 || busy === 'enable'}>
              Turn on
            </button>
            <button type="button" className="pill md" onClick={() => setSetup(null)}>
              Cancel
            </button>
          </div>
        </form>
      )}
    </div>
  );
}

function Password() {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const { busy, run } = useAction();
  return (
    <form
      className="section"
      onSubmit={async (e) => {
        e.preventDefault();
        const r = await run('pw', () => post<{ endedSessions: number }>('/api/account/password', { current, password: next }));
        if (r) {
          setCurrent('');
          setNext('');
        }
      }}
    >
      <h3>Password</h3>
      <label className="field">
        <span>Current password</span>
        <input className="input" type="password" value={current} onChange={(e) => setCurrent(e.target.value)} autoComplete="current-password" required />
      </label>
      <label className="field">
        <span>New password (at least 8 characters)</span>
        <input className="input" type="password" value={next} onChange={(e) => setNext(e.target.value)} autoComplete="new-password" minLength={8} required />
      </label>
      <button className="btn-dark md" style={{ alignSelf: 'flex-start' }} disabled={busy === 'pw'}>
        Change password
      </button>
      <div className="muted" style={{ fontSize: 12 }}>
        Changing it signs out your other sessions.
      </div>
    </form>
  );
}

function Sessions() {
  const sessions = useLoad(() => get<Session[]>('/api/account/sessions'), []);
  const { run } = useAction();
  const list = sessions.data || [];
  return (
    <div className="section">
      <h3>Where you're signed in</h3>
      {!sessions.data ? (
        <Loading />
      ) : (
        <>
          {list.map((s) => (
            <div key={s.id} className="api-row">
              <span style={{ flex: 1, minWidth: 0 }}>
                <span className="val" style={{ fontFamily: 'inherit', fontWeight: 600 }}>
                  {describeAgent(s.userAgent)} {s.current && <span className="tag">This browser</span>}
                </span>
                <span className="lbl">
                  {s.ip || 'unknown address'} · {s.fromInternet ? 'internet' : 'your network'} · active {stamp(s.lastSeenAt)}
                </span>
              </span>
              {!s.current && (
                <button
                  className="pill sm"
                  onClick={async () => {
                    if (await run('end', () => del(`/api/account/sessions/${s.id}`), 'Signed out that session')) sessions.reload();
                  }}
                >
                  Sign out
                </button>
              )}
            </div>
          ))}
          {list.length > 1 && (
            <button
              className="pill md"
              style={{ alignSelf: 'flex-start' }}
              onClick={async () => {
                if (await run('others', () => post('/api/account/sessions/end-others'), 'Signed out everywhere else')) sessions.reload();
              }}
            >
              Sign out everywhere else
            </button>
          )}
        </>
      )}
    </div>
  );
}

function Accounts({ me }: { me: Account }) {
  const users = useLoad(() => get<StudioUser[]>('/api/studio-users'), []);
  const [adding, setAdding] = useState(false);
  const [resetting, setResetting] = useState<StudioUser | null>(null);
  const confirm = useConfirm();
  const { run } = useAction();
  return (
    <div className="section">
      <h3>Studio accounts</h3>
      <div className="muted" style={{ fontSize: 12.5 }}>
        Everyone with a Studio account is a full admin of every project. The owner account comes from <span className="mono">KEEL_DASHBOARD_USERNAME</span>; changing{' '}
        <span className="mono">KEEL_DASHBOARD_PASSWORD</span> in .env resets its password.
      </div>
      {!users.data ? (
        <Loading />
      ) : (
        users.data.map((u) => (
          <div key={u.id} className="api-row">
            <span style={{ flex: 1, minWidth: 0 }}>
              <span className="val" style={{ fontFamily: 'inherit', fontWeight: 600 }}>
                {u.username} {u.isOwner && <span className="tag">Owner</span>} {u.id === me.id && <span className="tag">You</span>}
              </span>
              <span className="lbl">
                {u.twoFactor ? 'Two-factor on' : 'Two-factor off'} · {u.lastLoginAt ? `last sign-in ${stamp(u.lastLoginAt)}` : 'never signed in'}
              </span>
            </span>
            {u.id !== me.id && !u.isOwner && (
              <span style={{ display: 'flex', gap: 6 }}>
                <button className="pill sm" onClick={() => setResetting(u)}>
                  New password
                </button>
                {u.twoFactor && (
                  <button
                    className="pill sm"
                    onClick={async () => {
                      const ok = await confirm({ title: `Turn off two-factor for ${u.username}?`, body: 'Use this when they lost their phone. They can set it up again after signing in.', confirm: 'Turn off' });
                      if (ok && (await run('2fa', () => del(`/api/studio-users/${u.id}/2fa`), `Two-factor is off for ${u.username}`))) users.reload();
                    }}
                  >
                    Reset 2FA
                  </button>
                )}
                <button
                  className="icon-btn"
                  aria-label={`Remove ${u.username}`}
                  title="Remove account"
                  onClick={async () => {
                    const ok = await confirm({ title: `Remove ${u.username}?`, body: 'They are signed out and can no longer open Studio.', confirm: 'Remove', danger: true });
                    if (ok && (await run('rm', () => del(`/api/studio-users/${u.id}`), `Removed ${u.username}`))) users.reload();
                  }}
                >
                  <Trash size={15} />
                </button>
              </span>
            )}
          </div>
        ))
      )}
      <button className="pill md" style={{ alignSelf: 'flex-start' }} onClick={() => setAdding(true)}>
        <Plus size={15} /> Add account
      </button>
      {adding && <AccountModal title="Add a Studio account" onClose={() => setAdding(false)} onDone={() => users.reload()} />}
      {resetting && <AccountModal title={`New password for ${resetting.username}`} user={resetting} onClose={() => setResetting(null)} onDone={() => users.reload()} />}
    </div>
  );
}

function AccountModal({ title, user, onClose, onDone }: { title: string; user?: StudioUser; onClose: () => void; onDone: () => void }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const { busy, run } = useAction();
  return (
    <Modal onClose={onClose} label={title}>
      <form
        style={{ display: 'flex', flexDirection: 'column', gap: 12 }}
        onSubmit={async (e) => {
          e.preventDefault();
          const r = user
            ? await run('save', () => post(`/api/studio-users/${user.id}/password`, { password }), `New password set for ${user.username}`)
            : await run('save', () => post('/api/studio-users', { username, password }), `Added ${username}`);
          if (r) {
            onDone();
            onClose();
          }
        }}
      >
        <h2>{title}</h2>
        {!user && (
          <label className="field">
            <span>Username</span>
            <input className="input" value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="off" required autoFocus />
          </label>
        )}
        <label className="field">
          <span>Password (at least 8 characters)</span>
          <input className="input" type="text" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" minLength={8} required autoFocus={!!user} />
        </label>
        <div className="muted" style={{ fontSize: 12.5 }}>
          Share it with them privately. They can change it, and turn on two-factor, under Account and security.
          {user && ' Their current sessions end.'}
        </div>
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button type="button" className="pill md" onClick={onClose}>
            Cancel
          </button>
          <button className="btn-dark md" disabled={busy === 'save'}>
            {user ? 'Set password' : 'Add account'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function describeAgent(ua: string | null): string {
  if (!ua) return 'Unknown device';
  const browser = /Edg\//.test(ua) ? 'Edge' : /Chrome\//.test(ua) ? 'Chrome' : /Firefox\//.test(ua) ? 'Firefox' : /Safari\//.test(ua) ? 'Safari' : /node|undici|curl/i.test(ua) ? 'Script' : 'Browser';
  const os = /iPhone|iPad/.test(ua) ? 'iOS' : /Android/.test(ua) ? 'Android' : /Mac OS X/.test(ua) ? 'macOS' : /Windows/.test(ua) ? 'Windows' : /Linux/.test(ua) ? 'Linux' : '';
  return os ? `${browser} on ${os}` : browser;
}

