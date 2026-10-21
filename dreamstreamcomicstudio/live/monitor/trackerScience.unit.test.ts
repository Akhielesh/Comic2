// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  ageDays,
  ageLabel,
  cToF,
  dayBounds,
  dayTotals,
  dedupeSleep,
  diaperCheck,
  doseCheck,
  feedIntervalRange,
  feverCheck,
  formatDuration,
  fToC,
  growthForItem,
  insights,
  isNightSleep,
  localParts,
  nextDose,
  predictNextFeed,
  predictNextSleep,
  startOfLocalDay,
  wakeWindowRange,
  type BabyProfile,
  type DayTotals,
  type TrackData,
  type TrackItem,
  type TrackKind,
} from './trackerScience';

const M = 60_000;
const H = 3_600_000;
const D = 86_400_000;
const T = (iso: string) => Date.parse(iso.endsWith('Z') ? iso : `${iso}Z`);
const UTC = 'UTC';

let seq = 0;
function item(kind: TrackKind, start: number, end: number | null, data: TrackData = {}, extra: Partial<TrackItem> = {}): TrackItem {
  return { id: `i${String(++seq).padStart(4, '0')}`, kind, start, end, by: 'Sam', data, ...extra };
}
const sleep = (s: string, e: string | null, extra: Partial<TrackItem> = {}) => item('sleep', T(s), e === null ? null : T(e), {}, extra);
/** A profile whose baby is `days` old on the UTC date of `now`. */
const bornDaysAgo = (days: number, now: number, sex: 'f' | 'm' | null = 'f'): BabyProfile => {
  const d = new Date(startOfLocalDay(now, UTC) - days * D);
  return { birth: d.toISOString().slice(0, 10), sex };
};

describe('age', () => {
  const p: BabyProfile = { birth: '2026-01-01', sex: 'f' };

  it('counts whole local days since birth', () => {
    expect(ageDays(p, T('2026-01-22T12:00'), UTC)).toBe(21);
    expect(ageDays(p, T('2026-01-01T23:59'), UTC)).toBe(0);
    expect(ageDays({ birth: null, sex: null }, T('2026-01-22T12:00'), UTC)).toBeNull();
    expect(ageDays({ birth: '2026-02-30', sex: 'm' }, T('2026-03-22T12:00'), UTC)).toBeNull();
    expect(ageDays({ birth: 'soon', sex: 'm' }, T('2026-03-22T12:00'), UTC)).toBeNull();
    expect(ageDays(p, T('2025-12-31T12:00'), UTC)).toBeNull(); // not born yet
  });

  it('uses the family time zone for the calendar date', () => {
    const now = T('2026-03-01T23:30');
    const q: BabyProfile = { birth: '2026-03-01', sex: 'm' };
    expect(ageDays(q, now, 'Asia/Tokyo')).toBe(1); // already 2 March there
    expect(ageDays(q, now, 'America/Los_Angeles')).toBe(0);
  });

  it('labels age in days, weeks, months and years', () => {
    expect(ageLabel(p, T('2026-01-01T09:00'), UTC)).toBe('newborn');
    expect(ageLabel(p, T('2026-01-02T09:00'), UTC)).toBe('1 day');
    expect(ageLabel(p, T('2026-01-06T09:00'), UTC)).toBe('5 days');
    expect(ageLabel(p, T('2026-01-22T09:00'), UTC)).toBe('3 weeks');
    expect(ageLabel(p, T('2026-02-25T09:00'), UTC)).toBe('7 weeks'); // 55 days
    expect(ageLabel(p, T('2026-02-26T09:00'), UTC)).toBe('8 weeks');
    expect(ageLabel({ birth: '2026-01-15', sex: 'f' }, T('2026-05-20T09:00'), UTC)).toBe('4 months');
    expect(ageLabel({ birth: '2025-03-10', sex: 'f' }, T('2026-03-10T09:00'), UTC)).toBe('1 year');
    expect(ageLabel({ birth: '2025-03-10', sex: 'f' }, T('2026-05-12T09:00'), UTC)).toBe('1 year 2 months');
    expect(ageLabel({ birth: '2024-01-10', sex: 'f' }, T('2026-05-12T09:00'), UTC)).toBe('2 years 4 months');
    expect(ageLabel({ birth: null, sex: null }, T('2026-05-12T09:00'), UTC)).toBe('');
  });
});

describe('local time helpers', () => {
  it('reads wall-clock parts in a zone', () => {
    expect(localParts(T('2026-01-01T18:30'), 'Asia/Kolkata')).toMatchObject({ year: 2026, month: 1, day: 2, hour: 0, minute: 0 });
    expect(localParts(T('2026-07-04T12:00'), 'America/New_York').hour).toBe(8);
  });

  it('finds local midnight and day length across DST', () => {
    const ny = 'America/New_York';
    expect(startOfLocalDay(T('2026-07-04T12:00'), ny)).toBe(T('2026-07-04T04:00'));
    const spring = dayBounds(T('2026-03-08T15:00'), ny); // clocks go forward
    expect(spring.start).toBe(T('2026-03-08T05:00'));
    expect(spring.end - spring.start).toBe(23 * H);
    const fall = dayBounds(T('2026-11-01T15:00'), ny); // clocks go back
    expect(fall.end - fall.start).toBe(25 * H);
  });

  it('formats durations', () => {
    expect(formatDuration(45)).toBe('45 min');
    expect(formatDuration(60)).toBe('1 h');
    expect(formatDuration(310)).toBe('5 h 10 min');
  });
});

