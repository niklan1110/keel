import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowClockwise, MagnifyingGlass, Play, Stop } from '@phosphor-icons/react';
import { get, post } from '../api';
import { statusOf } from '../components/Side';
import { Notice, useAction, useConfirm } from '../components/ui';
import { useStudio } from '../ctx';
import { clock } from '../lib/format';
import { useLoad } from '../lib/hooks';
import type { LogLine } from '../types';
import { Shell } from './Shell';

const PROTECTED_STOP = new Set(['keel-studio', 'keel-db']);

export function ServiceDrawer({ service }: { service: string }) {
  const { containers, docker, open, reloadStack, mobile } = useStudio();
  const c = containers.find((x) => x.service === service);
  const s = c ? statusOf(c) : { label: 'Unknown', dot: 'var(--dim)', color: 'var(--dim)' };
  const logs = useLoad(() => get<{ docker: boolean; lines: LogLine[] }>(`/api/stack/${encodeURIComponent(service)}/logs?tail=300`), [service], { poll: 3000, enabled: docker });
  const { busy, run } = useAction();
  const confirm = useConfirm();
  const [filter, setFilter] = useState('');
  const box = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const running = c?.state === 'running';

  const lines = useMemo(() => {
    const all = logs.data?.lines || [];
    const f = filter.trim().toLowerCase();
    return f ? all.filter((l) => l.msg.toLowerCase().includes(f) || l.lvl.toLowerCase() === f) : all;
  }, [logs.data, filter]);

  useEffect(() => {
    const el = box.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [lines]);

  const act = async (action: 'restart' | 'stop' | 'start') => {
    if (action !== 'start' && service === 'keel-gateway') {
      const ok = await confirm({ title: `${action === 'stop' ? 'Stop' : 'Restart'} the gateway?`, body: 'Apps lose access to every project until it is back.', confirm: action === 'stop' ? 'Stop' : 'Restart', danger: action === 'stop' });
      if (!ok) return;
    }
    await run(action, async () => {
      await post(`/api/stack/${encodeURIComponent(service)}/${action}`);
      await reloadStack();
      setTimeout(() => void reloadStack(), 2500);
      void logs.reload();
    }, `${service}: ${action === 'start' ? 'started' : action === 'stop' ? 'stopped' : 'restarted'}`);
  };

  return (
    <Shell label={service} title={<span className="mono" style={{ fontSize: 20 }}>{service}</span>} sub={c?.role ? `${c.role}, container logs` : 'Container logs'} wide={!mobile}>
      <div className="section" style={{ gap: 14 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <span className="badge neutral" style={{ height: 28, color: 'var(--ink)' }}>
            <span className="dot" style={{ background: s.dot }} aria-hidden="true" />
            {s.label}
          </span>
          {c?.image && (
            <span className="mono" style={{ fontSize: 12, color: 'var(--muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '100%' }}>
              {c.image}
            </span>
          )}
          {docker && (
            <div style={{ marginLeft: mobile ? 0 : 'auto', display: 'flex', gap: 6, width: mobile ? '100%' : undefined }}>
              <button className="pill md" style={mobile ? { flex: 1 } : undefined} disabled={!!busy || !running} onClick={() => act('restart')}>
                <ArrowClockwise size={15} className={busy === 'restart' ? 'spin' : ''} />
                Restart
              </button>
              {running ? (
                <button className="pill md" style={mobile ? { flex: 1 } : undefined} disabled={!!busy || PROTECTED_STOP.has(service)} title={PROTECTED_STOP.has(service) ? 'Stop this one from the command line' : undefined} onClick={() => act('stop')}>
                  <Stop size={15} />
                  Stop
                </button>
              ) : (
                <button className="pill md" style={mobile ? { flex: 1 } : undefined} disabled={!!busy} onClick={() => act('start')}>
                  <Play size={15} />
                  Start
                </button>
              )}
            </div>
          )}
        </div>
        {c?.status && <div className="dim" style={{ fontSize: 12, marginTop: -6 }}>{c.status}</div>}
        {!docker ? (
          <Notice kind="info">
            Studio can't reach Docker, so it shows health checks only. To see logs and control containers, keep the <code>keel-docker</code> service in docker-compose.yml.
          </Notice>
        ) : (
          <>
            <div style={{ display: 'flex', gap: 8 }}>
              <label className="search-pill" style={{ flex: 1, height: 32 }}>
                <MagnifyingGlass size={14} />
                <input placeholder="Filter log lines (or WARN, ERROR)" value={filter} onChange={(e) => setFilter(e.target.value)} />
              </label>
              <select className="select" style={{ width: 'auto', height: 32 }} value={service} onChange={(e) => open({ kind: 'service', service: e.target.value })} aria-label="Service">
                {containers.map((x) => (
                  <option key={x.service}>{x.service}</option>
                ))}
              </select>
            </div>
            <div
              className="term"
              role="log"
              aria-live="polite"
              ref={box}
              style={{ maxHeight: mobile ? 'none' : 'calc(100vh - 330px)', minHeight: 200 }}
              onScroll={(e) => {
                const el = e.currentTarget;
                stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
              }}
            >
              {logs.error && <div className="lv-ERROR">{logs.error.message}</div>}
              {!logs.data && !logs.error && <div className="lv-INFO">Loading…</div>}
              {logs.data && lines.length === 0 && <div className="lv-INFO">{filter ? 'No matching lines.' : 'No log output yet.'}</div>}
              {lines.map((l, i) =>
                mobile ? (
                  <div key={i} style={{ padding: '3px 0' }}>
                    <span className="lv-INFO">{clock(l.t)}</span> <span className={`lv-${l.lvl}`}>{l.lvl}</span>
                    <div style={{ wordBreak: 'break-word' }}>{l.msg}</div>
                  </div>
                ) : (
                  <div className="log-line" key={i}>
                    <span className="t">{clock(l.t)}</span>
                    <span className={`lv-${l.lvl}`}>{l.lvl}</span>
                    <span className="m">{l.msg}</span>
                  </div>
                ),
              )}
            </div>
          </>
        )}
      </div>
    </Shell>
  );
}
