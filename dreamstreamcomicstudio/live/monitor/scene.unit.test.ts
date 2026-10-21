// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { INFANT_SCENES, type InfantScene } from './infantScenes.fixture';
import { birthAt, classifyPosture, downAngle, faceVisible, pickBaby, poseBox, SceneWatch, type Detection, type Landmark, type SceneEvent, type SceneFrame } from './scene';
import type { Zone } from './vision';

/** A 33-point pose with the given points set (others invisible). */
function pose(pts: Partial<Record<number, [number, number, number?]>>): Landmark[] {
  return Array.from({ length: 33 }, (_, i) => {
    const p = pts[i];
    return p ? { x: p[0], y: p[1], v: p[2] ?? 0.9 } : { x: 0, y: 0, v: 0 };
  });
}
// Indices: 0 nose, 2/5 eyes, 11/12 shoulders, 15/16 wrists, 23/24 hips, 25/26 knees, 27/28 ankles.
const lying = (face = true) => pose({ 0: [0.3, 0.5, face ? 0.9 : 0.1], 2: [0.29, 0.48, face ? 0.9 : 0.1], 5: [0.31, 0.48, face ? 0.9 : 0.1], 11: [0.38, 0.47], 12: [0.38, 0.55], 23: [0.55, 0.48], 24: [0.55, 0.54], 25: [0.65, 0.5], 26: [0.65, 0.53], 27: [0.74, 0.5], 28: [0.74, 0.53], 15: [0.45, 0.42], 16: [0.45, 0.6] });
const sitting = pose({ 0: [0.5, 0.3], 2: [0.49, 0.28], 5: [0.51, 0.28], 11: [0.45, 0.4], 12: [0.55, 0.4], 23: [0.46, 0.58], 24: [0.54, 0.58], 25: [0.44, 0.63], 26: [0.56, 0.63], 15: [0.42, 0.55], 16: [0.58, 0.55] });
const standing = pose({ 0: [0.5, 0.15], 2: [0.49, 0.13], 5: [0.51, 0.13], 11: [0.45, 0.25], 12: [0.55, 0.25], 23: [0.46, 0.45], 24: [0.54, 0.45], 25: [0.46, 0.6], 26: [0.54, 0.6], 27: [0.46, 0.75], 28: [0.54, 0.75] });

const person = (x: number, y: number, w: number, h: number, score = 0.8): Detection => ({ label: 'person', score, box: { x, y, w, h } });
const obj = (label: string, x: number, y: number, w = 0.06, h = 0.06): Detection => ({ label, score: 0.7, box: { x, y, w, h } });
const crib: Zone = { id: 'c', kind: 'crib', name: 'Crib', x: 0.2, y: 0.3, w: 0.6, h: 0.5 };
const gym: Zone = { id: 'g', kind: 'activity', name: 'Play gym', x: 0.2, y: 0.3, w: 0.6, h: 0.5 };

/** Feed the same frame once a second for `secs`. */
const run = (w: SceneWatch, f: SceneFrame, from: number, secs: number) => {
  const all = [];
  for (let s = 0; s < secs; s++) all.push(...w.push(f, from + s * 1000).events);
  return all;
};

describe('classifyPosture', () => {
  it('tells lying, sitting and standing apart from a side-on view', () => {
    expect(classifyPosture(lying()).posture).toBe('lying');
    expect(classifyPosture(sitting).posture).toBe('sitting');
    expect(classifyPosture(standing).posture).toBe('standing');
  });
  it('won’t call it standing when the feet are out of the frame (a baby on their back, seen from above, looks the same)', () => {
    const feetOut = standing.map((p, i) => (i === 27 || i === 28 ? { ...p, y: 1.05 } : i === 25 || i === 26 ? { ...p, y: 0.75 } : p));
    expect(classifyPosture(feetOut).posture).toBeNull();
  });
  it('lying only (too young to sit, or the camera looks straight down): visible means lying', () => {
    expect(classifyPosture(standing, { lyingOnly: true })).toEqual({ posture: 'lying', conf: 0.8 });
    expect(classifyPosture(sitting, { lyingOnly: true }).posture).toBe('lying');
    expect(classifyPosture(pose({ 30: [0.5, 0.9] }), { lyingOnly: true }).posture).toBeNull();
  });
  it('says nothing without shoulders and hips', () => {
    expect(classifyPosture(pose({ 0: [0.5, 0.5] }))).toEqual({ posture: null, conf: 0 });
    expect(classifyPosture([])).toEqual({ posture: null, conf: 0 });
  });
  it('sees whether the face is toward the camera', () => {
    expect(faceVisible(lying(true))).toBe(true);
    expect(faceVisible(lying(false))).toBe(false);
  });
});

