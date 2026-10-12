import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import pg from 'pg';
import { config, rolePassword } from '../lib/config.js';
import { pool } from '../lib/db.js';
import { log } from '../lib/log.js';
import type { Project } from '../lib/registry.js';
import { decode, toJsonValue, type Relation, type Tuple } from './pgoutput.js';

export type Change = {
  schema: string;
  table: string;
  relid: number;
  type: 'INSERT' | 'UPDATE' | 'DELETE';
  commit_timestamp: string;
  columns: { name: string; type: string }[];
  record: Record<string, unknown>;
  old_record: Record<string, unknown>;
  /**
   * Text values (as in the WAL) of the new row, or for deletes the old row,
   * for RLS visibility checks. Columns the WAL doesn't carry (unchanged TOAST
   * values, non-key columns of an old row without REPLICA IDENTITY FULL) are
   * left out.
   */
  raw: Record<string, string | null>;
  /** For updates: text values of the old row, with the same rule (all columns only with REPLICA IDENTITY FULL). */
  oldRaw: Record<string, string | null>;
};

const PUBLICATION = 'supabase_realtime';
const PG_EPOCH_MS = 946_684_800_000n;

/**
 * Streams row changes for one project database using a temporary logical
 * replication slot. Temporary slots vanish when the connection closes, so an
 * idle or crashed Keel never makes Postgres retain WAL.
 */
export class ProjectStream extends EventEmitter {
  private client: pg.Client | null = null;
  private relations = new Map<number, Relation>();
  private types = new Map<number, string>();
  private queue: Promise<void> = Promise.resolve();
  private lastLsn = 0n;
  private statusTimer: NodeJS.Timeout | null = null;
  private stopped = false;
  private commitTime = new Date();
  running = false;
  private readyWaiters = new Set<() => void>();

  constructor(private project: Project) {
    super();
  }

