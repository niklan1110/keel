import { spawn, type ChildProcess } from 'node:child_process';
import http from 'node:http';
import readline from 'node:readline';
import { config, requireRolePassword, rolePassword } from '../lib/config.js';
import { postgrestSecret } from '../lib/jwt.js';
import { log } from '../lib/log.js';
import { proxyRequest } from '../lib/proxy.js';
import { Registry, type Project } from '../lib/registry.js';

/**
 * keel-rest supervises one PostgREST process per project and routes
 * /<project>/... to it. PostgREST is the same battle-tested engine Supabase
 * uses, so query syntax, embedding, RPC and RLS behave identically.
 */

type Worker = {
  project: string;
  port: number;
  adminPort: number;
  fingerprint: string;
  child: ChildProcess | null;
  ready: boolean;
  restarts: number;
  stopping: boolean;
  timer?: NodeJS.Timeout;
};

const workers = new Map<string, Worker>();
const usedPorts = new Set<number>();

function allocatePort(): number {
  for (let p = config.rest.basePort; p < config.rest.basePort + 2000; p += 2) {
    if (!usedPorts.has(p)) {
      usedPorts.add(p);
      return p;
    }
  }
  throw new Error('no free ports for PostgREST workers');
}

function fingerprint(p: Project): string {
  return JSON.stringify([p.dbName, postgrestSecret(p.jwtKeys), p.settings.rest || {}, config.publicUrl]);
}

function envFor(p: Project, w: Worker): NodeJS.ProcessEnv {
  const schemas = ['public', ...(p.settings.rest?.schemas || []).filter((s) => s !== 'public')];
  const uri = `postgres://authenticator:${encodeURIComponent(rolePassword('authenticator'))}@${config.db.host}:${config.db.port}/${p.dbName}`;
  return {
    PATH: process.env.PATH,
    PGRST_DB_URI: uri,
    PGRST_DB_SCHEMAS: schemas.join(','),
    PGRST_DB_ANON_ROLE: 'anon',
    PGRST_DB_EXTRA_SEARCH_PATH: 'public,extensions',
    PGRST_DB_POOL: String(config.rest.poolSize),
    PGRST_DB_MAX_ROWS: String(p.settings.rest?.max_rows || config.rest.maxRows),
    PGRST_DB_CHANNEL_ENABLED: 'true',
    PGRST_JWT_SECRET: postgrestSecret(p.jwtKeys),
    PGRST_SERVER_HOST: '127.0.0.1',
    PGRST_SERVER_PORT: String(w.port),
    PGRST_ADMIN_SERVER_PORT: String(w.adminPort),
    PGRST_OPENAPI_SERVER_PROXY_URI: `${config.publicUrl}/${p.name}/rest/v1`,
    PGRST_LOG_LEVEL: process.env.KEEL_POSTGREST_LOG_LEVEL || 'info',
  };
}

function start(p: Project, w: Worker) {
  w.ready = false;
  const child = spawn(config.rest.binary, [], { env: envFor(p, w), stdio: ['ignore', 'pipe', 'pipe'] });
  w.child = child;
  const tag = `[${p.name}]`;
  for (const stream of [child.stdout!, child.stderr!]) {
    readline.createInterface({ input: stream }).on('line', (line) => {
      const msg = line.replace(/^\d{2}\/\w{3}\/\d{4}:\d{2}:\d{2}:\d{2} [+-]\d{4}: /, '');
      if (/error|fatal/i.test(msg)) log.warn(`${tag} ${msg}`);
      else log.info(`${tag} ${msg}`);
    });
  }
  child.on('error', (err) => log.error(`${tag} failed to start PostgREST`, { error: err.message }));
  child.on('exit', (code, signal) => {
    w.child = null;
    w.ready = false;
    if (w.stopping) return;
    const delay = Math.min(30_000, 1000 * 2 ** Math.min(w.restarts++, 5));
    log.warn(`${tag} PostgREST exited, restarting`, { code, signal, in_ms: delay });
    w.timer = setTimeout(() => {
      const current = registryRef?.get(p.name);
      if (current && workers.get(p.name) === w) start(current, w);
    }, delay);
  });
  void waitReady(w);
}

async function waitReady(w: Worker) {
  for (let i = 0; i < 120 && w.child && !w.stopping; i++) {
    const ok = await new Promise<boolean>((resolve) => {
      const req = http.get({ host: '127.0.0.1', port: w.adminPort, path: '/ready', timeout: 1000 }, (res) => {
        res.resume();
        resolve(res.statusCode === 200);
      });
      req.on('error', () => resolve(false));
      req.on('timeout', () => {
        req.destroy();
        resolve(false);
      });
    });
    if (ok) {
      w.ready = true;
      w.restarts = 0;
      log.info(`[${w.project}] REST API ready`);
      return;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
}

function stop(w: Worker) {
  w.stopping = true;
  clearTimeout(w.timer);
  if (w.child) {
    // Free the ports only once the old process has let go of them.
    w.child.once('exit', () => usedPorts.delete(w.port));
    w.child.kill('SIGTERM');
  } else {
    usedPorts.delete(w.port);
  }
}

let registryRef: Registry | null = null;

function sync(projects: Project[]) {
  const names = new Set(projects.map((p) => p.name));
  for (const [name, w] of workers) {
    if (!names.has(name)) {
      log.info(`[${name}] project removed, stopping PostgREST`);
      stop(w);
      workers.delete(name);
    }
  }
  for (const p of projects) {
    const existing = workers.get(p.name);
    const fp = fingerprint(p);
    if (existing && existing.fingerprint === fp) continue;
    if (existing) {
      log.info(`[${p.name}] configuration changed, restarting PostgREST`);
      stop(existing);
    }
    const port = allocatePort();
    const w: Worker = { project: p.name, port, adminPort: port + 1, fingerprint: fp, child: null, ready: false, restarts: 0, stopping: false };
    workers.set(p.name, w);
    start(p, w);
  }
}

export async function main(): Promise<void> {
  requireRolePassword('authenticator');
  const registry = new Registry('authenticator');
  registryRef = registry;
  registry.on('change', sync);
  await registry.start();
  sync(registry.list());

  process.on('exit', () => {
    for (const w of workers.values()) w.child?.kill('SIGTERM');
  });

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', 'http://local');
    if (url.pathname === '/health') {
      const status = [...workers.values()].map((w) => ({ project: w.project, ready: w.ready }));
      const body = JSON.stringify({ status: 'ok', workers: status });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(body);
      return;
    }
    const m = /^\/([a-z][a-z0-9-]*)(\/.*)?$/.exec(url.pathname);
    const w = m ? workers.get(m[1]) : undefined;
    if (!m || !w) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ message: 'Unknown project' }));
      return;
    }
    if (!w.ready) {
      res.writeHead(503, { 'Content-Type': 'application/json', 'Retry-After': '2' });
      res.end(JSON.stringify({ message: `The REST API for "${w.project}" is starting, try again in a moment.` }));
      return;
    }
    await proxyRequest(req, res, {
      target: `http://127.0.0.1:${w.port}`,
      path: (m[2] || '/') + url.search,
      headers: { 'x-keel-project': null },
    });
  });
  await new Promise<void>((r) => server.listen(config.ports.rest, '0.0.0.0', r));
  log.info(`keel-rest listening on port ${config.ports.rest}`);
}