describe('pickBaby', () => {
  it('prefers the person in the crib, the rest are adults', () => {
    const baby = person(0.35, 0.4, 0.2, 0.2);
    const mom = person(0.0, 0.0, 0.4, 0.9);
    expect(pickBaby([mom, baby], [crib])).toEqual({ baby, adults: [mom] });
  });
  it('a lone person is the baby, even filling the frame (phone right above them)', () => {
    const close = person(0.12, 0.07, 0.83, 0.9);
    expect(pickBaby([close], [])).toEqual({ baby: close, adults: [] });
  });
  it('with no zones, the smaller of two people is the baby', () => {
    const baby = person(0.36, 0.36, 0.4, 0.49, 0.41);
    const dad = person(0.69, 0.22, 0.3, 0.78);
    expect(pickBaby([dad, baby], [])).toEqual({ baby, adults: [dad] });
  });
});

describe('context', () => {
  it('reads the camera’s pitch from the phone’s tilt', () => {
    expect(downAngle(0, 0)).toBeCloseTo(90); // flat, screen up: the back camera looks straight down
    expect(downAngle(90, 0)).toBeCloseTo(0); // upright
    expect(downAngle(30, 0)).toBeCloseTo(60);
    expect(downAngle(0, 0, true)).toBeCloseTo(-90); // the front camera looks up
  });
  it('parses a birthday', () => {
    expect(birthAt('2026-05-01')).toBe(new Date(2026, 4, 1).getTime());
    expect(birthAt('')).toBeNull();
    expect(birthAt(null)).toBeNull();
    expect(birthAt('May 1')).toBeNull();
  });
  it('finds the baby from the pose when the detector misses them', () => {
    expect(poseBox(lying())).toMatchObject({ x: expect.any(Number), w: expect.any(Number) });
    expect(poseBox(pose({ 0: [0.5, 0.5], 11: [0.5, 0.6] }))).toBeNull();
    const w = new SceneWatch();
    expect(w.push({ objects: [], poses: [lying()] }, 0).state.baby).toBe(true);
  });
});

