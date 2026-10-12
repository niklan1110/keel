import http from 'node:http';
import type pg from 'pg';
import { config, requireRolePassword } from '../lib/config.js';
import { pool } from '../lib/db.js';
import { loadPolicy, sendRequest, type EgressPolicy, type OutgoingRequest } from '../lib/egress.js';
import { log } from '../lib/log.js';
import { Registry, type Project } from '../lib/registry.js';

/**
 * keel-egress sends the HTTP requests a project's SQL queues (net.http_get,
 * net.http_post, database webhooks): the work pg_net's background worker
 * does on Supabase. The URLs, headers and bodies come from the project, so
 * it runs apart from everything that holds secrets: it logs in as
 * keel_egress_admin, which may only take requests off each project's queue
 * and write their responses (014_egress.sql), holds no superuser password,
 * and is not on the network of the Docker socket proxy. Requests follow the
 * edge functions' address rules (lib/egress.ts).
 *
 * Request bodies and headers are never written to the logs.
 */

const ROLE = 'keel_egress_admin';
const CLEANUP_MS = 60_000;

type State = { inflight: number; busy: boolean; recovered: boolean; cleanedAt: number };

export async function main(): Promise<void> {
  requireRolePassword(ROLE);
  const registry = new Registry(ROLE);
  await registry.start();
  const states = new Map<string, State>();
  // Its own small pool per project, with time limits: a project whose queue
  // is locked by its own sessions only holds up itself.
  const db = (p: Project) => pool(p.dbName, ROLE, 3, { name: 'egress', statementTimeoutMs: 15_000, lockTimeoutMs: 5_000 });
  const warned = new Map<string, number>();
  const warn = (key: string, msg: string, extra: Record<string, unknown>) => {
    if (Date.now() - (warned.get(key) || 0) < 60_000) return;
    warned.set(key, Date.now());
    log.warn(msg, extra);
  };
  const functionBases = () => [...new Set([config.publicUrl, config.envPublicUrl, config.services.gateway])];

  const respond = (d: pg.Pool, id: string, cols: { status?: number; contentType?: string | null; headers?: Record<string, string>; content?: string; timedOut?: boolean; error?: string }) =>
    d.query(
      `with r as (insert into net._http_response (id, status_code, content_type, headers, content, timed_out, error_msg) values ($1, $2, $3, $4, $5, $6, $7))
       delete from net._keel_sending where id = $1`,
      [id, cols.status ?? null, cols.contentType ?? null, cols.headers ?? null, cols.content ?? null, cols.timedOut ?? false, cols.error ?? null],
    );

  /** Requests a restart cut off get an error response instead of disappearing. */
  const recover = async (d: pg.Pool) => {
    await d.query(
      `with gone as (delete from net._keel_sending returning id)
       insert into net._http_response (id, timed_out, error_msg)
       select id, false, 'not sent: keel-egress restarted while sending it (requests are not retried)' from gone`,
    );
  };

  const sendQueued = async (p: Project, s: State) => {
    const room = config.net.concurrency - s.inflight;
    if (room <= 0) return;
    const d = db(p);
    // Checked before anything is taken off the queue: without it nothing is sent.
    let policy: EgressPolicy;
    try {
      policy = await loadPolicy();
    } catch (err) {
      return warn('policy', 'outgoing requests paused: could not work out which addresses to refuse', { error: (err as Error).message });
    }
    // Taken off the queue as they are sent, like pg_net: a request is sent at most once.
    const { rows } = await d.query(
      `with taken as (
         delete from net.http_request_queue
          where id in (select id from net.http_request_queue order by id limit $1 for update skip locked)
          returning id, method, url, headers, body, timeout_milliseconds
       ), marked as (insert into net._keel_sending (id) select id from taken)
       select id::text, method, url, headers, body, timeout_milliseconds from taken`,
      [room],
    );
    for (const r of rows) {
      s.inflight++;
      const send = async () => {
        const headers: Record<string, string> = {};
        for (const [k, v] of Object.entries((r.headers || {}) as Record<string, unknown>)) {
          headers[k] = typeof v === 'string' ? v : JSON.stringify(v);
        }
        const req: OutgoingRequest = {
          method: r.method,
          url: r.url,
          headers,
          body: r.body,
          timeoutMs: Math.max(1, Math.min(Number(r.timeout_milliseconds) || 5000, config.net.maxTimeoutMs)),
        };
        const out = await sendRequest(req, { project: p.name, policy, maxResponseBytes: config.net.maxResponseBytes, functionBases: functionBases(), gateway: config.services.gateway });
        await respond(
          d,
          r.id,
          out.ok ? { status: out.status, contentType: out.contentType, headers: out.headers, content: out.content } : { timedOut: out.timedOut, error: out.error },
        );
      };
      void send()
        .catch((err) => warn(`net:${p.name}`, 'could not record an HTTP response', { project: p.name, error: (err as Error).message }))
        .finally(() => s.inflight--);
    }
  };

  const tickProject = async (p: Project, s: State, now: number) => {
    const d = db(p);
    if (!s.recovered) {
      await recover(d);
      s.recovered = true;
    }
    await sendQueued(p, s);
    if (now - s.cleanedAt >= CLEANUP_MS) {
      s.cleanedAt = now;
      await d.query(`delete from net._http_response where created < now() - make_interval(hours => $1)`, [config.net.ttlHours]);
    }
  };

  // Each project ticks on its own, so a slow or locked one can't hold up the others.
  setInterval(() => {
    const now = Date.now();
    const projects = registry.list();
    for (const name of states.keys()) if (!projects.some((p) => p.name === name)) states.delete(name);
    for (const p of projects) {
      let s = states.get(p.name);
      if (!s) states.set(p.name, (s = { inflight: 0, busy: false, recovered: false, cleanedAt: 0 }));
      if (s.busy) continue;
      s.busy = true;
      const st = s;
      void tickProject(p, st, now)
        .catch((err) => {
          // A project created a moment ago may not have its schemas yet.
          if (!['3F000', '42P01'].includes((err as { code?: string }).code || '')) warn(`tick:${p.name}`, 'outgoing requests: project skipped', { project: p.name, error: (err as Error).message });
        })
        .finally(() => {
          st.busy = false;
        });
    }
  }, 1000).unref();

  const server = http.createServer((req, res) => {
    const ok = req.url === '/health';
    res.writeHead(ok ? 200 : 404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(ok ? { status: 'ok' } : { error: 'not found' }));
  });
  await new Promise<void>((r) => server.listen(config.ports.egress, '127.0.0.1', r));
  log.info(`keel-egress listening on port ${config.ports.egress}`, { concurrency: config.net.concurrency, max_timeout_ms: config.net.maxTimeoutMs });
}
