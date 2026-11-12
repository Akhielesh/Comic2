// Pro Edit motion: the presets (master plan §2.5 "Presets"; PE-MOTION-ENGINE).
//
// One pure function per preset: (t01, params, seed, ctx) → {dx, dy, s, sy, r, o, reveal}, for every id in
// MOTION_PRESET_IDS (10 entrances, 8 emphases, 6 exits, 6 loops) and CAMERA_MOVE_IDS (6 camera moves; 'shake' is both an
// emphasis and a camera move, so the two live in separate tables). Each preset carries:
//   - its parameter schema (number ranges, enums, booleans) and defaults: the PE-SERVER sanitizer checks stored params
//     against it (presetParamIssues) and every player resolves them through it (resolvePresetParams), so a stored value
//     outside the range is clamped at draw time;
//   - the flashes one cycle makes for given params (WCAG 2.3.1; presets.test.ts holds it against the drawn curve, and
//     budget.ts clipFlashHz reads the drawn curve itself);
//   - its default duration and ease.
//
// Channels: dx, dy are offsets in page fractions; s is the scale (1 = as drawn), sy an extra vertical factor (squash and
// stretch only; 1 otherwise); r is degrees clockwise; o opacity 0..1; reveal 0..1 is how much of the text a reveal
// preset shows (typewriter, word cascade, ink wipe). A reveal is a clip mask over the drawn lettering in the line's own
// direction (right to left for Arabic and Urdu: sample.ts sets the pose's `dir`), never a re-layout of the text, so
// shaping and LetterPlans stay untouched. Entrances run from hidden (t = 0) to as drawn (t = 1) and exits the other way,
// each exactly once (a stored repeat is ignored); emphases and loops start and end as drawn. Camera channels move the camera frame: dx, dy shift it, s zooms in.
//
// Deterministic: randomness (jitter, camera shake) comes from the seed, never Math.random, and never decides when
// anything flashes: what the flash rule reads (visibilityOf) is the same for every seed, so the server's seed-0 count
// bounds every player. No DOM.
//
// Bundling: the tables below are built at module level, so each is marked pure (/* @__PURE__ */, @__NO_SIDE_EFFECTS__)
// and a bundle that imports nothing from this file drops all of it. Labels never import the engine: words.ts is the
// metadata-only leaf for that (History, undo, the reader chunk).

import type {
  CameraMoveId,
  EaseId,
  EmphasisPresetId,
  EnterPresetId,
  ExitPresetId,
  LoopPresetId,
  MotionClip,
  MotionKey,
  MotionPresetId,
  MotionRole
} from './types.js';
import { CAMERA_MOVE_IDS, MOTION_PRESET_IDS } from './types.js';
import { MOTION_LIMITS } from '../limits.js';
import { easeOf, isKnownEase, type EaseFn } from './easing.js';

/** What a preset sets at one instant. */
export interface PresetChannels {
  dx: number;
  dy: number;
  s: number;
  sy: number;
  r: number;
  o: number;
  reveal: number;
}

/** As drawn: no offset, no scale, no turn, fully opaque, fully revealed. */
export const REST_CHANNELS: Readonly<PresetChannels> = /* @__PURE__ */ Object.freeze({ dx: 0, dy: 0, s: 1, sy: 1, r: 0, o: 1, reveal: 1 });

export type PresetParamSpec =
  | { kind: 'number'; min: number; max: number; default: number; int?: true }
  | { kind: 'enum'; values: readonly string[]; default: string }
  | { kind: 'boolean'; default: boolean };
export type PresetParamSchema = Readonly<Record<string, PresetParamSpec>>;
export type PresetParams = Record<string, number | string | boolean>;

/** How a reveal preset uncovers the lettering: line by line (typewriter), word by word, or one wipe over the object. */
export type RevealMask = 'lines' | 'words' | 'wipe';
export type MotionDir = 'ltr' | 'rtl';
export interface PresetContext {
  /** The text direction of the object (right to left for Arabic and Urdu lines). */
  dir: MotionDir;
}

export interface PresetDef<Id extends string = string> {
  id: Id;
  /** What the curve is: an entrance, an emphasis, an exit, a loop, or a camera move over a panel's shot. */
  role: MotionRole | 'camera';
  /** One play's length (ms) when the clip names no `dur` (camera moves last their panel's shot). */
  dur: number;
  /** The clip's ease when it names none. */
  ease: EaseId;
  /** True when the clip's ease is ignored: a flashing preset keeps its rhythm, so the flashes counted are the ones drawn. */
  fixedEase?: true;
  params: PresetParamSchema;
  /** Flashes (pairs of opposing visibility changes of at least FLASH_OPACITY_DELTA) one cycle makes for these params. */
  flashes: (params: PresetParams) => number;
  /** Set on the reveal presets: how the reveal channel uncovers the lettering. */
  mask?: RevealMask;
  /** Channels at t01 (0..1 of one play, after the ease; a spring may overshoot past 1). Pure. */
  at: (t01: number, params: PresetParams, seed: number, ctx: PresetContext) => PresetChannels;
}
export type MotionPresetDef = PresetDef<MotionPresetId>;
export type CameraMoveDef = PresetDef<CameraMoveId>;

