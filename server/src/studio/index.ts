import crypto from 'node:crypto';
import dns from 'node:dns';
import fs from 'node:fs';
import os from 'node:os';
import type { IncomingMessage, ServerResponse } from 'node:http';
import path from 'node:path';
import pg from 'pg';
import { config, requireSecret } from '../lib/config.js';
import { PROJECT_SEARCH_PATH, newClient, pool, quoteIdent, quoteLiteral, tx } from '../lib/db.js';
import { HttpError, Router, createServer, fromLocalNetwork, listen, viaTrustedProxy, viaTunnel, readJson, sendJson, type Req, type Res } from '../lib/http.js';
import { log } from '../lib/log.js';
import { isKnownHost } from '../lib/net.js';
import { createProject, deleteProject, keyGraceHours, listKeys, revokeOldKeys, rollKeys, validateProjectName } from '../lib/projects.js';
import { postgresUrl } from '../lib/pgurl.js';
import { proxyRequest } from '../lib/proxy.js';
import { SECURITY_HEADERS, isDocsPath, sendFile, serveDocs } from '../lib/static.js';
import { Registry, ownerRoleFor, type PhoneSettings, type Project, type ProjectSettings } from '../lib/registry.js';
import { DEFAULT_SMS_TEMPLATE, isPrivateServer, newProjectSettings, smsConfigured } from '../auth/settings.js';
import { control as controlPool, ensureOwner, registerAccountRoutes, resealTotpSecrets, type StudioRequest } from './accounts.js';
import { registerDefaultsRoutes } from './defaults.js';
import { registerFunctionRoutes } from './functions.js';
import { registerImportRoutes } from './imports.js';
import { registerJobRoutes } from './jobs.js';
import { registerInternetRoutes } from './internet.js';
import { csrfProblem } from './csrf.js';
import { functionNetworks, isFunctionPeer } from './peers.js';
import { backupPath, backupProject, deleteBackup, downloadToken, getBackup, isRunning, listBackups, readDownloadToken, reschedule, restoreBackup, startSchedule } from './backups.js';
import { connectTarget, envTarget, resolveTarget } from '../lib/backup-target.js';
import {
  deleteSet,
  effectiveSchedule,
  fullBackupRunning,
  listRemote,
  listSets,
  loadSettings,
  passphraseSet,
  saveSettings,
  setFile,
  startFullBackup,
  targetFromInput,
  testTarget,
} from './fullbackups.js';
import { containerAction, containerLogs, dockerEnabled, listContainers } from './docker.js';
import { RAW_TYPES, introspect, keyClause, listSchemas, tableInfo, toParam, whereClause, type Filter } from './schema.js';
import { startScheduler } from './scheduler.js';
import { updateStatus } from './updates.js';
import { ProviderSettingsError, maskProviders, mergeBuiltinProviders, mergeCustomProviders } from './providers.js';
import { providerSecretKey, sealSecret } from '../auth/totp.js';

const MAX_RESULT_ROWS = 1000;
const HELPER_SERVICES = new Set(['keel-migrate', 'keel-docker', 'keel-db-tls']);

const bad = (msg: string, code = 'bad_request') => new HttpError(400, msg, code);

