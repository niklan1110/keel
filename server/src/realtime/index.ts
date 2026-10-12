import crypto from 'node:crypto';
import http from 'node:http';
import { WebSocketServer, WebSocket, type RawData } from 'ws';
import { config, requireRolePassword } from '../lib/config.js';
import { asRole, newClient, pool, quoteIdent } from '../lib/db.js';
import { bearer, clientKey, readJson } from '../lib/http.js';
import { verify, type Claims } from '../lib/jwt.js';
import { log } from '../lib/log.js';
import { Registry, type Project } from '../lib/registry.js';
import { ConnectionLimits, LIMITS, RateLimiter, bindingsProblem, presenceBytes, roomKey, topicProblem } from './limits.js';
import { ProjectStream, type Change } from './replication.js';
import { pickKeys, policyCondition, rowCheckQuery, type SelectPolicy } from './visibility.js';

/**
 * keel-realtime speaks the Phoenix channel protocol used by
 * @supabase/realtime-js (serializer 1.0.0 and 2.0.0), supporting
 * broadcast, presence and postgres_changes with row level security.
 *
 * Private channels (config.private) follow Supabase Realtime Authorization:
 * RLS policies on realtime.messages decide who may receive (SELECT) and send
 * (INSERT) broadcast and presence messages on a topic. Public and private
 * channels with the same name are separate rooms. Rows inserted into
 * realtime.messages (realtime.send(), realtime.broadcast_changes()) are
 * broadcast to the matching room after commit.
 *
 * One process serves every project, so connections are held to the limits in
 * limits.ts (channels, presence size, message rate, frame size).
 */

type PgFilter = { column: string; op: string; value: string };
type PgBinding = { id: number; event: string; schema: string; table?: string; filter?: string; parsed: PgFilter | null };

type Perms = { broadcastRead: boolean; broadcastWrite: boolean; presenceRead: boolean; presenceWrite: boolean };
const ALL: Perms = { broadcastRead: true, broadcastWrite: true, presenceRead: true, presenceWrite: true };

type Join = {
  id: string;
  conn: Conn;
  topic: string;
  /** Room key (see roomKey): private and public channels with the same topic don't mix. */
  room: string;
  private: boolean;
  perms: Perms;
  joinRef: string | null;
  claims: Claims;
  broadcastSelf: boolean;
  broadcastAck: boolean;
  presenceKey: string;
  presenceRef: string | null;
  presenceMeta: Record<string, unknown> | null;
  pg: PgBinding[];
};

type Conn = {
  ws: WebSocket;
  project: Project;
  vsn: string;
  joins: Map<string, Join>; // by topic
  apiClaims: Claims;
  queue: Promise<unknown>;
  /** Inbound message rate limit. */
  limiter: RateLimiter;
  /** Messages received but not handled yet (see conn.queue), and their size. */
  pending: number;
  pendingBytes: number;
  /** Called when a channel is joined with a user's (or the service role's) token. */
  signedIn: () => void;
};

type TableMeta = { rls: boolean; pk: string[]; columns: string[]; at: number };

type ProjectState = {
  /** Joins by room (see roomKey). */
  topics: Map<string, Set<Join>>;
  stream: ProjectStream | null;
  /** LISTEN connection for messages broadcast from the database. */
  listener: { client: ReturnType<typeof newClient>; stop: () => void; ready: Promise<void> } | null;
  idleTimer: NodeJS.Timeout | null;
  tableMeta: Map<number, TableMeta>;
  privs: Map<string, { ok: boolean; at: number }>;
  /** SELECT policies that apply to a role, by `role:relid`. */
  policies: Map<string, { list: SelectPolicy[]; at: number }>;
};

const states = new Map<string, ProjectState>();
const META_TTL = 30_000;
/** Time limit for one RLS visibility check (policies may run sub-queries). */
const CHECK_TIMEOUT_MS = 5000;

const subTopic = (topic: string) => topic.replace(/^realtime:/, '');

function stateFor(name: string): ProjectState {
  let s = states.get(name);
  if (!s) {
    s = { topics: new Map(), stream: null, listener: null, idleTimer: null, tableMeta: new Map(), privs: new Map(), policies: new Map() };
    states.set(name, s);
  }
  return s;
}

// ------------------------------------------------------------------ wire format
function encode(conn: Conn, joinRef: string | null, ref: string | null, topic: string, event: string, payload: unknown): string {
  if (conn.vsn === '1.0.0') return JSON.stringify({ topic, event, payload, ref, join_ref: joinRef });
  return JSON.stringify([joinRef, ref, topic, event, payload]);
}

/** Sends a frame, dropping the connection if the client has stopped reading (its unsent data piles up in memory). */
function sendRaw(conn: Conn, data: string | Buffer) {
  if (conn.ws.readyState !== WebSocket.OPEN) return;
  if (conn.ws.bufferedAmount > LIMITS.maxBufferedBytes) {
    log.warn('realtime client too slow, disconnecting', { project: conn.project.name, buffered: conn.ws.bufferedAmount });
    conn.ws.terminate();
    return;
  }
  conn.ws.send(data);
}

function send(conn: Conn, joinRef: string | null, ref: string | null, topic: string, event: string, payload: unknown) {
  if (conn.ws.readyState !== WebSocket.OPEN) return;
  sendRaw(conn, encode(conn, joinRef, ref, topic, event, payload));
}

