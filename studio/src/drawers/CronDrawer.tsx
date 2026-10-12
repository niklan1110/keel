import { get } from '../api';
import { Loading, Notice } from '../components/ui';
import { projectPath, useStudio } from '../ctx';
import { clock, stamp } from '../lib/format';
import { useLoad } from '../lib/hooks';
import type { CronInfo, NetInfo } from '../types';
import { Shell } from './Shell';

const EXAMPLE = `-- Every night at 03:30 (UTC)
select cron.schedule('nightly-cleanup', '30 3 * * *', $$delete from public.events where created_at < now() - interval '30 days'$$);

-- Every 10 seconds
select cron.schedule('heartbeat', '10 seconds', $$select 1$$);

-- Stop a job
select cron.unschedule('nightly-cleanup');`;

const statusBadge = (status: string | null) =>
  status === 'succeeded' ? <span className="badge ok sm">Succeeded</span>
  : status === 'failed' ? <span className="badge err sm">Failed</span>
  : status ? <span className="badge warn sm">{status[0].toUpperCase() + status.slice(1)}</span>
  : <span className="badge neutral sm">Not run yet</span>;

/** Scheduled jobs (cron.schedule) and recent outgoing requests (net.http_*, database webhooks). */
export function CronDrawer() {
  const { project, open } = useStudio();
  const base = projectPath(project);
  const cron = useLoad(() => get<CronInfo>(`${base}/cron`), [base], { poll: 5000 });
  const net = useLoad(() => get<NetInfo>(`${base}/net`), [base], { poll: 5000 });
  const names = new Map((cron.data?.jobs || []).map((j) => [j.jobid, j.jobname || `#${j.jobid}`]));

  return (
    <Shell label="Scheduled jobs" title="Scheduled jobs" sub="cron.schedule() and net.http_*, as on Supabase" wide>
      <div className="toolbar">
        <span className="dim" style={{ fontSize: 12 }}>
          Jobs run as the project's owner role, in UTC
        </span>
        <button className="btn-dark grow" onClick={() => open({ kind: 'sql', sql: EXAMPLE })}>
          Schedule with SQL
        </button>
      </div>
      {cron.error ? (
        <div className="section">
          <Notice kind="err">{cron.error.message}</Notice>
        </div>
      ) : !cron.data ? (
        <Loading />
      ) : (
        <>
          <div className="section">
            <h3>Jobs</h3>
            {cron.data.jobs.length === 0 ? (
              <div className="empty" style={{ padding: '12px 0' }}>
                <b>No scheduled jobs</b>
                Schedule one with <code className="code-inline">cron.schedule()</code> in the SQL editor.
              </div>
            ) : (
              cron.data.jobs.map((j) => (
                <div key={j.jobid} className="user-row" style={{ padding: '6px 0' }}>
                  <span className="two-line" style={{ minWidth: 0 }}>
                    <span className="a">
                      {j.jobname || `Job ${j.jobid}`} <span className="mono dim" style={{ fontSize: 12 }}>{j.schedule}</span>
                    </span>
                    <span className="b mono" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={j.command}>
                      {j.command}
                    </span>
                  </span>
                  <span style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
                    {!j.active && <span className="badge neutral sm">Paused</span>}
                    {statusBadge(j.last_status)}
                  </span>
                </div>
              ))
            )}
          </div>
          <div className="section">
            <h3>Recent runs</h3>
            <span className="dim" style={{ fontSize: 12 }}>
              Kept for {cron.data.historyDays} days in <code className="code-inline">cron.job_run_details</code>; a run stops after {cron.data.timeoutSeconds} s.
            </span>
            {cron.data.runs.length === 0 ? (
              <span className="dim">No runs yet.</span>
            ) : (
              cron.data.runs.map((r) => (
                <div key={r.runid} className="user-row" style={{ padding: '4px 0' }}>
                  <span className="two-line" style={{ minWidth: 0 }}>
                    <span className="a">
                      {names.get(r.jobid) || `#${r.jobid}`} <span className="dim" style={{ fontSize: 12 }}>{clock(r.start_time)}</span>
                    </span>
                    {r.return_message && (
                      <span className="b mono" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={r.return_message}>
                        {r.return_message}
                      </span>
                    )}
                  </span>
                  {statusBadge(r.status)}
                </div>
              ))
            )}
          </div>
        </>
      )}
      <div className="section">
        <h3>Outgoing requests</h3>
        <span className="dim" style={{ fontSize: 12 }}>
          From <code className="code-inline">net.http_get</code>, <code className="code-inline">net.http_post</code> and database webhooks. Private and LAN addresses are refused.
          {net.data ? ` ${net.data.queued} waiting; responses are kept ${net.data.ttlHours} hours.` : ''}
        </span>
        {net.error ? (
          <Notice kind="err">{net.error.message}</Notice>
        ) : !net.data ? null : net.data.responses.length === 0 ? (
          <span className="dim">No requests yet.</span>
        ) : (
          net.data.responses.map((r) => (
            <div key={`${r.id}-${r.created}`} className="user-row" style={{ padding: '4px 0' }}>
              <span className="two-line" style={{ minWidth: 0 }}>
                <span className="a">
                  Request {r.id} <span className="dim" style={{ fontSize: 12 }}>{stamp(r.created)}</span>
                </span>
                <span className="b mono" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={r.error_msg || r.content || ''}>
                  {r.error_msg || r.content || ''}
                </span>
              </span>
              {r.status_code !== null ? (
                <span className={`badge sm ${r.status_code < 400 ? 'ok' : 'err'}`}>{r.status_code}</span>
              ) : (
                <span className="badge err sm">{r.timed_out ? 'Timed out' : 'Failed'}</span>
              )}
            </div>
          ))
        )}
      </div>
    </Shell>
  );
}
