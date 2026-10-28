// @vitest-environment node
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { composeGlance, glanceFacts, MOOD_RANK, type BabyState, type GlanceCamInput, type GlanceFacts } from './glance';
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
  const at = (h: number, m: number, s = 0) => Date.UTC(2026, 9, h < 12 ? 22 : 21, h, m, s);
  const within = (from: number, to: number) => bumps.filter((b) => b.t >= from && b.t < to).map((b) => [new Date(b.t).toISOString().slice(11, 19), b.reasons]);

  /** Every step of the replay (observations and re-checks), with the facts and what is published after it. */
  const steps: { t: number; facts: GlanceFacts; shown: GlanceFacts; before: GlanceFacts }[] = [];
  {
    let facts = night.initial;
    let state = startBump(facts, night.t0);
    let recheck: number | null = null;
    const step = (t: number) => {
      const before = state.facts;
      const r = nextBump(state, facts, t);
      state = r.state;
      recheck = r.recheckAt != null && r.recheckAt > t ? r.recheckAt : null;
      steps.push({ t, facts, shown: state.facts, before });
    };
    for (const [dt, patch] of night.observations) {
      const t = night.t0 + dt;
      while (recheck != null && recheck <= t) step(recheck);
      facts = applyFactsPatch(facts, patch);
      step(t);
    }
  }

  it('stays within 60 bumps (ADR 0006 acceptance), with two cameras for most of it', () => {
    expect(bumps.length).toBeLessThanOrEqual(night.expect.maxBumps);
    expect(night.expect.maxBumps).toBe(60);
    expect(Math.max(...steps.map((s) => s.facts.cam.on))).toBe(2);
  });

  it('gives exactly the golden bumps every port must reproduce', () => {
    expect(bumps.map((b) => [b.t - night.t0, b.q, b.reasons])).toEqual(night.expect.bumps);
  });

  it('never delays crying, fussing, an alert or a camera going offline — not by a millisecond', () => {
    let needed = 0;
    for (const { t, facts, shown, before } of steps) {
      const when = new Date(t).toISOString();
      // After every step, the glance shows at least as much distress as the facts…
      if (MOOD_RANK[facts.m] >= MOOD_RANK.fussing) expect(MOOD_RANK[shown.m], when).toBeGreaterThanOrEqual(MOOD_RANK[facts.m]);
      // …every open alert, and no camera when there is none.
      if (facts.al?.st === 'open') expect([shown.al?.id, shown.al?.st], when).toEqual([facts.al.id, 'open']);
      if (facts.cam.on === 0) expect([shown.cam.on, shown.m], when).toEqual([0, facts.m]);
      const rose = MOOD_RANK[facts.m] >= MOOD_RANK.fussing && MOOD_RANK[facts.m] > MOOD_RANK[before.m];
      const opened = facts.al?.st === 'open' && (before.al?.id !== facts.al.id || before.al.st !== 'open');
      const died = facts.cam.on === 0 && before.cam.on > 0;
      if (rose || opened || died) needed++;
    }
    // Two cries and a fuss rising, two cry alerts, the Wi-Fi blip (cameras + alert), the cameras stopped.
    expect(needed).toBe(7);
  });

  it('a 10-second stir is never shown; a 40-second one is, and so is the calm after it', () => {
    expect(within(at(23, 10), at(23, 11))).toEqual([]);
    expect(within(at(23, 40), at(23, 41))).toEqual([['23:40:15', ['mood']], ['23:40:55', ['mood']]]);
  });

  it('two cameras: a restless half hour on one is shown once, and so is the calm after it', () => {
    expect(within(at(22, 30), at(23, 1))).toEqual([['22:30:15', ['mood']], ['23:00:10', ['mood']]]);
  });

  it('two cameras: the 04:00 cry in bursts, over the dresser seeing her stir, is one cry', () => {
    expect(within(at(4, 0), at(4, 5)).filter(([, r]) => r.includes('mood') || r.includes('urgent'))).toEqual([['04:00:00', ['urgent']]]);
    for (const s of steps.filter((x) => x.t >= at(4, 0) && x.t < at(4, 5))) expect(s.shown.m).toBe('crying');
  });

  it('the dresser phone joining at 17 % shows its battery at once, then each edge it crosses', () => {
    expect(bumps.filter((b) => b.reasons.includes('battery')).map((b) => new Date(b.t).toISOString().slice(11, 16))).toEqual(['22:00', '23:52', '01:24', '02:04']);
  });
});

