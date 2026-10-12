import pg from 'pg';
import { config } from '../lib/config.js';
import { matchesMinute, parseSchedule, type CronSchedule } from '../lib/cron.js';
import { pool } from '../lib/db.js';
import { log } from '../lib/log.js';
import { ownerRoleFor, type Project } from '../lib/registry.js';

/**
 * Runs every project's scheduled jobs (cron.job), the work pg_cron's
 * background worker does on Supabase (see sql/project/013_cron_and_net.sql).
 * Queued HTTP requests (net.http_*) are sent by keel-egress instead.
 *
 * A job runs on a connection of its own, logged in as the project's owner
 * role (pg_cron runs a job as its user): never as a superuser, so a job's
 * SQL can't reset its way to more rights. Runs are recorded in
 * cron.job_run_details. Commands are never written to the logs: they may
 * hold the project's secrets.
 */

type Job = { jobid: string; schedule: string; username: string; parsed: CronSchedule | null };

type ProjectState = {
  jobs: Job[];
  loadedAt: number;
  /** Jobs running now: one run of a job at a time. */
  running: Set<string>;
  /** When each "N seconds" job last started. */
  lastStart: Map<string, number>;
  recovered: boolean;
  /** A tick of this project is under way (each project ticks on its own). */
  busy: boolean;
  /** The minute this project's five-field jobs were last checked for. */
  minute: number;
  cleanedAt: number;
};

const RELOAD_MS = 5_000;
/** Active jobs loaded per project; more are left out (and a warning logged). */
export const MAX_JOBS = 1000;
const CLEANUP_MS = 60_000;

/**
 * The jobs due now: five-field jobs whose schedule matches the current minute
 * (once, when the minute starts) and "N seconds" jobs whose interval has
 * passed since they last started. A job still running is skipped, as is
 * anything past the project's limit of jobs running at once.
 */
export function dueJobs(jobs: Job[], s: Pick<ProjectState, 'running' | 'lastStart'>, now: number, newMinute: boolean, maxRunning: number): Job[] {
  const due: Job[] = [];
  let room = maxRunning - s.running.size;
  for (const j of jobs) {
    if (!j.parsed || s.running.has(j.jobid)) continue;
    let fire = false;
    if (j.parsed.kind === 'seconds') {
      const last = s.lastStart.get(j.jobid);
      if (last === undefined) s.lastStart.set(j.jobid, now);
      else fire = now - last >= j.parsed.seconds * 1000 - 200;
    } else {
      fire = newMinute && matchesMinute(j.parsed, new Date(now));
    }
    if (!fire) continue;
    if (room <= 0) break;
    room--;
    due.push(j);
  }
  return due;
}

/** "SELECT 1"-style message for a finished command, as pg_cron records it. */
export function resultMessage(result: pg.QueryResult | pg.QueryResult[]): string {
  const last = Array.isArray(result) ? result[result.length - 1] : result;
  if (!last?.command) return '';
  if (last.command === 'SELECT') return `${last.rowCount ?? 0} row${last.rowCount === 1 ? '' : 's'}`;
  if (last.command === 'INSERT') return `INSERT 0 ${last.rowCount ?? 0}`;
  return last.rowCount === null || last.rowCount === undefined ? last.command : `${last.command} ${last.rowCount}`;
}

/**
 * Runs a job's command, keeping each statement's command tag and row count
 * but not its rows: a job's result is never shown, and a big one would
 * otherwise sit in keel-studio's memory.
 */
function runDiscardingRows(c: pg.Client, text: string): Promise<pg.QueryResult | pg.QueryResult[]> {
  return new Promise((resolve, reject) => {
    const q = new pg.Query(text);
    // With a 'row' listener and no callback, pg doesn't keep the rows.
    q.on('row', () => {});
    q.on('end', (result: pg.QueryResult | pg.QueryResult[]) => resolve(result));
    q.on('error', reject);
    c.query(q);
  });
}

