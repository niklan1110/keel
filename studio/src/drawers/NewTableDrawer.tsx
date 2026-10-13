import { useState } from 'react';
import { Plus, X } from '@phosphor-icons/react';
import { post } from '../api';
import { Notice, Switch, useAction } from '../components/ui';
import { projectPath, useStudio } from '../ctx';
import { Shell } from './Shell';

type Col = { name: string; type: string; default: string; nullable: boolean; pk: boolean; unique: boolean; references: string };

const TYPES = ['int8', 'int4', 'text', 'varchar(255)', 'bool', 'numeric', 'float8', 'uuid', 'timestamptz', 'date', 'jsonb', 'text[]', 'int8[]', 'bytea'];
const DEFAULTS: Record<string, string[]> = {
  int8: ['identity', '0'],
  int4: ['identity', '0'],
  uuid: ['gen_random_uuid()', 'auth.uid()'],
  timestamptz: ['now()'],
  date: ['current_date'],
  bool: ['false', 'true'],
  jsonb: ["'{}'"],
  'text[]': ["'{}'"],
};

const blank = (): Col => ({ name: '', type: 'text', default: '', nullable: true, pk: false, unique: false, references: '' });

export function NewTableDrawer() {
  const { project, schema, tables, open, reloadSchema, reloadOverview } = useStudio();
  const [name, setName] = useState('');
  const [cols, setCols] = useState<Col[]>([
    { name: 'id', type: 'int8', default: 'identity', nullable: false, pk: true, unique: false, references: '' },
    { name: 'created_at', type: 'timestamptz', default: 'now()', nullable: false, pk: false, unique: false, references: '' },
    blank(),
  ]);
  const [rls, setRls] = useState(true);
  const [realtime, setRealtime] = useState(false);
  const { busy, run } = useAction();

  const refs = [
    { value: 'auth.users.id', label: 'auth.users.id (signed-in user)' },
    ...tables.flatMap((t) => t.columns.filter((c) => c.pk).map((c) => ({ value: `${t.schema}.${t.name}.${c.name}`, label: `${t.name}.${c.name}` }))),
  ];
  const update = (i: number, patch: Partial<Col>) => setCols(cols.map((c, j) => (j === i ? { ...c, ...patch } : c)));

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const columns = cols.filter((c) => c.name.trim()).map((c) => ({ ...c, name: c.name.trim(), default: c.default.trim() || undefined, references: c.references || undefined }));
    const r = await run('create', () => post(`${projectPath(project)}/tables`, { schema, name, columns, rls, realtime }), `Created ${name}`);
    if (r) {
      await reloadSchema();
      void reloadOverview();
      open({ kind: 'table', table: name });
    }
  };

  return (
    <Shell label="New table" title="New table" sub={`in the ${schema} schema`} wide>
      <form onSubmit={submit}>
        <div className="section">
          <label className="field">
            <span>Table name</span>
            <input className="input mono" value={name} onChange={(e) => setName(e.target.value.replace(/[^a-zA-Z0-9_]/g, '_'))} placeholder="recipes" required autoFocus />
          </label>
        </div>
        <div className="section">
          <div style={{ display: 'flex', alignItems: 'center' }}>
            <h3 style={{ flex: 1 }}>Columns</h3>
            <button
              type="button"
              className="pill sm"
              onClick={() => setCols([...cols, { name: 'user_id', type: 'uuid', default: 'auth.uid()', nullable: false, pk: false, unique: false, references: 'auth.users.id' }])}
            >
              <Plus size={13} /> Owner column
            </button>
          </div>
          {cols.map((c, i) => (
            <div key={i} className="policy" style={{ gap: 8 }}>
              <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1.2fr) minmax(0,1fr) minmax(0,1fr) auto', gap: 6, alignItems: 'center' }}>
                <input className="input mono" placeholder="column_name" value={c.name} onChange={(e) => update(i, { name: e.target.value.replace(/[^a-zA-Z0-9_]/g, '_') })} aria-label="Column name" />
                <input className="input mono" list="keel-types" value={c.type} onChange={(e) => update(i, { type: e.target.value })} aria-label="Type" />
                <input className="input mono" list={`keel-defaults-${i}`} placeholder="default" value={c.default} onChange={(e) => update(i, { default: e.target.value })} aria-label="Default value" />
                <datalist id={`keel-defaults-${i}`}>
                  {(DEFAULTS[c.type] || []).map((d) => (
                    <option key={d} value={d} />
                  ))}
                </datalist>
                <button type="button" className="icon-btn sm ghost" aria-label="Remove column" onClick={() => setCols(cols.filter((_, j) => j !== i))}>
                  <X size={14} />
                </button>
              </div>
              <div style={{ display: 'flex', gap: 14, alignItems: 'center', flexWrap: 'wrap', fontSize: 12 }}>
                <label className="check">
                  <input type="checkbox" checked={c.pk} onChange={(e) => update(i, { pk: e.target.checked, nullable: e.target.checked ? false : c.nullable })} />
                  Primary key
                </label>
                <label className="check">
                  <input type="checkbox" checked={!c.nullable} disabled={c.pk} onChange={(e) => update(i, { nullable: !e.target.checked })} />
                  Required
                </label>
                <label className="check">
                  <input type="checkbox" checked={c.unique} disabled={c.pk} onChange={(e) => update(i, { unique: e.target.checked })} />
                  Unique
                </label>
                <select className="select" style={{ height: 28, width: 'auto', flex: 1, minWidth: 160, fontSize: 12 }} value={c.references} onChange={(e) => update(i, { references: e.target.value })} aria-label="References">
                  <option value="">No reference</option>
                  {refs.map((r) => (
                    <option key={r.value} value={r.value}>
                      → {r.label}
                    </option>
                  ))}
                </select>
              </div>
            </div>
          ))}
          <datalist id="keel-types">
            {TYPES.map((t) => (
              <option key={t} value={t} />
            ))}
          </datalist>
          <button type="button" className="pill sm" style={{ alignSelf: 'flex-start' }} onClick={() => setCols([...cols, blank()])}>
            <Plus size={13} /> Add column
          </button>
        </div>
        <div className="section">
          <div className="setting">
            <span className="two-line">
              <span className="a">Row level security</span>
              <span className="b">Recommended. Nothing is readable through the API until you add a policy.</span>
            </span>
            <Switch label="Row level security" checked={rls} onChange={setRls} />
          </div>
          {!rls && <Notice kind="warn">Without row level security, anyone with your anon key can read and change every row.</Notice>}
          <div className="setting">
            <span className="two-line">
              <span className="a">Realtime</span>
              <span className="b">Broadcast changes to subscribed clients.</span>
            </span>
            <Switch label="Realtime" checked={realtime} onChange={setRealtime} />
          </div>
          <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
            <button className="btn-dark md" disabled={busy === 'create' || !name}>
              {busy === 'create' ? 'Creating…' : 'Create table'}
            </button>
          </div>
        </div>
      </form>
    </Shell>
  );
}
