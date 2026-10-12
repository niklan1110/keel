import { useEffect, useState, type ReactNode } from 'react';
import { ArrowLeft, DeviceMobile, DiscordLogo, EnvelopeSimple, GearSix, GithubLogo, GitlabLogo, GoogleLogo, IdentificationCard, MagnifyingGlass, Phone, Plus, ShieldCheck, Trash, User, UserPlus, WindowsLogo } from '@phosphor-icons/react';
import { del, get, post, put } from '../api';
import { CopyButton, Loading, Notice, Switch, useAction, useConfirm } from '../components/ui';
import { projectPath, useStudio } from '../ctx';
import { count, stamp, when } from '../lib/format';
import { useLoad } from '../lib/hooks';
import { Shell } from './Shell';

type Factor = { id: string; type: 'totp' | 'phone'; name: string | null; status: 'verified' | 'unverified'; phone: string | null; createdAt: string };

type U = {
  id: string;
  email: string | null;
  phone: string | null;
  factors: Factor[];
  createdAt: string;
  lastSignInAt: string | null;
  confirmedAt: string | null;
  invitedAt: string | null;
  bannedUntil: string | null;
  anonymous: boolean;
  providers: string[];
  metadata: Record<string, unknown>;
  appMetadata: Record<string, unknown>;
};

type Builtin = 'github' | 'google' | 'discord' | 'gitlab' | 'azure';

type CustomProvider = {
  id: string;
  enabled: boolean;
  name: string;
  icon_url: string;
  issuer: string;
  client_id: string;
  scopes: string;
  allow_http: boolean;
  has_secret: boolean;
  secret?: string;
  /** Not saved yet: the identifier can still change. */
  isNew?: boolean;
};

type BuiltinInfo = {
  id: Builtin;
  name: string;
  icon: (size: number) => ReactNode;
  url?: { label: string; placeholder: string; help: string; http?: boolean };
};

const BUILTINS: BuiltinInfo[] = [
  { id: 'github', name: 'GitHub', icon: (n) => <GithubLogo size={n} /> },
  { id: 'google', name: 'Google', icon: (n) => <GoogleLogo size={n} /> },
  { id: 'discord', name: 'Discord', icon: (n) => <DiscordLogo size={n} /> },
  {
    id: 'gitlab',
    name: 'GitLab',
    icon: (n) => <GitlabLogo size={n} />,
    url: { label: 'GitLab URL', placeholder: 'https://gitlab.com', help: 'Leave empty for gitlab.com, or enter the address of your own GitLab.', http: true },
  },
  {
    id: 'azure',
    name: 'Microsoft (Azure / Entra ID)',
    icon: (n) => <WindowsLogo size={n} />,
    url: { label: 'Tenant URL', placeholder: 'https://login.microsoftonline.com/common', help: 'Leave empty for any Microsoft account, or use https://login.microsoftonline.com/<tenant id>.' },
  },
];

type Settings = {
  site_url: string;
  uri_allow_list: string[];
  jwt_exp: number;
  disable_signup: boolean;
  mailer_autoconfirm: boolean | null;
  anonymous_users: boolean;
  password_min_length: number;
  external: Record<Builtin, { enabled: boolean; client_id: string; has_secret: boolean; secret?: string; url: string; allow_http: boolean }>;
  custom_providers: CustomProvider[];
  smtp: { host: string; port: number; user: string; from: string; secure: boolean; has_pass: boolean; pass?: string };
  global_smtp: boolean;
  /** False when the server's public URL may be reachable from the internet. */
  public_url_private: boolean;
  phone: {
    enabled: boolean;
    configured: boolean;
    autoconfirm: boolean;
    provider: '' | 'twilio' | 'vonage' | 'messagebird' | 'webhook' | 'log';
    template: string;
    otp_exp: number;
    otp_length: number;
    test_otp: string;
    twilio: { account_sid: string; message_service_sid: string; from: string; has_secret: boolean; auth_token?: string };
    vonage: { api_key: string; from: string; has_secret: boolean; api_secret?: string };
    messagebird: { originator: string; has_secret: boolean; access_key?: string };
    webhook: { url: string; has_secret: boolean; secret?: string };
  };
  mfa: { totp: boolean; phone: boolean; max_enrolled_factors: number };
};

const hasMail = (s: Settings) => !!s.smtp.host || s.global_smtp;
/** Anyone can sign up and is signed in at once, without proving their address. */
const openSignups = (s: Settings) => !s.disable_signup && (s.mailer_autoconfirm ?? !hasMail(s));

function OpenSignupsNotice({ s }: { s: Settings }) {
  if (!openSignups(s)) return null;
  return (
    <Notice kind={s.public_url_private ? 'warn' : 'err'}>
      Anyone {s.public_url_private ? 'who can reach this server' : 'on the internet'} can create an account and is signed in right away, without confirming an email address. Policies for{' '}
      <code>authenticated</code> let them in. Turn off <b>Allow new sign-ups</b>, or set up a mail server and turn on <b>Confirm email addresses</b>.
    </Notice>
  );
}