/** A change of visibility this large (visibilityOf: opacity, reveal, a collapsing scale) counts toward a flash (WCAG
 *  2.3.1 reads a 10 % change in luminance as one). */
export const FLASH_OPACITY_DELTA = 0.1;
/** Squeezed under this on either axis, an object reads as gone: the flash rule fades its visibility to 0 below it, and
 *  the flash guard never lets a held clip shrink past it. */
export const FLASH_HIDDEN_SCALE = 0.25;

/**
 * How much of an object shows at one instant, 0..1, as the flash rule reads it (budget.ts clipFlashHz): its opacity,
 * times its reveal, times how far its narrower axis is from collapsing (1 at FLASH_HIDDEN_SCALE or more, 0 at 0). An
 * object that blinks out by fading, by un-revealing or by shrinking to nothing flashes the same.
 */
export const visibilityOf = (c: Pick<PresetChannels, 'o' | 'reveal' | 's' | 'sy'>): number => {
  const narrow = Math.min(Math.abs(c.s), Math.abs(c.s * c.sy));
  const v = c.o * c.reveal * Math.min(1, narrow / FLASH_HIDDEN_SCALE);
  return Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0;
};

// ── Helpers (pure) ──────────────────────────────────────────────────────────

const clamp01 = (v: number): number => (v > 0 ? (v < 1 ? v : 1) : 0);
/** 2π, as a literal: a top-level read of Math.PI is a side effect to a bundler, and this file must shake out. */
const TAU = 6.283185307179586;
const ch = (p: Partial<PresetChannels>): PresetChannels => ({ ...REST_CHANNELS, ...p });
const num = (params: PresetParams, key: string): number => params[key] as number;
const word = (params: PresetParams, key: string): string => params[key] as string;
/** 0 outside c ± w, 1 at c (a smooth bump). */
const bump = (t: number, c: number, w: number): number => {
  const d = (t - c) / w;
  return d <= -1 || d >= 1 ? 0 : 1 - d * d;
};
/** Penner's bounce-out (0 → 1 with three settling bounces). */
const bounceOut = (x: number): number => {
  const n = 7.5625;
  const d = 2.75;
  let t = clamp01(x);
  if (t < 1 / d) return n * t * t;
  if (t < 2 / d) return n * (t -= 1.5 / d) * t + 0.75;
  if (t < 2.5 / d) return n * (t -= 2.25 / d) * t + 0.9375;
  return n * (t -= 2.625 / d) * t + 0.984375;
};

/** A seeded number in 0..1 for (seed, i): an integer hash (no state, same on every run and engine). */
export const seeded01 = (seed: number, i: number): number => {
  let h = (Math.imul(seed | 0, 0x9e3779b1) ^ Math.imul((i | 0) + 0x7f4a7c15, 0x85ebca6b)) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35) >>> 0;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
};

/** A 32-bit seed from text (FNV-1a): a clip's id seeds its jitter, so the same clip shakes the same way everywhere. */
export const seedOf = (text: string): number => {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h | 0;
};

const DIRECTIONS = ['start', 'end', 'left', 'right', 'up', 'down'] as const;
/** The unit offset a slide comes from (or goes to): 'start' is the reading start (left, or right for rtl). */
const offsetOf = (dir: string, ctx: PresetContext): { x: number; y: number } => {
  const rtl = ctx.dir === 'rtl';
  switch (dir) {
    case 'start':
      return { x: rtl ? 1 : -1, y: 0 };
    case 'end':
      return { x: rtl ? -1 : 1, y: 0 };
    case 'left':
      return { x: -1, y: 0 };
    case 'right':
      return { x: 1, y: 0 };
    case 'up':
      return { x: 0, y: -1 };
    default:
      return { x: 0, y: 1 };
  }
};

const none = (): number => 0;
const dips = /* @__NO_SIDE_EFFECTS__ */ (key: string) => (params: PresetParams): number => (num(params, key) >= FLASH_OPACITY_DELTA ? 1 : 0);
/** Seeded jitter: a step `k` of `steps` gets its own offset in −1..1 on each axis. */
const jitterAt = (t: number, steps: number, seed: number): { x: number; y: number } => {
  const k = Math.min(steps - 1, Math.max(0, Math.floor(t * steps)));
  return { x: seeded01(seed, 2 * k) * 2 - 1, y: seeded01(seed, 2 * k + 1) * 2 - 1 };
};

