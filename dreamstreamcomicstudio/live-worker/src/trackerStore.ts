/**
 * TrackerStore — the baby tracker's log (feeds, bottles, diapers, sleep,
 * pumping, growth, medicine, temperature, activities, notes), kept in the
 * nursery's MonitorRoom SQLite next to the monitor's own history, so every
 * family member's phone sees the same log the moment it changes.
 *
 *   mon_track   one row per entry; `end_at` NULL = a running timer
 *               (breastfeeding, pumping, sleep, tummy time…), so whoever is
 *               up can stop the timer someone else started.
 *
 * Deletes are soft (a `deleted` flag + `updated`) so a phone that was offline
 * learns about them. Everything coming from a client is clamped to sane,
 * kind-specific ranges here — the room never stores free-form JSON.
 * The mirror of these types for the app is live/monitor/trackerScience.ts.
 */

import type { SqlExec } from './monitorStore';

export const TRACK_KINDS = ['breast', 'bottle', 'solids', 'pump', 'diaper', 'sleep', 'growth', 'med', 'temp', 'activity', 'note'] as const;
export type TrackKind = (typeof TRACK_KINDS)[number];
/** Kinds that run as a timer (end_at may be NULL). */
export const TIMED: ReadonlySet<TrackKind> = new Set(['breast', 'pump', 'sleep', 'activity']);

export interface TrackRow {
  id: string;
  kind: TrackKind;
  start: number;
  end: number | null;
  by: string;
  by_uid: string;
  data: Record<string, unknown>;
  src: 'manual' | 'monitor';
  updated: number;
  deleted?: boolean;
}