  /**
   * Resolves once the replication slot exists, so every commit after this
   * point reaches subscribers. Gives up quietly after `timeoutMs`.
   */
  whenReady(timeoutMs = 5000): Promise<void> {
    if (this.running) return Promise.resolve();
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        this.readyWaiters.delete(done);
        resolve();
      };
      const timer = setTimeout(done, timeoutMs);
      this.readyWaiters.add(done);
    });
  }

  start(): void {
    this.stopped = false;
    void this.loop();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.statusTimer) clearInterval(this.statusTimer);
    await this.client?.end().catch(() => {});
    this.client = null;
    this.running = false;
  }

  private async loop(): Promise<void> {
    let delay = 1000;
    while (!this.stopped) {
      try {
        await this.connect();
        delay = 1000;
        await new Promise<void>((resolve) => {
          this.client!.once('end', resolve);
          this.client!.once('error', (err) => {
            log.warn('replication connection error', { project: this.project.name, error: err.message });
            resolve();
          });
        });
      } catch (err) {
        log.warn('replication stream failed', { project: this.project.name, error: (err as Error).message });
      }
      this.running = false;
      if (this.statusTimer) clearInterval(this.statusTimer);
      await this.client?.end().catch(() => {});
      this.client = null;
      if (this.stopped) return;
      await new Promise((r) => setTimeout(r, delay));
      delay = Math.min(delay * 2, 30_000);
    }
  }

  private async connect(): Promise<void> {
    const client = new pg.Client({
      host: config.db.host,
      port: config.db.port,
      user: 'keel_realtime_admin',
      password: rolePassword('keel_realtime_admin'),
      database: this.project.dbName,
      replication: 'database',
      application_name: 'keel-realtime',
    } as pg.ClientConfig);
    this.client = client;
    await client.connect();
    const slot = `keel_rt_${crypto.randomBytes(6).toString('hex')}`;
    await client.query(`CREATE_REPLICATION_SLOT ${slot} TEMPORARY LOGICAL pgoutput NOEXPORT_SNAPSHOT`);
    const conn = (client as unknown as { connection: EventEmitter & { sendCopyFromChunk(b: Buffer): void } }).connection;
    conn.on('copyData', (msg: { chunk: Buffer }) => this.onCopyData(msg.chunk, conn));
    client
      .query(`START_REPLICATION SLOT ${slot} LOGICAL 0/0 (proto_version '1', publication_names '${PUBLICATION}')`)
      .catch((err) => {
        if (!this.stopped) log.warn('replication ended', { project: this.project.name, error: err.message });
        client.end().catch(() => {});
      });
    this.statusTimer = setInterval(() => this.sendStatus(conn), 10_000);
    this.running = true;
    for (const done of [...this.readyWaiters]) done();
    log.info('realtime replication started', { project: this.project.name, slot });
  }

  private sendStatus(conn: { sendCopyFromChunk(b: Buffer): void }) {
    const buf = Buffer.alloc(34);
    buf.write('r', 0);
    buf.writeBigUInt64BE(this.lastLsn, 1);
    buf.writeBigUInt64BE(this.lastLsn, 9);
    buf.writeBigUInt64BE(this.lastLsn, 17);
    buf.writeBigInt64BE((BigInt(Date.now()) - PG_EPOCH_MS) * 1000n, 25);
    buf.writeUInt8(0, 33);
    try {
      conn.sendCopyFromChunk(buf);
    } catch {
      /* connection is going away */
    }
  }

  private onCopyData(chunk: Buffer, conn: { sendCopyFromChunk(b: Buffer): void }) {
    const kind = String.fromCharCode(chunk[0]);
    if (kind === 'k') {
      const walEnd = chunk.readBigUInt64BE(1);
      if (walEnd > this.lastLsn) this.lastLsn = walEnd;
      if (chunk[17] === 1) this.sendStatus(conn);
      return;
    }
    if (kind !== 'w') return;
    const start = chunk.readBigUInt64BE(1);
    // Copy: `chunk` is a view into pg's read buffer, which is reused for later
    // messages while this one waits in the queue. Without the copy a change
    // can be decoded from another change's bytes (or a mix of two rows).
    const data = Buffer.from(chunk.subarray(25));
    // Process strictly in order; type lookups are async.
    this.queue = this.queue
      .then(() => this.handle(data))
      .catch((err) => log.warn('failed to process change', { project: this.project.name, error: (err as Error).message }))
      .then(() => {
        if (start > this.lastLsn) this.lastLsn = start;
      });
  }

  private async handle(data: Buffer): Promise<void> {
    const msg = decode(data);
    switch (msg.tag) {
      case 'begin':
        this.commitTime = msg.commitTime;
        return;
      case 'relation':
        this.relations.set(msg.relation.relid, msg.relation);
        await this.resolveTypes(msg.relation);
        this.emit('relation', msg.relation.relid);
        return;
      case 'insert':
        return this.emitChange('INSERT', msg.relid, msg.tuple, null);
      case 'update':
        return this.emitChange('UPDATE', msg.relid, msg.tuple, msg.old);
      case 'delete':
        return this.emitChange('DELETE', msg.relid, null, msg.old);
      default:
        return;
    }
  }

  private async resolveTypes(rel: Relation) {
    const missing = rel.columns.map((c) => c.typeOid).filter((oid) => !this.types.has(oid));
    if (!missing.length) return;
    const { rows } = await pool(this.project.dbName, 'keel_realtime_admin', 4).query(
      'select oid::int as oid, typname from pg_type where oid = any($1::oid[])',
      [missing],
    );
    for (const r of rows) this.types.set(r.oid, r.typname);
  }

  private emitChange(type: Change['type'], relid: number, tuple: Tuple | null, old: Tuple | null) {
    const rel = this.relations.get(relid);
    if (!rel) return;
    const columns = rel.columns.map((c) => ({ name: c.name, type: this.types.get(c.typeOid) || 'text' }));
    // Without REPLICA IDENTITY FULL the old row only carries the key columns.
    const keysOnly = rel.replicaIdentity !== 'f';
    const toRecord = (t: Tuple | null, isOld = false) => {
      const out: Record<string, unknown> = {};
      if (!t) return out;
      rel.columns.forEach((c, i) => {
        if (t[i] === undefined) return; // unchanged TOAST value
        if (isOld && keysOnly && !(c.flags & 1)) return;
        out[c.name] = toJsonValue(columns[i].type, t[i] as string | null);
      });
      return out;
    };
    const toRaw = (t: Tuple | null, isOld: boolean) => {
      const out: Record<string, string | null> = Object.create(null);
      if (!t) return out;
      rel.columns.forEach((c, i) => {
        if (t[i] === undefined) return;
        if (isOld && keysOnly && !(c.flags & 1)) return;
        out[c.name] = t[i] as string | null;
      });
      return out;
    };
    const change: Change = {
      schema: rel.schema,
      table: rel.table,
      relid,
      type,
      commit_timestamp: this.commitTime.toISOString(),
      columns,
      record: toRecord(tuple),
      old_record: toRecord(old, true),
      raw: tuple ? toRaw(tuple, false) : toRaw(old, true),
      oldRaw: tuple ? toRaw(old, true) : Object.create(null),
    };
    this.emit('change', change);
  }
}
