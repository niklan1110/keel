import { pool, tx } from '../lib/db.js';
import { config } from '../lib/config.js';
import { HttpError, readJson, sendJson, type Req, type Res, type Router } from '../lib/http.js';
import { log } from '../lib/log.js';
import type { Project } from '../lib/registry.js';
import { backupProject } from './backups.js';

/**
 * Project defaults: a saved copy of the rows in the project's own tables,
 * and "Restore defaults" to put every table back to it. The work happens in
 * the database (_keel_defaults.save() and .restore(), see 010_defaults.sql),
 * so agents with a database connection can use the same thing.
 */

type Deps = {
  authed: (fn: (req: Req, res: Res) => unknown) => (req: Req, res: Res) => unknown;
  project: (req: Req) => Project;
};

type SavedTable = { schema: string; name: string; rows: number };

const restoring = new Set<string>();

async function info(p: Project) {
  const c = await pool(p.dbName, config.db.superuser, 6).connect();
  try {
    const saved = (await c.query('select saved_at from _keel_defaults.info')).rows[0]?.saved_at ?? null;
    const tables = (
      await c.query('select table_schema as schema, table_name as name, row_count::int as rows from _keel_defaults.tables order by 1, 2')
    ).rows as SavedTable[];
    // Tables created since: a restore empties them.
    const added = (
      await c.query(
        `select u.table_schema as schema, u.table_name as name from _keel_defaults.user_tables() u
          where not exists (select 1 from _keel_defaults.tables d where d.table_schema = u.table_schema and d.table_name = u.table_name)`,
      )
    ).rows as { schema: string; name: string }[];
    return {
      savedAt: saved ? new Date(saved).toISOString() : null,
      rows: tables.reduce((n, t) => n + t.rows, 0),
      tables: saved ? tables : [],
      addedSince: saved ? added : [],
    };
  } finally {
    c.release();
  }
}

const notReady = (err: unknown) => {
  // A database from before this feature, until keel-migrate has run.
  if ((err as { code?: string }).code === '3F000' || (err as { code?: string }).code === '42883') {
    return new HttpError(409, 'Keel is still upgrading this project. Try again in a minute.', 'not_ready');
  }
  return null;
};

export function registerDefaultsRoutes(router: Router, { authed, project }: Deps): void {
  router.get(
    '/api/projects/:p/defaults',
    authed(async (req, res) => {
      try {
        sendJson(res, 200, await info(project(req)));
      } catch (err) {
        throw notReady(err) || err;
      }
    }),
  );

  router.post(
    '/api/projects/:p/defaults/save',
    authed(async (req, res) => {
      const p = project(req);
      try {
        // One snapshot for every table, while the app keeps running.
        const out = await tx(pool(p.dbName, config.db.superuser, 6), async (c) => {
          await c.query('set transaction isolation level repeatable read');
          return (await c.query('select _keel_defaults.save() as r')).rows[0].r;
        });
        log.info('defaults saved', { project: p.name, tables: out.tables, rows: out.rows });
      } catch (err) {
        throw notReady(err) || new HttpError(400, (err as Error).message, 'save_failed');
      }
      sendJson(res, 200, await info(p));
    }),
  );

  router.post(
    '/api/projects/:p/defaults/restore',
    authed(async (req, res) => {
      const p = project(req);
      const body = await readJson(req);
      if (body.confirm !== p.name) throw new HttpError(400, 'Confirm with the project name.', 'confirm_required');
      if (restoring.has(p.name)) throw new HttpError(409, 'Defaults are already being restored.', 'busy');
      restoring.add(p.name);
      try {
        const current = await info(p).catch((err) => {
          throw notReady(err) || err;
        });
        if (!current.savedAt) throw new HttpError(400, 'No defaults saved for this project yet.', 'no_defaults');
        // A backup first, so a restore can be undone from Backups.
        const backup = await backupProject(p.name, p.dbName, 'before-defaults');
        let out: { rows: number; emptied: string[]; missing: string[]; savedAt: string };
        try {
          out = await tx(pool(p.dbName, config.db.superuser, 6), async (c) => {
            await c.query(`set local lock_timeout = '15s'`);
            return (await c.query('select _keel_defaults.restore() as r')).rows[0].r;
          });
        } catch (err) {
          const e = err as Error & { hint?: string; code?: string };
          const msg = e.code === '55P03' ? 'Some tables are busy; try again in a moment.' : e.hint ? `${e.message}. ${e.hint}` : e.message;
          throw new HttpError(400, `Nothing was changed: ${msg}`, 'restore_failed');
        }
        log.info('defaults restored', { project: p.name, rows: out.rows, backup: backup.file });
        sendJson(res, 200, { ...out, backup: { id: backup.id, createdAt: backup.created_at } });
      } finally {
        restoring.delete(p.name);
      }
    }),
  );

  router.delete(
    '/api/projects/:p/defaults',
    authed(async (req, res) => {
      const p = project(req);
      await tx(pool(p.dbName, config.db.superuser, 6), async (c) => {
        await c.query('truncate _keel_defaults.rows, _keel_defaults.tables, _keel_defaults.info');
      }).catch((err) => {
        throw notReady(err) || err;
      });
      log.info('defaults removed', { project: p.name });
      sendJson(res, 200, await info(p));
    }),
  );
}