export async function main(): Promise<void> {
  requireSecret('POSTGRES_PASSWORD', config.db.password);
  requireSecret('KEEL_SECRET', config.secret);
  requireSecret('KEEL_DASHBOARD_PASSWORD', config.dashboard.password);

  const registry = new Registry(config.db.superuser);
  await registry.start();
  await startSchedule(() => registry.list());
  startScheduler(() => registry.list());

  await ensureOwner();
  // Studio sessions store the IP address and browser of each sign-in; expired
  // ones go hourly, not only when someone signs in.
  const sweepSessions = () =>
    void controlPool()
      .query('delete from keel.studio_sessions where expires_at < now()')
      .catch((e) => log.warn('studio session cleanup failed', { error: (e as Error).message }));
  sweepSessions();
  setInterval(sweepSessions, 60 * 60_000).unref();
  await resealTotpSecrets();
  const router = new Router();

  // ------------------------------------------------------------ accounts and sessions
  const { authed, sessionActive, policy: internetLogin } = registerAccountRoutes(router);
  registerInternetRoutes(router, { authed, reload: () => registry.reload() });

  const project = (req: Req): Project => {
    const p = registry.get(req.params.p);
    if (!p) throw new HttpError(404, `Project "${req.params.p}" not found`, 'not_found');
    return p;
  };
  const db = (p: Project) => pool(p.dbName, config.db.superuser, 6);

  /**
   * Switches the table editor's transaction to the project's owner role when
   * that role may do `privilege` on the table. Triggers, column defaults,
   * domain checks and views run as the role that touches the table, and the
   * owner role writes those: as the superuser, a trigger the owner planted
   * could make it a superuser. Tables the owner role can't use (made by a
   * superuser elsewhere) carry nothing it wrote, and stay the superuser's.
   */
  const asOwnerWhereAllowed = async (c: pg.ClientBase, p: Project, t: { oid: number }, privilege: 'SELECT' | 'INSERT' | 'UPDATE' | 'DELETE') => {
    const owner = ownerRoleFor(p.dbName);
    const { rows } = await c.query(
      `select exists (select 1 from pg_catalog.pg_roles where rolname = $1::text)
              and pg_catalog.has_table_privilege($1::text, $2::oid, $3::text) as ok`,
      [owner, t.oid, privilege],
    );
    if (rows[0]?.ok) await c.query(`set local role ${quoteIdent(owner)}`);
  };

  /** Calls a project's internal service API with the service role key. */
  const service = async (p: Project, base: string, method: string, path: string, body?: unknown) => {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${p.serviceKey}`,
        apikey: p.serviceKey,
        'x-keel-project': p.name,
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let data: any = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = text;
    }
    if (!res.ok) throw new HttpError(res.status >= 500 ? 502 : res.status, data?.msg || data?.message || `Request failed (${res.status})`, data?.error_code || data?.error || 'upstream_error');
    return data;
  };

  router.get(
    '/api/instance',
    authed(async (_req, res) => {
      const c = newClient('postgres');
      await c.connect();
      let version = '';
      try {
        version = (await c.query('show server_version')).rows[0].server_version.split(' ')[0];
      } finally {
        await c.end();
      }
      sendJson(res, 200, {
        version: config.version,
        update: updateStatus(),
        postgres: version,
        hostLabel: config.hostLabel,
        publicUrl: config.publicUrl,
        docker: dockerEnabled(),
        backupSchedule: effectiveSchedule(await loadSettings().catch(() => null)),
        smtp: !!config.smtp.host,
        internetLogin,
      });
    }),
  );

  // ------------------------------------------------------------ projects
  router.get(
    '/api/projects',
    authed(async (_req, res) => {
      const list = registry.list();
      const sizes = new Map<string, number>();
      if (list.length) {
        const c = newClient('postgres');
        await c.connect();
        try {
          const { rows } = await c.query('select datname, pg_database_size(datname)::bigint as size from pg_database where datname = any($1)', [list.map((p) => p.dbName)]);
          for (const r of rows) sizes.set(r.datname, Number(r.size));
        } finally {
          await c.end();
        }
      }
      sendJson(res, 200, list.map((p) => ({ name: p.name, dbName: p.dbName, sizeBytes: sizes.get(p.dbName) ?? 0, createdAt: p.createdAt })));
    }),
  );

  router.post(
    '/api/projects',
    authed(async (req, res) => {
      const body = await readJson(req);
      const name = String(body.name || '').trim();
      const problem = validateProjectName(name);
      if (problem) throw bad(problem, 'invalid_name');
      try {
        await createProject(name, newProjectSettings(config.publicUrl, !!config.smtp.host, config.exposure));
      } catch (err) {
        const e = err as Error & { status?: number };
        throw new HttpError(e.status || 500, e.message, 'create_failed');
      }
      await registry.reload();
      sendJson(res, 201, { name });
    }),
  );

  router.delete(
    '/api/projects/:p',
    authed(async (req, res) => {
      const p = project(req);
      const body = await readJson(req);
      if (body.confirm !== p.name) throw bad('Type the project name to confirm deletion.', 'confirm_required');
      await deleteProject(p.name);
      await registry.reload();
      sendJson(res, 200, { deleted: p.name });
    }),
  );

  router.get(
    '/api/projects/:p/overview',
    authed(async (req, res) => {
      const p = project(req);
      const { rows } = await db(p).query(
        `select pg_database_size(current_database())::bigint as size,
                (select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
                  where n.nspname = 'public' and c.relkind in ('r', 'p') and not c.relispartition)::int as tables,
                (select count(*) from auth.users)::int as users,
                (select count(*) from auth.users where last_sign_in_at > now() - interval '1 day')::int as users_today,
                (select coalesce(sum((metadata->>'size')::bigint), 0) from storage.objects)::bigint as storage,
                (select count(*) from storage.buckets)::int as buckets`,
      );
      const r = rows[0];
      const last = (await listBackups(p.name)).find((b) => b.status === 'ok');
      sendJson(res, 200, {
        sizeBytes: Number(r.size),
        tables: r.tables,
        users: r.users,
        usersToday: r.users_today,
        storageBytes: Number(r.storage),
        buckets: r.buckets,
        lastBackup: last ? { id: last.id, createdAt: last.created_at, sizeBytes: Number(last.size_bytes) } : null,
        backupRunning: isRunning(p.name),
      });
    }),
  );

  router.get(
    '/api/projects/:p/connect',
    authed(async (req, res) => {
      const p = project(req);
      // The project's owner role, not the superuser (see sql/project/011_owner_role.sql).
      const owner = await controlPool().query('select password from keel.project_owners where project = $1', [p.name]);
      // keel-db turns TLS on when it has a certificate (made by keel-db-tls).
      const ssl = await controlPool().query("select current_setting('ssl') = 'on' as on");
      const db = { host: config.publicDbHost, port: config.publicDbPort, database: p.dbName, user: ownerRoleFor(p.dbName) };
      sendJson(res, 200, {
        // Whether <public address>/docs works, so the AI agent prompt only links docs that exist.
        docsOnApi: await gatewayServesDocs(),
        apiUrl: `${config.publicUrl}/${p.name}`,
        restUrl: `${config.publicUrl}/${p.name}/rest/v1`,
        anonKey: p.anonKey,
        serviceKey: p.serviceKey,
        db: {
          ...db,
          url: postgresUrl({ ...db, tls: ssl.rows[0]?.on === true }),
          password: (owner.rows[0]?.password as string | undefined) ?? null,
        },
        superuser: config.db.superuser,
        callbackUrl: `${config.publicUrl}/${p.name}/auth/v1/callback`,
      });
    }),
  );

  // ------------------------------------------------------------ API keys
  const actor = (req: Req) => `studio:${(req as StudioRequest).studio?.username || 'unknown'}`;

  router.get(
    '/api/projects/:p/keys',
    authed(async (req, res) => {
      sendJson(res, 200, await listKeys(project(req).name));
    }),
  );

  router.post(
    '/api/projects/:p/keys/roll',
    authed(async (req, res) => {
      const p = project(req);
      const body = await readJson(req);
      const emergency = body.emergency === true;
      // Signs every user out: confirmed by typing the project name, as for deleting it.
      if (emergency && body.confirm !== p.name) throw bad('Type the project name to confirm an emergency roll.', 'confirm_required');
      let graceHours: number | undefined;
      try {
        graceHours = emergency ? undefined : keyGraceHours(body.graceHours);
      } catch (err) {
        throw bad((err as Error).message, 'invalid_grace');
      }
      const out = await rollKeys(p.name, { emergency, graceHours, actor: actor(req) });
      // Show the new keys right away rather than after the change notification.
      await registry.reload();
      sendJson(res, 200, { kid: out.kid, anonKey: out.anonKey, serviceKey: out.serviceKey, revoked: out.revoked, endedSessions: out.endedSessions });
    }),
  );

  router.post(
    '/api/projects/:p/keys/revoke-old',
    authed(async (req, res) => {
      const out = await revokeOldKeys(project(req).name, actor(req));
      await registry.reload();
      sendJson(res, 200, out);
    }),
  );

  // ------------------------------------------------------------ project settings (auth)
  const maskSettings = (s: ProjectSettings) => {
    return {
      site_url: s.site_url || '',
      uri_allow_list: s.uri_allow_list || [],
      jwt_exp: s.jwt_exp || 3600,
      disable_signup: !!s.disable_signup,
      mailer_autoconfirm: s.mailer_autoconfirm ?? null,
      anonymous_users: !!s.anonymous_users,
      password_min_length: s.password_min_length || 6,
      ...maskProviders(s),
      smtp: { host: s.smtp?.host || '', port: s.smtp?.port || 587, user: s.smtp?.user || '', from: s.smtp?.from || '', secure: !!s.smtp?.secure, has_pass: !!s.smtp?.pass },
      global_smtp: !!config.smtp.host,
      // The public URL may be reachable from the internet (see newProjectSettings).
      public_url_private: isPrivateServer(config.publicUrl, config.exposure),
      phone: {
        enabled: !!s.phone?.enabled,
        configured: smsConfigured(s.phone),
        autoconfirm: !!s.phone?.autoconfirm,
        provider: s.phone?.provider || '',
        template: s.phone?.template || DEFAULT_SMS_TEMPLATE,
        otp_exp: s.phone?.otp_exp || 60,
        otp_length: s.phone?.otp_length || 6,
        test_otp: Object.entries(s.phone?.test_otp || {}).map(([k, v]) => `${k}=${v}`).join('\n'),
        twilio: { account_sid: s.phone?.twilio?.account_sid || '', message_service_sid: s.phone?.twilio?.message_service_sid || '', from: s.phone?.twilio?.from || '', has_secret: !!s.phone?.twilio?.auth_token },
        vonage: { api_key: s.phone?.vonage?.api_key || '', from: s.phone?.vonage?.from || '', has_secret: !!s.phone?.vonage?.api_secret },
        messagebird: { originator: s.phone?.messagebird?.originator || '', has_secret: !!s.phone?.messagebird?.access_key },
        webhook: { url: s.phone?.webhook?.url || '', has_secret: !!s.phone?.webhook?.secret },
      },
      mfa: { totp: s.mfa?.totp ?? true, phone: !!s.mfa?.phone, max_enrolled_factors: s.mfa?.max_enrolled_factors || 10 },
      realtime: { private_only: !!s.realtime?.private_only },
    };
  };

  router.get('/api/projects/:p/settings', authed((req, res) => sendJson(res, 200, maskSettings(project(req).settings))));

  router.put(
    '/api/projects/:p/settings',
    authed(async (req, res) => {
      const p = project(req);
      const body = await readJson(req);
      const cur: ProjectSettings = JSON.parse(JSON.stringify(p.settings || {}));
      if (typeof body.site_url === 'string') {
        const v = body.site_url.trim().replace(/\/+$/, '');
        if (v && !/^https?:\/\//.test(v)) throw bad('Site URL must start with http:// or https://');
        cur.site_url = v;
      }
      if (Array.isArray(body.uri_allow_list)) cur.uri_allow_list = body.uri_allow_list.map(String).map((s: string) => s.trim()).filter(Boolean);
      if (body.jwt_exp !== undefined) {
        const n = Number(body.jwt_exp);
        if (!Number.isInteger(n) || n < 60 || n > 7 * 24 * 3600) throw bad('Token lifetime must be between 60 seconds and 7 days');
        cur.jwt_exp = n;
      }
      for (const k of ['disable_signup', 'anonymous_users'] as const) if (typeof body[k] === 'boolean') cur[k] = body[k];
      if (body.mailer_autoconfirm === null) delete cur.mailer_autoconfirm;
      else if (typeof body.mailer_autoconfirm === 'boolean') cur.mailer_autoconfirm = body.mailer_autoconfirm;
      if (body.password_min_length !== undefined) cur.password_min_length = Math.max(6, Math.min(72, Number(body.password_min_length) || 6));
      const seal = (secret: string) => sealSecret(secret, providerSecretKey(p.jwtSecret));
      try {
        mergeBuiltinProviders(cur, body.external, seal);
        mergeCustomProviders(cur, body.custom_providers, seal);
      } catch (e) {
        if (e instanceof ProviderSettingsError) throw bad(e.message, 'invalid_provider');
        throw e;
      }
      if (body.smtp) {
        const prev = cur.smtp || {};
        cur.smtp = {
          host: typeof body.smtp.host === 'string' ? body.smtp.host.trim() : prev.host,
          port: Number(body.smtp.port) || prev.port || 587,
          user: typeof body.smtp.user === 'string' ? body.smtp.user : prev.user,
          pass: typeof body.smtp.pass === 'string' && body.smtp.pass ? body.smtp.pass : prev.pass,
          from: typeof body.smtp.from === 'string' ? body.smtp.from : prev.from,
          secure: typeof body.smtp.secure === 'boolean' ? body.smtp.secure : prev.secure,
        };
        if (!cur.smtp.host) delete cur.smtp;
      }
      if (body.phone && typeof body.phone === 'object') cur.phone = mergePhone(cur.phone || {}, body.phone);
      if (body.mfa && typeof body.mfa === 'object') {
        cur.mfa = {
          totp: typeof body.mfa.totp === 'boolean' ? body.mfa.totp : cur.mfa?.totp,
          phone: typeof body.mfa.phone === 'boolean' ? body.mfa.phone : cur.mfa?.phone,
          max_enrolled_factors: body.mfa.max_enrolled_factors !== undefined ? Math.max(1, Math.min(50, Number(body.mfa.max_enrolled_factors) || 10)) : cur.mfa?.max_enrolled_factors,
        };
      }
      if (body.realtime && typeof body.realtime.private_only === 'boolean') cur.realtime = { ...(cur.realtime || {}), private_only: body.realtime.private_only };
      const k = newClient(config.db.controlDb);
      await k.connect();
      try {
        await k.query('update keel.projects set settings = $2 where name = $1', [p.name, cur]);
      } finally {
        await k.end();
      }
      await registry.reload();
      sendJson(res, 200, maskSettings(cur));
    }),
  );

  registerFunctionRoutes(router, { authed, project });
  registerJobRoutes(router, { authed, project });
  registerImportRoutes(router, { authed, project });
  registerDefaultsRoutes(router, { authed, project });

  // ------------------------------------------------------------ schema & tables
  router.get(
    '/api/projects/:p/schemas',
    authed(async (req, res) => {
      const c = await db(project(req)).connect();
      try {
        sendJson(res, 200, await listSchemas(c));
      } finally {
        c.release();
      }
    }),
  );

  router.get(
    '/api/projects/:p/schema',
    authed(async (req, res) => {
      const schema = req.query.get('schema') || 'public';
      const c = await db(project(req)).connect();
      try {
        sendJson(res, 200, { schema, tables: await introspect(c, schema) });
      } finally {
        c.release();
      }
    }),
  );

  router.get(
    '/api/projects/:p/tables/:schema/:table/rows',
    authed(async (req, res) => {
      const p = project(req);
      const limit = Math.min(500, Math.max(1, Number(req.query.get('limit')) || 50));
      const offset = Math.max(0, Number(req.query.get('offset')) || 0);
      let filters: Filter[] = [];
      try {
        filters = JSON.parse(req.query.get('filters') || '[]');
      } catch {
        throw bad('filters must be JSON');
      }
      const c = await db(p).connect();
      try {
        const t = await tableInfo(c, req.params.schema, req.params.table);
        const params: unknown[] = [];
        const where = whereClause(t, filters, params);
        const order = (req.query.get('order') || '').split(',').filter(Boolean).map((o) => {
          const [col, dir] = o.split('.');
          if (!t.columns.some((x) => x.name === col)) throw bad(`Unknown column ${col}`);
          return `${quoteIdent(col)} ${dir === 'desc' ? 'desc' : 'asc'} nulls last`;
        });
        const pk = t.columns.filter((x) => x.pk).map((x) => quoteIdent(x.name));
        const orderBy = order.length ? order : pk.length ? pk : [];
        const from = `${quoteIdent(t.schema)}.${quoteIdent(t.name)}`;
        await c.query('begin read only');
        await c.query(`set local statement_timeout = '15s'`);
        await asOwnerWhereAllowed(c, p, t, 'SELECT');
        const rows = await c.query({
          text: `select * from ${from} ${where} ${orderBy.length ? 'order by ' + orderBy.join(', ') : ''} limit ${limit} offset ${offset}`,
          values: params,
          rowMode: 'array',
          types: RAW_TYPES,
        });
        const total = await c.query(`select count(*)::bigint as n from ${from} ${where}`, params);
        await c.query('commit');
        sendJson(res, 200, {
          columns: t.columns,
          rows: rows.rows,
          total: Number(total.rows[0].n),
          rls: t.rls,
          realtime: t.realtime,
        });
      } catch (err) {
        await c.query('rollback').catch(() => {});
        throw err instanceof HttpError ? err : new HttpError(400, (err as Error).message, 'query_failed');
      } finally {
        c.release();
      }
    }),
  );

  router.post(
    '/api/projects/:p/tables/:schema/:table/rows',
    authed(async (req, res) => {
      const p = project(req);
      const body = await readJson(req);
      const values = (body.values || {}) as Record<string, unknown>;
      const r = await tx(db(p), async (c) => {
        const t = await tableInfo(c, req.params.schema, req.params.table);
        const cols = t.columns.filter((col) => col.name in values && !col.generated);
        const params = cols.map((col) => toParam(col, values[col.name]));
        const sql = cols.length
          ? `insert into ${quoteIdent(t.schema)}.${quoteIdent(t.name)} (${cols.map((x) => quoteIdent(x.name)).join(', ')}) values (${cols.map((_, i) => `$${i + 1}`).join(', ')}) returning *`
          : `insert into ${quoteIdent(t.schema)}.${quoteIdent(t.name)} default values returning *`;
        await asOwnerWhereAllowed(c, p, t, 'INSERT');
        return c.query({ text: sql, values: params, rowMode: 'array', types: RAW_TYPES });
      }).catch((err) => {
        throw err instanceof HttpError ? err : new HttpError(400, (err as Error).message, 'insert_failed');
      });
      sendJson(res, 201, { row: r.rows[0] });
    }),
  );

  router.patch(
    '/api/projects/:p/tables/:schema/:table/rows',
    authed(async (req, res) => {
      const p = project(req);
      const body = await readJson(req);
      const values = (body.values || {}) as Record<string, unknown>;
      const r = await tx(db(p), async (c) => {
        const t = await tableInfo(c, req.params.schema, req.params.table);
        const cols = t.columns.filter((col) => col.name in values && !col.generated);
        if (!cols.length) throw bad('Nothing to update');
        const params: unknown[] = cols.map((col) => toParam(col, values[col.name]));
        const set = cols.map((x, i) => `${quoteIdent(x.name)} = $${i + 1}`).join(', ');
        const where = keyClause(t, body.key || {}, params);
        await asOwnerWhereAllowed(c, p, t, 'UPDATE');
        const out = await c.query({ text: `update ${quoteIdent(t.schema)}.${quoteIdent(t.name)} set ${set} where ${where} returning *`, values: params, rowMode: 'array', types: RAW_TYPES });
        if (!out.rowCount) throw new HttpError(404, 'Row not found', 'not_found');
        return out;
      }).catch((err) => {
        throw err instanceof HttpError ? err : new HttpError(400, (err as Error).message, 'update_failed');
      });
      sendJson(res, 200, { row: r.rows[0] });
    }),
  );

  router.delete(
    '/api/projects/:p/tables/:schema/:table/rows',
    authed(async (req, res) => {
      const p = project(req);
      const body = await readJson(req);
      const keys = Array.isArray(body.keys) ? (body.keys as Record<string, unknown>[]) : [];
      if (!keys.length) throw bad('No rows selected');
      const out = await tx(db(p), async (c) => {
        const t = await tableInfo(c, req.params.schema, req.params.table);
        await asOwnerWhereAllowed(c, p, t, 'DELETE');
        let n = 0;
        for (const key of keys) {
          const params: unknown[] = [];
          const where = keyClause(t, key, params);
          n += (await c.query(`delete from ${quoteIdent(t.schema)}.${quoteIdent(t.name)} where ${where}`, params)).rowCount || 0;
        }
        return n;
      }).catch((err) => {
        throw err instanceof HttpError ? err : new HttpError(400, (err as Error).message, 'delete_failed');
      });
      sendJson(res, 200, { deleted: out });
    }),
  );

  router.post(
    '/api/projects/:p/tables',
    authed(async (req, res) => {
      const p = project(req);
      const body = await readJson(req);
      const sql = createTableSql(body);
      await tx(db(p), async (c) => {
        // Column types such as vector live in extensions: the admin's table, the project's search_path.
        await c.query(`set local search_path to ${PROJECT_SEARCH_PATH}`);
        await c.query(sql);
        if (body.realtime) {
          const rel = `${quoteIdent(body.schema || 'public')}.${quoteIdent(body.name)}`;
          await c.query(`alter publication supabase_realtime add table ${rel}`);
          await c.query(`alter table ${rel} replica identity full`);
        }
      }).catch((err) => {
        throw new HttpError(400, (err as Error).message, 'create_failed');
      });
      sendJson(res, 201, { schema: body.schema || 'public', name: body.name, sql });
    }),
  );

  router.delete(
    '/api/projects/:p/tables/:schema/:table',
    authed(async (req, res) => {
      const p = project(req);
      const body = await readJson(req);
      if (body.confirm !== req.params.table) throw bad('Type the table name to confirm.', 'confirm_required');
      await db(p)
        .query(`drop table ${quoteIdent(req.params.schema)}.${quoteIdent(req.params.table)}${body.cascade ? ' cascade' : ''}`)
        .catch((err) => {
          throw new HttpError(400, (err as Error).message, 'drop_failed');
        });
      sendJson(res, 200, { dropped: req.params.table });
    }),
  );

  // ------------------------------------------------------------ policies, RLS, realtime
  const CMD: Record<string, string> = { r: 'SELECT', a: 'INSERT', w: 'UPDATE', d: 'DELETE', '*': 'ALL' };

  router.get(
    '/api/projects/:p/tables/:schema/:table/policies',
    authed(async (req, res) => {
      const p = project(req);
      const rel = `${quoteIdent(req.params.schema)}.${quoteIdent(req.params.table)}`;
      const c = await db(p).connect();
      try {
        const meta = (
          await c.query(
            `select c.relrowsecurity as rls, c.relforcerowsecurity as force_rls, c.relreplident as replica_identity,
                    exists (select 1 from pg_publication_tables pt where pt.pubname = 'supabase_realtime'
                             and pt.schemaname = $1 and pt.tablename = $2) as realtime
               from pg_class c where c.oid = $3::regclass`,
            [req.params.schema, req.params.table, rel],
          )
        ).rows[0];
        if (!meta) throw new HttpError(404, 'Table not found', 'not_found');
        const { rows } = await c.query(
          `select p.polname as name, p.polcmd as cmd, p.polpermissive as permissive,
                  case when p.polroles = '{0}' then array['public'] else array(select rolname::text from pg_roles where oid = any(p.polroles)) end as roles,
                  pg_get_expr(p.polqual, p.polrelid) as using, pg_get_expr(p.polwithcheck, p.polrelid) as check
             from pg_policy p where p.polrelid = $1::regclass order by p.polname`,
          [rel],
        );
        sendJson(res, 200, {
          rls: meta.rls,
          forceRls: meta.force_rls,
          realtime: meta.realtime,
          replicaIdentityFull: meta.replica_identity === 'f',
          policies: rows.map((r) => ({ ...r, cmd: CMD[r.cmd] || r.cmd })),
        });
      } finally {
        c.release();
      }
    }),
  );

  router.post(
    '/api/projects/:p/tables/:schema/:table/policies',
    authed(async (req, res) => {
      const p = project(req);
      const b = await readJson(req);
      const name = String(b.name || '').trim();
      if (!name) throw bad('Give the policy a name');
      const cmd = String(b.command || 'ALL').toUpperCase();
      if (!['ALL', 'SELECT', 'INSERT', 'UPDATE', 'DELETE'].includes(cmd)) throw bad('Unknown command');
      const roles = (Array.isArray(b.roles) && b.roles.length ? b.roles : ['public']).map((r: string) => (r === 'public' ? 'public' : quoteIdent(r)));
      let sql = `create policy ${quoteIdent(name)} on ${quoteIdent(req.params.schema)}.${quoteIdent(req.params.table)} as ${b.permissive === false ? 'restrictive' : 'permissive'} for ${cmd} to ${roles.join(', ')}`;
      if (b.using && cmd !== 'INSERT') sql += ` using (${b.using})`;
      if (b.check && cmd !== 'SELECT' && cmd !== 'DELETE') sql += ` with check (${b.check})`;
      await tx(db(p), async (c) => {
        // The admin's expressions may call the project's own functions: its search_path.
        await c.query(`set local search_path to ${PROJECT_SEARCH_PATH}`);
        await c.query(sql);
      }).catch((err) => {
        throw new HttpError(400, (err as Error).message, 'policy_failed');
      });
      sendJson(res, 201, { sql });
    }),
  );

  router.delete(
    '/api/projects/:p/tables/:schema/:table/policies/:name',
    authed(async (req, res) => {
      const p = project(req);
      await db(p).query(`drop policy ${quoteIdent(req.params.name)} on ${quoteIdent(req.params.schema)}.${quoteIdent(req.params.table)}`).catch((err) => {
        throw new HttpError(400, (err as Error).message, 'policy_failed');
      });
      sendJson(res, 200, { dropped: req.params.name });
    }),
  );

  router.put(
    '/api/projects/:p/tables/:schema/:table/settings',
    authed(async (req, res) => {
      const p = project(req);
      const b = await readJson(req);
      const rel = `${quoteIdent(req.params.schema)}.${quoteIdent(req.params.table)}`;
      await tx(db(p), async (c) => {
        if (typeof b.rls === 'boolean') await c.query(`alter table ${rel} ${b.rls ? 'enable' : 'disable'} row level security`);
        if (typeof b.realtime === 'boolean') {
          const has = (await c.query(`select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = $1 and tablename = $2`, [req.params.schema, req.params.table])).rowCount;
          if (b.realtime && !has) {
            await c.query(`alter publication supabase_realtime add table ${rel}`);
            // Full old rows let realtime check policies for deletes (otherwise they are withheld).
            await c.query(`alter table ${rel} replica identity full`);
          }
          if (!b.realtime && has) await c.query(`alter publication supabase_realtime drop table ${rel}`);
        }
        if (typeof b.replicaIdentityFull === 'boolean') await c.query(`alter table ${rel} replica identity ${b.replicaIdentityFull ? 'full' : 'default'}`);
      }).catch((err) => {
        throw new HttpError(400, (err as Error).message, 'settings_failed');
      });
      sendJson(res, 200, { ok: true });
    }),
  );

  // ------------------------------------------------------------ SQL editor
  const typeNames = new Map<string, Map<number, string>>();
  const typeName = async (c: pg.ClientBase, dbName: string, oids: number[]) => {
    let m = typeNames.get(dbName);
    if (!m) typeNames.set(dbName, (m = new Map()));
    const missing = oids.filter((o) => !m!.has(o));
    if (missing.length) {
      const { rows } = await c.query('select oid::int as oid, typname from pg_type where oid = any($1::oid[])', [missing]);
      for (const r of rows) m.set(r.oid, r.typname);
    }
    return (oid: number) => m!.get(oid) || 'text';
  };

  router.post(
    '/api/projects/:p/sql',
    authed(async (req, res) => {
      const p = project(req);
      const body = await readJson(req, 2 * 1024 * 1024);
      const query = String(body.query || '');
      if (!query.trim()) throw bad('Write a query first');
      // A dedicated connection, so an unfinished BEGIN never leaks into a pool.
      // The admin's own SQL, so the project's search_path (see connectionOptions).
      const c = newClient(p.dbName, undefined, { projectPath: true });
      await c.connect();
      const started = performance.now();
      try {
        await c.query(`set statement_timeout = '60s'`);
        const out = await c.query({ text: query, rowMode: 'array', types: RAW_TYPES } as pg.QueryConfig);
        const ms = performance.now() - started;
        const list = (Array.isArray(out) ? out : [out]) as pg.QueryArrayResult[];
        const name = await typeName(c, p.dbName, [...new Set(list.flatMap((r) => (r.fields || []).map((f) => f.dataTypeID)))]);
        sendJson(res, 200, {
          durationMs: Math.round(ms * 10) / 10,
          results: list.map((r) => ({
            command: r.command,
            rowCount: r.rowCount,
            fields: (r.fields || []).map((f) => ({ name: f.name, type: name(f.dataTypeID) })),
            rows: (r.rows || []).slice(0, MAX_RESULT_ROWS),
            truncated: (r.rows || []).length > MAX_RESULT_ROWS,
          })),
        });
      } catch (err) {
        const e = err as pg.DatabaseError;
        sendJson(res, 400, {
          error: 'query_failed',
          message: e.message,
          detail: e.detail,
          hint: e.hint,
          position: e.position ? Number(e.position) : undefined,
          code: e.code,
          durationMs: Math.round((performance.now() - started) * 10) / 10,
        });
      } finally {
        await c.end().catch(() => {});
      }
    }),
  );

  const control = async <T>(fn: (c: pg.Client) => Promise<T>) => {
    const c = newClient(config.db.controlDb);
    await c.connect();
    try {
      return await fn(c);
    } finally {
      await c.end();
    }
  };

  router.get(
    '/api/projects/:p/queries',
    authed(async (req, res) => {
      const p = project(req);
      sendJson(res, 200, await control(async (c) => (await c.query('select id, name, sql, updated_at from keel.saved_queries where project = $1 order by updated_at desc', [p.name])).rows));
    }),
  );
  router.post(
    '/api/projects/:p/queries',
    authed(async (req, res) => {
      const p = project(req);
      const b = await readJson(req);
      const name = String(b.name || '').trim() || 'Untitled query';
      sendJson(res, 201, await control(async (c) => (await c.query('insert into keel.saved_queries (project, name, sql) values ($1, $2, $3) returning id, name, sql, updated_at', [p.name, name, String(b.sql || '')])).rows[0]));
    }),
  );
  router.put(
    '/api/projects/:p/queries/:id',
    authed(async (req, res) => {
      const p = project(req);
      const b = await readJson(req);
      const row = await control(async (c) =>
        (await c.query('update keel.saved_queries set name = coalesce($3, name), sql = coalesce($4, sql), updated_at = now() where project = $1 and id = $2 returning id, name, sql, updated_at', [p.name, req.params.id, b.name ?? null, b.sql ?? null])).rows[0],
      );
      if (!row) throw new HttpError(404, 'Query not found', 'not_found');
      sendJson(res, 200, row);
    }),
  );
  router.delete(
    '/api/projects/:p/queries/:id',
    authed(async (req, res) => {
      const p = project(req);
      await control((c) => c.query('delete from keel.saved_queries where project = $1 and id = $2', [p.name, req.params.id]));
      sendJson(res, 200, { ok: true });
    }),
  );

  // ------------------------------------------------------------ users
  router.get(
    '/api/projects/:p/users',
    authed(async (req, res) => {
      const p = project(req);
      const search = (req.query.get('search') || '').trim();
      const limit = Math.min(200, Number(req.query.get('limit')) || 50);
      const offset = Math.max(0, Number(req.query.get('offset')) || 0);
      const where = search ? `where u.email ilike '%' || $1 || '%' or u.phone like '%' || regexp_replace($1, '[^0-9]', '', 'g') || '%' or u.id::text = $1` : '';
      const { rows } = await db(p).query(
        `select u.id, u.email, u.phone, u.created_at, u.last_sign_in_at, u.confirmed_at, u.invited_at, u.banned_until,
                u.is_anonymous, u.raw_app_meta_data as app, u.raw_user_meta_data as meta,
                array(select provider from auth.identities i where i.user_id = u.id order by i.created_at) as providers,
                coalesce((select json_agg(json_build_object('id', f.id, 'type', f.factor_type, 'name', f.friendly_name, 'status', f.status,
                                                           'phone', f.phone, 'createdAt', f.created_at) order by f.created_at)
                            from auth.mfa_factors f where f.user_id = u.id), '[]') as factors,
                count(*) over () as total
           from auth.users u ${where} order by u.created_at desc limit ${limit} offset ${offset}`,
        search ? [search] : [],
      );
      const total = rows[0] ? Number(rows[0].total) : 0;
      sendJson(res, 200, {
        total,
        users: rows.map((u) => ({
          id: u.id,
          email: u.email,
          phone: u.phone,
          createdAt: u.created_at,
          lastSignInAt: u.last_sign_in_at,
          confirmedAt: u.confirmed_at,
          factors: u.factors,
          invitedAt: u.invited_at,
          bannedUntil: u.banned_until && new Date(u.banned_until) > new Date() ? u.banned_until : null,
          anonymous: u.is_anonymous,
          providers: u.providers.length ? u.providers : u.is_anonymous ? ['anonymous'] : [],
          metadata: u.meta,
          appMetadata: u.app,
        })),
      });
    }),
  );

  router.post(
    '/api/projects/:p/users',
    authed(async (req, res) => {
      const p = project(req);
      const b = await readJson(req);
      const user = await service(p, config.services.auth, 'POST', '/admin/users', {
        email: b.email || undefined,
        phone: b.phone || undefined,
        password: b.password || undefined,
        email_confirm: b.autoConfirm !== false,
        phone_confirm: b.autoConfirm !== false,
      });
      sendJson(res, 201, user);
    }),
  );

  router.post(
    '/api/projects/:p/users/invite',
    authed(async (req, res) => {
      const p = project(req);
      const b = await readJson(req);
      const smtp = !!(p.settings.smtp?.host || config.smtp.host);
      if (smtp) {
        const user = await service(p, config.services.auth, 'POST', '/invite', { email: b.email });
        return sendJson(res, 200, { user, emailed: true });
      }
      // No mail server: return the invite link so it can be shared by hand.
      const link = await service(p, config.services.auth, 'POST', '/admin/generate_link', { type: 'invite', email: b.email });
      sendJson(res, 200, { user: link, emailed: false, link: link.action_link });
    }),
  );

  router.post(
    '/api/projects/:p/users/:id/recovery',
    authed(async (req, res) => {
      const p = project(req);
      const { rows } = await db(p).query('select email from auth.users where id = $1', [req.params.id]);
      if (!rows[0]?.email) throw new HttpError(404, 'User has no email address', 'not_found');
      const link = await service(p, config.services.auth, 'POST', '/admin/generate_link', { type: 'recovery', email: rows[0].email });
      const smtp = !!(p.settings.smtp?.host || config.smtp.host);
      if (smtp) {
        await service(p, config.services.auth, 'POST', '/recover', { email: rows[0].email });
        return sendJson(res, 200, { emailed: true });
      }
      sendJson(res, 200, { emailed: false, link: link.action_link });
    }),
  );

  router.post(
    '/api/projects/:p/users/:id/ban',
    authed(async (req, res) => {
      const p = project(req);
      const b = await readJson(req);
      const user = await service(p, config.services.auth, 'PUT', `/admin/users/${encodeURIComponent(req.params.id)}`, { ban_duration: b.duration || 'none' });
      sendJson(res, 200, user);
    }),
  );

  router.delete(
    '/api/projects/:p/users/:id/factors/:factor',
    authed(async (req, res) => {
      const p = project(req);
      await service(p, config.services.auth, 'DELETE', `/admin/users/${encodeURIComponent(req.params.id)}/factors/${encodeURIComponent(req.params.factor)}`);
      sendJson(res, 200, { ok: true });
    }),
  );

  router.delete(
    '/api/projects/:p/users/:id',
    authed(async (req, res) => {
      const p = project(req);
      await service(p, config.services.auth, 'DELETE', `/admin/users/${encodeURIComponent(req.params.id)}`, {});
      sendJson(res, 200, { ok: true });
    }),
  );

  // ------------------------------------------------------------ storage
  router.get(
    '/api/projects/:p/buckets',
    authed(async (req, res) => {
      const p = project(req);
      const { rows } = await db(p).query(
        `select b.id, b.name, b.public, b.file_size_limit, b.allowed_mime_types, b.created_at,
                count(o.id)::int as files, coalesce(sum((o.metadata->>'size')::bigint), 0)::bigint as size
           from storage.buckets b left join storage.objects o on o.bucket_id = b.id
          group by b.id order by b.created_at`,
      );
      sendJson(res, 200, rows.map((r) => ({ ...r, size: Number(r.size), file_size_limit: r.file_size_limit === null ? null : Number(r.file_size_limit) })));
    }),
  );

  router.post(
    '/api/projects/:p/buckets',
    authed(async (req, res) => {
      const p = project(req);
      const b = await readJson(req);
      await service(p, config.services.storage, 'POST', '/bucket', {
        name: b.name,
        public: !!b.public,
        file_size_limit: b.fileSizeLimit || null,
        allowed_mime_types: b.allowedMimeTypes || null,
      });
      sendJson(res, 201, { name: b.name });
    }),
  );

  router.put(
    '/api/projects/:p/buckets/:id',
    authed(async (req, res) => {
      const p = project(req);
      const b = await readJson(req);
      await service(p, config.services.storage, 'PUT', `/bucket/${encodeURIComponent(req.params.id)}`, b);
      sendJson(res, 200, { ok: true });
    }),
  );

  router.delete(
    '/api/projects/:p/buckets/:id',
    authed(async (req, res) => {
      const p = project(req);
      const id = encodeURIComponent(req.params.id);
      await service(p, config.services.storage, 'POST', `/bucket/${id}/empty`, {});
      await service(p, config.services.storage, 'DELETE', `/bucket/${id}`);
      sendJson(res, 200, { ok: true });
    }),
  );

  router.get(
    '/api/projects/:p/buckets/:id/objects',
    authed(async (req, res) => {
      const p = project(req);
      const prefix = req.query.get('prefix') || '';
      const list = await service(p, config.services.storage, 'POST', `/object/list/${encodeURIComponent(req.params.id)}`, {
        prefix,
        limit: 1000,
        offset: 0,
        sortBy: { column: 'name', order: 'asc' },
      });
      sendJson(res, 200, list);
    }),
  );

  router.post(
    '/api/projects/:p/buckets/:id/upload',
    authed(async (req, res) => {
      const p = project(req);
      const objectPath = (req.query.get('path') || '').replace(/^\/+/, '');
      if (!objectPath) throw bad('Missing path');
      await proxyRequest(req, res, {
        target: config.services.storage,
        path: `/object/${encodeURIComponent(req.params.id)}/${objectPath.split('/').map(encodeURIComponent).join('/')}`,
        headers: {
          authorization: `Bearer ${p.serviceKey}`,
          apikey: p.serviceKey,
          'x-keel-project': p.name,
          'x-upsert': 'true',
        },
      });
    }),
  );

  router.post(
    '/api/projects/:p/buckets/:id/delete',
    authed(async (req, res) => {
      const p = project(req);
      const b = await readJson(req);
      const paths: string[] = Array.isArray(b.paths) ? b.paths.map(String) : [];
      // Folders are expanded to every object below them.
      const names = new Set<string>();
      for (const pth of paths) {
        if (pth.endsWith('/')) {
          const { rows } = await db(p).query(`select name from storage.objects where bucket_id = $1 and name like $2 escape '\\'`, [req.params.id, pth.replace(/[\\%_]/g, '\\$&') + '%']);
          rows.forEach((r) => names.add(r.name));
        } else names.add(pth);
      }
      if (!names.size) return sendJson(res, 200, { deleted: 0 });
      const out = await service(p, config.services.storage, 'DELETE', `/object/${encodeURIComponent(req.params.id)}`, { prefixes: [...names] });
      sendJson(res, 200, { deleted: Array.isArray(out) ? out.length : 0 });
    }),
  );

  router.post(
    '/api/projects/:p/buckets/:id/url',
    authed(async (req, res) => {
      const p = project(req);
      const b = await readJson(req);
      const objectPath = String(b.path || '');
      const enc = objectPath.split('/').map(encodeURIComponent).join('/');
      const bucket = (await db(p).query('select public from storage.buckets where id = $1', [req.params.id])).rows[0];
      if (!bucket) throw new HttpError(404, 'Bucket not found', 'not_found');
      const base = `${config.publicUrl}/${p.name}/storage/v1`;
      const signed = await service(p, config.services.storage, 'POST', `/object/sign/${encodeURIComponent(req.params.id)}/${enc}`, { expiresIn: Number(b.expiresIn) || 3600 });
      sendJson(res, 200, {
        publicUrl: bucket.public ? `${base}/object/public/${encodeURIComponent(req.params.id)}/${enc}` : null,
        signedUrl: `${base}${signed.signedURL}`,
      });
    }),
  );

  // ------------------------------------------------------------ stack (containers)
  const HEALTH: { service: string; role: string; url: string }[] = [
    { service: 'keel-rest', role: 'REST API', url: `${config.services.rest}/health` },
    { service: 'keel-auth', role: 'Auth', url: `${config.services.auth}/health` },
    { service: 'keel-realtime', role: 'Realtime', url: `${config.services.realtime}/health` },
    { service: 'keel-storage', role: 'Storage', url: `${config.services.storage}/health` },
    { service: 'keel-gateway', role: 'Gateway', url: `${config.services.gateway}/health` },
    { service: 'keel-imgproxy', role: 'Image resize', url: `${config.services.imgproxy}/health` },
    { service: 'keel-functions', role: 'Edge functions', url: `${config.services.functions}/health` },
  ];

  router.get(
    '/api/stack',
    authed(async (_req, res) => {
      if (dockerEnabled()) {
        try {
          // Helpers that do one job and wait (migrations, the Docker API filter, Postgres' certificate) stay out of the stack view.
          const containers = (await listContainers()).filter((c) => !HELPER_SERVICES.has(c.service));
          return sendJson(res, 200, { docker: true, containers });
        } catch (err) {
          log.warn('docker unavailable, falling back to health checks', { error: (err as Error).message });
        }
      }
      const probe = async (url: string) => {
        try {
          const r = await fetch(url, { signal: AbortSignal.timeout(2000) });
          return r.ok;
        } catch {
          return false;
        }
      };
      let dbUp = true;
      try {
        await pool('postgres', config.db.superuser, 2).query('select 1');
      } catch {
        dbUp = false;
      }
      const results = await Promise.all(HEALTH.map(async (h) => ({ ...h, up: await probe(h.url) })));
      const containers = [{ service: 'keel-db', role: 'Database', up: dbUp }, ...results, { service: 'keel-studio', role: 'Studio', up: true }].map((h) => ({
        id: h.service,
        name: h.service,
        service: h.service,
        role: h.role,
        image: '',
        state: h.up ? 'running' : 'exited',
        status: h.up ? 'Healthy' : 'Not responding',
        health: null,
        createdAt: '',
      }));
      sendJson(res, 200, { docker: false, containers });
    }),
  );

  for (const action of ['start', 'stop', 'restart'] as const) {
    router.post(
      `/api/stack/:service/${action}`,
      authed(async (req, res) => {
        if (!dockerEnabled()) throw new HttpError(400, 'Docker access is disabled for Studio', 'docker_disabled');
        if (action === 'stop' && ['keel-studio', 'keel-db'].includes(req.params.service)) {
          throw bad(req.params.service === 'keel-studio' ? 'Studio cannot stop itself' : 'Stop the database from the command line (./keel down) so nothing is mid-write');
        }
        await containerAction(req.params.service, action).catch((err) => {
          throw new HttpError((err as { status?: number }).status || 502, (err as Error).message, 'docker_error');
        });
        sendJson(res, 200, { ok: true });
      }),
    );
  }

  router.get(
    '/api/stack/:service/logs',
    authed(async (req, res) => {
      if (!dockerEnabled()) return sendJson(res, 200, { docker: false, lines: [] });
      const tail = Math.min(1000, Number(req.query.get('tail')) || 200);
      const lines = await containerLogs(req.params.service, tail).catch((err) => {
        throw new HttpError((err as { status?: number }).status || 502, (err as Error).message, 'docker_error');
      });
      sendJson(res, 200, { docker: true, lines });
    }),
  );

  // ------------------------------------------------------------ backups
  router.get('/api/projects/:p/backups', authed(async (req, res) => sendJson(res, 200, await listBackups(project(req).name))));

  router.post(
    '/api/projects/:p/backups',
    authed(async (req, res) => {
      const p = project(req);
      const b = await backupProject(p.name, p.dbName, 'manual').catch((err) => {
        throw new HttpError((err as { status?: number }).status || 500, (err as Error).message, 'backup_failed');
      });
      sendJson(res, 201, b);
    }),
  );

  router.delete(
    '/api/projects/:p/backups/:id',
    authed(async (req, res) => {
      await deleteBackup(project(req).name, req.params.id);
      sendJson(res, 200, { ok: true });
    }),
  );

  router.post(
    '/api/projects/:p/backups/:id/restore',
    authed(async (req, res) => {
      const p = project(req);
      const b = await readJson(req);
      if (b.confirm !== p.name) throw bad('Type the project name to confirm the restore.', 'confirm_required');
      await restoreBackup(p.name, p.dbName, req.params.id).catch((err) => {
        throw new HttpError(500, `Restore failed: ${(err as Error).message}`, 'restore_failed');
      });
      sendJson(res, 200, { ok: true });
    }),
  );

  // ------------------------------------------------------------ full backups
  const backupOverview = async () => {
    const settings = await loadSettings();
    const env = envTarget();
    const t = settings.target;
    return {
      passphrase: passphraseSet(),
      schedule: effectiveSchedule(settings),
      scheduleSetHere: settings.schedule !== undefined,
      keepLocal: config.backups.keepLocal,
      keepDaily: settings.keepDaily,
      keepWeekly: settings.keepWeekly,
      // Never the secret key itself.
      target: t ? { endpoint: t.endpoint, region: t.region, bucket: t.bucket, prefix: t.prefix, accessKeyId: t.accessKeyId, pathStyle: t.pathStyle, hasSecret: !!t.secretSealed } : null,
      envTarget: env ? { endpoint: env.endpoint, bucket: env.bucket, prefix: env.prefix } : null,
      running: fullBackupRunning(),
      sets: await listSets(),
    };
  };
  const backupError = (err: unknown, code: string) => new HttpError((err as { status?: number }).status || 500, (err as Error).message, code);

  router.get('/api/backups', authed(async (_req, res) => sendJson(res, 200, await backupOverview())));

  router.put(
    '/api/backups/settings',
    authed(async (req, res) => {
      await saveSettings(await readJson(req)).catch((err) => {
        throw backupError(err, 'invalid_settings');
      });
      await reschedule();
      sendJson(res, 200, await backupOverview());
    }),
  );

  // Tries the target in the form (or the saved one): list, write and delete a small test file.
  router.post(
    '/api/backups/test',
    authed(async (req, res) => {
      const body = await readJson(req);
      try {
        const settings = await loadSettings();
        let target;
        if (body.target) {
          const t = targetFromInput(body.target, settings.target);
          target = connectTarget({ ...t.target, secretAccessKey: t.secret }, 'studio', 1);
        } else {
          target = resolveTarget(settings, 1);
          if (!target) throw Object.assign(new Error('No backup target is set up.'), { status: 400 });
        }
        const { canDelete } = await testTarget(target);
        sendJson(res, 200, { ok: true, target: target.describe, canDelete });
      } catch (err) {
        sendJson(res, 200, { ok: false, error: (err as Error).message });
      }
    }),
  );

  router.post(
    '/api/backups/full',
    authed(async (_req, res) => {
      const { row } = await startFullBackup('manual').catch((err) => {
        throw backupError(err, 'backup_failed');
      });
      sendJson(res, 202, row);
    }),
  );

  router.get(
    '/api/backups/remote',
    authed(async (_req, res) => {
      let target;
      try {
        target = resolveTarget(await loadSettings(), 1);
      } catch (err) {
        throw backupError(Object.assign(err as Error, { status: 400 }), 'target_error');
      }
      if (!target) return sendJson(res, 200, { target: null, backups: [] });
      const backups = await listRemote(target).catch((err) => {
        throw new HttpError(502, `Could not list the backup target: ${(err as Error).message}`, 'target_error');
      });
      sendJson(res, 200, { target: target.describe, backups: backups.map((b) => ({ name: b.name, size: b.size, lastModified: b.lastModified })) });
    }),
  );

  router.delete(
    '/api/backups/full/:id',
    authed(async (req, res) => {
      await deleteSet(req.params.id).catch((err) => {
        throw backupError(err, 'delete_failed');
      });
      sendJson(res, 200, { ok: true });
    }),
  );

  router.post(
    '/api/backups/full/:id/link',
    authed(async (req, res) => {
      const file = await setFile(req.params.id).catch((err) => {
        throw backupError(err, 'not_found');
      });
      sendJson(res, 200, { url: `/api/download/${downloadToken(file, (req as StudioRequest).studio!.sessionId)}` });
    }),
  );

  // Browser downloads can't send headers, so hand out a short-lived link
  // that works only while the session that asked for it is signed in.
  router.post(
    '/api/projects/:p/backups/:id/link',
    authed(async (req, res) => {
      const p = project(req);
      const b = await getBackup(p.name, req.params.id);
      const token = downloadToken(b.file, (req as StudioRequest).studio!.sessionId);
      sendJson(res, 200, { url: `/api/download/${token}` });
    }),
  );

  router.get('/api/download/:token', async (req, res) => {
    let link;
    try {
      link = readDownloadToken(req.params.token);
    } catch {
      throw new HttpError(403, 'This download link has expired', 'expired');
    }
    if (!(await sessionActive(link.sid))) throw new HttpError(403, 'This download link has expired', 'expired');
    const file = backupPath(link.file);
    const stat = await fs.promises.stat(file).catch(() => null);
    if (!stat) throw new HttpError(404, 'Backup file is missing', 'not_found');
    res.writeHead(200, {
      'Content-Type': 'application/octet-stream',
      'Content-Length': stat.size,
      'Content-Disposition': `attachment; filename="${path.basename(file)}"`,
    });
    fs.createReadStream(file).pipe(res);
  });

  router.get('/health', (_req, res) => sendJson(res, 200, { status: 'ok' }));

  // ------------------------------------------------------------ static UI
  const root = path.resolve(config.studioStatic);
  const serveStatic = async (req: Req, res: Res) => {
    if (req.path.startsWith('/api/')) throw new HttpError(404, 'Not found', 'not_found');
    if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'Method not allowed', 'method_not_allowed');
    if (isDocsPath(req.path)) return serveDocs(req, res, req.path);
    let decoded: string;
    try {
      decoded = decodeURIComponent(req.path);
    } catch {
      throw new HttpError(400, 'Bad request', 'bad_request');
    }
    let file = path.resolve(root, '.' + decoded);
    if (!file.startsWith(root + path.sep) && file !== root) throw new HttpError(404, 'Not found', 'not_found');
    let stat = await fs.promises.stat(file).catch(() => null);
    if (!stat || stat.isDirectory()) {
      file = path.join(root, 'index.html');
      stat = await fs.promises.stat(file).catch(() => null);
      if (!stat) throw new HttpError(404, 'Studio UI is not built', 'not_found');
    }
    sendFile(req, res, file, stat.size, 200, SECURITY_HEADERS, req.path.startsWith('/assets/'));
  };

  const server = createServer('keel-studio', router, (e) => ({ status: e.status, body: { error: e.code || 'error', message: e.message } }), serveStatic, true);
  server.requestTimeout = 0;
  // Edge functions run code from npm and the web; they never need Studio, so
  // connections from their container and its network are refused outright.
  // (Function code is kept from the host's published ports by its sandbox.)
  const handle = server.listeners('request')[0] as (req: IncomingMessage, res: ServerResponse) => void;
  server.removeAllListeners('request');
  server.on('request', (req: IncomingMessage, res: ServerResponse) => {
    if (isFunctionPeer(req.socket.remoteAddress, functionPeers, functionNets)) {
      res.writeHead(403, { 'Content-Type': 'text/plain' });
      return void res.end('Forbidden');
    }
    // DNS rebinding: a web page can point its own name at this server and
    // have a browser on your network sign in "locally". Only requests that
    // would count as local gain anything that way, so unknown names are
    // refused for those, and for anything from a proxy on this machine: a
    // browser on the server itself (Studio on 127.0.0.1) arrives from the
    // same address as Caddy would. Only Cloudflare Tunnel is exempt: it
    // serves just the names configured in Cloudflare.
    if (req.url !== '/health' && !viaTunnel(req) && !isKnownHost(req.headers.host, studioHosts()) && (fromLocalNetwork(req) || viaTrustedProxy(req))) {
      const message = `Studio doesn't answer to the name "${String(req.headers.host || '').slice(0, 100)}". Open it by IP address, or add the name to KEEL_STUDIO_HOSTS in .env.`;
      const api = (req.url || '').startsWith('/api/');
      res.writeHead(421, { 'Content-Type': api ? 'application/json' : 'text/plain; charset=utf-8', 'X-Content-Type-Options': 'nosniff' });
      return void res.end(api ? JSON.stringify({ error: 'unknown_host', message }) : message);
    }
    // Cross-site request forgery: the session cookie goes along with any
    // request the browser makes, so API calls must show they came from Studio.
    const forwardedHost = viaTrustedProxy(req) ? String(req.headers['x-forwarded-host'] || '').split(',')[0].trim() : '';
    const forged = csrfProblem(req, [String(req.headers.host || ''), forwardedHost, ...studioHosts().filter((h) => !h.includes('*'))].filter(Boolean));
    if (forged) {
      res.writeHead(403, { 'Content-Type': 'application/json', 'X-Content-Type-Options': 'nosniff' });
      return void res.end(JSON.stringify({ error: 'forbidden', message: forged }));
    }
    handle(req, res);
  });
  void refreshFunctionPeers();
  setInterval(() => void refreshFunctionPeers(), 30_000).unref();
  await listen(server, config.ports.studio, 'keel-studio');
}