const T = Date.UTC(2026, 9, 22, 2, 0);
const base = (over: Partial<GlanceFacts> = {}): GlanceFacts => ({
  nm: 'Nursery',
  m: 'calm',
  ms: T - 600_000,
  sl: { p: 'asleep', s: T - 600_000, min: 10, w: 0 },
  db: 45,
  dbt: T,
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
    expect(run([[20_000, { m: 'stirring', ms: T + 1_000 }]]).reasons).toEqual([['mood']]);
    // …unless the facts date it to a moment the room looked and saw another mood: then it began now.
    expect(run([[20_000, { m: 'stirring', ms: T }], [34_999, {}], [35_000, {}]]).reasons).toEqual([null, null, ['mood']]);
    expect(run([[10_000, { db: 46, dbt: T + 10_000 }], [20_000, { m: 'stirring', ms: T + 5_000 }], [35_000, {}]]).reasons).toEqual([null, null, ['mood']]);
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
    for (let i = 1; i <= 30; i++) steps.push([i * 60_000, { sl: { p: 'asleep', s: T - 600_000, min: 10 + i, w: 0 }, db: 45 + (i % 3), dbt: T + i * 60_000, cam: { ls: T + i * 60_000 } }]);
    expect(run(steps).reasons.every((x) => x === null)).toBe(true);
  });

  it('a resolved alert ageing out waits for the next bump; an active one vanishing is news', () => {
    const resolved = { id: 'i1', k: 'cry', sev: 'urgent' as const, at: T, st: 'resolved' as const, by: 'Dad' };
    expect(run([[0, { al: null }]], base({ al: resolved })).reasons).toEqual([null]);
    expect(run([[0, { al: null }]], base({ al: { ...resolved, st: 'acked' } })).reasons).toEqual([['alert']]);
  });

  it('dB band: 30 s sustained, measured, with 2 dB of hysteresis', () => {
    const lv = (db: number | null, dt: number): FactsPatch => ({ db, dbt: db == null ? null : T + dt });
    // 45 (normal) → 58 (loud): shown when a level taken 30 s after the first is still loud.
    const held = run([[0, lv(58, 0)], [10_000, lv(59, 10_000)]]);
    expect(held.reasons).toEqual([null, null]);
    expect(held.recheck).toBeNull(); // it waits for a measurement, not for a re-check
    expect(run([[0, lv(58, 0)], [30_000, lv(58, 30_000)]]).reasons).toEqual([null, ['db']]);
    // The same level re-checked 30 s later is not a measurement.
    expect(run([[0, lv(58, 0)], [30_000, {}], [90_000, {}]]).reasons).toEqual([null, null, null]);
    // A 20 s spike never shows; a level back in the band starts the count again.
    expect(run([[0, lv(66, 0)], [20_000, lv(45, 20_000)], [60_000, lv(45, 60_000)]]).reasons).toEqual([null, null, null]);
    expect(run([[0, lv(58, 0)], [20_000, lv(50, 20_000)], [40_000, lv(58, 40_000)], [60_000, lv(58, 60_000)], [70_000, lv(58, 70_000)]]).reasons).toEqual([null, null, null, null, ['db']]);
    // No level any more (the meter off) isn't a measurement: it shows 30 s after it went.
    const gone = run([[0, lv(null, 0)]]);
    expect(gone.recheck).toBe(T + BUMP_RULES.dbbSustainMs);
    expect(run([[0, lv(null, 0)], [30_000, {}]]).reasons).toEqual([null, ['db']]);
    // A fan hovering at 54–56 dB stays "normal".
    const fan: [number, FactsPatch][] = Array.from({ length: 40 }, (_, i) => [i * 60_000, lv([54, 55, 56][i % 3], i * 60_000)]);
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

  it('a battery first seen under 20 % or 10 % shows at once, as a crossing would', () => {
    // An iPhone camera in Safari gives no battery reading; an Android phone joins at 8 %.
    const room = new Room([cam('calm', T - HOUR)], T);
    room.cams.push({ online: true, at: T, since: null, st: null });
    room.status(T, 0, 'calm');
    room.status(T + 2_000, 1, 'calm', { battery: 8, charging: false });
    room.status(T + 60_000, 1, 'calm', { battery: 4, charging: false });
    expect(room.bumps.map((b) => [b.t - T, b.reasons, b.facts.cam.bat])).toEqual([
      [0, ['camera'], null],
      [2_000, ['battery'], 8],
    ]);
    // First seen at 20 % or more is nothing to show; first seen at 15 % is.
    expect(run([[0, { cam: { bat: 60 } }], [1, { cam: { bat: 15 } }]], base({ cam: { on: 1, bat: null, chg: null, pz: null, ls: T } })).reasons).toEqual([null, ['battery']]);
    expect(run([[0, { cam: { bat: 15 } }]], base({ cam: { on: 1, bat: null, chg: null, pz: null, ls: T } })).reasons).toEqual([['battery']]);
  });

  it('between bumps the published glance is frozen; a bump publishes everything current', () => {
    const r1 = run([[0, { db: 49, sl: { p: 'asleep', s: T - 600_000, min: 11, w: 0 } }]]);
    expect(r1.state.facts.db).toBe(45);
    expect(r1.state.facts.sl?.min).toBe(10);
    const r2 = run([[20_000, { db: 49, dbt: T + 20_000, m: 'stirring', ms: T + 1_000 }], [25_000, { so: 'Rain' }]]);
    expect(r2.reasons).toEqual([['mood'], ['soothe']]);
    expect(r2.state.facts).toMatchObject({ db: 49, m: 'stirring', so: 'Rain' });
    expect(r2.state.pend).toEqual({});
    expect(r2.recheck).toBeNull();
  });

  it('a bump for something else never shows a mood still in its 15 s, nor a level not yet confirmed', () => {
    const al = { id: 'i1', k: 'cry', sev: 'urgent' as const, at: T + 20_000, st: 'open' as const, by: null };
    // A breath between cries as the cry alert opens: the glance says crying, with the alert.
    const r = run([
      [0, { m: 'crying', ms: T }],
      [20_000, { m: 'calm', ms: T + 20_000, al, db: 66, dbt: T + 20_000 }],
      [25_000, { m: 'crying', ms: T + 25_000 }],
    ]);
    expect(r.reasons).toEqual([['urgent'], ['alert'], null]);
    expect(r.state.facts).toMatchObject({ m: 'crying', ms: T, al, db: 45, dbt: T });
    expect(r.state.dbb).toBe(1);
    // What was held keeps waiting, and shows when due.
    const held = run([
      [0, { m: 'stirring', ms: T, db: 66, dbt: T }],
      [5_000, { so: 'Rain' }],
    ]);
    expect(held.reasons).toEqual([null, ['soothe']]);
    expect(held.state.facts).toMatchObject({ m: 'calm', db: 45, so: 'Rain' });
    expect(held.state.pend).toEqual({ m: { v: 'stirring', since: T }, dbb: { v: 2, since: T } });
    expect(held.recheck).toBe(T + BUMP_RULES.moodStableMs);
    // No level isn't held: the camera going offline takes its dB with it.
    const off = run([[0, { m: 'offline', ms: T, db: null, dbt: null, cam: { on: 0 } }]]);
    expect(off.state.facts).toMatchObject({ m: 'offline', db: null });
    expect([off.state.dbb, off.state.pend, off.recheck]).toEqual([null, {}, null]);
  });

  it('composes from the published state', () => {
    let s = startBump(base({ db: 54 }), T, 99);
    s = nextBump(s, base({ db: 56 }), T + 60_000).state;
    const g = composeGlance(glanceRoomState('n1', s, T + 61_000), { role: 'parent' });
    expect(g).toMatchObject({ q: 100, at: T + 61_000, db: 54, dbb: 1 });
  });
});

