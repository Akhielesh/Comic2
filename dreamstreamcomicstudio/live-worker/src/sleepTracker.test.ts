// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { classifyMinute, endSession, manualSleep, manualWake, newSleepSm, sessionKind, stepSleep, type SleepEvent, type SleepMinute, type SleepSm } from './sleepTracker';

const MIN = 60_000;
const T0 = Date.UTC(2026, 9, 20, 19, 0); // 19:00

type Kind = 'quiet' | 'active' | 'cry' | 'stir';
const minute = (m: number, k: Kind): SleepMinute => ({
  m,
  state: k === 'cry' ? 5 : k === 'active' ? 2 : k === 'stir' ? 2 : 1,
  motion: k === 'active' ? 40 : k === 'cry' ? 30 : k === 'stir' ? 15 : 2,
  crib: null,
  sounds: k === 'cry' ? { cry: 40 } : {},
  visit: 0,
});

/** Feed a schedule of [kind, minutes] from a start time. */
function feed(sm: SleepSm, start: number, plan: [Kind, number][]) {
  const ev: SleepEvent[] = [];
  let t = start;
  let n = 0;
  for (const [k, mins] of plan) {
    for (let i = 0; i < mins; i++, t += MIN) ev.push(...stepSleep(sm, minute(t, k), () => `s${++n}`));
  }
  return { ev, t };
}

const at = (h: number, m = 0) => T0 + ((h - 19) * 60 + m) * MIN;

describe('sleep tracking', () => {
  it('follows a whole night: bedtime, a crying wake-up, a brief stir, morning', () => {
    const sm = newSleepSm();
    const { ev } = feed(sm, T0, [
      ['active', 20], // 19:00 bedtime routine
      ['quiet', 220], // 19:20–23:00 asleep
      ['cry', 12], // 23:00 cries 12 min
      ['quiet', 178], // 23:12–02:10
      ['stir', 2], // 02:10 brief stir — still asleep
      ['quiet', 260], // → 06:32
      ['active', 40], // morning
    ]);
    // The morning wake is reported live, then becomes the session's end 30 min later.
    expect(ev.map((e) => e.type)).toEqual(['started', 'asleep', 'woke', 'resettled', 'woke', 'ended']);
    expect(ev[0]).toMatchObject({ at: at(19, 20), source: 'auto' });
    expect(ev[2]).toMatchObject({ at: at(23, 0) });
    expect(ev[3]).toMatchObject({ at: at(23, 12), mins: 12 });
    const end = ev[5] as Extract<SleepEvent, { type: 'ended' }>;
    expect(end.end).toBe(at(30, 32)); // 06:32 next morning
    expect(end.discarded).toBe(false);
    // The night's numbers travel with the event (the state machine has reset).
    expect(end.stats).toMatchObject({ asleepMin: 660, awakeMin: 12, longest: 440, cryMin: 12, onset: at(19, 20) });
    expect(end.stats.wakings).toEqual([{ at: at(23), mins: 12, cried: true }]);
  });

  it('keeps the night’s numbers for the report', () => {
    const sm = newSleepSm();
    const night: [Kind, number][] = [['active', 20], ['quiet', 220], ['cry', 12], ['quiet', 440]];
    feed(sm, T0, night);
    expect(sm.phase).toBe('asleep');
    expect(sm.asleepMin).toBe(660);
    expect(sm.awakeMin).toBe(12);
    expect(sm.wakings).toEqual([{ at: at(23), mins: 12, cried: true }]);
    expect(sm.longest).toBe(440);
    expect(sm.cryMin).toBe(12);
  });

  it('a parent’s "Down for sleep" starts the session; "Woke up" ends it', () => {
    const sm = newSleepSm();
    expect(manualSleep(sm, T0, 'm1')).toEqual([{ type: 'started', session: 'm1', at: T0, source: 'manual' }]);
    const { ev, t } = feed(sm, T0, [['active', 8], ['quiet', 70]]);
    expect(ev).toEqual([{ type: 'asleep', session: 'm1', at: at(19, 8) }]);
    expect(manualWake(sm, t)).toMatchObject([{ type: 'ended', session: 'm1', end: t, discarded: false, stats: { asleepMin: 70, wakings: [], source: 'manual' } }]);
    expect(sm.session).toBeNull();
  });

  it('ends a session where the data stops when the camera goes away', () => {
    const sm = newSleepSm();
    const { t } = feed(sm, T0, [['quiet', 90]]);
    const ev = stepSleep(sm, minute(t + 3 * 60 * MIN, 'quiet'), () => 'x');
    expect(ev).toMatchObject([{ type: 'ended', session: 's1', end: t, discarded: false, stats: { asleepMin: 90, longest: 90 } }]);
  });

  it('discards a session too short to be real sleep', () => {
    const sm = newSleepSm();
    feed(sm, T0, [['quiet', 12]]);
    expect(endSession(sm, at(19, 12))).toMatchObject([{ type: 'ended', session: 's1', end: at(19, 12), discarded: true }]);
  });

  it('never calls an adult in the room "asleep"', () => {
    const sm = newSleepSm();
    const { ev } = feed(sm, T0, [['quiet', 5]]);
    const visit = { ...minute(at(19, 5), 'quiet'), visit: 1 };
    ev.push(...stepSleep(sm, visit, () => 'v'));
    ev.push(...feed(sm, at(19, 6), [['quiet', 6]]).ev);
    expect(ev).toEqual([]);
  });

  it('classifies minutes and sessions', () => {
    expect(classifyMinute(minute(0, 'quiet'))).toBe('quiet');
    expect(classifyMinute(minute(0, 'cry'))).toBe('active');
    expect(classifyMinute(minute(0, 'stir'))).toBe('active');
    expect(classifyMinute({ ...minute(0, 'quiet'), motion: 10 })).toBe('neutral');
    // The crib zone is preferred over the whole picture.
    expect(classifyMinute({ ...minute(0, 'quiet'), motion: 60, crib: 2 })).toBe('quiet');
    expect(sessionKind(20, 30)).toBe('night');
    expect(sessionKind(13, 90)).toBe('nap');
    expect(sessionKind(13, 300)).toBe('night');
  });
});