describe('wake windows', () => {
  it('follows the age table', () => {
    expect(wakeWindowRange(10)).toMatchObject({ min: 35, max: 60, bedtime: null });
    expect(wakeWindowRange(130)).toMatchObject({ min: 75, max: 120, naps: 4 });
    expect(wakeWindowRange(183)).toMatchObject({ min: 120, max: 180, naps: 3, bedtime: { from: 19, to: 20.5 } });
    expect(wakeWindowRange(548)).toMatchObject({ min: 240, max: 360, naps: 1 });
    expect(wakeWindowRange(-5)).toMatchObject({ min: 35, max: 60 });
  });

  it('tells night sleep from naps', () => {
    expect(isNightSleep(sleep('2026-03-10T19:00', '2026-03-10T19:40'), UTC)).toBe(true); // evening start
    expect(isNightSleep(sleep('2026-03-10T13:00', '2026-03-10T14:30'), UTC)).toBe(false); // nap
    expect(isNightSleep(sleep('2026-03-10T10:00', '2026-03-10T14:30'), UTC)).toBe(true); // ≥ 4 h
    expect(isNightSleep(sleep('2026-03-10T01:30', '2026-03-10T02:30'), UTC)).toBe(true); // spans 02:00
    expect(isNightSleep(sleep('2026-03-10T03:00', '2026-03-10T06:30'), UTC)).toBe(true); // after a 3 am feed
    expect(isNightSleep(sleep('2026-03-10T06:00', '2026-03-10T07:00'), UTC)).toBe(false);
    expect(isNightSleep(sleep('2026-03-10T15:00', null), UTC, T('2026-03-10T20:00'))).toBe(true); // running 5 h
  });

  it('classifies by the family time zone', () => {
    const s = sleep('2026-03-10T10:00', '2026-03-10T11:00');
    expect(isNightSleep(s, 'Asia/Tokyo')).toBe(true); // 19:00 there
    expect(isNightSleep(s, 'America/New_York')).toBe(false); // 06:00 there
  });
});

describe('dedupeSleep', () => {
  it('drops camera sleep that a manual entry covers by ≥ 50 % of the shorter one', () => {
    const manual = sleep('2026-03-10T20:00', '2026-03-11T06:10');
    const cam = sleep('2026-03-10T20:05', '2026-03-11T06:00', { src: 'monitor' });
    const camNap = sleep('2026-03-11T13:00', '2026-03-11T14:00', { src: 'monitor' });
    const manualNap = sleep('2026-03-11T13:50', '2026-03-11T15:00'); // overlaps camNap by 10 of 60 min
    const out = dedupeSleep([manual, cam, camNap, manualNap]);
    expect(out.map((i) => i.id)).toEqual([manual.id, camNap.id, manualNap.id]);
  });

  it('ignores deleted items, which never suppress anything', () => {
    const gone = sleep('2026-03-10T20:00', '2026-03-11T06:00', { deleted: true });
    const cam = sleep('2026-03-10T20:05', '2026-03-11T06:00', { src: 'monitor' });
    expect(dedupeSleep([gone, cam]).map((i) => i.id)).toEqual([cam.id]);
  });

  it('measures running sleeps up to now', () => {
    const manual = sleep('2026-03-10T13:00', null);
    const cam = sleep('2026-03-10T13:05', '2026-03-10T13:50', { src: 'monitor' });
    expect(dedupeSleep([manual, cam], T('2026-03-10T14:00'))).toEqual([manual]);
    expect(dedupeSleep([manual, cam], T('2026-03-10T13:10'))).toEqual([manual]); // 5 of the manual's 10 min
    expect(dedupeSleep([manual, cam], T('2026-03-10T13:08'))).toEqual([manual, cam]); // 3 of 8 min
  });
});