function NoMailNotice({ s }: { s: Settings }) {
  if (hasMail(s)) return null;
  return (
    <Notice kind="warn">
      No mail server. Confirmation, magic link and password reset emails are not sent, and their links are not logged. Invite and password reset links you create here are shown to you to pass on.
    </Notice>
  );
}

const label = (u: U) => u.email || (u.phone ? `+${u.phone}` : 'Anonymous user');

function status(u: U): { label: string; cls: string } {
  if (u.bannedUntil) return { label: 'Banned', cls: 'err' };
  if (u.anonymous) return { label: 'Anonymous', cls: 'neutral' };
  if (u.confirmedAt) return { label: 'Confirmed', cls: 'ok' };
  if (u.invitedAt) return { label: 'Invited', cls: 'warn' };
  return { label: 'Unconfirmed', cls: 'warn' };
}

function ProviderIcon({ u, size = 16 }: { u: U; size?: number }) {
  const p = u.providers.find((x) => x !== 'email') || u.providers[0];
  if (p === 'github') return <GithubLogo size={size} />;
  if (p === 'google') return <GoogleLogo size={size} />;
  if (p === 'discord') return <DiscordLogo size={size} />;
  if (p === 'gitlab') return <GitlabLogo size={size} />;
  if (p === 'azure') return <WindowsLogo size={size} />;
  if (p?.startsWith('custom:')) return <IdentificationCard size={size} />;
  if (p === 'anonymous' || u.anonymous) return <User size={size} />;
  if (p === 'phone') return <Phone size={size} />;
  return <EnvelopeSimple size={size} />;
}

export function UsersDrawer() {
  const { project, overview, reloadOverview } = useStudio();
  const base = projectPath(project);
  const [search, setSearch] = useState('');
  const [q, setQ] = useState('');
  const [view, setView] = useState<'list' | 'settings' | { user: U }>('list');
  const [invite, setInvite] = useState<null | 'invite' | 'create'>(null);
  const users = useLoad(() => get<{ total: number; users: U[] }>(`${base}/users?limit=100&search=${encodeURIComponent(q)}`), [base, q]);
  const settings = useLoad(() => get<Settings>(`${base}/settings`), [base]);

  useEffect(() => {
    const t = setTimeout(() => setQ(search.trim()), 250);
    return () => clearTimeout(t);
  }, [search]);

  const providers = ['email', settings.data?.phone.enabled && settings.data.phone.configured && 'phone', settings.data?.external.github.enabled && 'GitHub', settings.data?.external.google.enabled && 'Google', settings.data?.anonymous_users && 'anonymous'].filter(Boolean);
  const total = overview?.users ?? users.data?.total ?? 0;
  const sub = `${count(total)} user${total === 1 ? '' : 's'}, ${providers.join(', ').replace(/, ([^,]*)$/, ' and $1')}`;

  const refresh = async () => {
    await users.reload();
    void reloadOverview();
  };

  if (view === 'settings') {
    return (
      <Shell label="Auth settings" title="Users" sub="Sign-in settings">
        <AuthSettings base={base} initial={settings.data} onBack={() => setView('list')} onSaved={(s) => settings.setData(s)} />
      </Shell>
    );
  }
  if (typeof view === 'object') {
    return (
      <Shell label="User" title="Users" sub={label(view.user)}>
        <UserDetail base={base} user={view.user} onBack={() => setView('list')} onChanged={refresh} />
      </Shell>
    );
  }

  return (
    <Shell
      label="Users"
      title="Users"
      sub={sub}
      actions={
        <button className="icon-btn" aria-label="Sign-in settings" title="Sign-in settings" onClick={() => setView('settings')}>
          <GearSix size={15} />
        </button>
      }
    >
      <div className="toolbar" style={{ gap: 8, flexWrap: 'nowrap' }}>
        <label className="search-pill" style={{ flex: 1 }}>
          <MagnifyingGlass size={15} />
          <input aria-label="Search users" placeholder="Search users…" value={search} onChange={(e) => setSearch(e.target.value)} />
        </label>
        <button className="pill lg" onClick={() => setInvite(invite === 'create' ? null : 'create')} title="Add a user with a password">
          <Plus size={15} />
          Add
        </button>
        <button className="btn-dark" style={{ height: 34 }} onClick={() => setInvite(invite === 'invite' ? null : 'invite')}>
          <UserPlus size={15} />
          Invite
        </button>
      </div>
      {settings.data && (openSignups(settings.data) || !hasMail(settings.data)) && (
        <div className="section">
          <OpenSignupsNotice s={settings.data} />
          <NoMailNotice s={settings.data} />
        </div>
      )}
      {invite && <InviteForm base={base} mode={invite} onDone={refresh} onClose={() => setInvite(null)} />}
      {!users.data ? (
        users.error ? <div className="section"><Notice kind="err">{users.error.message}</Notice></div> : <Loading />
      ) : users.data.users.length === 0 ? (
        <div className="empty">
          <b>{q ? 'No users match' : 'No users yet'}</b>
          {q ? 'Try another email or user id.' : 'Users appear here when they sign up through your app, or when you invite them.'}
        </div>
      ) : (
        users.data.users.map((u) => {
          const s = status(u);
          return (
            <button key={u.id} className="user-row" onClick={() => setView({ user: u })}>
              <span className="avatar">
                <ProviderIcon u={u} />
              </span>
              <span className="two-line">
                <span className="a">{label(u)}</span>
                <span className="b">Last sign-in {when(u.lastSignInAt)}</span>
              </span>
              {u.factors.some((f) => f.status === 'verified') && (
                <span title="Uses two-factor authentication" style={{ display: 'inline-flex', color: 'var(--ok-fg)' }}>
                  <ShieldCheck size={16} />
                </span>
              )}
              <span className={`badge ${s.cls}`}>{s.label}</span>
            </button>
          );
        })
      )}
    </Shell>
  );
}