let docsCheck: { at: number; ok: boolean } | null = null;

/** Asks the gateway (internally) whether it serves the documentation; cached for a minute. */
async function gatewayServesDocs(): Promise<boolean> {
  if (docsCheck && Date.now() - docsCheck.at < 60_000) return docsCheck.ok;
  let ok = false;
  try {
    const r = await fetch(`${config.services.gateway}/docs/llms.txt`, { method: 'HEAD', signal: AbortSignal.timeout(2000) });
    ok = r.status === 200;
  } catch {
    ok = false;
  }
  docsCheck = { at: Date.now(), ok };
  return ok;
}

/** Names Studio answers to besides IP addresses and local names: KEEL_STUDIO_HOSTS and the public addresses. */
function studioHosts(): string[] {
  const host = (url: string) => {
    try {
      return new URL(url).hostname;
    } catch {
      return '';
    }
  };
  return [...config.studioHosts.split(','), host(config.publicUrl), host(config.envPublicUrl), config.publicDbHost, config.hostLabel]
    .map((h) => h.trim())
    .filter(Boolean);
}

let functionPeers = new Set<string>();
let functionNets: ReturnType<typeof functionNetworks> = [];

/** The addresses of the keel-functions container, looked up through Docker's DNS, and its network. */
async function refreshFunctionPeers(): Promise<void> {
  try {
    const host = new URL(config.services.functions).hostname;
    const found = await dns.promises.lookup(host, { all: true });
    // Never block this machine, even if the functions URL points at it.
    functionPeers = new Set(found.map((a) => a.address).filter((a) => !/^(127\.|::1$)/.test(a)));
    // Only for a container name (Docker's DNS): a host elsewhere on the LAN
    // shares its network with everyone's laptops.
    functionNets = /^[a-z0-9_-]+$/i.test(host) ? functionNetworks(os.networkInterfaces(), [...functionPeers]) : [];
  } catch {
    // Keep the last known network: a container that is restarting is still there.
    functionPeers = new Set();
  }
}

