import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, FolderOpen, Key, Lightning, PaperPlaneRight, Plus, Trash } from '@phosphor-icons/react';
import { del, enc, get, patch, post, put } from '../api';
import { CopyButton, Loading, Notice, Switch, useAction, useConfirm, useToast } from '../components/ui';
import { projectPath, useStudio } from '../ctx';
import { clock, when } from '../lib/format';
import { useLoad } from '../lib/hooks';
import { Shell } from './Shell';

type Fn = {
  name: string;
  entrypoint: string;
  verifyJwt: boolean;
  version: number;
  updatedAt: string;
  files: number;
  sizeBytes: number;
  worker: { state: string; version: number; since: string; inflight: number } | null;
};
type FnList = { runtime: 'running' | 'unreachable'; baseUrl: string; functions: Fn[] };
type FnDetail = { name: string; entrypoint: string; verifyJwt: boolean; version: number; files: Record<string, string> };
type Secret = { name: string; digest: string; updatedAt: string };
type Logs = { logs: { t: string; level: 'info' | 'error' | 'system'; msg: string }[]; invocations: { t: string; method: string; path: string; status: number; ms: number }[]; unreachable?: boolean };

const NAME_RE = /^[A-Za-z][A-Za-z0-9_-]{0,62}$/;

const TEMPLATE = `// Runs on Deno, like Supabase Edge Functions.
// Secrets: Deno.env.get('MY_SECRET'). Your project: Deno.env.get('SUPABASE_URL').

Deno.serve(async (req) => {
  const { name } = await req.json().catch(() => ({ name: 'world' }));
  return new Response(JSON.stringify({ message: \`Hello \${name}!\` }), {
    headers: { 'Content-Type': 'application/json' },
  });
});
`;

export function FunctionsDrawer({ initial }: { initial?: string }) {
  const { project, mobile } = useStudio();
  const base = projectPath(project);
  const list = useLoad(() => get<FnList>(`${base}/functions`), [base], { poll: 10_000 });
  const [view, setView] = useState<'list' | 'new' | 'secrets' | { fn: string }>(initial ? { fn: initial } : 'list');

  if (view === 'new') {
    return (
      <Shell label="New function" title="Functions" sub="New edge function" wide={!mobile}>
        <NewFunction
          base={base}
          onBack={() => setView('list')}
          onCreated={async (name) => {
            await list.reload();
            setView({ fn: name });
          }}
        />
      </Shell>
    );
  }
  if (view === 'secrets') {
    return (
      <Shell label="Secrets" title="Functions" sub="Secrets (environment variables)" wide={!mobile}>
        <Secrets base={base} onBack={() => setView('list')} />
      </Shell>
    );
  }
  if (typeof view === 'object') {
    const fn = list.data?.functions.find((f) => f.name === view.fn);
    return (
      <Shell label={view.fn} title={<span className="mono" style={{ fontSize: 20 }}>{view.fn}</span>} sub={fn ? `v${fn.version}, ${fn.verifyJwt ? 'requires a JWT' : 'public'}` : 'Edge function'} wide={!mobile}>
        <FunctionDetail
          key={view.fn}
          base={base}
          name={view.fn}
          url={`${list.data?.baseUrl || ''}/${view.fn}`}
          summary={fn}
          onBack={() => setView('list')}
          onChanged={() => void list.reload()}
        />
      </Shell>
    );
  }

  const fns = list.data?.functions || [];
  return (
    <Shell
      label="Functions"
      title="Functions"
      sub={list.data ? `${fns.length} edge function${fns.length === 1 ? '' : 's'}, running on Deno` : 'Edge functions'}
      wide={!mobile}
      actions={
        <button className="icon-btn" aria-label="Secrets" title="Secrets" onClick={() => setView('secrets')}>
          <Key size={15} />
        </button>
      }
    >
      <div className="toolbar">
        <button className="btn-dark md" onClick={() => setView('new')}>
          <Plus size={15} /> New function
        </button>
        <button className="pill md" onClick={() => setView('secrets')}>
          <Key size={15} /> Secrets
        </button>
      </div>
      {list.data?.runtime === 'unreachable' && (
        <div className="section" style={{ paddingBottom: 0 }}>
          <Notice kind="warn">
            The <code>keel-functions</code> container isn't answering, so functions can't run right now. Check it under Logs.
          </Notice>
        </div>
      )}
      {list.error && (
        <div className="section">
          <Notice kind="err">{list.error.message}</Notice>
        </div>
      )}
      {!list.data && !list.error ? (
        <Loading />
      ) : fns.length === 0 ? (
        <div className="empty">
          <b>No functions yet</b>
          Functions are small TypeScript programs that run on your server, for webhooks, payments, emails or anything that needs a secret.
          <div style={{ marginTop: 14 }}>
            <button className="btn-dark md" onClick={() => setView('new')}>
              <Plus size={15} /> New function
            </button>
          </div>
          <div style={{ marginTop: 14, textAlign: 'left' }}>
            Or deploy a Supabase-style <span className="mono">supabase/functions</span> folder from the command line:
            <pre className="snippet" style={{ marginTop: 8 }}>./keel functions deploy --project {project}</pre>
          </div>
        </div>
      ) : (
        fns.map((f) => (
          <button key={f.name} className="user-row" onClick={() => setView({ fn: f.name })}>
            <span className="avatar">
              <Lightning size={16} />
            </span>
            <span className="two-line">
              <span className="a mono">{f.name}</span>
              <span className="b">
                v{f.version} · updated {when(f.updatedAt)} · {f.verifyJwt ? 'JWT required' : 'public'}
              </span>
            </span>
            <span className={`badge ${f.worker?.state === 'ready' ? 'ok' : 'neutral'}`}>{f.worker?.state === 'ready' ? 'Warm' : f.worker?.state === 'starting' ? 'Starting' : 'Idle'}</span>
          </button>
        ))
      )}
    </Shell>
  );
}