export const TRACK_RETAIN_MS = 3 * 366 * 24 * 60 * 60_000;
const DAY = 24 * 60 * 60_000;
/** Longest a single entry may span. */
const MAX_SPAN: Record<TrackKind, number> = {
  breast: 3 * 60 * 60_000, bottle: 2 * 60 * 60_000, solids: 2 * 60 * 60_000, pump: 2 * 60 * 60_000, diaper: 60_000,
  sleep: 18 * 60 * 60_000, growth: 60_000, med: 60_000, temp: 60_000, activity: 6 * 60 * 60_000, note: 60_000,
};

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS mon_track (
    id TEXT PRIMARY KEY, kind TEXT NOT NULL, start INTEGER NOT NULL, end_at INTEGER,
    by_name TEXT NOT NULL, by_uid TEXT NOT NULL, data TEXT NOT NULL, src TEXT NOT NULL DEFAULT 'manual',
    updated INTEGER NOT NULL, deleted INTEGER NOT NULL DEFAULT 0)`,
  `CREATE INDEX IF NOT EXISTS mon_track_start ON mon_track(start)`,
  `CREATE INDEX IF NOT EXISTS mon_track_running ON mon_track(end_at) WHERE end_at IS NULL`,
  `CREATE INDEX IF NOT EXISTS mon_track_updated ON mon_track(updated)`,
];

/* ------------------------------------------------------------ sanitizing */

const num = (v: unknown, lo: number, hi: number, digits = 1): number | undefined => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() ? Number(v) : NaN;
  if (!Number.isFinite(n)) return undefined;
  const f = 10 ** digits;
  return Math.round(Math.min(hi, Math.max(lo, n)) * f) / f;
};
const str = (v: unknown, max: number): string | undefined => {
  if (typeof v !== 'string') return undefined;
  const s = v.normalize('NFKC').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, max);
  return s || undefined;
};
const pick = <T extends string>(v: unknown, allowed: readonly T[]): T | undefined => (allowed.includes(v as T) ? (v as T) : undefined);
const bool = (v: unknown): boolean | undefined => (typeof v === 'boolean' ? v : undefined);
const clean = (o: Record<string, unknown>) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));

/** Kind-specific fields, clamped. Unknown fields are dropped. */
export function sanitizeData(kind: TrackKind, d: Record<string, unknown>): Record<string, unknown> {
  const note = str(d.note, 300);
  switch (kind) {
    case 'breast':
      return clean({ left: num(d.left, 0, 3 * 3600, 0), right: num(d.right, 0, 3 * 3600, 0), side: pick(d.side, ['left', 'right'] as const), note });
    case 'bottle':
      return clean({ ml: num(d.ml, 0, 1000, 0), milk: pick(d.milk, ['formula', 'breast', 'mixed', 'other'] as const), note });
    case 'solids':
      return clean({ foods: str(d.foods, 120), amount: pick(d.amount, ['taste', 'some', 'most', 'all'] as const), reaction: str(d.reaction, 120), note });
    case 'pump':
      return clean({ mlLeft: num(d.mlLeft, 0, 600, 0), mlRight: num(d.mlRight, 0, 600, 0), note });
    case 'diaper':
      return clean({
        pee: bool(d.pee), poo: bool(d.poo), rash: bool(d.rash),
        color: pick(d.color, ['yellow', 'green', 'brown', 'black', 'red', 'white', 'orange'] as const),
        texture: pick(d.texture, ['runny', 'seedy', 'soft', 'formed', 'hard'] as const),
        note,
      });
    case 'sleep':
      return clean({ where: pick(d.where, ['crib', 'bassinet', 'arms', 'stroller', 'car', 'bed', 'other'] as const), note });
    case 'growth':
      return clean({ kg: num(d.kg, 0.3, 40, 3), cm: num(d.cm, 20, 130, 1), headCm: num(d.headCm, 20, 60, 1), note });
    case 'med':
      return clean({ name: str(d.name, 60), dose: num(d.dose, 0, 1000, 2), unit: pick(d.unit, ['ml', 'mg', 'drops', 'tablet', 'puff'] as const), everyH: num(d.everyH, 1, 48, 1), note });
    case 'temp':
      return clean({ c: num(d.c, 30, 45, 1), method: pick(d.method, ['rectal', 'armpit', 'ear', 'forehead', 'oral'] as const), note });
    case 'activity':
      return clean({ type: pick(d.type, ['tummy', 'bath', 'play', 'outdoor', 'reading', 'skin'] as const), note });
    case 'note':
      return clean({ note });
  }
}

/** A client's entry → a row the room can store, or why not. */
export function sanitizeTrack(
  input: Record<string, unknown>,
  who: { name: string; uid: string },
  now: number,
): { ok: true; row: TrackRow } | { ok: false; error: string } {
  const kind = pick(input.kind, TRACK_KINDS);
  if (!kind) return { ok: false, error: 'Unknown entry type.' };
  const id = typeof input.id === 'string' && /^[A-Za-z0-9_-]{6,40}$/.test(input.id) ? input.id : null;
  if (!id) return { ok: false, error: 'Bad id.' };
  // Out-of-range times are refused, not clamped (a wrong clock shouldn't quietly move an entry).
  const inRange = (v: unknown) => typeof v === 'number' && Number.isFinite(v) && v >= now - 400 * DAY && v <= now + 5 * 60_000;
  if (!inRange(input.start)) return { ok: false, error: 'That time is out of range.' };
  const start = Math.round(input.start as number);
  if (input.end != null && !inRange(input.end)) return { ok: false, error: 'That time is out of range.' };
  let end: number | null = input.end == null ? null : Math.round(input.end as number);
  if (end == null && !TIMED.has(kind)) end = start;
  if (end != null && end < start) return { ok: false, error: 'It ends before it starts.' };
  if (end != null && end - start > MAX_SPAN[kind]) return { ok: false, error: 'That entry is too long.' };
  const data = sanitizeData(kind, (input.data && typeof input.data === 'object' ? input.data : {}) as Record<string, unknown>);
  if (kind === 'bottle' && data.ml == null) return { ok: false, error: 'Add how much they drank.' };
  if (kind === 'temp' && data.c == null) return { ok: false, error: 'Add the temperature.' };
  if (kind === 'growth' && data.kg == null && data.cm == null && data.headCm == null) return { ok: false, error: 'Add a measurement.' };
  if (kind === 'med' && !data.name) return { ok: false, error: 'Add the medicine’s name.' };
  if (kind === 'diaper' && !data.pee && !data.poo) data.pee = false;
  return { ok: true, row: { id, kind, start, end, by: who.name.slice(0, 60), by_uid: who.uid.slice(0, 80), data, src: 'manual', updated: now } };
}

/* ---------------------------------------------------------------- store */

const toRow = (r: Record<string, unknown>): TrackRow => {
  let data: Record<string, unknown> = {};
  try {
    data = JSON.parse(String(r.data)) as Record<string, unknown>;
  } catch { /* keep {} */ }
  return {
    id: String(r.id),
    kind: String(r.kind) as TrackKind,
    start: Number(r.start),
    end: r.end_at == null ? null : Number(r.end_at),
    by: String(r.by_name),
    by_uid: String(r.by_uid),
    data,
    src: r.src === 'monitor' ? 'monitor' : 'manual',
    updated: Number(r.updated),
    ...(Number(r.deleted) ? { deleted: true } : {}),
  };
};

export class TrackerStore {
  constructor(private sql: SqlExec) {
    for (const q of SCHEMA) sql.exec(q);
  }

  get(id: string): TrackRow | null {
    const r = this.sql.exec('SELECT * FROM mon_track WHERE id = ?', id).toArray()[0];
    return r ? toRow(r) : null;
  }

  /**
   * Insert or edit. An edit keeps who first logged it; a deleted entry can't
   * come back by being edited again (a stale offline phone).
   */
  put(row: TrackRow): TrackRow | null {
    const cur = this.get(row.id);
    if (cur?.deleted) return null;
    const out: TrackRow = cur ? { ...row, by: cur.by, by_uid: cur.by_uid, src: cur.src } : row;
    this.sql.exec(
      `INSERT INTO mon_track (id, kind, start, end_at, by_name, by_uid, data, src, updated, deleted) VALUES (?,?,?,?,?,?,?,?,?,0)
       ON CONFLICT(id) DO UPDATE SET kind = excluded.kind, start = excluded.start, end_at = excluded.end_at, data = excluded.data, updated = excluded.updated`,
      out.id, out.kind, out.start, out.end, out.by, out.by_uid, JSON.stringify(out.data), out.src, out.updated,
    );
    return out;
  }

  delete(id: string, now: number): boolean {
    const cur = this.get(id);
    if (!cur || cur.deleted) return false;
    this.sql.exec('UPDATE mon_track SET deleted = 1, updated = ? WHERE id = ?', now, id);
    return true;
  }

  /** Entries overlapping [from, to), plus anything still running. */
  range(from: number, to: number, limit = 3000): TrackRow[] {
    return this.sql
      .exec(
        `SELECT * FROM mon_track WHERE deleted = 0 AND start < ? AND (end_at IS NULL OR end_at >= ?) ORDER BY start LIMIT ?`,
        to, from, limit,
      )
      .toArray()
      .map(toRow);
  }

  running(): TrackRow[] {
    return this.sql.exec('SELECT * FROM mon_track WHERE deleted = 0 AND end_at IS NULL ORDER BY start').toArray().map(toRow);
  }

  /** The most recent entry of each kind (for "last fed 2 h ago"). */
  latest(): Partial<Record<TrackKind, TrackRow>> {
    const rows = this.sql
      .exec(
        `SELECT t.* FROM mon_track t JOIN (SELECT kind, MAX(start) AS s FROM mon_track WHERE deleted = 0 GROUP BY kind) m
         ON m.kind = t.kind AND m.s = t.start WHERE t.deleted = 0`,
      )
      .toArray()
      .map(toRow);
    const out: Partial<Record<TrackKind, TrackRow>> = {};
    for (const r of rows) out[r.kind] = r;
    return out;
  }

  /** Changes (including deletes) since a phone last synced. */
  changedSince(updated: number, limit = 2000): TrackRow[] {
    return this.sql.exec('SELECT * FROM mon_track WHERE updated > ? ORDER BY updated LIMIT ?', updated, limit).toArray().map(toRow);
  }

  purge(now: number): void {
    this.sql.exec('DELETE FROM mon_track WHERE deleted = 1 AND updated < ?', now - 60 * DAY);
    this.sql.exec('DELETE FROM mon_track WHERE start < ?', now - TRACK_RETAIN_MS);
    // A timer nobody stopped for a day is a mistake, not a 3-week sleep.
    this.sql.exec('UPDATE mon_track SET end_at = start + 3600000, updated = ? WHERE end_at IS NULL AND start < ?', now, now - DAY);
  }

  csv(from: number, to: number, fmt: (t: number) => string): string {
    const esc = (v: unknown) => {
      const s = v == null ? '' : String(v);
      const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
      return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
    };
    const lines = ['start,end,minutes,type,details,logged_by'];
    for (const r of this.range(from, to, 20000)) {
      const mins = r.end != null ? Math.round((r.end - r.start) / 60_000) : '';
      const details = Object.entries(r.data).map(([k, v]) => `${k}=${v}`).join('; ');
      lines.push([fmt(r.start), r.end != null ? fmt(r.end) : 'running', mins, r.kind, details, r.by].map(esc).join(','));
    }
    return lines.join('\r\n');
  }
}