const SMS_PROVIDERS = ['twilio', 'vonage', 'messagebird', 'webhook', 'log'];

/** Applies the phone section of a settings update; blank secrets keep the stored value. */
function mergePhone(prev: PhoneSettings, b: Record<string, any>): PhoneSettings {
  const str = (v: unknown, fallback?: string) => (typeof v === 'string' ? v.trim() : fallback);
  const secret = (v: unknown, fallback?: string) => (typeof v === 'string' && v.trim() ? v.trim() : fallback);
  const next: PhoneSettings = { ...prev };
  if (typeof b.enabled === 'boolean') next.enabled = b.enabled;
  if (typeof b.autoconfirm === 'boolean') next.autoconfirm = b.autoconfirm;
  if (b.provider !== undefined) {
    if (b.provider && !SMS_PROVIDERS.includes(b.provider)) throw new HttpError(400, 'Unknown SMS provider', 'bad_request');
    next.provider = b.provider || undefined;
  }
  if (typeof b.template === 'string') {
    if (b.template.trim() && !/\{\{\s*\.Code\s*\}\}/.test(b.template)) throw new HttpError(400, 'The SMS message must contain {{ .Code }}', 'bad_request');
    next.template = b.template.trim() || undefined;
  }
  if (b.otp_exp !== undefined) next.otp_exp = Math.max(30, Math.min(3600, Number(b.otp_exp) || 60));
  if (b.otp_length !== undefined) next.otp_length = Math.max(6, Math.min(10, Number(b.otp_length) || 6));
  if (typeof b.test_otp === 'string') {
    const map: Record<string, string> = {};
    for (const line of b.test_otp.split(/[\n,]/)) {
      const [num, code] = line.split('=').map((x: string) => x.trim());
      if (!num) continue;
      const digits = num.replace(/[^0-9]/g, '');
      if (!/^[1-9]\d{6,14}$/.test(digits) || !/^\d{4,10}$/.test(code || '')) throw new HttpError(400, `Test number "${line.trim()}" should look like 15555550100=123456`, 'bad_request');
      map[digits] = code;
    }
    next.test_otp = map;
  }
  if (b.twilio) next.twilio = { account_sid: str(b.twilio.account_sid, prev.twilio?.account_sid), auth_token: secret(b.twilio.auth_token, prev.twilio?.auth_token), message_service_sid: str(b.twilio.message_service_sid, prev.twilio?.message_service_sid), from: str(b.twilio.from, prev.twilio?.from) };
  if (b.vonage) next.vonage = { api_key: str(b.vonage.api_key, prev.vonage?.api_key), api_secret: secret(b.vonage.api_secret, prev.vonage?.api_secret), from: str(b.vonage.from, prev.vonage?.from) };
  if (b.messagebird) next.messagebird = { access_key: secret(b.messagebird.access_key, prev.messagebird?.access_key), originator: str(b.messagebird.originator, prev.messagebird?.originator) };
  if (b.webhook) {
    const url = str(b.webhook.url, prev.webhook?.url);
    if (url && !/^https?:\/\//.test(url)) throw new HttpError(400, 'Webhook URL must start with http:// or https://', 'bad_request');
    next.webhook = { url, secret: secret(b.webhook.secret, prev.webhook?.secret) };
  }
  return next;
}


type ColumnSpec = { name: string; type: string; default?: string; nullable?: boolean; pk?: boolean; unique?: boolean; references?: string };

const TYPE_RE = /^[a-z][a-z0-9_ ]*(\(\d+(,\s*\d+)?\))?(\[\])?$/i;

/** Builds CREATE TABLE from the New table form. Identifiers are quoted; types are validated. */
function createTableSql(body: Record<string, any>): string {
  const schema = String(body.schema || 'public');
  const name = String(body.name || '').trim();
  if (!/^[a-zA-Z_][a-zA-Z0-9_]{0,62}$/.test(name)) throw bad('Table names use letters, digits and underscores, and start with a letter.');
  const cols = (Array.isArray(body.columns) ? body.columns : []) as ColumnSpec[];
  if (!cols.length) throw bad('Add at least one column');
  const pks = cols.filter((c) => c.pk).map((c) => quoteIdent(c.name));
  const defs = cols.map((c) => {
    if (!/^[a-zA-Z_][a-zA-Z0-9_]{0,62}$/.test(c.name || '')) throw bad(`Invalid column name "${c.name}"`);
    const type = String(c.type || '').trim();
    if (!TYPE_RE.test(type)) throw bad(`Invalid type for ${c.name}`);
    let def = `${quoteIdent(c.name)} ${type}`;
    if (c.default && String(c.default).trim()) {
      const d = String(c.default).trim();
      if (d === 'identity') def = `${quoteIdent(c.name)} ${type} generated by default as identity`;
      else if (/^(now\(\)|gen_random_uuid\(\)|auth\.uid\(\)|true|false|null|-?\d+(\.\d+)?|current_date|'[^']*'(::[a-z0-9_ ]+)?|'\{\}'::[a-z0-9_]+\[\]|\{\}|'\{\}')$/i.test(d)) def += ` default ${d}`;
      else def += ` default ${quoteLiteral(d)}`;
    }
    if (c.nullable === false || c.pk) def += ' not null';
    if (c.unique && !c.pk) def += ' unique';
    if (c.references) {
      const m = /^([a-zA-Z_][a-zA-Z0-9_]*)\.([a-zA-Z_][a-zA-Z0-9_]*)\.([a-zA-Z_][a-zA-Z0-9_]*)$/.exec(c.references);
      if (!m) throw bad(`Invalid reference for ${c.name}`);
      def += ` references ${quoteIdent(m[1])}.${quoteIdent(m[2])} (${quoteIdent(m[3])}) on delete cascade`;
    }
    return def;
  });
  if (pks.length) defs.push(`primary key (${pks.join(', ')})`);
  let sql = `create table ${quoteIdent(schema)}.${quoteIdent(name)} (\n  ${defs.join(',\n  ')}\n);`;
  if (body.rls === false) sql += `\nalter table ${quoteIdent(schema)}.${quoteIdent(name)} disable row level security;`;
  else sql += `\nalter table ${quoteIdent(schema)}.${quoteIdent(name)} enable row level security;`;
  return sql;
}