function reply(conn: Conn, joinRef: string | null, ref: string | null, topic: string, status: 'ok' | 'error', response: unknown = {}) {
  send(conn, joinRef, ref, topic, 'phx_reply', { status, response });
}

type Inbound = { joinRef: string | null; ref: string | null; topic: string; event: string; payload: any; binaryPayload?: Buffer; encoding?: number };

function decodeInbound(data: RawData, isBinary: boolean): Inbound | null {
  if (isBinary) {
    const buf = Buffer.isBuffer(data) ? data : Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data as ArrayBuffer);
    // kind 3: user broadcast push (serializer 2.0.0)
    if (buf[0] !== 3) return null;
    const lens = [buf[1], buf[2], buf[3], buf[4], buf[5]];
    const encoding = buf[6];
    let off = 7;
    const take = (n: number) => {
      const s = buf.toString('utf8', off, off + n);
      off += n;
      return s;
    };
    const joinRef = take(lens[0]) || null;
    const ref = take(lens[1]) || null;
    const topic = take(lens[2]);
    const userEvent = take(lens[3]);
    const meta = take(lens[4]);
    const body = buf.subarray(off);
    let userPayload: unknown = null;
    if (encoding === 1) {
      try {
        userPayload = JSON.parse(body.toString('utf8'));
      } catch {
        return null;
      }
    }
    const payload: Record<string, unknown> = { type: 'broadcast', event: userEvent, payload: userPayload };
    if (meta) {
      try {
        payload.meta = JSON.parse(meta);
      } catch {
        /* ignore bad metadata */
      }
    }
    return { joinRef, ref, topic, event: 'broadcast', payload, binaryPayload: encoding === 0 ? body : undefined, encoding };
  }
  let msg: unknown;
  try {
    msg = JSON.parse(data.toString());
  } catch {
    return null;
  }
  if (Array.isArray(msg)) {
    const [joinRef, ref, topic, event, payload] = msg;
    return { joinRef: joinRef ?? null, ref: ref ?? null, topic: String(topic), event: String(event), payload: payload ?? {} };
  }
  if (msg && typeof msg === 'object') {
    const m = msg as Record<string, any>;
    return { joinRef: m.join_ref ?? null, ref: m.ref ?? null, topic: String(m.topic), event: String(m.event), payload: m.payload ?? {} };
  }
  return null;
}

/** Binary "user broadcast" frame (kind 4) for serializer 2.0.0 clients. */
function encodeBinaryBroadcast(topic: string, event: string, body: Buffer, encoding: number): Buffer {
  const t = Buffer.from(topic);
  const e = Buffer.from(event);
  const header = Buffer.from([4, t.length, e.length, 0, encoding]);
  return Buffer.concat([header, t, e, body]);
}

// ------------------------------------------------------------------ postgres_changes filters
const FILTER_OPS = new Set(['eq', 'neq', 'lt', 'lte', 'gt', 'gte', 'in']);

function parseFilter(filter: string | undefined): PgFilter | null {
  if (!filter) return null;
  const m = /^([^=]+)=([a-z]+)\.(.*)$/s.exec(filter);
  if (!m || !FILTER_OPS.has(m[2])) throw new Error(`invalid filter "${filter}"`);
  return { column: m[1].trim(), op: m[2], value: m[3] };
}

function compare(a: unknown, b: string): number {
  const na = typeof a === 'number' ? a : Number(a);
  const nb = Number(b);
  if (a !== null && a !== '' && b !== '' && Number.isFinite(na) && Number.isFinite(nb)) return na - nb;
  return String(a).localeCompare(b);
}

function filterMatches(f: PgFilter | null, row: Record<string, unknown>): boolean {
  if (!f) return true;
  if (!(f.column in row)) return false;
  const v = row[f.column];
  const s = v === null ? 'null' : typeof v === 'object' ? JSON.stringify(v) : String(v);
  switch (f.op) {
    case 'eq': return s === f.value;
    case 'neq': return s !== f.value;
    case 'lt': return compare(v, f.value) < 0;
    case 'lte': return compare(v, f.value) <= 0;
    case 'gt': return compare(v, f.value) > 0;
    case 'gte': return compare(v, f.value) >= 0;
    case 'in': {
      const list = f.value.replace(/^\(|\)$/g, '').split(',').map((x) => x.trim().replace(/^"(.*)"$/, '$1'));
      return list.includes(s);
    }
    default: return false;
  }
}

function bindingMatches(b: PgBinding, c: Change): boolean {
  if (b.event !== '*' && b.event.toUpperCase() !== c.type) return false;
  if (b.schema !== '*' && b.schema !== c.schema) return false;
  if (b.table && b.table !== '*' && b.table !== c.table) return false;
  return filterMatches(b.parsed, c.type === 'DELETE' ? c.old_record : c.record);
}

// ------------------------------------------------------------------ RLS
async function tableMeta(project: Project, st: ProjectState, relid: number): Promise<TableMeta> {
  const cached = st.tableMeta.get(relid);
  if (cached && Date.now() - cached.at < META_TTL) return cached;
  const { rows } = await pool(project.dbName, 'keel_realtime_admin', 4).query(
    `select c.relrowsecurity as rls,
            array(select a.attname::text from pg_index i join pg_attribute a on a.attrelid = i.indrelid and a.attnum = any(i.indkey)
                   where i.indrelid = c.oid and i.indisprimary order by a.attnum) as pk,
            array(select a.attname::text from pg_attribute a
                   where a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped order by a.attnum) as columns
       from pg_class c where c.oid = $1`,
    [relid],
  );
  // A table that has gone away is treated as protected: nothing is visible.
  const meta: TableMeta = {
    rls: rows[0] ? !!rows[0].rls : true,
    pk: (rows[0]?.pk as string[]) || [],
    columns: (rows[0]?.columns as string[]) || [],
    at: Date.now(),
  };
  st.tableMeta.set(relid, meta);
  return meta;
}