function CodeArea({ value, onChange, rows = 18, label }: { value: string; onChange: (v: string) => void; rows?: number; label: string }) {
  return (
    <textarea
      className="textarea mono code-area"
      aria-label={label}
      spellCheck={false}
      autoCapitalize="off"
      autoCorrect="off"
      rows={rows}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      onKeyDown={(e) => {
        if (e.key !== 'Tab' || e.shiftKey) return;
        e.preventDefault();
        const t = e.currentTarget;
        const { selectionStart: s, selectionEnd: end } = t;
        const next = t.value.slice(0, s) + '  ' + t.value.slice(end);
        onChange(next);
        requestAnimationFrame(() => t.setSelectionRange(s + 2, s + 2));
      }}
    />
  );
}

/** Reads a dropped/picked folder into { "name/path": text }, skipping binaries. */
async function readFolder(files: FileList, name: string): Promise<{ files: Record<string, string>; skipped: string[] }> {
  const out: Record<string, string> = {};
  const skipped: string[] = [];
  for (const f of [...files]) {
    const rel = (f as File & { webkitRelativePath?: string }).webkitRelativePath || f.name;
    const parts = rel.split('/').slice(1); // drop the picked folder's own name
    if (!parts.length || parts.some((p) => p.startsWith('.') || p === 'node_modules')) continue;
    const buf = new Uint8Array(await f.arrayBuffer());
    if (buf.length > 5 * 1024 * 1024 || buf.subarray(0, 8192).includes(0)) {
      skipped.push(parts.join('/'));
      continue;
    }
    out[`${name}/${parts.join('/')}`] = new TextDecoder().decode(buf);
  }
  return { files: out, skipped };
}

