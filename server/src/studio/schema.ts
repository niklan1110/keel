import type pg from 'pg';
import { quoteIdent } from '../lib/db.js';
import { HttpError } from '../lib/http.js';

/** Return every value as Postgres' text representation (null stays null). */
export const RAW_TYPES = { getTypeParser: () => (v: string) => v };

export type Column = {
  name: string;
  type: string;
  format: string;
  nullable: boolean;
  default: string | null;
  identity: boolean;
  generated: boolean;
  pk: boolean;
  fk: { schema: string; table: string; column: string } | null;
};

export type Table = {
  oid: number;
  schema: string;
  name: string;
  kind: 'table' | 'view' | 'materialized view' | 'foreign table' | 'partitioned table';
  rows: number;
  exact: boolean;
  rls: boolean;
  realtime: boolean;
  policies: number;
  comment: string | null;
  columns: Column[];
};

const KIND: Record<string, Table['kind']> = { r: 'table', p: 'partitioned table', v: 'view', m: 'materialized view', f: 'foreign table' };

export async function listSchemas(c: pg.ClientBase): Promise<string[]> {
  const { rows } = await c.query(
    `select nspname from pg_namespace
      where nspname not like 'pg\\_%' and nspname not in ('information_schema', '_keel', '_keel_defaults', 'extensions')
      order by nspname = 'public' desc, nspname`,
  );
  return rows.map((r) => r.nspname);
}

export async function introspect(c: pg.ClientBase, schema: string, opts: { table?: string; counts?: boolean } = {}): Promise<Table[]> {
  const tables = (
    await c.query(
      `select c.oid::int as oid, n.nspname as schema, c.relname as name, c.relkind as kind,
              c.reltuples::bigint as estimate, c.relrowsecurity as rls,
              obj_description(c.oid, 'pg_class') as comment,
              exists (select 1 from pg_publication_tables pt
                       where pt.pubname = 'supabase_realtime' and pt.schemaname = n.nspname and pt.tablename = c.relname) as realtime,
              (select count(*) from pg_policy p where p.polrelid = c.oid)::int as policies
         from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = $1 and c.relkind in ('r', 'p', 'v', 'm', 'f') and not c.relispartition
          and ($2::text is null or c.relname = $2)
        order by c.relname`,
      [schema, opts.table ?? null],
    )
  ).rows;
  if (!tables.length) return [];
  const oids = tables.map((t) => t.oid);
  const cols = (
    await c.query(
      `select a.attrelid::int as oid, a.attname as name, t.typname as type, format_type(a.atttypid, a.atttypmod) as format,
              not a.attnotnull as nullable, pg_get_expr(d.adbin, d.adrelid) as "default",
              a.attidentity <> '' as identity, a.attgenerated <> '' as generated
         from pg_attribute a
         join pg_type t on t.oid = a.atttypid
         left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
        where a.attrelid = any($1) and a.attnum > 0 and not a.attisdropped
        order by a.attrelid, a.attnum`,
      [oids],
    )
  ).rows;
  const cons = (
    await c.query(
      `select con.conrelid::int as oid, con.contype as type,
              array(select a.attname::text from unnest(con.conkey) with ordinality k(n, i)
                      join pg_attribute a on a.attrelid = con.conrelid and a.attnum = k.n order by k.i) as cols,
              fn.nspname as fschema, fc.relname as ftable,
              array(select a.attname::text from unnest(con.confkey) with ordinality k(n, i)
                      join pg_attribute a on a.attrelid = con.confrelid and a.attnum = k.n order by k.i) as fcols
         from pg_constraint con
         left join pg_class fc on fc.oid = con.confrelid
         left join pg_namespace fn on fn.oid = fc.relnamespace
        where con.conrelid = any($1) and con.contype in ('p', 'f')`,
      [oids],
    )
  ).rows;

  // Exact counts for small tables, planner estimates for big ones.
  const counts = new Map<number, number>();
  for (const t of tables) {
    if (opts.counts === false) break;
    if (t.kind !== 'r' && t.kind !== 'p') continue;
    if (Number(t.estimate) >= 0 && Number(t.estimate) > 100_000) continue;
    try {
      const r = await c.query(`select count(*)::bigint as n from ${quoteIdent(t.schema)}.${quoteIdent(t.name)}`);
      counts.set(t.oid, Number(r.rows[0].n));
    } catch {
      /* permission or lock issues: fall back to the estimate */
    }
  }

  return tables.map((t) => {
    const pk = cons.find((k) => k.oid === t.oid && k.type === 'p');
    const fks = cons.filter((k) => k.oid === t.oid && k.type === 'f' && k.cols.length === 1);
    return {
      oid: t.oid,
      schema: t.schema,
      name: t.name,
      kind: KIND[t.kind],
      rows: counts.get(t.oid) ?? Math.max(0, Number(t.estimate)),
      exact: counts.has(t.oid),
      rls: t.rls,
      realtime: t.realtime,
      policies: t.policies,
      comment: t.comment,
      columns: cols
        .filter((col) => col.oid === t.oid)
        .map((col) => {
          const fk = fks.find((k) => k.cols[0] === col.name);
          return {
            name: col.name,
            type: col.type,
            format: col.format,
            nullable: col.nullable,
            default: col.default,
            identity: col.identity,
            generated: col.generated,
            pk: !!pk && pk.cols.includes(col.name),
            fk: fk ? { schema: fk.fschema, table: fk.ftable, column: fk.fcols[0] } : null,
          };
        }),
    };
  });
}

