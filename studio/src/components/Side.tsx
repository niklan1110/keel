import { useEffect, useRef, useState } from 'react';
import { CaretDown, CircleNotch, DownloadSimple } from '@phosphor-icons/react';
import { get, post } from '../api';
import { projectPath, useStudio } from '../ctx';
import { bytes, count, stamp } from '../lib/format';
import type { Container } from '../types';
import { useAction } from './ui';

export function statusOf(c: Container): { label: string; color: string; dot: string } {
  if (c.state === 'running') {
    if (c.health === 'unhealthy') return { label: 'Unhealthy', color: 'var(--err)', dot: 'var(--err)' };
    if (c.health === 'health: starting') return { label: 'Starting…', color: 'var(--warn)', dot: 'var(--warn)' };
    return { label: 'Running', color: 'var(--ink)', dot: 'var(--ok)' };
  }
  if (c.state === 'restarting') return { label: 'Restarting', color: 'var(--warn)', dot: 'var(--warn)' };
  if (c.state === 'paused') return { label: 'Paused', color: 'var(--warn)', dot: 'var(--warn)' };
  return { label: 'Stopped', color: 'var(--muted)', dot: 'var(--dim)' };
}

export function ProjectCard({ setSchema }: { setSchema: (s: string) => void }) {
  const { project, schema, tables, tablesLoaded, overview } = useStudio();
  const n = tables.filter((t) => t.kind === 'table' || t.kind === 'partitioned table').length;
  return (
    <div className="card proj-card">
      <h1>{project}</h1>
      <div className="desc">
        {!tablesLoaded ? 'Reading ' : n === 0 ? 'No tables in ' : `${n} table${n === 1 ? '' : 's'} in `}
        <SchemaPicker schema={schema} setSchema={setSchema} />
        {!tablesLoaded ? '…' : n === 0 ? ' yet.' : '. Click one to browse rows.'}
      </div>
      <div className="stats">
        <Stat value={overview ? bytes(overview.sizeBytes) : '–'} label="Database size" />
        <Stat value={overview ? count(overview.tables) : '–'} label="Tables" />
        <Stat value={overview ? count(overview.users) : '–'} label="Auth users" />
        <Stat value={overview ? bytes(overview.storageBytes) : '–'} label="Storage" />
      </div>
    </div>
  );
}

function Stat({ value, label }: { value: string; label: string }) {
  return (
    <div className="stat">
      <div className="v">{value}</div>
      <div className="l">{label}</div>
    </div>
  );
}

function SchemaPicker({ schema, setSchema }: { schema: string; setSchema: (s: string) => void }) {
  const { project } = useStudio();
  const [open, setOpen] = useState(false);
  const [schemas, setSchemas] = useState<string[] | null>(null);
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!open) return;
    get<string[]>(`${projectPath(project)}/schemas`).then(setSchemas, () => setSchemas([]));
    const onDown = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && setOpen(false);
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open, project]);
  return (
    <span ref={ref} style={{ position: 'relative' }}>
      <button className="schema-pick" onClick={() => setOpen(!open)} aria-label="Change schema">
        {schema}
        <CaretDown size={11} />
      </button>
      {open && (
        <div className="menu" style={{ width: 200 }}>
          {(schemas || [schema]).map((s) => (
            <button
              key={s}
              className="menu-item"
              onClick={() => {
                setSchema(s);
                setOpen(false);
              }}
            >
              <span className="mono" style={{ fontSize: 12, fontWeight: s === schema ? 600 : 400 }}>
                {s}
              </span>
            </button>
          ))}
        </div>
      )}
    </span>
  );
}

export function StackCard({ selected }: { selected: string | null }) {
  const { containers, overview, project, open, reloadOverview } = useStudio();
  const { busy, run } = useAction();
  const running = containers.filter((c) => c.state === 'running').length;
  const backingUp = busy === 'backup' || !!overview?.backupRunning;
  return (
    <div className="card stack-card">
      <div className="stack-head">
        <b>Stack</b>
        <span>{containers.length ? `${running} of ${containers.length} containers running` : 'Checking…'}</span>
      </div>
      {containers.map((c) => {
        const s = statusOf(c);
        return (
          <button key={c.service} className={`svc${selected === c.service ? ' on' : ''}`} onClick={() => open({ kind: 'service', service: c.service })}>
            <span className="dot" style={{ background: s.dot }} aria-hidden="true" />
            <span className="nm">{c.service}</span>
            <span className="st" style={{ color: s.color }}>
              {s.label}
            </span>
          </button>
        );
      })}
      <div className="stack-foot">
        <button className="lb" onClick={() => open({ kind: 'backups' })} title="Show backups">
          Last backup {overview?.lastBackup ? stamp(overview.lastBackup.createdAt) : 'never'}
        </button>
        <button
          className="pill sm"
          disabled={backingUp}
          onClick={() =>
            run('backup', async () => {
              await post(`${projectPath(project)}/backups`);
              await reloadOverview();
            }, 'Backup complete')
          }
        >
          {backingUp ? <CircleNotch size={13} className="spin" /> : <DownloadSimple size={13} />}
          {backingUp ? 'Backing up…' : 'Back up now'}
        </button>
      </div>
    </div>
  );
}