function NewFunction({ base, onBack, onCreated }: { base: string; onBack: () => void; onCreated: (name: string) => void }) {
  const [name, setName] = useState('');
  const [code, setCode] = useState(TEMPLATE);
  const [verifyJwt, setVerifyJwt] = useState(true);
  const folder = useRef<HTMLInputElement>(null);
  const { busy, run } = useAction();
  const toast = useToast();
  const valid = NAME_RE.test(name);

  useEffect(() => {
    folder.current?.setAttribute('webkitdirectory', '');
  }, []);

  const deploy = async (files: Record<string, string>, fnName = name) => {
    const r = await run('deploy', () => put<{ version: number }>(`${base}/functions/${enc(fnName)}`, { files, verify_jwt: verifyJwt }), `Deployed ${fnName}`);
    if (r) onCreated(fnName);
  };

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (valid) void deploy({ [`${name}/index.ts`]: code });
      }}
    >
      <div className="toolbar">
        <button type="button" className="pill" onClick={onBack}>
          <ArrowLeft size={14} /> All functions
        </button>
        <button type="button" className="pill md grow" disabled={busy === 'deploy'} onClick={() => folder.current?.click()} title="Pick a function folder (with index.ts) from your computer">
          <FolderOpen size={15} /> Upload folder
        </button>
        <button className="btn-dark md" disabled={!valid || busy === 'deploy'}>
          {busy === 'deploy' ? 'Deploying…' : 'Deploy'}
        </button>
      </div>
      <input
        ref={folder}
        type="file"
        hidden
        multiple
        onChange={async (e) => {
          const picked = e.target.files;
          e.target.value = '';
          if (!picked?.length) return;
          const dir = ((picked[0] as File & { webkitRelativePath?: string }).webkitRelativePath || '').split('/')[0];
          const fnName = valid ? name : dir.replace(/[^A-Za-z0-9_-]/g, '-');
          if (!NAME_RE.test(fnName)) return toast('Enter a function name first', true);
          const { files, skipped } = await readFolder(picked, fnName);
          if (!Object.keys(files).some((k) => /\/index\.(ts|js|tsx|jsx|mjs|mts)$/.test(k) && k.split('/').length === 2)) {
            return toast('That folder has no index.ts at its top level', true);
          }
          if (skipped.length) toast(`Skipped binary or large files: ${skipped.join(', ')}`, true);
          await deploy(files, fnName);
        }}
      />
      <div className="section">
        <label className="field">
          <span>Name</span>
          <input className="input mono" value={name} onChange={(e) => setName(e.target.value.replace(/[^A-Za-z0-9_-]/g, '-'))} placeholder="hello-world" autoFocus />
          <small>Becomes part of the URL: /functions/v1/{name || 'hello-world'}</small>
        </label>
        <div className="setting">
          <span className="two-line">
            <span className="a">Require a valid JWT</span>
            <span className="b">Callers must send your anon key or a user's token. Turn off for webhooks from other services.</span>
          </span>
          <Switch label="Require a valid JWT" checked={verifyJwt} onChange={setVerifyJwt} />
        </div>
        <div className="field">
          <span>index.ts</span>
          <CodeArea label="Function code" value={code} onChange={setCode} />
        </div>
      </div>
    </form>
  );
}

function FunctionDetail({ base, name, url, summary, onBack, onChanged }: { base: string; name: string; url: string; summary?: Fn; onBack: () => void; onChanged: () => void }) {
  const [tab, setTab] = useState<'code' | 'test' | 'logs' | 'settings'>('code');
  return (
    <>
      <div className="toolbar">
        <button className="pill" onClick={onBack}>
          <ArrowLeft size={14} /> All functions
        </button>
        <div className="tabs grow" role="tablist">
          {(['code', 'test', 'logs', 'settings'] as const).map((t) => (
            <button key={t} role="tab" aria-selected={tab === t} onClick={() => setTab(t)}>
              {t[0].toUpperCase() + t.slice(1)}
            </button>
          ))}
        </div>
      </div>
      <div className="section" style={{ paddingBottom: 0 }}>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <input className="input mono" readOnly value={url} onFocus={(e) => e.target.select()} aria-label="Function URL" />
          <CopyButton text={url} />
        </div>
      </div>
      {tab === 'code' && <CodeTab base={base} name={name} onDeployed={onChanged} />}
      {tab === 'test' && <TestTab base={base} name={name} />}
      {tab === 'logs' && <LogsTab base={base} name={name} />}
      {tab === 'settings' && summary && <SettingsTab base={base} fn={summary} url={url} onChanged={onChanged} onDeleted={onBack} />}
    </>
  );
}

