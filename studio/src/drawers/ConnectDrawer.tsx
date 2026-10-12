import { useState } from 'react';
import { GlobeSimple } from '@phosphor-icons/react';
import { get, post } from '../api';
import { CopyButton, Loading, Notice, useAction, useConfirm } from '../components/ui';
import { stamp } from '../lib/format';
import { projectPath, useStudio } from '../ctx';
import { useLoad } from '../lib/hooks';
import { Shell } from './Shell';
// The same template as the docs page "Build with AI agents", filled in below.
import agentTemplate from '../../../website/snippets/agent-prompt.txt?raw';

type Info = {
  apiUrl: string;
  restUrl: string;
  anonKey: string;
  serviceKey: string;
  /**
   * The project's owner role (not a superuser) and its password. url is the
   * connection string with "<password>" in place of the password, and
   * sslmode=require when Postgres has TLS on.
   */
  db: { host: string; port: number; database: string; user: string; url: string; password: string | null };
  /** The Postgres superuser, for server admins only. */
  superuser: string;
  callbackUrl: string;
  /** False when the public address doesn't serve /docs (KEEL_GATEWAY_DOCS=off). */
  docsOnApi: boolean;
};

/** The Keel website, when the images were built knowing it. */
const SITE = /YOUR-KEEL-WEBSITE/.test(__KEEL_SITE__) ? null : __KEEL_SITE__;

const TABS = [
  ['env', '.env'],
  ['js', 'JavaScript'],
  ['psql', 'psql'],
  ['curl', 'curl'],
  ['agent', 'AI agent'],
] as const;

/** The prompt for coding agents, with this project's URL, key and server filled in. */
function agentPrompt(template: string, i: Info, project: string): string {
  const host = new URL(i.apiUrl).hostname;
  // The public Keel website when the images know it (agents can usually reach
  // it), else the docs the gateway serves next to the APIs: <KEEL_PUBLIC_URL>/docs.
  const base = i.apiUrl.endsWith(`/${project}`) ? i.apiUrl.slice(0, -(project.length + 1)) : new URL(i.apiUrl).origin;
  const docs = SITE || `${base}/docs`;
  return template
    .replaceAll('@@IMAGES@@', __KEEL_IMAGES__)
    .replaceAll('@@SITE@@', __KEEL_SITE__)
    .replaceAll('postgresql://my_app_owner:PASSWORD@YOUR-SERVER:5432/my_app?sslmode=require', i.db.url.replace('<password>', 'PASSWORD'))
    .replaceAll('http://YOUR-SERVER:8000/docs', docs)
    .replaceAll('http://YOUR-SERVER:8000/my-app', i.apiUrl)
    .replaceAll('YOUR_ANON_KEY', i.anonKey)
    .replaceAll('my_app', i.db.database)
    .replaceAll('my-app', project)
    .replaceAll('YOUR-SERVER', host);
}

