import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, File, FileCsv, FileImage, FilePdf, FileText, FileZip, Folder, FolderPlus, GearSix, GlobeSimple, LockSimple, Plus, UploadSimple } from '@phosphor-icons/react';
import { api, enc, get, post, put } from '../api';
import { CopyButton, Loading, Notice, Switch, useAction, useConfirm, useToast } from '../components/ui';
import { projectPath, useStudio } from '../ctx';
import { bytes, when } from '../lib/format';
import { useLoad, useStored } from '../lib/hooks';
import { Shell } from './Shell';

type Bucket = { id: string; name: string; public: boolean; file_size_limit: number | null; allowed_mime_types: string[] | null; files: number; size: number };
type Entry = { name: string; id: string | null; updated_at: string | null; metadata: { size?: number; mimetype?: string } | null };

const PLACEHOLDER = '.emptyFolderPlaceholder';

function fileIcon(e: Entry) {
  const t = e.metadata?.mimetype || '';
  if (!e.id) return <Folder size={20} color="var(--accent)" weight="fill" />;
  if (t.startsWith('image/')) return <FileImage size={20} color="var(--muted)" />;
  if (t.includes('csv')) return <FileCsv size={20} color="var(--muted)" />;
  if (t.includes('pdf')) return <FilePdf size={20} color="var(--muted)" />;
  if (/zip|gzip|tar|compressed/.test(t)) return <FileZip size={20} color="var(--muted)" />;
  if (t.startsWith('text/') || t.includes('json')) return <FileText size={20} color="var(--muted)" />;
  return <File size={20} color="var(--muted)" />;
}

