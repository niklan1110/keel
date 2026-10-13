import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../lib/config.js';
import { newClient, waitForDb } from '../lib/db.js';
import { FUNCTION_NAME_RE, RESERVED_SECRET_RE, SECRET_NAME_RE, deployFunction, validateBundle, type Bundle } from '../functions/shared.js';

/**
 * Command-line edge function management, run inside the Keel image by ./keel:
 *
 *   keel fn deploy [name ...] [--project p] [--no-verify-jwt]   (reads /src/functions)
 *   keel fn list [--project p]
 *   keel fn delete <name> [--project p]
 *   keel secrets list|set NAME=value ...|unset NAME ... [--project p]
 *
 * The functions folder uses the Supabase layout: one folder per function with
 * an index.ts, plus shared code in folders starting with "_" (e.g. _shared).
 */

const SRC = process.env.KEEL_FUNCTIONS_SRC || '/src/functions';
const MAX_FILE = 5 * 1024 * 1024;
const SKIP_DIRS = new Set(['node_modules', '.git', '.vscode', 'tests', '__tests__']);

type Args = { positional: string[]; project: string; flags: Set<string> };

function parseArgs(argv: string[]): Args {
  const positional: string[] = [];
  const flags = new Set<string>();
  let project = config.defaultProject;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--project' || a === '-p') project = argv[++i] || '';
    else if (a.startsWith('--project=')) project = a.slice(10);
    else if (a.startsWith('--')) flags.add(a.slice(2));
    else positional.push(a);
  }
  return { positional, project, flags };
}

const out = (s: string) => process.stdout.write(s + '\n');
const fail = (s: string): never => {
  process.stderr.write(`keel: ${s}\n`);
  process.exit(1);
};

async function withControl<T>(fn: (c: ReturnType<typeof newClient>) => Promise<T>): Promise<T> {
  await waitForDb(config.db.controlDb, config.db.superuser, 30_000);
  const c = newClient(config.db.controlDb);
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end();
  }
}

async function requireProject(project: string) {
  // A project's owner role (KEEL_DB_URL from Studio > Connect) sees only its own project, through the view.
  const { rowCount } = await withControl((c) =>
    c.query('select 1 from keel.projects where name = $1', [project]).catch((err) => {
      if ((err as { code?: string }).code !== '42501') throw err;
      return c.query('select 1 from keel.visible_projects where name = $1', [project]);
    }),
  );
  if (!rowCount) fail(`project "${project}" does not exist (use --project <name>)`);
}

/** Collects text files under dir (relative paths with forward slashes). */
async function collect(dir: string, prefix: string, files: Record<string, string>, skipped: string[]) {
  for (const ent of await fs.readdir(dir, { withFileTypes: true })) {
    if (ent.name.startsWith('.')) continue;
    const rel = prefix ? `${prefix}/${ent.name}` : ent.name;
    const abs = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      if (!SKIP_DIRS.has(ent.name)) await collect(abs, rel, files, skipped);
      continue;
    }
    if (!ent.isFile()) continue;
    const buf = await fs.readFile(abs);
    if (buf.length > MAX_FILE || buf.subarray(0, 8192).includes(0)) {
      skipped.push(rel);
      continue;
    }
    files[rel] = buf.toString('utf8');
  }
}