function CodeTab({ base, name, onDeployed }: { base: string; name: string; onDeployed: () => void }) {
  const detail = useLoad(() => get<FnDetail>(`${base}/functions/${enc(name)}`), [base, name]);
  const [files, setFiles] = useState<Record<string, string> | null>(null);
  const [file, setFile] = useState<string>('');
  const { busy, run } = useAction();

  useEffect(() => {
    if (detail.data && !files) {
      setFiles(detail.data.files);
      setFile(detail.data.entrypoint);
    }
  }, [detail.data, files]);

  if (detail.error) return <div className="section"><Notice kind="err">{detail.error.message}</Notice></div>;
  if (!detail.data || !files) return <Loading />;
  const dirty = JSON.stringify(files) !== JSON.stringify(detail.data.files);
  const names = Object.keys(files).sort();

  return (
    <div className="section">
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <select className="select mono" style={{ flex: 1 }} value={file} onChange={(e) => setFile(e.target.value)} aria-label="File">
          {names.map((n) => (
            <option key={n} value={n}>
              {n}
              {n === detail.data!.entrypoint ? '  (entrypoint)' : ''}
            </option>
          ))}
        </select>
        <button
          className="btn-dark md"
          disabled={!dirty || busy === 'deploy'}
          onClick={async () => {
            const r = await run('deploy', () => put<{ version: number }>(`${base}/functions/${enc(name)}`, { files, entrypoint: detail.data!.entrypoint, verify_jwt: detail.data!.verifyJwt }));
            if (r) {
              await detail.reload();
              setFiles(null);
              onDeployed();
            }
          }}
        >
          {busy === 'deploy' ? 'Deploying…' : dirty ? 'Deploy changes' : `v${detail.data.version} deployed`}
        </button>
      </div>
      <CodeArea label={`Edit ${file}`} rows={22} value={files[file] ?? ''} onChange={(v) => setFiles({ ...files, [file]: v })} />
      <small className="dim">Deploying restarts the function with the new code; requests already running finish on the old version.</small>
    </div>
  );
}

