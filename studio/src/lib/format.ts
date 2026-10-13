export function bytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  const v = n / 1024 ** i;
  return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(v >= 10 ? 1 : 2).replace(/\.?0+$/, '')} ${units[i]}`;
}

export function count(n: number): string {
  return n.toLocaleString('en-US');
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const pad = (n: number) => String(n).padStart(2, '0');

/** "Today, 13:41", "Yesterday, 22:18", "28 Sep, 19:55", "14 Mar 2025" */
export function when(iso: string | null | undefined): string {
  if (!iso) return 'Never';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  const now = new Date();
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const startOfDay = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diffDays = Math.round((startOfDay(now) - startOfDay(d)) / 86_400_000);
  if (diffDays === 0) return `Today, ${time}`;
  if (diffDays === 1) return `Yesterday, ${time}`;
  if (d.getFullYear() === now.getFullYear()) return `${d.getDate()} ${MONTHS[d.getMonth()]}, ${time}`;
  return `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
}

/** "2 Oct 2026, 03:00" */
export function stamp(iso: string | null | undefined): string {
  if (!iso) return 'never';
  const d = new Date(iso);
  return `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}, ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function clock(iso: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  const now = new Date();
  if (now.getTime() - d.getTime() > 86_400_000) return `${d.getDate()} ${MONTHS[d.getMonth()]}`;
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

const MONO_TYPES = /^(int|float|numeric|money|uuid|date|time|timestamp|interval|oid|bit|inet|cidr|macaddr|bytea|tsvector|json|jsonb|_)/;

/** Short display name for a Postgres type ("timestamp with time zone" -> "timestamptz"). */
export function shortType(t: string): string {
  if (t.startsWith('_')) return `${t.slice(1)}[]`;
  return t;
}

export type CellStyle = { text: string; cls: string };

/** Formats a raw text value from Postgres for the grid, like the design does. */
export function cell(value: string | null, type: string): CellStyle {
  if (value === null) return { text: 'NULL', cls: 'cell-null' };
  if (type === 'bool') {
    const v = value === 't' || value === 'true';
    return { text: String(v), cls: v ? 'cell-true' : 'cell-false' };
  }
  if (MONO_TYPES.test(type)) {
    let text = value;
    if (/^timestamp/.test(type)) text = value.replace(/(\d{2}:\d{2})(:\d{2}(\.\d+)?)?([+-]\d{2}(:\d{2})?)?$/, '$1');
    return { text, cls: 'cell-mono' };
  }
  return { text: value, cls: 'cell-text' };
}

export function plural(n: number, one: string, many = one + 's'): string {
  return `${count(n)} ${n === 1 ? one : many}`;
}