export function ConnectDrawer() {
  const { project, tables, open } = useStudio();
  const info = useLoad(() => get<Info>(`${projectPath(project)}/connect`), [project]);
  const [tab, setTab] = useState<(typeof TABS)[number][0]>('env');
  const i = info.data;
  const table = tables.find((t) => t.kind === 'table')?.name || 'todos';

  const pg = i ? i.db.url : '';
  const pgWithPassword = i?.db.password ? pg.replace('<password>', encodeURIComponent(i.db.password)) : pg;
  const snippets: Record<string, string> = i
    ? {
        env: `KEEL_URL=${i.apiUrl}\nKEEL_ANON_KEY=${i.anonKey}\nDATABASE_URL=${pg}`,
        js: `// npm install @supabase/supabase-js  (Keel speaks the same API)\nimport { createClient } from '@supabase/supabase-js'\n\nconst keel = createClient(\n  '${i.apiUrl}',\n  process.env.KEEL_ANON_KEY\n)\n\nconst { data } = await keel.from('${table}').select('*')`,
        psql: `psql "${pg.replace(':<password>@', '@')}"`,
        curl: `curl '${i.restUrl}/${table}?select=*' \\\n  -H "apikey: ${i.anonKey}"`,
        agent: agentPrompt(agentTemplate, i, project),
      }
    : {};

  return (
    <Shell
      label="Connect"
      title="Connect"
      sub="Use these from your apps"
      actions={
        <button className="pill sm" onClick={() => open({ kind: 'internet' })}>
          <GlobeSimple size={14} /> Internet access
        </button>
      }
    >
      {!i ? (
        info.error ? <div className="section"><Notice kind="err">{info.error.message}</Notice></div> : <Loading />
      ) : (
        <div className="section">
          <div className="tabs" role="tablist">
            {TABS.map(([id, label]) => (
              <button key={id} role="tab" aria-selected={tab === id} onClick={() => setTab(id)}>
                {label}
              </button>
            ))}
          </div>
          {tab === 'agent' && (
            <>
              <p className="muted" style={{ margin: 0, fontSize: 13 }}>
                Paste this into Claude Code, Cursor, Codex or another coding agent, or save it as <code>CLAUDE.md</code> / <code>AGENTS.md</code> in your app.
                It contains no secrets.{' '}
                <a href="/docs/guide/ai-agents" target="_blank" rel="noopener">
                  How it works
                </a>
              </p>
              {!SITE && !i.docsOnApi && (
                <Notice kind="warn">
                  Your public address doesn't serve the docs (<span className="mono">KEEL_GATEWAY_DOCS=off</span>), so agents can't fetch them. Download them
                  below and save the file in your app as <span className="mono">.keel/docs.md</span>.
                </Notice>
              )}
              <p className="muted" style={{ margin: 0, fontSize: 13 }}>
                Agent can't reach your server?{' '}
                <a href="/docs/llms-full.txt" download="docs.md">
                  Download the docs
                </a>{' '}
                and save them in your app as <span className="mono">.keel/docs.md</span>.
              </p>
            </>
          )}
          <pre className={`snippet${tab === 'agent' ? ' wrap' : ''}`} translate="no">
            {snippets[tab]}
          </pre>
          <div>
            <CopyButton text={snippets[tab]} className="btn-dark md" />
          </div>
          <Row label="API URL (use with supabase-js)" value={i.apiUrl} />
          <Row label="REST endpoint" value={i.restUrl} />
          <Row
            label="Postgres connection"
            value={pg.replace('<password>', '••••••')}
            copy={pgWithPassword}
            hint={`Copies with the password. ${i.db.user} owns this project's tables and functions but isn't a superuser and can't reach other projects. The ${i.superuser} superuser (POSTGRES_PASSWORD in .env) is for server admins.`}
          />
          <Row label="Anon key" value={i.anonKey} />
          <Row label="Service role key" value={i.serviceKey.slice(0, 20) + '••••••••••••••••'} copy={i.serviceKey} />
          <Notice kind="warn">The service role key bypasses row level security. Only use it on servers you control, never in a browser or app.</Notice>
          <KeysSection project={project} onRolled={() => void info.reload()} />
        </div>
      )}
    </Shell>
  );
}

function Row({ label, value, copy, hint }: { label: string; value: string; copy?: string; hint?: string }) {
  return (
    <div className="api-row">
      <span style={{ flex: 1, minWidth: 0 }}>
        <span className="lbl">{label}</span>
        <span className="val" translate="no">
          {value}
        </span>
        {hint && <span className="lbl" style={{ fontSize: 11, color: 'var(--dim)' }}>{hint}</span>}
      </span>
      <CopyButton text={copy ?? value} />
    </div>
  );
}

type KeyList = {
  keys: { kid: string; createdAt: string; expiresAt: string | null; current: boolean }[];
  events: { action: string; kid: string | null; actor: string; detail: Record<string, unknown>; createdAt: string }[];
};

const ACTIONS: Record<string, string> = {
  roll: 'Rolled keys',
  roll_emergency: 'Emergency roll',
  revoke: 'Stopped old keys',
  end_sessions: 'Signed all users out',
};

/**
 * Rolling the project's keys: a new signing key and new anon and service
 * role keys. Old keys keep working for a grace period unless stopped.
 */
