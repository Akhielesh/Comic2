/**
 * This device's own usage ledger (Phase B receipts): what THIS device watched, saved and hosted.
 * It lives in localStorage only — never sent anywhere — and is small and bounded:
 *
 *   - nights per nursery: minutes per path between 18:00 and 09:00 local time (the
 *     "Last night: 10 h · 98% direct · free" receipt in Nursery settings), last 14 nights;
 *   - the month (UTC, like the server's usage rows): baby-monitor minutes per path on this
 *     device, and bytes saved to Google Drive, this device, or a 7-day copy — this month and
 *     last, older months are dropped;
 *   - meetings this device hosted: guest-minutes per path and relay bytes, last 20 events
 *     (the recap's Delivery block).
 *
 * Every read and write is wrapped: private mode, a full disk or blocked storage just means
 * nothing is shown. Display only — never a limit.
 */
import { monthKey, prevMonthKey, STREAM_PATHS, type StreamPath } from '@/shared/stream/usage';
import { zeroPaths, type PathMs, type SessionTotals } from './sessionMeter';

const NIGHTS_KEY = (nid: string) => `ds-usage-nights-${nid}`;
const MONTH_KEY = (month: string) => `ds-usage-device-${month}`;
const MEETINGS_KEY = 'ds-usage-meetings';
const KEEP_NIGHTS = 14;
const KEEP_MEETINGS = 20;
/** A night: 18:00 → 09:00 local. */
export const NIGHT_FROM_H = 18;
export const NIGHT_TO_H = 9;

function read<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

function write(key: string, v: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(v));
  } catch { /* storage unavailable */ }
}

const cleanPaths = (x: unknown): PathMs => {
  const out = zeroPaths();
  const o = (x && typeof x === 'object' ? x : {}) as Record<string, unknown>;
  for (const p of STREAM_PATHS) {
    const v = Number(o[p]);
    out[p] = Number.isFinite(v) && v > 0 ? v : 0;
  }
  return out;
};

/** 'YYYY-MM-DD' of a local calendar day. */
const dayKey = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/**
 * The night windows [D 18:00, D+1 09:00) local that [from, to) overlaps, keyed by the date of
 * the evening D, with the overlap in ms.
 */
export function nightOverlaps(from: number, to: number): { key: string; ms: number }[] {
  if (!(to > from)) return [];
  const out: { key: string; ms: number }[] = [];
  const start = new Date(from);
  // The evening before `from` can own its early-morning hours.
  const d = new Date(start.getFullYear(), start.getMonth(), start.getDate() - 1);
  for (let i = 0; i < 400; i++) {
    const wStart = new Date(d.getFullYear(), d.getMonth(), d.getDate(), NIGHT_FROM_H).getTime();
    if (wStart >= to) break;
    const wEnd = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1, NIGHT_TO_H).getTime();
    const ms = Math.min(to, wEnd) - Math.max(from, wStart);
    if (ms > 0) out.push({ key: dayKey(d), ms });
    d.setDate(d.getDate() + 1);
  }
  return out;
}

/* -------------------------------------------------------------- nights */

type Nights = Record<string, PathMs>;

/** A stretch of watching on one path (from the viewer's SessionMeter). */
export function addNightSegment(nid: string, path: StreamPath, from: number, to: number): void {
  const parts = nightOverlaps(from, to);
  if (!parts.length) return;
  const nights: Nights = read<Nights>(NIGHTS_KEY(nid)) ?? {};
  for (const { key, ms } of parts) {
    const cur = cleanPaths(nights[key]);
    cur[path] += ms;
    nights[key] = cur;
  }
  const keep = Object.keys(nights).sort().slice(-KEEP_NIGHTS);
  write(NIGHTS_KEY(nid), Object.fromEntries(keep.map((k) => [k, nights[k]])));
}

export interface NightSummary {
  key: string;
  /** "Last night" or "Tonight so far". */
  label: string;
  ms: PathMs;
}

/**
 * The night to show now: tonight's while it's evening and something was watched, else the
 * night that ended this morning (or is ending now, before 09:00).
 */
