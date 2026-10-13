/**
 * Schedules for cron.schedule(), as pg_cron reads them: five fields (minute,
 * hour, day of month, month, day of week) with lists, ranges, steps and
 * names, `$` for the last day of the month, the @daily-style macros, and
 * '[1-59] seconds' for a job every few seconds. Times are UTC, like
 * pg_cron's default (cron.timezone = GMT).
 *
 * The same rules are checked in SQL by cron._check_schedule() (see
 * sql/project/013_cron_and_net.sql), so a bad schedule fails when it is set.
 */

export type CronSchedule =
  | { kind: 'seconds'; seconds: number }
  | {
      kind: 'cron';
      minute: Set<number>;
      hour: Set<number>;
      dom: Set<number>;
      month: Set<number>;
      dow: Set<number>;
      /** `$` in the day of month field. */
      lastDom: boolean;
      /** The field started with `*`: vixie cron then needs both day fields to match, not either. */
      domStar: boolean;
      dowStar: boolean;
    };

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

const MACROS: Record<string, string> = {
  '@yearly': '0 0 1 1 *',
  '@annually': '0 0 1 1 *',
  '@monthly': '0 0 1 * *',
  '@weekly': '0 0 * * 0',
  '@daily': '0 0 * * *',
  '@midnight': '0 0 * * *',
  '@hourly': '0 * * * *',
};

type Field = { min: number; max: number; names?: string[]; nameBase?: number };
const FIELDS: Field[] = [
  { min: 0, max: 59 },
  { min: 0, max: 23 },
  { min: 1, max: 31 },
  { min: 1, max: 12, names: MONTHS, nameBase: 1 },
  { min: 0, max: 7, names: DAYS, nameBase: 0 },
];
const FIELD_NAMES = ['minute', 'hour', 'day of month', 'month', 'day of week'];

const SECONDS_RE = /^\s*(\d{1,2})\s+seconds?\s*$/i;

class ScheduleError extends Error {}

function value(s: string, f: Field, field: string): number {
  if (/^\d{1,2}$/.test(s)) {
    const n = Number(s);
    if (n < f.min || n > f.max) throw new ScheduleError(`${field}: ${n} is out of range (${f.min}-${f.max})`);
    return n;
  }
  const i = f.names?.indexOf(s.toLowerCase()) ?? -1;
  if (i < 0) throw new ScheduleError(`${field}: "${s}" is not a number${f.names ? ' or name' : ''}`);
  return i + f.nameBase!;
}

function parseField(text: string, f: Field, field: string, allowLast: boolean): { set: Set<number>; last: boolean } {
  const set = new Set<number>();
  let last = false;
  if (!text) throw new ScheduleError(`${field} is empty`);
  for (const item of text.split(',')) {
    if (allowLast && item === '$') {
      last = true;
      continue;
    }
    const m = /^([^/]+)(?:\/(\d{1,2}))?$/.exec(item);
    if (!m) throw new ScheduleError(`${field}: "${item}" is not valid`);
    const step = m[2] === undefined ? 1 : Number(m[2]);
    if (step < 1) throw new ScheduleError(`${field}: a step must be at least 1`);
    let lo: number;
    let hi: number;
    if (m[1] === '*') {
      lo = f.min;
      hi = f.max;
    } else {
      const parts = m[1].split('-');
      if (parts.length > 2) throw new ScheduleError(`${field}: "${item}" is not valid`);
      lo = value(parts[0], f, field);
      // "5/15" means from 5 to the end, every 15.
      hi = parts.length === 2 ? value(parts[1], f, field) : m[2] !== undefined ? f.max : lo;
      if (hi < lo) throw new ScheduleError(`${field}: ${parts[0]}-${parts[1]} runs backwards`);
    }
    for (let n = lo; n <= hi; n += step) set.add(n);
  }
  return { set, last };
}

/** Parses a schedule; throws an Error saying what is wrong. */
export function parseSchedule(text: string): CronSchedule {
  if (typeof text !== 'string') throw new ScheduleError('schedule must be text');
  const sec = SECONDS_RE.exec(text);
  if (sec) {
    const n = Number(sec[1]);
    if (n < 1 || n > 59) throw new ScheduleError('seconds must be from 1 to 59');
    return { kind: 'seconds', seconds: n };
  }
  let t = text.trim();
  if (t.startsWith('@')) {
    const macro = MACROS[t.toLowerCase()];
    if (!macro) throw new ScheduleError(`"${t}" is not supported`);
    t = macro;
  }
  const parts = t.split(/\s+/);
  if (parts.length !== 5) throw new ScheduleError(`a schedule has 5 fields (minute hour day-of-month month day-of-week) or is "N seconds"; got "${text}"`);
  const out = parts.map((p, i) => parseField(p, FIELDS[i], FIELD_NAMES[i], i === 2));
  const dow = new Set([...out[4].set].map((d) => d % 7));
  return {
    kind: 'cron',
    minute: out[0].set,
    hour: out[1].set,
    dom: out[2].set,
    month: out[3].set,
    dow,
    lastDom: out[2].last,
    domStar: parts[2].startsWith('*'),
    dowStar: parts[4].startsWith('*'),
  };
}

/** Whether a five-field schedule fires in the (UTC) minute holding `at`. */
export function matchesMinute(s: CronSchedule, at: Date): boolean {
  if (s.kind !== 'cron') return false;
  if (!s.minute.has(at.getUTCMinutes()) || !s.hour.has(at.getUTCHours()) || !s.month.has(at.getUTCMonth() + 1)) return false;
  const day = at.getUTCDate();
  const lastDay = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth() + 1, 0)).getUTCDate();
  const domOk = s.dom.has(day) || (s.lastDom && day === lastDay);
  const dowOk = s.dow.has(at.getUTCDay());
  return s.domStar || s.dowStar ? domOk && dowOk : domOk || dowOk;
}
