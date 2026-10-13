import { config } from '../lib/config.js';
import { pool } from '../lib/db.js';
import { sendJson, type Req, type Res, type Router } from '../lib/http.js';
import type { Project } from '../lib/registry.js';

type Deps = {
  authed: (fn: (req: Req, res: Res) => unknown) => (req: Req, res: Res) => unknown;
  project: (req: Req) => Project;
};

/** Studio's view of a project's scheduled jobs (cron) and recent outgoing requests (net). */
export function registerJobRoutes(router: Router, { authed, project }: Deps): void {
  const db = (p: Project) => pool(p.dbName, config.db.superuser, 6);

  router.get(
    '/api/projects/:p/cron',
    authed(async (req, res) => {
      const p = project(req);
      const jobs = await db(p).query(
        `select j.jobid::text as jobid, j.jobname, j.schedule, j.command, j.username, j.active,
                r.status as last_status, r.start_time as last_start, r.end_time as last_end, r.return_message as last_message
           from cron.job j
           left join lateral (select status, start_time, end_time, return_message from cron.job_run_details d
                               where d.jobid = j.jobid order by start_time desc limit 1) r on true
          order by j.jobid`,
      );
      const runs = await db(p).query(
        `select runid::text as runid, jobid::text as jobid, status, left(return_message, 500) as return_message, start_time, end_time
           from cron.job_run_details order by start_time desc limit 100`,
      );
      sendJson(res, 200, { jobs: jobs.rows, runs: runs.rows, timeoutSeconds: config.cron.timeout, historyDays: config.cron.historyDays });
    }),
  );

  router.get(
    '/api/projects/:p/net',
    authed(async (req, res) => {
      const p = project(req);
      const queued = await db(p).query('select count(*)::int as n from net.http_request_queue');
      const responses = await db(p).query(
        `select id::text as id, status_code, content_type, left(content, 500) as content, timed_out, error_msg, created
           from net._http_response order by created desc limit 50`,
      );
      sendJson(res, 200, { queued: queued.rows[0].n, responses: responses.rows, ttlHours: config.net.ttlHours });
    }),
  );
}