/** The role may select from the table (and use its schema), as a query through the API would need. */
async function hasSelect(project: Project, st: ProjectState, role: string, relid: number): Promise<boolean> {
  const key = `${role}:${relid}`;
  const cached = st.privs.get(key);
  if (cached && Date.now() - cached.at < META_TTL) return cached.ok;
  const { rows } = await pool(project.dbName, 'keel_realtime_admin', 4).query(
    `select has_table_privilege($1, c.oid, 'SELECT') and has_schema_privilege($1, c.relnamespace, 'USAGE') as ok
       from pg_class c where c.oid = $2::oid`,
    [role, relid],
  );
  const ok = !!rows[0]?.ok;
  st.privs.set(key, { ok, at: Date.now() });
  return ok;
}

/**
 * What a subscriber may receive of a change: null when nothing, otherwise
 * the `old_record` to send. On tables with RLS, updates only carry the old
 * row's primary key (as on Supabase): the policies were checked against the
 * new row, not the old one. Deletes carry the old row the policies were
 * checked against.
 */
async function visibleChange(project: Project, st: ProjectState, claims: Claims, change: Change): Promise<{ old: Record<string, unknown> } | null> {
  const role = typeof claims.role === 'string' ? claims.role : 'anon';
  if (role === 'service_role') return { old: change.old_record };
  if (role !== 'anon' && role !== 'authenticated') return null;
  if (!(await hasSelect(project, st, role, change.relid))) return null;
  const meta = await tableMeta(project, st, change.relid);
  if (!meta.rls) return { old: change.old_record };
  if (!(await rowVisible(project, st, claims, role, change, meta))) return null;
  return { old: change.type === 'UPDATE' ? pickKeys(change.old_record, meta.pk) : change.old_record };
}

/** The table's SELECT policies that apply to `role` (directly, through PUBLIC or through role membership, as in Postgres). */
async function selectPolicies(project: Project, st: ProjectState, relid: number, role: string): Promise<SelectPolicy[]> {
  const key = `${role}:${relid}`;
  const cached = st.policies.get(key);
  if (cached && Date.now() - cached.at < 5000) return cached.list;
  const { rows } = await pool(project.dbName, 'keel_realtime_admin', 4).query(
    `select p.polpermissive as permissive, pg_get_expr(p.polqual, p.polrelid) as qual
       from pg_policy p
      where p.polrelid = $1::oid and p.polcmd in ('r', '*')
        and exists (select 1 from unnest(p.polroles) as r(roleid) where r.roleid = 0 or pg_has_role($2::name, r.roleid, 'USAGE'))`,
    [relid, role],
  );
  st.policies.set(key, { list: rows, at: Date.now() });
  return rows;
}

const policyWarned = new Map<string, number>();

/**
 * Evaluates the table's SELECT policies, as the subscriber and with their JWT
 * claims, against the row as it was written to the WAL: the new row for
 * inserts and updates, the old row for deletes (see visibility.ts). The
 * current contents of the table don't decide what a change reveals. Any
 * error means "not visible".
 */
async function rowVisible(project: Project, st: ProjectState, claims: Claims, role: string, change: Change, meta: TableMeta): Promise<boolean> {
  const condition = policyCondition(await selectPolicies(project, st, change.relid, role));
  if (!condition) return false;
  // TOASTed values an update didn't touch are only in the old row (with REPLICA IDENTITY FULL).
  const row: Record<string, string | null> = change.type === 'UPDATE' ? Object.assign(Object.create(null), change.oldRaw, change.raw) : change.raw;
  const q = rowCheckQuery({
    schema: change.schema,
    table: change.table,
    columns: meta.columns,
    pk: meta.pk,
    row,
    fillFromCurrent: change.type !== 'DELETE',
    condition,
  });
  if (!q) return false;
  try {
    const rows = await asRole(pool(project.dbName, 'keel_realtime_admin', 8), claims, async (c) => {
      await c.query(`set local statement_timeout = ${CHECK_TIMEOUT_MS}`);
      return (await c.query(q.text, q.values)).rows;
    });
    return rows.length > 0;
  } catch (err) {
    // Usually a policy that can't run on a copy of the row (e.g. it reads system columns). Log now and then.
    const key = `${project.name}:${change.relid}`;
    if (Date.now() - (policyWarned.get(key) || 0) > 60_000) {
      policyWarned.set(key, Date.now());
      log.warn('realtime policy check failed; change withheld', { project: project.name, table: `${change.schema}.${change.table}`, error: (err as Error).message });
    }
    return false;
  }
}

// ------------------------------------------------------------------ private channel authorization
/**
 * Works out what the caller may do on a private topic by asking Postgres:
 * inside a transaction that is always rolled back, probe rows are inserted
 * into realtime.messages, then (as the caller's role, with their JWT claims
 * and realtime.topic set) we check which of them are visible (read) and
 * whether inserting is allowed (write).
 */
