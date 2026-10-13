import fs from 'node:fs/promises';
import path from 'node:path';
import { config, serverOverrides } from '../lib/config.js';
import { HttpError, readJson, sendJson, type Req, type Res, type Router } from '../lib/http.js';
import { log } from '../lib/log.js';
import { tunnelIdOf, type TunnelStatus } from '../tunnel/index.js';
import { control } from './accounts.js';

/**
 * Studio > Internet access: the public address apps and emails use, and the
 * Cloudflare Tunnel that keel-tunnel runs. Both are changed here, without
 * editing .env or touching the server.
 */

type Deps = {
  authed: (fn: (req: Req, res: Res) => unknown) => (req: Req, res: Res) => unknown;
  /** Reloads server settings in this process (the other services get a notification). */
  reload: () => Promise<void>;
};

const tokenFile = () => path.join(config.tunnel.dir, 'token');
const statusFile = () => path.join(config.tunnel.dir, 'status.json');

/** A public address: http(s)://host[:port][/path], no query, no credentials. */
export function cleanPublicUrl(input: unknown): string | null {
  const v = String(input ?? '').trim();
  if (!v) return null;
  let u: URL;
  try {
    u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(v) ? v : `https://${v}`);
  } catch {
    throw new HttpError(400, 'Enter an address such as https://api.example.com', 'bad_request');
  }
  if (!/^https?:$/.test(u.protocol) || !u.hostname || u.username || u.password || u.search || u.hash) {
    throw new HttpError(400, 'Enter an address such as https://api.example.com (http or https, nothing after the path)', 'bad_request');
  }
  return `${u.protocol}//${u.host}${u.pathname}`.replace(/\/+$/, '');
}

/** A host for connection strings: a name or an IP address. */
export function cleanHost(input: unknown): string | null {
  const v = String(input ?? '').trim();
  if (!v) return null;
  if (!/^([A-Za-z0-9-]+\.)*[A-Za-z0-9-]+$|^\[?[0-9A-Fa-f:.]+\]?$/.test(v) || v.length > 253) {
    throw new HttpError(400, 'Enter a host name or IP address, such as 192.168.1.20', 'bad_request');
  }
  return v;
}

/**
 * The tunnel token from whatever was pasted: the token itself, or the whole
 * command Cloudflare shows (`... run --token eyJ...`).
 */
export function extractTunnelToken(input: unknown): string {
  const text = String(input ?? '');
  const candidates = text.match(/eyJ[A-Za-z0-9+/_=-]{40,}/g) || [];
  for (const c of candidates) {
    const t = c.replace(/-/g, '+').replace(/_/g, '/');
    try {
      const j = JSON.parse(Buffer.from(t, 'base64').toString('utf8'));
      if (typeof j.a === 'string' && typeof j.t === 'string' && typeof j.s === 'string') return c;
    } catch {
      // not this one
    }
  }
  throw new HttpError(
    400,
    "That doesn't look like a Cloudflare tunnel token. Copy the command Cloudflare shows after you create the tunnel (it ends with --token eyJ…) and paste it here.",
    'bad_token',
  );
}

async function tunnelInfo() {
  const dirExists = !!(await fs.stat(config.tunnel.dir).catch(() => null))?.isDirectory();
  const configured = !!(await fs.stat(tokenFile()).catch(() => null));
  const status = (await fs
    .readFile(statusFile(), 'utf8')
    .then((s) => JSON.parse(s) as TunnelStatus)
    .catch(() => null)) as TunnelStatus | null;
  // keel-tunnel writes a heartbeat every 10 seconds.
  const running = !!status && Date.now() - Date.parse(status.updatedAt) < 45_000;
  return { available: dirExists && running, configured, status: running ? status : null };
}

async function info() {
  const o = serverOverrides();
  return {
    publicUrl: config.publicUrl,
    envPublicUrl: config.envPublicUrl,
    publicUrlSetHere: !!o.publicUrl,
    publicDbHost: config.publicDbHost,
    publicDbHostSetHere: !!o.publicDbHost,
    tunnel: await tunnelInfo(),
  };
}

async function setSetting(key: string, value: string | null): Promise<void> {
  if (value === null) await control().query('delete from keel.server_settings where key = $1', [key]);
  else {
    await control().query(
      `insert into keel.server_settings (key, value) values ($1, $2)
       on conflict (key) do update set value = excluded.value, updated_at = now()`,
      [key, value],
    );
  }
}

export function registerInternetRoutes(router: Router, { authed, reload }: Deps): void {
  router.get(
    '/api/internet',
    authed(async (_req, res) => sendJson(res, 200, await info())),
  );

  router.put(
    '/api/internet/address',
    authed(async (req, res) => {
      const body = await readJson(req);
      if ('publicUrl' in body) await setSetting('public_url', cleanPublicUrl(body.publicUrl));
      if ('publicDbHost' in body) await setSetting('public_db_host', cleanHost(body.publicDbHost));
      await reload();
      log.info('public address changed in Studio', { public_url: config.publicUrl, db_host: config.publicDbHost });
      sendJson(res, 200, await info());
    }),
  );

  router.post(
    '/api/internet/check',
    authed(async (req, res) => {
      const body = await readJson(req);
      const url = cleanPublicUrl(body.url ?? config.publicUrl) || config.publicUrl;
      const started = Date.now();
      try {
        const r = await fetch(`${url}/health`, { redirect: 'manual', signal: AbortSignal.timeout(10_000) });
        const json = (await r.json().catch(() => null)) as { status?: string } | null;
        const ok = r.status === 200 && json?.status === 'ok';
        sendJson(res, 200, {
          url,
          ok,
          ms: Date.now() - started,
          message: ok ? 'Keel answered at this address.' : `The address answered, but not like Keel (HTTP ${r.status}).`,
        });
      } catch (err) {
        const e = err as Error & { cause?: { code?: string } };
        const why = e.name === 'TimeoutError' ? 'no answer within 10 seconds' : e.cause?.code || e.message;
        sendJson(res, 200, { url, ok: false, ms: Date.now() - started, message: `Couldn't reach it (${why}).` });
      }
    }),
  );

  router.put(
    '/api/internet/tunnel',
    authed(async (req, res) => {
      const token = extractTunnelToken((await readJson(req)).token);
      await fs.mkdir(config.tunnel.dir, { recursive: true });
      await fs.writeFile(`${tokenFile()}.tmp`, token, { mode: 0o600 });
      await fs.rename(`${tokenFile()}.tmp`, tokenFile());
      log.info('tunnel token saved in Studio', { tunnel: tunnelIdOf(token) });
      sendJson(res, 200, await info());
    }),
  );

  router.delete(
    '/api/internet/tunnel',
    authed(async (_req, res) => {
      await fs.rm(tokenFile(), { force: true });
      log.info('tunnel turned off in Studio');
      sendJson(res, 200, await info());
    }),
  );
}
