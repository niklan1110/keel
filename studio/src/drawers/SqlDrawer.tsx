import { useEffect, useMemo, useRef, useState } from 'react';
import { CaretDown, CircleNotch, FloppyDisk, Play, Plus, Trash } from '@phosphor-icons/react';
import { api, del, get, post, put } from '../api';
import { Notice, useAction, useConfirm, useToast } from '../components/ui';
import { projectPath, useStudio } from '../ctx';
import { cell, count } from '../lib/format';
import { tokenize } from '../lib/sql';
import { Shell } from './Shell';

type Saved = { id: string; name: string; sql: string; updated_at: string };
type Result = { command: string; rowCount: number | null; fields: { name: string; type: string }[]; rows: (string | null)[][]; truncated: boolean };
type RunOk = { durationMs: number; results: Result[] };
type RunErr = { message: string; detail?: string; hint?: string; position?: number; code?: string; durationMs?: number; offset?: number };

const DDL = /^\s*(create|alter|drop|comment|grant|revoke|truncate)\b/im;

export function SqlDrawer({ initial }: { initial?: string }) {
  const { project, tables, mobile, reloadSchema, reloadOverview } = useStudio();
  const draftKey = `keel.sql.draft.${project}`;
  const [sql, setSql] = useState<string>(() => {
    if (initial) return initial;
    try {
      const d = localStorage.getItem(draftKey);
      if (d) return d;
    } catch {
      /* ignore */
    }
    const first = tables.find((t) => t.kind === 'table');
    return first ? `select *\nfrom ${first.name}\nlimit 20;` : `-- Write SQL here and press ⌘↵ (Ctrl+Enter) to run it.\ncreate table notes (\n  id bigint generated always as identity primary key,\n  body text not null,\n  created_at timestamptz not null default now()\n);`;
  });
  const [current, setCurrent] = useState<Saved | null>(null);
  const [saved, setSaved] = useState<Saved[]>([]);
  const [menu, setMenu] = useState(false);
  const [running, setRunning] = useState(false);
  const [out, setOut] = useState<RunOk | null>(null);
  const [err, setErr] = useState<RunErr | null>(null);
  const [tab, setTab] = useState(0);
  const toast = useToast();
  const confirm = useConfirm();
  const { run } = useAction();
  const ta = useRef<HTMLTextAreaElement>(null);
  const base = projectPath(project);

  useEffect(() => {
    get<Saved[]>(`${base}/queries`).then(setSaved, () => {});
  }, [base]);

  useEffect(() => {
    try {
      localStorage.setItem(draftKey, sql);
    } catch {
      /* ignore */
    }
  }, [sql, draftKey]);

  const exec = async () => {
    if (running) return;
    const el = ta.current;
    const hasSelection = !!el && el.selectionStart !== el.selectionEnd;
    const selected = hasSelection ? sql.slice(el.selectionStart, el.selectionEnd) : sql;
    // Error positions are relative to what ran; remember where that starts in the editor.
    const offset = hasSelection ? el.selectionStart : 0;
    setRunning(true);
    setErr(null);
    try {
      const r = await api<RunOk>('POST', `${base}/sql`, { query: selected });
      setOut(r);
      const withRows = r.results.map((x, i) => ({ x, i })).filter(({ x }) => x.fields.length);
      setTab(withRows.length ? withRows[withRows.length - 1].i : r.results.length - 1);
      if (DDL.test(selected)) {
        void reloadSchema();
        void reloadOverview();
      }
    } catch (e) {
      const body = (e as { body?: RunErr }).body;
      setErr(body?.message ? { ...body, offset } : { message: (e as Error).message });
      setOut(null);
    } finally {
      setRunning(false);
    }
  };

  const save = async () => {
    if (current) {
      const row = await run('save', () => put<Saved>(`${base}/queries/${current.id}`, { sql }), 'Query saved');
      if (row) {
        setCurrent(row);
        setSaved((s) => [row, ...s.filter((x) => x.id !== row.id)]);
      }
      return;
    }
    const name = window.prompt('Name this query', firstLine(sql) || 'Untitled query');
    if (!name) return;
    const row = await run('save', () => post<Saved>(`${base}/queries`, { name, sql }), 'Query saved');
    if (row) {
      setCurrent(row);
      setSaved((s) => [row, ...s]);
    }
  };

  const errLine = useMemo(() => {
    if (!err?.position) return null;
    const before = sql.slice(0, (err.offset || 0) + err.position - 1);
    return before.split('\n').length;
  }, [err, sql]);

  const result = out?.results[tab];
  const meta = running
    ? 'Running…'
    : err
      ? `Error${err.durationMs !== undefined ? ` after ${err.durationMs} ms` : ''}`
      : out
        ? result?.fields.length
          ? `${count(result.rows.length)}${result.truncated ? '+' : ''} row${result.rows.length === 1 ? '' : 's'} in ${out.durationMs} ms`
          : `${result?.command || 'OK'}${result?.rowCount ? ` ${count(result.rowCount)}` : ''} in ${out.durationMs} ms`
        : 'Press Run or ⌘↵ to execute. Select text to run just that part.';

  return (
    <Shell label="SQL" title="SQL" sub={current?.name || 'Untitled query'} wide={!mobile}>
      <div className="section">
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <div style={{ position: 'relative', flex: 1, minWidth: 0 }}>
            <button className="pill" style={{ maxWidth: '100%' }} onClick={() => setMenu(!menu)} aria-expanded={menu}>
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', fontWeight: 600 }}>{current?.name || 'Saved queries'}</span>
              <CaretDown size={12} />
            </button>
            {menu && (
              <div className="menu" style={{ width: 300 }}>
                <button
                  className="menu-item"
                  onClick={() => {
                    setCurrent(null);
                    setSql('');
                    setMenu(false);
                    setOut(null);
                    setErr(null);
                    ta.current?.focus();
                  }}
                >
                  <Plus size={14} color="var(--muted)" />
                  <span className="t" style={{ fontWeight: 500 }}>New query</span>
                </button>
                {saved.length > 0 && <div className="menu-sep" />}
                {saved.map((q) => (
                  <div key={q.id} style={{ display: 'flex', alignItems: 'center' }}>
                    <button
                      className="menu-item"
                      onClick={() => {
                        setCurrent(q);
                        setSql(q.sql);
                        setMenu(false);
                        setOut(null);
                        setErr(null);
                      }}
                    >
                      <span style={{ minWidth: 0 }}>
                        <span className="t" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{q.name}</span>
                        <span className="s mono" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{firstLine(q.sql)}</span>
                      </span>
                    </button>
                    <button
                      className="icon-btn sm ghost"
                      aria-label={`Delete ${q.name}`}
                      onClick={async () => {
                        if (!(await confirm({ title: `Delete “${q.name}”?`, confirm: 'Delete', danger: true }))) return;
                        await del(`${base}/queries/${q.id}`).catch((e) => toast(e.message, true));
                        setSaved((s) => s.filter((x) => x.id !== q.id));
                        if (current?.id === q.id) setCurrent(null);
                      }}
                    >
                      <Trash size={13} />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
          <button className="pill md" onClick={save} title="Save query">
            <FloppyDisk size={15} /> Save
          </button>
          <button className="btn-dark md" onClick={exec} disabled={running}>
            {running ? <CircleNotch size={15} className="spin" /> : <Play size={15} weight="fill" />}
            {running ? 'Running…' : 'Run'}
            {!mobile && <span className="mono" style={{ fontSize: 11, opacity: 0.6 }}>⌘↵</span>}
          </button>
        </div>
        <Editor value={sql} onChange={setSql} onRun={exec} taRef={ta} errorLine={errLine} />
        <div style={{ fontSize: 12, color: err ? 'var(--err)' : 'var(--dim)' }}>{meta}</div>
        {err && (
          <Notice kind="err">
            <div style={{ fontFamily: 'var(--mono)', fontSize: 12 }}>
              {err.message}
              {errLine ? ` (line ${errLine})` : ''}
            </div>
            {err.detail && <div style={{ marginTop: 4 }}>{err.detail}</div>}
            {err.hint && <div style={{ marginTop: 4 }}>Hint: {err.hint}</div>}
          </Notice>
        )}
        {out && out.results.length > 1 && (
          <div className="tabs" role="tablist">
            {out.results.map((r, i) => (
              <button key={i} role="tab" aria-selected={i === tab} onClick={() => setTab(i)} style={{ height: 26, fontSize: 12 }}>
                {i + 1}. {r.command || 'OK'}
              </button>
            ))}
          </div>
        )}
        {result && result.fields.length > 0 && (
          <div style={{ border: '1px solid var(--border)', borderRadius: 12, overflow: 'auto', opacity: running ? 0.35 : 1, transition: 'opacity .2s', maxHeight: mobile ? undefined : '48vh' }}>
            <table className="grid static">
              <thead>
                <tr>
                  {result.fields.map((f, i) => (
                    <th key={i} style={{ padding: '9px 12px' }}>
                      {f.name}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {result.rows.map((r, i) => (
                  <tr key={i}>
                    {r.map((v, j) => {
                      const c = cell(v, result.fields[j]?.type || 'text');
                      return (
                        <td key={j} className={c.cls} style={{ padding: '9px 12px' }} title={v ?? 'NULL'}>
                          {c.text}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {result?.truncated && <div className="dim" style={{ fontSize: 12 }}>Showing the first 1,000 rows. Add a limit to see a specific range.</div>}
      </div>
    </Shell>
  );
}

function firstLine(s: string): string {
  return s.split('\n').map((l) => l.trim()).find((l) => l && !l.startsWith('--'))?.slice(0, 60) || '';
}

/** Textarea layered over a highlighted <pre>, with line numbers, like the design's code block. */
function Editor({ value, onChange, onRun, taRef, errorLine }: { value: string; onChange: (v: string) => void; onRun: () => void; taRef: React.RefObject<HTMLTextAreaElement | null>; errorLine: number | null }) {
  const lines = useMemo(() => tokenize(value), [value]);
  return (
    <div className="code">
      <div className="editor">
        <div className="gutter" aria-hidden="true">
          {lines.map((_, i) => (
            <div key={i} style={i + 1 === errorLine ? { color: 'var(--err)', fontWeight: 500 } : undefined}>
              {i + 1}
            </div>
          ))}
        </div>
        <div className="surface">
          <pre aria-hidden="true">
            {lines.map((toks, i) => (
              <div key={i} style={i + 1 === errorLine ? { background: 'var(--err-bg)' } : undefined}>
                {toks.length ? toks.map((t, j) => (t.c ? <span key={j} className={t.c}>{t.t}</span> : t.t)) : '​'}
              </div>
            ))}
          </pre>
          <textarea
            ref={taRef}
            aria-label="SQL"
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            value={value}
            onChange={(e) => onChange(e.target.value)}
            onKeyDown={(e) => {
              if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
                e.preventDefault();
                onRun();
              } else if (e.key === 'Tab' && !e.shiftKey) {
                e.preventDefault();
                const el = e.currentTarget;
                const s = el.selectionStart;
                const next = value.slice(0, s) + '  ' + value.slice(el.selectionEnd);
                onChange(next);
                requestAnimationFrame(() => el.setSelectionRange(s + 2, s + 2));
              }
            }}
          />
        </div>
      </div>
    </div>
  );
}