describe('predictNextSleep', () => {
  const now = T('2026-06-15T10:30');
  const baby4mo = bornDaysAgo(130, now);

  it('returns null without sleep data or while asleep', () => {
    expect(predictNextSleep([], baby4mo, now, UTC)).toBeNull();
    expect(predictNextSleep([item('bottle', T('2026-06-15T09:00'), T('2026-06-15T09:15'), { ml: 120 })], baby4mo, now, UTC)).toBeNull();
    expect(predictNextSleep([sleep('2026-06-14T19:30', '2026-06-15T06:30'), sleep('2026-06-15T10:00', null)], baby4mo, now, UTC)).toBeNull();
  });

  it('ignores a deleted running sleep', () => {
    const items = [sleep('2026-06-14T19:30', '2026-06-15T06:30'), sleep('2026-06-15T09:00', '2026-06-15T10:00'), sleep('2026-06-15T10:10', null, { deleted: true })];
    expect(predictNextSleep(items, baby4mo, now, UTC)).not.toBeNull();
  });

  it('uses the age range until there is personal history', () => {
    const items = [sleep('2026-06-14T19:30', '2026-06-15T06:30'), sleep('2026-06-15T09:00', '2026-06-15T10:00')];
    const p = predictNextSleep(items, baby4mo, now, UTC)!;
    expect(p.basis).toBe('age');
    expect(p.napOfDay).toBe(2);
    expect(p.bedtime).toBe(false);
    expect(p.windowMin).toBe(98); // midpoint of 75–120
    expect(p.at).toBe(T('2026-06-15T10:00') + 97.5 * M);
    expect(p.from).toBe(p.at - 10 * M);
    expect(p.to).toBe(p.at + 10 * M);
    expect(p.lastWake).toBe(T('2026-06-15T10:00'));
    expect(p.reason).toMatch(/3–4 months/);
  });

  it('makes the first wake window of the day a little shorter', () => {
    const p = predictNextSleep([sleep('2026-06-14T19:30', '2026-06-15T07:00')], baby4mo, T('2026-06-15T07:30'), UTC)!;
    expect(p.napOfDay).toBe(1);
    expect(p.windowMin).toBe(88); // 0.9 × 97.5
  });

  /** A week of a 6-month-old's days: night 19:00–06:00 and naps after 2 h awake. */
  function week(napWindowMin: number, days = 7) {
    const out: TrackItem[] = [];
    for (let d = days; d >= 1; d--) {
      const day = T('2026-06-15T00:00') - d * D;
      out.push(item('sleep', day - 5 * H, day + 6 * H)); // 19:00 → 06:00
      let wake = day + 6 * H;
      for (const len of [60, 90, 45]) {
        const s = wake + napWindowMin * M;
        out.push(item('sleep', s, s + len * M));
        wake = s + len * M;
      }
    }
    out.push(item('sleep', T('2026-06-14T19:00'), T('2026-06-15T06:00')));
    return out;
  }

  it('personalises from the median wake window before naps (blended, within the range)', () => {
    const now6 = T('2026-06-15T09:30');
    const baby6mo = bornDaysAgo(183, now6);
    const items = [...week(120), sleep('2026-06-15T08:00', '2026-06-15T09:00')];
    const p = predictNextSleep(items, baby6mo, now6, UTC)!;
    expect(p.basis).toBe('personal');
    expect(p.samples).toBeGreaterThanOrEqual(20);
    expect(p.napOfDay).toBe(2);
    // 0.75 × 120 (personal) + 0.25 × 150 (age midpoint) = 127.5
    expect(p.at).toBe(T('2026-06-15T09:00') + 127.5 * M);
    expect(p.reason).toMatch(/recent naps/);
  });

  it('clamps a personal window that falls outside the age range', () => {
    const now6 = T('2026-06-15T07:30');
    const items = week(70); // 70 min windows are short for 6 months (120–180)
    const p = predictNextSleep(items, bornDaysAgo(183, now6), now6, UTC)!;
    expect(p.basis).toBe('personal');
    expect(p.windowMin).toBe(120);
  });

  it('works from personal history alone when the birth date is unknown', () => {
    const now6 = T('2026-06-15T09:30');
    const items = [...week(120), sleep('2026-06-15T08:00', '2026-06-15T09:00')];
    const p = predictNextSleep(items, { birth: null, sex: null }, now6, UTC)!;
    expect(p.basis).toBe('personal');
    expect(p.windowMin).toBe(120);
    expect(predictNextSleep([sleep('2026-06-15T08:00', '2026-06-15T09:00')], { birth: null, sex: null }, now6, UTC)).toBeNull();
  });

  it('predicts bedtime once the usual naps are done', () => {
    const now6 = T('2026-06-15T16:30');
    const items = [
      sleep('2026-06-14T19:00', '2026-06-15T06:30'),
      sleep('2026-06-15T08:00', '2026-06-15T09:00'), // 90 min awake before
      sleep('2026-06-15T11:00', '2026-06-15T12:00'), // 120
      sleep('2026-06-15T14:30', '2026-06-15T16:00'), // 150
    ];
    const p = predictNextSleep(items, bornDaysAgo(183, now6), now6, UTC)!;
    expect(p.bedtime).toBe(true);
    expect(p.napOfDay).toBe(4);
    expect(p.basis).toBe('personal');
    // median 120 blended 50/50 with 150 → 135; bedtime window × 1.15 = 155.25
    expect(p.at).toBe(T('2026-06-15T16:00') + 155.25 * M);
    expect(p.reason).toMatch(/^Bedtime — earlier than the usual 19:00–20:30/);
  });

  it('predicts bedtime when another nap would run into the evening', () => {
    const now4 = T('2026-06-15T17:45');
    const items = [sleep('2026-06-14T19:30', '2026-06-15T06:30'), sleep('2026-06-15T09:00', '2026-06-15T10:00'), sleep('2026-06-15T16:00', '2026-06-15T17:30')];
    const p = predictNextSleep(items, bornDaysAgo(130, now4), now4, UTC)!;
    expect(p.bedtime).toBe(true);
    expect(p.at).toBe(T('2026-06-15T17:30') + 112.125 * M); // 97.5 × 1.15
    expect(p.reason).toMatch(/in the usual 19:00–20:30 window/);
  });

  it('handles a night waking', () => {
    const now4 = T('2026-06-16T01:10');
    const p = predictNextSleep([sleep('2026-06-15T19:30', '2026-06-16T01:00')], bornDaysAgo(130, now4), now4, UTC)!;
    expect(p.bedtime).toBe(true);
    expect(p.napOfDay).toBe(0);
    expect(p.windowMin).toBe(75);
    expect(p.reason).toMatch(/Night waking/);
  });

  it('depends on the time zone', () => {
    const items = [sleep('2026-06-15T10:00', '2026-06-15T11:00')];
    const n = T('2026-06-15T11:10');
    const tokyo = predictNextSleep(items, bornDaysAgo(130, n), n, 'Asia/Tokyo')!; // 19:00–20:00 there: night
    const ny = predictNextSleep(items, bornDaysAgo(130, n), n, 'America/New_York')!; // 06:00–07:00 there: early nap
    expect(tokyo.napOfDay).toBe(0);
    expect(tokyo.bedtime).toBe(true);
    expect(ny.bedtime).toBe(false);
    expect(ny.napOfDay).toBeGreaterThanOrEqual(1);
  });

  it('returns null when the last wake-up is stale', () => {
    const items = [sleep('2026-06-13T09:00', '2026-06-13T10:00')];
    expect(predictNextSleep(items, baby4mo, now, UTC)).toBeNull();
  });

  it("doesn't double-count camera sleep that was also logged by hand", () => {
    const items = [sleep('2026-06-14T19:30', '2026-06-15T06:30'), sleep('2026-06-15T09:00', '2026-06-15T10:00'), sleep('2026-06-15T09:02', '2026-06-15T09:58', { src: 'monitor' })];
    const p = predictNextSleep(items, baby4mo, now, UTC)!;
    expect(p.napOfDay).toBe(2);
    expect(p.lastWake).toBe(T('2026-06-15T10:00'));
  });
});

