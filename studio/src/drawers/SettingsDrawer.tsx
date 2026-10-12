import { useEffect, useRef, useState } from 'react';
import { ArrowsLeftRight } from '@phosphor-icons/react';
import { get, del, post, put } from '../api';
import { CopyButton, Loading, Modal, Notice, Switch, useAction, useConfirm } from '../components/ui';
import { projectPath, useStudio } from '../ctx';
import { bytes, stamp } from '../lib/format';
import { useLoad } from '../lib/hooks';
import type { ProjectSummary } from '../types';
import { DefaultsSection } from './DefaultsSection';
import { Shell } from './Shell';

export function SettingsDrawer({ focus }: { focus?: 'defaults' }) {
  const { project, instance, overview, close, reloadProjects, open } = useStudio();
  const projects = useLoad(() => get<ProjectSummary[]>('/api/projects'), []);
  const p = projects.data?.find((x) => x.name === project);
  const confirm = useConfirm();
  const { run } = useAction();
  const apiUrl = `${instance.publicUrl}/${project}`;
  const settings = useLoad(() => get<{ realtime: { private_only: boolean } }>(`${projectPath(project)}/settings`), [project]);
  const [importing, setImporting] = useState(false);

  return (
    <Shell label="Project settings" title="Project settings" sub={project}>
      {!p ? (
        <Loading />
      ) : (
        <>
          <div className="section">
            <dl className="kv">
              <dt>Project</dt>
              <dd className="mono">{p.name}</dd>
              <dt>Database</dt>
              <dd className="mono">{p.dbName}</dd>
              <dt>Created</dt>
              <dd>{stamp(p.createdAt)}</dd>
              <dt>Size</dt>
              <dd>{bytes(p.sizeBytes)}</dd>
              <dt>Users</dt>
              <dd>{overview?.users ?? '–'}</dd>
              <dt>API URL</dt>
              <dd className="mono" style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <span style={{ overflowWrap: 'anywhere' }}>{apiUrl}</span>
                <CopyButton text={apiUrl} />
                <button type="button" className="pill sm" onClick={() => open({ kind: 'internet' })}>
                  Change…
                </button>
              </dd>
              <dt>Keel</dt>
              <dd>
                v{instance.version}, Postgres {instance.postgres}
                {instance.update?.latest && instance.update.url && (
                  <>
                    {' · '}
                    <a href={instance.update.url} target="_blank" rel="noreferrer noopener">
                      v{instance.update.latest} available
                    </a>{' '}
                    <span className="dim">(update with ./keel update)</span>
                  </>
                )}
              </dd>
            </dl>
          </div>
          <div className="section">
            <h3>Realtime</h3>
            <div className="setting">
              <span className="two-line">
                <span className="a">Private channels only</span>
                <span className="b">
                  Reject public channels. Clients must join with {'{ config: { private: true } }'} and pass your policies on realtime.messages.
                </span>
              </span>
              <Switch
                label="Private channels only"
                checked={!!settings.data?.realtime.private_only}
                disabled={!settings.data}
                onChange={async (v) => {
                  const r = await run('rt', () => put(`${projectPath(project)}/settings`, { realtime: { private_only: v } }), v ? 'Only private channels allowed' : 'Public channels allowed');
                  if (r) settings.setData(r);
                }}
              />
            </div>
          </div>
          <DefaultsSection focus={focus === 'defaults'} />
          <div className="section">
            <h3>Move from Supabase</h3>
            <div className="muted" style={{ fontSize: 12.5 }}>
              Copy a Supabase project into this one: tables and data, users (their passwords keep working), storage buckets, policies and files. Supabase is only read.
            </div>
            <button className="pill md" style={{ alignSelf: 'flex-start' }} onClick={() => setImporting(true)}>
              <ArrowsLeftRight size={15} /> Import from Supabase
            </button>
          </div>
          {importing && <ImportModal project={project} onClose={() => setImporting(false)} />}
          <div className="section">
            <h3>Danger zone</h3>
            <div className="muted" style={{ fontSize: 12.5 }}>
              Deleting a project drops its database, users and storage metadata. Uploaded files stay in the storage volume. Download a backup first if you might need it.
            </div>
            <button
              className="pill md danger"
              style={{ alignSelf: 'flex-start' }}
              onClick={async () => {
                const ok = await confirm({ title: `Delete ${project}?`, body: 'This cannot be undone.', confirm: 'Delete project', danger: true, typeToConfirm: project });
                if (!ok) return;
                const r = await run('del', () => del(projectPath(project), { confirm: project }), `Deleted ${project}`);
                if (r) {
                  close();
                  await reloadProjects();
                }
              }}
            >
              Delete project
            </button>
          </div>
        </>
      )}
    </Shell>
  );
}

