/** Names of full backups: keel-<YYYYMMDD>-<HHMMSS>.tar.age (local time). */
export const SET_NAME_RE = /^keel-(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})\.tar\.age$/;

export function setName(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `keel-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}.tar.age`;
}

/** When a full backup was made, from its name; null for anything else. */
export function setTime(name: string): Date | null {
  const m = SET_NAME_RE.exec(name);
  if (!m) return null;
  const [y, mo, d, h, mi, s] = m.slice(1).map(Number);
  const t = new Date(y, mo - 1, d, h, mi, s);
  return Number.isNaN(t.getTime()) ? null : t;
}

const dayKey = (d: Date) => `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;

/** ISO 8601 week (weeks start on Monday) of a local date. */
function weekKey(d: Date): string {
  const t = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const day = (t.getDay() + 6) % 7; // Monday = 0
  t.setDate(t.getDate() - day + 3); // the Thursday of this week decides its year
  const dayOfYear = Math.round((t.getTime() - new Date(t.getFullYear(), 0, 1).getTime()) / 86_400_000);
  const week = 1 + Math.floor(dayOfYear / 7);
  return `${t.getFullYear()}-W${week}`;
}

/**
 * Which full backups to keep: the newest of each of the last `daily` days
 * that have one, the newest of each of the last `weekly` weeks, and always
 * the newest backup. Names that aren't full backups are never chosen for
 * deletion (they are kept).
 */
export function backupsToKeep(names: string[], daily: number, weekly: number): Set<string> {
  const sets = names
    .map((name) => ({ name, time: setTime(name) }))
    .filter((s): s is { name: string; time: Date } => !!s.time)
    .sort((a, b) => b.time.getTime() - a.time.getTime());
  const keep = new Set(names.filter((n) => !setTime(n)));
  if (sets.length) keep.add(sets[0].name);
  const pick = (count: number, key: (d: Date) => string) => {
    const seen = new Set<string>();
    for (const s of sets) {
      const k = key(s.time);
      if (seen.has(k)) continue;
      if (seen.size >= count) break;
      seen.add(k);
      keep.add(s.name);
    }
  };
  pick(daily, dayKey);
  pick(weekly, weekKey);
  return keep;
}