async function authorize(project: Project, claims: Claims, topic: string): Promise<Perms> {
  const role = typeof claims.role === 'string' ? claims.role : 'anon';
  if (role === 'service_role') return ALL;
  const none = { broadcastRead: false, broadcastWrite: false, presenceRead: false, presenceWrite: false };
  if (role !== 'anon' && role !== 'authenticated') return none;
  const c = await pool(project.dbName, 'keel_realtime_admin', 8).connect();
  try {
    await c.query('begin');
    const { rows } = await c.query(
      `insert into realtime.messages (topic, extension, private) values ($1, 'broadcast', true), ($1, 'presence', true) returning id, extension`,
      [topic],
    );
    await c.query(`set local role ${quoteIdent(role)}`);
    await c.query(
      `select set_config('request.jwt.claims', $1, true), set_config('request.jwt.claim.sub', $2, true),
              set_config('request.jwt.claim.role', $3, true), set_config('realtime.topic', $4, true)`,
      [JSON.stringify(claims), typeof claims.sub === 'string' ? claims.sub : '', role, topic],
    );
    const seen = new Set(
      (await c.query(`select extension from realtime.messages where id = any($1::uuid[])`, [rows.map((r) => r.id)])).rows.map((r) => r.extension as string),
    );
    const canWrite = async (extension: string) => {
      await c.query('savepoint probe');
      try {
        await c.query(`insert into realtime.messages (topic, extension, private) values ($1, $2, true)`, [topic, extension]);
        return true;
      } catch {
        return false;
      } finally {
        await c.query('rollback to savepoint probe');
      }
    };
    return {
      broadcastRead: seen.has('broadcast'),
      presenceRead: seen.has('presence'),
      broadcastWrite: await canWrite('broadcast'),
      presenceWrite: await canWrite('presence'),
    };
  } catch (err) {
    log.warn('realtime authorization check failed', { project: project.name, topic, error: (err as Error).message });
    return none;
  } finally {
    await c.query('rollback').catch(() => {});
    c.release();
  }
}

// ------------------------------------------------------------------ broadcast from the database
function ensureListener(project: Project) {
  const st = stateFor(project.name);
  if (st.listener) return;
  let stopped = false;
  const client = newClient(project.dbName, 'keel_realtime_admin');
  const stop = () => {
    stopped = true;
    void client.end().catch(() => {});
  };
  // Resolves when LISTEN is active (or the attempt failed), bounded so a join never hangs.
  let markReady: () => void = () => {};
  const ready = new Promise<void>((resolve) => {
    markReady = resolve;
    setTimeout(resolve, 5000).unref();
  });
  st.listener = { client, stop, ready };
  const restart = () => {
    if (stopped) return;
    if (st.listener?.client === client) st.listener = null;
    // Reconnect while channels are still open.
    setTimeout(() => {
      if (st.topics.size && registryRef?.get(project.name)) ensureListener(registryRef.get(project.name)!);
    }, 2000);
  };
  client.on('error', restart);
  client.on('end', restart);
  client.on('notification', (n) => {
    if (!n.payload) return;
    void client
      .query(`select topic, event, payload, private from realtime.messages where id = $1 and extension = 'broadcast'`, [n.payload])
      .then(({ rows }) => {
        const msg = rows[0];
        if (!msg) return;
        const topic = `realtime:${msg.topic}`;
        broadcastRoom(st, roomKey(topic, !!msg.private), topic, 'broadcast', { type: 'broadcast', event: msg.event, payload: msg.payload }, {
          need: 'broadcastRead',
        });
      })
      .catch((err) => log.warn('realtime message fetch failed', { project: project.name, error: err.message }));
  });
  client
    .connect()
    .then(() => client.query('listen keel_realtime_messages'))
    .then(() => markReady())
    .catch((err) => {
      markReady();
      log.warn('realtime listener failed', { project: project.name, error: err.message });
      restart();
    });
}

let registryRef: Registry | null = null;

// ------------------------------------------------------------------ fan-out
function deliverChange(project: Project, st: ProjectState, change: Change) {
  const byJoin = new Map<Join, number[]>();
  for (const joins of st.topics.values()) {
    for (const j of joins) {
      for (const b of j.pg) {
        if (!bindingMatches(b, change)) continue;
        // Push, not spread: copying the list per binding was quadratic in the bindings of a join.
        const ids = byJoin.get(j);
        if (ids) ids.push(b.id);
        else byJoin.set(j, [b.id]);
      }
    }
  }
  if (!byJoin.size) return;
  // One check per distinct set of claims: policies may read any claim, not just role and sub.
  const cache = new Map<string, Promise<{ old: Record<string, unknown> } | null>>();
  for (const [j, ids] of byJoin) {
    const ck = JSON.stringify(j.claims);
    let p = cache.get(ck);
    if (!p) {
      p = visibleChange(project, st, j.claims, change).catch((err) => {
        log.warn('realtime visibility check failed', { project: project.name, error: (err as Error).message });
        return null;
      });
      cache.set(ck, p);
    }
    void p.then((visible) => {
      if (!visible) return;
      const old = visible.old;
      send(j.conn, null, null, j.topic, 'postgres_changes', {
        ids,
        data: {
          schema: change.schema,
          table: change.table,
          commit_timestamp: change.commit_timestamp,
          type: change.type,
          columns: change.columns,
          record: change.type === 'DELETE' ? undefined : change.record,
          old_record: change.type === 'INSERT' ? undefined : old,
          errors: null,
        },
      });
    });
  }
}