function KeysSection({ project, onRolled }: { project: string; onRolled: () => void }) {
  const list = useLoad(() => get<KeyList>(`${projectPath(project)}/keys`), [project]);
  const { busy, run } = useAction();
  const confirm = useConfirm();
  const [grace, setGrace] = useState('24');
  const keys = list.data?.keys || [];
  const old = keys.filter((k) => !k.current);
  const done = () => {
    void list.reload();
    onRolled();
  };

  const roll = async () => {
    const ok = await confirm({
      title: 'Roll API keys?',
      body: `New anon and service role keys are made. The current keys keep working for ${grace} hours, so you can update your apps; signed-in users stay signed in.`,
      confirm: 'Roll keys',
    });
    if (!ok) return;
    if (await run('roll', () => post(`${projectPath(project)}/keys/roll`, { graceHours: Number(grace) }), 'New keys are ready. Update your apps.')) done();
  };
  const stopOld = async () => {
    const ok = await confirm({
      title: 'Stop the old keys now?',
      body: 'Apps still using an old key stop working, and users signed in with a token from an old key must refresh it. Wait at least as long as access tokens last (an hour by default) after rolling.',
      confirm: 'Stop old keys',
      danger: true,
    });
    if (!ok) return;
    if (await run('revoke', () => post(`${projectPath(project)}/keys/revoke-old`), 'Old keys stopped')) done();
  };
  const emergency = async () => {
    const ok = await confirm({
      title: 'Emergency roll?',
      body: 'For a leaked key. New keys are made and every old key stops working at once. Every user of this project is signed out, and your apps fail until they have the new keys.',
      confirm: 'Roll and sign everyone out',
      danger: true,
      typeToConfirm: project,
    });
    if (!ok) return;
    if (await run('emergency', () => post(`${projectPath(project)}/keys/roll`, { emergency: true, confirm: project }), 'Keys rolled; everyone was signed out')) done();
  };

  return (
    <div className="api-keys" style={{ display: 'flex', flexDirection: 'column', gap: 10, marginTop: 8 }}>
      <h3 style={{ margin: 0, fontSize: 14 }}>Key rotation</h3>
      {list.error ? (
        <Notice kind="err">{list.error.message}</Notice>
      ) : !list.data ? (
        <Loading />
      ) : (
        <>
          {keys.map((k) => (
            <div className="api-row" key={k.kid}>
              <span style={{ flex: 1, minWidth: 0 }}>
                <span className="lbl">{k.current ? 'Signing key' : 'Old key'}</span>
                <span className="val mono" translate="no">
                  {k.kid}
                </span>
                <span className="lbl" style={{ fontSize: 11, color: 'var(--dim)' }}>
                  {k.current ? `Since ${stamp(k.createdAt)}` : k.expiresAt ? `Keeps working until ${stamp(k.expiresAt)}` : 'Keeps working'}
                </span>
              </span>
            </div>
          ))}
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
            <select className="select" style={{ width: 190 }} value={grace} onChange={(e) => setGrace(e.target.value)} aria-label="Old keys keep working for">
              <option value="1">Old keys work 1 hour</option>
              <option value="24">Old keys work 24 hours</option>
              <option value="72">Old keys work 3 days</option>
              <option value="168">Old keys work 7 days</option>
            </select>
            <button className="pill sm" disabled={!!busy} onClick={roll}>
              {busy === 'roll' ? 'Rolling…' : 'Roll keys'}
            </button>
            {old.length > 0 && (
              <button className="pill sm danger" disabled={!!busy} onClick={stopOld}>
                {busy === 'revoke' ? 'Stopping…' : 'Stop old keys now'}
              </button>
            )}
            <button className="pill sm danger" disabled={!!busy} onClick={emergency}>
              {busy === 'emergency' ? 'Rolling…' : 'Emergency roll'}
            </button>
          </div>
          {list.data.events.length > 0 && (
            <div className="muted" style={{ fontSize: 12, display: 'flex', flexDirection: 'column', gap: 2 }}>
              {list.data.events.slice(0, 5).map((e, n) => (
                <span key={n}>
                  {stamp(e.createdAt)}: {ACTIONS[e.action] || e.action} by {e.actor.replace(/^studio:/, '')}
                </span>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}
