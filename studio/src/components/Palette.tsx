import { useEffect, useMemo, useRef, useState } from 'react';
import { Archive, ArrowCounterClockwise, BookOpenText, Clock, Columns, FloppyDisk, GlobeSimple, MagnifyingGlass, Plug, Plus, ShieldCheck, Table as TableIcon, TerminalWindow, UsersThree } from '@phosphor-icons/react';
import { useStudio } from '../ctx';
import { shortType } from '../lib/format';
import type { Drawer } from '../types';

type Item = { key: string; label: string; right?: string; icon: React.ReactNode; run: () => void };

export function Palette({ onClose, onNewProject }: { onClose: () => void; onNewProject: () => void }) {
  const { tables, open } = useStudio();
  const [q, setQ] = useState('');
  const [idx, setIdx] = useState(0);
  const listRef = useRef<HTMLUListElement>(null);

  const go = (d: Drawer) => {
    open(d);
    onClose();
  };

  const items = useMemo<Item[]>(() => {
    const out: Item[] = [];
    const term = q.trim().toLowerCase();
    for (const t of tables) {
      if (!term || t.name.toLowerCase().includes(term)) {
        out.push({ key: `t:${t.name}`, label: t.name, right: t.kind, icon: <TableIcon size={15} color="var(--accent)" />, run: () => go({ kind: 'table', table: t.name }) });
      }
    }
    if (term) {
      for (const t of tables) {
        for (const c of t.columns) {
          if (c.name.toLowerCase().includes(term)) {
            out.push({ key: `c:${t.name}.${c.name}`, label: `${t.name}.${c.name}`, right: shortType(c.type), icon: <Columns size={15} color="var(--blue)" />, run: () => go({ kind: 'table', table: t.name }) });
          }
        }
      }
    }
    const actions: Item[] = [
      { key: 'a:sql', label: 'Open SQL editor', icon: <TerminalWindow size={15} />, run: () => go({ kind: 'sql' }) },
      { key: 'a:new-table', label: 'New table', icon: <Plus size={15} />, run: () => go({ kind: 'new-table' }) },
      { key: 'a:users', label: 'Users', icon: <UsersThree size={15} />, run: () => go({ kind: 'users' }) },
      { key: 'a:storage', label: 'Storage', icon: <Archive size={15} />, run: () => go({ kind: 'storage' }) },
      { key: 'a:cron', label: 'Scheduled jobs and outgoing requests (cron, webhooks)', icon: <Clock size={15} />, run: () => go({ kind: 'cron' }) },
      { key: 'a:connect', label: 'Connect: API keys and URLs', icon: <Plug size={15} />, run: () => go({ kind: 'connect' }) },
      { key: 'a:defaults', label: 'Restore defaults: put tables back to their saved rows', icon: <ArrowCounterClockwise size={15} />, run: () => go({ kind: 'settings', focus: 'defaults' }) },
      { key: 'a:save-defaults', label: 'Save current data as defaults', icon: <FloppyDisk size={15} />, run: () => go({ kind: 'settings', focus: 'defaults' }) },
      { key: 'a:internet', label: 'Internet access: public address and Cloudflare Tunnel', icon: <GlobeSimple size={15} />, run: () => go({ kind: 'internet' }) },
      { key: 'a:project', label: 'New project', icon: <Plus size={15} />, run: () => (onClose(), onNewProject()) },
      { key: 'a:account', label: 'Account and security: password, two-factor, Studio accounts', icon: <ShieldCheck size={15} />, run: () => go({ kind: 'account' }) },
      { key: 'a:docs', label: 'Documentation', icon: <BookOpenText size={15} />, run: () => (onClose(), window.open('/docs/', '_blank', 'noopener')) },
    ];
    out.push(...actions.filter((a) => !term || a.label.toLowerCase().includes(term)));
    return out.slice(0, 60);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q, tables]);

  useEffect(() => setIdx(0), [q]);
  useEffect(() => {
    listRef.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [idx]);

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="palette" role="dialog" aria-modal="true" aria-label="Find">
        <label className="search-pill">
          <MagnifyingGlass size={16} />
          <input
            autoFocus
            placeholder="Find a table or column…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') {
                e.preventDefault();
                setIdx((i) => Math.min(items.length - 1, i + 1));
              } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                setIdx((i) => Math.max(0, i - 1));
              } else if (e.key === 'Enter') {
                items[idx]?.run();
              } else if (e.key === 'Escape') {
                onClose();
              }
            }}
            aria-activedescendant={items[idx]?.key}
          />
        </label>
        <ul ref={listRef} role="listbox">
          {items.length === 0 && <li className="empty">Nothing matches “{q}”.</li>}
          {items.map((it, i) => (
            <li key={it.key} id={it.key}>
              <button role="option" aria-selected={i === idx} onMouseEnter={() => setIdx(i)} onClick={it.run}>
                {it.icon}
                <span className={it.key.startsWith('a:') ? '' : 'mono'} style={{ fontSize: it.key.startsWith('a:') ? 13 : 12.5 }}>
                  {it.label}
                </span>
                {it.right && <span className="r mono">{it.right}</span>}
              </button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
