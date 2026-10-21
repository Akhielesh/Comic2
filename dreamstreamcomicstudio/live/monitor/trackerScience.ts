/**
 * Baby tracker science — the arithmetic behind the tracker's predictions,
 * daily totals, gentle checks and weekly insights. Pure functions only: every
 * result depends on the items, the profile and the `now` passed in (never the
 * clock), and on an optional IANA time zone for anything about "local" time.
 *
 *   items ─┬─ sleeps ─→ wake windows (personal median ⊕ age range) ─→ next-sleep sweet spot
 *          ├─ feeds  ─→ start-to-start interval (personal median | age) ─→ next feed + side
 *          ├─ a day  ─→ totals (clipped at the day's edges) ─→ wet-diaper check
 *          ├─ temps  ─→ fever guidance by age and method
 *          ├─ meds   ─→ earliest next dose from the parent's own interval
 *          └─ 7 + 7 days ─→ up to four kind, useful insights
 *
 * Sources (guidance ranges, not clinical standards — nothing here diagnoses):
 *  - Total sleep per 24 h: Paruthi S. et al., "Recommended amount of sleep for
 *    pediatric populations: a consensus statement of the American Academy of
 *    Sleep Medicine", J Clin Sleep Med 2016 (4–12 mo 12–16 h, 1–2 y 11–14 h;
 *    endorsed by the AAP); under 4 months: Hirshkowitz M. et al., National
 *    Sleep Foundation recommendations, Sleep Health 2015 (0–3 mo 14–17 h).
 *  - Wake windows: there is no clinical standard. The table below follows the
 *    ranges commonly published by pediatric sleep resources (e.g. Huckleberry,
 *    the Sleep Foundation): ~35–60 min for newborns rising to 4–6 h by the
 *    second year. The baby's own history matters more, so the prediction
 *    blends in the median of their recent wake windows, kept inside the range.
 *    Bedtime windows reflect that a circadian rhythm emerges at ~2–4 months.
 *  - Feeding: AAP / HealthyChildren.org "How often and how much should your
 *    baby eat?" — newborns 8–12 feeds per 24 h (every 2–3 h, counted from the
 *    start of one feed to the start of the next), spacing out with age.
 *  - Diapers: AAP / HealthyChildren.org and common lactation guidance — about
 *    one wet diaper per day of life for the first days, then 6+ a day after
 *    day 5; fewer can mean not enough milk. White/pale, red or (after the
 *    meconium days) black stool needs a call (AAP stool-colour guidance).
 *  - Fever: AAP / HealthyChildren.org "Fever and your baby" — under 3 months
 *    a rectal 38.0 °C (100.4 °F) or higher needs a doctor right away; 3–6
 *    months call at 38.9 °C (102 °F); any age 40 °C (104 °F) is urgent. Rectal
 *    is the reference for infants; armpit reads lower (fever ≥ 37.2 °C),
 *    mouth slightly lower (≥ 37.8 °C).
 *  - Tummy time: AAP "Back to sleep, tummy to play" — work up to 15–30 min a
 *    day by ~7 weeks; WHO 2019 activity guidelines — at least 30 min a day
 *    spread through the day for infants not yet mobile.
 *  - Growth: WHO Child Growth Standards (see ./whoGrowth).
 *  - Medicine: timing only, from the interval the parent typed — doses are
 *    never computed here.
 *
 * Every function ignores `deleted` items, and camera-detected sleep that a
 * parent also logged by hand counts once (see `dedupeSleep`).
 */

import type { BabyProfile, TrackData, TrackItem } from './trackTypes';
import { growthPoint, type GrowthPoint } from './whoGrowth';

// Shared shapes live in ./trackTypes; re-exported so either import path works.
export type { BabyProfile, TrackData, TrackItem, TrackKind } from './trackTypes';

export type Side = 'left' | 'right';
export type MilkType = NonNullable<TrackData['milk']>;
export type DiaperColor = NonNullable<TrackData['color']>;
export type TempMethod = NonNullable<TrackData['method']>;
export type ActivityType = NonNullable<TrackData['type']>;

const MIN = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;

const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));
const byStart = (a: TrackItem, b: TrackItem) => a.start - b.start || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
const overlap = (a0: number, a1: number, b0: number, b1: number) => Math.max(0, Math.min(a1, b1) - Math.max(a0, b0));
const opposite = (s: Side): Side => (s === 'left' ? 'right' : 'left');

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

const mean = (xs: number[]) => xs.reduce((a, x) => a + x, 0) / xs.length;
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** "45 min", "1 h", "5 h 10 min". */
export function formatDuration(min: number): string {
  const m = Math.max(0, Math.round(min));
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  const r = m % 60;
  return r ? `${h} h ${r} min` : `${h} h`;
}

// ── Clean-up: deleted items and camera/manual sleep overlaps ───────────────

/**
 * The items every calculation should see: deleted items removed, and
 * camera-detected sleep (`src: 'monitor'`) dropped wherever a manual sleep
 * entry overlaps it by ≥ 50 % of the shorter of the two — the parent's own
 * log wins. Running sleeps are measured up to `now` (open-ended without it).
 * Order is preserved.
 */
export function dedupeSleep(items: TrackItem[], now?: number): TrackItem[] {
  const live = items.filter((i) => i && !i.deleted);
  const endOf = (i: TrackItem) => Math.max(i.start, i.end ?? now ?? Infinity);
  const manual = live.filter((i) => i.kind === 'sleep' && i.src !== 'monitor');
  if (!manual.length) return live;
  return live.filter((m) => {
    if (m.kind !== 'sleep' || m.src !== 'monitor') return true;
    const m1 = endOf(m);
    return !manual.some((u) => {
      const u1 = endOf(u);
      const ov = overlap(m.start, m1, u.start, u1);
      return ov > 0 && ov >= 0.5 * Math.min(m1 - m.start, u1 - u.start);
    });
  });
}

// ── Local time (time-zone aware via Intl) ──────────────────────────────────

export interface LocalParts {
  year: number;
  month: number; // 1–12
  day: number;
  hour: number; // 0–23
  minute: number;
  second: number;
}

const formatters = new Map<string, Intl.DateTimeFormat>();
function formatter(tz?: string): Intl.DateTimeFormat {
  const key = tz ?? '';
  let f = formatters.get(key);
  if (!f) {
    const opts: Intl.DateTimeFormatOptions = { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false };
    try {
      f = new Intl.DateTimeFormat('en-US', tz ? { ...opts, timeZone: tz } : opts);
    } catch {
      f = new Intl.DateTimeFormat('en-US', opts); // unknown zone → this device's local time
    }
    formatters.set(key, f);
  }
  return f;
}

/** Wall-clock parts of an instant in `tz` (or this device's local zone). */
export function localParts(ms: number, tz?: string): LocalParts {
  const out: LocalParts = { year: 0, month: 0, day: 0, hour: 0, minute: 0, second: 0 };
  for (const p of formatter(tz).formatToParts(ms)) {
    switch (p.type) {
      case 'year': out.year = Number(p.value); break;
      case 'month': out.month = Number(p.value); break;
      case 'day': out.day = Number(p.value); break;
      case 'hour': out.hour = Number(p.value) % 24; break; // some engines print midnight as "24"
      case 'minute': out.minute = Number(p.value); break;
      case 'second': out.second = Number(p.value); break;
    }
  }
  return out;
}