function InviteForm({ base, mode, onDone, onClose }: { base: string; mode: 'invite' | 'create'; onDone: () => void; onClose: () => void }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [link, setLink] = useState<string | null>(null);
  const { busy, run } = useAction();
  return (
    <form
      className="section"
      style={{ borderBottom: '1px solid var(--divider)' }}
      onSubmit={async (e) => {
        e.preventDefault();
        if (mode === 'invite') {
          const r = await run('send', () => post<{ emailed: boolean; link?: string }>(`${base}/users/invite`, { email }));
          if (r) {
            if (r.emailed) onClose();
            else setLink(r.link || null);
            onDone();
          }
        } else {
          const isPhone = /^\+?[\d\s().-]{7,}$/.test(email.trim());
          const r = await run('send', () => post(`${base}/users`, { ...(isPhone ? { phone: email } : { email }), password, autoConfirm: true }), `Added ${email}`);
          if (r) {
            onDone();
            onClose();
          }
        }
      }}
    >
      <h3>{mode === 'invite' ? 'Invite a user' : 'Add a user'}</h3>
      {link ? (
        <>
          <Notice kind="ok">No mail server is configured, so share this invite link with {email} yourself. It works once, for an hour.</Notice>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <input className="input mono" readOnly value={link} onFocus={(e) => e.target.select()} />
            <CopyButton text={link} />
          </div>
          <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
            <button type="button" className="pill md" onClick={onClose}>
              Done
            </button>
          </div>
        </>
      ) : (
        <>
          <div className={mode === 'create' ? 'form-grid' : ''}>
            <label className="field">
              <span>{mode === 'create' ? 'Email or phone' : 'Email'}</span>
              <input className="input" type={mode === 'create' ? 'text' : 'email'} required value={email} onChange={(e) => setEmail(e.target.value)} placeholder={mode === 'create' ? 'ana@example.com or +15555550100' : undefined} autoFocus />
            </label>
            {mode === 'create' && (
              <label className="field">
                <span>Password</span>
                <input className="input" type="password" minLength={6} required value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" />
              </label>
            )}
          </div>
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <button type="button" className="pill md" onClick={onClose}>
              Cancel
            </button>
            <button className="btn-dark md" disabled={busy === 'send'}>
              {busy === 'send' ? 'Working…' : mode === 'invite' ? 'Send invite' : 'Add user'}
            </button>
          </div>
        </>
      )}
    </form>
  );
}