const n = /* @__NO_SIDE_EFFECTS__ */ (min: number, max: number, def: number, int?: true): PresetParamSpec => ({ kind: 'number', min, max, default: def, ...(int ? { int } : {}) });
const e = /* @__NO_SIDE_EFFECTS__ */ (values: readonly string[], def: string): PresetParamSpec => ({ kind: 'enum', values, default: def });

// ── Curves ──────────────────────────────────────────────────────────────────

// Entrance curves (t: 0 hidden → 1 as drawn). Exits run these backwards.
const popAt = (t: number, from: number) => ch({ s: from + (1 - from) * t, o: clamp01(t / 0.25) });
const slideAt = (t: number, params: PresetParams, key: string, ctx: PresetContext) => {
  const v = offsetOf(word(params, key), ctx);
  const d = num(params, 'distance');
  return { dx: v.x * d * (1 - t), dy: v.y * d * (1 - t) };
};
const zoomAt = (t: number, from: number) => ch({ s: 1 + (from - 1) * (1 - t), o: clamp01(t / 0.15) });
const dropAt = (t: number, distance: number) => ch({ dy: -distance * (1 - t), o: clamp01(t / 0.3) });

// ── The tables ──────────────────────────────────────────────────────────────

const ENTER: Record<EnterPresetId, Omit<MotionPresetDef, 'id' | 'role'>> = {
  pop: { dur: 320, ease: 'spring', params: { from: n(0, 1, 0.5) }, flashes: none, at: (t, p) => popAt(t, num(p, 'from')) },
  bounce: {
    dur: 700,
    ease: 'linear',
    params: { height: n(0, 0.5, 0.12) },
    flashes: none,
    at: (t, p) => ch({ dy: -num(p, 'height') * (1 - bounceOut(t)), o: clamp01(t / 0.2) })
  },
  slide: {
    dur: 420,
    ease: 'enter',
    params: { from: e(DIRECTIONS, 'start'), distance: n(0, 0.5, 0.06) },
    flashes: none,
    at: (t, p, _s, ctx) => ch({ ...slideAt(t, p, 'from', ctx), o: clamp01(t / 0.4) })
  },
  'zoom-punch': { dur: 260, ease: 'enter', params: { from: n(1, 4, 1.8) }, flashes: none, at: (t, p) => zoomAt(t, num(p, 'from')) },
  fade: { dur: 360, ease: 'ease', params: {}, flashes: none, at: (t) => ch({ o: clamp01(t) }) },
  drop: { dur: 420, ease: 'spring', params: { distance: n(0, 0.5, 0.08) }, flashes: none, at: (t, p) => dropAt(t, num(p, 'distance')) },
  'spin-in': {
    dur: 520,
    ease: 'enter',
    params: { turns: n(0, 2, 0.5), spin: e(['cw', 'ccw'], 'cw') },
    flashes: none,
    at: (t, p) => ch({ r: (word(p, 'spin') === 'ccw' ? 1 : -1) * num(p, 'turns') * 360 * (1 - t), s: 0.6 + 0.4 * t, o: clamp01(t / 0.3) })
  },
  typewriter: { dur: 1200, ease: 'linear', params: {}, flashes: none, mask: 'lines', at: (t) => ch({ reveal: clamp01(t) }) },
  'word-cascade': { dur: 1000, ease: 'linear', params: {}, flashes: none, mask: 'words', at: (t) => ch({ reveal: clamp01(t) }) },
  'ink-wipe': { dur: 600, ease: 'ease', params: {}, flashes: none, mask: 'wipe', at: (t) => ch({ reveal: clamp01(t) }) }
};

