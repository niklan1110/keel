import { useEffect, useState, type FormEvent } from 'react';
import { CircleNotch, CloudArrowUp } from '@phosphor-icons/react';
import { del, get, post, put } from '../api';
import { CopyButton, Loading, Notice, Switch, useAction, useConfirm } from '../components/ui';
import { useStudio } from '../ctx';
import { bytes, stamp } from '../lib/format';
import { useLoad } from '../lib/hooks';

type Target = { endpoint: string; region: string; bucket: string; prefix: string; accessKeyId: string; pathStyle: boolean; hasSecret: boolean };

type BackupSet = {
  id: string;
  file: string;
  size_bytes: string;
  kind: string;
  status: string;
  error: string | null;
  remote: string;
  remote_error: string | null;
  created_at: string;
  local: boolean;
};

type Overview = {
  passphrase: boolean;
  schedule: string;
  scheduleSetHere: boolean;
  keepLocal: number;
  keepDaily: number;
  keepWeekly: number;
  target: Target | null;
  envTarget: { endpoint: string; bucket: string; prefix: string } | null;
  running: boolean;
  sets: BackupSet[];
};

type Remote = { target: string | null; backups: { name: string; size: number; lastModified: string }[] };

const EMPTY_FORM = { endpoint: '', region: '', bucket: '', prefix: 'keel', accessKeyId: '', secretAccessKey: '', pathStyle: true };

const hostOf = (url: string) => {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
};

function remoteBadge(s: BackupSet) {
  if (s.remote === 'uploaded') return <span className="badge sm ok">Off-site</span>;
  if (s.remote === 'uploading') return <span className="badge sm neutral">Uploading…</span>;
  if (s.remote === 'failed') return <span className="badge sm err" title={s.remote_error ?? ''}>Upload failed</span>;
  return null;
}