describe('predictNextFeed', () => {
  const now = T('2026-06-15T12:00');

  it('returns null without feeds', () => {
    expect(predictNextFeed([], bornDaysAgo(10, now), now, UTC)).toBeNull();
    expect(predictNextFeed([item('solids', T('2026-06-15T11:00'), T('2026-06-15T11:20'))], bornDaysAgo(200, now), now, UTC)).toBeNull();
  });

  it('falls back to age-based intervals', () => {
    expect(feedIntervalRange(10)).toEqual({ min: 120, max: 180 });
    const items = [item('bottle', T('2026-06-15T08:00'), T('2026-06-15T08:20'), { ml: 60 }), item('bottle', T('2026-06-15T10:30'), T('2026-06-15T10:50'), { ml: 60 })];
    const p = predictNextFeed(items, bornDaysAgo(10, now), now, UTC)!;
    expect(p.basis).toBe('age');
    expect(p.intervalMin).toBe(150);
    expect(p.at).toBe(T('2026-06-15T10:30') + 150 * M);
    expect(p.lastSide).toBeUndefined();
    const older = predictNextFeed(items, bornDaysAgo(200, now), now, UTC)!;
    expect(older.intervalMin).toBe(255);
  });

  it('uses the median start-to-start interval, merging top-ups into one feed', () => {
    const items: TrackItem[] = [];
    for (let t = T('2026-06-14T13:00'); t <= T('2026-06-15T11:30'); t += 150 * M) {
      items.push(item('breast', t, t + 20 * M, { left: 600, right: 600, side: 'right' }));
    }
    // A bottle top-up 5 min after the last breastfeed (11:30–11:50) is the same feed.
    items.push(item('bottle', T('2026-06-15T11:55'), T('2026-06-15T12:00'), { ml: 30, milk: 'breast' }));
    const p = predictNextFeed(items, bornDaysAgo(20, now), now, UTC)!;
    expect(p.basis).toBe('personal');
    expect(p.intervalMin).toBe(150);
    expect(p.lastFeed).toBe(T('2026-06-15T11:30'));
    expect(p.at).toBe(T('2026-06-15T14:00'));
    expect(p.samples).toBeGreaterThanOrEqual(6);
  });

  it('suggests starting on the other breast', () => {
    const base = [item('breast', T('2026-06-15T09:00'), T('2026-06-15T09:25'), { left: 700, right: 500, side: 'left' })];
    const p = predictNextFeed(base, bornDaysAgo(20, now), now, UTC)!;
    expect(p.lastSide).toBe('left');
    expect(p.suggestSide).toBe('right');
    const rightOnly = predictNextFeed([item('breast', T('2026-06-15T09:00'), T('2026-06-15T09:15'), { right: 900 })], bornDaysAgo(20, now), now, UTC)!;
    expect(rightOnly.suggestSide).toBe('left');
    const running = predictNextFeed([item('breast', T('2026-06-15T11:50'), null, { left: 300, side: 'right' })], bornDaysAgo(20, now), now, UTC)!;
    expect(running.feeding).toBe(true);
    expect(running.lastSide).toBe('right');
  });
});