/**
 * A small room, the way WS-9 runs one: cameras as it knows them, `glanceFacts` + `nextBump` on
 * every status (state changes at once, a keepalive every 2 minutes) and on every re-check.
 */
class Room {
  state: BumpState;
  recheck: number | null = null;
  bumps: { t: number; reasons: BumpReason[]; facts: GlanceFacts }[] = [];
  constructor(
    public cams: GlanceCamInput[],
    t0: number,
    /** Whether the room knows when each camera's state began (otherwise `glanceFacts` falls back to `at`). */
    private since = true,
  ) {
    this.state = startBump(this.facts(t0), t0);
  }
  facts(t: number): GlanceFacts {
    return glanceFacts({ name: 'Twins', cams: this.cams }, t);
  }
  private step(t: number): void {
    const r = nextBump(this.state, this.facts(t), t);
    this.state = r.state;
    this.recheck = r.recheckAt;
    if (r.bumped) this.bumps.push({ t, reasons: r.reasons, facts: r.state.facts });
  }
  until(t: number): void {
    while (this.recheck != null && this.recheck <= t) this.step(this.recheck);
  }
  /** Camera `i` reports `state` at `t` (a keepalive when it is the same state). */
  status(t: number, i: number, state: BabyState, st: Partial<NonNullable<GlanceCamInput['st']>> = {}): void {
    this.until(t);
    const c = this.cams[i];
    if (c.st?.state !== state) c.since = this.since ? t : null;
    c.st = { ...c.st, ...st, state };
    c.at = t;
    this.step(t);
  }
  /** Run until `end`, every camera sending its 2-minute keepalive, while `script(t)` plays its changes. */
  play(t0: number, end: number, script: (t: number) => [number, BabyState][]): void {
    for (let t = t0; t < end; t += 1_000) {
      for (const [i, s] of script(t)) this.status(t, i, s);
      this.cams.forEach((c, i) => {
        if (c.online && c.st && (t - t0) % 120_000 === i * 1_000) this.status(t, i, c.st.state);
      });
    }
    this.until(end);
  }
}

