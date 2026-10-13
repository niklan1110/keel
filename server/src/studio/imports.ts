import { HttpError, readJson, sendJson, type Req, type Res, type Router } from '../lib/http.js';
import { log } from '../lib/log.js';
import type { Project } from '../lib/registry.js';
import { importFromSupabase, redactUrl, type ImportResult } from '../importer/supabase.js';

type Job = {
  status: 'running' | 'done' | 'failed';
  startedAt: string;
  finishedAt: string | null;
  source: string;
  lines: { t: string; level: 'info' | 'warn' | 'error'; msg: string }[];
  result: ImportResult | null;
  error: string | null;
};

type Deps = {
  authed: (fn: (req: Req, res: Res) => unknown) => (req: Req, res: Res) => unknown;
  project: (req: Req) => Project;
};

const jobs = new Map<string, Job>();

/** Studio API for "Import from Supabase": one background job per project. */
export function registerImportRoutes(router: Router, { authed, project }: Deps): void {
  router.get(
    '/api/projects/:p/import',
    authed((req, res) => sendJson(res, 200, jobs.get(project(req).name) || null)),
  );

  router.post(
    '/api/projects/:p/import',
    authed(async (req, res) => {
      const p = project(req);
      if (jobs.get(p.name)?.status === 'running') throw new HttpError(409, 'An import is already running for this project', 'busy');
      const body = await readJson(req);
      const dbUrl = String(body.dbUrl || '').trim();
      if (!/^postgres(ql)?:\/\//.test(dbUrl)) throw new HttpError(400, 'Paste the Postgres connection string (postgresql://…)', 'bad_request');
      const apiUrl = String(body.apiUrl || '').trim();
      if (apiUrl && !/^https?:\/\//.test(apiUrl)) throw new HttpError(400, 'Project URL must start with https://', 'bad_request');
      const job: Job = { status: 'running', startedAt: new Date().toISOString(), finishedAt: null, source: redactUrl(dbUrl), lines: [], result: null, error: null };
      jobs.set(p.name, job);
      const push = (msg: string, level: 'info' | 'warn' | 'error' = 'info') => {
        job.lines.push({ t: new Date().toISOString(), level, msg });
        if (job.lines.length > 2000) job.lines.splice(0, job.lines.length - 2000);
        (level === 'info' ? log.info : log.warn)(`import ${p.name}: ${msg}`);
      };
      void importFromSupabase({
        project: p,
        dbUrl,
        apiUrl: apiUrl || undefined,
        serviceKey: String(body.serviceKey || '').trim() || undefined,
        schema: body.schema !== false,
        auth: body.auth !== false,
        storage: body.storage !== false,
        log: push,
      }).then(
        (r) => {
          job.status = 'done';
          job.result = r;
          job.finishedAt = new Date().toISOString();
        },
        (err) => {
          job.status = 'failed';
          job.error = (err as Error).message;
          push((err as Error).message, 'error');
          job.finishedAt = new Date().toISOString();
        },
      );
      sendJson(res, 202, job);
    }),
  );
}
