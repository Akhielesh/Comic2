// PE-MOTION-ENGINE presets (master plan §2.5 "Presets", §2.9 "Flash ≤ 3 Hz in the presets"): one pure function per id
// in MOTION_PRESET_IDS and CAMERA_MOVE_IDS, each with a param schema and a flash count that matches the curve it draws.

import { describe, expect, it } from 'vitest';
import { MOTION_LIMITS } from '../limits';
import {
  CAMERA_MOVES,
  clipCurveAt,
  countFlashes,
  FLASH_OPACITY_DELTA,
  MOTION_PRESETS,
  motionPresetOf,
  cameraMoveOf,
  playableClip,
  presetDefaults,
  presetFlashesPerCycle,
  presetParamIssues,
  presetParamSchema,
  PRESET_REGISTRY,
  resolvePresetParams,
  REST_CHANNELS,
  seeded01,
  seedOf,
  type PresetChannels,
  type PresetDef,
  type PresetParams
} from './presets';
import { CAMERA_MOVE_IDS, MOTION_PRESET_IDS, MOTION_PRESETS_BY_ROLE, type MotionClip } from './types';

const LTR = { dir: 'ltr' as const };
const RTL = { dir: 'rtl' as const };
const SEEDS = [0, 1, 7, -123456, 0x7fffffff];
const close = (a: PresetChannels, b: PresetChannels, label: string) => {
  for (const k of Object.keys(REST_CHANNELS) as (keyof PresetChannels)[]) expect(a[k], `${label} ${k}`).toBeCloseTo(b[k], 9);
};
const all = (): PresetDef[] => [...Object.values(MOTION_PRESETS), ...Object.values(CAMERA_MOVES)];

/** Params at every corner of a schema: the defaults, then each number at its min and max and each enum value. */
const paramCorners = (def: PresetDef): PresetParams[] => {
  const base = presetDefaults(def.params);
  const out = [base];
  for (const [key, spec] of Object.entries(def.params)) {
    if (spec.kind === 'number') out.push({ ...base, [key]: spec.min }, { ...base, [key]: spec.max });
    else if (spec.kind === 'enum') for (const v of spec.values) out.push({ ...base, [key]: v });
  }
  return out;
};

/** The opacity curve one cycle draws, as the flash rule reads it (emphasis from and back to rest; loops closed). */
const sampledFlashes = (def: PresetDef, params: PresetParams, seed: number): number => {
  const os = Array.from({ length: 2001 }, (_, i) => def.at(i / 2000, params, seed, LTR).o);
  if (def.role === 'emphasis') return countFlashes([1, ...os, 1]);
  return countFlashes(os, def.role === 'loop');
};

describe('the preset registry', () => {
  it('has one preset per MOTION_PRESET_IDS id in its own group, and one camera move per CAMERA_MOVE_IDS id', () => {
    expect(Object.keys(MOTION_PRESETS).sort()).toEqual([...MOTION_PRESET_IDS].sort());
    for (const [role, ids] of Object.entries(MOTION_PRESETS_BY_ROLE)) for (const id of ids) expect(MOTION_PRESETS[id].role, id).toBe(role);
    expect(Object.keys(CAMERA_MOVES).sort()).toEqual([...CAMERA_MOVE_IDS].sort());
    for (const id of CAMERA_MOVE_IDS) expect(CAMERA_MOVES[id].role).toBe('camera');
    for (const def of all()) expect(def.id).toBeTruthy();
    // 'shake' is both an emphasis and a camera move: two different curves.
    expect(MOTION_PRESETS.shake).not.toBe(CAMERA_MOVES.shake);
    expect(PRESET_REGISTRY).toHaveLength(MOTION_PRESET_IDS.length + CAMERA_MOVE_IDS.length);
    expect(PRESET_REGISTRY.filter((p) => p.role === 'camera').map((p) => p.id)).toEqual([...CAMERA_MOVE_IDS]);
  });

  it('lookups read own keys only; an unknown id is undefined (its clip is inert)', () => {
    expect(motionPresetOf('pop')?.id).toBe('pop');
    expect(cameraMoveOf('push')?.id).toBe('push');
    for (const bad of ['constructor', 'toString', '__proto__', 'warp-in', '', 4, null]) {
      expect(motionPresetOf(bad)).toBeUndefined();
      expect(cameraMoveOf(bad)).toBeUndefined();
      expect(presetParamSchema(bad)).toBeUndefined();
    }
  });

  it('every schema is sound: defaults inside their ranges, enums list their default, durations inside the write bounds', () => {
    for (const def of all()) {
      expect(Object.keys(def.params).length, def.id).toBeLessThanOrEqual(MOTION_LIMITS.paramsPerClip);
      for (const [key, spec] of Object.entries(def.params)) {
        expect(key).toMatch(/^[a-zA-Z][a-zA-Z0-9_]{0,23}$/);
        if (spec.kind === 'number') {
          expect(spec.min, `${def.id}.${key}`).toBeLessThanOrEqual(spec.default);
          expect(spec.default).toBeLessThanOrEqual(spec.max);
          if (spec.int) expect(Number.isInteger(spec.default)).toBe(true);
        } else if (spec.kind === 'enum') {
          expect(spec.values).toContain(spec.default);
          for (const v of spec.values) expect(v.length).toBeLessThanOrEqual(MOTION_LIMITS.paramTextChars);
        }
      }
      if (def.role !== 'camera') {
        expect(def.dur, def.id).toBeGreaterThanOrEqual(MOTION_LIMITS.durMin);
        expect(def.dur).toBeLessThanOrEqual(MOTION_LIMITS.durMax);
      }
    }
  });
});

