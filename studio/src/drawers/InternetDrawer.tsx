import { useEffect, useState, type FormEvent } from 'react';
import { ArrowSquareOut } from '@phosphor-icons/react';
import { del, get, post, put } from '../api';
import { CopyButton, Loading, Notice, useAction, useConfirm } from '../components/ui';
import { useStudio } from '../ctx';
import { useLoad } from '../lib/hooks';
import { Shell } from './Shell';

type TunnelStatus = {
  state: 'off' | 'starting' | 'connected' | 'error';
  connections: number;
  error: string | null;
  tunnelId: string | null;
  log: string[];
  updatedAt: string;
};

type Internet = {
  publicUrl: string;
  envPublicUrl: string;
  publicUrlSetHere: boolean;
  publicDbHost: string;
  publicDbHostSetHere: boolean;
  tunnel: { available: boolean; configured: boolean; status: TunnelStatus | null };
};

type Check = { url: string; ok: boolean; ms: number; message: string };

const CLOUDFLARE = 'https://one.dash.cloudflare.com/';

/** Internet access: the public address, and a Cloudflare Tunnel run by Keel. */
export function InternetDrawer() {
  const { reloadInstance } = useStudio();
  const load = useLoad(() => get<Internet>('/api/internet'), [], { poll: 3000 });
  const [d, setD] = useState<Internet | null>(null);
  useEffect(() => {
    if (load.data) setD(load.data);
  }, [load.data]);

  const { run, busy } = useAction();
  const confirm = useConfirm();
  const [addr, setAddr] = useState('');
  const [dbHost, setDbHost] = useState('');
  const [token, setToken] = useState('');
  const [host, setHost] = useState('');
  const [check, setCheck] = useState<Check | null>(null);

  useEffect(() => {
    if (!d) return;
    setAddr((a) => a || d.publicUrl);
    setDbHost((h) => h || d.publicDbHost);
  }, [d]);

  if (!d) {
    return (
      <Shell label="Internet access" title="Internet access" sub="Reach Keel from anywhere">
        {load.error ? (
          <div className="section">
            <Notice kind="err">{load.error.message}</Notice>
          </div>
        ) : (
          <Loading />
        )}
      </Shell>
    );
  }

  const applied = async (next: Internet | undefined) => {
    if (!next) return;
    setD(next);
    setAddr(next.publicUrl);
    setDbHost(next.publicDbHost);
    await reloadInstance();
  };

  const runCheck = async (url?: string) => {
    const r = await run('check', () => post<Check>('/api/internet/check', { url: url ?? addr }));
    if (r) setCheck(r);
    return r;
  };

  const saveAddress = async (e: FormEvent) => {
    e.preventDefault();
    await applied(await run('addr', () => put<Internet>('/api/internet/address', { publicUrl: addr }), 'Public address saved'));
  };

  const submitHostname = async (e: FormEvent) => {
    e.preventDefault();
    const h = host.trim().replace(/^https?:\/\//i, '').replace(/\/.*$/, '');
    if (!h) return;
    const next = await run('host', () => put<Internet>('/api/internet/address', { publicUrl: `https://${h}` }), 'Public address saved');
    await applied(next);
    if (next) await runCheck(next.publicUrl);
  };

  const t = d.tunnel;
  const s = t.status;

  return (
    <Shell label="Internet access" title="Internet access" sub="Reach Keel from anywhere">
      <div className="section">
        <h3>Public address</h3>
        <p className="muted" style={{ margin: 0, fontSize: 13 }}>
          Where your apps, emails and sign-in links reach Keel's API. Studio's Connect panel and the AI agent prompt use it too.
        </p>
        <form onSubmit={saveAddress} style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <label className="field">
            <span>Address</span>
            <input
              className="input mono"
              name="public-url"
              inputMode="url"
              autoCapitalize="none"
              autoComplete="off"
              spellCheck={false}
              placeholder="https://api.example.com…"
              value={addr}
              onChange={(e) => setAddr(e.target.value)}
            />
            <small>
              {d.publicUrlSetHere ? (
                <>
                  Set here. The server's own setting is <span className="mono">{d.envPublicUrl}</span>.
                </>
              ) : (
                <>From the server's settings. Change it here; no restart needed.</>
              )}
            </small>
          </label>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button className="btn-dark md" disabled={busy === 'addr' || addr.trim() === d.publicUrl}>
              {busy === 'addr' ? 'Saving…' : 'Save'}
            </button>
            <button type="button" className="pill md" disabled={busy === 'check'} onClick={() => void runCheck()}>
              {busy === 'check' ? 'Checking…' : 'Check'}
            </button>
            {d.publicUrlSetHere && (
              <button
                type="button"
                className="pill md"
                onClick={async () => applied(await run('addr', () => put<Internet>('/api/internet/address', { publicUrl: null }), 'Back to the server setting'))}
              >
                Use the server setting
              </button>
            )}
          </div>
        </form>
        {check && (
          <div aria-live="polite">
            <Notice kind={check.ok ? 'ok' : 'err'}>
              <span className="mono">{check.url}</span>: {check.message}
            </Notice>
          </div>
        )}
        <details>
          <summary className="muted" style={{ fontSize: 13, cursor: 'pointer' }}>
            Database address in connection strings
          </summary>
          <form
            style={{ display: 'flex', gap: 8, marginTop: 8 }}
            onSubmit={async (e) => {
              e.preventDefault();
              await applied(await run('db', () => put<Internet>('/api/internet/address', { publicDbHost: dbHost }), 'Saved'));
            }}
          >
            <input
              className="input mono"
              aria-label="Database host"
              autoCapitalize="none"
              spellCheck={false}
              placeholder="192.168.1.20…"
              value={dbHost}
              onChange={(e) => setDbHost(e.target.value)}
              style={{ flex: 1, minWidth: 0 }}
            />
            <button className="pill md" disabled={busy === 'db' || dbHost.trim() === d.publicDbHost}>
              Save
            </button>
          </form>
          <small className="muted" style={{ display: 'block', marginTop: 6, fontSize: 12 }}>
            Postgres isn't reachable through a tunnel, so use your server's address on your network (its IP, or its Tailscale name).
          </small>
        </details>
      </div>

      <div className="section">
        <h3 style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          Cloudflare Tunnel <TunnelBadge configured={t.configured} status={s} />
        </h3>
        <p className="muted" style={{ margin: 0, fontSize: 13 }}>
          Puts the API on the internet at your own domain, without opening ports on your router or showing your home's IP address. Free, with a domain on
          Cloudflare. The tunnel can only reach Keel's API and Studio.
        </p>

        {!t.available ? (
          <Notice kind="warn">
            This Keel doesn't include the tunnel service yet. Update Keel (run the install command again, or load the newest compose file in your server
            panel), then come back here.
          </Notice>
        ) : !t.configured ? (
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              const next = await run('token', () => put<Internet>('/api/internet/tunnel', { token }), 'Tunnel connecting…');
              if (next) {
                setD(next);
                setToken('');
              }
            }}
            style={{ display: 'flex', flexDirection: 'column', gap: 10 }}
          >
            <ol className="steps">
              <li>
                In Cloudflare, open <b>Zero Trust → Networks → Tunnels</b>, click <b>Create a tunnel</b>, choose <b>Cloudflared</b> and give it a name.{' '}
                <a href={CLOUDFLARE} target="_blank" rel="noopener">
                  Open Cloudflare <ArrowSquareOut size={12} />
                </a>
              </li>
              <li>
                On the next page, choose <b>Docker</b> and copy the command it shows.
              </li>
              <li>
                Paste it here. Only the token in it is kept, on this server.
                <textarea
                  className="textarea mono"
                  aria-label="Cloudflare tunnel command or token"
                  rows={3}
                  spellCheck={false}
                  autoCapitalize="none"
                  placeholder="docker run cloudflare/cloudflared:latest tunnel --no-autoupdate run --token eyJ…"
                  value={token}
                  onChange={(e) => setToken(e.target.value)}
                  style={{ marginTop: 6 }}
                />
              </li>
            </ol>
            <div>
              <button className="btn-dark md" disabled={!token.trim() || busy === 'token'}>
                {busy === 'token' ? 'Starting…' : 'Start tunnel'}
              </button>
            </div>
          </form>
        ) : (
          <>
            {s?.state === 'error' && s.error && <Notice kind="err">{s.error}</Notice>}
            <ol className="steps" start={4}>
              <li>
                In Cloudflare, on the tunnel's <b>Public hostname</b> tab, add a hostname: a subdomain such as <span className="mono">api</span>, your domain,
                type <b>HTTP</b> and URL <span className="mono">keel-gateway:8000</span> <CopyButton text="keel-gateway:8000" />
              </li>
              <li>
                Enter that hostname here, and Keel uses it as its public address:
                <form onSubmit={submitHostname} style={{ display: 'flex', gap: 8, marginTop: 6 }}>
                  <input
                    className="input mono"
                    aria-label="Public hostname"
                    inputMode="url"
                    autoCapitalize="none"
                    spellCheck={false}
                    placeholder="api.example.com…"
                    value={host}
                    onChange={(e) => setHost(e.target.value)}
                    style={{ flex: 1, minWidth: 0 }}
                  />
                  <button className="btn-dark md" disabled={!host.trim() || busy === 'host'}>
                    {busy === 'host' ? 'Saving…' : 'Use it'}
                  </button>
                </form>
              </li>
            </ol>
            {s && s.log.length > 0 && (
              <details>
                <summary className="muted" style={{ fontSize: 13, cursor: 'pointer' }}>
                  Tunnel log
                </summary>
                <pre className="snippet wrap" style={{ maxHeight: 220, overflow: 'auto' }}>
                  {s.log.join('\n')}
                </pre>
              </details>
            )}
            <div>
              <button
                type="button"
                className="pill md"
                onClick={async () => {
                  if (!(await confirm({ title: 'Turn off the tunnel?', body: 'Keel goes offline at your domain. Your home network keeps working.', confirm: 'Turn off', danger: true })))
                    return;
                  const next = await run('off', () => del<Internet>('/api/internet/tunnel'), 'Tunnel turned off');
                  if (next) setD(next);
                }}
              >
                Turn off the tunnel
              </button>
            </div>
          </>
        )}
      </div>

      <div className="section">
        <h3>Studio</h3>
        <p className="muted" style={{ margin: 0, fontSize: 13 }}>
          Studio stays on your home network. To use it from outside too, add a second hostname in Cloudflare with URL{' '}
          <span className="mono">keel-studio:3000</span>, protected by Cloudflare Access, and turn on two-factor first.{' '}
          <a href="/docs/self-hosting/cloudflare-tunnel#put-studio-online" target="_blank" rel="noopener">
            How
          </a>
        </p>
      </div>
    </Shell>
  );
}

function TunnelBadge({ configured, status }: { configured: boolean; status: TunnelStatus | null }) {
  if (!configured) return <span className="tag">Off</span>;
  if (!status || status.state === 'starting' || status.state === 'off') return <span className="tag">Connecting…</span>;
  if (status.state === 'connected') {
    return (
      <span className="tag" style={{ color: 'var(--green, #1f9d62)', borderColor: 'currentColor' }}>
        Connected
      </span>
    );
  }
  return (
    <span className="tag" style={{ color: 'var(--red, #d93a2b)', borderColor: 'currentColor' }}>
      Not connected
    </span>
  );
}