describe('SceneWatch', () => {
  it('reports a posture only once it has held, then a change', () => {
    const w = new SceneWatch();
    w.setZones([crib]);
    const baby = person(0.3, 0.38, 0.5, 0.25);
    const ev1 = run(w, { objects: [baby], poses: [lying()] }, 0, 8);
    expect(ev1).toEqual([{ type: 'posture', posture: 'lying', where: 'Crib' }]);
    const ev2 = run(w, { objects: [baby], poses: [sitting] }, 200_000, 8);
    expect(ev2).toEqual([{ type: 'posture', posture: 'sitting', where: 'Crib' }]);
  });

  it('standing in the crib is called out (climb-out risk)', () => {
    const w = new SceneWatch();
    w.setZones([crib]);
    const ev = run(w, { objects: [person(0.4, 0.1, 0.2, 0.68)], poses: [standing] }, 0, 8);
    expect(ev.map((e) => e.type)).toEqual(['posture', 'stood_in_crib']);
  });

  it('notices a roll: face seen, then turned away while lying', () => {
    const w = new SceneWatch();
    w.setZones([crib]);
    const baby = person(0.3, 0.38, 0.5, 0.25);
    run(w, { objects: [baby], poses: [lying(true)] }, 0, 10);
    const ev = run(w, { objects: [baby], poses: [lying(false)] }, 10_000, 10);
    expect(ev).toEqual([{ type: 'rolled' }]);
  });

  it('a held toy is reported; a risky object within reach warns once (with a cooldown)', () => {
    const w = new SceneWatch();
    w.setZones([gym]);
    const baby = person(0.3, 0.38, 0.5, 0.25);
    const frame = { objects: [baby, obj('teddy bear', 0.42, 0.57), obj('scissors', 0.62, 0.42)], poses: [lying()] };
    const ev = run(w, frame, 0, 6);
    expect(ev).toContainEqual({ type: 'holding', label: 'teddy bear' });
    expect(ev).toContainEqual({ type: 'object_near', label: 'scissors', sharp: true, why: 'sharp' });
    expect(run(w, frame, 6000, 30).filter((e) => e.type === 'object_near')).toHaveLength(0);
    const later = run(w, frame, 11 * 60_000, 5);
    expect(later.filter((e) => e.type === 'object_near')).toHaveLength(1);
  });

  it('flags a soft toy in the crib with the baby (safe sleep)', () => {
    const w = new SceneWatch();
    w.setZones([crib]);
    const ev = run(w, { objects: [person(0.3, 0.38, 0.3, 0.2), obj('teddy bear', 0.7, 0.7)], poses: [] }, 0, 8);
    expect(ev).toEqual([{ type: 'soft_toy', inCrib: true }]);
  });

  it('flags a soft toy beside a lying baby with no crib marked', () => {
    const w = new SceneWatch();
    const ev = run(w, { objects: [person(0.25, 0.4, 0.55, 0.25), obj('teddy bear', 0.5, 0.3, 0.1, 0.1)], poses: [lying()] }, 0, 10);
    expect(ev).toContainEqual({ type: 'soft_toy', inCrib: false });
  });

  it('a young baby is only ever reported lying — and never “standing in the crib”', () => {
    const w = new SceneWatch();
    w.setZones([crib]);
    w.setContext({ bornAt: -60 * 86_400_000 }); // two months old at t=0
    const ev = run(w, { objects: [person(0.4, 0.1, 0.2, 0.68)], poses: [standing] }, 0, 8);
    expect(ev).toEqual([{ type: 'posture', posture: 'lying', where: 'Crib' }]);
  });

  it('grows out of it: the same frame reads as standing once the baby is older', () => {
    const w = new SceneWatch();
    w.setZones([crib]);
    w.setContext({ bornAt: -300 * 86_400_000 });
    const ev = run(w, { objects: [person(0.4, 0.1, 0.2, 0.68)], poses: [standing] }, 0, 8);
    expect(ev.map((e) => e.type)).toEqual(['posture', 'stood_in_crib']);
  });

  it('a camera looking straight down reports lying; level, it trusts the pose', () => {
    const w = new SceneWatch();
    w.setContext({ downAngle: 85 });
    expect(run(w, { objects: [person(0.2, 0.1, 0.6, 0.8)], poses: [sitting] }, 0, 8)).toEqual([{ type: 'posture', posture: 'lying', where: null }]);
    w.setContext({ downAngle: 20 });
    expect(run(w, { objects: [person(0.2, 0.1, 0.6, 0.8)], poses: [sitting] }, 200_000, 8)).toEqual([{ type: 'posture', posture: 'sitting', where: null }]);
  });

  it('head on a bed or couch → lying, whatever the image angle says', () => {
    const w = new SceneWatch();
    const ev = run(w, { objects: [obj('bed', 0, 0, 1, 1), person(0.2, 0.1, 0.6, 0.8)], poses: [sitting] }, 0, 8);
    expect(ev).toEqual([{ type: 'posture', posture: 'lying', where: null }]);
  });

  it('no pose and too young to sit → lying, unless a grown-up is holding them', () => {
    const young = { bornAt: -30 * 86_400_000 };
    const alone = new SceneWatch();
    alone.setContext(young);
    expect(run(alone, { objects: [person(0.4, 0.4, 0.2, 0.2)], poses: [] }, 0, 8)).toEqual([{ type: 'posture', posture: 'lying', where: null }]);
    const held = new SceneWatch();
    held.setContext(young);
    expect(run(held, { objects: [person(0.3, 0.1, 0.5, 0.85), person(0.4, 0.3, 0.2, 0.2)], poses: [] }, 0, 8)).toEqual([]);
  });

  it('activity zones: in after a few seconds, out with how long', () => {
    const w = new SceneWatch();
    w.setZones([gym]);
    const baby = person(0.3, 0.38, 0.3, 0.2);
    const into = run(w, { objects: [baby], poses: [] }, 0, 10);
    expect(into).toEqual([{ type: 'in_zone', name: 'Play gym' }]);
    const away = run(w, { objects: [person(0.85, 0.85, 0.1, 0.1)], poses: [] }, 120_000, 10);
    expect(away).toEqual([{ type: 'left_zone', name: 'Play gym', secs: expect.any(Number) }]);
  });

  it('describes the scene right now', () => {
    const w = new SceneWatch();
    w.setZones([crib]);
    const { state } = w.push({ objects: [person(0.3, 0.38, 0.4, 0.25), person(0, 0, 0.5, 0.95), obj('cup', 0.45, 0.45)], poses: [lying()] }, 0);
    expect(state).toMatchObject({ baby: true, where: 'Crib', adult: true, near: ['cup'] });
  });
});

