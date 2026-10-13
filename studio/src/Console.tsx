import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { BookOpenText, CaretDown, Check, Database, GearSix, MagnifyingGlass, Plus, PlugsConnected, ShieldCheck, SignOut } from '@phosphor-icons/react';
import { get, post } from './api';
import { Canvas } from './components/Canvas';
import { Dock } from './components/Dock';
import { Palette } from './components/Palette';
import { ProjectCard, StackCard } from './components/Side';
import { Modal, useAction } from './components/ui';
import { Ctx, projectPath, type StudioCtx } from './ctx';
import { DrawerHost } from './drawers/DrawerHost';
import { bytes } from './lib/format';
import { useLoad, useMedia, useStored } from './lib/hooks';
import { MobileHome } from './MobileHome';
import type { Container, Drawer, Instance, Overview, ProjectSummary, Table } from './types';

export function Console({ instance, onSignOut, onInstanceChange }: { instance: Instance; onSignOut: () => void; onInstanceChange: () => Promise<void> }) {
  const mobile = useMedia('(max-width: 719px)');
  const projects = useLoad(() => get<ProjectSummary[]>('/api/projects'), []);
  const [stored, setStored] = useStored<string | null>('keel.studio.project', null);
  const list = projects.data || [];
  const project = list.find((p) => p.name === stored)?.name || list[0]?.name || null;

  const [schema, setSchema] = useState('public');
  const [drawer, setDrawer] = useState<Drawer | null>(null);
  const [menu, setMenu] = useState(false);
  const [palette, setPalette] = useState(false);
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    setSchema('public');
    setDrawer(null);
  }, [project]);

  const schemaData = useLoad(
    () => get<{ tables: Table[] }>(`${projectPath(project!)}/schema?schema=${encodeURIComponent(schema)}`),
    [project, schema],
    { enabled: !!project },
  );
  const overview = useLoad(() => get<Overview>(`${projectPath(project!)}/overview`), [project], { enabled: !!project, poll: 20_000 });
  const stack = useLoad(() => get<{ docker: boolean; containers: Container[] }>('/api/stack'), [], { poll: 10_000 });

  // Keep the schema fresh while the window is focused (tables created elsewhere show up).
  useEffect(() => {
    const onFocus = () => project && void schemaData.reload();
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [project, schemaData]);

  const open = useCallback((d: Drawer) => {
    setMenu(false);
    setDrawer(d);
  }, []);
  const close = useCallback(() => setDrawer(null), []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setPalette((v) => !v);
      } else if (e.key === 'Escape' && !palette && !document.querySelector('.modal-backdrop')) {
        if (menu) setMenu(false);
        else setDrawer(null);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [menu, palette]);

  const ctx: StudioCtx | null = useMemo(
    () =>
      project
        ? {
            instance,
            project,
            schema,
            tables: schemaData.data?.tables || [],
            tablesLoaded: !!schemaData.data,
            overview: overview.data,
            containers: stack.data?.containers || [],
            docker: !!stack.data?.docker,
            mobile,
            open,
            close,
            reloadSchema: schemaData.reload,
            reloadOverview: overview.reload,
            reloadStack: stack.reload,
            reloadProjects: projects.reload,
            reloadInstance: onInstanceChange,
            switchProject: (name: string) => setStored(name),
          }
        : null,
    [instance, project, schema, schemaData.data, schemaData.reload, overview.data, overview.reload, stack.data, stack.reload, mobile, open, close, projects.reload, setStored, onInstanceChange],
  );

  if (projects.loading && !projects.data) return <div className="login" />;

  if (!project || !ctx) {
    return (
      <div className="login">
        <div className="card" style={{ padding: 24, width: 'min(420px, 100%)' }}>
          <div className="logo" style={{ marginBottom: 12 }}>
            keel<span>.</span>
          </div>
          <h1 style={{ margin: '0 0 6px', fontSize: 24, letterSpacing: '-0.03em' }}>Create your first project</h1>
          <p className="muted" style={{ margin: '0 0 16px' }}>
            Each project gets its own Postgres database, API keys and URL.
          </p>
          <button className="btn-dark lg" onClick={() => setCreating(true)}>
            <Plus size={15} /> New project
          </button>
        </div>
        {creating && <NewProject onClose={() => setCreating(false)} onCreated={async (n) => (await projects.reload(), setStored(n))} />}
      </div>
    );
  }

  const header = (
    <ProjectSwitcher
      mobile={mobile}
      projects={list}
      current={project}
      open={menu}
      setOpen={setMenu}
      onPick={(n) => {
        setStored(n);
        setMenu(false);
      }}
      onNew={() => {
        setMenu(false);
        setCreating(true);
      }}
      onSettings={() => open({ kind: 'settings' })}
      onAccount={() => open({ kind: 'account' })}
      onSignOut={onSignOut}
    />
  );

  return (
    <Ctx.Provider value={ctx}>
      {mobile ? (
        <MobileHome switcher={header} drawer={drawer} />
      ) : (
        <div className="app">
          <header className="header">
            <span className="logo">
              keel<span>.</span>
            </span>
            {header}
            <span className="server">
              Postgres {instance.postgres} on {instance.hostLabel}
            </span>
            <div className="right">
              <a className="docs-btn" href="/docs/" target="_blank" rel="noopener">
                <BookOpenText size={16} />
                Docs
              </a>
              <button className="find-btn" onClick={() => setPalette(true)}>
                <MagnifyingGlass size={15} />
                <span>Find a table or column…</span>
                <kbd>⌘K</kbd>
              </button>
              <button className="btn-dark lg" onClick={() => open({ kind: 'connect' })}>
                <PlugsConnected size={16} />
                Connect
              </button>
            </div>
          </header>
          <div className={`stage${drawer ? ' drawer-open' : ''}${drawer && ['sql', 'service', 'new-table', 'table', 'functions'].includes(drawer.kind) ? ' drawer-wide' : ''}`}>
            <Canvas
              tables={ctx.tables}
              loading={schemaData.loading && !schemaData.data}
              selected={drawer?.kind === 'table' ? drawer.table : null}
            />
            <div className="side">
              <ProjectCard setSchema={setSchema} />
              <StackCard selected={drawer?.kind === 'service' ? drawer.service : null} />
            </div>
            <Dock drawer={drawer} />
            {drawer && <DrawerHost drawer={drawer} />}
          </div>
        </div>
      )}
      {palette && <Palette onClose={() => setPalette(false)} onNewProject={() => setCreating(true)} />}
      {creating && (
        <NewProject
          onClose={() => setCreating(false)}
          onCreated={async (n) => {
            await projects.reload();
            setStored(n);
          }}
        />
      )}
    </Ctx.Provider>
  );
}