/** Full backups of the whole install: settings, the off-machine target, and the list. */
export function FullBackupsSection() {
  const { reloadInstance } = useStudio();
  const [poll, setPoll] = useState(false);
  const load = useLoad(() => get<Overview>('/api/backups'), [], { poll: poll ? 3000 : undefined });
  const d = load.data;
  const { run, busy } = useAction();
  const confirm = useConfirm();
  const [schedule, setSchedule] = useState('');
  const [keepDaily, setKeepDaily] = useState('7');
  const [keepWeekly, setKeepWeekly] = useState('4');
  const [form, setForm] = useState(EMPTY_FORM);
  const [editing, setEditing] = useState(false);
  const [test, setTest] = useState<{ ok: boolean; error?: string; target?: string; canDelete?: boolean } | null>(null);
  const [remote, setRemote] = useState<Remote | null>(null);

  useEffect(() => {
    setPoll(!!d && (d.running || d.sets.some((s) => s.remote === 'uploading')));
  }, [d]);

  useEffect(() => {
    if (!d) return;
    setSchedule(d.schedule);
    setKeepDaily(String(d.keepDaily));
    setKeepWeekly(String(d.keepWeekly));
    const t = d.target;
    setForm(t ? { endpoint: t.endpoint, region: t.region, bucket: t.bucket, prefix: t.prefix.replace(/\/$/, ''), accessKeyId: t.accessKeyId, secretAccessKey: '', pathStyle: t.pathStyle } : EMPTY_FORM);
    // Only on first load and after saving, not on every poll.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [d?.schedule, d?.keepDaily, d?.keepWeekly, JSON.stringify(d?.target)]);

  if (!d) return load.error ? <Notice kind="err">{load.error.message}</Notice> : <Loading />;

  const saved = (next: Overview | undefined) => {
    if (!next) return;
    load.setData(next);
    setEditing(false);
    void reloadInstance();
  };

  const saveSchedule = async (e: FormEvent) => {
    e.preventDefault();
    saved(await run('schedule', () => put<Overview>('/api/backups/settings', { schedule, keepDaily, keepWeekly }), 'Backup settings saved'));
  };


  const saveTarget = async (e: FormEvent) => {
    e.preventDefault();
    saved(await run('target', () => put<Overview>('/api/backups/settings', { target: form }), 'Backup target saved'));
  };

  const runTest = async (unsaved: boolean) => {
    setTest(null);
    const r = await run('test', () => post<{ ok: boolean; error?: string; target?: string; canDelete?: boolean }>('/api/backups/test', unsaved ? { target: form } : {}));
    if (r) setTest(r);
  };

  const showRemote = async () => {
    const r = await run('remote', () => get<Remote>('/api/backups/remote'));
    if (r) setRemote(r);
  };

  const hasTarget = !!(d.envTarget || d.target);
  const formOpen = !d.envTarget && (editing || !d.target);
  const last = d.sets.find((s) => s.status !== 'running');
  const running = d.running || busy === 'full';

  return (
    <>
      <div className="section">
        <h3>Everything, encrypted</h3>
        <p className="muted" style={{ margin: 0, fontSize: 13 }}>
          A full backup holds every project's database, Keel's own settings, keys and Studio accounts, and all uploaded files, in one file
          encrypted with your passphrase. Restore it onto a new server with <span className="mono">./keel restore</span>.
        </p>
        {!d.passphrase ? (
          <Notice kind="warn">
            Full backups are off. Set <span className="mono">KEEL_BACKUP_PASSPHRASE</span> (12 characters or more) in the server's settings and restart Keel.
            Keep a copy of the passphrase somewhere else: without it, the backups can't be opened.
          </Notice>
        ) : (
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <button
              className="btn-dark md"
              disabled={running}
              onClick={() =>
                run('full', async () => {
                  await post('/api/backups/full');
                  setPoll(true);
                  await load.reload();
                }, 'Full backup started')
              }
            >
              {running ? <CircleNotch size={15} className="spin" /> : <CloudArrowUp size={15} />}
              {running ? 'Backing up everything…' : 'Back up everything now'}
            </button>
            {last && (
              <span className="dim" style={{ fontSize: 12 }}>
                Last: {stamp(last.created_at)}, {last.status === 'ok' ? (last.remote === 'uploaded' ? 'copied off this machine' : hasTarget ? 'not copied off this machine' : 'on this machine only') : 'failed'}
              </span>
            )}
          </div>
        )}
        {!hasTarget && d.passphrase && <Notice kind="warn">Backups are only on this machine. Add a backup target below so a dead disk doesn't take them with it.</Notice>}
      </div>

      <div className="section">
        <h3>Schedule</h3>
        <form onSubmit={saveSchedule} style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div className="form-grid">
            <label className="field">
              <span>Time each night</span>
              <input className="input mono" name="schedule" autoComplete="off" spellCheck={false} placeholder="03:00…" value={schedule} onChange={(e) => setSchedule(e.target.value)} />
              <small>24-hour clock in the server's time zone, or off. {d.scheduleSetHere ? 'Set here.' : 'From the server settings.'}</small>
            </label>
            <span />
            <label className="field">
              <span>Daily backups kept off-site</span>
              <input className="input" name="keep-daily" inputMode="numeric" value={keepDaily} onChange={(e) => setKeepDaily(e.target.value)} />
            </label>
            <label className="field">
              <span>Weekly backups kept off-site</span>
              <input className="input" name="keep-weekly" inputMode="numeric" value={keepWeekly} onChange={(e) => setKeepWeekly(e.target.value)} />
            </label>
          </div>
          <small className="dim">
            The newest {d.keepLocal} full {d.keepLocal === 1 ? 'backup stays' : 'backups stay'} on this machine (KEEL_BACKUP_KEEP_LOCAL). The nightly run also dumps each project's database,
            listed above.
          </small>
          <div>
            <button className="btn-dark md" disabled={busy === 'schedule'}>
              {busy === 'schedule' ? 'Saving…' : 'Save'}
            </button>
          </div>
        </form>
      </div>

      <div className="section">
        <h3>Backup target</h3>
        <p className="muted" style={{ margin: 0, fontSize: 13 }}>
          An S3-compatible bucket: AWS S3, Backblaze B2, Cloudflare R2, Wasabi, MinIO on another machine. Backups are encrypted before they leave this server.
        </p>
        {d.envTarget ? (
          <Notice>
            Set in the server's settings (KEEL_BACKUP_S3_*):{' '}
            <span className="mono">
              {d.envTarget.bucket}/{d.envTarget.prefix} at {hostOf(d.envTarget.endpoint)}
            </span>
          </Notice>
        ) : d.target && !editing ? (
          <div className="setting">
            <span className="two-line">
              <span className="a mono">
                {d.target.bucket}/{d.target.prefix}
              </span>
              <span className="b">at {hostOf(d.target.endpoint)}</span>
            </span>
            <button type="button" className="pill sm" onClick={() => setEditing(true)}>
              Change
            </button>
          </div>
        ) : null}
        {formOpen && (
          <form onSubmit={saveTarget} style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <div className="form-grid">
              <label className="field" style={{ gridColumn: '1 / -1' }}>
                <span>Endpoint</span>
                <input
                  className="input mono"
                  name="endpoint"
                  inputMode="url"
                  autoCapitalize="none"
                  autoComplete="off"
                  spellCheck={false}
                  placeholder="https://s3.us-east-1.amazonaws.com…"
                  value={form.endpoint}
                  onChange={(e) => setForm({ ...form, endpoint: e.target.value })}
                />
              </label>
              <label className="field">
                <span>Bucket</span>
                <input className="input mono" name="bucket" autoCapitalize="none" autoComplete="off" spellCheck={false} value={form.bucket} onChange={(e) => setForm({ ...form, bucket: e.target.value })} />
              </label>
              <label className="field">
                <span>Folder</span>
                <input className="input mono" name="prefix" autoCapitalize="none" autoComplete="off" spellCheck={false} value={form.prefix} onChange={(e) => setForm({ ...form, prefix: e.target.value })} />
              </label>
              <label className="field">
                <span>Region</span>
                <input className="input mono" name="region" autoCapitalize="none" autoComplete="off" spellCheck={false} placeholder="us-east-1…" value={form.region} onChange={(e) => setForm({ ...form, region: e.target.value })} />
                <small>auto for Cloudflare R2.</small>
              </label>
              <span />
              <label className="field">
                <span>Access key ID</span>
                <input className="input mono" name="access-key-id" autoCapitalize="none" autoComplete="off" spellCheck={false} value={form.accessKeyId} onChange={(e) => setForm({ ...form, accessKeyId: e.target.value })} />
              </label>
              <label className="field">
                <span>Secret access key</span>
                <input
                  className="input mono"
                  type="password"
                  name="secret-access-key"
                  autoComplete="new-password"
                  placeholder={d.target?.hasSecret ? 'Saved; leave empty to keep' : ''}
                  value={form.secretAccessKey}
                  onChange={(e) => setForm({ ...form, secretAccessKey: e.target.value })}
                />
              </label>
            </div>
            <div className="setting">
              <span className="two-line">
                <span className="a">Bucket name in the path</span>
                <span className="b">On for MinIO and most S3-compatible services. Off puts the bucket in the host name.</span>
              </span>
              <Switch label="Bucket name in the path" checked={form.pathStyle} onChange={(v) => setForm({ ...form, pathStyle: v })} />
            </div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <button className="btn-dark md" disabled={busy === 'target'}>
                {busy === 'target' ? 'Saving…' : 'Save'}
              </button>
              <button type="button" className="pill md" disabled={busy === 'test'} onClick={() => void runTest(true)}>
                {busy === 'test' ? 'Testing…' : 'Test connection'}
              </button>
              {d.target && (
                <>
                  <button type="button" className="pill md" onClick={() => setEditing(false)}>
                    Cancel
                  </button>
                  <button
                    type="button"
                    className="pill md danger"
                    onClick={async () => {
                      if (!(await confirm({ title: 'Stop copying backups off this machine?', body: 'Backups already in the bucket stay there.', confirm: 'Remove target', danger: true }))) return;
                      saved(await run('target', () => put<Overview>('/api/backups/settings', { target: null }), 'Backup target removed'));
                    }}
                  >
                    Remove
                  </button>
                </>
              )}
            </div>
          </form>
        )}
        {hasTarget && !formOpen && (
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button type="button" className="pill md" disabled={busy === 'test'} onClick={() => void runTest(false)}>
              {busy === 'test' ? 'Testing…' : 'Test connection'}
            </button>
            <button type="button" className="pill md" disabled={busy === 'remote'} onClick={() => void showRemote()}>
              {busy === 'remote' ? 'Loading…' : 'Show backups in the bucket'}
            </button>
          </div>
        )}
        {test &&
          (!test.ok ? (
            <Notice kind="err">{test.error}</Notice>
          ) : test.canDelete === false ? (
            <Notice kind="ok">
              Connected to {test.target}: Keel can list and write there, but not delete. Old backups stay in the bucket, so let its own lifecycle rules remove them. (A small
              .keel-connection-test file was left there.)
            </Notice>
          ) : (
            <Notice kind="ok">Connected to {test.target}: Keel can list, write and delete there.</Notice>
          ))}
        {remote && (
          <div>
            {remote.backups.length === 0 ? (
              <p className="dim" style={{ fontSize: 13 }}>No full backups in {remote.target} yet.</p>
            ) : (
              remote.backups.map((b) => (
                <div key={b.name} className="user-row">
                  <span className="two-line">
                    <span className="a mono">{b.name}</span>
                    <span className="b">
                      {stamp(b.lastModified)}, {bytes(b.size)}
                    </span>
                  </span>
                  <CopyButton text={`./keel restore ${b.name}`} label="Copy restore command" />
                </div>
              ))
            )}
          </div>
        )}
      </div>

      {d.sets.length > 0 && (
        <div style={{ paddingTop: 8 }}>
          {d.sets.map((s) => (
            <div key={s.id} className="user-row">
              <span className="two-line">
                <span className="a">{stamp(s.created_at)}</span>
                <span className="b">
                  {s.kind === 'scheduled' ? 'Nightly' : 'Manual'}
                  {s.status === 'ok' ? `, ${bytes(Number(s.size_bytes))}${s.local ? '' : ', no longer on this machine'}` : ''}
                  {s.error ? `: ${s.error}` : ''}
                  {s.remote === 'failed' && s.remote_error ? ` Upload: ${s.remote_error}` : ''}
                </span>
              </span>
              {s.status === 'running' ? (
                <span className="badge sm neutral">Running…</span>
              ) : s.status !== 'ok' ? (
                <span className="badge err">Failed</span>
              ) : (
                <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                  {remoteBadge(s)}
                  {s.local && (
                    <button
                      className="pill sm"
                      onClick={() =>
                        run('dl', async () => {
                          const r = await post<{ url: string }>(`/api/backups/full/${s.id}/link`);
                          window.location.href = r.url;
                        })
                      }
                    >
                      Download
                    </button>
                  )}
                  <button
                    className="pill sm danger"
                    onClick={async () => {
                      if (!(await confirm({ title: 'Delete this full backup from this machine?', body: 'A copy in the backup target stays there.', confirm: 'Delete', danger: true }))) return;
                      const r = await run('del', () => del(`/api/backups/full/${s.id}`), 'Backup deleted');
                      if (r) await load.reload();
                    }}
                  >
                    Delete
                  </button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </>
  );
}