const EMPHASIS: Record<EmphasisPresetId, Omit<MotionPresetDef, 'id' | 'role'>> = {
  shake: {
    dur: 500,
    ease: 'linear',
    params: { amount: n(0, 0.1, 0.015), cycles: n(1, 12, 5, true) },
    flashes: none,
    at: (t, p) => ch({ dx: num(p, 'amount') * Math.sin(TAU * num(p, 'cycles') * t) * (1 - clamp01(t)) })
  },
  pulse: { dur: 600, ease: 'ease', params: { amount: n(0, 0.5, 0.08) }, flashes: none, at: (t, p) => ch({ s: 1 + num(p, 'amount') * Math.sin(Math.PI * clamp01(t)) }) },
  jitter: {
    dur: 500,
    ease: 'linear',
    params: { amount: n(0, 0.1, 0.008), steps: n(2, 24, 10, true) },
    flashes: none,
    at: (t, p, seed) => {
      const j = jitterAt(t, num(p, 'steps'), seed);
      const env = Math.sin(Math.PI * clamp01(t));
      return ch({ dx: num(p, 'amount') * j.x * env, dy: num(p, 'amount') * j.y * env });
    }
  },
  'squash-stretch': {
    dur: 520,
    ease: 'linear',
    params: { amount: n(0, 0.5, 0.15) },
    flashes: none,
    at: (t, p) => {
      const w = num(p, 'amount') * Math.sin(TAU * clamp01(t)) * (1 - clamp01(t));
      const sx = 1 + w / 2;
      return ch({ s: sx, sy: (1 - w) / sx });
    }
  },
  flicker: {
    dur: 1200,
    ease: 'linear',
    fixedEase: true,
    params: { flashes: n(1, 8, 3, true), depth: n(0, 1, 0.8) },
    flashes: (p) => (num(p, 'depth') >= FLASH_OPACITY_DELTA ? num(p, 'flashes') : 0),
    // Evenly spaced dips, the same for every seed: when a flicker flashes never depends on who draws it, so the
    // sanitizer's count (seed 0) is every player's count.
    at: (t, p) => {
      const count = num(p, 'flashes');
      const k = Math.min(count - 1, Math.max(0, Math.floor(clamp01(t) * count)));
      const centre = (k + 0.5) / count;
      return ch({ o: Math.abs(t - centre) < 0.12 / count ? 1 - num(p, 'depth') : 1 });
    }
  },
  wiggle: {
    dur: 600,
    ease: 'linear',
    params: { angle: n(0, 45, 6), cycles: n(1, 8, 3, true) },
    flashes: none,
    at: (t, p) => ch({ r: num(p, 'angle') * Math.sin(TAU * num(p, 'cycles') * t) * (1 - clamp01(t)) })
  },
  // A soft swell: no live filter is drawn (§5 performance), so a glow reads as the object breathing out.
  glow: { dur: 900, ease: 'ease', params: { amount: n(0, 0.3, 0.06) }, flashes: none, at: (t, p) => ch({ s: 1 + num(p, 'amount') * Math.sin(Math.PI * clamp01(t)) ** 2 }) },
  heartbeat: {
    dur: 900,
    ease: 'linear',
    params: { amount: n(0, 0.5, 0.1) },
    flashes: none,
    at: (t, p) => ch({ s: 1 + num(p, 'amount') * (bump(t, 0.2, 0.12) + 0.6 * bump(t, 0.5, 0.12)) })
  }
};

const EXIT: Record<ExitPresetId, Omit<MotionPresetDef, 'id' | 'role'>> = {
  'pop-out': { dur: 260, ease: 'in', params: { to: n(0, 1, 0.5) }, flashes: none, at: (t, p) => popAt(1 - t, num(p, 'to')) },
  'fade-out': { dur: 360, ease: 'ease', params: {}, flashes: none, at: (t) => ch({ o: clamp01(1 - t) }) },
  'slide-out': {
    dur: 380,
    ease: 'in',
    params: { to: e(DIRECTIONS, 'end'), distance: n(0, 0.5, 0.06) },
    flashes: none,
    at: (t, p, _s, ctx) => ch({ ...slideAt(1 - t, p, 'to', ctx), o: clamp01((1 - t) / 0.4) })
  },
  'zoom-out': { dur: 320, ease: 'in', params: { to: n(1, 4, 1.6) }, flashes: none, at: (t, p) => ch({ s: 1 + (num(p, 'to') - 1) * t, o: clamp01((1 - t) / 0.4) }) },
  'drop-out': {
    dur: 420,
    ease: 'in',
    params: { distance: n(0, 0.5, 0.1) },
    flashes: none,
    at: (t, p) => ch({ dy: num(p, 'distance') * t, o: clamp01((1 - t) / 0.5) })
  },
  'ink-wipe-out': { dur: 600, ease: 'ease', params: {}, flashes: none, mask: 'wipe', at: (t) => ch({ reveal: clamp01(1 - t) }) }
};

