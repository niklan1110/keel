import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowsClockwise, MagnifyingGlassMinus, MagnifyingGlassPlus, Plus, Table as TableIcon, TerminalWindow } from '@phosphor-icons/react';
import { useStudio } from '../ctx';
import { count, shortType } from '../lib/format';
import { MAX_ROWS, NODE_W, autoLayout, bounds, edges, type Pos } from '../lib/layout';
import type { Table } from '../types';
import { Loading } from './ui';

type Drag = { name: string; startX: number; startY: number; orig: Pos; moved: boolean };

function loadLayout(key: string): Record<string, Pos> {
  try {
    return JSON.parse(localStorage.getItem(key) || '{}');
  } catch {
    return {};
  }
}

export function Canvas({ tables, loading, selected }: { tables: Table[]; loading: boolean; selected: string | null }) {
  const { project, schema, open } = useStudio();
  const key = `keel.layout.${project}.${schema}`;
  const [saved, setSaved] = useState<Record<string, Pos>>(() => loadLayout(key));
  const [scale, setScale] = useState(1);
  const [drag, setDrag] = useState<Drag | null>(null);
  const [live, setLive] = useState<Record<string, Pos>>({});
  const justDragged = useRef(false);
  const scroller = useRef<HTMLDivElement>(null);
  const pan = useRef<{ x: number; y: number; sl: number; st: number } | null>(null);

  useEffect(() => setSaved(loadLayout(key)), [key]);

  const auto = useMemo(() => autoLayout(tables), [tables]);
  const pos = useMemo(() => {
    const out: Record<string, Pos> = {};
    for (const t of tables) out[t.name] = live[t.name] || saved[t.name] || auto[t.name];
    return out;
  }, [tables, auto, saved, live]);
  const lines = useMemo(() => edges(tables, pos), [tables, pos]);
  const size = useMemo(() => bounds(tables, pos), [tables, pos]);

  const persist = (next: Record<string, Pos>) => {
    setSaved(next);
    try {
      localStorage.setItem(key, JSON.stringify(next));
    } catch {
      /* ignore */
    }
  };

  const onNodeDown = (e: React.PointerEvent, name: string) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    setDrag({ name, startX: e.clientX, startY: e.clientY, orig: pos[name], moved: false });
  };
  const onNodeMove = (e: React.PointerEvent) => {
    if (!drag) return;
    const dx = (e.clientX - drag.startX) / scale;
    const dy = (e.clientY - drag.startY) / scale;
    if (!drag.moved && Math.hypot(dx, dy) < 4) return;
    if (!drag.moved) setDrag({ ...drag, moved: true });
    setLive({ [drag.name]: { x: Math.max(0, Math.round(drag.orig.x + dx)), y: Math.max(0, Math.round(drag.orig.y + dy)) } });
  };
  const onNodeUp = () => {
    if (drag?.moved && live[drag.name]) {
      persist({ ...saved, [drag.name]: live[drag.name] });
      justDragged.current = true;
      setTimeout(() => (justDragged.current = false), 0);
    }
    setLive({});
    setDrag(null);
  };

  const onBgDown = (e: React.PointerEvent) => {
    if (e.button !== 0 || e.target !== e.currentTarget && !(e.target as HTMLElement).classList.contains('canvas-inner') && !(e.target as HTMLElement).classList.contains('canvas-plane')) return;
    const el = scroller.current!;
    pan.current = { x: e.clientX, y: e.clientY, sl: el.scrollLeft, st: el.scrollTop };
    el.setPointerCapture(e.pointerId);
  };
  const onBgMove = (e: React.PointerEvent) => {
    if (!pan.current) return;
    const el = scroller.current!;
    el.scrollLeft = pan.current.sl - (e.clientX - pan.current.x);
    el.scrollTop = pan.current.st - (e.clientY - pan.current.y);
  };
  const onBgUp = () => (pan.current = null);

  const zoom = (d: number) => setScale((s) => Math.min(1.3, Math.max(0.5, Math.round((s + d) * 10) / 10)));

  if (loading) {
    return (
      <div className="canvas">
        <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <Loading label="Reading schema…" />
        </div>
      </div>
    );
  }

  return (
    <>
      <div
        className={`canvas${pan.current ? ' grabbing' : ''}`}
        ref={scroller}
        onPointerDown={onBgDown}
        onPointerMove={onBgMove}
        onPointerUp={onBgUp}
        onWheel={(e) => {
          if (e.ctrlKey || e.metaKey) {
            e.preventDefault();
            zoom(e.deltaY > 0 ? -0.1 : 0.1);
          }
        }}
      >
        {tables.length === 0 ? (
          <div className="canvas-empty">
            <h2>No tables in {schema} yet</h2>
            <p className="muted" style={{ margin: '0 0 16px' }}>
              Create a table to start storing data. New tables get row level security, so nothing is public until you add a policy.
            </p>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <button className="btn-dark md" onClick={() => open({ kind: 'new-table' })}>
                <Plus size={15} /> New table
              </button>
              <button className="pill md" onClick={() => open({ kind: 'sql' })}>
                <TerminalWindow size={15} /> Open SQL editor
              </button>
            </div>
          </div>
        ) : (
          <div className="canvas-inner" style={{ width: size.w * scale, height: size.h * scale }}>
            <div className="canvas-plane" style={{ position: 'absolute', left: 0, top: 0, width: size.w, height: size.h, transform: `scale(${scale})`, transformOrigin: '0 0' }}>
              <svg className="edges" width={size.w} height={size.h} aria-hidden="true">
                {lines.map((l) => {
                  const hot = !!selected && (l.from === selected || l.to === selected);
                  return (
                    <g key={`${l.from}.${l.fromCol}`}>
                      <path d={l.d} fill="none" stroke={hot ? 'var(--accent)' : '#b9bcc3'} strokeWidth={hot ? 2 : 1.25} />
                      <circle cx={l.ex} cy={l.ey} r={3.5} fill={hot ? 'var(--accent)' : '#b9bcc3'} />
                    </g>
                  );
                })}
              </svg>
              {tables.map((t) => (
                <Node
                  key={t.name}
                  table={t}
                  pos={pos[t.name]}
                  on={selected === t.name}
                  dragging={drag?.name === t.name && drag.moved}
                  onPointerDown={(e) => onNodeDown(e, t.name)}
                  onPointerMove={onNodeMove}
                  onPointerUp={onNodeUp}
                  onClick={() => {
                    if (!justDragged.current) open({ kind: 'table', table: t.name });
                  }}
                />
              ))}
            </div>
          </div>
        )}
      </div>
      {tables.length > 0 && (
        <div className="canvas-tools">
          <button className="icon-btn sm ghost" aria-label="Zoom out" title="Zoom out" onClick={() => zoom(-0.1)}>
            <MagnifyingGlassMinus size={15} />
          </button>
          <button className="icon-btn sm ghost" aria-label="Zoom in" title="Zoom in" onClick={() => zoom(0.1)}>
            <MagnifyingGlassPlus size={15} />
          </button>
          <button
            className="icon-btn sm ghost"
            aria-label="Tidy layout"
            title="Tidy layout"
            onClick={() => {
              persist({});
              setScale(1);
            }}
          >
            <ArrowsClockwise size={15} />
          </button>
          <button className="icon-btn sm ghost" aria-label="New table" title="New table" onClick={() => open({ kind: 'new-table' })}>
            <Plus size={15} />
          </button>
        </div>
      )}
    </>
  );
}

