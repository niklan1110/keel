import crypto from 'node:crypto';
import { config } from '../lib/config.js';
import { newClient } from '../lib/db.js';
import { HttpError, readJson, sendJson, type Req, type Res, type Router } from '../lib/http.js';
import type { Project } from '../lib/registry.js';
import { FUNCTION_NAME_RE, RESERVED_SECRET_RE, SECRET_NAME_RE, deployFunction, validateBundle } from '../functions/shared.js';

type Deps = {
  authed: (fn: (req: Req, res: Res) => unknown) => (req: Req, res: Res) => unknown;
  project: (req: Req) => Project;
};

const bad = (msg: string) => new HttpError(400, msg, 'bad_request');

async function control<T>(fn: (c: ReturnType<typeof newClient>) => Promise<T>): Promise<T> {
  const c = newClient(config.db.controlDb);
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end();
  }
}

/** Asks keel-functions (internal API) for logs or worker status. Empty when it isn't running. */
async function internal(path: string): Promise<any> {
  try {
    const res = await fetch(`${config.services.functions}${path}`, {
      headers: { Authorization: `Bearer ${config.functionsToken}` },
      signal: AbortSignal.timeout(4000),
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

const fnName = (req: Req) => {
  const n = req.params.name;
  if (!FUNCTION_NAME_RE.test(n)) throw new HttpError(404, 'Function not found', 'not_found');
  return n;
};

export function registerFunctionRoutes(router: Router, { authed, project }: Deps): void {
  router.get(
    '/api/projects/:p/functions',
    authed(async (req, res) => {
      const p = project(req);
      const { rows } = await control((c) =>
        c.query(
          `select name, entrypoint, verify_jwt, version, created_at, updated_at,
                  (select count(*) from jsonb_object_keys(files))::int as file_count,
                  octet_length(files::text)::int as size
             from keel.functions where project = $1 order by name`,
          [p.name],
        ),
      );
      const status = await internal(`/_keel/status?project=${encodeURIComponent(p.name)}`);
      sendJson(res, 200, {
        runtime: status ? 'running' : 'unreachable',
        baseUrl: `${config.publicUrl}/${p.name}/functions/v1`,
        functions: rows.map((r) => ({
          name: r.name,
          entrypoint: r.entrypoint,
          verifyJwt: r.verify_jwt,
          version: r.version,
          createdAt: r.created_at,
          updatedAt: r.updated_at,
          files: r.file_count,
          sizeBytes: r.size,
          worker: status?.workers?.[r.name] || null,
        })),
      });
    }),
  );

  router.get(
    '/api/projects/:p/functions/:name',
    authed(async (req, res) => {
      const p = project(req);
      const { rows } = await control((c) => c.query('select * from keel.functions where project = $1 and name = $2', [p.name, fnName(req)]));
      if (!rows[0]) throw new HttpError(404, 'Function not found', 'not_found');
      const r = rows[0];
      sendJson(res, 200, { name: r.name, entrypoint: r.entrypoint, verifyJwt: r.verify_jwt, version: r.version, files: r.files, updatedAt: r.updated_at });
    }),
  );

  router.put(
    '/api/projects/:p/functions/:name',
    authed(async (req, res) => {
      const p = project(req);
      const name = fnName(req);
      const body = await readJson(req, 25 * 1024 * 1024);
      let bundle;
      try {
        bundle = validateBundle(name, body);
      } catch (err) {
        const e = err as Error & { status?: number };
        throw new HttpError(e.status || 400, e.message, 'invalid_function');
      }
      const version = await deployFunction(p.name, name, bundle);
      sendJson(res, 200, { name, version });
    }),
  );

  router.patch(
    '/api/projects/:p/functions/:name',
    authed(async (req, res) => {
      const p = project(req);
      const body = await readJson(req);
      if (typeof body.verify_jwt !== 'boolean') throw bad('verify_jwt must be true or false');
      const r = await control((c) =>
        c.query('update keel.functions set verify_jwt = $3, updated_at = now() where project = $1 and name = $2', [p.name, fnName(req), body.verify_jwt]),
      );
      if (!r.rowCount) throw new HttpError(404, 'Function not found', 'not_found');
      sendJson(res, 200, { verifyJwt: body.verify_jwt });
    }),
  );

  router.delete(
    '/api/projects/:p/functions/:name',
    authed(async (req, res) => {
      const p = project(req);
      const r = await control((c) => c.query('delete from keel.functions where project = $1 and name = $2', [p.name, fnName(req)]));
      if (!r.rowCount) throw new HttpError(404, 'Function not found', 'not_found');
      sendJson(res, 200, {});
    }),
  );

  router.get(
    '/api/projects/:p/functions/:name/logs',
    authed(async (req, res) => {
      const p = project(req);
      const data = await internal(`/_keel/logs?project=${encodeURIComponent(p.name)}&name=${encodeURIComponent(fnName(req))}`);
      sendJson(res, 200, data || { logs: [], invocations: [], unreachable: true });
    }),
  );

  /** Test runner: calls the function through the gateway, like an app would. */
  router.post(
    '/api/projects/:p/functions/:name/invoke',
    authed(async (req, res) => {
      const p = project(req);
      const name = fnName(req);
      const body = await readJson(req, 2 * 1024 * 1024);
      const method = String(body.method || 'POST').toUpperCase();
      if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) throw bad('Unsupported method');
      const sub = String(body.path || '');
      if (sub && !/^\/[^\s#]*$/.test(sub)) throw bad('Path must start with /');
      const key = body.role === 'service_role' ? p.serviceKey : p.anonKey;
      const headers: Record<string, string> = { Authorization: `Bearer ${key}`, apikey: p.anonKey };
      if (body.headers && typeof body.headers === 'object') {
        for (const [k, v] of Object.entries(body.headers as Record<string, unknown>)) {
          if (/^[A-Za-z0-9-]+$/.test(k) && typeof v === 'string') headers[k] = v;
        }
      }
      const payload = method === 'GET' || method === 'DELETE' ? undefined : typeof body.body === 'string' ? body.body : '';
      if (payload && !Object.keys(headers).some((h) => h.toLowerCase() === 'content-type')) headers['Content-Type'] = 'application/json';
      const started = Date.now();
      let r: Response;
      try {
        r = await fetch(`${config.services.gateway}/${p.name}/functions/v1/${name}${sub}`, {
          method,
          headers,
          body: payload,
          signal: AbortSignal.timeout((config.functions.timeout + 5) * 1000),
        });
      } catch (err) {
        throw new HttpError(502, `Could not reach the function: ${(err as Error).message}`, 'invoke_failed');
      }
      const buf = Buffer.from(await r.arrayBuffer());
      const limit = 256 * 1024;
      sendJson(res, 200, {
        status: r.status,
        ms: Date.now() - started,
        headers: Object.fromEntries([...r.headers.entries()].filter(([k]) => !k.startsWith('access-control-'))),
        body: buf.subarray(0, limit).toString('utf8'),
        truncated: buf.length > limit,
      });
    }),
  );

  // ------------------------------------------------------------ secrets
  router.get(
    '/api/projects/:p/secrets',
    authed(async (req, res) => {
      const p = project(req);
      const { rows } = await control((c) => c.query('select name, value, updated_at from keel.function_secrets where project = $1 order by name', [p.name]));
      // Values are never sent back; a digest lets people check which value is set.
      sendJson(
        res,
        200,
        rows.map((r) => ({ name: r.name, digest: crypto.createHash('sha256').update(r.value).digest('hex').slice(0, 12), updatedAt: r.updated_at })),
      );
    }),
  );

  router.put(
    '/api/projects/:p/secrets',
    authed(async (req, res) => {
      const p = project(req);
      const body = await readJson(req);
      const entries = Object.entries((body.secrets || {}) as Record<string, unknown>);
      if (!entries.length) throw bad('Send { "secrets": { "NAME": "value" } }');
      for (const [k, v] of entries) {
        if (!SECRET_NAME_RE.test(k)) throw bad(`Invalid secret name "${k}". Use letters, digits and underscores.`);
        if (RESERVED_SECRET_RE.test(k)) throw bad(`${k} is set by Keel and can't be overridden.`);
        if (typeof v !== 'string' || v.length > 64 * 1024) throw bad(`Value for ${k} must be text up to 64 KB`);
      }
      await control(async (c) => {
        await c.query('begin');
        try {
          for (const [k, v] of entries) {
            await c.query(
              `insert into keel.function_secrets (project, name, value) values ($1, $2, $3)
               on conflict (project, name) do update set value = excluded.value, updated_at = now()`,
              [p.name, k, v],
            );
          }
          await c.query('commit');
        } catch (err) {
          await c.query('rollback');
          throw err;
        }
      });
      sendJson(res, 200, { updated: entries.map(([k]) => k) });
    }),
  );

  router.delete(
    '/api/projects/:p/secrets/:name',
    authed(async (req, res) => {
      const p = project(req);
      await control((c) => c.query('delete from keel.function_secrets where project = $1 and name = $2', [p.name, req.params.name]));
      sendJson(res, 200, {});
    }),
  );
}