const LOOP: Record<LoopPresetId, Omit<MotionPresetDef, 'id' | 'role'>> = {
  float: { dur: 2400, ease: 'linear', params: { amount: n(0, 0.1, 0.008) }, flashes: none, at: (t, p) => ch({ dy: -num(p, 'amount') * Math.sin(TAU * t) }) },
  sway: { dur: 3000, ease: 'linear', params: { angle: n(0, 30, 3) }, flashes: none, at: (t, p) => ch({ r: num(p, 'angle') * Math.sin(TAU * t) }) },
  blink: {
    dur: 3200,
    ease: 'linear',
    fixedEase: true,
    params: { depth: n(0, 1, 1) },
    flashes: dips('depth'),
    at: (t, p) => ch({ o: t > 0.46 && t < 0.54 ? 1 - num(p, 'depth') : 1 })
  },
  'rain-fall': {
    dur: 900,
    ease: 'linear',
    params: { distance: n(0, 1, 0.1), slant: n(-45, 45, 12) },
    flashes: none,
    at: (t, p) => {
      const dy = num(p, 'distance') * clamp01(t);
      return ch({ dy, dx: dy * Math.tan((num(p, 'slant') * Math.PI) / 180) });
    }
  },
  'speed-line-scroll': {
    dur: 600,
    ease: 'linear',
    params: { distance: n(0, 1, 0.1), toward: e(DIRECTIONS, 'start') },
    flashes: none,
    at: (t, p, _s, ctx) => {
      const v = offsetOf(word(p, 'toward'), ctx);
      const d = num(p, 'distance') * clamp01(t);
      return ch({ dx: v.x * d, dy: v.y * d });
    }
  },
  'sparkle-twinkle': {
    dur: 1600,
    ease: 'linear',
    fixedEase: true,
    params: { depth: n(0, 1, 0.6) },
    flashes: dips('depth'),
    at: (t, p) => {
      const b = bump(t, 0.5, 0.2);
      return ch({ o: 1 - num(p, 'depth') * b, s: 1 + 0.12 * num(p, 'depth') * b });
    }
  }
};

const CAMERA: Record<CameraMoveId, Omit<CameraMoveDef, 'id' | 'role'>> = {
  still: { dur: 0, ease: 'linear', params: {}, flashes: none, at: () => ch({}) },
  push: { dur: 0, ease: 'ease', params: { amount: n(0, 0.5, 0.08) }, flashes: none, at: (t, p) => ch({ s: 1 + num(p, 'amount') * clamp01(t) }) },
  pull: { dur: 0, ease: 'ease', params: { amount: n(0, 0.5, 0.08) }, flashes: none, at: (t, p) => ch({ s: 1 + num(p, 'amount') * (1 - clamp01(t)) }) },
  'pan-left': { dur: 0, ease: 'ease', params: { amount: n(0, 0.5, 0.06) }, flashes: none, at: (t, p) => ch({ dx: -num(p, 'amount') * clamp01(t) }) },
  'pan-right': { dur: 0, ease: 'ease', params: { amount: n(0, 0.5, 0.06) }, flashes: none, at: (t, p) => ch({ dx: num(p, 'amount') * clamp01(t) }) },
  shake: {
    dur: 0,
    ease: 'linear',
    params: { amount: n(0, 0.05, 0.006), steps: n(4, 48, 24, true) },
    flashes: none,
    at: (t, p, seed) => {
      const j = jitterAt(t, num(p, 'steps'), seed);
      const env = Math.min(1, clamp01(t) / 0.1, (1 - clamp01(t)) / 0.1);
      return ch({ dx: num(p, 'amount') * j.x * env, dy: num(p, 'amount') * j.y * env });
    }
  }
};

const withIds = /* @__NO_SIDE_EFFECTS__ */ <K extends string, D extends PresetDef>(table: Record<K, Omit<D, 'id' | 'role'>>, role: D['role']): Record<K, D> =>
  Object.fromEntries((Object.keys(table) as K[]).map((id) => [id, Object.freeze(Object.assign({}, table[id], { id, role }))])) as unknown as Record<K, D>;

/** Every clip preset this build plays, by id (exhaustive over MOTION_PRESET_IDS: each table is keyed by its group's ids). */
export const MOTION_PRESETS: Readonly<Record<MotionPresetId, MotionPresetDef>> = /* @__PURE__ */ Object.freeze(
  /* @__PURE__ */ Object.assign(
    {} as Record<MotionPresetId, MotionPresetDef>,
    /* @__PURE__ */ withIds<EnterPresetId, MotionPresetDef>(ENTER, 'enter'),
    /* @__PURE__ */ withIds<EmphasisPresetId, MotionPresetDef>(EMPHASIS, 'emphasis'),
    /* @__PURE__ */ withIds<ExitPresetId, MotionPresetDef>(EXIT, 'exit'),
    /* @__PURE__ */ withIds<LoopPresetId, MotionPresetDef>(LOOP, 'loop')
  )
);

/** Every camera move this build plays, by id (exhaustive over CAMERA_MOVE_IDS). */
export const CAMERA_MOVES: Readonly<Record<CameraMoveId, CameraMoveDef>> = /* @__PURE__ */ Object.freeze(/* @__PURE__ */ withIds<CameraMoveId, CameraMoveDef>(CAMERA, 'camera'));

const own = (table: object, id: unknown): id is string => typeof id === 'string' && Object.prototype.hasOwnProperty.call(table, id);