function TestTab({ base, name }: { base: string; name: string }) {
  const [method, setMethod] = useState('POST');
  const [path, setPath] = useState('');
  const [role, setRole] = useState<'anon' | 'service_role'>('anon');
  const [body, setBody] = useState('{\n  "name": "Keel"\n}');
  const [out, setOut] = useState<{ status: number; ms: number; body: string; headers: Record<string, string>; truncated: boolean } | null>(null);
  const { busy, run } = useAction();
  const pretty = useMemo(() => {
    if (!out) return '';
    try {
      return JSON.stringify(JSON.parse(out.body), null, 2);
    } catch {
      return out.body;
    }
  }, [out]);
  return (
    <form
      className="section"
      onSubmit={async (e) => {
        e.preventDefault();
        const r = await run('send', () => post(`${base}/functions/${enc(name)}/invoke`, { method, path, role, body }));
        if (r) setOut(r);
      }}
    >
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <select className="select" style={{ width: 110 }} value={method} onChange={(e) => setMethod(e.target.value)} aria-label="Method">
          {['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].map((m) => (
            <option key={m}>{m}</option>
          ))}
        </select>
        <input className="input mono" style={{ flex: 1, minWidth: 140 }} placeholder="/optional/sub/path?x=1" value={path} onChange={(e) => setPath(e.target.value)} aria-label="Path" />
        <select className="select" style={{ width: 150 }} value={role} onChange={(e) => setRole(e.target.value as 'anon' | 'service_role')} aria-label="Send as">
          <option value="anon">anon key</option>
          <option value="service_role">service role</option>
        </select>
      </div>
      {method !== 'GET' && method !== 'DELETE' && (
        <div className="field">
          <span>Body</span>
          <CodeArea label="Request body" rows={6} value={body} onChange={setBody} />
        </div>
      )}
      <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
        <button className="btn-dark md" disabled={busy === 'send'}>
          <PaperPlaneRight size={15} /> {busy === 'send' ? 'Running…' : 'Send request'}
        </button>
      </div>
      {out && (
        <div className="field">
          <span>
            <span className={`badge sm ${out.status < 300 ? 'ok' : out.status < 500 ? 'warn' : 'err'}`}>{out.status}</span> in {out.ms} ms
            {out.headers['content-type'] ? ` · ${out.headers['content-type']}` : ''}
          </span>
          <pre className="snippet" style={{ maxHeight: 360, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{pretty || '(empty body)'}{out.truncated ? '\n…' : ''}</pre>
        </div>
      )}
    </form>
  );
}

function LogsTab({ base, name }: { base: string; name: string }) {
  const { mobile } = useStudio();
  const logs = useLoad(() => get<Logs>(`${base}/functions/${enc(name)}/logs`), [base, name], { poll: 3000 });
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (box.current) box.current.scrollTop = box.current.scrollHeight;
  }, [logs.data]);
  const inv = (logs.data?.invocations || []).slice(-8).reverse();
  return (
    <div className="section">
      {logs.data?.unreachable && <Notice kind="warn">keel-functions isn't answering, so there are no logs to show.</Notice>}
      <h3>Recent requests</h3>
      {inv.length === 0 ? (
        <div className="dim" style={{ fontSize: 13 }}>No requests since the functions container started.</div>
      ) : (
        <div className="row-list">
          {inv.map((r, i) => (
            <div key={i} className="file-row" style={{ cursor: 'default' }}>
              <span className={`badge sm ${r.status < 300 ? 'ok' : r.status < 500 ? 'warn' : 'err'}`}>{r.status}</span>
              <span className="mono" style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 12 }}>
                {r.method} {r.path}
              </span>
              <span className="dim" style={{ fontSize: 12 }}>
                {r.ms} ms · {clock(r.t)}
              </span>
            </div>
          ))}
        </div>
      )}
      <h3>Console output</h3>
      <div className="term" role="log" ref={box} style={{ maxHeight: mobile ? 'none' : 'calc(100vh - 470px)', minHeight: 160 }}>
        {!logs.data && <div className="lv-INFO">Loading…</div>}
        {logs.data && logs.data.logs.length === 0 && <div className="lv-INFO">Nothing logged yet. console.log() output shows up here.</div>}
        {(logs.data?.logs || []).map((l, i) => (
          <div className="log-line" key={i}>
            <span className="t">{clock(l.t)}</span>
            <span className={l.level === 'error' ? 'lv-ERROR' : l.level === 'system' ? 'lv-WARN' : 'lv-INFO'}>{l.level === 'system' ? 'KEEL' : l.level === 'error' ? 'ERROR' : 'LOG'}</span>
            <span className="m">{l.msg}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function SettingsTab({ base, fn, url, onChanged, onDeleted }: { base: string; fn: Fn; url: string; onChanged: () => void; onDeleted: () => void }) {
  const { project } = useStudio();
  const { run } = useAction();
  const confirm = useConfirm();
  const curl = `curl -X POST '${url}' \\\n  -H 'Authorization: Bearer <anon key or user token>' \\\n  -H 'Content-Type: application/json' \\\n  -d '{"name":"Keel"}'`;
  const js = `const { data, error } = await supabase.functions.invoke('${fn.name}', {\n  body: { name: 'Keel' },\n})`;
  return (
    <div className="section">
      <div className="setting">
        <span className="two-line">
          <span className="a">Require a valid JWT</span>
          <span className="b">Off: anyone who knows the URL can call it (fine for webhooks that check their own signature).</span>
        </span>
        <Switch
          label="Require a valid JWT"
          checked={fn.verifyJwt}
          onChange={(v) => void run('jwt', () => patch(`${base}/functions/${enc(fn.name)}`, { verify_jwt: v }).then(onChanged), v ? 'JWT check on' : 'JWT check off')}
        />
      </div>
      <div className="field">
        <span>Call it from your app</span>
        <pre className="snippet">{js}</pre>
      </div>
      <div className="field">
        <span>Or with curl</span>
        <pre className="snippet">{curl}</pre>
      </div>
      <div className="field">
        <span>Redeploy from your computer</span>
        <pre className="snippet">./keel functions deploy {fn.name} --project {project}</pre>
      </div>
      <div>
        <button
          className="pill md danger"
          onClick={async () => {
            if (!(await confirm({ title: `Delete ${fn.name}?`, body: 'Apps calling it get 404s. Secrets stay.', confirm: 'Delete function', danger: true }))) return;
            const r = await run('delete', () => del(`${base}/functions/${enc(fn.name)}`), `Deleted ${fn.name}`);
            if (r !== undefined) {
              onChanged();
              onDeleted();
            }
          }}
        >
          <Trash size={15} /> Delete function
        </button>
      </div>
    </div>
  );
}

function parseEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split('\n')) {
    const line = raw.trim().replace(/^export\s+/, '');
    if (!line || line.startsWith('#')) continue;
    const i = line.indexOf('=');
    if (i < 1) continue;
    let v = line.slice(i + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    out[line.slice(0, i).trim()] = v;
  }
  return out;
}

function Secrets({ base, onBack }: { base: string; onBack: () => void }) {
  const secrets = useLoad(() => get<Secret[]>(`${base}/secrets`), [base]);
  const [text, setText] = useState('');
  const { busy, run } = useAction();
  const confirm = useConfirm();
  const parsed = parseEnv(text);
  const n = Object.keys(parsed).length;
  return (
    <>
      <div className="toolbar">
        <button className="pill" onClick={onBack}>
          <ArrowLeft size={14} /> All functions
        </button>
      </div>
      <form
        className="section"
        onSubmit={async (e) => {
          e.preventDefault();
          const r = await run('save', () => put(`${base}/secrets`, { secrets: parsed }), `Saved ${n} secret${n === 1 ? '' : 's'}`);
          if (r) {
            setText('');
            await secrets.reload();
          }
        }}
      >
        <h3>Add or update</h3>
        <label className="field">
          <span>One NAME=value per line (you can paste a .env file)</span>
          <textarea className="textarea mono" rows={4} placeholder={'STRIPE_SECRET_KEY=sk_live_...\nRESEND_API_KEY=re_...'} value={text} onChange={(e) => setText(e.target.value)} spellCheck={false} />
          <small>Read them in functions with Deno.env.get('NAME'). SUPABASE_URL, SUPABASE_ANON_KEY and SUPABASE_SERVICE_ROLE_KEY are always set for you.</small>
        </label>
        <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
          <button className="btn-dark md" disabled={!n || busy === 'save'}>
            {busy === 'save' ? 'Saving…' : n ? `Save ${n} secret${n === 1 ? '' : 's'}` : 'Save'}
          </button>
        </div>
      </form>
      <div className="section">
        <h3>Stored secrets</h3>
        {!secrets.data ? (
          <Loading />
        ) : secrets.data.length === 0 ? (
          <div className="dim" style={{ fontSize: 13 }}>No secrets yet.</div>
        ) : (
          <div className="row-list">
            {secrets.data.map((s) => (
              <div key={s.name} className="file-row" style={{ cursor: 'default' }}>
                <Key size={16} color="var(--muted)" />
                <span className="two-line" style={{ flex: 1, minWidth: 0 }}>
                  <span className="a mono">{s.name}</span>
                  <span className="b">
                    SHA-256 {s.digest}… · updated {when(s.updatedAt)}
                  </span>
                </span>
                <button
                  className="icon-btn"
                  aria-label={`Delete ${s.name}`}
                  onClick={async () => {
                    if (!(await confirm({ title: `Delete ${s.name}?`, body: 'Functions restart without it.', confirm: 'Delete', danger: true }))) return;
                    const r = await run('del', () => del(`${base}/secrets/${enc(s.name)}`), `Deleted ${s.name}`);
                    if (r !== undefined) await secrets.reload();
                  }}
                >
                  <Trash size={15} />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </>
  );
}