/** Local hour of day as a fraction (13.5 = 1:30 pm). */
export function localHour(ms: number, tz?: string): number {
  const p = localParts(ms, tz);
  return p.hour + p.minute / 60 + p.second / 3600;
}

/** Local calendar date "YYYY-MM-DD". */
export function dayKey(ms: number, tz?: string): string {
  const p = localParts(ms, tz);
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

/** Wall time minus UTC at an instant, in ms. */
function zoneOffset(ms: number, tz?: string): number {
  const p = localParts(ms, tz);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(ms / 1000) * 1000;
}

/** Epoch ms of the local midnight that starts the day containing `ms` (DST-safe). */
export function startOfLocalDay(ms: number, tz?: string): number {
  const p = localParts(ms, tz);
  const wall = Date.UTC(p.year, p.month - 1, p.day);
  const guess = wall - zoneOffset(ms, tz);
  return wall - zoneOffset(guess, tz);
}

/** The local day containing `ms`: [start, end) — 23 or 25 hours long on DST days. */
export function dayBounds(ms: number, tz?: string): { start: number; end: number } {
  const start = startOfLocalDay(ms, tz);
  return { start, end: startOfLocalDay(start + 36 * HOUR, tz) };
}

// ── Age ────────────────────────────────────────────────────────────────────

function parseBirth(birth: string | null | undefined): { y: number; m: number; d: number; utc: number } | null {
  const r = birth ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(birth.trim()) : null;
  if (!r) return null;
  const [y, m, d] = [Number(r[1]), Number(r[2]), Number(r[3])];
  const utc = Date.UTC(y, m - 1, d);
  const back = new Date(utc);
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== m - 1 || back.getUTCDate() !== d) return null;
  return { y, m, d, utc };
}

/**
 * Whole days since birth on the family's local calendar (born today = 0).
 * Null without a valid birth date, or when the birth date is in the future.
 */
export function ageDays(profile: BabyProfile | null | undefined, now: number, tz?: string): number | null {
  const b = parseBirth(profile?.birth);
  if (!b) return null;
  const p = localParts(now, tz);
  const days = Math.round((Date.UTC(p.year, p.month - 1, p.day) - b.utc) / DAY);
  return days < 0 ? null : days;
}

/** "newborn", "5 days", "3 weeks", "4 months", "1 year", "1 year 2 months"; '' without a birth date. */
export function ageLabel(profile: BabyProfile | null | undefined, now: number, tz?: string): string {
  const days = ageDays(profile, now, tz);
  const b = parseBirth(profile?.birth);
  if (days === null || !b) return '';
  if (days === 0) return 'newborn';
  if (days < 14) return plural(days, 'day');
  const p = localParts(now, tz);
  const months = (p.year - b.y) * 12 + (p.month - b.m) - (p.day < b.d ? 1 : 0);
  if (months < 2) return plural(Math.floor(days / 7), 'week');
  if (months < 12) return plural(months, 'month');
  const y = Math.floor(months / 12);
  const r = months % 12;
  return r ? `${plural(y, 'year')} ${plural(r, 'month')}` : plural(y, 'year');
}

// ── Age norms ──────────────────────────────────────────────────────────────

export interface WakeWindowRange {
  /** Age bracket, e.g. "3–4 months". */
  label: string;
  /** Typical wake window, minutes. */
  min: number;
  max: number;
  /** Typical naps per day. */
  naps: number;
  /** Typical bedtime window as local hours (19.5 = 7:30 pm); null for newborns (no rhythm yet). */
  bedtime: { from: number; to: number } | null;
}

const WAKE: readonly (WakeWindowRange & { upTo: number })[] = [
  { upTo: 28, label: '0–4 weeks', min: 35, max: 60, naps: 5, bedtime: null },
  { upTo: 84, label: '4–12 weeks', min: 60, max: 90, naps: 4, bedtime: { from: 19.5, to: 22 } },
  { upTo: 152, label: '3–4 months', min: 75, max: 120, naps: 4, bedtime: { from: 19, to: 20.5 } },
  { upTo: 213, label: '5–7 months', min: 120, max: 180, naps: 3, bedtime: { from: 19, to: 20.5 } },
  { upTo: 320, label: '7–10 months', min: 150, max: 210, naps: 2, bedtime: { from: 19, to: 20.5 } },
  { upTo: 426, label: '11–14 months', min: 180, max: 240, naps: 2, bedtime: { from: 19, to: 20.5 } },
  { upTo: 731, label: '14–24 months', min: 240, max: 360, naps: 1, bedtime: { from: 19, to: 20.5 } },
  { upTo: Infinity, label: '2 years +', min: 300, max: 360, naps: 1, bedtime: { from: 19, to: 20.5 } },
];

/** Commonly published wake-window range for an age in days (guidance, not a clinical standard). */
export function wakeWindowRange(ageDays: number): WakeWindowRange {
  const d = Number.isFinite(ageDays) ? Math.max(0, ageDays) : 0;
  const { upTo: _upTo, ...row } = WAKE.find((w) => d < w.upTo) ?? WAKE[WAKE.length - 1];
  return { ...row, bedtime: row.bedtime ? { ...row.bedtime } : null };
}

/** Recommended total sleep per 24 h (hours) — NSF under 4 months, AASM/AAP after. */
export function sleepNeedHours(ageDays: number): { min: number; max: number } {
  if (ageDays < 122) return { min: 14, max: 17 };
  if (ageDays < 365) return { min: 12, max: 16 };
  if (ageDays < 1096) return { min: 11, max: 14 };
  return { min: 10, max: 13 };
}

/** Typical start-to-start feeding interval (minutes) by age — used until there's personal history. */
export function feedIntervalRange(ageDays: number): { min: number; max: number } {
  if (ageDays < 28) return { min: 120, max: 180 }; // 8–12 feeds a day
  if (ageDays < 90) return { min: 150, max: 240 };
  if (ageDays < 180) return { min: 180, max: 240 };
  if (ageDays < 365) return { min: 210, max: 300 }; // 4–6 milk feeds + solids
  return { min: 180, max: 300 };
}

// ── Sleep ──────────────────────────────────────────────────────────────────

/**
 * Night sleep (vs a nap): starts 18:00–23:59 local, lasts ≥ 4 h, or spans
 * 02:00 local. Sleep that starts in the small hours (00:00–04:59) is night
 * too, so the stretch after a 3 am feed isn't mistaken for a nap. A running
 * sleep is measured up to `now`.
 */
export function isNightSleep(item: TrackItem, tz?: string, now?: number): boolean {
  if (item.kind !== 'sleep') return false;
  // The family's own call (nap / night) wins over the clock.
  if (typeof item.data.night === 'boolean') return item.data.night;
  const end = item.end ?? now ?? item.start;
  const h = localHour(item.start, tz);
  if (h >= 18 || h < 5) return true; // evening start, or small hours (covers spanning 02:00 from midnight on)
  if (end - item.start >= 4 * HOUR) return true; // covers spanning 02:00 from any daytime start
  return false;
}

export interface SleepPrediction {
  /** Centre of the sweet spot (epoch ms). May be in the past when overdue. */
  at: number;
  from: number;
  to: number;
  basis: 'age' | 'personal';
  /** The wake window used, minutes. */
  windowMin: number;
  /** Which sleep of the day this is (1 = first nap); 0 = back to sleep during the night. */
  napOfDay: number;
  bedtime: boolean;
  /** When the baby last woke (epoch ms). */
  lastWake: number;
  /** Personal wake windows that informed it. */
  samples: number;
  reason: string;
}

