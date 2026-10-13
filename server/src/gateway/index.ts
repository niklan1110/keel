import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import { config, requireRolePassword } from '../lib/config.js';
import { gatewayForwarding, limitServer, trustedProxies } from '../lib/http.js';
import { JwtError, verify } from '../lib/jwt.js';
import { log } from '../lib/log.js';
import { proxyRequest, proxyUpgrade, rejectUpgrade } from '../lib/proxy.js';
import { Registry, type Project } from '../lib/registry.js';
import { isDocsPath, serveDocs } from '../lib/static.js';

/**
 * The public entry point. Every project is served under its own path prefix:
 *
 *   http://host:8000/<project>/rest/v1/...      -> PostgREST for that project
 *   http://host:8000/<project>/auth/v1/...      -> keel-auth
 *   http://host:8000/<project>/storage/v1/...   -> keel-storage
 *   http://host:8000/<project>/realtime/v1/...  -> keel-realtime (WebSocket)
 *   http://host:8000/<project>/functions/v1/... -> keel-functions (edge functions)
 *
 * So `createClient('http://host:8000/<project>', anonKey)` works with
 * @supabase/supabase-js and the other Supabase clients.
 */

const SERVICES = ['rest', 'auth', 'storage', 'realtime', 'functions'] as const;
type Service = (typeof SERVICES)[number];

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS, HEAD',
  'Access-Control-Expose-Headers':
    'Content-Range, Content-Location, Content-Length, Content-Type, Content-Disposition, Range-Unit, Preference-Applied, X-Total-Count, ETag, Location, Proxy-Status, X-Supabase-Api-Version, Sb-Gateway-Version, ' +
    'Upload-Offset, Upload-Length, Upload-Metadata, Upload-Expires, Tus-Resumable, Tus-Version, Tus-Max-Size, Tus-Extension, X-Relay-Error',
  'Access-Control-Max-Age': '86400',
};

/** Auth endpoints reachable without an API key (browser redirects land here), as on Supabase. */
const OPEN_AUTH = [/^\/verify$/, /^\/callback$/, /^\/authorize$/, /^\/\.well-known\//];

type Parsed = { project: string; service: Service; rest: string; search: string };

function parse(url: string | undefined): Parsed | null {
  const u = new URL(url || '/', 'http://local');
  const m = /^\/([a-z][a-z0-9-]*)\/(rest|auth|storage|realtime|functions)\/v1(\/.*)?$/.exec(u.pathname);
  if (!m) return null;
  return { project: m[1], service: m[2] as Service, rest: m[3] || '/', search: u.search };
}

/** PostgREST would read ?apikey= as a column filter; the gateway has already checked it. */
export function withoutApiKey(search: string): string {
  const parts = search.replace(/^\?/, '').split('&').filter((s) => s && !/^apikey(=|$)/.test(s));
  return parts.length ? `?${parts.join('&')}` : '';
}

function send(res: ServerResponse, status: number, body: unknown) {
  const data = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(data), ...CORS_HEADERS });
  res.end(data);
}

function apiKeyFrom(req: IncomingMessage): string | null {
  const h = req.headers['apikey'];
  if (typeof h === 'string' && h) return h;
  const q = new URL(req.url || '/', 'http://local').searchParams.get('apikey');
  return q || null;
}

/** Validates that the API key is this project's anon or service key. */
function checkApiKey(project: Project, key: string | null): { ok: true; role: string } | { ok: false; status: number; message: string } {
  if (!key) return { ok: false, status: 401, message: 'No API key found in request' };
  try {
    const claims = verify(key, project.jwtKeys);
    if (claims.ref && claims.ref !== project.name) return { ok: false, status: 401, message: 'Invalid API key' };
    const role = String(claims.role || '');
    if (role !== 'anon' && role !== 'service_role') {
      return { ok: false, status: 401, message: 'Invalid API key' };
    }
    return { ok: true, role };
  } catch (err) {
    return { ok: false, status: 401, message: err instanceof JwtError && /expired/.test(err.message) ? 'API key has expired' : 'Invalid API key' };
  }
}

/** Gateway path for a function call: /<function>/<rest>. Names never start with "_" (internal endpoints). */
const FUNCTION_PATH_RE = /^\/[A-Za-z][A-Za-z0-9_-]{0,62}(\/|$)/;

function needsKey(p: Parsed, method: string): boolean {
  if (p.service === 'storage') return false; // storage verifies tokens itself so public URLs work
  if (p.service === 'functions') return false; // keel-functions checks the JWT unless verify_jwt is off (webhooks)
  if (p.service === 'auth') return !OPEN_AUTH.some((re) => re.test(p.rest));
  return true;
}

