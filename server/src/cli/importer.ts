import { config } from '../lib/config.js';
import { newClient, waitForDb } from '../lib/db.js';
import type { Project } from '../lib/registry.js';
import { importFromSupabase } from '../importer/supabase.js';

/**
 * keel import-supabase --db-url URL [--url https://<ref>.supabase.co --service-key KEY] [--project NAME]
 *   [--no-schema] [--no-auth] [--no-storage]
 */
export async function main(): Promise<void> {
  const argv = process.argv.slice(3);
  const opt = (name: string) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const flag = (name: string) => argv.includes(`--${name}`);
  const dbUrl = opt('db-url') || process.env.SUPABASE_DB_URL;
  const projectName = opt('project') || config.defaultProject;
  if (!dbUrl) {
    process.stderr.write('usage: keel import-supabase --db-url postgresql://… [--url https://<ref>.supabase.co --service-key <service_role key>] [--project NAME]\n');
    process.exit(2);
  }
  await waitForDb(config.db.controlDb, config.db.superuser, 30_000);
  const k = newClient(config.db.controlDb);
  await k.connect();
  const { rows } = await k.query('select * from keel.projects where name = $1', [projectName]);
  await k.end();
  if (!rows[0]) {
    process.stderr.write(`keel: project "${projectName}" does not exist. Create it in Studio first (an empty project is best).\n`);
    process.exit(1);
  }
  const r = rows[0];
  const project: Project = { name: r.name, dbName: r.db_name, jwtSecret: r.jwt_secret, jwtKeys: [], anonKey: r.anon_key, serviceKey: r.service_key, settings: r.settings, createdAt: String(r.created_at) };
  const result = await importFromSupabase({
    project,
    dbUrl,
    apiUrl: opt('url'),
    serviceKey: opt('service-key') || process.env.SUPABASE_SERVICE_ROLE_KEY,
    schema: !flag('no-schema'),
    auth: !flag('no-auth'),
    storage: !flag('no-storage'),
    log: (msg, level) => (level === 'warn' || level === 'error' ? process.stderr : process.stdout).write(`${level === 'warn' ? 'warning: ' : ''}${msg}\n`),
  });
  if (result.warnings) process.stdout.write(`Finished with ${result.warnings} warning(s); check them above.\n`);
}