const NAP_MIN_FOR_WINDOW = 20; // minutes — shorter catnaps don't say much about readiness
const PERSONAL_DAYS = 7;
const PERSONAL_MIN_SAMPLES = 3;

/** Wake windows (minutes) that preceded a nap of ≥ 20 min in the last 7 days. */
function personalWakeWindows(done: TrackItem[], now: number, range: WakeWindowRange | null, tz?: string): number[] {
  const since = now - PERSONAL_DAYS * DAY;
  const lo = range ? Math.max(10, range.min * 0.5) : 10;
  const hi = range ? range.max * 2 : 480;
  const out: number[] = [];
  for (let k = 1; k < done.length; k++) {
    const s = done[k];
    const prev = done[k - 1];
    if (s.start < since || s.end === null || prev.end === null) continue;
    if (isNightSleep(s, tz) || s.end - s.start < NAP_MIN_FOR_WINDOW * MIN) continue;
    const w = (s.start - prev.end) / MIN;
    if (w >= lo && w <= hi) out.push(w); // outside → probably a missed log
  }
  return out;
}

/**
 * The next sleep's "sweet spot" — like Huckleberry's SweetSpot: when the
 * baby is likely to be ready, from how long they've been awake.
 *
 * Wake window = the age range's midpoint, or — with ≥ 3 recent samples — the
 * median of the baby's own wake windows before naps ≥ 20 min (last 7 days),
 * blended with the midpoint (personal weight n/(n+3), max 0.75) and clamped
 * to the range. The first window of the day runs ~10 % shorter, the last
 * before bed ~15 % longer (still inside the range). Bedtime is predicted once
 * another nap wouldn't fit before the age's bedtime window, or the day's
 * usual naps are done. Null while a sleep is running, without sleep data,
 * or when the last wake-up is too long ago to mean anything.
 */
export function predictNextSleep(items: TrackItem[], profile: BabyProfile | null, now: number, tz?: string): SleepPrediction | null {
  const sleeps = dedupeSleep(items, now).filter((i) => i.kind === 'sleep' && i.start <= now).sort(byStart);
  if (!sleeps.length) return null;
  if (sleeps.some((s) => s.end === null || s.end > now)) return null; // asleep
  const done = sleeps.filter((s) => s.end !== null && s.end > s.start);
  if (!done.length) return null;
  const last = done.reduce((a, s) => ((s.end as number) > (a.end as number) ? s : a));
  const lastWake = last.end as number;

  const age = ageDays(profile, now, tz);
  const range = age === null ? null : wakeWindowRange(age);
  const awake = (now - lastWake) / MIN;
  if (awake > Math.max(3 * (range?.max ?? 160), 480)) return null; // stale: nothing logged for ages

  const windows = personalWakeWindows(done, now, range, tz);
  const n = windows.length;
  let base: number;
  let basis: 'age' | 'personal';
  if (n >= PERSONAL_MIN_SAMPLES) {
    const med = median(windows);
    basis = 'personal';
    if (range) {
      const w = Math.min(0.75, n / (n + 3));
      base = clamp(w * med + (1 - w) * ((range.min + range.max) / 2), range.min, range.max);
    } else {
      base = clamp(med, 20, 420);
    }
  } else if (range) {
    basis = 'age';
    base = (range.min + range.max) / 2;
  } else {
    return null;
  }
  const lo = range?.min ?? 20;
  const hi = range?.max ?? 420;
  const spreadOf = (w: number) => clamp(Math.round(w * 0.1), 10, 30) * MIN;
  const lastIsNight = isNightSleep(last, tz);
  const wakeHour = localHour(lastWake, tz);
  const ranges = range ? `${formatDuration(range.min)}–${formatDuration(range.max)}` : '';
  const why =
    basis === 'personal'
      ? `Based on ${n} recent naps (median ${formatDuration(median(windows))} awake)${range ? `, kept within the usual ${ranges} for ${range.label}` : ''}.`
      : `Typical wake window for ${range?.label} is ${ranges}; log a few more naps to personalise.`;

  // Woke during the night → back to sleep, keep it short and calm.
  if (lastIsNight && (wakeHour >= 19 || wakeHour < 5)) {
    const win = lo;
    const at = lastWake + win * MIN;
    return {
      at, from: at - spreadOf(win), to: at + spreadOf(win), basis, windowMin: Math.round(win), napOfDay: 0, bedtime: true, lastWake, samples: n,
      reason: `Night waking — keep it dark and calm; most babies this age are ready to settle again within about ${formatDuration(win)}.`,
    };
  }

  // Naps since the morning wake-up (or since local midnight if the night wasn't logged).
  const lastNight = [...done].reverse().find((s) => isNightSleep(s, tz));
  const ref = lastNight && (lastNight.end as number) > now - 20 * HOUR ? (lastNight.end as number) : startOfLocalDay(now, tz);
  const napsToday = done.filter((s) => !isNightSleep(s, tz) && s.start >= ref).length;
  const napOfDay = napsToday + 1;

  let win = napsToday === 0 ? clamp(base * 0.9, lo, hi) : base;
  let bedtime = false;
  let reason = why;
  if (range?.bedtime) {
    const late = (t: number) => {
      const h = localHour(t, tz);
      return h < 5 ? h + 24 : h; // after midnight counts as late evening
    };
    const bedWin = clamp(base * 1.15, lo, hi);
    const napAt = lastWake + win * MIN;
    const bedAt = lastWake + bedWin * MIN;
    const noRoom = late(napAt) >= range.bedtime.from - 1;
    const napsDone = napsToday >= range.naps && late(bedAt) >= range.bedtime.from - 2.5;
    if (noRoom || napsDone) {
      bedtime = true;
      win = bedWin;
      const bh = late(bedAt);
      const hhmm = (x: number) => `${Math.floor(x) % 24}:${String(Math.round((x % 1) * 60)).padStart(2, '0')}`;
      const usual = `${hhmm(range.bedtime.from)}–${hhmm(range.bedtime.to)}`;
      reason =
        bh < range.bedtime.from
          ? `Bedtime — earlier than the usual ${usual}, which is fine (especially after short naps). ${why}`
          : bh > range.bedtime.to
            ? `Bedtime — a little later than the usual ${usual} window. ${why}`
            : `Bedtime, in the usual ${usual} window. ${why}`;
    }
  }
  const at = lastWake + win * MIN;
  return { at, from: at - spreadOf(win), to: at + spreadOf(win), basis, windowMin: Math.round(win), napOfDay, bedtime, lastWake, samples: n, reason };
}

// ── Feeding ────────────────────────────────────────────────────────────────

interface FeedSession {
  start: number;
  /** Latest end (or start, for running items) of the items in it. */
  until: number;
  items: TrackItem[];
}

/** Breast/bottle items starting within 30 min of the previous one's end are one feed (e.g. a top-up). */
const FEED_MERGE_MS = 30 * MIN;

function feedSessions(items: TrackItem[]): FeedSession[] {
  const out: FeedSession[] = [];
  for (const f of items.filter((i) => i.kind === 'breast' || i.kind === 'bottle').sort(byStart)) {
    const last = out[out.length - 1];
    const until = Math.max(f.start, f.end ?? f.start);
    if (last && f.start - last.until <= FEED_MERGE_MS) {
      last.items.push(f);
      last.until = Math.max(last.until, until);
    } else {
      out.push({ start: f.start, until, items: [f] });
    }
  }
  return out;
}