const cam = (state: BabyState, since: number, over: Partial<GlanceCamInput> = {}): GlanceCamInput => ({ online: true, at: since, since, st: { state }, ...over });
const HOUR = 3_600_000;

describe('the dB band moves on measurements, never on silence', () => {
  // Overnight with the parent on the data channel, the room hears a camera every 2 minutes
  // (statusCadence keepalive), each status carrying the last second's Leq.
  it('a cough or a car at a keepalive is one second of sound: never shown', () => {
    const room = new Room([cam('calm', T - HOUR, { st: { state: 'calm', spl: { leq: 36 } } })], T);
    [36, 43, 35, 36, 44, 34, 37, 36, 43, 35].forEach((leq, i) => room.status(T + i * 120_000, 0, 'calm', { spl: { leq } }));
    room.until(T + 30 * 60_000);
    expect(room.bumps).toEqual([]);
  });

  it('a re-check alone never completes a band change; a later level still in the band does', () => {
    const r = replayObservations(T, base({ db: 45, dbt: T }), [[0, { db: 58, dbt: T }]], 10 * 60_000);
    expect(r.bumps.map((b) => b.reasons)).toEqual([['start']]);
    expect(r.state.pend.dbb).toEqual({ v: 2, since: T });
    const held = replayObservations(T, base({ db: 45, dbt: T }), [[0, { db: 58, dbt: T }], [60_000, { db: 59, dbt: T + 60_000 }]]);
    expect(held.bumps.map((b) => [b.t - T, b.reasons])).toEqual([[0, ['start']], [60_000, ['db']]]);
  });

  it('a minute row is the level the glance shows: it arrives every minute, and a spike is averaged in', () => {
    const room = new Room([cam('calm', T - HOUR, { st: { state: 'calm', spl: { leq: 80 } }, minute: { laeq: 38, at: T } })], T);
    expect(room.facts(T)).toMatchObject({ db: 38, dbt: T });
    // A stale row (the camera stopped sending them) gives way to the status's level.
    expect(room.facts(T + 10 * 60_000)).toMatchObject({ db: 80, dbt: T - HOUR });
  });
});

