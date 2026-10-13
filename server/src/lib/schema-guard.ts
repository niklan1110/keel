import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';
import { newClient } from './db.js';

/**
 * Stops an older Keel image from starting on a database that a newer Keel
 * has already upgraded (after a downgrade by hand, or a rollback without
 * restoring the backup). Older code doesn't know the newer schema and could
 * damage data.
 *
 * Each project database lists its applied upgrades in _keel.migrations. The
 * control database also records, in keel.schema_state, the highest upgrade
 * and control-schema level that ran and which Keel version ran them.
 */

/**
 * Level of the control database's schema (sql/cluster/control.sql). Raise it
 * when control.sql changes in a way older versions can't work with.
 */
export const CONTROL_SCHEMA = 1;

const PROJECT_SQL = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../sql/project');

export type SchemaLevel = { migration: number; control: number };

export type DatabaseState = {
  /** What the last Keel to finish its upgrades wrote down, if any. */
  recorded: (SchemaLevel & { version: string }) | null;
  /** Highest applied upgrade in each project database. */
  projects: { name: string; migration: number }[];
};

/** The highest project upgrade this image ships, and its control-schema level. */
export async function imageLevel(dir = PROJECT_SQL): Promise<SchemaLevel> {
  const numbers = (await fs.readdir(dir)).filter((f) => f.endsWith('.sql')).map((f) => Number.parseInt(f, 10));
  return { migration: Math.max(0, ...numbers.filter(Number.isFinite)), control: CONTROL_SCHEMA };
}

/** Explains why the database is newer than this image, or returns null when it isn't. */
export function newerThanImage(image: SchemaLevel, db: DatabaseState, version = config.version): string | null {
  const reasons: string[] = [];
  for (const p of db.projects) {
    if (p.migration > image.migration) reasons.push(`project ${p.name} has schema upgrade ${p.migration}`);
  }
  const r = db.recorded;
  if (r && (r.migration > image.migration || r.control > image.control)) {
    reasons.push(`the database was last upgraded by Keel ${r.version}`);
  }
  if (!reasons.length) return null;
  return [
    `This Keel (${version}, schema upgrades up to ${image.migration}) is older than its database: ${reasons.join('; ')}.`,
    'Starting it could damage your data, so Keel stops here. Either go back to the newer version',
    '(./keel update, or set KEEL_VERSION back to it), or restore the backup taken before the update',
    'with ./keel rollback --restore.',
  ].join('\n');
}

async function readState(): Promise<DatabaseState> {
  const state: DatabaseState = { recorded: null, projects: [] };
  const c = newClient('postgres');
  await c.connect();
  try {
    const { rowCount } = await c.query('select 1 from pg_database where datname = $1', [config.db.controlDb]);
    if (!rowCount) return state; // a fresh install
  } finally {
    await c.end();
  }

  let projects: { name: string; db_name: string }[] = [];
  const k = newClient(config.db.controlDb);
  await k.connect();
  try {
    const has = (await k.query(`select to_regclass('keel.schema_state') as s, to_regclass('keel.projects') as p`)).rows[0];
    if (has.s) {
      const row = (await k.query('select keel_version, project_migration, control_schema from keel.schema_state')).rows[0];
      if (row) state.recorded = { version: row.keel_version, migration: row.project_migration, control: row.control_schema };
    }
    if (has.p) projects = (await k.query('select name, db_name from keel.projects')).rows;
  } finally {
    await k.end();
  }

  for (const p of projects) {
    const c = newClient(p.db_name);
    try {
      await c.connect();
    } catch {
      continue; // a database that no longer exists: nothing to protect
    }
    try {
      const has = (await c.query(`select to_regclass('_keel.migrations') as m`)).rows[0].m;
      const migration = has ? Number((await c.query('select coalesce(max(version), 0) as v from _keel.migrations')).rows[0].v) : 0;
      state.projects.push({ name: p.name, migration });
    } finally {
      await c.end();
    }
  }
  return state;
}

/**
 * Why this image must not start on the database, or null when it may.
 * KEEL_ALLOW_DOWNGRADE=on skips the check (for development only).
 */
export async function olderImageProblem(): Promise<string | null> {
  if (/^(on|true|1|yes)$/i.test(process.env.KEEL_ALLOW_DOWNGRADE ?? '')) return null;
  return newerThanImage(await imageLevel(), await readState());
}

/** Notes in the control database which version upgraded it, and how far. */
export async function recordSchema(): Promise<void> {
  const level = await imageLevel();
  const k = newClient(config.db.controlDb);
  await k.connect();
  try {
    await k.query(`create table if not exists keel.schema_state (
      id                boolean primary key default true check (id),
      keel_version      text not null,
      project_migration int not null,
      control_schema    int not null,
      updated_at        timestamptz not null default now()
    )`);
    await k.query(
      `insert into keel.schema_state (id, keel_version, project_migration, control_schema) values (true, $1, $2, $3)
       on conflict (id) do update set keel_version = excluded.keel_version, project_migration = excluded.project_migration,
         control_schema = excluded.control_schema, updated_at = now()`,
      [config.version, level.migration, level.control],
    );
  } finally {
    await k.end();
  }
}