type ImportJob = {
  status: 'running' | 'done' | 'failed';
  source: string;
  lines: { t: string; level: 'info' | 'warn' | 'error'; msg: string }[];
  result: { warnings: number; tables: number; users: number; files: number } | null;
  error: string | null;
} | null;

function ImportModal({ project, onClose }: { project: string; onClose: () => void }) {
  const { reloadSchema, reloadOverview } = useStudio();
  const base = `${projectPath(project)}/import`;
  const job = useLoad(() => get<ImportJob>(base), [base], { poll: 1500 });
  const [dbUrl, setDbUrl] = useState('');
  const [apiUrl, setApiUrl] = useState('');
  const [serviceKey, setServiceKey] = useState('');
  const [started, setStarted] = useState(false);
  const { busy, run } = useAction();
  const box = useRef<HTMLDivElement>(null);
  const j = job.data;
  const running = j?.status === 'running';
  const showLog = started || running;

  useEffect(() => {
    if (box.current) box.current.scrollTop = box.current.scrollHeight;
  }, [j?.lines.length]);
  useEffect(() => {
    if (started && j && j.status !== 'running') {
      void reloadSchema();
      void reloadOverview();
    }
  }, [started, j?.status, reloadSchema, reloadOverview]);

  return (
    <Modal onClose={onClose} label="Import from Supabase" wide>
      <h2>Import from Supabase</h2>
      {!showLog ? (
        <form
          style={{ display: 'flex', flexDirection: 'column', gap: 12 }}
          onSubmit={async (e) => {
            e.preventDefault();
            const r = await run('start', () => post(base, { dbUrl, apiUrl, serviceKey }));
            if (r) {
              setStarted(true);
              await job.reload();
            }
          }}
        >
          <Notice>Import into an empty project. In Supabase, open your project and copy these from Connect and Project Settings &gt; API.</Notice>
          <label className="field">
            <span>Database connection string (Session pooler)</span>
            <input className="input mono" required placeholder="postgresql://postgres.abcd:[PASSWORD]@aws-0-eu-west-1.pooler.supabase.com:5432/postgres" value={dbUrl} onChange={(e) => setDbUrl(e.target.value)} autoComplete="off" />
            <small>Include your database password. It's only used for this import and isn't stored.</small>
          </label>
          <div className="form-grid">
            <label className="field">
              <span>Project URL (for files)</span>
              <input className="input mono" placeholder="https://abcd.supabase.co" value={apiUrl} onChange={(e) => setApiUrl(e.target.value)} />
            </label>
            <label className="field">
              <span>service_role key (for files)</span>
              <input className="input mono" type="password" value={serviceKey} onChange={(e) => setServiceKey(e.target.value)} autoComplete="off" />
            </label>
          </div>
          <small className="dim">Edge functions are deployed from your code: ./keel functions deploy. Secrets have to be set again.</small>
          <div className="acts">
            <button type="button" className="pill md" onClick={onClose}>
              Cancel
            </button>
            <button className="btn-dark md" disabled={!dbUrl || busy === 'start'}>
              {busy === 'start' ? 'Starting…' : 'Start import'}
            </button>
          </div>
        </form>
      ) : (
        <>
          {j?.status === 'done' && (
            <Notice kind={j.result?.warnings ? 'warn' : 'ok'}>
              Imported {j.result?.tables} tables, {j.result?.users} users and {j.result?.files} files{j.result?.warnings ? ` with ${j.result.warnings} warning(s), see below` : ''}.
            </Notice>
          )}
          {j?.status === 'failed' && <Notice kind="err">{j.error}</Notice>}
          <div className="term" ref={box} style={{ maxHeight: 320, minHeight: 160 }}>
            {(j?.lines || []).map((l, i) => (
              <div key={i} className={l.level === 'info' ? '' : l.level === 'warn' ? 'lv-WARN' : 'lv-ERROR'}>
                {l.msg}
              </div>
            ))}
            {running && <div className="lv-INFO">Working…</div>}
          </div>
          <div className="acts">
            <button className="btn-dark md" onClick={onClose} disabled={running}>
              {running ? 'Importing…' : 'Close'}
            </button>
          </div>
        </>
      )}
    </Modal>
  );
}