function sideOf(item: TrackItem): Side | undefined {
  if (item.data.side === 'left' || item.data.side === 'right') return item.data.side;
  const l = item.data.left ?? 0;
  const r = item.data.right ?? 0;
  if (l > 0 && r <= 0) return 'left';
  if (r > 0 && l <= 0) return 'right';
  return undefined;
}

export interface FeedPrediction {
  /** Expected start of the next feed (epoch ms). May be in the past when due. */
  at: number;
  /** Start-to-start interval used, minutes. */
  intervalMin: number;
  basis: 'age' | 'personal';
  /** Start of the most recent feed (epoch ms). */
  lastFeed: number;
  /** A breast/bottle timer is running right now. */
  feeding: boolean;
  /** Side the last breastfeed ended on (or is on now). */
  lastSide?: Side;
  /** Start the next breastfeed on this side. */
  suggestSide?: Side;
  /** Intervals the personal median used. */
  samples: number;
}

/**
 * When the next feed is likely, counted start-to-start (as the AAP does).
 * Personal: median interval between feeds in the last 24 h (48 h if fewer
 * than 6 intervals), needing ≥ 4 intervals. Otherwise the age midpoint
 * (newborns 2–3 h, …). Breastfeeding: start on the side opposite the one the
 * last feed ended on. Null without any feeds.
 */
export function predictNextFeed(items: TrackItem[], profile: BabyProfile | null, now: number, tz?: string): FeedPrediction | null {
  const past = dedupeSleep(items, now).filter((i) => i.start <= now);
  const sessions = feedSessions(past);
  if (!sessions.length) return null;
  const last = sessions[sessions.length - 1];
  const intervals = (hours: number) => {
    const recent = sessions.filter((s) => s.start >= now - hours * HOUR);
    const out: number[] = [];
    for (let i = 1; i < recent.length; i++) out.push((recent[i].start - recent[i - 1].start) / MIN);
    return out;
  };
  let iv = intervals(24);
  if (iv.length < 6) iv = intervals(48);
  const age = ageDays(profile, now, tz);
  let intervalMin: number;
  let basis: 'age' | 'personal';
  if (iv.length >= 4) {
    basis = 'personal';
    intervalMin = Math.round(clamp(median(iv), 45, 360));
  } else {
    basis = 'age';
    const r = age === null ? { min: 150, max: 210 } : feedIntervalRange(age);
    intervalMin = Math.round((r.min + r.max) / 2);
  }
  const out: FeedPrediction = {
    at: last.start + intervalMin * MIN,
    intervalMin,
    basis,
    lastFeed: last.start,
    feeding: past.some((i) => (i.kind === 'breast' || i.kind === 'bottle') && i.end === null && i.start > now - 6 * HOUR), // older = a forgotten timer
    samples: basis === 'personal' ? iv.length : 0,
  };
  const lastBreast = past.filter((i) => i.kind === 'breast' && i.start >= now - 2 * DAY).sort(byStart).pop();
  const side = lastBreast && sideOf(lastBreast);
  if (side) {
    out.lastSide = side;
    out.suggestSide = opposite(side);
  }
  return out;
}

// ── Day totals ─────────────────────────────────────────────────────────────

export interface DayTotals {
  /** Feeds (breast/bottle sessions, top-ups merged) that started in the day. */
  feeds: number;
  breastFeeds: number;
  bottleFeeds: number;
  /** Breastfeeding minutes per side, clipped to the day. */
  breastMin: { left: number; right: number; total: number };
  bottleMl: number;
  bottleMlByMilk: Record<MilkType, number>;
  solids: number;
  pumps: number;
  pumpMl: number;
  diapers: {
    total: number;
    /** Pee only. */
    wet: number;
    /** Poo only. */
    dirty: number;
    both: number;
    dry: number;
    /** Any pee (wet + both) — what the wet-diaper guidance counts. */
    wetTotal: number;
    /** Any poo (dirty + both). */
    dirtyTotal: number;
    rash: number;
    colors: Partial<Record<DiaperColor, number>>;
  };
  sleep: {
    totalMin: number;
    /** Nap minutes. */
    dayMin: number;
    nightMin: number;
    /** Naps that started in the day. */
    naps: number;
    /** Longest single sleep (full length) touching the day. */
    longestMin: number;
  };
  activityMin: Record<ActivityType, number> & { total: number };
  meds: number;
  medsByName: Record<string, number>;
  /** Highest temperature logged (°C), or null. */
  maxTempC: number | null;
}

/** Seconds per side of a breastfeed; a running one credits elapsed time to the current side. */
function breastSeconds(item: TrackItem, now: number): { left: number; right: number } {
  let left = Math.max(0, item.data.left ?? 0);
  let right = Math.max(0, item.data.right ?? 0);
  if (item.end === null) {
    const elapsed = Math.max(0, (now - item.start) / 1000);
    if (item.data.side === 'left') left = Math.max(left, elapsed - right);
    else if (item.data.side === 'right') right = Math.max(right, elapsed - left);
  } else if (left + right === 0) {
    const secs = Math.max(0, (item.end - item.start) / 1000);
    if (item.data.side === 'left') left = secs;
    else if (item.data.side === 'right') right = secs;
    else [left, right] = [secs / 2, secs / 2];
  }
  return { left, right };
}

/**
 * Totals for [dayStart, dayEnd) — usually a local day from `dayBounds`.
 * Durations (sleep, breastfeeding, activities) are clipped to the window;
 * counts and volumes belong to the day the item started in. Running timers
 * count up to `opts.now` (default: dayEnd). `opts.tz` decides night vs nap.
 */