function ProjectSwitcher(props: {
  mobile: boolean;
  projects: ProjectSummary[];
  current: string;
  open: boolean;
  setOpen: (v: boolean) => void;
  onPick: (n: string) => void;
  onNew: () => void;
  onSettings: () => void;
  onAccount: () => void;
  onSignOut: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!props.open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) props.setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [props.open, props.setOpen]);

  return (
    <div ref={ref} style={{ position: props.mobile ? 'static' : 'relative', flex: props.mobile ? 1 : undefined, minWidth: 0 }}>
      {props.mobile ? (
        <button className="m-proj" aria-label="Switch project" aria-expanded={props.open} onClick={() => props.setOpen(!props.open)}>
          <span>{props.current}</span>
          <CaretDown size={14} color="var(--dim)" />
        </button>
      ) : (
        <button className="proj-btn" aria-label="Switch project" aria-expanded={props.open} onClick={() => props.setOpen(!props.open)}>
          <Database size={15} color="var(--accent)" />
          <span className="name">{props.current}</span>
          <CaretDown size={13} color="var(--dim)" />
        </button>
      )}
      {props.open && (
        <div className="menu" style={props.mobile ? { left: 12, right: 12, width: 'auto', top: 'calc(100% + 6px)' } : undefined}>
          {props.projects.map((p) => (
            <button key={p.name} className="menu-item" onClick={() => props.onPick(p.name)}>
              <span style={{ flex: 1, minWidth: 0 }}>
                <span className="t">{p.name}</span>
                <span className="s">Postgres · {bytes(p.sizeBytes)}</span>
              </span>
              <Check size={15} color="var(--accent)" style={{ opacity: p.name === props.current ? 1 : 0 }} />
            </button>
          ))}
          <div className="menu-sep" />
          <button className="menu-item" onClick={props.onNew}>
            <Plus size={15} color="var(--muted)" />
            <span className="t" style={{ fontWeight: 500 }}>
              New project
            </span>
          </button>
          <button
            className="menu-item"
            onClick={() => {
              props.setOpen(false);
              props.onSettings();
            }}
          >
            <GearSix size={15} color="var(--muted)" />
            <span className="t" style={{ fontWeight: 500 }}>
              Project settings
            </span>
          </button>
          <button
            className="menu-item"
            onClick={() => {
              props.setOpen(false);
              props.onAccount();
            }}
          >
            <ShieldCheck size={15} color="var(--muted)" />
            <span className="t" style={{ fontWeight: 500 }}>
              Account and security
            </span>
          </button>
          <a className="menu-item" href="/docs/" target="_blank" rel="noopener" onClick={() => props.setOpen(false)}>
            <BookOpenText size={15} color="var(--muted)" />
            <span className="t" style={{ fontWeight: 500 }}>
              Documentation
            </span>
          </a>
          <button className="menu-item" onClick={props.onSignOut}>
            <SignOut size={15} color="var(--muted)" />
            <span className="t" style={{ fontWeight: 500 }}>
              Sign out
            </span>
          </button>
        </div>
      )}
    </div>
  );
}

function NewProject({ onClose, onCreated }: { onClose: () => void; onCreated: (name: string) => Promise<void> | void }) {
  const [name, setName] = useState('');
  const { busy, run } = useAction();
  const valid = /^[a-z][a-z0-9-]{1,38}[a-z0-9]$/.test(name);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const ok = await run('create', () => post('/api/projects', { name }), `Created ${name}`);
    if (ok) {
      await onCreated(name);
      onClose();
    }
  };
  return (
    <Modal onClose={onClose} label="New project">
      <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <h2>New project</h2>
        <p className="muted" style={{ margin: 0 }}>
          A project is a separate Postgres database with its own API keys, users and storage.
        </p>
        <label className="field">
          <span>Name</span>
          <input className="input mono" value={name} onChange={(e) => setName(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '-'))} placeholder="recipe-box" autoFocus />
          <small>Lowercase letters, digits and dashes. Used in the API URL.</small>
        </label>
        <div className="acts">
          <button type="button" className="pill md" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn-dark md" disabled={!valid || busy === 'create'}>
            {busy === 'create' ? 'Creating…' : 'Create project'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