function Node(props: {
  table: Table;
  pos: Pos;
  on: boolean;
  dragging: boolean;
  onPointerDown: (e: React.PointerEvent) => void;
  onPointerMove: (e: React.PointerEvent) => void;
  onPointerUp: () => void;
  onClick: () => void;
}) {
  const t = props.table;
  const shown = t.columns.slice(0, MAX_ROWS);
  const hidden = t.columns.length - shown.length;
  return (
    <button
      className={`node${props.on ? ' on' : ''}${props.dragging ? ' dragging' : ''}`}
      style={{ left: props.pos.x, top: props.pos.y, width: NODE_W }}
      aria-label={`Open ${t.name}`}
      onPointerDown={props.onPointerDown}
      onPointerMove={props.onPointerMove}
      onPointerUp={props.onPointerUp}
      onClick={props.onClick}
    >
      <div className="node-head">
        <TableIcon size={15} />
        <span className="n">{t.name}</span>
        {t.kind !== 'table' && t.kind !== 'partitioned table' ? (
          <span className="node-tag view">{t.kind === 'materialized view' ? 'mat. view' : t.kind}</span>
        ) : !t.rls ? (
          <span className="node-tag warn" title="Row level security is off: anyone with the anon key can read and write this table">
            RLS off
          </span>
        ) : null}
        <span className="c">{t.kind === 'view' ? '' : (t.exact ? '' : '~') + count(t.rows)}</span>
      </div>
      {shown.map((c) => {
        const key = c.pk ? 'PK' : c.fk ? 'FK' : '';
        return (
          <div className="node-row" key={c.name}>
            <span className={`k ${c.pk ? 'pk' : 'fk'}`}>{key}</span>
            <span className="nm">{c.name}</span>
            <span className="ty">{shortType(c.type)}</span>
          </div>
        );
      })}
      {hidden > 0 && (
        <div className="node-row more">
          <span className="k" />+{hidden} more column{hidden === 1 ? '' : 's'}
        </div>
      )}
    </button>
  );
}