export function dayTotals(items: TrackItem[], dayStart: number, dayEnd: number, opts: { now?: number; tz?: string } = {}): DayTotals {
  const now = opts.now ?? dayEnd;
  const tz = opts.tz;
  items = dedupeSleep(items, now);
  const t: DayTotals = {
    feeds: 0, breastFeeds: 0, bottleFeeds: 0,
    breastMin: { left: 0, right: 0, total: 0 },
    bottleMl: 0, bottleMlByMilk: { formula: 0, breast: 0, mixed: 0, other: 0 },
    solids: 0, pumps: 0, pumpMl: 0,
    diapers: { total: 0, wet: 0, dirty: 0, both: 0, dry: 0, wetTotal: 0, dirtyTotal: 0, rash: 0, colors: {} },
    sleep: { totalMin: 0, dayMin: 0, nightMin: 0, naps: 0, longestMin: 0 },
    activityMin: { tummy: 0, bath: 0, play: 0, outdoor: 0, reading: 0, skin: 0, teeth: 0, screen: 0, other: 0, total: 0 },
    meds: 0, medsByName: {}, maxTempC: null,
  };
  const inDay = (ms: number) => ms >= dayStart && ms < dayEnd;
  const medNames = new Map<string, string>();
  let breastL = 0;
  let breastR = 0;

  t.feeds = feedSessions(items.filter((i) => i.start <= now)).filter((s) => inDay(s.start)).length;

  for (const it of items) {
    if (it.start > now) continue;
    const end = it.end ?? Math.max(it.start, now);
    const d = it.data;
    switch (it.kind) {
      case 'breast': {
        if (inDay(it.start)) t.breastFeeds++;
        const span = end - it.start;
        const f = span > 0 ? overlap(it.start, end, dayStart, dayEnd) / span : inDay(it.start) ? 1 : 0;
        if (f > 0) {
          const s = breastSeconds(it, now);
          breastL += (s.left * f) / 60;
          breastR += (s.right * f) / 60;
        }
        break;
      }
      case 'bottle':
        if (!inDay(it.start)) break;
        t.bottleFeeds++;
        if (d.ml && d.ml > 0) {
          t.bottleMl += d.ml;
          t.bottleMlByMilk[d.milk ?? 'other'] += d.ml;
        }
        break;
      case 'solids':
        if (inDay(it.start)) t.solids++;
        break;
      case 'pump':
        if (!inDay(it.start)) break;
        t.pumps++;
        t.pumpMl += Math.max(0, (d.mlLeft ?? 0) + (d.mlRight ?? 0)) || Math.max(0, d.ml ?? 0);
        break;
      case 'diaper': {
        if (!inDay(it.start)) break;
        t.diapers.total++;
        if (d.pee && d.poo) t.diapers.both++;
        else if (d.pee) t.diapers.wet++;
        else if (d.poo) t.diapers.dirty++;
        else t.diapers.dry++;
        if (d.rash) t.diapers.rash++;
        if (d.color) t.diapers.colors[d.color] = (t.diapers.colors[d.color] ?? 0) + 1;
        break;
      }
      case 'sleep': {
        const ov = overlap(it.start, end, dayStart, dayEnd);
        if (ov <= 0) break;
        const night = isNightSleep(it, tz, now);
        if (night) t.sleep.nightMin += ov / MIN;
        else t.sleep.dayMin += ov / MIN;
        if (!night && inDay(it.start)) t.sleep.naps++;
        t.sleep.longestMin = Math.max(t.sleep.longestMin, (end - it.start) / MIN);
        break;
      }
      case 'activity': {
        const ov = overlap(it.start, end, dayStart, dayEnd) / MIN;
        if (ov <= 0) break;
        if (d.type) t.activityMin[d.type] += ov;
        t.activityMin.total += ov;
        break;
      }
      case 'med': {
        if (!inDay(it.start)) break;
        t.meds++;
        const name = (d.name ?? '').trim() || 'Medicine';
        const key = name.toLowerCase();
        const shown = medNames.get(key) ?? name;
        medNames.set(key, shown);
        t.medsByName[shown] = (t.medsByName[shown] ?? 0) + 1;
        break;
      }
      case 'temp':
        if (inDay(it.start) && typeof d.c === 'number' && Number.isFinite(d.c)) t.maxTempC = Math.max(t.maxTempC ?? -Infinity, d.c);
        break;
    }
  }
  t.diapers.wetTotal = t.diapers.wet + t.diapers.both;
  t.diapers.dirtyTotal = t.diapers.dirty + t.diapers.both;
  t.breastMin.left = Math.round(breastL);
  t.breastMin.right = Math.round(breastR);
  t.breastMin.total = t.breastMin.left + t.breastMin.right;
  t.sleep.dayMin = Math.round(t.sleep.dayMin);
  t.sleep.nightMin = Math.round(t.sleep.nightMin);
  t.sleep.totalMin = t.sleep.dayMin + t.sleep.nightMin;
  t.sleep.longestMin = Math.round(t.sleep.longestMin);
  for (const k of ['tummy', 'bath', 'play', 'outdoor', 'reading', 'skin', 'total'] as const) t.activityMin[k] = Math.round(t.activityMin[k]);
  return t;
}

// ── Diapers ────────────────────────────────────────────────────────────────

export interface CheckResult {
  level: 'info' | 'call';
  text: string;
}

/**
 * Wet/dirty-diaper adequacy for one day's totals (or the last `hours` hours).
 * First days: about one wet diaper per day of life (day 1: 1, … day 5: 5),
 * then 6+ a day; fewer can mean not enough milk. Concerning stool colours
 * come first. Under 8 hours of data, or past the first year, only colours
 * are checked. Null when there's nothing worth saying (including nothing
 * logged — an empty log isn't evidence).
 */
export function diaperCheck(totals: DayTotals, ageDays: number | null, hours = 24): CheckResult | null {
  const d = totals.diapers;
  if (d.colors.white) {
    return { level: 'call', text: 'A white, chalky or very pale poo can be a sign of a liver problem in babies. Call your pediatrician today — a photo of the diaper helps.' };
  }
  if (d.colors.red) {
    return { level: 'call', text: 'Red in a diaper may be blood (sometimes it is just something baby ate). Call your pediatrician and keep the diaper or a photo to show them.' };
  }
  if (d.colors.black && ageDays !== null && ageDays >= 4) {
    return { level: 'call', text: 'Black, tarry poo is normal in the first few days (meconium), but after that it can mean blood — call your pediatrician. Iron drops can also darken poo, so mention any you give.' };
  }
  if (ageDays === null || ageDays >= 365 || hours < 8 || d.total === 0) return null;

  const scale = Math.min(1, hours / 24);
  const period = hours >= 24 ? 'in 24 hours' : `in the last ${Math.round(hours)} hours`;
  const dayOfLife = ageDays + 1;
  const typical = dayOfLife <= 5 ? dayOfLife : 6;
  const need = Math.max(1, Math.round(typical * scale));
  const wet = d.wetTotal;
  const wetWord = wet === 1 ? 'wet diaper' : 'wet diapers';
  if (wet < need) {
    if (dayOfLife <= 7) {
      const serious = wet <= need - 2 || (wet === 0 && hours >= 12);
      return serious
        ? { level: 'call', text: `Only ${wet} ${wetWord} ${period}. Around day ${dayOfLife} babies usually have at least ${typical} a day, and fewer can mean baby isn't getting enough milk. Call your pediatrician or lactation consultant today — sooner if baby is very sleepy, feeding poorly, or the pee looks dark.` }
        : { level: 'info', text: `${wet} ${wetWord} ${period}. Around day ${dayOfLife} babies usually have at least ${typical} a day. If it's not just a missed log, keep offering feeds and watch the next few diapers.` };
    }
    if (wet <= need - 3) {
      return { level: 'call', text: `Only ${wet} ${wetWord} ${period}. Most babies have 6 or more a day, and fewer can mean baby isn't getting enough milk or fluids. Call your pediatrician — especially with dark pee, a dry mouth, no tears, or unusual sleepiness.` };
    }
    return { level: 'info', text: `${wet} ${wetWord} ${period}. Most babies have 6 or more a day. If it's not just missed logs, offer extra feeds and keep an eye on it.` };
  }
  // Breastfed babies usually poo at least 3 times a day from day 5 to about 6 weeks.
  const breastfed = totals.breastFeeds > 0 || totals.bottleMlByMilk.breast > 0;
  if (breastfed && ageDays >= 4 && ageDays < 42 && hours >= 20 && d.dirtyTotal < 3) {
    return { level: 'info', text: `${d.dirtyTotal === 0 ? 'No' : d.dirtyTotal} poopy ${d.dirtyTotal === 1 ? 'diaper' : 'diapers'} ${period}. In the early weeks breastfed babies usually have 3 or more a day — mention it to your pediatrician or lactation consultant if it continues.` };
  }
  return null;
}

