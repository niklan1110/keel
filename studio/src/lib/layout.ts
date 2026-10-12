import type { Table } from '../types';

export const NODE_W = 232;
export const HEAD_H = 40;
export const ROW_H = 26;
export const MAX_ROWS = 12;
const GAP_X = 88;
const GAP_Y = 40;
const TOP = 40;

export type Pos = { x: number; y: number };

export function nodeHeight(t: Table): number {
  const shown = Math.min(t.columns.length, MAX_ROWS);
  const more = t.columns.length > MAX_ROWS ? 1 : 0;
  return HEAD_H + (shown + more) * ROW_H + 2;
}

/** Index of a column's row within the node (for edge anchors); hidden columns anchor to the header. */
export function rowIndex(t: Table, column: string): number {
  const i = t.columns.findIndex((c) => c.name === column);
  return i >= 0 && i < MAX_ROWS ? i : -1;
}

/**
 * Lays tables out in columns: tables that are referenced sit to the left of
 * the tables that reference them, like the hand-drawn Atlas design.
 */
export function autoLayout(tables: Table[]): Record<string, Pos> {
  const names = new Set(tables.map((t) => t.name));
  const refs = new Map<string, string[]>();
  for (const t of tables) {
    const out = new Set<string>();
    for (const c of t.columns) if (c.fk && c.fk.schema === t.schema && names.has(c.fk.table) && c.fk.table !== t.name) out.add(c.fk.table);
    refs.set(t.name, [...out]);
  }
  const linked = new Set<string>();
  for (const [from, tos] of refs) {
    if (tos.length) linked.add(from);
    tos.forEach((x) => linked.add(x));
  }

  // Longest path from a referenced "root" table.
  const level = new Map<string, number>();
  const visiting = new Set<string>();
  const depth = (n: string): number => {
    if (level.has(n)) return level.get(n)!;
    if (visiting.has(n)) return 0;
    visiting.add(n);
    const tos = refs.get(n) || [];
    const d = tos.length ? 1 + Math.max(...tos.map(depth)) : 0;
    visiting.delete(n);
    level.set(n, d);
    return d;
  };
  for (const t of tables) if (linked.has(t.name)) depth(t.name);
  // Pull referenced-only tables next to the tables that use them, so a lookup
  // table referenced from deep in the graph doesn't send edges across it.
  for (const t of tables) {
    if (!linked.has(t.name) || (refs.get(t.name) || []).length) continue;
    const users = [...refs].filter(([, tos]) => tos.includes(t.name)).map(([f]) => level.get(f)!);
    if (users.length) level.set(t.name, Math.max(0, Math.min(...users) - 1));
  }

  const cols: string[][] = [];
  for (const t of tables) {
    if (!linked.has(t.name)) continue;
    const l = level.get(t.name)!;
    (cols[l] ||= []).push(t.name);
  }
  if (!cols.length) cols.push([]);

  // Order within columns by the average position of neighbours (barycentre).
  const byName = new Map(tables.map((t) => [t.name, t]));
  const neighbours = (n: string) => [...(refs.get(n) || []), ...[...refs].filter(([, tos]) => tos.includes(n)).map(([f]) => f)];
  for (let pass = 0; pass < 4; pass++) {
    const index = new Map<string, number>();
    cols.forEach((c) => c.forEach((n, i) => index.set(n, i)));
    for (const c of cols) {
      c.sort((a, b) => {
        const avg = (n: string) => {
          const ns = neighbours(n).filter((x) => index.has(x));
          return ns.length ? ns.reduce((s, x) => s + index.get(x)!, 0) / ns.length : index.get(n)!;
        };
        return avg(a) - avg(b) || neighbours(b).length - neighbours(a).length || a.localeCompare(b);
      });
    }
  }

  // Unlinked tables fill the shortest columns.
  const heightOf = (c: string[]) => c.reduce((h, n) => h + nodeHeight(byName.get(n)!) + GAP_Y, 0);
  const loose = tables.filter((t) => !linked.has(t.name)).sort((a, b) => a.name.localeCompare(b.name));
  const maxCols = Math.max(cols.length, Math.min(4, Math.ceil(Math.sqrt(tables.length))));
  while (cols.length < maxCols) cols.push([]);
  for (const t of loose) {
    let best = 0;
    for (let i = 1; i < cols.length; i++) if (heightOf(cols[i]) < heightOf(cols[best])) best = i;
    cols[best].push(t.name);
  }

  const pos: Record<string, Pos> = {};
  cols.forEach((c, ci) => {
    let y = TOP + (ci % 2 === 1 ? 0 : 30);
    for (const n of c) {
      pos[n] = { x: 40 + ci * (NODE_W + GAP_X), y };
      y += nodeHeight(byName.get(n)!) + GAP_Y;
    }
  });
  return pos;
}

export type Edge = { from: string; fromCol: string; to: string; toCol: string; d: string; ex: number; ey: number };

export function edges(tables: Table[], pos: Record<string, Pos>): Edge[] {
  const byName = new Map(tables.map((t) => [t.name, t]));
  const out: Edge[] = [];
  for (const t of tables) {
    for (const c of t.columns) {
      if (!c.fk || c.fk.schema !== t.schema || !byName.has(c.fk.table)) continue;
      const target = byName.get(c.fk.table)!;
      const sp = pos[t.name];
      const tp = pos[target.name];
      if (!sp || !tp) continue;
      const si = rowIndex(t, c.name);
      const tj = rowIndex(target, c.fk.column);
      const sy = sp.y + (si < 0 ? HEAD_H / 2 : HEAD_H + si * ROW_H + ROW_H / 2);
      const ty = tp.y + (tj < 0 ? HEAD_H / 2 : HEAD_H + tj * ROW_H + ROW_H / 2);
      let sx: number, tx: number, c1: number, c2: number;
      if (target.name === t.name) {
        sx = sp.x + NODE_W;
        tx = sp.x + NODE_W;
        c1 = sx + 56;
        c2 = tx + 56;
      } else if (tp.x > sp.x + NODE_W / 2) {
        sx = sp.x + NODE_W;
        tx = tp.x;
        c1 = sx + 70;
        c2 = tx - 70;
      } else if (tp.x < sp.x - NODE_W / 2) {
        sx = sp.x;
        tx = tp.x + NODE_W;
        c1 = sx - 70;
        c2 = tx + 70;
      } else {
        sx = sp.x;
        tx = tp.x;
        c1 = sx - 64;
        c2 = tx - 64;
      }
      out.push({ from: t.name, fromCol: c.name, to: target.name, toCol: c.fk.column, d: `M${sx} ${sy} C${c1} ${sy}, ${c2} ${ty}, ${tx} ${ty}`, ex: tx, ey: ty });
    }
  }
  return out;
}

export function bounds(tables: Table[], pos: Record<string, Pos>): { w: number; h: number } {
  let w = 600;
  let h = 400;
  for (const t of tables) {
    const p = pos[t.name];
    if (!p) continue;
    w = Math.max(w, p.x + NODE_W + 80);
    h = Math.max(h, p.y + nodeHeight(t) + 40);
  }
  return { w, h };
}