describe('dayTotals', () => {
  const day = dayBounds(T('2026-06-15T12:00'), UTC);

  it('adds up a mixed day', () => {
    const items = [
      item('breast', T('2026-06-15T06:00'), T('2026-06-15T06:20'), { left: 600, right: 480, side: 'right' }),
      item('bottle', T('2026-06-15T06:30'), T('2026-06-15T06:40'), { ml: 30, milk: 'breast' }), // top-up: same feed
      item('bottle', T('2026-06-15T10:00'), T('2026-06-15T10:15'), { ml: 120, milk: 'formula' }),
      item('bottle', T('2026-06-15T14:00'), T('2026-06-15T14:15'), { ml: 90 }),
      item('solids', T('2026-06-15T12:00'), T('2026-06-15T12:15'), { foods: 'pear', amount: 'some' }),
      item('pump', T('2026-06-15T08:00'), T('2026-06-15T08:15'), { mlLeft: 60, mlRight: 50 }),
      item('diaper', T('2026-06-15T07:00'), T('2026-06-15T07:00'), { pee: true }),
      item('diaper', T('2026-06-15T09:00'), T('2026-06-15T09:00'), { poo: true, color: 'yellow' }),
      item('diaper', T('2026-06-15T11:00'), T('2026-06-15T11:00'), { pee: true, poo: true, color: 'yellow', rash: true }),
      item('diaper', T('2026-06-15T13:00'), T('2026-06-15T13:00'), {}),
      item('med', T('2026-06-15T08:00'), T('2026-06-15T08:00'), { name: 'Vitamin D', dose: 1, unit: 'drops' }),
      item('med', T('2026-06-15T09:00'), T('2026-06-15T09:00'), { name: 'Paracetamol ', dose: 2.5, unit: 'ml', everyH: 6 }),
      item('med', T('2026-06-15T15:00'), T('2026-06-15T15:00'), { name: 'paracetamol', dose: 2.5, unit: 'ml', everyH: 6 }),
      item('temp', T('2026-06-15T09:00'), T('2026-06-15T09:00'), { c: 37.9, method: 'rectal' }),
      item('temp', T('2026-06-15T15:00'), T('2026-06-15T15:00'), { c: 37.4, method: 'rectal' }),
      item('activity', T('2026-06-15T10:30'), T('2026-06-15T10:45'), { type: 'tummy' }),
      item('activity', T('2026-06-15T18:00'), T('2026-06-15T18:10'), { type: 'bath' }),
      item('note', T('2026-06-15T18:30'), null, { note: 'first giggle!' }),
      item('bottle', T('2026-06-15T16:00'), T('2026-06-15T16:10'), { ml: 500 }, { deleted: true }),
    ];
    const t = dayTotals(items, day.start, day.end, { tz: UTC });
    expect(t.feeds).toBe(3);
    expect(t.breastFeeds).toBe(1);
    expect(t.bottleFeeds).toBe(3);
    expect(t.breastMin).toEqual({ left: 10, right: 8, total: 18 });
    expect(t.bottleMl).toBe(240);
    expect(t.bottleMlByMilk).toEqual({ formula: 120, breast: 30, mixed: 0, other: 90 });
    expect(t.solids).toBe(1);
    expect(t.pumps).toBe(1);
    expect(t.pumpMl).toBe(110);
    expect(t.diapers).toMatchObject({ total: 4, wet: 1, dirty: 1, both: 1, dry: 1, wetTotal: 2, dirtyTotal: 2, rash: 1, colors: { yellow: 2 } });
    expect(t.meds).toBe(3);
    expect(t.medsByName).toEqual({ 'Vitamin D': 1, Paracetamol: 2 });
    expect(t.maxTempC).toBe(37.9);
    expect(t.activityMin).toMatchObject({ tummy: 15, bath: 10, total: 25 });
  });

  it('clips sleep that crosses midnight and splits naps from nights', () => {
    const items = [
      sleep('2026-06-14T20:00', '2026-06-15T06:00'), // 6 h of it today
      sleep('2026-06-15T13:00', '2026-06-15T14:30'), // nap
      sleep('2026-06-15T19:30', '2026-06-16T07:00'), // 4.5 h of it today
      sleep('2026-06-15T19:35', '2026-06-16T06:55', { src: 'monitor' }), // camera duplicate
    ];
    const t = dayTotals(items, day.start, day.end, { tz: UTC });
    expect(t.sleep).toEqual({ totalMin: 720, dayMin: 90, nightMin: 630, naps: 1, longestMin: 690 });
  });

  it('counts running timers up to now', () => {
    const items = [sleep('2026-06-15T13:00', null), item('breast', T('2026-06-15T10:00'), null, { side: 'left' })];
    const t = dayTotals(items, day.start, day.end, { tz: UTC, now: T('2026-06-15T10:12') });
    expect(t.breastMin.left).toBe(12);
    expect(t.sleep.totalMin).toBe(0); // not started yet at "now"
    const later = dayTotals(items, day.start, day.end, { tz: UTC, now: T('2026-06-15T14:00') });
    expect(later.sleep).toMatchObject({ dayMin: 60, naps: 1 });
  });

  it('respects local day boundaries in a time zone', () => {
    const ny = 'America/New_York';
    const nyDay = dayBounds(T('2026-06-15T16:00'), ny); // 04:00Z → 04:00Z
    const items = [item('diaper', T('2026-06-15T03:00'), T('2026-06-15T03:00'), { pee: true }), item('diaper', T('2026-06-15T05:00'), T('2026-06-15T05:00'), { pee: true })];
    expect(dayTotals(items, nyDay.start, nyDay.end, { tz: ny }).diapers.wet).toBe(1); // 03:00Z is still the 14th there
  });
});

