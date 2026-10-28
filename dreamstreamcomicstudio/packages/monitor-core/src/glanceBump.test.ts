// @vitest-environment node
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { composeGlance, type GlanceFacts } from './glance';
import { applyFactsPatch, batteryBucket, BUMP_RULES, dbBandFrom, glanceRoomState, nextBump, replayObservations, startBump, type BumpReason, type BumpState, type FactsPatch } from './glanceBump';

interface NightFixture {
  t0: number;
  endMs: number;
  initial: GlanceFacts;
  observations: [number, FactsPatch][];
  expect: { maxBumps: number; bumps: [number, number, BumpReason[]][] };
}
const night = JSON.parse(readFileSync(new URL('../fixtures/glance/night-2026-10-21.json', import.meta.url), 'utf8')) as NightFixture;

describe('the recorded night', () => {
  const { bumps } = replayObservations(night.t0, night.initial, night.observations, night.endMs);

  it('stays within 60 bumps (ADR 0006 acceptance)', () => {
    expect(bumps.length).toBeLessThanOrEqual(night.expect.maxBumps);
    expect(night.expect.maxBumps).toBe(60);
  });

  it('gives exactly the golden bumps every port must reproduce', () => {
    expect(bumps.map((b) => [b.t - night.t0, b.q, b.reasons])).toEqual(night.expect.bumps);
  });

  it('never delays crying, fussing, an alert or a camera going offline — not by a millisecond', () => {
    let facts = night.initial;
    const bumpAt = new Set(bumps.map((b) => b.t - night.t0));
    let checked = 0;
    for (const [t, patch] of night.observations) {
      const before = facts;
      facts = applyFactsPatch(facts, patch);
      const rises = (facts.m === 'crying' || facts.m === 'fussing') && before.m !== facts.m && before.m !== 'crying';
      const opens = facts.al?.st === 'open' && (before.al?.id !== facts.al.id || before.al.st !== 'open');
      const dies = facts.cam.on === 0 && before.cam.on > 0;
      if (rises || opens || dies) {
        expect(bumpAt.has(t), `bump at ${new Date(night.t0 + t).toISOString()}`).toBe(true);
        checked++;
      }
    }
    // Two cries and a fuss rising, two cry alerts, the Wi-Fi blip (camera + alert), the camera stopped.
    expect(checked).toBe(7);
  });

  it('a 10-second stir is never shown; a 40-second one is, and so is the calm after it', () => {
    const at = (h: number, m: number, s = 0) => Date.UTC(2026, 9, h < 12 ? 22 : 21, h, m, s);
    const times = bumps.map((b) => b.t);
    expect(times.some((t) => t >= at(23, 10) && t < at(23, 11))).toBe(false);
    expect(times.filter((t) => t >= at(23, 40) && t < at(23, 41))).toEqual([at(23, 40, 15), at(23, 40, 55)]);
  });
});

const T = Date.UTC(2026, 9, 22, 2, 0);
const base = (over: Partial<GlanceFacts> = {}): GlanceFacts => ({
  nm: 'Nursery',
  m: 'calm',
  ms: T - 600_000,
  sl: { p: 'asleep', s: T - 600_000, min: 10, w: 0 },
  db: 45,
  cam: { on: 1, bat: 80, chg: false, pz: null, ls: T },
  al: null,
  du: null,
  so: null,
  tk: null,
  ...over,
});

/** Feed `steps` ([ms after T, patch]) and return the reasons of each step (null = no bump). */
function run(steps: [number, FactsPatch][], start: GlanceFacts = base()): { reasons: (BumpReason[] | null)[]; state: BumpState; recheck: number | null } {
  let state = startBump(start, T);
  let f = start;
  let recheck: number | null = null;
  const reasons: (BumpReason[] | null)[] = [];
  for (const [dt, p] of steps) {
    f = applyFactsPatch(f, p);
    const r = nextBump(state, f, T + dt);
    state = r.state;
    recheck = r.recheckAt;
    reasons.push(r.bumped ? r.reasons : null);
  }
  return { reasons, state, recheck };
}