// ── Temperature ────────────────────────────────────────────────────────────

export const cToF = (c: number): number => (c * 9) / 5 + 32;
export const fToC = (f: number): number => ((f - 32) * 5) / 9;

export interface FeverResult {
  level: 'ok' | 'watch' | 'call' | 'urgent';
  text: string;
  /** At or above the fever threshold for this method. */
  fever: boolean;
}

/** Fever threshold by method (AAP): rectal/ear/forehead 38.0, mouth 37.8, armpit 37.2 °C. */
const FEVER_AT: Record<TempMethod, number> = { rectal: 38.0, ear: 38.0, forehead: 38.0, oral: 37.8, armpit: 37.2 };

const fmtTemp = (c: number) => `${c.toFixed(1)} °C (${cToF(c).toFixed(1)} °F)`;

/**
 * Fever guidance (AAP). Readings are converted to a rectal equivalent by the
 * method's threshold offset (armpit +0.8 °C, mouth +0.2 °C). Under 3 months
 * any fever needs a doctor right away; a fever on a lower-reading method is
 * "call — confirm rectally" unless it is ≥ 38.0 °C as read. 3–6 months: call
 * at 38.9 °C (102 °F). Any age: 40 °C (104 °F) is urgent. Unknown age is
 * treated as over 6 months, with the under-3-months rule spelled out.
 */
export function feverCheck(celsius: number, method: TempMethod | null | undefined, ageDays: number | null): FeverResult {
  if (!Number.isFinite(celsius) || celsius < 32 || celsius > 44) {
    return { level: 'watch', text: 'That reading looks unusual — check the thermometer and measure again.', fever: false };
  }
  const m: TempMethod = method && method in FEVER_AT ? method : 'rectal';
  const est = celsius + (38.0 - FEVER_AT[m]);
  const fever = celsius >= FEVER_AT[m];
  const notes: string[] = [];
  if ((m === 'armpit' || m === 'forehead') && (fever || est >= 37.5)) notes.push(`${m === 'armpit' ? 'Armpit' : 'Forehead'} readings can run lower than rectal, which is the most accurate for babies.`);
  if (m === 'ear' && ageDays !== null && ageDays < 180) notes.push("Ear thermometers aren't reliable under 6 months — rectal is best.");
  if (m === 'oral' && (ageDays === null || ageDays < 4 * 365)) notes.push("Mouth readings aren't reliable under age 4 — rectal is best for babies.");
  const say = (level: FeverResult['level'], text: string): FeverResult => ({ level, text: [text, ...notes].join(' '), fever });
  const t = fmtTemp(celsius);

  if (est >= 40 || celsius >= 40) {
    return say('urgent', `${t} is a very high temperature. Call your pediatrician now or get urgent care.`);
  }
  if (ageDays !== null && ageDays < 90) {
    if (fever && (m === 'rectal' || celsius >= 38.0)) {
      return say('urgent', `${t} is a fever. For a baby under 3 months, a temperature of 38.0 °C (100.4 °F) or higher needs a doctor right away — call your pediatrician now, or go to the emergency department if you can't reach them. Don't give fever medicine unless a doctor says to.`);
    }
    if (fever) {
      return say('call', `${t} by ${m} may be a fever. For babies under 3 months, check with a rectal thermometer — if it's 38.0 °C (100.4 °F) or higher, call your pediatrician right away.`);
    }
    if (m === 'rectal' && celsius < 36.0) {
      return say('call', `${t} is lower than normal. In young babies a low temperature can also be a sign of illness — warm baby up, recheck in 15–30 minutes, and call your pediatrician if it stays low.`);
    }
    return say('ok', `${t} — no fever.`);
  }
  if (ageDays !== null && ageDays < 180) {
    if (est >= 38.9) {
      return say('call', `${t} — for babies 3 to 6 months old, call your pediatrician for a temperature of 38.9 °C (102 °F) or higher.`);
    }
    if (fever) {
      return say('watch', `${t} is a mild fever. At 3–6 months, call your pediatrician if it reaches 38.9 °C (102 °F), lasts more than a day, or baby seems unwell (very sleepy, fewer wet diapers, fast breathing).`);
    }
    return say('ok', `${t} — no fever.`);
  }
  if (fever) {
    const young = ageDays === null ? ' If your baby is under 3 months, any temperature of 38.0 °C (100.4 °F) or higher needs a doctor right away.' : '';
    return say('watch', `${t} is a fever. How baby is acting matters more than the number. Call your pediatrician if the fever lasts more than 24 hours under age 2 (3 days at any age), or if baby seems very unwell.${young}`);
  }
  return say('ok', `${t} — no fever.`);
}

// ── Medicine (timing only — never doses) ───────────────────────────────────

export interface DoseTiming {
  /** Name as last logged. */
  name: string;
  /** Start of the last dose (epoch ms). */
  last: number;
  /** Interval the parent entered (most recent one), hours; null if none. */
  everyH: number | null;
  /** Earliest time the next dose is allowed by that interval; null without one. */
  at: number | null;
  /** now ≥ at; null when no interval was entered (we never guess one). */
  ready: boolean | null;
  /** Minutes until `at` (0 once ready). */
  waitMin: number;
  /** Doses of this medicine in the 24 h before `now`. */
  doses24h: number;
}

const sameName = (a: string | undefined, b: string) => !!a && a.trim().toLowerCase() === b.trim().toLowerCase();
const validH = (h: unknown): h is number => typeof h === 'number' && Number.isFinite(h) && h > 0;

/** When the next dose of `name` is allowed, from the interval the parent entered. Null if never given. */
export function nextDose(items: TrackItem[], name: string, now: number): DoseTiming | null {
  // A skipped dose was never given: timing runs from the last real one.
  const doses = items.filter((i) => i.kind === 'med' && !i.deleted && !i.data.skipped && i.start <= now && sameName(i.data.name, name)).sort(byStart);
  if (!doses.length) return null;
  const last = doses[doses.length - 1];
  const withH = [...doses].reverse().find((d) => validH(d.data.everyH));
  const everyH = withH ? (withH.data.everyH as number) : null;
  const at = everyH === null ? null : last.start + everyH * HOUR;
  return {
    name: (last.data.name ?? name).trim(),
    last: last.start,
    everyH,
    at,
    ready: at === null ? null : now >= at,
    waitMin: at === null ? 0 : Math.max(0, Math.ceil((at - now) / MIN)),
    doses24h: doses.filter((d) => d.start > now - DAY).length,
  };
}

export interface DoseFlag {
  level: 'watch';
  text: string;
  /** Minutes since the previous dose. */
  gapMin: number;
  /** The interval entered, minutes. */
  minGapMin: number;
}

/**
 * Flags a dose logged sooner than the interval entered for that medicine
 * (on this dose, or the latest one that had an interval; 1 min tolerance).
 */