describe('preset curves', () => {
  it('entrances run from hidden to exactly as drawn; exits the other way; emphases and loops start and end at rest', () => {
    for (const def of Object.values(MOTION_PRESETS)) {
      for (const params of paramCorners(def)) {
        for (const seed of SEEDS) {
          const label = `${def.id} ${JSON.stringify(params)} seed ${seed}`;
          const start = def.at(0, params, seed, LTR);
          const end = def.at(1, params, seed, LTR);
          if (def.role === 'enter') {
            close(end, REST_CHANNELS, label);
            expect(start.o === 0 || start.reveal === 0, label).toBe(true);
          } else if (def.role === 'exit') {
            close(start, REST_CHANNELS, label);
            expect(end.o === 0 || end.reveal === 0, label).toBe(true);
          } else if (def.role === 'emphasis') {
            close(start, REST_CHANNELS, label);
            close(end, REST_CHANNELS, label);
          } else close(start, REST_CHANNELS, label);
        }
      }
    }
    // The smooth loops join up (the tiled ones, rain and speed lines, wrap by design).
    for (const id of ['float', 'sway', 'blink', 'sparkle-twinkle'] as const) close(MOTION_PRESETS[id].at(1, presetDefaults(MOTION_PRESETS[id].params), 3, LTR), REST_CHANNELS, id);
    for (const id of CAMERA_MOVE_IDS) if (id !== 'pull') close(CAMERA_MOVES[id].at(0, presetDefaults(CAMERA_MOVES[id].params), 5, LTR), REST_CHANNELS, id);
    close(CAMERA_MOVES.pull.at(1, presetDefaults(CAMERA_MOVES.pull.params), 5, LTR), REST_CHANNELS, 'pull');
  });

  it('every curve is finite at every corner of its schema, and the same inputs give the same numbers', () => {
    for (const def of all()) {
      for (const params of paramCorners(def)) {
        for (const t of [0, 0.013, 0.25, 0.5, 0.777, 1, 1.12]) {
          const a = def.at(t, params, 42, RTL);
          for (const v of Object.values(a)) expect(Number.isFinite(v), `${def.id} t=${t}`).toBe(true);
          expect(def.at(t, params, 42, RTL)).toEqual(a);
        }
      }
    }
  });

  it('the declared flashes per cycle are the flashes the curve draws, for every preset at every corner and seed', () => {
    let flashing = 0;
    for (const def of all()) {
      for (const params of paramCorners(def)) {
        for (const seed of SEEDS) {
          expect(sampledFlashes(def, params, seed), `${def.id} ${JSON.stringify(params)} seed ${seed}`).toBe(def.flashes(params));
          if (def.flashes(params) > 0) flashing += 1;
        }
      }
    }
    expect(flashing).toBeGreaterThan(10);
    // Only flicker, blink and the sparkle's twinkle flash at all.
    expect(all().filter((d) => d.flashes(presetDefaults(d.params)) > 0).map((d) => d.id).sort()).toEqual(['blink', 'flicker', 'sparkle-twinkle']);
    expect(presetFlashesPerCycle('flicker', { flashes: 6 })).toBe(6);
    expect(presetFlashesPerCycle('flicker', { depth: FLASH_OPACITY_DELTA / 2 })).toBe(0);
    expect(presetFlashesPerCycle('nope')).toBe(0);
  });

  it('the default flashing presets stay at or under 3 flashes a second', () => {
    for (const id of ['flicker', 'blink', 'sparkle-twinkle'] as const) {
      const def = MOTION_PRESETS[id];
      expect((def.flashes(presetDefaults(def.params)) * 1000) / def.dur, id).toBeLessThanOrEqual(MOTION_LIMITS.flashHzMax);
    }
  });

  it('randomness comes from the seed: jitter and the camera shake differ by seed and repeat for the same one', () => {
    const jitter = MOTION_PRESETS.jitter;
    const p = presetDefaults(jitter.params);
    const run = (seed: number) => Array.from({ length: 9 }, (_, i) => jitter.at((i + 0.5) / 9, p, seed, LTR).dx);
    expect(run(1)).toEqual(run(1));
    expect(run(1)).not.toEqual(run(2));
    expect(seeded01(5, 3)).toBe(seeded01(5, 3));
    for (let i = 0; i < 200; i += 1) {
      const v = seeded01(i * 7919, i);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
    expect(seedOf('mc_boom')).toBe(seedOf('mc_boom'));
    expect(seedOf('mc_boom')).not.toBe(seedOf('mc_bam'));
  });

  it('typewriter, word cascade and ink wipe are reveal masks (no re-layout); slide from the start follows the text direction', () => {
    expect(MOTION_PRESETS.typewriter.mask).toBe('lines');
    expect(MOTION_PRESETS['word-cascade'].mask).toBe('words');
    expect(MOTION_PRESETS['ink-wipe'].mask).toBe('wipe');
    expect(MOTION_PRESETS['ink-wipe-out'].mask).toBe('wipe');
    for (const id of ['typewriter', 'word-cascade', 'ink-wipe'] as const) {
      const at = (t: number) => MOTION_PRESETS[id].at(t, {}, 0, RTL);
      expect(at(0).reveal).toBe(0);
      expect(at(0.5).reveal).toBeGreaterThan(0);
      expect(at(1).reveal).toBe(1);
      // Only the reveal moves: the text is never shifted, scaled or faded.
      expect({ ...at(0.5), reveal: 1 }).toEqual(REST_CHANNELS);
    }
    const slide = MOTION_PRESETS.slide;
    const p = presetDefaults(slide.params);
    expect(slide.at(0, p, 0, LTR).dx).toBeLessThan(0);
    expect(slide.at(0, p, 0, RTL).dx).toBeGreaterThan(0);
    expect(slide.at(0, { ...p, from: 'up' }, 0, RTL).dy).toBeLessThan(0);
  });
});

describe('preset params', () => {
  it('stored params are clamped into the schema at draw time; wrong kinds, long text and unknown keys take the default', () => {
    const schema = MOTION_PRESETS.flicker.params;
    expect(resolvePresetParams(schema)).toEqual({ flashes: 3, depth: 0.8 });
    expect(resolvePresetParams(schema, { flashes: 99, depth: -4 })).toEqual({ flashes: 8, depth: 0 });
    expect(resolvePresetParams(schema, { flashes: 2.6 })).toEqual({ flashes: 3, depth: 0.8 });
    expect(resolvePresetParams(schema, { flashes: 'many', depth: Number.NaN, other: 1 })).toEqual({ flashes: 3, depth: 0.8 });
    const slide = MOTION_PRESETS.slide.params;
    expect(resolvePresetParams(slide, { from: 'up' }).from).toBe('up');
    expect(resolvePresetParams(slide, { from: 'sideways' }).from).toBe('start');
    expect(resolvePresetParams(slide, { from: 'u'.repeat(MOTION_LIMITS.paramTextChars + 1) }).from).toBe('start');
    // Only the first paramsPerClip entries are read (a write bound).
    const crowded: Record<string, number> = {};
    for (let i = 0; i < MOTION_LIMITS.paramsPerClip; i += 1) crowded[`x${i}`] = i;
    crowded.distance = 0.4;
    expect(resolvePresetParams(slide, crowded).distance).toBe(0.06);
    expect(resolvePresetParams(slide, ['distance'])).toEqual(presetDefaults(slide));
  });

  it('presetParamIssues names each problem for the sanitizer; good params have none', () => {
    const schema = MOTION_PRESETS.flicker.params;
    expect(presetParamIssues(schema)).toEqual([]);
    expect(presetParamIssues(schema, { flashes: 4, depth: 0.5 })).toEqual([]);
    expect(presetParamIssues(schema, { flashes: 9, depth: 'deep', glow: true, ['__proto__']: 1 })).toEqual([
      { key: 'flashes', reason: 'range' },
      { key: 'depth', reason: 'type' },
      { key: 'glow', reason: 'unknown' },
      // An own '__proto__' key (JSON can carry one) is just another unknown key, never a prototype.
      { key: '__proto__', reason: 'unknown' }
    ]);
    expect(presetParamIssues(schema, { flashes: 2.5 })).toEqual([{ key: 'flashes', reason: 'range' }]);
    expect(presetParamIssues(MOTION_PRESETS.slide.params, { from: 'sideways' })).toEqual([{ key: 'from', reason: 'value' }]);
    expect(presetParamIssues(schema, 'loud')).toEqual([{ key: '', reason: 'type' }]);
    const many = Object.fromEntries(Array.from({ length: MOTION_LIMITS.paramsPerClip + 1 }, (_, i) => [`k${i}`, i]));
    expect(presetParamIssues({}, many)[0]).toEqual({ key: '', reason: 'count' });
  });
});

describe('playable clips (the draw-time clamp) and their curve', () => {
  const clip = (patch: Partial<MotionClip>): MotionClip => ({ id: 'mc_a', target: { k: 'line', id: 'l1' }, role: 'enter', preset: 'pop', at: { anchor: 'reveal', ms: 0 }, ...patch });

  it('an unknown preset or ease makes the clip inert; timings are clamped to the write bounds', () => {
    expect(playableClip(clip({ preset: 'warp-in' as MotionClip['preset'] }))).toBeUndefined();
    expect(playableClip(clip({ ease: 'wobble' as MotionClip['ease'] }))).toBeUndefined();
    const pc = playableClip(clip({ dur: 99_999, repeat: 400, at: { anchor: 'page', ms: -50_000 } }))!;
    expect(pc.durMs).toBe(MOTION_LIMITS.durMax);
    expect(pc.repeat).toBe(MOTION_LIMITS.repeatMax);
    expect(pc.offsetMs).toBe(MOTION_LIMITS.atMsMin);
    expect(playableClip(clip({}))!.durMs).toBe(MOTION_PRESETS.pop.dur);
    expect(playableClip(clip({}))!.ease(0.5)).toBe(playableClip(clip({ ease: 'spring' }))!.ease(0.5));
    expect(playableClip(clip({}), 9)!.seed).not.toBe(playableClip(clip({}), 10)!.seed);
  });

  it('keys are clamped, sorted and capped; keyframes override the preset channel by channel', () => {
    const keys = [
      { t: 1, s: 50, x: 9 },
      { t: 0, s: 1, x: -9 },
      ...Array.from({ length: 20 }, (_, i) => ({ t: 0.5, r: i * 100 }))
    ];
    const pc = playableClip(clip({ preset: 'slide', ease: 'linear', keys }))!;
    expect(pc.keys.length).toBeLessThanOrEqual(MOTION_LIMITS.keysPerClip);
    expect(pc.keys.map((k) => k.t)).toEqual([...pc.keys.map((k) => k.t)].sort((a, b) => a - b));
    expect(pc.keys.find((k) => k.t === 1)).toEqual({ t: 1, s: MOTION_LIMITS.keyScaleMax, x: MOTION_LIMITS.keyOffsetMax });
    for (const k of pc.keys) if (k.r !== undefined) expect(Math.abs(k.r)).toBeLessThanOrEqual(MOTION_LIMITS.keyRotateMax);
    const end = clipCurveAt(pc, 1, LTR);
    expect(end.s).toBe(MOTION_LIMITS.keyScaleMax);
    expect(end.dx).toBe(MOTION_LIMITS.keyOffsetMax);
    // The channels no key sets still follow the preset: the slide's fade-in.
    const mid = clipCurveAt(pc, 0.2, LTR);
    expect(mid.o).toBeCloseTo(MOTION_PRESETS.slide.at(0.2, presetDefaults(MOTION_PRESETS.slide.params), 0, LTR).o, 9);
    expect(mid.dx).toBeCloseTo(-1 + 0.2 * 2, 9);
    // The flash guard keeps opacity as drawn.
    expect(clipCurveAt(pc, 0.1, LTR, true).o).toBe(1);
  });
});