function ensureStream(project: Project) {
  const st = stateFor(project.name);
  if (st.idleTimer) {
    clearTimeout(st.idleTimer);
    st.idleTimer = null;
  }
  if (st.stream) return;
  const stream = new ProjectStream(project);
  stream.on('change', (c: Change) => deliverChange(project, st, c));
  stream.on('relation', (relid: number) => st.tableMeta.delete(relid));
  st.stream = stream;
  stream.start();
}

function maybeStopStream(projectName: string) {
  const st = states.get(projectName);
  if (!st || !st.stream) return;
  const hasPg = [...st.topics.values()].some((set) => [...set].some((j) => j.pg.length));
  if (hasPg || st.idleTimer) return;
  st.idleTimer = setTimeout(() => {
    st.idleTimer = null;
    const still = [...st.topics.values()].some((set) => [...set].some((j) => j.pg.length));
    if (!still && st.stream) {
      void st.stream.stop();
      st.stream = null;
      log.info('realtime replication stopped (no subscribers)', { project: projectName });
    }
  }, 60_000);
}

// ------------------------------------------------------------------ presence
function presenceState(st: ProjectState, room: string) {
  // No prototype: presence keys are client input ("constructor", "__proto__", ...).
  const out: Record<string, { metas: unknown[] }> = Object.create(null);
  for (const j of st.topics.get(room) || []) {
    if (!j.presenceMeta) continue;
    (out[j.presenceKey] ||= { metas: [] }).metas.push({ phx_ref: j.presenceRef, ...j.presenceMeta });
  }
  return out;
}

function broadcastRoom(st: ProjectState, room: string, topic: string, event: string, payload: unknown, opts: { except?: Join; need?: keyof Perms } = {}) {
  for (const j of st.topics.get(room) || []) {
    if (j === opts.except) continue;
    if (opts.need && !j.perms[opts.need]) continue;
    send(j.conn, null, null, topic, event, payload);
  }
}

function presenceLeave(st: ProjectState, j: Join) {
  if (!j.presenceMeta) return;
  const leaves = { [j.presenceKey]: { metas: [{ phx_ref: j.presenceRef, ...j.presenceMeta }] } };
  j.presenceMeta = null;
  j.presenceRef = null;
  broadcastRoom(st, j.room, j.topic, 'presence_diff', { joins: {}, leaves }, { need: 'presenceRead' });
}

// ------------------------------------------------------------------ channel lifecycle
function leave(j: Join) {
  const st = stateFor(j.conn.project.name);
  presenceLeave(st, j);
  const set = st.topics.get(j.room);
  set?.delete(j);
  if (set && !set.size) st.topics.delete(j.room);
  j.conn.joins.delete(j.topic);
  maybeStopStream(j.conn.project.name);
  if (!st.topics.size && st.listener) {
    st.listener.stop();
    st.listener = null;
  }
}

function verifyToken(project: Project, token: unknown): Claims {
  if (typeof token !== 'string' || !token) throw new Error('missing access token');
  const claims = verify(token, project.jwtKeys);
  if (claims.ref && claims.ref !== project.name) throw new Error('token is for another project');
  return claims;
}

async function handleJoin(conn: Conn, m: Inbound) {
  const { project } = conn;
  const st = stateFor(project.name);
  const problem = topicProblem(m.topic);
  if (problem) return reply(conn, m.joinRef, m.ref, m.topic, 'error', { reason: problem });
  if (!conn.joins.has(m.topic) && conn.joins.size >= LIMITS.maxChannelsPerConnection) {
    return reply(conn, m.joinRef, m.ref, m.topic, 'error', { reason: 'ChannelRateLimitReached: Too many channels' });
  }
  const cfg = (m.payload?.config && typeof m.payload.config === 'object' ? m.payload.config : {}) as Record<string, any>;
  const isPrivate = !!cfg.private;
  if (!isPrivate && project.settings.realtime?.private_only) {
    return reply(conn, m.joinRef, m.ref, m.topic, 'error', { reason: 'PrivateOnly: This project only allows private channels' });
  }
  let claims: Claims;
  try {
    claims = m.payload?.access_token ? verifyToken(project, m.payload.access_token) : conn.apiClaims;
    if (claims.role && claims.role !== 'anon') conn.signedIn();
  } catch (err) {
    return reply(conn, m.joinRef, m.ref, m.topic, 'error', { reason: `Invalid token: ${(err as Error).message}` });
  }
  let perms = ALL;
  if (isPrivate) {
    perms = await authorize(project, claims, subTopic(m.topic));
    if (!perms.broadcastRead && !perms.presenceRead) {
      return reply(conn, m.joinRef, m.ref, m.topic, 'error', {
        reason: `Unauthorized: You do not have permissions to read from this Channel topic: ${subTopic(m.topic)}`,
      });
    }
    if (conn.ws.readyState !== WebSocket.OPEN) return;
  }

  const existing = conn.joins.get(m.topic);
  if (existing) leave(existing);

  const tooMany = bindingsProblem(cfg.postgres_changes);
  if (tooMany) return reply(conn, m.joinRef, m.ref, m.topic, 'error', { reason: tooMany });
  const bindings: PgBinding[] = [];
  try {
    for (const b of (Array.isArray(cfg.postgres_changes) ? cfg.postgres_changes : []) as Record<string, string>[]) {
      bindings.push({
        id: crypto.randomInt(1, 2 ** 31),
        event: String(b.event || '*'),
        schema: String(b.schema || 'public'),
        table: b.table,
        filter: b.filter,
        parsed: parseFilter(b.filter),
      });
    }
  } catch (err) {
    return reply(conn, m.joinRef, m.ref, m.topic, 'error', { reason: (err as Error).message });
  }

  const j: Join = {
    id: crypto.randomUUID(),
    conn,
    topic: m.topic,
    room: roomKey(m.topic, isPrivate),
    private: isPrivate,
    perms,
    joinRef: m.joinRef,
    claims,
    broadcastSelf: !!cfg.broadcast?.self,
    broadcastAck: !!cfg.broadcast?.ack,
    presenceKey: cfg.presence?.key ? String(cfg.presence.key) : crypto.randomUUID(),
    presenceRef: null,
    presenceMeta: null,
    pg: bindings,
  };
  conn.joins.set(m.topic, j);
  let set = st.topics.get(j.room);
  if (!set) st.topics.set(j.room, (set = new Set()));
  set.add(j);
  ensureListener(project);
  if (bindings.length) ensureStream(project);
  // Confirm the join only once database broadcasts and changes can reach it,
  // so nothing committed after the client sees SUBSCRIBED is missed.
  await Promise.all([st.listener?.ready, bindings.length ? st.stream?.whenReady() : undefined]);
  if (conn.joins.get(m.topic) !== j || conn.ws.readyState !== WebSocket.OPEN) return;

  reply(conn, m.joinRef, m.ref, m.topic, 'ok', {
    postgres_changes: bindings.map((b) => ({ id: b.id, event: b.event, schema: b.schema, table: b.table, filter: b.filter })),
  });
  if (bindings.length) {
    send(conn, m.joinRef, null, m.topic, 'system', {
      status: 'ok',
      message: 'Subscribed to PostgreSQL',
      extension: 'postgres_changes',
      channel: m.topic.replace(/^realtime:/, ''),
    });
  }
  if (cfg.presence?.enabled !== false && perms.presenceRead) send(conn, m.joinRef, null, m.topic, 'presence_state', presenceState(st, j.room));
}