/**
 * Regression set from real infant photos (numbers only — see the fixture).
 * In every one the baby is lying down; the swaddled ones sleep near plush toys.
 */
describe('real infant photos', () => {
  const frameOf = (s: InfantScene): SceneFrame => ({
    objects: s.objects.map(([label, score, x, y, w, h]) => ({ label, score, box: { x, y, w, h } })),
    poses: s.poses.map((p) => p.map(([x, y, v]) => ({ x, y, v }))),
  });
  const watch = (s: InfantScene, ctx?: Parameters<SceneWatch['setContext']>[0]) => {
    const w = new SceneWatch();
    if (ctx) w.setContext(ctx);
    const events: SceneEvent[] = [];
    let state = w.push(frameOf(s), 0).state;
    for (let t = 1; t <= 12; t++) {
      const r = w.push(frameOf(s), t * 1000);
      events.push(...r.events);
      state = r.state;
    }
    return { state, events };
  };
  const contexts = {
    'no context': () => undefined,
    'baby’s age (2 months)': () => ({ bornAt: -60 * 86_400_000 }),
    'phone tilt': (s: InfantScene) => ({ downAngle: s.view === 'overhead' ? 85 : 15 }),
  };

  it('has the nine scenes', () => expect(INFANT_SCENES).toHaveLength(9));

  for (const [name, ctx] of Object.entries(contexts)) {
    it(`${name}: finds the baby every time and never calls them sitting or standing`, () => {
      for (const s of INFANT_SCENES) {
        const { state, events } = watch(s, ctx(s));
        expect(state.baby, s.name).toBe(true);
        expect([null, 'lying'], s.name).toContain(state.posture);
        expect(events.some((e) => e.type === 'stood_in_crib' || (e.type === 'posture' && e.posture !== 'lying')), s.name).toBe(false);
      }
    });
  }

  it('with the age or the tilt known, every scene is lying', () => {
    for (const s of INFANT_SCENES) {
      expect(watch(s, contexts['baby’s age (2 months)']()).state.posture, s.name).toBe('lying');
      expect(watch(s, contexts['phone tilt'](s)).state.posture, s.name).toBe('lying');
    }
  });

  it('flags the plush toys around the sleeping baby (AAP: keep the sleep space bare)', () => {
    const side = INFANT_SCENES.find((s) => s.name === 'asleep-swaddled-side')!;
    const over = INFANT_SCENES.find((s) => s.name === 'asleep-swaddled-overhead-adult')!;
    expect(watch(side).events).toContainEqual({ type: 'soft_toy', inCrib: false });
    expect(watch(over, { bornAt: -60 * 86_400_000 }).events).toContainEqual({ type: 'soft_toy', inCrib: false });
    for (const s of INFANT_SCENES.filter((x) => !x.name.startsWith('asleep'))) {
      expect(watch(s, { bornAt: -60 * 86_400_000 }).events.some((e) => e.type === 'soft_toy'), s.name).toBe(false);
    }
  });

  it('sees the grown-up lying beside the baby as an adult, not the baby', () => {
    const s = INFANT_SCENES.find((x) => x.name === 'asleep-swaddled-overhead-adult')!;
    const { state } = watch(s);
    expect(state.adult).toBe(true);
    expect(state.baby).toBe(true);
  });
});