function UserDetail({ base, user, onBack, onChanged }: { base: string; user: U; onBack: () => void; onChanged: () => void }) {
  const { busy, run } = useAction();
  const confirm = useConfirm();
  const [link, setLink] = useState<string | null>(null);
  const s = status(user);
  return (
    <>
      <div className="toolbar">
        <button className="pill" onClick={onBack}>
          <ArrowLeft size={14} /> All users
        </button>
        <span className={`badge ${s.cls} grow`}>{s.label}</span>
      </div>
      <div className="section">
        <dl className="kv">
          <dt>User ID</dt>
          <dd className="mono" style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <span style={{ overflowWrap: 'anywhere' }}>{user.id}</span>
            <CopyButton text={user.id} />
          </dd>
          <dt>Email</dt>
          <dd>{user.email || '–'}</dd>
          <dt>Phone</dt>
          <dd>{user.phone ? `+${user.phone}` : '–'}</dd>
          <dt>Sign-in methods</dt>
          <dd>{user.providers.join(', ') || '–'}</dd>
          <dt>Created</dt>
          <dd>{stamp(user.createdAt)}</dd>
          <dt>Last sign-in</dt>
          <dd>{when(user.lastSignInAt)}</dd>
          <dt>Confirmed</dt>
          <dd>{user.confirmedAt ? stamp(user.confirmedAt) : 'No'}</dd>
          {user.bannedUntil && (
            <>
              <dt>Banned until</dt>
              <dd>{stamp(user.bannedUntil)}</dd>
            </>
          )}
        </dl>
        {Object.keys(user.metadata || {}).length > 0 && (
          <div className="field">
            <span>User metadata</span>
            <pre className="snippet" style={{ fontSize: 11.5 }}>{JSON.stringify(user.metadata, null, 2)}</pre>
          </div>
        )}
      </div>
      {user.factors.length > 0 && (
        <div className="section">
          <h3>Two-factor authentication</h3>
          <div className="row-list">
            {user.factors.map((f) => (
              <div key={f.id} className="file-row" style={{ cursor: 'default' }}>
                {f.type === 'totp' ? <ShieldCheck size={17} color="var(--muted)" /> : <DeviceMobile size={17} color="var(--muted)" />}
                <span className="two-line" style={{ flex: 1, minWidth: 0 }}>
                  <span className="a">{f.name || (f.type === 'totp' ? 'Authenticator app' : 'Phone')}</span>
                  <span className="b">
                    {f.type === 'totp' ? 'Authenticator app (TOTP)' : `SMS to +${f.phone}`} · added {when(f.createdAt)}
                  </span>
                </span>
                <span className={`badge sm ${f.status === 'verified' ? 'ok' : 'warn'}`}>{f.status === 'verified' ? 'Active' : 'Not finished'}</span>
                <button
                  className="icon-btn"
                  aria-label="Remove factor"
                  title="Remove factor (if the user lost their device)"
                  onClick={async () => {
                    if (!(await confirm({ title: 'Remove this factor?', body: 'The user can sign in without it and set up a new one. Do this when someone has lost their phone or authenticator app.', confirm: 'Remove', danger: true }))) return;
                    const r = await run('factor', () => del(`${base}/users/${user.id}/factors/${f.id}`), 'Factor removed');
                    if (r) {
                      onChanged();
                      onBack();
                    }
                  }}
                >
                  <Trash size={15} />
                </button>
              </div>
            ))}
          </div>
        </div>
      )}
      <div className="section">
        <h3>Actions</h3>
        {link && (
          <>
            <Notice kind="ok">No mail server is configured. Send this password reset link to the user; it works once, for an hour.</Notice>
            <div style={{ display: 'flex', gap: 8 }}>
              <input className="input mono" readOnly value={link} onFocus={(e) => e.target.select()} />
              <CopyButton text={link} />
            </div>
          </>
        )}
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {user.email && (
            <button
              className="pill md"
              disabled={busy === 'recover'}
              onClick={async () => {
                const r = await run('recover', () => post<{ emailed: boolean; link?: string }>(`${base}/users/${user.id}/recovery`));
                if (r?.emailed) setLink(null);
                if (r && !r.emailed) setLink(r.link || null);
              }}
            >
              Password reset link
            </button>
          )}
          <button
            className="pill md"
            onClick={async () => {
              const banned = !!user.bannedUntil;
              const r = await run('ban', () => post(`${base}/users/${user.id}/ban`, { duration: banned ? 'none' : '876000h' }), banned ? 'User unbanned' : 'User banned and signed out');
              if (r) {
                onChanged();
                onBack();
              }
            }}
          >
            {user.bannedUntil ? 'Unban' : 'Ban user'}
          </button>
          <button
            className="pill md danger"
            onClick={async () => {
              if (!(await confirm({ title: 'Delete this user?', body: `${user.email || user.id} is removed with their sessions and identities. Rows that reference them may be deleted too (on delete cascade).`, confirm: 'Delete user', danger: true }))) return;
              const r = await run('delete', () => del(`${base}/users/${user.id}`), 'User deleted');
              if (r) {
                onChanged();
                onBack();
              }
            }}
          >
            Delete user
          </button>
        </div>
      </div>
    </>
  );
}

