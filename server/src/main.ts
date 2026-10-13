import { log } from './lib/log.js';

const services: Record<string, () => Promise<{ main: () => Promise<void> }>> = {
  migrate: () => import('./migrate/index.js'),
  gateway: () => import('./gateway/index.js'),
  rest: () => import('./rest/index.js'),
  auth: () => import('./auth/index.js'),
  storage: () => import('./storage/index.js'),
  realtime: () => import('./realtime/index.js'),
  studio: () => import('./studio/index.js'),
  functions: () => import('./functions/index.js'),
  egress: () => import('./egress/index.js'),
  'docker-proxy': () => import('./dockerproxy/index.js'),
  tunnel: () => import('./tunnel/index.js'),
  // Command-line helpers (run with `docker compose run`, see ./keel).
  fn: () => import('./cli/functions.js'),
  secrets: () => import('./cli/functions.js').then((m) => ({ main: m.secretsMain })),
  'generate-env': () => import('./cli/env.js'),
  'import-supabase': () => import('./cli/importer.js'),
  'studio-user': () => import('./cli/studio-users.js'),
  keys: () => import('./cli/keys.js'),
  restore: () => import('./cli/restore.js'),
};

const name = process.argv[2];
const load = services[name];
if (!load) {
  process.stderr.write(`usage: keel <${Object.keys(services).join('|')}>\n`);
  process.exit(2);
}

process.on('unhandledRejection', (err) => {
  log.error('unhandled rejection', { error: (err as Error)?.stack || String(err) });
});

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    log.info(`received ${sig}, shutting down`);
    process.exit(0);
  });
}

try {
  const mod = await load();
  await mod.main();
  if (['migrate', 'fn', 'secrets', 'generate-env', 'import-supabase', 'studio-user', 'keys', 'restore'].includes(name)) process.exit(0);
} catch (err) {
  if (['fn', 'secrets', 'generate-env', 'import-supabase', 'studio-user', 'keys', 'restore'].includes(name)) {
    // Command-line use: a plain message, not a stack trace.
    const e = err as { code?: string; message?: string };
    const hint = e.code === '28P01' ? ' (check the password in KEEL_DB_URL or POSTGRES_PASSWORD)' : '';
    process.stderr.write(`keel: ${e.message || String(err)}${hint}\n`);
  } else {
    log.error(`${name} failed to start`, { error: (err as Error)?.stack || String(err) });
  }
  process.exit(1);
}
