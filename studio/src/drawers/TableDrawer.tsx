import { useEffect, useMemo, useState } from 'react';
import { ArrowClockwise, ArrowLeft, CaretDown, CaretUp, FunnelSimple, Plus, ShieldCheck, TerminalWindow, Trash, X } from '@phosphor-icons/react';
import { del, enc, get, patch, post, put } from '../api';
import { Loading, Notice, Switch, useAction, useConfirm } from '../components/ui';
import { projectPath, useStudio } from '../ctx';
import { cell, count, plural, shortType } from '../lib/format';
import { useLoad } from '../lib/hooks';
import type { Column } from '../types';
import { Shell } from './Shell';

type Filter = { column: string; op: string; value: string };
type Rows = { columns: Column[]; rows: (string | null)[][]; total: number; rls: boolean; realtime: boolean };

const PAGE = 50;
const OPS: [string, string][] = [
  ['eq', 'equals'],
  ['neq', 'not equal'],
  ['gt', '>'],
  ['gte', '≥'],
  ['lt', '<'],
  ['lte', '≤'],
  ['ilike', 'contains'],
  ['in', 'in list'],
  ['is_null', 'is null'],
  ['not_null', 'is not null'],
];

export function TableDrawer({ table }: { table: string }) {
  const { project, schema, tables, mobile, reloadSchema, reloadOverview, open, close } = useStudio();
  const meta = tables.find((t) => t.name === table);
  const base = `${projectPath(project)}/tables/${enc(schema)}/${enc(table)}`;
  const [offset, setOffset] = useState(0);
  const [order, setOrder] = useState('');
  const [filters, setFilters] = useState<Filter[]>([]);
  const [draft, setDraft] = useState<Filter[]>([]);
  const [showFilters, setShowFilters] = useState(false);
  const [view, setView] = useState<'rows' | 'policies' | 'insert' | { edit: number }>('rows');
  const confirm = useConfirm();
  const { run } = useAction();

  const data = useLoad(
    () => get<Rows>(`${base}/rows?limit=${PAGE}&offset=${offset}&order=${enc(order)}&filters=${enc(JSON.stringify(filters))}`),
    [base, offset, order, JSON.stringify(filters)],
  );
  const d = data.data;
  const cols = d?.columns || meta?.columns || [];
  const pk = cols.filter((c) => c.pk);
  const total = d?.total ?? meta?.rows ?? 0;
  const rls = d?.rls ?? meta?.rls ?? false;
  const isView = meta && meta.kind !== 'table' && meta.kind !== 'partitioned table';

  useEffect(() => setOffset(0), [order, JSON.stringify(filters)]);

  const keyOf = (row: (string | null)[]) => Object.fromEntries(pk.map((c) => [c.name, row[cols.indexOf(c)]]));

  const afterWrite = async () => {
    await data.reload();
    void reloadSchema();
    void reloadOverview();
  };

  const sortBy = (c: string) => {
    const [col, dir] = order.split('.');
    setOrder(col !== c ? `${c}.asc` : dir === 'asc' ? `${c}.desc` : '');
  };

  const dropTable = async () => {
    const ok = await confirm({
      title: `Delete ${table}?`,
      body: 'The table and all its rows are deleted. This cannot be undone (unless you restore a backup).',
      confirm: 'Delete table',
      danger: true,
      typeToConfirm: table,
    });
    if (!ok) return;
    const done = await run('drop', () => del(base, { confirm: table }), `Deleted ${table}`);
    if (done) {
      close();
      void reloadSchema();
      void reloadOverview();
    }
  };

  const sub = isView ? `${meta?.kind}, read only here` : `${plural(total, "row")}, row level security ${rls ? "on" : "off"}`;
  const editing = typeof view === 'object' ? d?.rows[view.edit] : null;

  return (
    <Shell
      label={table}
      title={<span className="mono" style={{ fontSize: 20 }}>{table}</span>}
      sub={sub}
      wide={!mobile && cols.length > 5}
      actions={
        <>
          <button className="icon-btn" aria-label="Query in SQL editor" title="Query in SQL editor" onClick={() => open({ kind: 'sql', sql: `select *\nfrom ${schema === 'public' ? '' : schema + '.'}${table}\nlimit 100;` })}>
            <TerminalWindow size={15} />
          </button>
          {!isView && (
            <button className="icon-btn" aria-label="Delete table" title="Delete table" onClick={dropTable}>
              <Trash size={15} />
            </button>
          )}
        </>
      }
    >
      {view === 'policies' ? (
        <PoliciesPanel base={base} columns={cols} onBack={() => setView('rows')} onChanged={afterWrite} />
      ) : view === 'insert' || editing ? (
        <RowForm
          columns={cols}
          row={editing || null}
          onCancel={() => setView('rows')}
          onSave={async (values) => {
            const ok = editing
              ? await run('save', () => patch(`${base}/rows`, { key: keyOf(editing), values }), 'Row updated')
              : await run('save', () => post(`${base}/rows`, { values }), 'Row inserted');
            if (ok) {
              setView('rows');
              await afterWrite();
            }
          }}
          onDelete={
            editing && pk.length
              ? async () => {
                  if (!(await confirm({ title: 'Delete this row?', confirm: 'Delete row', danger: true }))) return;
                  const ok = await run('del', () => del(`${base}/rows`, { keys: [keyOf(editing)] }), 'Row deleted');
                  if (ok) {
                    setView('rows');
                    await afterWrite();
                  }
                }
              : undefined
          }
          canEdit={!isView && (!editing || pk.length > 0)}
        />
      ) : (
        <>
          <div className="toolbar">
            <button className={`pill${filters.length || showFilters ? ' on' : ''}`} onClick={() => {
              if (!showFilters) setDraft(filters.length ? filters : [{ column: cols[0]?.name || '', op: 'eq', value: '' }]);
              setShowFilters(!showFilters);
            }}>
              <FunnelSimple size={15} />
              Filter{filters.length ? ` (${filters.length})` : ''}
            </button>
            {!isView && (
              <button className="pill" onClick={() => setView('policies')}>
                <ShieldCheck size={15} />
                Policies{meta ? ` (${meta.policies})` : ''}
              </button>
            )}
            <button className="icon-btn sm ghost" aria-label="Refresh" title="Refresh" onClick={() => data.reload()}>
              <ArrowClockwise size={15} className={data.loading ? 'spin' : ''} />
            </button>
            {!isView && (
              <button className="btn-dark grow" onClick={() => setView('insert')}>
                <Plus size={15} />
                Insert row
              </button>
            )}
          </div>
          {showFilters && (
            <FilterBar
              columns={cols}
              draft={draft}
              setDraft={setDraft}
              onApply={() => setFilters(draft.filter((f) => f.column && (f.value !== '' || f.op === 'is_null' || f.op === 'not_null')))}
              onClear={() => {
                setDraft([]);
                setFilters([]);
                setShowFilters(false);
              }}
            />
          )}
          {!rls && !isView && (
            <div style={{ padding: '12px 22px 0' }}>
              <Notice kind="warn">
                Row level security is off: anyone with the anon key can read and change every row. Turn it on under <b>Policies</b>.
              </Notice>
            </div>
          )}
          {data.error ? (
            <div className="section">
              <Notice kind="err">{data.error.message}</Notice>
            </div>
          ) : !d ? (
            <Loading />
          ) : d.rows.length === 0 ? (
            <div className="empty">
              <b>{filters.length ? 'No rows match these filters' : 'No rows yet'}</b>
              {filters.length ? 'Try changing or clearing the filters.' : isView ? '' : 'Insert one here, through the API, or with SQL.'}
            </div>
          ) : mobile ? (
            <MobileRows columns={cols} rows={d.rows} onPick={(i) => setView({ edit: i })} />
          ) : (
            <div style={{ overflow: 'auto' }}>
              <table className="grid">
                <thead>
                  <tr>
                    {cols.map((c) => {
                      const [oc, od] = order.split('.');
                      return (
                        <th key={c.name}>
                          <button onClick={() => sortBy(c.name)} title={`Sort by ${c.name}`}>
                            {c.name}
                            {oc === c.name && (od === 'asc' ? <CaretUp size={11} /> : <CaretDown size={11} />)}
                          </button>
                          <span className="ty">{shortType(c.type)}</span>
                        </th>
                      );
                    })}
                  </tr>
                </thead>
                <tbody>
                  {d.rows.map((r, i) => (
                    <tr key={i} onClick={() => setView({ edit: i })}>
                      {r.map((v, j) => {
                        const c = cell(v, cols[j]?.type || 'text');
                        return (
                          <td key={j} className={c.cls} title={v ?? 'NULL'}>
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
          {d && d.rows.length > 0 && (
            <div className="grid-foot">
              <span className="grow">
                Showing {count(offset + 1)}-{count(offset + d.rows.length)} of {count(d.total)}
              </span>
              <button className="pill sm" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE))}>
                Previous
              </button>
              <button className="pill sm" disabled={offset + PAGE >= d.total} onClick={() => setOffset(offset + PAGE)}>
                Next
              </button>
            </div>
          )}
        </>
      )}
    </Shell>
  );
}

function FilterBar(props: { columns: Column[]; draft: Filter[]; setDraft: (f: Filter[]) => void; onApply: () => void; onClear: () => void }) {
  const { columns, draft, setDraft } = props;
  const update = (i: number, patch: Partial<Filter>) => setDraft(draft.map((f, j) => (j === i ? { ...f, ...patch } : f)));
  return (
    <form
      className="section"
      style={{ borderBottom: '1px solid var(--divider)', gap: 8 }}
      onSubmit={(e) => {
        e.preventDefault();
        props.onApply();
      }}
    >
      {draft.map((f, i) => (
        <div key={i} style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          <select className="select" style={{ flex: 1.2 }} value={f.column} onChange={(e) => update(i, { column: e.target.value })} aria-label="Column">
            {columns.map((c) => (
              <option key={c.name} value={c.name}>
                {c.name}
              </option>
            ))}
          </select>
          <select className="select" style={{ flex: 1 }} value={f.op} onChange={(e) => update(i, { op: e.target.value })} aria-label="Operator">
            {OPS.map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </select>
          <input
            className="input mono"
            style={{ flex: 1.4 }}
            value={f.value}
            disabled={f.op === 'is_null' || f.op === 'not_null'}
            placeholder={f.op === 'in' ? 'a, b, c' : f.op === 'ilike' ? '%text%' : 'value'}
            onChange={(e) => update(i, { value: e.target.value })}
            aria-label="Value"
          />
          <button type="button" className="icon-btn sm ghost" aria-label="Remove filter" onClick={() => setDraft(draft.filter((_, j) => j !== i))}>
            <X size={14} />
          </button>
        </div>
      ))}
      <div style={{ display: 'flex', gap: 6 }}>
        <button type="button" className="pill sm" onClick={() => setDraft([...draft, { column: columns[0]?.name || '', op: 'eq', value: '' }])}>
          <Plus size={13} /> Add filter
        </button>
        <button type="button" className="pill sm ghost" onClick={props.onClear}>
          Clear
        </button>
        <button type="submit" className="btn-dark" style={{ marginLeft: 'auto', height: 28, fontSize: 12 }}>
          Apply
        </button>
      </div>
    </form>
  );
}

function MobileRows({ columns, rows, onPick }: { columns: Column[]; rows: (string | null)[][]; onPick: (i: number) => void }) {
  let ti = columns.findIndex((c) => c.type === 'text' || c.type === 'varchar');
  if (ti < 0) ti = 0;
  return (
    <div className="section" style={{ gap: 10 }}>
      {rows.map((r, i) => (
        <button key={i} className="m-card" onClick={() => onPick(i)}>
          <div className="top">
            <b>{r[ti] ?? 'NULL'}</b>
            {ti !== 0 && <span className="mono dim" style={{ fontSize: 11, whiteSpace: 'nowrap' }}>{`${columns[0].name} ${r[0] ?? ''}`.slice(0, 24)}</span>}
          </div>
          <div className="pairs">
            {r
              .map((v, j) => ({ v, j }))
              .filter(({ j }) => j !== ti && j !== 0)
              .slice(0, 4)
              .map(({ v, j }) => {
                const c = cell(v, columns[j].type);
                return (
                  <div key={j} style={{ minWidth: 0 }}>
                    <div className="k">{columns[j].name}</div>
                    <div className={`v ${c.cls}`}>{c.text}</div>
                  </div>
                );
              })}
          </div>
        </button>
      ))}
    </div>
  );
}

function RowForm(props: {
  columns: Column[];
  row: (string | null)[] | null;
  onSave: (values: Record<string, string | null>) => void | Promise<void>;
  onCancel: () => void;
  onDelete?: () => void;
  canEdit: boolean;
}) {
  const { columns, row } = props;
  const initial = useMemo(() => Object.fromEntries(columns.map((c, i) => [c.name, row ? row[i] : null])), [columns, row]);
  const [values, setValues] = useState<Record<string, string | null>>(() => (row ? initial : Object.fromEntries(columns.map((c) => [c.name, '']))));
  const [touched, setTouched] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);

  const set = (name: string, v: string | null) => {
    setValues((s) => ({ ...s, [name]: v }));
    setTouched((t) => new Set(t).add(name));
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const out: Record<string, string | null> = {};
    for (const c of columns) {
      if (c.generated) continue;
      if (row) {
        if (touched.has(c.name) && values[c.name] !== initial[c.name]) out[c.name] = values[c.name];
      } else if (touched.has(c.name)) {
        out[c.name] = values[c.name];
      }
    }
    setBusy(true);
    try {
      await props.onSave(out);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit}>
      <div className="toolbar">
        <button type="button" className="pill" onClick={props.onCancel}>
          <ArrowLeft size={14} /> Rows
        </button>
        <b style={{ marginLeft: 4 }}>{row ? 'Edit row' : 'Insert row'}</b>
      </div>
      <div className="section">
        {!props.canEdit && <Notice kind="warn">This row can't be edited here because the table has no primary key. Use the SQL editor instead.</Notice>}
        {columns.map((c) => {
          const v = values[c.name];
          const isNull = v === null;
          const defaultHint = c.identity ? 'generated (identity)' : c.default ? `default: ${c.default}` : c.nullable ? 'NULL' : '';
          const disabled = !props.canEdit || c.generated || isNull;
          const common = {
            id: `f-${c.name}`,
            disabled,
            value: isNull ? '' : (v ?? ''),
            placeholder: row ? (isNull ? 'NULL' : '') : defaultHint,
            onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => set(c.name, e.target.value),
          };
          let input: React.ReactNode;
          if (c.type === 'bool') {
            input = (
              <select className="select" {...common} value={isNull ? '' : v === 't' || v === 'true' ? 'true' : v === 'f' || v === 'false' ? 'false' : ''}>
                <option value="">{row ? '' : defaultHint || 'choose…'}</option>
                <option value="true">true</option>
                <option value="false">false</option>
              </select>
            );
          } else if (c.type === 'json' || c.type === 'jsonb' || (c.type === 'text' && (v?.length || 0) > 60)) {
            input = <textarea className={`textarea${c.type.startsWith('json') ? ' mono' : ''}`} rows={c.type.startsWith('json') ? 4 : 3} {...common} />;
          } else {
            input = <input className={`input${c.type === 'text' || c.type === 'varchar' ? '' : ' mono'}`} {...common} />;
          }
          return (
            <div className="field" key={c.name}>
              <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <label htmlFor={`f-${c.name}`} style={{ color: 'var(--ink)', fontWeight: 600 }}>
                  {c.name}
                </label>
                <span className="mono dim" style={{ fontSize: 11 }}>
                  {c.format}
                </span>
                {c.pk && <span className="badge sm neutral">primary key</span>}
                {c.fk && <span className="badge sm neutral">→ {c.fk.schema === 'public' ? '' : c.fk.schema + '.'}{c.fk.table}</span>}
                {c.nullable && !c.generated && props.canEdit && (
                  <label className="check" style={{ marginLeft: 'auto', fontSize: 11.5, color: 'var(--dim)', fontWeight: 400 }}>
                    <input type="checkbox" checked={isNull && (!!row || touched.has(c.name))} onChange={(e) => set(c.name, e.target.checked ? null : '')} />
                    NULL
                  </label>
                )}
              </span>
              {input}
            </div>
          );
        })}
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          {props.onDelete && (
            <button type="button" className="pill md danger" onClick={props.onDelete}>
              <Trash size={14} /> Delete row
            </button>
          )}
          <span style={{ flex: 1 }} />
          <button type="button" className="pill md" onClick={props.onCancel}>
            Cancel
          </button>
          <button type="submit" className="btn-dark md" disabled={busy || !props.canEdit}>
            {busy ? 'Saving…' : row ? 'Save changes' : 'Insert row'}
          </button>
        </div>
      </div>
    </form>
  );
}

type Policy = { name: string; cmd: string; permissive: boolean; roles: string[]; using: string | null; check: string | null };
type PolicyInfo = { rls: boolean; realtime: boolean; replicaIdentityFull: boolean; policies: Policy[] };

function PoliciesPanel({ base, columns, onBack, onChanged }: { base: string; columns: Column[]; onBack: () => void; onChanged: () => void }) {
  const info = useLoad(() => get<PolicyInfo>(`${base}/policies`), [base]);
  const { busy, run } = useAction();
  const confirm = useConfirm();
  const [form, setForm] = useState<null | { name: string; command: string; roles: string[]; using: string; check: string }>(null);
  const ownerCol = columns.find((c) => c.fk?.schema === 'auth' && c.fk.table === 'users')?.name || columns.find((c) => c.name === 'user_id')?.name;

  const setting = async (patchBody: Record<string, boolean>, msg: string) => {
    const ok = await run('setting', () => put(`${base}/settings`, patchBody), msg);
    if (ok) {
      await info.reload();
      onChanged();
    }
  };

  const templates = [
    { label: 'Everyone can read', p: { name: 'Public read access', command: 'SELECT', roles: ['anon', 'authenticated'], using: 'true', check: '' } },
    { label: 'Signed-in users can read', p: { name: 'Signed-in users can read', command: 'SELECT', roles: ['authenticated'], using: 'true', check: '' } },
    ...(ownerCol
      ? [{ label: 'Users manage their own rows', p: { name: 'Users manage their own rows', command: 'ALL', roles: ['authenticated'], using: `${ownerCol} = auth.uid()`, check: `${ownerCol} = auth.uid()` } }]
      : []),
  ];

  const i = info.data;
  return (
    <>
      <div className="toolbar">
        <button className="pill" onClick={onBack}>
          <ArrowLeft size={14} /> Rows
        </button>
        <b style={{ marginLeft: 4 }}>Access</b>
      </div>
      {!i ? (
        info.error ? <div className="section"><Notice kind="err">{info.error.message}</Notice></div> : <Loading />
      ) : (
        <>
          <div className="section">
            <div className="setting">
              <span className="two-line">
                <span className="a">Row level security</span>
                <span className="b">When on, rows are only visible to API callers that a policy allows. The service role key always bypasses it.</span>
              </span>
              <Switch label="Row level security" checked={i.rls} disabled={busy === 'setting'} onChange={(v) => setting({ rls: v }, v ? 'Row level security on' : 'Row level security off')} />
            </div>
            <div className="setting">
              <span className="two-line">
                <span className="a">Realtime</span>
                <span className="b">Stream inserts, updates and deletes to subscribed clients (respecting policies).</span>
              </span>
              <Switch label="Realtime" checked={i.realtime} disabled={busy === 'setting'} onChange={(v) => setting({ realtime: v }, v ? 'Realtime on' : 'Realtime off')} />
            </div>
            {(i.realtime || i.replicaIdentityFull) && (
              <div className="setting">
                <span className="two-line">
                  <span className="a">Send old values on update and delete</span>
                  <span className="b">REPLICA IDENTITY FULL. Events include the previous row, and delete events can be checked against your policies; with it off, deletes on tables with row level security are not sent.</span>
                </span>
                <Switch label="Replica identity full" checked={i.replicaIdentityFull} disabled={busy === 'setting'} onChange={(v) => setting({ replicaIdentityFull: v }, 'Saved')} />
              </div>
            )}
          </div>
          <div className="section">
            <div style={{ display: 'flex', alignItems: 'center' }}>
              <h3 style={{ flex: 1 }}>Policies</h3>
              {!form && (
                <button className="btn-dark" onClick={() => setForm({ name: '', command: 'SELECT', roles: ['authenticated'], using: 'true', check: '' })}>
                  <Plus size={14} /> New policy
                </button>
              )}
            </div>
            {i.rls && i.policies.length === 0 && !form && <Notice kind="info">No policies yet, so only the service role can read or write this table through the API.</Notice>}
            {form && (
              <form
                className="policy"
                style={{ gap: 10 }}
                onSubmit={async (e) => {
                  e.preventDefault();
                  const ok = await run('policy', () => post(`${base}/policies`, form), 'Policy created');
                  if (ok) {
                    setForm(null);
                    await info.reload();
                    onChanged();
                  }
                }}
              >
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                  {templates.map((t) => (
                    <button type="button" key={t.label} className="pill sm" onClick={() => setForm(t.p)}>
                      {t.label}
                    </button>
                  ))}
                </div>
                <label className="field">
                  <span>Name</span>
                  <input className="input" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required />
                </label>
                <div className="form-grid">
                  <label className="field">
                    <span>Command</span>
                    <select className="select" value={form.command} onChange={(e) => setForm({ ...form, command: e.target.value })}>
                      {['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'ALL'].map((c) => (
                        <option key={c}>{c}</option>
                      ))}
                    </select>
                  </label>
                  <div className="field">
                    <span>Applies to</span>
                    <div style={{ display: 'flex', gap: 10, alignItems: 'center', height: 34, flexWrap: 'wrap' }}>
                      {['anon', 'authenticated'].map((r) => (
                        <label key={r} className="check mono" style={{ fontSize: 12 }}>
                          <input
                            type="checkbox"
                            checked={form.roles.includes(r)}
                            onChange={(e) => setForm({ ...form, roles: e.target.checked ? [...form.roles, r] : form.roles.filter((x) => x !== r) })}
                          />
                          {r}
                        </label>
                      ))}
                    </div>
                  </div>
                </div>
                {form.command !== 'INSERT' && (
                  <label className="field">
                    <span>Using (which existing rows)</span>
                    <textarea className="textarea mono" rows={2} value={form.using} onChange={(e) => setForm({ ...form, using: e.target.value })} placeholder="user_id = auth.uid()" />
                  </label>
                )}
                {form.command !== 'SELECT' && form.command !== 'DELETE' && (
                  <label className="field">
                    <span>With check (which new rows)</span>
                    <textarea className="textarea mono" rows={2} value={form.check} onChange={(e) => setForm({ ...form, check: e.target.value })} placeholder="user_id = auth.uid()" />
                  </label>
                )}
                <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
                  <button type="button" className="pill md" onClick={() => setForm(null)}>
                    Cancel
                  </button>
                  <button type="submit" className="btn-dark md" disabled={busy === 'policy'}>
                    {busy === 'policy' ? 'Saving…' : 'Create policy'}
                  </button>
                </div>
              </form>
            )}
            {i.policies.map((p) => (
              <div className="policy" key={p.name}>
                <div className="hd">
                  <b>{p.name}</b>
                  <span className="badge sm neutral mono">{p.cmd}</span>
                  {!p.permissive && <span className="badge sm warn">restrictive</span>}
                  <button
                    className="icon-btn sm ghost"
                    aria-label={`Delete policy ${p.name}`}
                    onClick={async () => {
                      if (!(await confirm({ title: `Delete policy “${p.name}”?`, confirm: 'Delete policy', danger: true }))) return;
                      const ok = await run('drop', () => del(`${base}/policies/${enc(p.name)}`), 'Policy deleted');
                      if (ok) {
                        await info.reload();
                        onChanged();
                      }
                    }}
                  >
                    <Trash size={14} />
                  </button>
                </div>
                <div className="dim" style={{ fontSize: 12 }}>
                  to {p.roles.join(', ')}
                </div>
                {p.using && (
                  <div>
                    <span className="dim" style={{ fontSize: 11 }}>using </span>
                    <code>{p.using}</code>
                  </div>
                )}
                {p.check && (
                  <div>
                    <span className="dim" style={{ fontSize: 11 }}>with check </span>
                    <code>{p.check}</code>
                  </div>
                )}
              </div>
            ))}
            <div className="dim" style={{ fontSize: 12 }}>
              {plural(i.policies.length, 'policy', 'policies')}. Helpers: <code className="code-inline">auth.uid()</code>, <code className="code-inline">auth.role()</code>, <code className="code-inline">auth.jwt()</code>.
            </div>
          </div>
        </>
      )}
    </>
  );
}