/** verify_jwt = false from supabase/config.toml, when the project has one. */
async function verifyJwtFromConfig(name: string): Promise<boolean | undefined> {
  const toml = await fs.readFile(path.join(path.dirname(SRC), 'config.toml'), 'utf8').catch(() => '');
  if (!toml) return undefined;
  let section = '';
  for (const raw of toml.split('\n')) {
    const line = raw.replace(/#.*$/, '').trim();
    const sec = /^\[(.+)\]$/.exec(line);
    if (sec) {
      section = sec[1].trim();
      continue;
    }
    const kv = /^verify_jwt\s*=\s*(true|false)$/.exec(line);
    if (kv && (section === `functions.${name}` || section === `functions."${name}"`)) return kv[1] === 'true';
  }
  return undefined;
}

async function deploy(args: Args) {
  const stat = await fs.stat(SRC).catch(() => null);
  if (!stat?.isDirectory()) fail(`no functions folder found (expected supabase/functions or functions/)`);
  await requireProject(args.project);
  const entries = await fs.readdir(SRC, { withFileTypes: true });
  const all = entries.filter((e) => e.isDirectory() && !e.name.startsWith('_') && !e.name.startsWith('.')).map((e) => e.name);
  const names = args.positional.length ? args.positional : all;
  if (!names.length) fail('no functions to deploy');

  // Shared code: every top-level folder starting with "_" plus a root import map.
  const shared: Record<string, string> = {};
  const skipped: string[] = [];
  for (const e of entries) {
    if (e.isDirectory() && e.name.startsWith('_')) await collect(path.join(SRC, e.name), e.name, shared, skipped);
  }
  const rootMap = await fs.readFile(path.join(SRC, 'import_map.json'), 'utf8').catch(() => null);
  if (rootMap !== null) shared['import_map.json'] = rootMap;

  // Check every function first, so a broken one doesn't leave a half-finished deploy.
  const ready: { name: string; bundle: Bundle; files: Record<string, string> }[] = [];
  for (const name of names) {
    if (!FUNCTION_NAME_RE.test(name)) fail(`"${name}" is not a valid function name`);
    if (!all.includes(name)) fail(`no folder named ${name} in the functions folder`);
    const files: Record<string, string> = { ...shared };
    await collect(path.join(SRC, name), name, files, skipped);
    const fromConfig = await verifyJwtFromConfig(name);
    const verifyJwt = args.flags.has('no-verify-jwt') ? false : fromConfig ?? true;
    try {
      ready.push({ name, files, bundle: validateBundle(name, { files, verify_jwt: verifyJwt }) });
    } catch (err) {
      fail(`${name}: ${(err as Error).message} (nothing was deployed)`);
    }
  }
  for (const { name, bundle, files } of ready) {
    const version = await deployFunction(args.project, name, bundle);
    const size = Object.values(files).reduce((n, f) => n + Buffer.byteLength(f), 0);
    out(`Deployed ${name} v${version} (${Object.keys(files).length} files, ${(size / 1024).toFixed(1)} KB${bundle.verifyJwt ? '' : ', JWT check off'})`);
    out(`  ${config.publicUrl}/${args.project}/functions/v1/${name}`);
  }
  if (skipped.length) out(`Skipped binary or oversized files: ${skipped.join(', ')}`);
}

export async function main(): Promise<void> {
  const [cmd, ...rest] = process.argv.slice(3);
  const args = parseArgs(rest);
  switch (cmd) {
    case 'deploy':
      return deploy(args);
    case 'list': {
      await requireProject(args.project);
      const { rows } = await withControl((c) =>
        c.query('select name, version, verify_jwt, updated_at from keel.functions where project = $1 order by name', [args.project]),
      );
      if (!rows.length) {
        out(`No functions in ${args.project} yet.`);
        return;
      }
      for (const r of rows) out(`${r.name.padEnd(28)} v${String(r.version).padEnd(5)} ${r.verify_jwt ? 'jwt' : 'public'}  ${new Date(r.updated_at).toISOString()}`);
      return;
    }
    case 'delete': {
      if (!args.positional.length) fail('usage: keel functions delete <name>');
      await requireProject(args.project);
      for (const name of args.positional) {
        const r = await withControl((c) => c.query('delete from keel.functions where project = $1 and name = $2', [args.project, name]));
        out(r.rowCount ? `Deleted ${name}` : `No function named ${name}`);
      }
      return;
    }
    default:
      fail('usage: keel functions <deploy|list|delete> [name ...] [--project NAME] [--no-verify-jwt]');
  }
}

export async function secretsMain(): Promise<void> {
  const [cmd, ...rest] = process.argv.slice(3);
  const args = parseArgs(rest);
  await requireProject(args.project);
  switch (cmd) {
    case 'list': {
      const { rows } = await withControl((c) => c.query('select name, updated_at from keel.function_secrets where project = $1 order by name', [args.project]));
      if (!rows.length) {
        out(`No secrets in ${args.project}.`);
        return;
      }
      for (const r of rows) out(`${r.name.padEnd(40)} ${new Date(r.updated_at).toISOString()}`);
      return;
    }
    case 'set': {
      const pairs = args.positional.map((p) => {
        const i = p.indexOf('=');
        if (i < 1) fail(`expected NAME=value, got "${p}"`);
        return [p.slice(0, i), p.slice(i + 1)] as const;
      });
      if (!pairs.length) fail('usage: keel secrets set NAME=value ...');
      for (const [k] of pairs) {
        if (!SECRET_NAME_RE.test(k)) fail(`invalid secret name "${k}"`);
        if (RESERVED_SECRET_RE.test(k)) fail(`${k} is set by Keel and can't be overridden`);
      }
      for (const [k, v] of pairs) if (v.length > 64 * 1024) fail(`the value for ${k} is longer than 64 KB`);
      await withControl(async (c) => {
        for (const [k, v] of pairs) {
          await c.query(
            `insert into keel.function_secrets (project, name, value) values ($1, $2, $3)
             on conflict (project, name) do update set value = excluded.value, updated_at = now()`,
            [args.project, k, v],
          );
        }
      });
      out(`Set ${pairs.map(([k]) => k).join(', ')} for ${args.project}. Running functions restart with the new values.`);
      return;
    }
    case 'unset': {
      await withControl((c) => c.query('delete from keel.function_secrets where project = $1 and name = any($2)', [args.project, args.positional]));
      out(`Removed ${args.positional.join(', ')}`);
      return;
    }
    default:
      fail('usage: keel secrets <list|set NAME=value ...|unset NAME ...> [--project NAME]');
  }
}