/**
 * The answer for a project that doesn't exist: the same one a wrong API key
 * gets, so project names can't be discovered by trying them.
 */
function unknownProject(p: Parsed, method: string, key: string | null): { status: number; message: string } {
  if (!needsKey(p, method)) return { status: 404, message: 'Not found' };
  return { status: 401, message: key ? 'Invalid API key' : 'No API key found in request' };
}

/**
 * Storage's routes as keel-storage matches them, longest first, with the
 * methods they answer: after the words comes a bucket, then an object name.
 * A bucket named like a route word ("public") is then only read as one where
 * storage would too.
 */
const STORAGE_ROUTES: [methods: string[] | null, words: string[]][] = [
  [['POST', 'PUT'], ['object', 'upload', 'sign']],
  [['GET', 'HEAD'], ['object', 'info', 'public']],
  [['GET', 'HEAD'], ['object', 'info', 'authenticated']],
  [['GET', 'HEAD'], ['object', 'info']],
  [['GET', 'HEAD'], ['object', 'public']],
  [['GET', 'HEAD'], ['object', 'authenticated']],
  [['GET', 'HEAD', 'POST'], ['object', 'sign']],
  [['POST'], ['object', 'list']],
  [['POST'], ['object', 'move']],
  [['POST'], ['object', 'copy']],
  [['GET', 'HEAD'], ['render', 'image', 'public']],
  [['GET', 'HEAD'], ['render', 'image', 'authenticated']],
  [['GET', 'HEAD'], ['render', 'image', 'sign']],
  [null, ['upload', 'resumable']],
  [null, ['object']],
  [null, ['bucket']],
];
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The request path as written to the log: the route, not the values in it.
 * Storage object names hold user IDs and file names, function paths and
 * auth admin routes hold IDs, so those parts become "*" and ":id". Without
 * a method, storage routes for any method are considered.
 */
export function routeShape(url: string, method?: string): string {
  const p = parse(url);
  if (!p) {
    const [, first = '', ...more] = new URL(url || '/', 'http://local').pathname.split('/');
    return `/${/^([a-z][a-z0-9-]{0,62})?$/.test(first) ? first : '*'}${more.length ? '/*' : ''}`;
  }
  const segs = p.rest.split('/').filter(Boolean);
  const out: string[] = [];
  if (p.service === 'storage') {
    const m = method?.toUpperCase();
    const route = STORAGE_ROUTES.find(([methods, words]) => (!m || !methods || methods.includes(m)) && words.every((w, i) => segs[i] === w));
    if (!route) out.push('*');
    else {
      const words = route[1];
      out.push(...words);
      const next = segs[words.length];
      if (next !== undefined) out.push(words[words.length - 1] === 'resumable' || UUID_RE.test(next) ? ':id' : next);
      if (segs.length > words.length + 1) out.push('*');
    }
  } else if (p.service === 'functions') {
    if (segs.length) out.push(segs[0]);
    if (segs.length > 1) out.push('*');
  } else {
    for (const seg of segs) out.push(UUID_RE.test(seg) ? ':id' : seg);
  }
  return `/${p.project}/${p.service}/v1/${out.join('/')}`;
}

const dropCors = (name: string) => name.startsWith('access-control-');