export function doseCheck(items: TrackItem[], dose: TrackItem): DoseFlag | null {
  const name = dose.data.name?.trim();
  if (dose.kind !== 'med' || dose.deleted || !name) return null;
  const earlier = items
    .filter((i) => i.kind === 'med' && !i.deleted && !i.data.skipped && i.id !== dose.id && i.start <= dose.start && sameName(i.data.name, name))
    .sort(byStart);
  const prev = earlier[earlier.length - 1];
  if (!prev) return null;
  // The interval on this dose, else the most recent one entered for this medicine.
  const withH = validH(dose.data.everyH) ? dose : [...earlier].reverse().find((d) => validH(d.data.everyH));
  const everyH = withH ? (withH.data.everyH as number) : null;
  if (everyH === null) return null;
  const gap = dose.start - prev.start;
  if (gap >= everyH * HOUR - MIN) return null;
  const gapMin = Math.round(gap / MIN);
  return {
    level: 'watch',
    gapMin,
    minGapMin: Math.round(everyH * 60),
    text: `This ${name} dose was logged ${formatDuration(gapMin)} after the previous one — sooner than the every-${formatDuration(everyH * 60)} interval you entered. Please check the label, or ask your pediatrician or pharmacist, before the next dose.`,
  };
}

// ── Growth ─────────────────────────────────────────────────────────────────

/** WHO percentiles for a growth item's weight/length/head (0–24 months, needs birth date and sex). */
export function growthForItem(item: TrackItem, profile: BabyProfile | null, tz?: string): { weight?: GrowthPoint; length?: GrowthPoint; head?: GrowthPoint } {
  const out: { weight?: GrowthPoint; length?: GrowthPoint; head?: GrowthPoint } = {};
  const age = ageDays(profile, item.start, tz);
  if (item.kind !== 'growth' || item.deleted || age === null || !profile?.sex) return out;
  const put = (k: 'weight' | 'length' | 'head', v: number | undefined) => {
    const p = typeof v === 'number' ? growthPoint(k, profile.sex, age, v) : null;
    if (p) out[k] = p;
  };
  put('weight', item.data.kg);
  put('length', item.data.cm);
  put('head', item.data.headCm);
  return out;
}

// ── Insights ───────────────────────────────────────────────────────────────

export interface Insight {
  id: string;
  tone: 'good' | 'info' | 'watch';
  text: string;
}

interface WeekStats {
  /** Local days with any log. */
  days: Set<string>;
  /** Night key → longest stretch (min) and number of sleeps. */
  nights: Map<string, { longest: number; sleeps: number; wakings: number }>;
  naps: number[];
  feeds: Map<string, number>;
  bottleMl: Map<string, number>;
  tummyMin: Map<string, number>;
  wet: Map<string, number>;
}

const bump = (m: Map<string, number>, k: string, v: number) => m.set(k, (m.get(k) ?? 0) + v);
const fmt1 = (x: number) => (Math.round(x * 10) / 10).toFixed(1);

function weekStats(items: TrackItem[], sessions: FeedSession[], dayKeys: Set<string>, skipNight: string | null, tz?: string): WeekStats {
  const s: WeekStats = { days: new Set(), nights: new Map(), naps: [], feeds: new Map(), bottleMl: new Map(), tummyMin: new Map(), wet: new Map() };
  for (const it of items) {
    const day = dayKey(it.start, tz);
    if (dayKeys.has(day)) s.days.add(day);
    if (it.kind === 'sleep' && it.end !== null && it.end > it.start) {
      const dur = (it.end - it.start) / MIN;
      if (isNightSleep(it, tz)) {
        const key = dayKey(it.start - 12 * HOUR, tz); // the evening this night belongs to
        if (!dayKeys.has(key) || key === skipNight) continue;
        const n = s.nights.get(key) ?? { longest: 0, sleeps: 0, wakings: 0 };
        n.longest = Math.max(n.longest, dur);
        n.sleeps++;
        n.wakings += Math.max(0, Math.round(it.data.wakings ?? 0));
        s.nights.set(key, n);
      } else if (dayKeys.has(day)) {
        s.naps.push(dur);
      }
    } else if (!dayKeys.has(day)) {
      continue;
    } else if (it.kind === 'bottle' && it.data.ml && it.data.ml > 0) {
      bump(s.bottleMl, day, it.data.ml);
    } else if (it.kind === 'activity' && it.data.type === 'tummy' && it.end !== null && it.end > it.start) {
      bump(s.tummyMin, day, (it.end - it.start) / MIN);
    } else if (it.kind === 'diaper') {
      bump(s.wet, day, it.data.pee ? 1 : 0);
    }
  }
  for (const f of sessions) {
    const day = dayKey(f.start, tz);
    if (dayKeys.has(day)) bump(s.feeds, day, 1);
  }
  return s;
}

/**
 * Up to four short, kind observations from the last 7 complete local days
 * versus the 7 before: longest night stretch, night wakings, nap length,
 * feeds / bottle intake, tummy time (vs 15–30 min/day, 7 weeks–6 months)
 * and wet diapers. Each needs ≥ 4 days (or nights) of logs this week, and
 * trends need ≥ 3 the week before — nothing is said from a day or two.
 */
/** "Avocado, oatmeal & pear" → ['avocado', 'oatmeal', 'pear'] (lower-case, trimmed, de-duplicated). */
export function foodList(foods: string | undefined): string[] {
  if (!foods) return [];
  return [...new Set(foods.split(/[,;\n]|\s+(?:and|&)\s+/i).map((f) => f.trim().toLowerCase().replace(/\s+/g, ' ')).filter((f) => f.length >= 2 && f.length <= 40))];
}

/** When each food first appeared in the log (food → epoch ms). */
export function firstFoods(items: TrackItem[]): Map<string, number> {
  const first = new Map<string, number>();
  for (const i of [...items].filter((x) => x.kind === 'solids' && !x.deleted).sort(byStart)) {
    for (const f of foodList(i.data.foods)) if (!first.has(f)) first.set(f, i.start);
  }
  return first;
}