export function StorageDrawer() {
  const { project, mobile, reloadOverview } = useStudio();
  const base = projectPath(project);
  const buckets = useLoad(() => get<Bucket[]>(`${base}/buckets`), [base]);
  const [stored, setStored] = useStored<string | null>(`keel.storage.bucket.${project}`, null);
  const list = buckets.data || [];
  const bucket = list.find((b) => b.id === stored) || list[0] || null;
  const [prefix, setPrefix] = useState('');
  const [view, setView] = useState<'files' | 'new-bucket' | 'bucket-settings' | { file: Entry }>('files');
  const [drop, setDrop] = useState(false);
  const [uploading, setUploading] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const toast = useToast();

  useEffect(() => setPrefix(''), [bucket?.id]);

  const entries = useLoad(
    () => get<Entry[]>(`${base}/buckets/${enc(bucket!.id)}/objects?prefix=${enc(prefix)}`),
    [base, bucket?.id, prefix],
    { enabled: !!bucket },
  );

  const upload = async (files: FileList | File[]) => {
    if (!bucket) return;
    const arr = [...files];
    let ok = 0;
    for (const f of arr) {
      setUploading(`Uploading ${f.name}…`);
      try {
        await api('POST', `${base}/buckets/${enc(bucket.id)}/upload?path=${enc(prefix + f.name)}`, undefined, { raw: f, contentType: f.type || 'application/octet-stream' });
        ok++;
      } catch (e) {
        toast(`${f.name}: ${(e as Error).message}`, true);
      }
    }
    setUploading(null);
    if (ok) toast(ok === 1 ? `Uploaded ${arr[0].name}` : `Uploaded ${ok} files`);
    await entries.reload();
    void buckets.reload();
    void reloadOverview();
  };

  const newFolder = async () => {
    const name = window.prompt('Folder name');
    if (!name || !bucket) return;
    const clean = name.replace(/^\/+|\/+$/g, '');
    if (!clean) return;
    try {
      await api('POST', `${base}/buckets/${enc(bucket.id)}/upload?path=${enc(`${prefix}${clean}/${PLACEHOLDER}`)}`, undefined, { raw: new Blob(['']), contentType: 'text/plain' });
      setPrefix(`${prefix}${clean}/`);
    } catch (e) {
      toast((e as Error).message, true);
    }
  };

  const sub = bucket ? `${bucket.name}, ${bucket.public ? 'public' : 'private'}` : 'Files for your apps';

  return (
    <Shell
      label="Storage"
      title="Storage"
      sub={sub}
      actions={
        bucket && view === 'files' ? (
          <button className="icon-btn" aria-label="Bucket settings" title="Bucket settings" onClick={() => setView('bucket-settings')}>
            <GearSix size={15} />
          </button>
        ) : undefined
      }
    >
      <div className={mobile ? 'section' : 'toolbar'} style={mobile ? { paddingBottom: 6 } : undefined}>
        <div className={mobile ? 'chips' : ''} style={mobile ? undefined : { display: 'contents' }}>
          {list.map((b) => (
            <button
              key={b.id}
              className={`pill md${bucket?.id === b.id && view !== 'new-bucket' ? ' on' : ''}`}
              style={bucket?.id === b.id ? undefined : { color: 'var(--muted)' }}
              onClick={() => {
                setStored(b.id);
                setView('files');
              }}
            >
              {b.public ? <GlobeSimple size={15} /> : <LockSimple size={15} />}
              {b.name}
            </button>
          ))}
          <button className={`pill md${view === 'new-bucket' ? ' on' : ''}`} onClick={() => setView('new-bucket')} aria-label="New bucket" title="New bucket">
            <Plus size={15} />
            {list.length === 0 && 'New bucket'}
          </button>
        </div>
        {bucket && view === 'files' && !mobile && (
          <button className="btn-dark md grow" onClick={() => fileInput.current?.click()} disabled={!!uploading}>
            <UploadSimple size={15} />
            Upload
          </button>
        )}
      </div>
      <input ref={fileInput} type="file" multiple hidden onChange={(e) => e.target.files && upload(e.target.files)} />

      {buckets.error && <div className="section"><Notice kind="err">{buckets.error.message}</Notice></div>}
      {view === 'new-bucket' ? (
        <NewBucket
          base={base}
          onCreated={async (id) => {
            await buckets.reload();
            setStored(id);
            setView('files');
            void reloadOverview();
          }}
          onCancel={() => setView('files')}
        />
      ) : !buckets.data ? (
        <Loading />
      ) : !bucket ? (
        <div className="empty">
          <b>No buckets yet</b>
          Buckets hold files. Public buckets serve files to anyone with the URL; private ones follow your storage policies.
          <div style={{ marginTop: 14 }}>
            <button className="btn-dark md" onClick={() => setView('new-bucket')}>
              <Plus size={15} /> New bucket
            </button>
          </div>
        </div>
      ) : view === 'bucket-settings' ? (
        <BucketSettings
          base={base}
          bucket={bucket}
          onBack={() => setView('files')}
          onChanged={async (deleted) => {
            await buckets.reload();
            if (deleted) setStored(null);
            setView('files');
            void reloadOverview();
          }}
        />
      ) : typeof view === 'object' ? (
        <FileDetail
          base={base}
          bucket={bucket}
          path={prefix + view.file.name}
          entry={view.file}
          onBack={() => setView('files')}
          onDeleted={async () => {
            setView('files');
            await entries.reload();
            void buckets.reload();
            void reloadOverview();
          }}
        />
      ) : (
        <div
          className={drop ? 'dropzone' : ''}
          style={{ minHeight: 200 }}
          onDragOver={(e) => {
            e.preventDefault();
            setDrop(true);
          }}
          onDragLeave={() => setDrop(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDrop(false);
            if (e.dataTransfer.files.length) void upload(e.dataTransfer.files);
          }}
        >
          <div className="crumbs">
            <button onClick={() => setPrefix('')}>{bucket.name}</button>
            {prefix
              .split('/')
              .filter(Boolean)
              .map((seg, i, all) => (
                <span key={i} style={{ display: 'contents' }}>
                  <span className="sep">/</span>
                  <button onClick={() => setPrefix(all.slice(0, i + 1).join('/') + '/')}>{seg}</button>
                </span>
              ))}
            <span style={{ flex: 1 }} />
            {mobile && (
              <button onClick={() => fileInput.current?.click()} style={{ fontFamily: 'var(--sans)', display: 'inline-flex', gap: 4, alignItems: 'center' }}>
                <UploadSimple size={14} /> Upload
              </button>
            )}
            <button onClick={newFolder} style={{ fontFamily: 'var(--sans)', display: 'inline-flex', gap: 4, alignItems: 'center' }}>
              <FolderPlus size={14} /> New folder
            </button>
          </div>
          {uploading && (
            <div className="section" style={{ paddingTop: 10, paddingBottom: 10 }}>
              <Notice>{uploading}</Notice>
            </div>
          )}
          {!entries.data ? (
            entries.error ? <div className="section"><Notice kind="err">{entries.error.message}</Notice></div> : <Loading />
          ) : entries.data.filter((x) => x.name !== PLACEHOLDER).length === 0 ? (
            <div className="empty">
              <b>{prefix ? 'This folder is empty' : 'This bucket is empty'}</b>
              Drop files here or use Upload.
            </div>
          ) : (
            entries.data
              .filter((x) => x.name !== PLACEHOLDER)
              .map((x) => (
                <button key={(x.id || 'dir') + x.name} className="file-row" onClick={() => (x.id ? setView({ file: x }) : setPrefix(`${prefix}${x.name}/`))}>
                  {fileIcon(x)}
                  <span className="two-line">
                    <span className="a" style={{ fontWeight: 400 }}>
                      {x.id ? x.name : `${x.name}/`}
                    </span>
                    <span className="b">{x.id ? `${x.metadata?.mimetype || 'file'}, ${when(x.updated_at)}` : 'Folder'}</span>
                  </span>
                  <span className="mono" style={{ fontSize: 12, color: 'var(--muted)' }}>
                    {x.id ? bytes(x.metadata?.size || 0) : '-'}
                  </span>
                </button>
              ))
          )}
        </div>
      )}
    </Shell>
  );
}