export async function main(): Promise<void> {
  requireRolePassword('authenticator');
  const registry = new Registry('authenticator');
  await registry.start();
  trustedProxies();

  const server = http.createServer(async (req, res) => {
    const started = Date.now();
    const method = req.method || 'GET';
    res.on('finish', () => {
      if (req.url === '/health' || isDocsPath((req.url || '').split('?')[0])) return;
      const path = config.logPii ? (req.url || '').split('?')[0] : routeShape(req.url || '/', req.method);
      log.info(`${method} ${path} ${res.statusCode} ${Date.now() - started}ms`);
    });

    if (method === 'OPTIONS') {
      res.writeHead(204, {
        ...CORS_HEADERS,
        'Access-Control-Allow-Headers': String(req.headers['access-control-request-headers'] || 'authorization, apikey, content-type, x-client-info'),
      });
      res.end();
      return;
    }

    if (req.url === '/health') return send(res, 200, { status: 'ok' });
    if (req.url === '/' || req.url === '') {
      // Browsers get the documentation; API clients a short description.
      // No project list here: the gateway is public and project names are the caller's business.
      if (config.gatewayDocs && /text\/html/.test(String(req.headers.accept || ''))) {
        res.writeHead(302, { Location: '/docs/', 'Cache-Control': 'no-cache' });
        return void res.end();
      }
      return send(res, 200, { name: 'keel', ...(config.gatewayDocs ? { docs: '/docs/' } : {}), apis: '/<project>/{rest,auth,storage,realtime,functions}/v1' });
    }

    const p = parse(req.url);
    // The documentation is served here too, so it's online wherever the API is.
    // (A project that happens to be called "docs" keeps working.)
    const pathname = new URL(req.url || '/', 'http://local').pathname;
    if (config.gatewayDocs && isDocsPath(pathname) && !(p && registry.get(p.project))) return serveDocs(req, res, pathname);
    if (!p) return send(res, 404, { message: 'Not found. Project APIs live at /<project>/{rest,auth,storage,realtime,functions}/v1' });
    const project = registry.get(p.project);
    const key = apiKeyFrom(req);
    if (!project) {
      const u = unknownProject(p, method, key);
      return send(res, u.status, { message: u.message });
    }

    if (needsKey(p, method)) {
      const check = checkApiKey(project, key);
      if (!check.ok) return send(res, check.status, { message: check.message });
    }

    const headers: Record<string, string | null> = { 'x-keel-project': project.name, ...gatewayForwarding(req) };
    let target: string;
    let path: string;
    switch (p.service) {
      case 'rest':
        target = config.services.rest;
        path = `/${project.name}${p.rest}${withoutApiKey(p.search)}`;
        if (!req.headers.authorization && key) headers['authorization'] = `Bearer ${key}`;
        break;
      case 'auth':
        target = config.services.auth;
        path = `${p.rest}${p.search}`;
        break;
      case 'storage':
        target = config.services.storage;
        path = `${p.rest}${p.search}`;
        break;
      case 'realtime':
        target = config.services.realtime;
        path = `${p.rest}${p.search}`;
        break;
      case 'functions':
        if (!FUNCTION_PATH_RE.test(p.rest)) return send(res, 404, { code: 'NOT_FOUND', message: 'Requested function was not found' });
        // Functions set their own CORS headers; fill in permissive ones only when they don't.
        return proxyRequest(req, res, {
          target: config.services.functions,
          path: `${p.rest}${p.search}`,
          headers,
          defaultResponseHeaders: CORS_HEADERS,
          errorBody: () => ({ code: 'BOOT_ERROR', message: 'Edge functions are not running (keel-functions is unreachable)' }),
        });
    }
    await proxyRequest(req, res, { target, path, headers, dropResponseHeaders: dropCors, responseHeaders: CORS_HEADERS });
  });

  server.on('upgrade', (req, socket, head) => {
    const p = parse(req.url);
    if (!p || (p.service !== 'realtime' && p.service !== 'functions')) return rejectUpgrade(socket, 404, 'not found');
    const project = registry.get(p.project);
    if (!project) {
      const u = unknownProject(p, req.method || 'GET', apiKeyFrom(req));
      return rejectUpgrade(socket, u.status, u.message);
    }
    if (p.service === 'functions') {
      if (!FUNCTION_PATH_RE.test(p.rest)) return rejectUpgrade(socket, 404, 'function not found');
      return proxyUpgrade(req, socket, head, {
        target: config.services.functions,
        path: `${p.rest}${p.search}`,
        headers: { 'x-keel-project': project.name, ...gatewayForwarding(req) },
      });
    }
    const check = checkApiKey(project, apiKeyFrom(req));
    if (!check.ok) return rejectUpgrade(socket, check.status, check.message);
    log.info(`WS ${p.rest} ${project.name}`);
    proxyUpgrade(req, socket, head, {
      target: config.services.realtime,
      path: `${p.rest}${p.search}`,
      headers: { 'x-keel-project': project.name, ...gatewayForwarding(req) },
    });
  });

  server.keepAliveTimeout = 65_000;
  // Large uploads and long function calls can take longer than Node's default
  // 5-minute request limit; the services behind the gateway set their own limits.
  // A body that stops arriving is closed, though, and so are connection floods.
  server.requestTimeout = 0;
  limitServer(server, 'keel-gateway', { bodyIdleMs: config.limits.bodyIdleTimeout * 1000, connectionsPerIp: config.limits.connectionsPerIp });
  await new Promise<void>((r) => server.listen(config.ports.gateway, '0.0.0.0', r));
  log.info(`keel-gateway listening on port ${config.ports.gateway}`, { public_url: config.publicUrl });
}