/** The preset for a stored id, or undefined for one this build does not know (the clip is then inert). Own keys only. */
export const motionPresetOf = (id: unknown): MotionPresetDef | undefined => (own(MOTION_PRESETS, id) ? MOTION_PRESETS[id as MotionPresetId] : undefined);
/** The camera move for a stored id, or undefined (inert). */
export const cameraMoveOf = (id: unknown): CameraMoveDef | undefined => (own(CAMERA_MOVES, id) ? CAMERA_MOVES[id as CameraMoveId] : undefined);
/** True for a clip preset this build plays (camera moves: doc.ts isKnownCameraMove, or cameraMoveOf). */
export const isKnownMotionPreset = (id: unknown): id is MotionPresetId => !!motionPresetOf(id);

/** The parameter schema of a clip preset (PE-SERVER validates stored params against it), or undefined. */
export const presetParamSchema = (id: unknown): PresetParamSchema | undefined => motionPresetOf(id)?.params;
/** The parameter schema of a camera move, or undefined. */
export const cameraParamSchema = (id: unknown): PresetParamSchema | undefined => cameraMoveOf(id)?.params;

/** The defaults of a schema. */
export const presetDefaults = (schema: PresetParamSchema): PresetParams => Object.fromEntries(Object.entries(schema).map(([k, spec]) => [k, spec.default]));

/**
 * Stored params made playable for a schema (the draw-time clamp; the load path keeps any finite value): only the first
 * MOTION_LIMITS.paramsPerClip entries are read; a number is clamped to its range (rounded when the schema says int), an
 * enum or boolean of the wrong kind, a text longer than MOTION_LIMITS.paramTextChars and anything missing take the
 * default; keys the schema does not name are ignored.
 */
export const resolvePresetParams = (schema: PresetParamSchema, raw?: unknown): PresetParams => {
  const out = presetDefaults(schema);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const [key, value] of Object.entries(raw as Record<string, unknown>).slice(0, MOTION_LIMITS.paramsPerClip)) {
    if (!own(schema, key)) continue;
    const spec = schema[key];
    if (spec.kind === 'number') {
      if (typeof value !== 'number' || !Number.isFinite(value)) continue;
      const v = Math.min(spec.max, Math.max(spec.min, value));
      out[key] = spec.int ? Math.round(v) : v;
    } else if (spec.kind === 'enum') {
      if (typeof value === 'string' && value.length <= MOTION_LIMITS.paramTextChars && spec.values.includes(value)) out[key] = value;
    } else if (typeof value === 'boolean') out[key] = value;
  }
  return out;
};

/** Why one stored parameter is refused (PE-SERVER words it calmly). */
export interface PresetParamIssue {
  key: string;
  reason: 'unknown' | 'type' | 'range' | 'value' | 'count';
}

/**
 * Every problem with stored params for a schema, empty when they are fine: more than MOTION_LIMITS.paramsPerClip
 * entries ('count'), a key the schema does not name ('unknown'), the wrong kind of value ('type'), a number outside its
 * range or not whole where the schema says int ('range'), an enum value it does not list ('value').
 */
export const presetParamIssues = (schema: PresetParamSchema, raw?: unknown): PresetParamIssue[] => {
  if (raw === undefined || raw === null) return [];
  if (typeof raw !== 'object' || Array.isArray(raw)) return [{ key: '', reason: 'type' }];
  const entries = Object.entries(raw as Record<string, unknown>);
  const issues: PresetParamIssue[] = entries.length > MOTION_LIMITS.paramsPerClip ? [{ key: '', reason: 'count' }] : [];
  for (const [key, value] of entries) {
    if (!own(schema, key)) {
      issues.push({ key, reason: 'unknown' });
      continue;
    }
    const spec = schema[key];
    if (spec.kind === 'number') {
      if (typeof value !== 'number' || !Number.isFinite(value)) issues.push({ key, reason: 'type' });
      else if (value < spec.min || value > spec.max || (spec.int && !Number.isInteger(value))) issues.push({ key, reason: 'range' });
    } else if (spec.kind === 'enum') {
      if (typeof value !== 'string') issues.push({ key, reason: 'type' });
      else if (value.length > MOTION_LIMITS.paramTextChars || !spec.values.includes(value)) issues.push({ key, reason: 'value' });
    } else if (typeof value !== 'boolean') issues.push({ key, reason: 'type' });
  }
  return issues;
};

/** Flashes one cycle of a preset makes with these stored params (0 for an unknown preset: it never plays). */
export const presetFlashesPerCycle = (id: unknown, params?: unknown): number => {
  const def = motionPresetOf(id);
  return def ? def.flashes(resolvePresetParams(def.params, params)) : 0;
};

