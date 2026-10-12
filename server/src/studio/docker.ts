import http from 'node:http';
import os from 'node:os';
import { config } from '../lib/config.js';
import { log } from '../lib/log.js';

/** Minimal Docker Engine API client (unix socket or tcp). */

type Target = { socketPath?: string; host?: string; port?: number };

function target(): Target | null {
  const h = config.docker.host;
  if (!h) return null;
  if (h.startsWith('unix://')) return { socketPath: h.slice('unix://'.length) };
  const m = /^tcp:\/\/([^:/]+)(?::(\d+))?/.exec(h);
  if (m) return { host: m[1], port: Number(m[2] || 2375) };
  return null;
}

function request(method: string, path: string, opts: { raw?: boolean; timeout?: number } = {}): Promise<{ status: number; body: Buffer }> {
  const t = target();
  if (!t) return Promise.reject(new Error('Docker access is disabled'));
  return new Promise((resolve, reject) => {
    const req = http.request({ ...t, method, path: `/v1.41${path}`, timeout: opts.timeout ?? 8000, headers: { Host: 'docker' } }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode || 0, body: Buffer.concat(chunks) }));
    });
    req.on('timeout', () => req.destroy(new Error('Docker API timed out')));
    req.on('error', reject);
    req.end();
  });
}

async function json<T>(method: string, path: string): Promise<T> {
  const r = await request(method, path);
  if (r.status >= 400) throw new Error(`Docker API ${method} ${path} failed (${r.status}): ${r.body.toString().slice(0, 200)}`);
  return (r.body.length ? JSON.parse(r.body.toString('utf8')) : null) as T;
}

export type ContainerInfo = {
  id: string;
  name: string;
  service: string;
  role: string;
  image: string;
  state: string;
  status: string;
  health: string | null;
  createdAt: string;
};

type DockerContainer = {
  Id: string;
  Names: string[];
  Image: string;
  State: string;
  Status: string;
  Labels: Record<string, string>;
  Created: number;
};

let composeProject: string | null = null;

async function detectComposeProject(): Promise<string | null> {
  if (composeProject) return composeProject;
  if (config.docker.composeProject) return (composeProject = config.docker.composeProject);
  try {
    const self = await json<{ Config: { Labels: Record<string, string> } }>('GET', `/containers/${os.hostname()}/json`);
    composeProject = self.Config.Labels['com.docker.compose.project'] || null;
  } catch {
    composeProject = null;
  }
  return composeProject;
}

const ORDER = ['keel-db', 'keel-rest', 'keel-auth', 'keel-realtime', 'keel-storage', 'keel-gateway', 'keel-egress', 'keel-imgproxy', 'keel-studio', 'keel-tunnel', 'keel-docker', 'keel-migrate'];