export function insights(items: TrackItem[], profile: BabyProfile | null, now: number, tz?: string): Insight[] {
  const past = dedupeSleep(items, now).filter((i) => i.start <= now);
  if (!past.length) return [];
  // The 7 complete local days before today, and the 7 before those.
  const keys: string[] = [];
  let d = startOfLocalDay(now, tz);
  for (let i = 0; i < 14; i++) {
    d = startOfLocalDay(d - 12 * HOUR, tz);
    keys.push(dayKey(d, tz));
  }
  const cur = new Set(keys.slice(0, 7));
  const prev = new Set(keys.slice(7));
  // Last night may still be going (or barely over) in the small hours.
  const nightOpen = localHour(now, tz) < 6 || past.some((i) => i.kind === 'sleep' && i.end === null);
  const skip = nightOpen ? keys[0] : null;
  const sessions = feedSessions(past);
  const a = weekStats(past, sessions, cur, skip, tz);
  const b = weekStats(past, sessions, prev, null, tz);
  const age = ageDays(profile, now, tz);
  const out: (Insight & { score: number })[] = [];
  const add = (id: string, tone: Insight['tone'], text: string, score: number) => out.push({ id, tone, text, score });
  const vals = (m: Map<string, number>) => [...m.values()];

  // Longest night stretch.
  if (a.nights.size >= 4) {
    const curL = mean([...a.nights.values()].map((n) => n.longest));
    const prevL = b.nights.size >= 3 ? mean([...b.nights.values()].map((n) => n.longest)) : null;
    if (prevL !== null && curL - prevL >= 20 && curL >= prevL * 1.1) {
      add('night-stretch', 'good', `Longest night stretch is up to ${formatDuration(curL)} on average, from ${formatDuration(prevL)} the week before.`, 70 + Math.min(20, ((curL - prevL) / prevL) * 50));
    } else if (prevL !== null && prevL - curL >= 30 && curL <= prevL * 0.9) {
      add('night-stretch', 'info', `Longest night stretch averaged ${formatDuration(curL)} this week, down from ${formatDuration(prevL)}. Dips like this are common with growth spurts, teething or new skills, and usually pass.`, 60);
    } else {
      add('night-stretch', 'info', `Longest night stretch averaged ${formatDuration(curL)} this week.`, 25);
    }
    // Night wakings: gaps between night sleeps in the same night, plus wakings the camera counted inside one.
    const wakes = (n: { sleeps: number; wakings: number }) => n.sleeps - 1 + n.wakings;
    const curW = mean([...a.nights.values()].map(wakes));
    if (b.nights.size >= 3) {
      const prevW = mean([...b.nights.values()].map(wakes));
      if (prevW - curW >= 0.5) {
        add('night-wakings', 'good', `Night wakings down from ${fmt1(prevW)} to ${fmt1(curW)} per night.`, 75 + Math.min(15, (prevW - curW) * 5));
      } else if (curW - prevW >= 0.5) {
        add('night-wakings', 'info', `Night wakings up from ${fmt1(prevW)} to ${fmt1(curW)} per night — often a passing phase (teething, a cold or a new skill).`, 55);
      }
    }
  }

  // Nap length.
  if (a.naps.length >= 5 && b.naps.length >= 5) {
    const curN = median(a.naps);
    const prevN = median(b.naps);
    if (curN - prevN >= 10 && curN >= prevN * 1.15) {
      add('naps', 'good', `Naps are getting longer: typically ${formatDuration(curN)}, up from ${formatDuration(prevN)}.`, 65 + Math.min(20, ((curN - prevN) / prevN) * 40));
    } else if (prevN - curN >= 10 && curN <= prevN * 0.85) {
      add('naps', 'info', `Naps are a little shorter this week (typically ${formatDuration(curN)}, from ${formatDuration(prevN)}). Short naps are common and often lengthen again; an earlier bedtime can help on short-nap days.`, 50);
    }
  }

  // Feeds and bottle intake.
  if (a.feeds.size >= 4) {
    const perDay = mean(vals(a.feeds));
    const before = b.feeds.size >= 3 ? ` (${fmt1(mean(vals(b.feeds)))} the week before)` : '';
    let said = false;
    if (a.bottleMl.size >= 3 && b.bottleMl.size >= 3) {
      const curMl = mean(vals(a.bottleMl));
      const prevMl = mean(vals(b.bottleMl));
      const change = (curMl - prevMl) / prevMl;
      const ml = (x: number) => `${Math.round(x / 10) * 10} ml`;
      if (change >= 0.1) {
        add('feeds', 'good', `Bottle intake averages ${ml(curMl)} a day, up from ${ml(prevMl)}.`, 60 + Math.min(20, change * 50));
        said = true;
      } else if (change <= -0.1) {
        const solids = age !== null && age >= 180;
        const tone = change <= -0.2 && !solids ? 'watch' : 'info';
        const tail = solids
          ? ' That’s common as solids ramp up.'
          : tone === 'watch'
            ? ' Keep an eye on wet diapers, and check in with your pediatrician if it continues.'
            : '';
        add('feeds', tone, `Bottle intake is down to ${ml(curMl)} a day from ${ml(prevMl)}.${tail}`, tone === 'watch' ? 90 : 50);
        said = true;
      }
    }
    if (!said) add('feeds', 'info', `About ${fmt1(perDay)} feeds a day this week${before}.`, 20);
  }

  // Tummy time, 7 weeks – 6 months (AAP: 15–30 min a day; WHO: ≥ 30 min).
  if (age !== null && age >= 49 && age <= 183 && a.tummyMin.size >= 2 && a.days.size >= 4) {
    const perDay = vals(a.tummyMin).reduce((x, y) => x + y, 0) / a.days.size;
    if (perDay >= 15) {
      add('tummy', 'good', `Tummy time averaged ${Math.round(perDay)} min a day — ${perDay > 30 ? 'above' : 'right in'} the 15–30 min daily goal for this age.`, 45);
    } else {
      add('tummy', 'info', `Tummy time averaged ${Math.round(perDay)} min a day. Short sessions add up — a few minutes after each diaper change helps toward the 15–30 min daily goal.`, 58);
    }
  }

  // How well they slept, when the family rates it (1 restless … 5 great).
  const rated = (days: Set<string>) => past.filter((i) => i.kind === 'sleep' && i.data.quality && days.has(dayKey(i.start, tz))).map((i) => i.data.quality as number);
  const qa = rated(cur);
  if (qa.length >= 4) {
    const qb = rated(prev);
    const ca = mean(qa);
    if (qb.length >= 4 && ca - mean(qb) >= 0.5) add('quality', 'good', `Sleep rated ${fmt1(ca)}/5 on average this week, up from ${fmt1(mean(qb))}.`, 55);
    else if (qb.length >= 4 && mean(qb) - ca >= 0.5) add('quality', 'info', `Sleep rated ${fmt1(ca)}/5 this week, down from ${fmt1(mean(qb))} — rough patches often line up with teething, colds or new skills.`, 50);
    else add('quality', 'info', `Sleep rated ${fmt1(ca)}/5 on average this week.`, 18);
  }

  // New foods: the first time each one shows up in the log (one at a time, watch a few days).
  const fresh = [...firstFoods(past).entries()].filter(([, t]) => cur.has(dayKey(t, tz))).map(([f]) => f);
  if (fresh.length) {
    const reacted = past.some((i) => i.kind === 'solids' && cur.has(dayKey(i.start, tz)) && !!i.data.reaction && !/\b(loved|liked|fine|ok|good|happy)\b/i.test(i.data.reaction));
    add(
      'new-foods',
      reacted ? 'watch' : 'good',
      `${fresh.length} new food${fresh.length > 1 ? 's' : ''} this week: ${fresh.slice(0, 4).join(', ')}${fresh.length > 4 ? '…' : ''}.${reacted ? ' A reaction was noted — if you see hives, swelling, vomiting or trouble breathing after a food, call your pediatrician (or emergency services for breathing trouble).' : ' Introducing one new food at a time makes any reaction easy to pin down.'}`,
      reacted ? 85 : 48,
    );
  }

  // Screen time under 18 months (AAP: avoid, apart from video chatting with family).
  if (age !== null && age < 548 && past.some((i) => i.kind === 'activity' && i.data.type === 'screen' && cur.has(dayKey(i.start, tz)))) {
    add('screen', 'info', 'Screen time was logged this week. Before 18 months the AAP suggests avoiding screens other than video calls with family — talking, reading and play do more for language.', 40);
  }

  // Wet diapers (after the first days, under a year).
  if (age !== null && age >= 5 && age < 365 && a.wet.size >= 4) {
    const perDay = mean(vals(a.wet));
    if (perDay < 5) {
      add('wet', 'watch', `Wet diapers averaged ${fmt1(perDay)} a day this week; most babies have 6 or more. If that's not just missed logs, mention it to your pediatrician.`, 95);
    } else if (perDay >= 6 && age < 90) {
      add('wet', 'good', `Wet diapers average ${fmt1(perDay)} a day — a good sign baby is getting enough milk.`, 30);
    }
  }

  return out
    .sort((x, y) => y.score - x.score || (x.id < y.id ? -1 : 1))
    .slice(0, 4)
    .map(({ id, tone, text }) => ({ id, tone, text }));
}