/**
 * Flashes in a run of opacity values: pairs of opposing changes each at least `delta` (WCAG 2.3.1 general flash).
 * `periodic` closes the run back to its first value (a loop).
 */
export const countFlashes = (values: readonly number[], periodic = false, delta = FLASH_OPACITY_DELTA): number => {
  const seq = periodic && values.length ? [...values, values[0]] : [...values];
  if (seq.length < 2) return 0;
  let swings = 0;
  let dir = 0;
  let hi = seq[0];
  let lo = seq[0];
  let extreme = seq[0];
  for (const v of seq) {
    if (dir === 0) {
      hi = Math.max(hi, v);
      lo = Math.min(lo, v);
      if (hi - v >= delta) {
        dir = -1;
        extreme = v;
        swings = 1;
      } else if (v - lo >= delta) {
        dir = 1;
        extreme = v;
        swings = 1;
      }
    } else if (dir > 0) {
      if (v > extreme) extreme = v;
      else if (extreme - v >= delta) {
        dir = -1;
        extreme = v;
        swings += 1;
      }
    } else if (v < extreme) extreme = v;
    else if (v - extreme >= delta) {
      dir = 1;
      extreme = v;
      swings += 1;
    }
  }
  return Math.floor(swings / 2);
};

/** Every preset id with its group, for pickers and the server registry (MOTION_PRESET_IDS order, then camera moves). */
export const PRESET_REGISTRY: readonly { id: string; role: PresetDef['role'] }[] = /* @__PURE__ */ (() => [
  ...MOTION_PRESET_IDS.map((id) => ({ id, role: MOTION_PRESETS[id].role })),
  ...CAMERA_MOVE_IDS.map((id) => ({ id, role: 'camera' as const }))
])();

// ── Clips: one stored clip made playable (the draw-time clamp) and its curve ─────────────────────────────────────
//
// The load normalizer (doc.ts normalizeMotionClip) keeps any finite stored value; the write bounds marked "WRITE, LEAD
// TO CONFIRM" in limits.ts are applied here, at draw time, by every player (and by PE-SERVER's sanitizer on write):
// the offset, duration and repeat, at most MOTION_LIMITS.keysPerClip keys with each channel in its range, the preset's
// params in its schema. Keyframes override the preset channel by channel: a channel any key sets follows the keys, the
// others follow the preset.

/** A stored clip ready to play. */
export interface PlayableClip {
  clip: MotionClip;
  def: MotionPresetDef;
  params: PresetParams;
  ease: EaseFn;
  /** The clip's offset from its anchor (ms, MOTION_LIMITS.atMsMin..atMsMax). */
  offsetMs: number;
  /** One play (ms, MOTION_LIMITS.durMin..durMax). */
  durMs: number;
  /** Extra plays of an emphasis (0..MOTION_LIMITS.repeatMax). Always 0 for an entrance or an exit, which play once
   *  (a repeat would snap the object from shown back to hidden: a flash); a loop cycles for as long as the page shows. */
  repeat: number;
  /** Keys, t-sorted, each channel clamped to its write bound. */
  keys: MotionKey[];
  /** The clip's own seed (from its id, mixed with the caller's). */
  seed: number;
}

const finiteOr = (v: unknown, fallback: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);
const within = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));
const L = MOTION_LIMITS;

/** Each channel inside its write bound (offsets ±keyOffsetMax, scales 0..keyScaleMax, turns ±keyRotateMax, 0..1). */
export const clampChannels = (c: PresetChannels): PresetChannels => ({
  dx: within(finiteOr(c.dx, 0), -L.keyOffsetMax, L.keyOffsetMax),
  dy: within(finiteOr(c.dy, 0), -L.keyOffsetMax, L.keyOffsetMax),
  s: within(finiteOr(c.s, 1), 0, L.keyScaleMax),
  sy: within(finiteOr(c.sy, 1), 0, L.keyScaleMax),
  r: within(finiteOr(c.r, 0), -L.keyRotateMax, L.keyRotateMax),
  o: within(finiteOr(c.o, 1), 0, 1),
  reveal: within(finiteOr(c.reveal, 1), 0, 1)
});

/** A stored key made playable: t in 0..1 and each channel it sets inside its write bound; undefined when t is unusable. */
export const clampMotionKey = (raw: unknown): MotionKey | undefined => {
  if (!raw || typeof raw !== 'object') return undefined;
  const k = raw as Record<string, unknown>;
  if (typeof k.t !== 'number' || !Number.isFinite(k.t)) return undefined;
  const out: MotionKey = { t: within(k.t, 0, 1) };
  const set = (name: 'x' | 'y' | 's' | 'r' | 'o', lo: number, hi: number) => {
    const v = k[name];
    if (typeof v === 'number' && Number.isFinite(v)) out[name] = within(v, lo, hi);
  };
  set('x', -L.keyOffsetMax, L.keyOffsetMax);
  set('y', -L.keyOffsetMax, L.keyOffsetMax);
  set('s', 0, L.keyScaleMax);
  set('r', -L.keyRotateMax, L.keyRotateMax);
  set('o', 0, 1);
  return out;
};