describe('nextBump rules', () => {
  it('starts at lastQ + 1 and only ever goes up', () => {
    expect(startBump(base(), T).q).toBe(1);
    expect(startBump(base(), T, 811).q).toBe(812);
    const { state } = run([[0, { m: 'crying', ms: T }], [1, { m: 'fussing', ms: T }], [20_000, {}]], base());
    expect(state.q).toBe(3);
  });

  it('a rise to fussing or crying is immediate; falling back waits 15 s of calm', () => {
    const r = run([
      [0, { m: 'fussing', ms: T }],
      [1_000, { m: 'crying', ms: T + 1_000 }],
      [60_000, { m: 'fussing', ms: T + 60_000 }],
      [70_000, {}],
      [75_000, {}],
    ]);
    expect(r.reasons).toEqual([['urgent'], ['urgent'], null, null, ['mood']]);
  });

  it('a mood that flaps never settles, so it never bumps', () => {
    const steps: [number, FactsPatch][] = [];
    for (let i = 0; i < 20; i++) steps.push([i * 5_000, { m: i % 2 ? 'calm' : 'stirring', ms: T + i * 5_000 }]);
    expect(run(steps).reasons.every((x) => x === null)).toBe(true);
  });

  it('stability counts from when the mood began, not from when the room heard of it', () => {
    expect(run([[20_000, { m: 'stirring', ms: T }]]).reasons).toEqual([['mood']]);
    // A mood "since" in the future can't hold the bump back forever.
    const r = run([[0, { m: 'stirring', ms: T + 3_600_000 }], [15_000, {}]]);
    expect(r.reasons).toEqual([null, ['mood']]);
  });

  it('camera offline, back, or gone is immediate both ways', () => {
    expect(run([[0, { m: 'offline', ms: T, cam: { on: 0 } }], [5_000, { m: 'calm', ms: T + 5_000, cam: { on: 1 } }]]).reasons).toEqual([
      ['camera', 'urgent'],
      ['camera', 'urgent'],
    ]);
    expect(run([[0, { m: 'unknown', ms: T }]]).reasons).toEqual([['urgent']]);
  });

  it('sleep phase, alert, duty, soothing, talk, pause and rename are immediate', () => {
    const al = { id: 'i1', k: 'cry', sev: 'urgent' as const, at: T };
    const r = run([
      [0, { sl: { p: 'awake', s: T, min: 10, w: 1 } }],
      [1, { al: { ...al, st: 'open', by: null } }],
      [2, { al: { ...al, st: 'acked', by: 'Dad' } }],
      [3, { al: { ...al, st: 'resolved', by: 'Dad' } }],
      [4, { du: { uid: 'u', nm: 'Mom', u: T + 1 } }],
      [5, { so: 'Rain' }],
      [6, { tk: 'Mom' }],
      [7, { cam: { pz: 'privacy' } }],
      [8, { nm: 'Maya’s room' }],
    ]);
    expect(r.reasons).toEqual([['sleep'], ['alert'], ['alert'], ['alert'], ['duty'], ['soothe'], ['talk'], ['camera'], ['name']]);
  });

  it('sleep minutes ticking, the dB number and the camera clock never bump', () => {
    const steps: [number, FactsPatch][] = [];
    for (let i = 1; i <= 30; i++) steps.push([i * 60_000, { sl: { p: 'asleep', s: T - 600_000, min: 10 + i, w: 0 }, db: 45 + (i % 3), cam: { ls: T + i * 60_000 } }]);
    expect(run(steps).reasons.every((x) => x === null)).toBe(true);
  });

  it('a resolved alert ageing out waits for the next bump; an active one vanishing is news', () => {
    const resolved = { id: 'i1', k: 'cry', sev: 'urgent' as const, at: T, st: 'resolved' as const, by: 'Dad' };
    expect(run([[0, { al: null }]], base({ al: resolved })).reasons).toEqual([null]);
    expect(run([[0, { al: null }]], base({ al: { ...resolved, st: 'acked' } })).reasons).toEqual([['alert']]);
  });

  it('dB band: 30 s sustained, with 2 dB of hysteresis', () => {
    // 45 (normal) → 58 (loud) held: due 30 s later.
    const held = run([[0, { db: 58 }], [10_000, { db: 59 }]]);
    expect(held.reasons).toEqual([null, null]);
    expect(held.recheck).toBe(T + BUMP_RULES.dbbSustainMs);
    expect(run([[0, { db: 58 }], [30_000, { db: 58 }]]).reasons).toEqual([null, ['db']]);
    // A 20 s spike never shows.
    expect(run([[0, { db: 66 }], [20_000, { db: 45 }], [60_000, { db: 45 }]]).reasons).toEqual([null, null, null]);
    // A fan hovering at 54–56 dB stays "normal".
    const fan: [number, FactsPatch][] = Array.from({ length: 40 }, (_, i) => [i * 60_000, { db: [54, 55, 56][i % 3] }]);
    expect(run(fan).reasons.every((x) => x === null)).toBe(true);
    expect([dbBandFrom(56, 1), dbBandFrom(57, 1), dbBandFrom(53, 2), dbBandFrom(52, 2), dbBandFrom(80, 0), dbBandFrom(null, 2)]).toEqual([1, 2, 2, 1, 3, null]);
  });

  it('battery: down at 20 % and 10 % at once; back up only 3 points over', () => {
    const r = run([
      [0, { cam: { bat: 21 } }],
      [1, { cam: { bat: 19 } }],
      [2, { cam: { bat: 21, chg: true } }],
      [3, { cam: { bat: 23 } }],
      [4, { cam: { bat: 9 } }],
      [5, { cam: { bat: 12 } }],
      [6, { cam: { bat: null } }],
    ]);
    expect(r.reasons).toEqual([null, ['battery'], null, ['battery'], ['battery'], null, null]);
    expect([batteryBucket(20, null), batteryBucket(19.9, 2), batteryBucket(22, 1), batteryBucket(23, 1), batteryBucket(9, 1), batteryBucket(13, 0)]).toEqual([2, 1, 1, 2, 0, 1]);
  });

  it('between bumps the published glance is frozen; a bump publishes everything current', () => {
    const r1 = run([[0, { db: 49, sl: { p: 'asleep', s: T - 600_000, min: 11, w: 0 } }]]);
    expect(r1.state.facts.db).toBe(45);
    expect(r1.state.facts.sl?.min).toBe(10);
    const r2 = run([[0, { db: 49, m: 'stirring', ms: T }], [5_000, { so: 'Rain' }]]);
    expect(r2.reasons).toEqual([null, ['soothe']]);
    expect(r2.state.facts).toMatchObject({ db: 49, m: 'stirring', so: 'Rain' });
    expect(r2.state.pend).toEqual({});
    expect(r2.recheck).toBeNull();
  });

  it('composes from the published state', () => {
    let s = startBump(base({ db: 54 }), T, 99);
    s = nextBump(s, base({ db: 56 }), T + 60_000).state;
    const g = composeGlance(glanceRoomState('n1', s, T + 61_000), { role: 'parent' });
    expect(g).toMatchObject({ q: 100, at: T + 61_000, db: 54, dbb: 1 });
  });
});