async function handleMessage(conn: Conn, m: Inbound) {
  // Messages queued behind a slow one may run after the client has gone: don't let them join anything.
  if (conn.ws.readyState !== WebSocket.OPEN) return;
  const st = stateFor(conn.project.name);
  if (m.topic === 'phoenix' && m.event === 'heartbeat') return reply(conn, null, m.ref, 'phoenix', 'ok');
  if (m.event === 'phx_join') return handleJoin(conn, m);

  const j = conn.joins.get(m.topic);
  if (!j) return reply(conn, m.joinRef, m.ref, m.topic, 'error', { reason: 'unmatched topic' });

  switch (m.event) {
    case 'phx_leave':
      leave(j);
      reply(conn, m.joinRef, m.ref, m.topic, 'ok');
      send(conn, m.joinRef, null, m.topic, 'phx_close', {});
      return;
    case 'access_token':
      try {
        j.claims = verifyToken(conn.project, m.payload?.access_token);
        if (j.claims.role && j.claims.role !== 'anon') conn.signedIn();
        if (j.private) {
          // A new token may carry different rights: check again.
          j.perms = await authorize(conn.project, j.claims, subTopic(j.topic));
          if (!j.perms.broadcastRead && !j.perms.presenceRead) {
            send(conn, j.joinRef, null, j.topic, 'system', { status: 'error', message: 'Unauthorized: You do not have permissions to read from this Channel topic', extension: 'system', channel: subTopic(j.topic) });
            send(conn, j.joinRef, null, j.topic, 'phx_close', {});
            leave(j);
            return;
          }
        }
        if (m.ref) reply(conn, m.joinRef, m.ref, m.topic, 'ok');
      } catch (err) {
        reply(conn, m.joinRef, m.ref, m.topic, 'error', { reason: `Invalid token: ${(err as Error).message}` });
      }
      return;
    case 'broadcast': {
      const p = m.payload || {};
      if (!j.perms.broadcastWrite) {
        if (m.ref) reply(conn, m.joinRef, m.ref, m.topic, 'error', { reason: 'Unauthorized: You do not have permissions to write to this Channel topic' });
        return;
      }
      for (const other of st.topics.get(j.room) || []) {
        if (other === j && !j.broadcastSelf) continue;
        if (!other.perms.broadcastRead) continue;
        if (other.conn.ws.readyState !== WebSocket.OPEN) continue;
        if (m.binaryPayload && other.conn.vsn !== '1.0.0') {
          sendRaw(other.conn, encodeBinaryBroadcast(m.topic, String(p.event || ''), m.binaryPayload, 0));
        } else {
          send(other.conn, null, null, m.topic, 'broadcast', { type: 'broadcast', event: p.event, payload: p.payload, ...(p.meta ? { meta: p.meta } : {}) });
        }
      }
      if (j.broadcastAck && m.ref) reply(conn, m.joinRef, m.ref, m.topic, 'ok');
      return;
    }
    case 'presence': {
      const p = m.payload || {};
      if (!j.perms.presenceWrite) {
        if (m.ref) reply(conn, m.joinRef, m.ref, m.topic, 'error', { reason: 'Unauthorized: You do not have permissions to track presence on this Channel topic' });
        return;
      }
      if (p.event === 'track') {
        const meta = (p.payload && typeof p.payload === 'object' ? p.payload : {}) as Record<string, unknown>;
        if (presenceBytes(j.presenceKey, meta) > LIMITS.maxPresenceBytes) {
          if (m.ref) reply(conn, m.joinRef, m.ref, m.topic, 'error', { reason: `PayloadTooLarge: Presence state is larger than ${LIMITS.maxPresenceBytes / 1024} KB` });
          return;
        }
        if (!j.presenceMeta && [...conn.joins.values()].filter((o) => o.presenceMeta).length >= LIMITS.maxPresencePerConnection) {
          if (m.ref) {
            reply(conn, m.joinRef, m.ref, m.topic, 'error', {
              reason: `TooManyPresences: A connection can track presence on at most ${LIMITS.maxPresencePerConnection} channels`,
            });
          }
          return;
        }
        const prev = j.presenceMeta ? { [j.presenceKey]: { metas: [{ phx_ref: j.presenceRef, ...j.presenceMeta }] } } : {};
        j.presenceRef = crypto.randomBytes(9).toString('base64url');
        j.presenceMeta = meta;
        const joins = { [j.presenceKey]: { metas: [{ phx_ref: j.presenceRef, ...j.presenceMeta }] } };
        broadcastRoom(st, j.room, m.topic, 'presence_diff', { joins, leaves: prev }, { need: 'presenceRead' });
      } else if (p.event === 'untrack') {
        presenceLeave(st, j);
      }
      if (m.ref) reply(conn, m.joinRef, m.ref, m.topic, 'ok');
      return;
    }
    default:
      if (m.ref) reply(conn, m.joinRef, m.ref, m.topic, 'ok');
  }
}