describe('diaperCheck', () => {
  const totals = (wet: number, extra: Partial<DayTotals['diapers']> = {}, rest: Partial<DayTotals> = {}): DayTotals => {
    const items: TrackItem[] = [];
    for (let i = 0; i < wet; i++) items.push(item('diaper', T('2026-06-15T01:00') + i * H, null, { pee: true, poo: true }));
    const t = dayTotals(items, T('2026-06-15T00:00'), T('2026-06-16T00:00'), { tz: UTC });
    if (!wet) t.diapers.total = 1; // something was logged
    return { ...t, ...rest, diapers: { ...t.diapers, ...extra } };
  };

  it('uses day-of-life counts in the first week', () => {
    expect(diaperCheck(totals(3), 2)).toBeNull(); // day 3: 3 wet is fine
    expect(diaperCheck(totals(2), 2)?.level).toBe('info');
    const low = diaperCheck(totals(1), 2)!;
    expect(low.level).toBe('call');
    expect(low.text).toMatch(/day 3/);
    expect(low.text).toMatch(/pediatrician/);
  });

  it('expects 6+ wet diapers after day 5', () => {
    expect(diaperCheck(totals(6), 21)).toBeNull();
    expect(diaperCheck(totals(4), 21)?.level).toBe('info');
    const few = diaperCheck(totals(2), 21)!;
    expect(few.level).toBe('call');
    expect(few.text).toMatch(/6 or more/);
  });

  it('flags concerning stool colours, but not meconium', () => {
    expect(diaperCheck(totals(6, { colors: { white: 1 } }), 30)?.level).toBe('call');
    expect(diaperCheck(totals(6, { colors: { red: 1 } }), 30)?.text).toMatch(/blood/);
    expect(diaperCheck(totals(2, { colors: { black: 2 } }), 1)).toBeNull();
    expect(diaperCheck(totals(6, { colors: { black: 1 } }), 10)?.level).toBe('call');
  });

  it('stays quiet on partial or empty days and checks poos for breastfed newborns', () => {
    expect(diaperCheck(totals(1), 21, 4)).toBeNull(); // only 4 h of data
    expect(diaperCheck(totals(2), 21, 12)?.level).toBe('info'); // half a day: expect ~3
    const empty = dayTotals([], 0, 1);
    expect(diaperCheck(empty, 21)).toBeNull();
    const fewPoos = totals(6, { dirty: 0, both: 1, dirtyTotal: 1 }, { breastFeeds: 8 });
    expect(diaperCheck(fewPoos, 14)?.level).toBe('info');
    expect(diaperCheck(totals(6, { dirtyTotal: 1 }), 14)).toBeNull(); // formula-fed: fewer poos are normal
  });
});

describe('feverCheck', () => {
  it('treats any fever under 3 months as needing a doctor right away', () => {
    const r = feverCheck(38.0, 'rectal', 60);
    expect(r.level).toBe('urgent');
    expect(r.fever).toBe(true);
    expect(r.text).toMatch(/100\.4 °F/);
    expect(feverCheck(37.9, 'rectal', 60).level).toBe('ok');
  });

  it('asks for a rectal check when a lower-reading method suggests fever in a young baby', () => {
    const armpit = feverCheck(37.4, 'armpit', 60);
    expect(armpit.level).toBe('call');
    expect(armpit.text).toMatch(/rectal/);
    expect(feverCheck(38.1, 'armpit', 60).level).toBe('urgent');
    expect(feverCheck(36.9, 'armpit', 60).level).toBe('ok');
  });

  it('flags low temperatures in young babies', () => {
    expect(feverCheck(35.7, 'rectal', 20).level).toBe('call');
  });

  it('uses the 3–6 month threshold of 38.9 °C (102 °F)', () => {
    expect(feverCheck(38.5, 'rectal', 120).level).toBe('watch');
    expect(feverCheck(39.0, 'rectal', 120).level).toBe('call');
    expect(feverCheck(38.3, 'armpit', 120).level).toBe('call'); // ≈ 39.1 rectal
  });

  it('is urgent at 40 °C (104 °F) at any age', () => {
    expect(feverCheck(39.5, 'rectal', 400).level).toBe('watch');
    expect(feverCheck(40.1, 'rectal', 400).level).toBe('urgent');
    expect(feverCheck(40.0, 'forehead', 100).level).toBe('urgent');
  });

  it('adds method notes and handles unknown ages and odd readings', () => {
    const unknown = feverCheck(38.3, 'rectal', null);
    expect(unknown.level).toBe('watch');
    expect(unknown.text).toMatch(/under 3 months/);
    expect(feverCheck(37.0, 'ear', 100).text).toMatch(/Ear thermometers/);
    expect(feverCheck(25, 'rectal', 100).level).toBe('watch');
    expect(feverCheck(37.0, undefined, 400).level).toBe('ok');
  });

  it('converts units', () => {
    expect(cToF(38)).toBeCloseTo(100.4, 10);
    expect(fToC(104)).toBeCloseTo(40, 10);
    expect(fToC(cToF(36.6))).toBeCloseTo(36.6, 10);
  });
});

