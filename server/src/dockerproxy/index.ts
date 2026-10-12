import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import os from 'node:os';
import { log } from '../lib/log.js';

/**
 * keel-docker: the one container that talks to Docker. Studio uses it to list
 * this install's containers, read their logs and start, stop or restart them.
 * Every other Docker API call is refused, other containers on the machine are
 * invisible, and container details are cut down to labels and state (no
 * environment variables, so no passwords or tokens).
 */

const SOCKET = process.env.KEEL_DOCKER_SOCKET || '/var/run/docker.sock';
const PORT = Number(process.env.KEEL_DOCKER_PROXY_PORT || 2375);
const MAX_BODY = 20 * 1024 * 1024;
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const LOG_PARAMS = ['stdout', 'stderr', 'timestamps', 'tail', 'since', 'until'];

type Reply = { status: number; type: string; body: Buffer };

function docker(method: string, path: string, timeout = 30_000): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = http.request({ socketPath: SOCKET, method, path, timeout, headers: { Host: 'docker' } }, (res) => {
      const chunks: Buffer[] = [];
      let size = 0;
      res.on('data', (c: Buffer) => {
        size += c.length;
        if (size > MAX_BODY) return req.destroy(new Error('Docker answer too large'));
        chunks.push(c);
      });
      res.on('end', () => resolve({ status: res.statusCode || 502, type: String(res.headers['content-type'] || 'application/json'), body: Buffer.concat(chunks) }));
    });
    req.on('timeout', () => req.destroy(new Error('Docker API timed out')));
    req.on('error', reject);
    req.end();
  });
}

const parse = <T>(r: Reply): T => JSON.parse(r.body.toString('utf8') || 'null') as T;

/** The compose project this proxy belongs to; only its containers are visible. */
let project: string | null = null;

function visible(labels: Record<string, string> | null | undefined): boolean {
  if (!labels) return false;
  return project ? labels['com.docker.compose.project'] === project : !!labels['keel.role'];
}

type Inspect = { Id: string; Name: string; Created: string; Config: { Labels: Record<string, string> | null; Image: string }; State: unknown };

async function inspect(id: string): Promise<Inspect | null> {
  if (!ID_RE.test(id)) return null;
  const r = await docker('GET', `/containers/${encodeURIComponent(id)}/json`);
  if (r.status !== 200) return null;
  const c = parse<Inspect>(r);
  return visible(c.Config?.Labels) ? c : null;
}

function send(res: ServerResponse, status: number, body: unknown, type = 'application/json') {
  const data = Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body));
  res.writeHead(status, { 'Content-Type': type, 'Content-Length': data.length });
  res.end(data);
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url || '/', 'http://docker');
  const path = url.pathname.replace(/^\/v\d+\.\d+(?=\/)/, '');
  const method = req.method || 'GET';
  req.resume();

  if (method === 'GET' && (path === '/_ping' || path === '/version')) {
    const r = await docker('GET', path);
    return send(res, r.status, r.body, r.type);
  }

  if (method === 'GET' && path === '/containers/json') {
    const q = new URLSearchParams({ all: url.searchParams.get('all') === '1' ? '1' : '0' });
    const filter = project ? { label: [`com.docker.compose.project=${project}`] } : { label: ['keel.role'] };
    q.set('filters', JSON.stringify(filter));
    const r = await docker('GET', `/containers/json?${q}`);
    if (r.status !== 200) return send(res, r.status, r.body, r.type);
    const list = parse<{ Id: string; Names: string[]; Image: string; State: string; Status: string; Labels: Record<string, string>; Created: number }[]>(r);
    return send(
      res,
      200,
      list.filter((c) => visible(c.Labels)).map((c) => ({ Id: c.Id, Names: c.Names, Image: c.Image, State: c.State, Status: c.Status, Labels: c.Labels, Created: c.Created })),
    );
  }

  const m = /^\/containers\/([^/]+)\/(json|logs|start|stop|restart)$/.exec(path);
  if (m) {
    const [, id, op] = m;
    const c = await inspect(decodeURIComponent(id));
    if (!c) return send(res, 404, { message: 'No such container' });
    if (method === 'GET' && op === 'json') {
      return send(res, 200, { Id: c.Id, Name: c.Name, Created: c.Created, Config: { Labels: c.Config.Labels, Image: c.Config.Image }, State: c.State });
    }
    if (method === 'GET' && op === 'logs') {
      const q = new URLSearchParams();
      for (const k of LOG_PARAMS) {
        const v = url.searchParams.get(k);
        if (v !== null && /^[A-Za-z0-9.]{1,20}$/.test(v)) q.set(k, v);
      }
      const r = await docker('GET', `/containers/${c.Id}/logs?${q}`);
      return send(res, r.status, r.body, r.type);
    }
    if (method === 'POST' && op !== 'json' && op !== 'logs') {
      const t = url.searchParams.get('t');
      const r = await docker('POST', `/containers/${c.Id}/${op}${t && /^\d{1,3}$/.test(t) ? `?t=${t}` : ''}`, 60_000);
      log.info(`container ${op}`, { container: c.Name.replace(/^\//, '') });
      return send(res, r.status, r.body, r.type);
    }
  }

  send(res, 403, { message: 'keel-docker only lists, starts, stops and restarts Keel containers and reads their logs' });
}

export async function main(): Promise<void> {
  try {
    const self = parse<Inspect>(await docker('GET', `/containers/${os.hostname()}/json`));
    project = self?.Config?.Labels?.['com.docker.compose.project'] || null;
  } catch (err) {
    log.warn('could not inspect this container; showing containers labelled keel.role', { error: (err as Error).message });
  }
  const server = http.createServer((req, res) => {
    handle(req, res).catch((err) => {
      log.warn('docker request failed', { error: (err as Error).message });
      if (!res.headersSent) send(res, 502, { message: 'Docker is not reachable' });
      else res.destroy();
    });
  });
  server.listen(PORT, '0.0.0.0', () => log.info(`keel-docker listening on port ${PORT}`, { project }));
}