// ------------------------------------------------------------------ HTTP broadcast API
type HttpMessage = { topic: string; event: unknown; payload: unknown; private?: unknown };

async function httpBroadcast(registry: Registry, req: http.IncomingMessage, res: http.ServerResponse, url: URL) {
  const project = registry.get(String(req.headers['x-keel-project'] || ''));
  const respond = (status: number, body: unknown) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  if (!project) return respond(404, { message: 'Unknown project' });
  let claims: Claims;
  try {
    claims = verifyToken(project, bearer(req) || req.headers['apikey']);
  } catch {
    return respond(401, { message: 'Invalid token' });
  }
  const st = stateFor(project.name);
  const body = await readJson(req, 1024 * 1024).catch(() => null);
  if (!body) return respond(400, { message: 'Invalid JSON body' });
  const single = /^\/api\/broadcast\/([^/]+)\/events\/([^/]+)$/.exec(url.pathname);
  let messages: unknown[];
  if (single) {
    try {
      messages = [{ topic: decodeURIComponent(single[1]), event: decodeURIComponent(single[2]), payload: body, private: url.searchParams.get('private') === 'true' }];
    } catch {
      return respond(400, { message: 'Malformed URL encoding' });
    }
  } else {
    messages = Array.isArray((body as any).messages) ? (body as any).messages : [];
  }

  // Check the whole request before sending anything.
  if (messages.length > LIMITS.httpMaxMessages) {
    return respond(400, { message: `Too many messages: at most ${LIMITS.httpMaxMessages} per request` });
  }
  const privateTopics = new Set<string>();
  for (const msg of messages) {
    if (!msg || typeof msg !== 'object' || typeof (msg as HttpMessage).topic !== 'string') {
      return respond(400, { message: 'Invalid message: topic must be a string' });
    }
    const problem = topicProblem(`realtime:${(msg as HttpMessage).topic}`);
    if (problem) return respond(400, { message: problem });
    if ((msg as HttpMessage).private) privateTopics.add((msg as HttpMessage).topic);
  }
  if (privateTopics.size > LIMITS.httpMaxPrivateTopics) {
    return respond(400, { message: `Too many private topics: at most ${LIMITS.httpMaxPrivateTopics} per request` });
  }

  const allowed = new Map<string, boolean>();
  for (const msg of messages as HttpMessage[]) {
    const isPrivate = !!msg.private;
    if (!isPrivate && project.settings.realtime?.private_only) continue;
    if (isPrivate) {
      let ok = allowed.get(msg.topic);
      if (ok === undefined) {
        ok = (await authorize(project, claims, msg.topic)).broadcastWrite;
        allowed.set(msg.topic, ok);
      }
      if (!ok) continue;
    }
    const topic = `realtime:${msg.topic}`;
    broadcastRoom(st, roomKey(topic, isPrivate), topic, 'broadcast', { type: 'broadcast', event: msg.event, payload: msg.payload }, { need: 'broadcastRead' });
  }
  respond(202, {});
}

/** Size of a WebSocket message as received. */
function frameBytes(data: RawData): number {
  if (Buffer.isBuffer(data)) return data.length;
  if (Array.isArray(data)) return data.reduce((n, b) => n + b.length, 0);
  return data.byteLength;
}

