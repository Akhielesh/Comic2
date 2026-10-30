// Comic History — "this morning", "yesterday", "Tue 10:42" (versions plan §9; package H0). Pure.
//
// resolveWhen turns a spoken time into a window [start, end) of epoch ms in the user's IANA time zone (the stream
// request's `tz`). The history list then picks "the latest row with content_at < end" — so "yesterday" is the
// latest state before local midnight, and "how page 3 looked this morning" is the latest one before 12:00 local.
// Without a valid tz the window is computed in UTC and `utc: true` tells the director to say so.
// Local midnights are found through Intl offsets, so DST days are 23 or 25 hours long, as they really are.

import { normalizeTimeZone } from '../events.js';
import type { DayPart, HistoryWhen } from './types.js';

export interface WhenWindow {
  /** Inclusive start (epoch ms). */
  start: number;
  /** Exclusive end (epoch ms), never later than now + 1 ms. */
  end: number;
  /** The zone used. */
  tz: string;
  /** No valid tz was given: the window is UTC (the director says so). */
  utc: boolean;
  /** Plain words: "yesterday", "this morning", "Mon 27 Oct at 10:42". */
  label: string;
  /** The whole window is in the future (nothing can match). */
  future: boolean;
}

/** Local hour windows of a day part ([from, to) hours; night runs into the next morning). */
export const DAY_PARTS: Readonly<Record<DayPart, [from: number, to: number]>> = {
  morning: [5, 12],
  afternoon: [12, 17],
  evening: [17, 21],
  night: [21, 29]
};

const DAY_MS = 86_400_000;
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

interface LocalParts {
  y: number;
  m: number;
  d: number;
  h: number;
  mi: number;
  s: number;
}

const formatters = new Map<string, Intl.DateTimeFormat>();
const formatterFor = (tz: string): Intl.DateTimeFormat => {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit'
    });
    formatters.set(tz, f);
  }
  return f;
};

/** The wall-clock parts of an instant in a zone. */
export const localParts = (ms: number, tz: string): LocalParts => {
  const out: Record<string, number> = {};
  for (const p of formatterFor(tz).formatToParts(new Date(ms))) if (p.type !== 'literal') out[p.type] = Number(p.value);
  return { y: out.year, m: out.month, d: out.day, h: out.hour === 24 ? 0 : out.hour, mi: out.minute, s: out.second };
};

/** The zone's offset from UTC at an instant (ms; IST = +19 800 000). */
const offsetAt = (ms: number, tz: string): number => {
  const p = localParts(ms, tz);
  return Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi, p.s) - Math.floor(ms / 1000) * 1000;
};

/** The instant a local wall-clock time occurs in a zone (overflowing day/hour values roll over, like Date.UTC). */
export const zonedTime = (y: number, m: number, d: number, h: number, mi: number, tz: string): number => {
  const guess = Date.UTC(y, m - 1, d, h, mi);
  const first = guess - offsetAt(guess, tz);
  const second = guess - offsetAt(first, tz);
  return second;
};

const ISO_DAY = /^(\d{4})-(\d{2})-(\d{2})$/;
const HH_MM = /^([01]?\d|2[0-3]):([0-5]\d)$/;

const dayLabel = (y: number, m: number, d: number): string => {
  const wd = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return `${WEEKDAYS[wd]} ${d} ${MONTHS[m - 1]}`;
};

const PART_WORDS: Record<DayPart, { today: string; yesterday: string; other: string }> = {
  morning: { today: 'this morning', yesterday: 'yesterday morning', other: 'morning' },
  afternoon: { today: 'this afternoon', yesterday: 'yesterday afternoon', other: 'afternoon' },
  evening: { today: 'this evening', yesterday: 'yesterday evening', other: 'evening' },
  night: { today: 'tonight', yesterday: 'last night', other: 'night' }
};

/**
 * The window a spoken time names, or null when it cannot be read (an unknown day word, a bad date or time).
 * day: 'today' | 'yesterday' | 'YYYY-MM-DD'; part: morning | afternoon | evening | night; at: 'HH:MM' (that minute
 * included). `now` is passed in (pure).
 */