function AuthSettings({ base, initial, onBack, onSaved }: { base: string; initial: Settings | null; onBack: () => void; onSaved: (s: Settings) => void }) {
  const { instance, project } = useStudio();
  const [s, setS] = useState<Settings | null>(initial);
  const [allow, setAllow] = useState((initial?.uri_allow_list || []).join('\n'));
  const { busy, run } = useAction();
  useEffect(() => {
    if (initial && !s) {
      setS(initial);
      setAllow(initial.uri_allow_list.join('\n'));
    }
  }, [initial, s]);
  if (!s) return <Loading />;
  const callback = `${instance.publicUrl}/${project}/auth/v1/callback`;
  const smtpOn = hasMail(s);
  const set = (patch: Partial<Settings>) => setS({ ...s, ...patch });
  const ext = (p: Builtin, patch: Partial<Settings['external']['github']>) => set({ external: { ...s.external, [p]: { ...s.external[p], ...patch } } });

  return (
    <form
      onSubmit={async (e) => {
        e.preventDefault();
        const body = {
          ...s,
          uri_allow_list: allow.split('\n').map((x) => x.trim()).filter(Boolean),
          custom_providers: s.custom_providers.map(({ isNew: _new, has_secret: _has, ...p }) => p),
        };
        const r = await run('save', () => put<Settings>(`${base}/settings`, body), 'Sign-in settings saved');
        if (r) {
          setS(r);
          onSaved(r);
        }
      }}
    >
      <div className="toolbar">
        <button type="button" className="pill" onClick={onBack}>
          <ArrowLeft size={14} /> All users
        </button>
        <button className="btn-dark grow" disabled={busy === 'save'}>
          {busy === 'save' ? 'Saving…' : 'Save settings'}
        </button>
      </div>
      <div className="section">
        <h3>URLs</h3>
        <label className="field">
          <span>Site URL</span>
          <input className="input mono" placeholder="http://localhost:5173" value={s.site_url} onChange={(e) => set({ site_url: e.target.value })} />
          <small>Your app's address. Confirmation, magic link and password reset emails send people here.</small>
        </label>
        <label className="field">
          <span>Other allowed redirect URLs</span>
          <textarea className="textarea mono" rows={3} placeholder={'http://192.168.1.20:3000/**\nmyapp://auth-callback'} value={allow} onChange={(e) => setAllow(e.target.value)} />
          <small>One per line. Use * for one path segment and ** for any path.</small>
        </label>
      </div>
      <div className="section">
        <h3>Email sign-in</h3>
        <OpenSignupsNotice s={s} />
        <div className="setting">
          <span className="two-line">
            <span className="a">Allow new sign-ups</span>
            <span className="b">Turn off to only allow invited or admin-created users.</span>
          </span>
          <Switch label="Allow new sign-ups" checked={!s.disable_signup} onChange={(v) => set({ disable_signup: !v })} />
        </div>
        <div className="setting">
          <span className="two-line">
            <span className="a">Confirm email addresses</span>
            <span className="b">{smtpOn ? 'New users must click a link before signing in.' : 'Needs a mail server. Without one, new accounts are confirmed automatically.'}</span>
          </span>
          <Switch label="Confirm email" checked={s.mailer_autoconfirm === null ? smtpOn : !s.mailer_autoconfirm} onChange={(v) => set({ mailer_autoconfirm: !v })} />
        </div>
        <div className="setting">
          <span className="two-line">
            <span className="a">Anonymous sign-ins</span>
            <span className="b">Let apps create guest users with signInAnonymously().</span>
          </span>
          <Switch label="Anonymous sign-ins" checked={s.anonymous_users} onChange={(v) => set({ anonymous_users: v })} />
        </div>
        <div className="form-grid">
          <label className="field">
            <span>Minimum password length</span>
            <input className="input" type="number" min={6} max={72} value={s.password_min_length} onChange={(e) => set({ password_min_length: Number(e.target.value) })} />
          </label>
          <label className="field">
            <span>Session token lifetime (seconds)</span>
            <input className="input" type="number" min={60} value={s.jwt_exp} onChange={(e) => set({ jwt_exp: Number(e.target.value) })} />
          </label>
        </div>
      </div>
      <PhoneSettings s={s} set={set} />
      <div className="section">
        <h3>Two-factor authentication (MFA)</h3>
        <div className="setting">
          <span className="two-line">
            <span className="a">Authenticator apps (TOTP)</span>
            <span className="b">Users can add Google Authenticator, 1Password, Authy… with supabase.auth.mfa.enroll().</span>
          </span>
          <Switch label="Authenticator apps" checked={s.mfa.totp} onChange={(v) => set({ mfa: { ...s.mfa, totp: v } })} />
        </div>
        <div className="setting">
          <span className="two-line">
            <span className="a">SMS codes as a second factor</span>
            <span className="b">{s.phone.configured ? 'Sends a code to a phone number the user registers.' : 'Needs an SMS provider (set one up under Phone sign-in).'}</span>
          </span>
          <Switch label="SMS second factor" checked={s.mfa.phone} disabled={!s.phone.configured} onChange={(v) => set({ mfa: { ...s.mfa, phone: v } })} />
        </div>
        <small className="dim">
          MFA is enforced by your policies: require <span className="mono">(auth.jwt() -&gt;&gt; 'aal') = 'aal2'</span> where it matters.
        </small>
      </div>
      <div className="section">
        <h3>Sign in with other providers</h3>
        <small className="dim">Register this callback URL with every provider you turn on:</small>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <input className="input mono" readOnly value={callback} onFocus={(e) => e.target.select()} aria-label="Callback URL" />
          <CopyButton text={callback} />
        </div>
      </div>
      {BUILTINS.map((b) => {
        const p = s.external[b.id];
        return (
          <div className="section" key={b.id}>
            <div className="setting">
              <span className="two-line">
                <span className="a" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  {b.icon(16)} {b.name}
                </span>
                <span className="b mono">provider: '{b.id}'</span>
              </span>
              <Switch label={`Enable ${b.name}`} checked={p.enabled} onChange={(v) => ext(b.id, { enabled: v })} />
            </div>
            {p.enabled && (
              <div className="form-grid">
                <label className="field">
                  <span>Client ID</span>
                  <input className="input mono" value={p.client_id} onChange={(e) => ext(b.id, { client_id: e.target.value })} />
                </label>
                <label className="field">
                  <span>Client secret</span>
                  <input className="input mono" type="password" placeholder={p.has_secret ? '•••••••• (saved)' : ''} value={p.secret || ''} onChange={(e) => ext(b.id, { secret: e.target.value })} autoComplete="off" />
                </label>
                {b.url && (
                  <label className="field">
                    <span>{b.url.label}</span>
                    <input className="input mono" placeholder={b.url.placeholder} value={p.url} onChange={(e) => ext(b.id, { url: e.target.value })} />
                    <small>{b.url.help}</small>
                  </label>
                )}
              </div>
            )}
            {p.enabled && b.url?.http && (
              <div className="setting">
                <span className="two-line">
                  <span className="a">Allow plain http on your own network</span>
                  <span className="b">Only for a server on your LAN without https. Keel refuses http to addresses on the internet.</span>
                </span>
                <Switch label={`Allow http for ${b.name}`} checked={p.allow_http} onChange={(v) => ext(b.id, { allow_http: v })} />
              </div>
            )}
          </div>
        );
      })}
      <CustomProviders s={s} set={set} />
      <div className="section">
        <h3>Mail server</h3>
        <NoMailNotice s={s} />
        {s.global_smtp && !s.smtp.host && <Notice>Using the SMTP server from the stack's .env. Fill these in to use a different one for this project.</Notice>}
        <div className="form-grid">
          <label className="field">
            <span>SMTP host</span>
            <input className="input mono" placeholder="smtp.example.com" value={s.smtp.host} onChange={(e) => set({ smtp: { ...s.smtp, host: e.target.value } })} />
          </label>
          <label className="field">
            <span>Port</span>
            <input className="input" type="number" value={s.smtp.port} onChange={(e) => set({ smtp: { ...s.smtp, port: Number(e.target.value) } })} />
          </label>
          <label className="field">
            <span>Username</span>
            <input className="input mono" value={s.smtp.user} onChange={(e) => set({ smtp: { ...s.smtp, user: e.target.value } })} autoComplete="off" />
          </label>
          <label className="field">
            <span>Password</span>
            <input className="input mono" type="password" placeholder={s.smtp.has_pass ? '•••••••• (saved)' : ''} value={s.smtp.pass || ''} onChange={(e) => set({ smtp: { ...s.smtp, pass: e.target.value } })} autoComplete="off" />
          </label>
          <label className="field">
            <span>From</span>
            <input className="input" placeholder="My App <no-reply@example.com>" value={s.smtp.from} onChange={(e) => set({ smtp: { ...s.smtp, from: e.target.value } })} />
          </label>
          <label className="check" style={{ alignSelf: 'end', height: 34 }}>
            <input type="checkbox" checked={s.smtp.secure} onChange={(e) => set({ smtp: { ...s.smtp, secure: e.target.checked } })} />
            Use TLS from the start (port 465)
          </label>
        </div>
      </div>
    </form>
  );
}

const PROVIDERS: { id: Settings['phone']['provider']; label: string }[] = [
  { id: 'twilio', label: 'Twilio' },
  { id: 'vonage', label: 'Vonage' },
  { id: 'messagebird', label: 'MessageBird' },
  { id: 'webhook', label: 'Webhook (your own gateway)' },
  { id: 'log', label: 'Testing only (not sent)' },
];

const blankProvider = (): CustomProvider => ({
  id: 'custom:',
  enabled: true,
  name: '',
  icon_url: '',
  issuer: '',
  client_id: '',
  scopes: 'email profile',
  allow_http: false,
  has_secret: false,
  secret: '',
  isNew: true,
});

/** Any OpenID Connect provider: Authentik, Keycloak, Authelia, Pocket ID, Zitadel... */
function CustomProviders({ s, set }: { s: Settings; set: (patch: Partial<Settings>) => void }) {
  const list = s.custom_providers;
  const update = (i: number, patch: Partial<CustomProvider>) => set({ custom_providers: list.map((p, j) => (j === i ? { ...p, ...patch } : p)) });
  const remove = (i: number) => set({ custom_providers: list.filter((_, j) => j !== i) });
  return (
    <div className="section">
      <div className="setting">
        <span className="two-line">
          <span className="a" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <IdentificationCard size={16} /> OpenID Connect providers
          </span>
          <span className="b">Authentik, Keycloak, Authelia, Pocket ID, Zitadel or any other OpenID Connect provider.</span>
        </span>
        <button type="button" className="pill" onClick={() => set({ custom_providers: [...list, blankProvider()] })} disabled={list.length >= 20}>
          <Plus size={14} /> Add
        </button>
      </div>
      {list.map((p, i) => (
        <div key={p.isNew ? `new-${i}` : p.id} style={{ border: '1px solid var(--line, #e3e4e7)', borderRadius: 12, padding: 12, display: 'grid', gap: 10 }}>
          <div className="setting">
            <span className="two-line">
              <span className="a">{p.name || p.id}</span>
              <span className="b mono">{`signInWithOAuth({ provider: '${p.id}' })`}</span>
            </span>
            <Switch label={`Enable ${p.id}`} checked={p.enabled} onChange={(v) => update(i, { enabled: v })} />
          </div>
          <div className="form-grid">
            <label className="field">
              <span>Identifier</span>
              <input className="input mono" value={p.id} readOnly={!p.isNew} placeholder="custom:authentik" onChange={(e) => update(i, { id: e.target.value.toLowerCase() })} />
              <small>{p.isNew ? '"custom:" and lowercase letters, digits or hyphens. It can\'t be changed later.' : 'Apps sign in with this name.'}</small>
            </label>
            <label className="field">
              <span>Display name</span>
              <input className="input" value={p.name} placeholder="Authentik" onChange={(e) => update(i, { name: e.target.value })} />
            </label>
            <label className="field">
              <span>Issuer URL</span>
              <input className="input mono" value={p.issuer} placeholder="https://auth.example.com/application/o/my-app/" onChange={(e) => update(i, { issuer: e.target.value })} />
              <small>Keel reads &lt;issuer&gt;/.well-known/openid-configuration.</small>
            </label>
            <label className="field">
              <span>Scopes</span>
              <input className="input mono" value={p.scopes} placeholder="email profile" onChange={(e) => update(i, { scopes: e.target.value })} />
              <small>openid is always added.</small>
            </label>
            <label className="field">
              <span>Client ID</span>
              <input className="input mono" value={p.client_id} onChange={(e) => update(i, { client_id: e.target.value })} />
            </label>
            <label className="field">
              <span>Client secret</span>
              <input className="input mono" type="password" placeholder={p.has_secret ? '•••••••• (saved)' : ''} value={p.secret || ''} onChange={(e) => update(i, { secret: e.target.value })} autoComplete="off" />
            </label>
            <label className="field">
              <span>Icon URL (optional)</span>
              <input className="input mono" value={p.icon_url} placeholder="https://auth.example.com/static/icon.svg" onChange={(e) => update(i, { icon_url: e.target.value })} />
            </label>
          </div>
          <div className="setting">
            <span className="two-line">
              <span className="a">Allow plain http on your own network</span>
              <span className="b">For a provider on your LAN without https. Keel still refuses http to addresses on the internet.</span>
            </span>
            <Switch label={`Allow http for ${p.id}`} checked={p.allow_http} onChange={(v) => update(i, { allow_http: v })} />
          </div>
          <div>
            <button type="button" className="pill" onClick={() => remove(i)}>
              <Trash size={14} /> Remove
            </button>
          </div>
        </div>
      ))}
      {list.length > 0 && <small className="dim">Changes take effect when you save.</small>}
    </div>
  );
}

function PhoneSettings({ s, set }: { s: Settings; set: (patch: Partial<Settings>) => void }) {
  const ph = s.phone;
  const up = (patch: Partial<Settings['phone']>) => set({ phone: { ...ph, ...patch } });
  const secretPh = (has: boolean) => (has ? '•••••••• (saved)' : '');
  return (
    <div className="section">
      <div className="setting">
        <span className="two-line">
          <span className="a" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <Phone size={16} /> Phone sign-in
          </span>
          <span className="b">Sign in with a code sent by SMS: signInWithOtp({'{'} phone {'}'}), or phone + password.</span>
        </span>
        <Switch label="Phone sign-in" checked={ph.enabled} onChange={(v) => up({ enabled: v })} />
      </div>
      <label className="field">
        <span>SMS provider</span>
        <select className="select" value={ph.provider} onChange={(e) => up({ provider: e.target.value as Settings['phone']['provider'] })}>
          <option value="">Choose…</option>
          {PROVIDERS.map((p) => (
            <option key={p.id} value={p.id}>
              {p.label}
            </option>
          ))}
        </select>
      </label>
      {ph.provider === 'log' && <Notice kind="warn">Nothing is sent, and codes are not logged. Only test numbers below, with their fixed codes, can sign in. Use this for testing, never for real users.</Notice>}
      {ph.provider === 'twilio' && (
        <div className="form-grid">
          <label className="field">
            <span>Account SID</span>
            <input className="input mono" value={ph.twilio.account_sid} onChange={(e) => up({ twilio: { ...ph.twilio, account_sid: e.target.value } })} />
          </label>
          <label className="field">
            <span>Auth token</span>
            <input className="input mono" type="password" autoComplete="off" placeholder={secretPh(ph.twilio.has_secret)} value={ph.twilio.auth_token || ''} onChange={(e) => up({ twilio: { ...ph.twilio, auth_token: e.target.value } })} />
          </label>
          <label className="field">
            <span>Messaging Service SID</span>
            <input className="input mono" placeholder="MG… (or use From)" value={ph.twilio.message_service_sid} onChange={(e) => up({ twilio: { ...ph.twilio, message_service_sid: e.target.value } })} />
          </label>
          <label className="field">
            <span>From number</span>
            <input className="input mono" placeholder="+15550001111" value={ph.twilio.from} onChange={(e) => up({ twilio: { ...ph.twilio, from: e.target.value } })} />
          </label>
        </div>
      )}
      {ph.provider === 'vonage' && (
        <div className="form-grid">
          <label className="field">
            <span>API key</span>
            <input className="input mono" value={ph.vonage.api_key} onChange={(e) => up({ vonage: { ...ph.vonage, api_key: e.target.value } })} />
          </label>
          <label className="field">
            <span>API secret</span>
            <input className="input mono" type="password" autoComplete="off" placeholder={secretPh(ph.vonage.has_secret)} value={ph.vonage.api_secret || ''} onChange={(e) => up({ vonage: { ...ph.vonage, api_secret: e.target.value } })} />
          </label>
          <label className="field">
            <span>From</span>
            <input className="input mono" placeholder="MyApp or +15550001111" value={ph.vonage.from} onChange={(e) => up({ vonage: { ...ph.vonage, from: e.target.value } })} />
          </label>
        </div>
      )}
      {ph.provider === 'messagebird' && (
        <div className="form-grid">
          <label className="field">
            <span>Access key</span>
            <input className="input mono" type="password" autoComplete="off" placeholder={secretPh(ph.messagebird.has_secret)} value={ph.messagebird.access_key || ''} onChange={(e) => up({ messagebird: { ...ph.messagebird, access_key: e.target.value } })} />
          </label>
          <label className="field">
            <span>Originator</span>
            <input className="input mono" placeholder="MyApp" value={ph.messagebird.originator} onChange={(e) => up({ messagebird: { ...ph.messagebird, originator: e.target.value } })} />
          </label>
        </div>
      )}
      {ph.provider === 'webhook' && (
        <>
          <div className="form-grid">
            <label className="field">
              <span>Webhook URL</span>
              <input className="input mono" placeholder="http://192.168.1.50:8080/sms" value={ph.webhook.url} onChange={(e) => up({ webhook: { ...ph.webhook, url: e.target.value } })} />
            </label>
            <label className="field">
              <span>Signing secret (optional)</span>
              <input className="input mono" type="password" autoComplete="off" placeholder={secretPh(ph.webhook.has_secret)} value={ph.webhook.secret || ''} onChange={(e) => up({ webhook: { ...ph.webhook, secret: e.target.value } })} />
            </label>
          </div>
          <small className="dim">
            Keel POSTs JSON {'{'} phone, otp, message, channel, type, project {'}'}. With a secret, X-Keel-Signature is sha256=HMAC(secret, timestamp + "." + body).
            Point it at an SMS gateway app, a GSM modem or an edge function.
          </small>
        </>
      )}
      <label className="field">
        <span>Message</span>
        <input className="input" value={ph.template} onChange={(e) => up({ template: e.target.value })} />
        <small>Must include {'{{ .Code }}'}.</small>
      </label>
      <div className="form-grid">
        <label className="field">
          <span>Code expires after (seconds)</span>
          <input className="input" type="number" min={30} max={3600} value={ph.otp_exp} onChange={(e) => up({ otp_exp: Number(e.target.value) })} />
        </label>
        <label className="field">
          <span>Code length</span>
          <input className="input" type="number" min={6} max={10} value={ph.otp_length} onChange={(e) => up({ otp_length: Number(e.target.value) })} />
        </label>
      </div>
      <div className="setting">
        <span className="two-line">
          <span className="a">Confirm phone numbers</span>
          <span className="b">Phone + password sign-ups must enter a code first.</span>
        </span>
        <Switch label="Confirm phone numbers" checked={!ph.autoconfirm} onChange={(v) => up({ autoconfirm: !v })} />
      </div>
      <label className="field">
        <span>Test numbers</span>
        <textarea className="textarea mono" rows={2} placeholder="15555550100=123456" value={ph.test_otp} onChange={(e) => up({ test_otp: e.target.value })} />
        <small>One number=code per line. These never receive an SMS and always accept their fixed code (handy for app store reviewers).</small>
      </label>
    </div>
  );
}
