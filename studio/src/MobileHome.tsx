import type { ReactNode } from 'react';
import { CaretRight, PlugsConnected, Table as TableIcon } from '@phosphor-icons/react';
import { Dock } from './components/Dock';
import { statusOf } from './components/Side';
import { useStudio } from './ctx';
import { DrawerHost } from './drawers/DrawerHost';
import { bytes, count, plural, shortType } from './lib/format';
import type { Drawer } from './types';

export function MobileHome({ switcher, drawer }: { switcher: ReactNode; drawer: Drawer | null }) {
  const { project, tables, tablesLoaded, overview, containers, open } = useStudio();
  const running = containers.filter((c) => c.state === 'running').length;
  return (
    <div className="m-app">
      <header className="m-header">
        <span className="logo">
          keel<span>.</span>
        </span>
        {switcher}
        <button className="m-round" aria-label="Connect" onClick={() => open({ kind: 'connect' })}>
          <PlugsConnected size={18} />
        </button>
      </header>
      <div className="m-scroll">
        <div>
          <h1>{project}</h1>
          <div className="m-stats">
            {[
              [overview ? bytes(overview.sizeBytes) : '–', 'Database size'],
              [overview ? count(overview.tables) : '–', 'Tables'],
              [overview ? count(overview.users) : '–', 'Auth users'],
              [overview ? bytes(overview.storageBytes) : '–', 'Storage'],
            ].map(([v, l]) => (
              <div key={l}>
                <div style={{ fontSize: 20, fontWeight: 600, letterSpacing: '-0.02em' }}>{v}</div>
                <div style={{ fontSize: 12, color: 'var(--dim)' }}>{l}</div>
              </div>
            ))}
          </div>
        </div>
        <div>
          <div className="m-title">
            <b>Stack</b>
            <span>{containers.length ? `${running} of ${containers.length} containers running` : ''}</span>
          </div>
          <div className="chips">
            {containers.map((c) => (
              <button key={c.service} className="chip" onClick={() => open({ kind: 'service', service: c.service })}>
                <span className="dot" style={{ background: statusOf(c).dot }} aria-hidden="true" />
                {c.service}
              </button>
            ))}
          </div>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div className="m-title" style={{ marginBottom: 0 }}>
            <b>Schema</b>
            <button className="pill sm" onClick={() => open({ kind: 'new-table' })}>
              New table
            </button>
          </div>
          {tablesLoaded && tables.length === 0 && <div className="empty">No tables yet. Create one, or use the SQL editor.</div>}
          {tables.map((t) => (
            <button key={t.name} className="m-table" onClick={() => open({ kind: 'table', table: t.name })}>
              <div className="hd">
                <TableIcon size={17} />
                <span className="n">{t.name}</span>
                <span className="c">{plural(t.rows, "row")}</span>
                <CaretRight size={14} color="var(--faint)" />
              </div>
              <div className="cols">
                {t.columns.slice(0, 8).map((c) => (
                  <div className="col" key={c.name}>
                    <span className="k" style={{ color: c.pk ? 'var(--accent)' : 'var(--blue)' }}>
                      {c.pk ? 'PK' : c.fk ? 'FK' : ''}
                    </span>
                    <span className="nm">{c.name}</span>
                    <span style={{ color: c.fk ? 'var(--blue)' : 'var(--dim)' }}>{c.fk ? `→ ${c.fk.table}` : shortType(c.type)}</span>
                  </div>
                ))}
                {t.columns.length > 8 && <div className="col dim">+{t.columns.length - 8} more</div>}
              </div>
            </button>
          ))}
        </div>
      </div>
      <Dock drawer={drawer} mobile />
      {drawer && <DrawerHost drawer={drawer} />}
    </div>
  );
}