describe('a nursery with two cameras stays within the budget (ADR 0006: ≤ 60 bumps a night)', () => {
  // One twin stirs for 20 s, settles for 5 s, all hour long; the other sleeps through it.
  const flap = (t: number): [number, BabyState][] => {
    const s = (t - T) % 25_000;
    return s === 0 ? [[1, 'stirring']] : s === 20_000 ? [[1, 'calm']] : [];
  };

  for (const since of [true, false]) {
    it(`a twin stirring on and off is shown once, as with one camera${since ? '' : ' (no since: cameras give their last status time)'}`, () => {
      const one = new Room([cam('calm', T - HOUR)], T, since);
      one.play(T, T + HOUR, (t) => flap(t).map(([, s]) => [0, s]));
      const two = new Room([cam('calm', T - HOUR), cam('calm', T - HOUR)], T, since);
      two.play(T, T + HOUR, flap);
      expect(one.bumps.map((b) => [b.t - T, b.reasons])).toEqual([[15_000, ['mood']]]);
      expect(two.bumps.map((b) => [b.t - T, b.reasons])).toEqual([[15_000, ['mood']]]);
    });
  }

  it('a twin crying on and off over a stirring sibling is one bump, not one per gap', () => {
    // A cries 20 s, quiet 5 s; B has been stirring for an hour.
    const room = new Room([cam('calm', T - HOUR), cam('stirring', T - HOUR)], T);
    room.play(T, T + HOUR, (t) => {
      const s = (t - T) % 25_000;
      return s === 0 ? [[0, 'crying']] : s === 20_000 ? [[0, 'calm']] : [];
    });
    expect(room.bumps.map((b) => [b.t - T, b.reasons])).toEqual([[0, ['urgent']]]);
  });

  it('the calm that follows is dated from when the nursery settled, not from the calmest camera', () => {
    const room = new Room([cam('calm', T - HOUR), cam('calm', T - HOUR)], T);
    room.status(T, 1, 'stirring');
    room.status(T + 120_000, 1, 'calm');
    room.until(T + 10 * 60_000);
    expect(room.bumps.map((b) => [b.t - T, b.reasons, b.facts.m, b.facts.ms - T])).toEqual([
      [15_000, ['mood'], 'stirring', 0],
      [135_000, ['mood'], 'calm', 120_000],
    ]);
  });

  it('when a cry ends over a stirring sibling, “stirring” starts then (and waits its 15 s)', () => {
    const room = new Room([cam('calm', T - HOUR), cam('stirring', T - HOUR)], T);
    room.status(T, 0, 'crying');
    room.status(T + 60_000, 0, 'calm');
    room.until(T + 10 * 60_000);
    expect(room.bumps.map((b) => [b.t - T, b.reasons, b.facts.m, b.facts.ms - T])).toEqual([
      [0, ['urgent'], 'crying', 0],
      [75_000, ['mood'], 'stirring', 60_000],
    ]);
  });

  it('a second twin starting to cry doesn’t restart the published “crying since”', () => {
    const room = new Room([cam('calm', T - HOUR), cam('calm', T - HOUR)], T);
    room.status(T, 0, 'crying');
    room.status(T + 60_000, 1, 'crying');
    room.status(T + 61_000, 0, 'crying', { soothing: 'Shush' });
    expect(room.bumps.map((b) => [b.t - T, b.reasons, b.facts.m, b.facts.ms - T])).toEqual([
      [0, ['urgent'], 'crying', 0],
      [61_000, ['soothe'], 'crying', 0],
    ]);
  });
});