function NewBucket({ base, onCreated, onCancel }: { base: string; onCreated: (id: string) => void; onCancel: () => void }) {
  const [name, setName] = useState('');
  const [pub, setPub] = useState(false);
  const [limit, setLimit] = useState('');
  const [types, setTypes] = useState('');
  const { busy, run } = useAction();
  return (
    <form
      className="section"
      onSubmit={async (e) => {
        e.preventDefault();
        const r = await run(
          'create',
          () =>
            post(`${base}/buckets`, {
              name,
              public: pub,
              fileSizeLimit: limit.trim() || null,
              allowedMimeTypes: types.split(',').map((t) => t.trim()).filter(Boolean),
            }),
          `Created bucket ${name}`,
        );
        if (r) onCreated(name);
      }}
    >
      <h3>New bucket</h3>
      <label className="field">
        <span>Name</span>
        <input className="input mono" value={name} onChange={(e) => setName(e.target.value.replace(/[^A-Za-z0-9._ -]/g, '-'))} placeholder="avatars" required autoFocus />
      </label>
      <div className="setting">
        <span className="two-line">
          <span className="a">Public bucket</span>
          <span className="b">Anyone with a file's URL can download it. Uploads still need a policy or the service key.</span>
        </span>
        <Switch label="Public bucket" checked={pub} onChange={setPub} />
      </div>
      <div className="form-grid">
        <label className="field">
          <span>Max file size</span>
          <input className="input mono" value={limit} onChange={(e) => setLimit(e.target.value)} placeholder="e.g. 5MB (optional)" />
        </label>
        <label className="field">
          <span>Allowed types</span>
          <input className="input mono" value={types} onChange={(e) => setTypes(e.target.value)} placeholder="image/*, application/pdf" />
        </label>
      </div>
      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
        <button type="button" className="pill md" onClick={onCancel}>
          Cancel
        </button>
        <button className="btn-dark md" disabled={busy === 'create' || !name}>
          {busy === 'create' ? 'Creating…' : 'Create bucket'}
        </button>
      </div>
    </form>
  );
}

