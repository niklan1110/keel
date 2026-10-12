import { spawn, type ChildProcess } from 'node:child_process';
import crypto from 'node:crypto';
import dns from 'node:dns';
import fs from 'node:fs/promises';
import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import type pg from 'pg';
import { config, requireRolePassword, requireSecret, serverOverrides } from '../lib/config.js';
import { newClient, pool } from '../lib/db.js';
import { bearer, sendJson } from '../lib/http.js';
import { verify } from '../lib/jwt.js';
import { log } from '../lib/log.js';
import { proxyRequest, proxyUpgrade, rejectUpgrade } from '../lib/proxy.js';
import { Registry, type Project } from '../lib/registry.js';
import { blockContains, defaultGateway, denyNetList, keepAllowed, parseAllowLan, parseBlock, serveGatewaySocket, type Block } from './sandbox.js';
import { FUNCTION_NAME_RE, RESERVED_SECRET_RE, safeRelPath } from './shared.js';

/**
 * keel-functions runs edge functions. Each deployed function gets its own
 * Deno process (started on the first request, stopped when idle) that serves
 * the function's Deno.serve() handler on a unix socket. Requests arrive from
 * keel-gateway as /<function>/<path> with the project in x-keel-project.
 */

type FnMeta = { project: string; name: string; entrypoint: string; verifyJwt: boolean; version: number; updatedAt: string };

type LogLine = { t: string; level: 'info' | 'error' | 'system'; msg: string };
type Invocation = { t: string; method: string; path: string; status: number; ms: number };

type Worker = {
  id: string;
  project: string;
  name: string;
  version: number;
  secretsHash: string;
  /** The API keys the worker got in its environment; rolling keys replaces the worker. */
  apiKeys: string;
  proc: ChildProcess;
  tmp: string;
  socket: string;
  ready: Promise<void>;
  state: 'starting' | 'ready' | 'stopping' | 'dead';
  inflight: number;
  startedAt: number;
  lastUsed: number;
};

const LOG_LIMIT = 1000;

