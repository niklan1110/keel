/**
 * Decoder for PostgreSQL's built-in `pgoutput` logical replication protocol (v1).
 * https://www.postgresql.org/docs/current/protocol-logicalrep-message-formats.html
 */

export type RelationColumn = { flags: number; name: string; typeOid: number; typmod: number };
export type Relation = { relid: number; schema: string; table: string; replicaIdentity: string; columns: RelationColumn[] };
/** Text values per column; null = SQL NULL; undefined = unchanged TOAST value. */
export type Tuple = (string | null | undefined)[];

export type PgOutputMessage =
  | { tag: 'begin'; finalLsn: bigint; commitTime: Date; xid: number }
  | { tag: 'commit'; commitLsn: bigint; endLsn: bigint; commitTime: Date }
  | { tag: 'relation'; relation: Relation }
  | { tag: 'type'; oid: number; schema: string; name: string }
  | { tag: 'insert'; relid: number; tuple: Tuple }
  | { tag: 'update'; relid: number; old: Tuple | null; tuple: Tuple }
  | { tag: 'delete'; relid: number; old: Tuple }
  | { tag: 'truncate'; relids: number[] }
  | { tag: 'origin' | 'message' | 'unknown' };

const PG_EPOCH_MS = 946_684_800_000;

class Reader {
  pos = 0;
  constructor(private buf: Buffer) {}
  u8() { return this.buf.readUInt8(this.pos++); }
  i16() { const v = this.buf.readInt16BE(this.pos); this.pos += 2; return v; }
  i32() { const v = this.buf.readInt32BE(this.pos); this.pos += 4; return v; }
  u32() { const v = this.buf.readUInt32BE(this.pos); this.pos += 4; return v; }
  u64() { const v = this.buf.readBigUInt64BE(this.pos); this.pos += 8; return v; }
  time() { const us = this.buf.readBigInt64BE(this.pos); this.pos += 8; return new Date(PG_EPOCH_MS + Number(us / 1000n)); }
  str() {
    const end = this.buf.indexOf(0, this.pos);
    const s = this.buf.toString('utf8', this.pos, end);
    this.pos = end + 1;
    return s;
  }
  bytes(n: number) { const b = this.buf.subarray(this.pos, this.pos + n); this.pos += n; return b; }
  tuple(): Tuple {
    const n = this.i16();
    const out: Tuple = [];
    for (let i = 0; i < n; i++) {
      const kind = String.fromCharCode(this.u8());
      if (kind === 'n') out.push(null);
      else if (kind === 'u') out.push(undefined);
      else if (kind === 't' || kind === 'b') {
        const len = this.i32();
        out.push(this.bytes(len).toString('utf8'));
      } else throw new Error(`unknown tuple kind ${kind}`);
    }
    return out;
  }
}

export function decode(buf: Buffer): PgOutputMessage {
  const r = new Reader(buf);
  const tag = String.fromCharCode(r.u8());
  switch (tag) {
    case 'B':
      return { tag: 'begin', finalLsn: r.u64(), commitTime: r.time(), xid: r.u32() };
    case 'C': {
      r.u8(); // flags
      return { tag: 'commit', commitLsn: r.u64(), endLsn: r.u64(), commitTime: r.time() };
    }
    case 'R': {
      const relid = r.u32();
      const schema = r.str();
      const table = r.str();
      const replicaIdentity = String.fromCharCode(r.u8());
      const n = r.i16();
      const columns: RelationColumn[] = [];
      for (let i = 0; i < n; i++) columns.push({ flags: r.u8(), name: r.str(), typeOid: r.u32(), typmod: r.i32() });
      return { tag: 'relation', relation: { relid, schema, table, replicaIdentity, columns } };
    }
    case 'Y':
      return { tag: 'type', oid: r.u32(), schema: r.str(), name: r.str() };
    case 'I': {
      const relid = r.u32();
      r.u8(); // 'N'
      return { tag: 'insert', relid, tuple: r.tuple() };
    }
    case 'U': {
      const relid = r.u32();
      let kind = String.fromCharCode(r.u8());
      let old: Tuple | null = null;
      if (kind === 'K' || kind === 'O') {
        old = r.tuple();
        kind = String.fromCharCode(r.u8());
      }
      return { tag: 'update', relid, old, tuple: r.tuple() };
    }
    case 'D': {
      const relid = r.u32();
      r.u8(); // 'K' or 'O'
      return { tag: 'delete', relid, old: r.tuple() };
    }
    case 'T': {
      const n = r.i32();
      r.u8(); // options
      const relids: number[] = [];
      for (let i = 0; i < n; i++) relids.push(r.u32());
      return { tag: 'truncate', relids };
    }
    case 'O':
      return { tag: 'origin' };
    case 'M':
      return { tag: 'message' };
    default:
      return { tag: 'unknown' };
  }
}

const INT_TYPES = new Set(['int2', 'int4', 'oid']);
const FLOAT_TYPES = new Set(['float4', 'float8']);

/** Converts a text value from the WAL into a JSON value, like Supabase Realtime does. */
export function toJsonValue(type: string, value: string | null): unknown {
  if (value === null) return null;
  if (type === 'bool') return value === 't';
  if (INT_TYPES.has(type)) return Number(value);
  if (FLOAT_TYPES.has(type)) {
    const n = Number(value);
    return Number.isFinite(n) ? n : value;
  }
  if (type === 'int8' || type === 'numeric') {
    const n = Number(value);
    return Number.isSafeInteger(n) || (type === 'numeric' && Number.isFinite(n) && String(n) === value) ? n : value;
  }
  if (type === 'json' || type === 'jsonb') {
    try {
      return JSON.parse(value);
    } catch {
      return value;
    }
  }
  return value;
}