describe('medicine timing', () => {
  const doses = [
    item('med', T('2026-06-15T02:00'), T('2026-06-15T02:00'), { name: 'Ibuprofen', dose: 2.5, unit: 'ml', everyH: 6 }),
    item('med', T('2026-06-15T08:00'), T('2026-06-15T08:00'), { name: 'ibuprofen ', dose: 2.5, unit: 'ml' }),
    item('med', T('2026-06-15T09:00'), T('2026-06-15T09:00'), { name: 'Vitamin D', dose: 1, unit: 'drops' }),
    item('med', T('2026-06-15T10:00'), T('2026-06-15T10:00'), { name: 'Ibuprofen', dose: 2.5, unit: 'ml', everyH: 6 }, { deleted: true }),
  ];

  it('gives the earliest next dose from the interval the parent entered', () => {
    const n = nextDose(doses, 'IBUPROFEN', T('2026-06-15T11:00'))!;
    expect(n.last).toBe(T('2026-06-15T08:00'));
    expect(n.everyH).toBe(6);
    expect(n.at).toBe(T('2026-06-15T14:00'));
    expect(n.ready).toBe(false);
    expect(n.waitMin).toBe(180);
    expect(n.doses24h).toBe(2);
    expect(nextDose(doses, 'Ibuprofen', T('2026-06-15T14:05'))!.ready).toBe(true);
  });

  it('never guesses an interval', () => {
    const v = nextDose(doses, 'vitamin d', T('2026-06-15T11:00'))!;
    expect(v.at).toBeNull();
    expect(v.ready).toBeNull();
    expect(nextDose(doses, 'Amoxicillin', T('2026-06-15T11:00'))).toBeNull();
  });

  it('flags a dose logged sooner than the interval', () => {
    const early = item('med', T('2026-06-15T11:00'), T('2026-06-15T11:00'), { name: 'Ibuprofen', dose: 2.5, unit: 'ml' });
    const flag = doseCheck([...doses, early], early)!;
    expect(flag.level).toBe('watch');
    expect(flag.gapMin).toBe(180);
    expect(flag.minGapMin).toBe(360);
    expect(flag.text).toMatch(/pharmacist/);
    const onTime = item('med', T('2026-06-15T14:00'), T('2026-06-15T14:00'), { name: 'Ibuprofen', everyH: 6 });
    expect(doseCheck([...doses, onTime], onTime)).toBeNull();
    const vit = item('med', T('2026-06-15T09:30'), T('2026-06-15T09:30'), { name: 'Vitamin D' });
    expect(doseCheck([...doses, vit], vit)).toBeNull(); // no interval entered
  });
});

describe('growthForItem', () => {
  it('places a growth entry on the WHO charts', () => {
    const now = T('2026-06-15T12:00');
    const profile = bornDaysAgo(183, now, 'm');
    const g = growthForItem(item('growth', now, now, { kg: 7.95, cm: 67.65, headCm: 43.3 }), profile, UTC);
    expect(g.weight!.z).toBeCloseTo(0, 1);
    expect(g.length!.label).toBe('50th percentile');
    expect(g.head!.pct).toBeGreaterThan(40);
    expect(growthForItem(item('growth', now, now, { kg: 7.95 }), { ...profile, sex: null }, UTC)).toEqual({});
  });
});