/**
 * A stored clip made playable, or undefined when this build cannot play it (inert, kept as stored): an unknown preset or
 * ease, or no usable id. `seed` mixes into the clip's own seed (seedOf(id)).
 */
export const playableClip = (clip: MotionClip, seed = 0): PlayableClip | undefined => {
  if (!clip || typeof clip !== 'object' || typeof clip.id !== 'string') return undefined;
  const def = motionPresetOf(clip.preset);
  if (!def) return undefined;
  if (clip.ease !== undefined && clip.ease !== null && !isKnownEase(clip.ease)) return undefined;
  const ease = easeOf(clip.ease ?? def.ease)!;
  const keys = (Array.isArray(clip.keys) ? clip.keys : [])
    .slice(0, L.keysPerClip)
    .map(clampMotionKey)
    .filter((k): k is MotionKey => !!k)
    .map((k, i) => ({ k, i }))
    .sort((a, b) => a.k.t - b.k.t || a.i - b.i)
    .map(({ k }) => k);
  return {
    clip,
    def,
    params: resolvePresetParams(def.params, clip.params),
    ease,
    offsetMs: Math.round(within(finiteOr(clip.at?.ms, 0), L.atMsMin, L.atMsMax)),
    durMs: Math.round(within(finiteOr(clip.dur, def.dur), L.durMin, L.durMax)),
    repeat: def.role === 'enter' || def.role === 'exit' ? 0 : Math.round(within(finiteOr(clip.repeat, 0), 0, L.repeatMax)),
    keys,
    seed: (seedOf(clip.id) ^ (seed | 0)) | 0
  };
};

const KEY_CHANNELS = [
  ['x', 'dx'],
  ['y', 'dy'],
  ['s', 's'],
  ['r', 'r'],
  ['o', 'o']
] as const;

/** One channel through the keys that set it, at phase p (0..1 of a play), the clip's ease shaping each segment. */
const keyedAt = (keys: readonly MotionKey[], name: 'x' | 'y' | 's' | 'r' | 'o', p: number, ease: EaseFn): number | undefined => {
  let prev: MotionKey | undefined;
  for (const k of keys) {
    if (k[name] === undefined) continue;
    if (p <= k.t) {
      if (!prev || k.t <= prev.t) return k[name];
      return prev[name]! + (k[name]! - prev[name]!) * ease((p - prev.t) / (k.t - prev.t));
    }
    prev = k;
  }
  return prev?.[name];
};

/** True when a clip's keys set its opacity (the keyed curve then decides its flashes). */
export const keysSetOpacity = (pc: Pick<PlayableClip, 'keys'>): boolean => pc.keys.some((k) => k.o !== undefined);

/**
 * The flash guard's hold on one instant's channels: fully opaque, fully revealed, and neither axis squeezed under
 * FLASH_HIDDEN_SCALE, so visibilityOf reads 1 whatever the clip does. Offsets, turns and scaling above that still play.
 */
const holdVisible = (c: PresetChannels): void => {
  c.o = 1;
  c.reveal = 1;
  if (!(c.s >= FLASH_HIDDEN_SCALE)) c.s = FLASH_HIDDEN_SCALE;
  if (!(c.s * c.sy >= FLASH_HIDDEN_SCALE)) c.sy = FLASH_HIDDEN_SCALE / c.s;
};

/**
 * A playable clip's channels at phase p (0..1 of one play): the preset through the clip's ease (a flashing preset keeps
 * its own rhythm), then every channel a key sets taken from the keys, each inside its write bound. `holdOpacity` is
 * the flash guard (sample.ts): the clip keeps the object visible as drawn (opaque, revealed, never squeezed out of
 * sight; holdVisible), so a clip that would flash too often never does; its movement still plays.
 */
export const clipCurveAt = (pc: PlayableClip, p: number, ctx: PresetContext, holdOpacity = false): PresetChannels => {
  const phase = within(finiteOr(p, 0), 0, 1);
  const u = pc.def.fixedEase ? phase : pc.ease(phase);
  const c = { ...pc.def.at(u, pc.params, pc.seed, ctx) };
  if (pc.keys.length) {
    for (const [name, channel] of KEY_CHANNELS) {
      const v = keyedAt(pc.keys, name, phase, pc.ease);
      if (v !== undefined) c[channel] = v;
    }
  }
  if (holdOpacity) holdVisible(c);
  return clampChannels(c);
};
