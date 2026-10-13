/**
 * Row level security for postgres_changes, evaluated against the row in the
 * WAL rather than whatever the table holds when the check runs (the row may
 * have changed or gone since). Postgres only applies RLS to real tables, so
 * the table's SELECT policies (those that apply to the subscriber's role) are
 * combined the way Postgres combines them and evaluated, as the subscriber,
 * over a copy of the WAL row:
 *
 *   select 1 from json_populate_record($1::schema.table, '{}') as "table" where <policies>
 *
 * $1 is a row literal built from the WAL's text values, so every column is
 * parsed by its own type's input function, exactly as Postgres stored it.
 */

export type SelectPolicy = { permissive: boolean; qual: string | null };

/** Same as quoteIdent in lib/db (kept here so this module has no dependencies). */
const quoteIdent = (name: string) => '"' + String(name).replace(/"/g, '""') + '"';

/**
 * Combines SELECT policies like Postgres does: at least one permissive policy
 * must pass and every restrictive one must. A permissive policy without a
 * USING expression grants nothing; a restrictive one restricts nothing.
 * Returns null when no row can be visible.
 */
export function policyCondition(policies: SelectPolicy[]): string | null {
  const permissive = policies.filter((p) => p.permissive && p.qual != null).map((p) => `(${p.qual})`);
  if (!permissive.length) return null;
  const restrictive = policies.filter((p) => !p.permissive && p.qual != null).map((p) => ` and (${p.qual})`);
  return `(${permissive.join(' or ')})${restrictive.join('')}`;
}

const own = (o: Record<string, unknown>, k: string) => Object.prototype.hasOwnProperty.call(o, k);

/** A composite literal `("v1","v2",)` for `columns` in order; absent and null values become NULL. */
export function rowLiteral(columns: string[], values: Record<string, string | null>): string {
  const fields = columns.map((c) => {
    const v = own(values, c) ? values[c] : null;
    return v == null ? '' : `"${v.replace(/["\\]/g, '\\$&')}"`;
  });
  return `(${fields.join(',')})`;
}

export type RowCheck = { text: string; values: (string | null)[] };

/**
 * Builds the query that returns a row when the subscriber may see `row`.
 *
 * Columns the WAL doesn't carry (unchanged TOASTed values, generated columns,
 * columns left out of the publication) are unknown. For inserts and updates
 * (`fillFromCurrent`) they're taken from the table's current row, found by
 * primary key and read under the subscriber's RLS, so the change is only
 * visible if the current row is too. Without a primary key that can't be done
 * and null is returned: not visible. Deletes leave them NULL (the row is gone);
 * the old row then only holds the key and policies on other columns fail.
 */
export function rowCheckQuery(opts: {
  schema: string;
  table: string;
  /** The table's columns in order (not dropped). */
  columns: string[];
  pk: string[];
  /** WAL text values by column; a column without a key is unknown. */
  row: Record<string, string | null>;
  fillFromCurrent: boolean;
  condition: string;
}): RowCheck | null {
  const { schema, table, columns, pk, row, fillFromCurrent, condition } = opts;
  const rel = `${quoteIdent(schema)}.${quoteIdent(table)}`;
  // Policies name the table itself in sub-queries (pg_get_expr output), so the copy carries its name.
  const alias = quoteIdent(table);
  const literal = rowLiteral(columns, row);
  const missing = new Set(columns.filter((c) => !own(row, c)));
  if (!missing.size || !fillFromCurrent) {
    return { text: `select 1 from json_populate_record($1::${rel}, '{}'::json) as ${alias} where ${condition} limit 1`, values: [literal] };
  }
  if (!pk.length || pk.some((k) => !own(row, k) || row[k] == null)) return null;
  const merged = columns.map((c) => `${missing.has(c) ? '"_keel_current"' : '"_keel_wal"'}.${quoteIdent(c)}`).join(', ');
  const where = pk.map((k, i) => `"_keel_current".${quoteIdent(k)} = $${i + 2}`).join(' and ');
  return {
    text:
      `select 1 from (select row(${merged})::${rel} as "_keel_row"` +
      ` from ${rel} as "_keel_current", json_populate_record($1::${rel}, '{}'::json) as "_keel_wal" where ${where}) as "_keel_merged"` +
      ` where exists (select 1 from json_populate_record("_keel_merged"."_keel_row", '{}'::json) as ${alias} where ${condition}) limit 1`,
    values: [literal, ...pk.map((k) => row[k])],
  };
}

/** The primary key columns of a record (what subscribers get as `old_record` on tables with RLS). */
export function pickKeys(record: Record<string, unknown>, pk: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of pk) if (own(record, k)) out[k] = record[k];
  return out;
}