function BucketSettings({ base, bucket, onBack, onChanged }: { base: string; bucket: Bucket; onBack: () => void; onChanged: (deleted?: boolean) => void }) {
  const { run, busy } = useAction();
  const confirm = useConfirm();
  return (
    <>
      <div className="toolbar">
        <button className="pill" onClick={onBack}>
          <ArrowLeft size={14} /> Files
        </button>
        <b style={{ marginLeft: 4 }}>{bucket.name}</b>
      </div>
      <div className="section">
        <div className="setting">
          <span className="two-line">
            <span className="a">Public bucket</span>
            <span className="b">{bucket.public ? 'Files are readable by anyone with the URL.' : 'Downloads need a signed URL, a policy, or the service key.'}</span>
          </span>
          <Switch
            label="Public bucket"
            checked={bucket.public}
            disabled={busy === 'pub'}
            onChange={async (v) => {
              const r = await run('pub', () => put(`${base}/buckets/${enc(bucket.id)}`, { public: v }), v ? 'Bucket is now public' : 'Bucket is now private');
              if (r) onChanged();
            }}
          />
        </div>
        <dl className="kv">
          <dt>Files</dt>
          <dd>{bucket.files}</dd>
          <dt>Size</dt>
          <dd>{bytes(bucket.size)}</dd>
          <dt>Max file size</dt>
          <dd>{bucket.file_size_limit ? bytes(bucket.file_size_limit) : 'Stack default'}</dd>
          <dt>Allowed types</dt>
          <dd className="mono">{bucket.allowed_mime_types?.join(', ') || 'Any'}</dd>
        </dl>
        <Notice>
          Access to files in private buckets is controlled by policies on <code>storage.objects</code>, e.g.{' '}
          <code>{`bucket_id = '${bucket.id}' and (storage.foldername(name))[1] = auth.uid()::text`}</code>
        </Notice>
      </div>
      <div className="section">
        <h3>Danger zone</h3>
        <button
          className="pill md danger"
          style={{ alignSelf: 'flex-start' }}
          onClick={async () => {
            const ok = await confirm({ title: `Delete bucket ${bucket.name}?`, body: `All ${bucket.files} files in it are deleted.`, confirm: 'Delete bucket', danger: true, typeToConfirm: bucket.name });
            if (!ok) return;
            const r = await run('del', () => api('DELETE', `${base}/buckets/${enc(bucket.id)}`, {}), 'Bucket deleted');
            if (r) onChanged(true);
          }}
        >
          Delete bucket
        </button>
      </div>
    </>
  );
}

function FileDetail({ base, bucket, path, entry, onBack, onDeleted }: { base: string; bucket: Bucket; path: string; entry: Entry; onBack: () => void; onDeleted: () => void }) {
  const [urls, setUrls] = useState<{ publicUrl: string | null; signedUrl: string } | null>(null);
  const { run } = useAction();
  const confirm = useConfirm();
  useEffect(() => {
    post<{ publicUrl: string | null; signedUrl: string }>(`${base}/buckets/${enc(bucket.id)}/url`, { path, expiresIn: 3600 }).then(setUrls, () => setUrls(null));
  }, [base, bucket.id, path]);
  const isImage = (entry.metadata?.mimetype || '').startsWith('image/');
  const url = urls?.publicUrl || urls?.signedUrl;
  return (
    <>
      <div className="toolbar">
        <button className="pill" onClick={onBack}>
          <ArrowLeft size={14} /> Files
        </button>
      </div>
      <div className="section">
        {isImage && url && (
          <div style={{ border: '1px solid var(--border)', borderRadius: 12, background: 'var(--bg-2)', display: 'flex', justifyContent: 'center', padding: 12 }}>
            <img src={url} alt={entry.name} style={{ maxWidth: '100%', maxHeight: 280, borderRadius: 8 }} />
          </div>
        )}
        <dl className="kv">
          <dt>Path</dt>
          <dd className="mono">{path}</dd>
          <dt>Type</dt>
          <dd>{entry.metadata?.mimetype || '–'}</dd>
          <dt>Size</dt>
          <dd>{bytes(entry.metadata?.size || 0)}</dd>
          <dt>Updated</dt>
          <dd>{when(entry.updated_at)}</dd>
        </dl>
        {urls && (
          <>
            {urls.publicUrl && (
              <div className="api-row">
                <span style={{ flex: 1, minWidth: 0 }}>
                  <span className="lbl">Public URL</span>
                  <span className="val">{urls.publicUrl}</span>
                </span>
                <CopyButton text={urls.publicUrl} />
              </div>
            )}
            <div className="api-row">
              <span style={{ flex: 1, minWidth: 0 }}>
                <span className="lbl">Signed URL (valid 1 hour)</span>
                <span className="val">{urls.signedUrl}</span>
              </span>
              <CopyButton text={urls.signedUrl} />
            </div>
          </>
        )}
        <div style={{ display: 'flex', gap: 8 }}>
          {url && (
            <a className="pill md" href={`${urls!.signedUrl}&download=`} target="_blank" rel="noreferrer">
              Download
            </a>
          )}
          <button
            className="pill md danger"
            onClick={async () => {
              if (!(await confirm({ title: `Delete ${entry.name}?`, confirm: 'Delete file', danger: true }))) return;
              const r = await run('del', () => post(`${base}/buckets/${enc(bucket.id)}/delete`, { paths: [path] }), 'File deleted');
              if (r) onDeleted();
            }}
          >
            Delete
          </button>
        </div>
      </div>
    </>
  );
}