export const resolveWhen = (when: HistoryWhen, now: number, tz?: string | null): WhenWindow | null => {
  if (!when || typeof when !== 'object' || typeof when.day !== 'string' || !Number.isFinite(now)) return null;
  const zone = normalizeTimeZone(tz) ?? 'UTC';
  const utc = normalizeTimeZone(tz) === undefined;
  const today = localParts(now, zone);
  const raw = when.day.trim().toLowerCase();
  let y: number;
  let m: number;
  let d: number;
  let rel: 'today' | 'yesterday' | 'other';
  if (raw === 'today' || raw === 'now') {
    ({ y, m, d } = today);
    rel = 'today';
  } else if (raw === 'yesterday') {
    const prev = new Date(Date.UTC(today.y, today.m - 1, today.d - 1));
    y = prev.getUTCFullYear();
    m = prev.getUTCMonth() + 1;
    d = prev.getUTCDate();
    rel = 'yesterday';
  } else {
    const iso = ISO_DAY.exec(raw);
    if (!iso) return null;
    y = Number(iso[1]);
    m = Number(iso[2]);
    d = Number(iso[3]);
    const check = new Date(Date.UTC(y, m - 1, d));
    if (check.getUTCFullYear() !== y || check.getUTCMonth() !== m - 1 || check.getUTCDate() !== d) return null;
    rel = y === today.y && m === today.m && d === today.d ? 'today' : 'other';
  }
  const part = when.part && Object.prototype.hasOwnProperty.call(DAY_PARTS, when.part) ? when.part : undefined;
  if (when.part !== undefined && !part) return null;
  let start = zonedTime(y, m, d, 0, 0, zone);
  let end = zonedTime(y, m, d + 1, 0, 0, zone);
  let label = rel === 'today' ? 'today' : rel === 'yesterday' ? 'yesterday' : dayLabel(y, m, d);
  if (part) {
    const [from, to] = DAY_PARTS[part];
    start = zonedTime(y, m, d, from, 0, zone);
    end = zonedTime(y, m, d, to, 0, zone);
    label = rel === 'other' ? `${dayLabel(y, m, d)} ${PART_WORDS[part].other}` : PART_WORDS[part][rel];
  }
  if (typeof when.at === 'string' && when.at.trim()) {
    const hm = HH_MM.exec(when.at.trim());
    if (!hm) return null;
    const hh = Number(hm[1]);
    const mm = Number(hm[2]);
    end = zonedTime(y, m, d, hh, mm, zone) + 60_000;
    label = `${rel === 'today' ? 'today' : rel === 'yesterday' ? 'yesterday' : dayLabel(y, m, d)} at ${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
  }
  const future = start > now;
  return { start, end: Math.min(end, now + 1), tz: zone, utc, label, future };
};

/** The History list's day group of an instant: 'Today' | 'Yesterday' | 'Mon 27 Oct' (in the viewer's zone). */
export const dayGroupLabel = (ms: number, now: number, tz?: string | null): string => {
  const zone = normalizeTimeZone(tz) ?? 'UTC';
  const a = localParts(ms, zone);
  const b = localParts(now, zone);
  const days = Math.round((Date.UTC(b.y, b.m - 1, b.d) - Date.UTC(a.y, a.m - 1, a.d)) / DAY_MS);
  if (days === 0) return 'Today';
  if (days === 1) return 'Yesterday';
  return dayLabel(a.y, a.m, a.d);
};

/** 'HH:MM' of an instant in a zone (tabular times in the list). */
export const clockLabel = (ms: number, tz?: string | null): string => {
  const p = localParts(ms, normalizeTimeZone(tz) ?? 'UTC');
  return `${String(p.h).padStart(2, '0')}:${String(p.mi).padStart(2, '0')}`;
};

/** The latest of `items` whose time is inside the window (null when none) — "the version yesterday" picker. */
export const latestInWindow = <T>(items: readonly T[], timeOf: (item: T) => number, window: Pick<WhenWindow, 'end'> & { start?: number }): T | null => {
  let best: T | null = null;
  let bestAt = -Infinity;
  for (const item of items) {
    const t = timeOf(item);
    if (!Number.isFinite(t) || t >= window.end || (window.start !== undefined && t < window.start)) continue;
    if (t > bestAt) {
      best = item;
      bestAt = t;
    }
  }
  return best;
};