export function nightSummary(nid: string, now = Date.now()): NightSummary | null {
  const nights = read<Nights>(NIGHTS_KEY(nid));
  if (!nights) return null;
  const t = new Date(now);
  const today = dayKey(t);
  const yesterday = dayKey(new Date(t.getFullYear(), t.getMonth(), t.getDate() - 1));
  const has = (k: string) => {
    const ms = cleanPaths(nights[k]);
    return STREAM_PATHS.some((p) => ms[p] > 0) ? ms : null;
  };
  if (t.getHours() >= NIGHT_FROM_H) {
    const tonight = has(today);
    if (tonight) return { key: today, label: 'Tonight so far', ms: tonight };
  }
  const last = has(yesterday);
  return last ? { key: yesterday, label: 'Last night', ms: last } : null;
}

/* ----------------------------------------------------------- the month */

export type SaveDest = 'drive' | 'device' | 'cloud';

export interface DeviceMonth {
  month: string;
  /** Baby-monitor watching on this device, ms per path. */
  monitor: PathMs;
  /** Bytes saved, by where they went. */
  saves: Record<SaveDest, number>;
}

const emptyMonth = (month: string): DeviceMonth => ({ month, monitor: zeroPaths(), saves: { drive: 0, device: 0, cloud: 0 } });

export function deviceMonth(month = monthKey(Date.now())): DeviceMonth {
  const raw = read<Partial<DeviceMonth>>(MONTH_KEY(month));
  if (!raw) return emptyMonth(month);
  const saves = (raw.saves ?? {}) as Partial<Record<SaveDest, number>>;
  const n = (v: unknown) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : 0);
  return { month, monitor: cleanPaths(raw.monitor), saves: { drive: n(saves.drive), device: n(saves.device), cloud: n(saves.cloud) } };
}

function updateMonth(at: number, fn: (m: DeviceMonth) => void): void {
  const month = monthKey(at);
  const m = deviceMonth(month);
  fn(m);
  write(MONTH_KEY(month), m);
  // Only this month and last are kept.
  try {
    const keep = new Set([MONTH_KEY(month), MONTH_KEY(prevMonthKey(month))]);
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const k = localStorage.key(i);
      if (k && k.startsWith('ds-usage-device-') && !keep.has(k)) localStorage.removeItem(k);
    }
  } catch { /* storage unavailable */ }
}

/** Monitor watching on this device (split across months at the UTC boundary is not worth it: credited to `to`). */
export function addMonitorMs(path: StreamPath, from: number, to: number): void {
  const ms = to - from;
  if (!(ms > 0)) return;
  updateMonth(to, (m) => {
    m.monitor[path] += ms;
  });
}

/** A recording saved somewhere (the save sheet, on success). */
export function addSave(dest: SaveDest, bytes: number, at = Date.now()): void {
  if (!(bytes > 0)) return;
  updateMonth(at, (m) => {
    m.saves[dest] += bytes;
  });
}

/* ------------------------------------------------------------ meetings */

export interface MeetingUse {
  eventId: string;
  /** Guest-minutes per path (ms), every guest's link added up. */
  ms: PathMs;
  /** TURN bytes this (host) device received on its own relay candidates. */
  turnBytes: number;
  /** Guests who linked up. */
  guests: number;
  at: number;
}

export function saveMeetingUse(eventId: string, totals: SessionTotals, guests: number, at = Date.now()): void {
  if (!eventId) return;
  const all = (read<MeetingUse[]>(MEETINGS_KEY) ?? []).filter((m) => m && m.eventId !== eventId);
  all.push({ eventId, ms: cleanPaths(totals.ms), turnBytes: Math.max(0, totals.turnBytes || 0), guests: Math.max(0, guests | 0), at });
  write(MEETINGS_KEY, all.slice(-KEEP_MEETINGS));
}

export function meetingUse(eventId: string): MeetingUse | null {
  const m = (read<MeetingUse[]>(MEETINGS_KEY) ?? []).find((x) => x && x.eventId === eventId);
  return m ? { ...m, ms: cleanPaths(m.ms) } : null;
}
