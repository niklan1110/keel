import { useEffect, useRef } from 'react';
import { ArrowCounterClockwise, FloppyDisk } from '@phosphor-icons/react';
import { del, get, post } from '../api';
import { Loading, Notice, useAction, useConfirm } from '../components/ui';
import { projectPath, useStudio } from '../ctx';
import { count, plural, stamp } from '../lib/format';
import { useLoad } from '../lib/hooks';

type Defaults = {
  savedAt: string | null;
  rows: number;
  tables: { schema: string; name: string; rows: number }[];
  addedSince: { schema: string; name: string }[];
};

type Restored = { rows: number; emptied: string[]; missing: string[]; backup: { id: string; createdAt: string } };

const label = (t: { schema: string; name: string }) => (t.schema === 'public' ? t.name : `${t.schema}.${t.name}`);

/** Project settings > Defaults: save the current rows, and go back to them. */
export function DefaultsSection({ focus }: { focus?: boolean }) {
  const { project, reloadSchema, reloadOverview } = useStudio();
  const base = `${projectPath(project)}/defaults`;
  const d = useLoad(() => get<Defaults>(base), [base]);
  const { busy, run } = useAction();
  const confirm = useConfirm();
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (focus) ref.current?.scrollIntoView({ block: 'start' });
  }, [focus, d.data]);

  const save = async () => {
    if (
      d.data?.savedAt &&
      !(await confirm({
        title: 'Replace the saved defaults?',
        body: `The rows in your tables now become ${project}'s defaults, in place of the ones saved ${stamp(d.data.savedAt)}.`,
        confirm: 'Save as defaults',
      }))
    )
      return;
    const next = await run('save', () => post<Defaults>(`${base}/save`), 'Defaults saved');
    if (next) d.setData(next);
  };

  const restore = async () => {
    if (!d.data?.savedAt) return;
    const ok = await confirm({
      title: 'Restore defaults?',
      body: (
        <>
          Every table in <b>{project}</b> goes back to the {plural(d.data.rows, 'row')} saved {stamp(d.data.savedAt)}. Rows added or changed since then are
          removed{d.data.addedSince.length ? `, and ${d.data.addedSince.map(label).join(', ')} ${d.data.addedSince.length === 1 ? 'is' : 'are'} emptied` : ''}.
          Users and files stay. Keel makes a backup first, so you can undo this from Backups.
        </>
      ),
      confirm: 'Restore defaults',
      danger: true,
    });
    if (!ok) return;
    const r = await run('restore', () => post<Restored>(`${base}/restore`, { confirm: project }), 'Defaults restored');
    if (r) {
      void reloadSchema();
      void reloadOverview();
      await d.reload();
    }
  };

  const forget = async () => {
    const ok = await confirm({
      title: 'Delete the saved defaults?',
      body: 'Your tables stay as they are; only the saved copy is deleted.',
      confirm: 'Delete defaults',
      danger: true,
    });
    if (!ok) return;
    const next = await run('forget', () => del<Defaults>(base), 'Saved defaults deleted');
    if (next) d.setData(next);
  };

  return (
    <div className="section" ref={ref} style={{ scrollMarginTop: 12 }}>
      <h3>Defaults</h3>
      <div className="muted" style={{ fontSize: 12.5 }}>
        A saved copy of the rows in your tables, such as your app's starting categories. <b>Restore defaults</b> puts every table back to it. Users and
        files aren't touched.
      </div>
      {d.error ? (
        <Notice kind="err">{d.error.message}</Notice>
      ) : !d.data ? (
        <Loading />
      ) : !d.data.savedAt ? (
        <>
          <Notice>
            No defaults saved yet. When your tables hold the rows you want to start from, save them here, then you can come back to them any time.
          </Notice>
          <div>
            <button className="btn-dark md" disabled={busy === 'save'} onClick={save}>
              <FloppyDisk size={15} />
              {busy === 'save' ? 'Saving…' : 'Save current data as defaults'}
            </button>
          </div>
        </>
      ) : (
        <>
          <dl className="kv">
            <dt>Saved</dt>
            <dd>{stamp(d.data.savedAt)}</dd>
            <dt>Contains</dt>
            <dd>
              {plural(d.data.rows, 'row')} in {plural(d.data.tables.length, 'table')}
            </dd>
          </dl>
          {d.data.tables.length > 0 && (
            <details>
              <summary className="muted" style={{ fontSize: 13, cursor: 'pointer' }}>
                Tables
              </summary>
              <ul style={{ margin: '8px 0 0', padding: 0, listStyle: 'none', fontSize: 13 }}>
                {d.data.tables.map((t) => (
                  <li key={label(t)} style={{ display: 'flex', justifyContent: 'space-between', gap: 12, padding: '3px 0' }}>
                    <span className="mono" style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                      {label(t)}
                    </span>
                    <span className="dim" style={{ fontVariantNumeric: 'tabular-nums' }}>
                      {count(t.rows)}
                    </span>
                  </li>
                ))}
              </ul>
            </details>
          )}
          {d.data.addedSince.length > 0 && (
            <Notice kind="warn">
              New since the defaults were saved: <span className="mono">{d.data.addedSince.map(label).join(', ')}</span>. Restoring empties{' '}
              {d.data.addedSince.length === 1 ? 'it' : 'them'}; save the defaults again to keep {d.data.addedSince.length === 1 ? 'its' : 'their'} rows.
            </Notice>
          )}
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button className="btn-dark md danger" disabled={busy === 'restore'} onClick={restore}>
              <ArrowCounterClockwise size={15} />
              {busy === 'restore' ? 'Restoring…' : 'Restore defaults'}
            </button>
            <button className="pill md" disabled={busy === 'save'} onClick={save}>
              <FloppyDisk size={15} />
              {busy === 'save' ? 'Saving…' : 'Save current data as defaults'}
            </button>
            <button className="pill md ghost" disabled={busy === 'forget'} onClick={forget}>
              Delete defaults
            </button>
          </div>
        </>
      )}
    </div>
  );
}
