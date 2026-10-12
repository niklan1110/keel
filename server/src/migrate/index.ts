import fs from 'node:fs/promises';
import path from 'node:path';
import { config, requireSecret, requireServicePassword } from '../lib/config.js';
import { newClient, waitForDb } from '../lib/db.js';
import { log } from '../lib/log.js';
import { createProject, ensureOwnerLogin, migrateCluster, migrateProjectDb } from '../lib/projects.js';
import { olderImageProblem, recordSchema } from '../lib/schema-guard.js';
import { newProjectSettings } from '../auth/settings.js';

/**
 * One-shot job run before the other services start: creates roles and the
 * control database, upgrades every project database, and creates the first
 * project on a fresh install.
 */
/** uid/gid the Keel images run as. */
const KEEL_UID = 1000;

/**
 * Bind-mounted folders (e.g. /DATA/AppData/keel/storage on a NAS) are created
 * by Docker as root, so the services can't write to them. When this job runs
 * as root it hands those folders to the keel user first.
 */
async function fixOwnership(): Promise<void> {
  if (process.getuid?.() !== 0) return;
  for (const dir of [config.storage.root, config.backups.dir, config.functions.root, config.tunnel.dir, config.db.credentialsDir]) {
    const st = await fs.stat(dir).catch(() => null);
    if (!st?.isDirectory() || st.uid === KEEL_UID) continue;
    const walk = async (p: string): Promise<void> => {
      await fs.lchown(p, KEEL_UID, KEEL_UID);
      const s = await fs.lstat(p);
      if (!s.isDirectory()) return;
      for (const name of await fs.readdir(p)) await walk(path.join(p, name));
    };
    await walk(dir);
    log.info('gave folder to the keel user', { dir });
  }
}

/** Written when migrations are done; the healthcheck of `migrate --stay` looks for it. */
const READY_FILE = '/tmp/keel-migrated';

export async function main(): Promise<void> {
  requireSecret('POSTGRES_PASSWORD', config.db.password);
  requireServicePassword();
  const stay = process.argv.includes('--stay');
  await fs.rm(READY_FILE, { force: true });
  await fixOwnership();
  // Root was only needed for the folders; everything after runs as the keel user.
  if (process.getuid?.() === 0 && process.setuid && process.setgid) {
    process.setgroups?.([KEEL_UID]);
    process.setgid(KEEL_UID);
    process.setuid(KEEL_UID);
  }
  await waitForDb();
  // Before touching anything: an older image must not run on a newer schema.
  const problem = await olderImageProblem();
  if (problem) {
    log.error('refusing to start: the database is newer than this version of Keel', { version: config.version });
    process.stderr.write(`\n${problem}\n\n`);
    process.exit(1);
  }
  await migrateCluster();
  log.info('cluster ready');

  const k = newClient(config.db.controlDb);
  await k.connect();
  let projects: { name: string; db_name: string }[];
  try {
    projects = (await k.query('select name, db_name from keel.projects order by created_at')).rows;
  } finally {
    await k.end();
  }

  for (const p of projects) {
    const n = await migrateProjectDb(p.db_name);
    log.info(n ? `upgraded project ${p.name}` : `project ${p.name} is up to date`, n ? { migrations: n } : undefined);
  }
  // Each project's owner role gets its password (made on first start after an upgrade).
  if (projects.length) {
    const c = newClient(config.db.controlDb);
    await c.connect();
    try {
      for (const p of projects) await ensureOwnerLogin(c, p.name, p.db_name);
    } finally {
      await c.end();
    }
  }

  if (!projects.length && config.defaultProject) {
    await createProject(config.defaultProject, newProjectSettings(config.publicUrl, !!config.smtp.host, config.exposure));
  }
  await recordSchema();
  log.info('migrations complete', { version: config.version });
  if (stay) {
    // For panels that expect every container to keep running (ZimaOS, CasaOS):
    // stay up and report healthy, instead of exiting once done.
    await fs.writeFile(READY_FILE, new Date().toISOString());
    log.info('staying up (--stay); other services can start');
    await new Promise(() => setInterval(() => {}, 1 << 30));
  }
}