export async function listContainers(): Promise<ContainerInfo[]> {
  const project = await detectComposeProject();
  const filter = project ? { label: [`com.docker.compose.project=${project}`] } : { label: ['keel.role'] };
  const list = await json<DockerContainer[]>('GET', `/containers/json?all=1&filters=${encodeURIComponent(JSON.stringify(filter))}`);
  const out = list.map((c) => {
    const service = c.Labels['com.docker.compose.service'] || c.Names[0]?.replace(/^\//, '') || c.Id.slice(0, 12);
    const health = /\((healthy|unhealthy|health: starting)\)/.exec(c.Status)?.[1] || null;
    return {
      id: c.Id,
      name: c.Names[0]?.replace(/^\//, '') || service,
      service,
      role: c.Labels['keel.role'] || '',
      image: c.Labels['keel.image'] || c.Image,
      state: c.State,
      status: c.Status,
      health,
      createdAt: new Date(c.Created * 1000).toISOString(),
    };
  });
  const rank = (s: string) => {
    const i = ORDER.indexOf(s);
    return i < 0 ? ORDER.length : i;
  };
  return out.sort((a, b) => rank(a.service) - rank(b.service) || a.service.localeCompare(b.service));
}

export async function findContainer(service: string): Promise<ContainerInfo> {
  const all = await listContainers();
  const c = all.find((x) => x.service === service || x.name === service);
  if (!c) throw Object.assign(new Error(`No container for service "${service}"`), { status: 404 });
  return c;
}

export async function containerAction(service: string, action: 'start' | 'stop' | 'restart'): Promise<void> {
  const c = await findContainer(service);
  const r = await request('POST', `/containers/${c.id}/${action}${action === 'start' ? '' : '?t=10'}`, { timeout: 30_000 });
  if (r.status >= 400 && r.status !== 304) throw new Error(`Docker refused to ${action} ${service} (${r.status}): ${r.body.toString().slice(0, 200)}`);
  log.info(`container ${action}`, { service });
}

export type LogLine = { t: string; lvl: string; msg: string };

/** Fetches recent log lines and normalises levels across Postgres, PostgREST and Keel services. */
export async function containerLogs(service: string, tail = 200, since?: number): Promise<LogLine[]> {
  const c = await findContainer(service);
  const q = new URLSearchParams({ stdout: '1', stderr: '1', timestamps: '1', tail: String(tail) });
  if (since) q.set('since', String(since));
  const r = await request('GET', `/containers/${c.id}/logs?${q}`, { timeout: 10_000 });
  if (r.status >= 400) throw new Error(`Docker logs failed (${r.status})`);
  return demux(r.body)
    .split('\n')
    .filter((l) => l.trim())
    .map(parseLine)
    .filter((l) => l.msg);
}

/** Docker multiplexes stdout/stderr with 8-byte frame headers when there is no TTY. */
function demux(buf: Buffer): string {
  if (buf.length < 8 || (buf[0] !== 1 && buf[0] !== 2) || buf[1] !== 0) return buf.toString('utf8');
  const parts: Buffer[] = [];
  let off = 0;
  while (off + 8 <= buf.length) {
    const len = buf.readUInt32BE(off + 4);
    parts.push(buf.subarray(off + 8, off + 8 + len));
    off += 8 + len;
  }
  return Buffer.concat(parts).toString('utf8');
}

const LEVELS: Record<string, string> = {
  LOG: 'LOG', INFO: 'INFO', NOTICE: 'INFO', DEBUG: 'DEBUG', WARN: 'WARN', WARNING: 'WARN', ERROR: 'ERROR', FATAL: 'ERROR', PANIC: 'ERROR', ALERT: 'ERROR', CRIT: 'ERROR',
};

function parseLine(line: string): LogLine {
  // Docker prefixes an RFC3339 timestamp.
  let rest = line;
  let t = '';
  const ts = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(\.\d+)?Z\s/.exec(rest);
  if (ts) {
    t = ts[1];
    rest = rest.slice(ts[0].length);
  }
  // Keel services: "2026-10-02T14:02:11.123Z INFO  message"
  rest = rest.replace(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z\s+/, '');
  // Postgres: "2026-10-02 14:02:11.123 UTC [1] LOG:  message"
  rest = rest.replace(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(\.\d+)? \w+ \[\d+\] /, '');
  let lvl = 'INFO';
  const m = /^(LOG|INFO|NOTICE|DEBUG|WARN|WARNING|ERROR|FATAL|PANIC|STATEMENT|DETAIL|HINT|CONTEXT)\b:?\s*/.exec(rest);
  if (m) {
    lvl = LEVELS[m[1]] || 'LOG';
    rest = rest.slice(m[0].length);
  } else {
    const bracket = /^\[(NOTICE|WARNING|ALERT|ERROR|INFO)\]\s*(\(\d+\)\s*:\s*)?/.exec(rest);
    if (bracket) {
      lvl = LEVELS[bracket[1]] || 'INFO';
      rest = rest.slice(bracket[0].length);
    } else if (/\b(error|fatal|panic)\b/i.test(rest)) {
      lvl = 'ERROR';
    } else if (/\bwarn(ing)?\b/i.test(rest)) {
      lvl = 'WARN';
    }
  }
  return { t: t ? new Date(t + 'Z').toISOString() : '', lvl, msg: rest.trim() };
}

export function dockerEnabled(): boolean {
  return target() !== null;
}
