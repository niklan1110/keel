import { CircleNotch, DownloadSimple } from '@phosphor-icons/react';
import { del, get, post } from '../api';
import { Loading, Notice, useAction, useConfirm } from '../components/ui';
import { projectPath, useStudio } from '../ctx';
import { bytes, stamp } from '../lib/format';
import { useLoad } from '../lib/hooks';
import type { Backup } from '../types';
import { FullBackupsSection } from './FullBackupsSection';
import { Shell } from './Shell';

export function BackupsDrawer() {
  const { project, instance, overview, reloadOverview, reloadSchema } = useStudio();
  const base = projectPath(project);
  const list = useLoad(() => get<Backup[]>(`${base}/backups`), [base]);
  const { busy, run } = useAction();
  const confirm = useConfirm();
  const running = busy === 'backup' || !!overview?.backupRunning;
  const schedule = /^\d{1,2}:\d{2}$/.test(instance.backupSchedule) ? `Nightly at ${instance.backupSchedule}` : 'Scheduled backups are off';

  return (
    <Shell label="Backups" title="Backups" sub={schedule}>
      <div className="toolbar">
        <span className="dim" style={{ fontSize: 12 }}>
          pg_dump of the {project} database
        </span>
        <button
          className="btn-dark grow"
          disabled={running}
          onClick={() =>
            run('backup', async () => {
              await post(`${base}/backups`);
              await list.reload();
              await reloadOverview();
            }, 'Backup complete')
          }
        >
          {running ? <CircleNotch size={15} className="spin" /> : <DownloadSimple size={15} />}
          {running ? 'Backing up…' : 'Back up now'}
        </button>
      </div>
      <div className="section" style={{ paddingBottom: 0 }}>
        <Notice>
          These cover the {project} database (tables, auth users, storage metadata) for quick rollbacks. Full backups below also hold uploaded files and Keel's own settings.
        </Notice>
      </div>
      {!list.data ? (
        <Loading />
      ) : list.data.length === 0 ? (
        <div className="empty">
          <b>No backups yet</b>
          Run one now, or wait for the nightly backup.
        </div>
      ) : (
        <div style={{ paddingTop: 8 }}>
          {list.data.map((b) => (
            <div key={b.id} className="user-row">
              <span className="two-line">
                <span className="a">{stamp(b.created_at)}</span>
                <span className="b">
                  {b.kind === 'scheduled' ? 'Nightly' : b.kind === 'before-defaults' ? 'Before restoring defaults' : 'Manual'}
                  {b.status === 'ok' ? `, ${bytes(Number(b.size_bytes))}` : ''}
                  {b.error ? `: ${b.error}` : ''}
                </span>
              </span>
              {b.status !== 'ok' ? (
                <span className="badge err">Failed</span>
              ) : (
                <div style={{ display: 'flex', gap: 6 }}>
                  <button
                    className="pill sm"
                    onClick={() =>
                      run('dl', async () => {
                        const r = await post<{ url: string }>(`${base}/backups/${b.id}/link`);
                        window.location.href = r.url;
                      })
                    }
                  >
                    Download
                  </button>
                  <button
                    className="pill sm"
                    disabled={busy === 'restore'}
                    onClick={async () => {
                      const ok = await confirm({
                        title: 'Restore this backup?',
                        body: `The ${project} database is rolled back to ${stamp(b.created_at)}. Changes made since then are lost. Take a backup first if unsure.`,
                        confirm: 'Restore',
                        danger: true,
                        typeToConfirm: project,
                      });
                      if (!ok) return;
                      const r = await run('restore', () => post(`${base}/backups/${b.id}/restore`, { confirm: project }), 'Backup restored');
                      if (r) {
                        void reloadSchema();
                        void reloadOverview();
                      }
                    }}
                  >
                    {busy === 'restore' ? 'Restoring…' : 'Restore'}
                  </button>
                  <button
                    className="pill sm danger"
                    onClick={async () => {
                      if (!(await confirm({ title: 'Delete this backup?', confirm: 'Delete', danger: true }))) return;
                      const r = await run('del', () => del(`${base}/backups/${b.id}`), 'Backup deleted');
                      if (r) await list.reload();
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
      <FullBackupsSection />
    </Shell>
  );
}