export async function main(): Promise<void> {
  requireRolePassword('keel_realtime_admin');
  const registry = new Registry('keel_realtime_admin');
  await registry.start();
  registryRef = registry;
  registry.on('change', () => {
    for (const [name, st] of states) {
      if (!registry.get(name)) {
        void st.stream?.stop();
        st.listener?.stop();
        states.delete(name);
      }
    }
  });

  // Broadcast messages stored in realtime.messages are only needed briefly.
  const prune = async () => {
    for (const p of registry.list()) {
      await pool(p.dbName, 'keel_realtime_admin', 4)
        .query(`delete from realtime.messages where inserted_at < now() - interval '24 hours'`)
        .catch(() => {});
    }
  };
  setInterval(() => void prune(), 60 * 60_000).unref();
  setTimeout(() => void prune(), 30_000).unref();

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url || '/', 'http://local');
      if (url.pathname === '/health') {
        // Reachable through the gateway with any project's key, so no per-project details.
        const body = JSON.stringify({ status: 'ok' });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return void res.end(body);
      }
      if (req.method === 'POST' && url.pathname.startsWith('/api/broadcast')) return await httpBroadcast(registry, req, res, url);
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ message: 'Not found' }));
    } catch (err) {
      log.warn('realtime request failed', { error: (err as Error).message });
      if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ message: 'Internal error' }));
    }
  });

  const wss = new WebSocketServer({ noServer: true, maxPayload: LIMITS.maxFrameBytes });
  // Open connections per client address in a project, and anonymous ones per project.
  const limits = new ConnectionLimits(config.limits.realtimePerIp, config.limits.realtimePerProject);
  const warnedFull = new Map<string, number>();
  const warnLimit = (project: string, address: string, what: string) => {
    if (Date.now() - (warnedFull.get(project) || 0) < 60_000) return;
    warnedFull.set(project, Date.now());
    const n = limits.usage(project, address);
    log.warn(`realtime connection limit reached: ${what}`, { project, per_address: n.address, anonymous_in_project: n.project });
  };
  server.on('upgrade', (req, socket, head) => {
    let url: URL;
    try {
      url = new URL(req.url || '/', 'http://local');
    } catch {
      socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
      return;
    }
    const project = registry.get(String(req.headers['x-keel-project'] || ''));
    if (!project || !/\/websocket$/.test(url.pathname)) {
      socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
      return;
    }
    let apiClaims: Claims;
    try {
      apiClaims = verifyToken(project, url.searchParams.get('apikey'));
    } catch {
      socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
      return;
    }
    const address = clientKey(req);
    const ticket = limits.admit(project.name, address, apiClaims.role === 'service_role');
    if (!ticket) {
      warnLimit(project.name, address, 'too many from one address');
      socket.end('HTTP/1.1 429 Too Many Requests\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
      return;
    }
    socket.once('close', () => ticket.close());
    if (ticket.probation) warnLimit(project.name, address, 'too many anonymous connections; new ones must sign in on a channel');
    wss.handleUpgrade(req, socket, head, (ws) => {
      // Over the project's cap for anonymous sockets: sign in on a channel soon, or go.
      const probation = ticket.probation
        ? setTimeout(() => {
            if (ticket.probation) ws.close(1008, 'Too many connections for this project');
          }, LIMITS.signInGraceMs)
        : null;
      probation?.unref();
      ws.once('close', () => probation && clearTimeout(probation));
      const conn: Conn = {
        ws,
        project,
        vsn: url.searchParams.get('vsn') || '1.0.0',
        joins: new Map(),
        apiClaims,
        queue: Promise.resolve(),
        limiter: new RateLimiter(),
        pending: 0,
        pendingBytes: 0,
        signedIn: ticket.signedIn,
      };
      let alive = true;
      const ping = setInterval(() => {
        if (!alive) return ws.terminate();
        alive = false;
        ws.ping();
      }, 30_000);
      ws.on('pong', () => (alive = true));
      ws.on('message', (data, isBinary) => {
        alive = true;
        if (ws.readyState !== WebSocket.OPEN) return;
        const rate = conn.limiter.hit();
        if (rate === 'close') {
          // Still sending far above the limit after being told: disconnect.
          log.warn('realtime client over the message rate limit, disconnecting', { project: project.name });
          ws.close(1008, 'Too many messages per second');
          return;
        }
        const size = frameBytes(data);
        const m = decodeInbound(data, isBinary);
        if (!m) return;
        const backlog = conn.pending >= LIMITS.maxPendingMessages || conn.pendingBytes + size > LIMITS.maxPendingBytes;
        if (rate === 'drop' || backlog) {
          const reason = rate === 'drop' ? 'RateLimitReached: Too many messages per second' : 'RateLimitReached: Too many messages waiting to be handled';
          if (m.ref) reply(conn, m.joinRef, m.ref, m.topic, 'error', { reason });
          return;
        }
        conn.pending++;
        conn.pendingBytes += size;
        // Messages for one connection are handled in order (joins may wait on an authorization check).
        conn.queue = conn.queue
          .then(() => handleMessage(conn, m))
          .catch((err) => log.warn('realtime message failed', { project: project.name, error: (err as Error).message }))
          .finally(() => {
            conn.pending--;
            conn.pendingBytes -= size;
          });
      });
      ws.on('close', () => {
        clearInterval(ping);
        for (const j of [...conn.joins.values()]) leave(j);
      });
      ws.on('error', () => ws.terminate());
    });
  });

  // Close channels whose JWT has expired.
  setInterval(() => {
    const now = Date.now() / 1000;
    for (const st of states.values()) {
      for (const set of st.topics.values()) {
        for (const j of [...set]) {
          if (typeof j.claims.exp === 'number' && j.claims.exp < now) {
            send(j.conn, j.joinRef, null, j.topic, 'system', { status: 'error', message: 'Token has expired', extension: 'system', channel: subTopic(j.topic) });
            send(j.conn, j.joinRef, null, j.topic, 'phx_close', {});
            leave(j);
          }
        }
      }
    }
  }, 15_000).unref();

  await new Promise<void>((r) => server.listen(config.ports.realtime, '0.0.0.0', r));
  log.info(`keel-realtime listening on port ${config.ports.realtime}`);
}