const apiKeysOf = (p: Project) => `${p.anonKey} ${p.serviceKey}`;
const INVOCATION_LIMIT = 200;
const PASS_ENV = ['HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'no_proxy', 'DENO_CERT', 'DENO_TLS_CA_STORE', 'TZ'];

class Catalog {
  private fns = new Map<string, Map<string, FnMeta>>();
  private secrets = new Map<string, { values: Record<string, string>; hash: string }>();
  constructor(private db: pg.Pool) {}

  get(project: string, name: string): FnMeta | undefined {
    return this.fns.get(project)?.get(name);
  }
  list(project: string): FnMeta[] {
    return [...(this.fns.get(project)?.values() || [])];
  }
  secretsOf(project: string) {
    return this.secrets.get(project) || { values: {}, hash: '' };
  }

  async load(project?: string): Promise<void> {
    const where = project ? 'where project = $1' : '';
    const args = project ? [project] : [];
    const fns = await this.db.query(
      `select project, name, entrypoint, verify_jwt, version, updated_at from keel.functions ${where}`,
      args,
    );
    const secrets = await this.db.query(`select project, name, value from keel.function_secrets ${where} order by name`, args);
    if (project) {
      this.fns.delete(project);
      this.secrets.delete(project);
    } else {
      this.fns.clear();
      this.secrets.clear();
    }
    for (const r of fns.rows) {
      let m = this.fns.get(r.project);
      if (!m) this.fns.set(r.project, (m = new Map()));
      m.set(r.name, {
        project: r.project,
        name: r.name,
        entrypoint: r.entrypoint,
        verifyJwt: r.verify_jwt,
        version: r.version,
        updatedAt: new Date(r.updated_at).toISOString(),
      });
    }
    const grouped = new Map<string, Record<string, string>>();
    for (const r of secrets.rows) {
      const g = grouped.get(r.project) || {};
      g[r.name] = r.value;
      grouped.set(r.project, g);
    }
    for (const [p, values] of grouped) {
      this.secrets.set(p, { values, hash: crypto.createHash('sha256').update(JSON.stringify(values)).digest('hex') });
    }
  }
}

export async function main(): Promise<void> {
  requireRolePassword('keel_functions_admin');
  // Studio's token for the internal endpoints. This container never gets KEEL_SECRET.
  if (process.env.KEEL_FUNCTIONS_TOKEN) requireSecret('KEEL_FUNCTIONS_TOKEN', config.functionsToken);
  const registry = new Registry('keel_functions_admin');
  await registry.start();
  const db = pool(config.db.controlDb, 'keel_functions_admin', 4);
  const catalog = new Catalog(db);
  const codeRoot = path.join(config.functions.root, 'code');
  const denoDir = path.join(config.functions.root, 'cache');
  await fs.mkdir(codeRoot, { recursive: true });
  await fs.mkdir(denoDir, { recursive: true });
  const bootstrap = path.join(config.functions.runtime, 'bootstrap.js');
  const shim = path.join(config.functions.runtime, 'std_http_server.ts');
  const token = config.functionsToken;

  const workers = new Map<string, Worker>();
  const logs = new Map<string, LogLine[]>();
  const invocations = new Map<string, Invocation[]>();
  const keyOf = (project: string, name: string) => `${project}/${name}`;

  const record = (project: string, name: string, level: LogLine['level'], msg: string) => {
    const key = keyOf(project, name);
    let buf = logs.get(key);
    if (!buf) logs.set(key, (buf = []));
    buf.push({ t: new Date().toISOString(), level, msg: msg.length > 4000 ? msg.slice(0, 4000) + '…' : msg });
    if (buf.length > LOG_LIMIT) buf.splice(0, buf.length - LOG_LIMIT);
    (level === 'error' ? process.stderr : process.stdout).write(`${new Date().toISOString()} ${level === 'error' ? 'ERROR' : 'INFO '} [${key}] ${msg}\n`);
  };

  // ------------------------------------------------------------------ catalog sync
  const retireStale = (project?: string) => {
    for (const w of workers.values()) {
      if (project && w.project !== project) continue;
      const meta = catalog.get(w.project, w.name);
      const secrets = catalog.secretsOf(w.project);
      const p = registry.get(w.project);
      if (!meta || meta.version !== w.version || secrets.hash !== w.secretsHash) {
        stopWorker(w, !meta ? 'the function was deleted' : meta.version !== w.version ? 'a new version was deployed' : 'its secrets changed');
      } else if (p && apiKeysOf(p) !== w.apiKeys) {
        stopWorker(w, 'the API keys were rolled');
      }
    }
  };
  registry.on('change', () => retireStale());

  const listen = async () => {
    let delay = 1000;
    for (;;) {
      const c = newClient(config.db.controlDb, 'keel_functions_admin');
      try {
        await c.connect();
        c.on('notification', (n) => {
          catalog
            .load(n.payload || undefined)
            .then(() => retireStale(n.payload || undefined))
            .catch((err) => log.warn('function catalog reload failed', { error: err.message }));
        });
        await c.query('listen keel_functions');
        await catalog.load();
        retireStale();
        delay = 1000;
        await new Promise<void>((resolve) => {
          c.on('error', () => resolve());
          c.on('end', () => resolve());
        });
      } catch (err) {
        log.info('waiting for function catalog', { error: (err as Error).message });
      } finally {
        await c.end().catch(() => {});
      }
      await new Promise((r) => setTimeout(r, delay));
      delay = Math.min(delay * 2, 15_000);
    }
  };
  void listen();

  // ------------------------------------------------------------------ code on disk
  const versionDir = (project: string, name: string, version: number) => path.join(codeRoot, project, name, `v${version}`);

  /** Writes a function version to disk (once) and returns its directory and Deno flags. */
  const materialize = async (meta: FnMeta): Promise<{ dir: string; entry: string; flags: string[] }> => {
    const dir = versionDir(meta.project, meta.name, meta.version);
    const done = path.join(dir, '.keel-complete');
    const exists = await fs.stat(done).then(() => true, () => false);
    if (!exists) {
      const { rows } = await db.query('select files, entrypoint, version from keel.functions where project = $1 and name = $2', [meta.project, meta.name]);
      if (!rows[0] || rows[0].version !== meta.version) throw new Error('function changed while starting; retry');
      const files = rows[0].files as Record<string, string>;
      const staging = `${dir}.tmp-${crypto.randomBytes(4).toString('hex')}`;
      await fs.mkdir(staging, { recursive: true });
      for (const [rel, content] of Object.entries(files)) {
        const safe = safeRelPath(rel);
        if (!safe) throw new Error(`invalid file path ${JSON.stringify(rel)}`);
        const file = path.join(staging, safe);
        await fs.mkdir(path.dirname(file), { recursive: true });
        await fs.writeFile(file, content);
      }
      // Older Supabase examples import serve() from deno.land/std, which no
      // longer works on Deno 2. Point those imports at a small stand-in.
      const stdUrls = new Set<string>();
      for (const content of Object.values(files)) {
        for (const m of content.matchAll(/https:\/\/deno\.land\/std@[^/'"\s]+\/http\/server\.ts/g)) stdUrls.add(m[0]);
      }
      if (stdUrls.size) {
        await fs.mkdir(path.join(staging, '.keel'), { recursive: true });
        await fs.copyFile(shim, path.join(staging, '.keel', 'std_http_server.ts'));
        const imports = Object.fromEntries([...stdUrls].map((u) => [u, './std_http_server.ts']));
        await fs.writeFile(path.join(staging, '.keel', 'import_map.json'), JSON.stringify({ imports }, null, 2));
      }
      await fs.writeFile(path.join(staging, '.keel-complete'), new Date().toISOString());
      await fs.rm(dir, { recursive: true, force: true });
      await fs.rename(staging, dir);
      // Drop versions no running process uses any more.
      const parent = path.dirname(dir);
      const inUse = new Set([...workers.values()].filter((w) => w.project === meta.project && w.name === meta.name).map((w) => `v${w.version}`));
      for (const d of await fs.readdir(parent)) {
        if (d !== `v${meta.version}` && !inUse.has(d)) await fs.rm(path.join(parent, d), { recursive: true, force: true });
      }
    }
    const entry = safeRelPath(meta.entrypoint);
    if (!entry) throw new Error('invalid entrypoint');
    const fnDir = path.dirname(entry);
    const has = (rel: string) => fs.stat(path.join(dir, rel)).then(() => true, () => false);
    const flags: string[] = [];
    if (await has(path.join(fnDir, 'deno.json'))) flags.push(`--config=${path.join(dir, fnDir, 'deno.json')}`);
    else if (await has(path.join(fnDir, 'deno.jsonc'))) flags.push(`--config=${path.join(dir, fnDir, 'deno.jsonc')}`);
    else {
      flags.push('--no-config');
      if (await has(path.join(fnDir, 'import_map.json'))) flags.push(`--import-map=${path.join(dir, fnDir, 'import_map.json')}`);
      else if (await has('import_map.json')) flags.push(`--import-map=${path.join(dir, 'import_map.json')}`);
      else if (await has('.keel/import_map.json')) flags.push(`--import-map=${path.join(dir, '.keel/import_map.json')}`);
    }
    return { dir, entry: path.join(dir, entry), flags };
  };

  // ------------------------------------------------------------------ workers
  /**
   * What function code may not connect to: every private and special address
   * range (Keel's containers, the Docker host and its published ports, the
   * LAN, cloud metadata) plus single addresses that belong to this server
   * but may be public: this container's, the server's public address and
   * KEEL_FUNCTIONS_DENY_NET. See sandbox.ts. Function code reaches the API
   * through its gateway socket instead.
   */
  let denyCache: { at: number; list: string } | null = null;
  let warnedIpv6 = false;
  const denyNet = async (): Promise<string> => {
    if (denyCache && Date.now() - denyCache.at < 30_000) return denyCache.list;
    const hostname = (h: string) => (h.includes('://') ? new URL(h).hostname : h).replace(/^\[|\]$/g, '');
    const lookup = async (h: string) => (!h ? [] : net.isIP(h) ? [h] : (await dns.promises.lookup(h, { all: true }).catch(() => [])).map((a) => a.address));
    const own = Object.values(os.networkInterfaces())
      .flat()
      .filter((i) => i && !i.internal)
      .map((i) => i!.address);
    if (!warnedIpv6 && own.some((a) => net.isIPv6(a) && !/^fe80:/i.test(a))) {
      warnedIpv6 = true;
      log.warn('keel-functions has IPv6 addresses. Function code is kept from IPv6 addresses one by one, not by range: keep its network IPv4 only.', {
        addresses: own.filter((a) => net.isIPv6(a)),
      });
    }
    // Where this server can be reached when that address is public: the
    // Postgres host (set in Studio or KEEL_PUBLIC_DB_HOST, which is this
    // machine) and KEEL_PUBLIC_URL when it's an address rather than a name
    // (a name may point at a tunnel or CDN that other sites share).
    const envHost = hostname(config.envPublicUrl);
    const serverHosts = [serverOverrides().publicDbHost || process.env.KEEL_PUBLIC_DB_HOST || '', net.isIP(envHost) ? envHost : ''];
    // Keel's own services, in case one lives outside the private ranges.
    const services = [config.db.host, config.services.gateway, config.services.rest, config.services.auth, config.services.storage, config.services.realtime, config.services.imgproxy, 'keel-studio', 'keel-docker'].map(hostname);
    const extra = config.functions.denyNet.split(',').map((x) => x.trim()).filter(Boolean);
    const addrs = new Set<string>([...own, ...extra]);
    // Service names are looked up together with a short timeout: names on other Docker
    // networks don't resolve, and Docker Desktop takes seconds to say so for each.
    const quick = new dns.promises.Resolver({ timeout: 1000, tries: 1 });
    const resolveService = async (h: string) =>
      !h ? [] : net.isIP(h) ? [h] : (await Promise.all([quick.resolve4(h).catch(() => []), quick.resolve6(h).catch(() => [])])).flat();
    const found = await Promise.all([...serverHosts.map(lookup), ...services.map(resolveService)]);
    for (const ip of found.flat()) addrs.add(ip);
    // This server's LAN addresses stay closed even inside an allowed range.
    const list = denyNetList([...addrs, ...hostAddresses()], await allowedLan(addrs));
    denyCache = { at: Date.now(), list };
    return list;
  };

  /**
   * LAN addresses the owner opened to function code (KEEL_FUNCTIONS_ALLOW_LAN),
   * minus anything that must stay closed whatever the setting says: the
   * Docker host (this container's default gateway), the networks this
   * container is on (Keel's own) and the addresses in `closed` (Keel's
   * containers, this server's addresses, KEEL_FUNCTIONS_DENY_NET).
   */
  const warnedAllow = new Set<string>();
  const hostAddresses = () => config.functions.hostAddresses.split(',').map((x) => x.trim()).filter((x) => net.isIP(x));
  const allowedLan = async (closed: Set<string>): Promise<Block[]> => {
    if (!config.functions.allowLan.trim()) return [];
    const { allowed, refused } = parseAllowLan(config.functions.allowLan, { ranges: hostAddresses().length > 0 });
    const forbidden: Block[] = [];
    // In Docker, this container's networks are Keel's own; outside Docker the
    // interface's network is the LAN, and only this machine's addresses are kept closed.
    const inDocker = await fs.stat('/.dockerenv').then(() => true, () => false);
    for (const i of Object.values(os.networkInterfaces()).flat()) {
      if (i && !i.internal && i.family === 'IPv4' && i.cidr) forbidden.push(parseBlock(inDocker ? i.cidr : i.address)!);
    }
    const gw = defaultGateway(await fs.readFile('/proc/net/route', 'utf8').catch(() => ''));
    for (const ip of [...closed, ...(gw ? [gw] : [])]) {
      const b = net.isIPv4(ip) || ip.includes('/') ? parseBlock(ip) : null;
      if (b) forbidden.push(b);
    }
    const kept = keepAllowed(allowed, forbidden);
    const warnOnce = (key: string, msg: string, extra: Record<string, unknown>) => {
      if (warnedAllow.has(key)) return;
      warnedAllow.add(key);
      log.warn(msg, extra);
    };
    for (const r of [...refused, ...kept.refused]) warnOnce(`refused:${r.entry}`, 'KEEL_FUNCTIONS_ALLOW_LAN: entry ignored', { entry: r.entry, reason: r.reason });
    const hosts = hostAddresses().filter((ip) => net.isIPv4(ip));
    for (const a of kept.kept) {
      const inside = hosts.filter((ip) => blockContains(a.block, parseBlock(ip)!));
      if (inside.length) warnOnce(`host:${a.entry}`, "KEEL_FUNCTIONS_ALLOW_LAN: this server's own addresses stay closed inside an allowed range", { entry: a.entry, closed: inside });
      if (a.port !== undefined) {
        warnOnce(`port:${a.entry}`, 'KEEL_FUNCTIONS_ALLOW_LAN: functions can reach every port of an allowed address, not only the one given', { entry: a.entry });
      }
    }
    if (kept.kept.length) warnOnce(`on:${kept.kept.map((a) => a.entry).join(',')}`, 'function code may connect to these LAN addresses (KEEL_FUNCTIONS_ALLOW_LAN)', { allowed: kept.kept.map((a) => a.entry) });
    return kept.kept.map((a) => a.block);
  };

  // The origin function code sees in SUPABASE_URL. Requests to it go through
  // the function's gateway socket (bootstrap.js). Deno checks --deny-net
  // against the address a name resolves to even when the request goes through
  // that socket, so the name must never resolve: .invalid is reserved for
  // exactly that (RFC 6761), on every network.
  const gatewayOrigin = (() => {
    const u = new URL(config.services.gateway);
    u.hostname = 'keel-gateway.invalid';
    return u.origin;
  })();

  const workerEnv = (project: Project): Record<string, string> => {
    const env: Record<string, string> = {};
    for (const k of PASS_ENV) if (process.env[k]) env[k] = process.env[k]!;
    for (const [k, v] of Object.entries(catalog.secretsOf(project.name).values)) {
      if (!RESERVED_SECRET_RE.test(k)) env[k] = v;
    }
    Object.assign(env, {
      SUPABASE_URL: `${gatewayOrigin}/${project.name}`,
      SUPABASE_ANON_KEY: project.anonKey,
      SUPABASE_SERVICE_ROLE_KEY: project.serviceKey,
      KEEL_URL: `${gatewayOrigin}/${project.name}`,
      KEEL_PUBLIC_URL: `${config.publicUrl}/${project.name}`,
      KEEL_PROJECT: project.name,
      DENO_DIR: denoDir,
      DENO_NO_UPDATE_CHECK: '1',
      DENO_NO_PROMPT: '1',
      NO_COLOR: '1',
      PATH: '/usr/local/bin:/usr/bin:/bin',
    });
    return env;
  };

  const stopWorker = (w: Worker, reason: string) => {
    if (w.state === 'stopping' || w.state === 'dead') return;
    w.state = 'stopping';
    if (workers.get(keyOf(w.project, w.name)) === w) workers.delete(keyOf(w.project, w.name));
    record(w.project, w.name, 'system', `Stopping (${reason})`);
    const kill = () => {
      w.proc.kill('SIGTERM');
      setTimeout(() => w.proc.exitCode === null && w.proc.signalCode === null && w.proc.kill('SIGKILL'), 5000).unref();
    };
    if (w.inflight === 0) return kill();
    // Let requests in flight finish first.
    const deadline = Date.now() + config.functions.timeout * 1000;
    const wait = setInterval(() => {
      if (w.inflight === 0 || Date.now() > deadline) {
        clearInterval(wait);
        kill();
      }
    }, 250);
  };

  const evictForRoom = () => {
    const live = [...workers.values()];
    if (live.length < config.functions.maxWorkers) return;
    const idle = live.filter((w) => w.inflight === 0).sort((a, b) => a.lastUsed - b.lastUsed)[0];
    if (idle) stopWorker(idle, 'making room for another function');
  };

  const startWorker = async (meta: FnMeta, project: Project): Promise<Worker> => {
    evictForRoom();
    const code = await materialize(meta);
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'keel-fn-'));
    const socket = path.join(tmp, 'worker.sock');
    // The function's only way to Keel's API (see sandbox.ts).
    const gatewaySocket = path.join(tmp, 'gateway.sock');
    const gateway = await serveGatewaySocket(gatewaySocket, project.name, config.services.gateway, config.functions.timeout * 1000);
    const env = {
      ...workerEnv(project),
      HOME: tmp,
      TMPDIR: tmp,
      KEEL_WORKER_SOCKET: socket,
      KEEL_WORKER_ENTRY: `file://${code.entry}`,
      KEEL_GATEWAY_SOCKET: gatewaySocket,
      KEEL_GATEWAY_ORIGIN: gatewayOrigin,
    };
    // The same list closes imports: Deno's module loader checks only the
    // import permission, so --deny-net alone let `import('http://<lan>/x.json',
    // { with: { type: 'json' } })` read private addresses.
    const deny = await denyNet();
    const args = [
      'run',
      '--no-prompt',
      '--no-lock',
      ...code.flags,
      '--allow-net',
      `--deny-net=${deny}`,
      '--allow-env',
      '--allow-sys',
      '--allow-import',
      `--deny-import=${deny}`,
      // Downloaded packages only: Deno's gen/ folder holds other functions' compiled code.
      `--allow-read=${code.dir},${tmp},${path.join(denoDir, 'npm')},${path.join(denoDir, 'remote')}`,
      `--allow-write=${tmp}`,
      `--v8-flags=--max-old-space-size=${config.functions.memoryMb}`,
      bootstrap,
    ];
    const proc = spawn(config.functions.deno, args, { cwd: code.dir, env, stdio: ['ignore', 'pipe', 'pipe'] });
    const secrets = catalog.secretsOf(project.name);
    const w: Worker = {
      id: crypto.randomBytes(4).toString('hex'),
      project: meta.project,
      name: meta.name,
      version: meta.version,
      secretsHash: secrets.hash,
      apiKeys: apiKeysOf(project),
      proc,
      tmp,
      socket,
      ready: Promise.resolve(),
      state: 'starting',
      inflight: 0,
      startedAt: Date.now(),
      lastUsed: Date.now(),
    };
    const started = Date.now();
    w.ready = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`did not start within ${config.functions.bootTimeout}s`));
        stopWorker(w, 'boot timeout');
      }, config.functions.bootTimeout * 1000);
      readline.createInterface({ input: proc.stdout! }).on('line', (line) => {
        if (line === '__KEEL_READY__' && w.state === 'starting') {
          clearTimeout(timer);
          w.state = 'ready';
          record(w.project, w.name, 'system', `Booted v${w.version} in ${Date.now() - started}ms`);
          resolve();
          return;
        }
        record(w.project, w.name, 'info', line);
      });
      readline.createInterface({ input: proc.stderr! }).on('line', (line) => record(w.project, w.name, 'error', line));
      proc.on('error', (err) => {
        clearTimeout(timer);
        gateway.close();
        record(w.project, w.name, 'error', `Could not start Deno: ${err.message}`);
        reject(err);
      });
      proc.on('exit', (code, signal) => {
        clearTimeout(timer);
        gateway.close();
        const was = w.state;
        w.state = 'dead';
        if (workers.get(keyOf(w.project, w.name)) === w) workers.delete(keyOf(w.project, w.name));
        if (was !== 'stopping') record(w.project, w.name, 'system', `Exited (${signal || `code ${code}`})`);
        const why: Record<number, string> = { 71: 'the function never called Deno.serve()', 72: 'the function could not be loaded (see the error above)' };
        reject(new Error(why[code ?? -1] || `exited during boot (${signal || `code ${code}`})`));
        void fs.rm(tmp, { recursive: true, force: true });
      });
    });
    w.ready.catch(() => {});
    workers.set(keyOf(meta.project, meta.name), w);
    record(w.project, w.name, 'system', `Starting v${meta.version}`);
    return w;
  };

  const starting = new Map<string, Promise<Worker>>();
  const acquire = async (meta: FnMeta, project: Project): Promise<Worker> => {
    const key = keyOf(meta.project, meta.name);
    const secrets = catalog.secretsOf(project.name);
    const cur = workers.get(key);
    if (cur && cur.version === meta.version && cur.secretsHash === secrets.hash && cur.apiKeys === apiKeysOf(project) && (cur.state === 'ready' || cur.state === 'starting')) {
      await cur.ready;
      return cur;
    }
    if (cur) stopWorker(cur, 'outdated');
    let p = starting.get(key);
    if (!p) {
      p = startWorker(meta, project).finally(() => starting.delete(key));
      starting.set(key, p);
    }
    const w = await p;
    await w.ready;
    return w;
  };

  setInterval(() => {
    const cutoff = Date.now() - config.functions.idle * 1000;
    for (const w of workers.values()) if (w.inflight === 0 && w.lastUsed < cutoff) stopWorker(w, 'idle');
  }, 15_000).unref();

  process.on('exit', () => {
    for (const w of workers.values()) w.proc.kill('SIGKILL');
  });

  // ------------------------------------------------------------------ http
  const fnError = (res: ServerResponse, status: number, code: string | number, message: string) => sendJson(res, status, { code, message });

  type Resolved = { project: Project; meta: FnMeta; fnPath: string } | { status: number; code: string | number; message: string };

  // A function deployed a moment ago may not have reached the catalog yet
  // (it reloads on NOTIFY); check the database before answering 404.
  const recentMiss = new Map<string, number>();
  const lookup = async (project: string, name: string): Promise<FnMeta | undefined> => {
    const hit = catalog.get(project, name);
    if (hit || !FUNCTION_NAME_RE.test(name)) return hit;
    const key = keyOf(project, name);
    if (Date.now() - (recentMiss.get(key) || 0) < 2000) return undefined;
    recentMiss.set(key, Date.now());
    if (recentMiss.size > 10_000) recentMiss.clear();
    const { rowCount } = await db.query('select 1 from keel.functions where project = $1 and name = $2', [project, name]);
    if (!rowCount) return undefined;
    await catalog.load(project);
    return catalog.get(project, name);
  };

  const resolve = async (req: IncomingMessage): Promise<Resolved> => {
    const project = registry.get(String(req.headers['x-keel-project'] || ''));
    if (!project) return { status: 404, code: 'NOT_FOUND', message: 'Unknown project' };
    const url = new URL(req.url || '/', 'http://local');
    const m = /^\/([^/]+)(\/.*)?$/.exec(url.pathname);
    const name = m?.[1] || '';
    const meta = await lookup(project.name, name);
    if (!meta) return { status: 404, code: 'NOT_FOUND', message: 'Requested function was not found' };
    if (meta.verifyJwt) {
      const jwt = bearer(req);
      if (!jwt) return { status: 401, code: 401, message: 'Missing authorization header' };
      try {
        const claims = verify(jwt, project.jwtKeys);
        if (claims.ref && claims.ref !== project.name) throw new Error('wrong project');
      } catch {
        return { status: 401, code: 401, message: 'Invalid JWT' };
      }
    }
    return { project, meta, fnPath: url.pathname + url.search };
  };

  const internal = (req: IncomingMessage, res: ServerResponse) => {
    const given = Buffer.from(bearer(req) || '');
    const want = Buffer.from(token);
    if (given.length !== want.length || !crypto.timingSafeEqual(given, want)) return fnError(res, 401, 401, 'Unauthorized');
    const url = new URL(req.url || '/', 'http://local');
    const project = url.searchParams.get('project') || '';
    if (url.pathname === '/_keel/logs') {
      const name = url.searchParams.get('name') || '';
      return sendJson(res, 200, { logs: logs.get(keyOf(project, name)) || [], invocations: invocations.get(keyOf(project, name)) || [] });
    }
    if (url.pathname === '/_keel/status') {
      const out: Record<string, { state: string; version: number; since: string; inflight: number }> = {};
      for (const w of workers.values()) {
        if (w.project !== project) continue;
        out[w.name] = { state: w.state, version: w.version, since: new Date(w.startedAt).toISOString(), inflight: w.inflight };
      }
      return sendJson(res, 200, { workers: out });
    }
    if (url.pathname === '/_keel/forget' && req.method === 'POST') {
      // Called after a project or function is deleted.
      for (const k of [...logs.keys()]) if (k.startsWith(`${project}/`)) logs.delete(k);
      for (const k of [...invocations.keys()]) if (k.startsWith(`${project}/`)) invocations.delete(k);
      return sendJson(res, 200, {});
    }
    return fnError(res, 404, 404, 'Not found');
  };

  const server = http.createServer(async (req, res) => {
    const url = req.url || '/';
    if (url === '/health') return sendJson(res, 200, { status: 'ok', workers: workers.size });
    if (url.startsWith('/_keel/')) return internal(req, res);
    const r = await resolve(req);
    if ('status' in r) {
      req.resume();
      return fnError(res, r.status, r.code, r.message);
    }
    const { project, meta, fnPath } = r;
    const started = Date.now();
    let w: Worker;
    try {
      w = await acquire(meta, project);
    } catch (err) {
      record(meta.project, meta.name, 'error', `Boot failed: ${(err as Error).message}`);
      req.resume();
      return fnError(res, 503, 'BOOT_ERROR', 'Function failed to start (please check logs)');
    }
    w.inflight++;
    w.lastUsed = Date.now();
    res.on('close', () => {
      w.inflight--;
      w.lastUsed = Date.now();
      const key = keyOf(meta.project, meta.name);
      let buf = invocations.get(key);
      if (!buf) invocations.set(key, (buf = []));
      buf.push({ t: new Date(started).toISOString(), method: req.method || 'GET', path: fnPath.split('?')[0], status: res.statusCode, ms: Date.now() - started });
      if (buf.length > INVOCATION_LIMIT) buf.splice(0, buf.length - INVOCATION_LIMIT);
    });
    await proxyRequest(req, res, {
      target: 'http://localhost',
      socketPath: w.socket,
      path: fnPath,
      headers: { 'x-keel-project': null },
      timeoutMs: config.functions.timeout * 1000,
      errorBody: (status) =>
        status === 504
          ? { code: 'WORKER_TIMEOUT', message: `Function exceeded the ${config.functions.timeout}s time limit` }
          : { code: 'WORKER_ERROR', message: 'Function stopped before responding (please check logs)' },
    });
  });

  // WebSockets served by functions (Deno.upgradeWebSocket).
  server.on('upgrade', async (req, socket, head) => {
    const r = await resolve(req);
    if ('status' in r) return rejectUpgrade(socket, r.status, r.message);
    try {
      const w = await acquire(r.meta, r.project);
      w.inflight++;
      w.lastUsed = Date.now();
      socket.on('close', () => {
        w.inflight--;
        w.lastUsed = Date.now();
      });
      proxyUpgrade(req, socket, head, { target: 'http://localhost', socketPath: w.socket, path: r.fnPath, headers: { 'x-keel-project': null } });
    } catch {
      rejectUpgrade(socket, 503, 'Function failed to start');
    }
  });

  server.keepAliveTimeout = 65_000;
  await new Promise<void>((r) => server.listen(config.ports.functions, '0.0.0.0', r));
  const deno = await new Promise<string>((r) => {
    const p = spawn(config.functions.deno, ['--version'], { stdio: ['ignore', 'pipe', 'ignore'] });
    let out = '';
    p.stdout.on('data', (d) => (out += d));
    p.on('error', () => r('not found'));
    p.on('exit', () => r(out.split('\n')[0] || 'unknown'));
  });
  log.info(`keel-functions listening on port ${config.ports.functions}`, { deno });
}
