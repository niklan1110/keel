import { config } from '../lib/config.js';
import { newClient } from '../lib/db.js';

/** Function names as Supabase allows them: used in URLs, so no slashes or dots. */
export const FUNCTION_NAME_RE = /^[A-Za-z][A-Za-z0-9_-]{0,62}$/;
/** Secret names: environment variable style. */
export const SECRET_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
/**
 * Set by Keel (or the container) for every function, or able to change how
 * the runtime loads code, resolves names, makes connections or writes files:
 * can't be set as a secret. SSLKEYLOGFILE makes the runtime itself append to
 * any path its user can write, outside --allow-write (another project's code
 * included); NPM_CONFIG_* points npm: imports at any registry, past --deny-net.
 */
export const RESERVED_SECRET_RE =
  /^(SUPABASE_URL|SUPABASE_ANON_KEY|SUPABASE_SERVICE_ROLE_KEY|KEEL_.*|DENO_.*|LD_.*|SSL_CERT_.*|SSLKEYLOGFILE|NODE_.*|NPM_CONFIG_.*|RUST_.*|MALLOC_.*|GLIBC_TUNABLES|GCONV_PATH|LOCPATH|HOSTALIASES|RES_OPTIONS|LOCALDOMAIN|PATH|HOME|TMPDIR|.*_PROXY)$/i;

export const MAX_FILES = 500;
export const MAX_BUNDLE_BYTES = 20 * 1024 * 1024;

/**
 * Validates a relative file path from a deployed bundle and returns it in
 * normalised form, or null when it could escape the bundle directory.
 */
export function safeRelPath(rel: string): string | null {
  if (typeof rel !== 'string' || !rel || rel.length > 300) return null;
  if (rel.startsWith('/') || rel.includes('\\') || /[\0\r\n]/.test(rel)) return null;
  const parts = rel.split('/');
  for (const p of parts) {
    if (!p || p === '.' || p === '..' || !/^[A-Za-z0-9._@+\- ]+$/.test(p)) return null;
  }
  return parts.join('/');
}

export type Bundle = { files: Record<string, string>; entrypoint: string; verifyJwt: boolean };

export function validateBundle(name: string, input: { files?: unknown; entrypoint?: unknown; verify_jwt?: unknown }): Bundle {
  if (!FUNCTION_NAME_RE.test(name)) {
    throw Object.assign(new Error('Function names start with a letter and use letters, digits, - and _ (max 63).'), { status: 400 });
  }
  if (!input.files || typeof input.files !== 'object' || Array.isArray(input.files)) {
    throw Object.assign(new Error('files must be an object of { "path": "source" }'), { status: 400 });
  }
  const files: Record<string, string> = {};
  let total = 0;
  for (const [k, v] of Object.entries(input.files as Record<string, unknown>)) {
    const safe = safeRelPath(k);
    if (!safe) throw Object.assign(new Error(`Invalid file path: ${JSON.stringify(k)}`), { status: 400 });
    if (typeof v !== 'string') throw Object.assign(new Error(`File ${safe} must be text`), { status: 400 });
    if (safe === '.keel-complete' || safe.startsWith('.keel/')) throw Object.assign(new Error(`${safe} is reserved`), { status: 400 });
    files[safe] = v;
    total += Buffer.byteLength(v);
  }
  const count = Object.keys(files).length;
  if (!count) throw Object.assign(new Error('A function needs at least one file'), { status: 400 });
  if (count > MAX_FILES) throw Object.assign(new Error(`At most ${MAX_FILES} files per function`), { status: 400 });
  if (total > MAX_BUNDLE_BYTES) throw Object.assign(new Error('Function source is larger than 20 MB'), { status: 413 });
  const entrypoint = typeof input.entrypoint === 'string' && input.entrypoint ? safeRelPath(input.entrypoint) : defaultEntrypoint(name, files);
  if (!entrypoint || !(entrypoint in files)) {
    throw Object.assign(new Error(`Entrypoint ${input.entrypoint || `${name}/index.ts`} is not among the files`), { status: 400 });
  }
  return { files, entrypoint, verifyJwt: input.verify_jwt === undefined ? true : !!input.verify_jwt };
}

function defaultEntrypoint(name: string, files: Record<string, string>): string | null {
  for (const ext of ['ts', 'js', 'tsx', 'jsx', 'mjs', 'mts']) {
    if (`${name}/index.${ext}` in files) return `${name}/index.${ext}`;
  }
  return null;
}

/** Creates or updates a function. Returns the new version number. */
export async function deployFunction(project: string, name: string, b: Bundle): Promise<number> {
  const c = newClient(config.db.controlDb);
  await c.connect();
  try {
    const { rows } = await c.query(
      `insert into keel.functions (project, name, entrypoint, files, verify_jwt)
       values ($1, $2, $3, $4, $5)
       on conflict (project, name) do update
         set entrypoint = excluded.entrypoint, files = excluded.files, verify_jwt = excluded.verify_jwt,
             version = keel.functions.version + 1, updated_at = now()
       returning version`,
      [project, name, b.entrypoint, JSON.stringify(b.files), b.verifyJwt],
    );
    return rows[0].version;
  } finally {
    await c.end();
  }
}