describe('insights', () => {
  const now = T('2026-06-15T12:00');
  const profile = bornDaysAgo(100, now);

  /** Nights, naps, feeds, diapers and tummy time for the 14 days before `now`. */
  function history(opts: { better?: boolean; wet?: number; tummy?: number; bottleMl?: [number, number] } = {}) {
    const out: TrackItem[] = [];
    for (let d = 14; d >= 1; d--) {
      const day = startOfLocalDay(now, UTC) - d * D;
      const recent = d <= 7;
      const evening = day + 19 * H;
      if (recent && opts.better) {
        out.push(item('sleep', evening, evening + 7 * H), item('sleep', evening + 7.5 * H, evening + 11.5 * H));
      } else {
        out.push(item('sleep', evening, evening + 4 * H), item('sleep', evening + 4.5 * H, evening + 7.5 * H), item('sleep', evening + 8 * H, evening + 11.5 * H));
      }
      const nap = recent && opts.better ? 75 : 45;
      for (const at of [9, 12, 15]) out.push(item('sleep', day + at * H, day + at * H + nap * M));
      for (let f = 0; f < 7; f++) {
        const ml = opts.bottleMl ? opts.bottleMl[recent ? 1 : 0] / 7 : 0;
        const t = day + (6 + f * 2.5) * H;
        out.push(ml ? item('bottle', t, t + 15 * M, { ml, milk: 'formula' }) : item('breast', t, t + 20 * M, { left: 600, right: 600 }));
      }
      for (let w = 0; w < (opts.wet ?? 7); w++) out.push(item('diaper', day + (7 + w * 2) * H, null, { pee: true }));
      if (opts.tummy && recent) out.push(item('activity', day + 10 * H, day + 10 * H + opts.tummy * M, { type: 'tummy' }));
    }
    return out;
  }

  it('says nothing without enough data', () => {
    expect(insights([], profile, now, UTC)).toEqual([]);
    const oneDay = history().filter((i) => i.start >= now - 1.5 * D);
    expect(insights(oneDay, profile, now, UTC)).toEqual([]);
  });

  it('notices better nights and longer naps', () => {
    const out = insights(history({ better: true }), profile, now, UTC);
    const byId = Object.fromEntries(out.map((i) => [i.id, i]));
    expect(out.length).toBeLessThanOrEqual(4);
    expect(byId['night-wakings']).toEqual({ id: 'night-wakings', tone: 'good', text: 'Night wakings down from 2.0 to 1.0 per night.' });
    expect(byId['night-stretch'].tone).toBe('good');
    expect(byId['night-stretch'].text).toMatch(/up to 7 h on average, from 4 h/);
    expect(byId['naps'].text).toMatch(/1 h 15 min, up from 45 min/);
  });

  it('is deterministic and keeps the most useful four', () => {
    const items = history({ better: true, tummy: 8 });
    const a = insights(items, profile, now, UTC);
    const b = insights([...items].reverse(), profile, now, UTC);
    expect(a).toEqual(b);
    expect(a).toHaveLength(4);
    expect(a.map((i) => i.id)).toContain('tummy');
    expect(a.find((i) => i.id === 'tummy')!.text).toMatch(/8 min a day.*15–30 min/);
  });

  it('cheers on tummy time that meets the goal', () => {
    const t = insights(history({ tummy: 20 }), profile, now, UTC).find((i) => i.id === 'tummy')!;
    expect(t.tone).toBe('good');
    expect(t.text).toMatch(/20 min a day/);
    // Not for babies outside 7 weeks – 6 months.
    expect(insights(history({ tummy: 20 }), bornDaysAgo(300, now), now, UTC).find((i) => i.id === 'tummy')).toBeUndefined();
  });

  it('puts a gentle watch on low wet-diaper counts first', () => {
    const out = insights(history({ wet: 4 }), profile, now, UTC);
    expect(out[0].id).toBe('wet');
    expect(out[0].tone).toBe('watch');
    expect(out[0].text).toMatch(/4\.0 a day/);
    expect(out[0].text).not.toMatch(/dehydrat|danger|emergency/i);
  });

  it('reports bottle intake trends', () => {
    const up = insights(history({ bottleMl: [630, 770] }), profile, now, UTC).find((i) => i.id === 'feeds')!;
    expect(up).toMatchObject({ tone: 'good' });
    expect(up.text).toMatch(/770 ml a day, up from 630 ml/);
    const down = insights(history({ bottleMl: [800, 560] }), profile, now, UTC).find((i) => i.id === 'feeds')!;
    expect(down.tone).toBe('watch');
    expect(down.text).toMatch(/pediatrician/);
  });

  it('ignores the night still in progress', () => {
    // At 03:00 tonight has a 1 h stretch so far and baby is asleep again — it must not drag the average.
    const at3 = T('2026-06-15T03:00');
    const tonight = [sleep('2026-06-14T19:00', '2026-06-14T20:00'), sleep('2026-06-14T20:30', null)];
    const items = [...history().filter((i) => i.start < T('2026-06-14T19:00')), ...tonight];
    const stretch = insights(items, profile, at3, UTC).find((i) => i.id === 'night-stretch')!;
    expect(stretch.text).toBe('Longest night stretch averaged 4 h this week.');
  });

  it('counts wakings the camera saw inside one sleep', () => {
    const cam = history().map((i) =>
      i.kind === 'sleep' && i.start >= now - 7 * D && localParts(i.start, UTC).hour === 19 ? { ...i, src: 'monitor' as const, data: { wakings: 1 } } : i,
    );
    const w = insights(cam, profile, now, UTC).find((i) => i.id === 'night-wakings')!;
    expect(w.text).toBe('Night wakings up from 2.0 to 3.0 per night — often a passing phase (teething, a cold or a new skill).');
  });
});