const cut = (s: string, n = 4000) => (s.length > n ? s.slice(0, n) + '…' : s);

export function startScheduler(listProjects: () => Project[]): void {
  const states = new Map<string, ProjectState>();
  // A pool of its own, apart from the one Studio's pages use, with time
  // limits: the owner role can lock cron's tables, and a project whose
  // tables are locked must not hold connections Studio needs.
  const su = (p: Project) => pool(p.dbName, config.db.superuser, 3, { name: 'scheduler', statementTimeoutMs: 15_000, lockTimeoutMs: 5_000 });
  const control = pool(config.db.controlDb, config.db.superuser, 2);
  const warned = new Map<string, number>();
  /** At most one warning a minute per kind and project. */
  const warn = (key: string, msg: string, extra: Record<string, unknown>) => {
    if (Date.now() - (warned.get(key) || 0) < 60_000) return;
    warned.set(key, Date.now());
    log.warn(msg, extra);
  };

  const stateOf = (p: Project) => {
    let s = states.get(p.name);
    if (!s) {
      s = { jobs: [], loadedAt: 0, running: new Set(), lastStart: new Map(), recovered: false, busy: false, minute: Math.floor(Date.now() / 60_000), cleanedAt: 0 };
      states.set(p.name, s);
    }
    return s;
  };

  // ------------------------------------------------------------ cron
  const loadJobs = async (p: Project, s: ProjectState) => {
    if (!s.recovered) {
      // Runs that were going when Studio stopped will never finish.
      await su(p).query(
        `update cron.job_run_details set status = 'failed', return_message = 'job was stopped by a restart of keel-studio', end_time = now()
          where status in ('starting', 'running')`,
      );
      s.recovered = true;
    }
    const { rows } = await su(p).query(
      `select jobid::text, schedule, username from cron.job where active and database = current_database() order by jobid limit $1`,
      [MAX_JOBS + 1],
    );
    if (rows.length > MAX_JOBS) {
      rows.length = MAX_JOBS;
      warn(`jobs:${p.name}`, `more than ${MAX_JOBS} active cron jobs: only the first ${MAX_JOBS} run`, { project: p.name });
    }
    s.jobs = rows.map((r) => {
      let parsed: CronSchedule | null = null;
      try {
        parsed = parseSchedule(r.schedule);
      } catch {
        // cron.schedule() checks the schedule; one written into the table by hand is skipped.
      }
      return { ...r, parsed };
    });
    const ids = new Set(s.jobs.map((j) => j.jobid));
    for (const id of s.lastStart.keys()) if (!ids.has(id)) s.lastStart.delete(id);
    s.loadedAt = Date.now();
  };

  const ownerPassword = async (p: Project): Promise<string | null> => {
    const { rows } = await control.query('select password from keel.project_owners where project = $1', [p.name]);
    return rows[0]?.password ?? null;
  };

  const runJob = async (p: Project, s: ProjectState, job: Job) => {
    s.running.add(job.jobid);
    s.lastStart.set(job.jobid, Date.now());
    const db = su(p);
    const owner = ownerRoleFor(p.dbName);
    let runid: string | null = null;
    const finish = async (status: 'succeeded' | 'failed', message: string) => {
      if (runid) {
        await db
          .query(`update cron.job_run_details set status = $2, return_message = $3, end_time = now() where runid = $1`, [runid, status, cut(message)])
          .catch((err) => warn(`record:${p.name}`, 'could not record a cron run', { project: p.name, error: err.message }));
      }
    };
    try {
      // The command is read when the job runs (not kept in memory between runs).
      const { rows } = await db.query(
        `insert into cron.job_run_details (jobid, database, username, command, status, start_time)
         select jobid, current_database(), username, command, 'starting', now() from cron.job where jobid = $1 and active
         returning runid::text, username, command`,
        [job.jobid],
      );
      if (!rows.length) return; // unscheduled or paused since the jobs were loaded
      runid = rows[0].runid;
      const username: string = rows[0].username;
      const command: string = rows[0].command;
      // Jobs run as the owner role; one written with another user by a superuser doesn't run.
      if (username !== owner) return await finish('failed', `jobs run as ${owner}; this job's user is ${username}`);
      const password = await ownerPassword(p);
      if (!password) return await finish('failed', `${owner} has no password yet (restart keel-migrate)`);
      const c = new pg.Client({
        host: config.db.host,
        port: config.db.port,
        user: owner,
        password,
        database: p.dbName,
        application_name: 'keel-cron',
        connectionTimeoutMillis: 10_000,
        statement_timeout: config.cron.timeout * 1000,
      });
      c.on('error', () => {});
      let timer: NodeJS.Timeout | undefined;
      try {
        await c.connect();
        const pid = (await c.query('select pg_backend_pid() as pid')).rows[0].pid as number;
        await db.query(`update cron.job_run_details set status = 'running', job_pid = $2 where runid = $1`, [runid, pid]);
        // A job can change its own statement_timeout: past the limit, its connection is closed.
        let killed = false;
        timer = setTimeout(() => {
          killed = true;
          void db.query('select pg_terminate_backend($1)', [pid]).catch(() => {});
        }, config.cron.timeout * 1000 + 5_000);
        try {
          const result = await runDiscardingRows(c, command);
          await finish('succeeded', resultMessage(result));
        } catch (err) {
          await finish('failed', killed ? `job stopped after ${config.cron.timeout}s (KEEL_CRON_TIMEOUT)` : (err as Error).message);
        }
      } finally {
        clearTimeout(timer);
        await c.end().catch(() => {});
      }
    } catch (err) {
      await finish('failed', `could not run the job: ${(err as Error).message}`);
      if (!runid) warn(`run:${p.name}`, 'could not start a cron job', { project: p.name, job: job.jobid, error: (err as Error).message });
    } finally {
      s.running.delete(job.jobid);
    }
  };

  // ------------------------------------------------------------ cleanup
  const cleanup = async (p: Project) => {
    const db = su(p);
    // Typed and qualified: an untyped $1 once let an owner's public.make_interval(text) run here as the superuser.
    await db.query(`delete from cron.job_run_details where start_time < now() - pg_catalog.make_interval(days => $1::int)`, [config.cron.historyDays]);
    await db.query(`delete from supabase_functions.hooks where created_at < now() - pg_catalog.make_interval(days => $1::int)`, [config.cron.historyDays]);
  };

  // ------------------------------------------------------------ tick
  const tickProject = async (p: Project, now: number) => {
    const s = stateOf(p);
    const minute = Math.floor(now / 60_000);
    const newMinute = minute !== s.minute;
    s.minute = minute;
    if (now - s.loadedAt >= RELOAD_MS) await loadJobs(p, s);
    for (const job of dueJobs(s.jobs, s, now, newMinute, config.cron.maxRunning)) void runJob(p, s, job);
    if (now - s.cleanedAt >= CLEANUP_MS) {
      s.cleanedAt = now;
      await cleanup(p);
    }
  };

  // Each project ticks on its own: one whose tables are locked (by its own
  // sessions) or whose database is slow can't hold up the others.
  const tick = () => {
    const now = Date.now();
    const projects = listProjects();
    for (const name of states.keys()) if (!projects.some((p) => p.name === name)) states.delete(name);
    for (const p of projects) {
      const s = stateOf(p);
      if (s.busy) continue;
      s.busy = true;
      void tickProject(p, now)
        .catch((err) => {
          // A project created a moment ago may not have its schemas yet.
          if (!['3F000', '42P01'].includes((err as { code?: string }).code || '')) warn(`tick:${p.name}`, 'scheduled jobs: project skipped', { project: p.name, error: (err as Error).message });
        })
        .finally(() => {
          s.busy = false;
        });
    }
  };
  setInterval(tick, 1000).unref();
  log.info('scheduled jobs (cron) are running', { timeout_s: config.cron.timeout });
}