export async function tableInfo(c: pg.ClientBase, schema: string, table: string): Promise<Table> {
  const [t] = await introspect(c, schema, { table, counts: false });
  if (!t) throw new HttpError(404, `Table ${schema}.${table} not found`, 'not_found');
  return t;
}

export type Filter = { column: string; op: string; value?: string };

const OPS: Record<string, (col: string, p: string) => string> = {
  eq: (c, p) => `${c} = ${p}`,
  neq: (c, p) => `${c} is distinct from ${p}`,
  gt: (c, p) => `${c} > ${p}`,
  gte: (c, p) => `${c} >= ${p}`,
  lt: (c, p) => `${c} < ${p}`,
  lte: (c, p) => `${c} <= ${p}`,
  like: (c, p) => `${c}::text like ${p}`,
  ilike: (c, p) => `${c}::text ilike ${p}`,
};

/** Builds a WHERE clause from UI filters. Columns are checked against the table. */
export function whereClause(t: Table, filters: Filter[], params: unknown[]): string {
  const parts: string[] = [];
  for (const f of filters) {
    const col = t.columns.find((x) => x.name === f.column);
    if (!col) throw new HttpError(400, `Unknown column ${f.column}`, 'bad_filter');
    const q = quoteIdent(col.name);
    if (f.op === 'is_null') parts.push(`${q} is null`);
    else if (f.op === 'not_null') parts.push(`${q} is not null`);
    else if (f.op === 'in') {
      const values = String(f.value ?? '').split(',').map((v) => v.trim()).filter(Boolean);
      params.push(values);
      parts.push(`${q}::text = any($${params.length}::text[])`);
    } else if (OPS[f.op]) {
      params.push(f.value ?? '');
      parts.push(OPS[f.op](q, `$${params.length}`));
    } else {
      throw new HttpError(400, `Unknown operator ${f.op}`, 'bad_filter');
    }
  }
  return parts.length ? `where ${parts.join(' and ')}` : '';
}

export function keyClause(t: Table, key: Record<string, unknown>, params: unknown[]): string {
  const pk = t.columns.filter((c) => c.pk);
  if (!pk.length) throw new HttpError(400, 'This table has no primary key, so rows cannot be edited here. Use the SQL editor.', 'no_primary_key');
  return pk
    .map((c) => {
      if (!(c.name in key)) throw new HttpError(400, `Missing key column ${c.name}`, 'bad_key');
      params.push(key[c.name]);
      return `${quoteIdent(c.name)} = $${params.length}`;
    })
    .join(' and ');
}

/** Converts UI values (strings, or null for NULL) into query parameters. */
export function toParam(col: Column, v: unknown): unknown {
  if (v === null || v === undefined) return null;
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}
