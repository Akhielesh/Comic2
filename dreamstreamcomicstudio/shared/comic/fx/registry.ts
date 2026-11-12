// The effect generator registry (master plan §2.3, §2.6, §2.8, §2.12 PE-FX). Metadata only: every registered
// generator version with its name, group and parameter schema (FX_GENERATORS), the named presets a creator starts
// from (FX_PRESETS), and renderFx, which dispatches to the drawings that fx/generators.ts registers. Registered versions
// are never removed or changed: a stored effect must draw the same forever, so a new look is a new version.
//
// Rules (PE-0 fixer note 10; collisions B-7):
// - this file imports types, names.ts and limits.ts only, never a generator module (lines, bursts, emanata, atmosphere,
//   borders, seed, generators): the shared barrel (`comic.fx`) re-exports it, so the server sanitizer, the editor and
//   every reader see the schemas without generator code (a source scan holds it);
// - each FxGenerator.name is FX_NAMES[gen] (fx/names.ts), which the editor scene and History read;
// - renderFx keeps PE-0's synchronous signature. Until fx/generators.ts is imported (the Pro editor and the compose
//   path import it), no drawing is registered and renderFx returns [] for every effect, as before PE-FX.
//
// S2 holds 14 generators (lines 2, bursts 4, emanata 1, atmosphere 6, borders 1) and 42 named presets (lines 6,
// bursts 8, emanata 12, atmosphere 6, borders 10). Tones and paper are PE-TONES's (S3).

import { FX_LIMITS } from '../limits.js';
import { FX_NAMES } from './names.js';
import type { FxDrawContext, FxGenerator, FxGroup, FxNode, FxParamSpec, FxParamValue, LayerFx } from './types.js';

// ── Schemas ──────────────────────────────────────────────────────────────────────────────────────────────────────

const num = (min: number, max: number, def: number, label: string, step?: number): FxParamSpec => ({ kind: 'number', min, max, default: def, label, ...(step ? { step } : {}) });
const int = (min: number, max: number, def: number, label: string): FxParamSpec => ({ kind: 'number', min, max, default: def, int: true, step: 1, label });
const choice = (values: readonly string[], def: string, label: string): FxParamSpec => ({ kind: 'enum', values, default: def, label });
const colour = (def: string, label: string): FxParamSpec => ({ kind: 'color', default: def, label });
const flag = (def: boolean, label: string): FxParamSpec => ({ kind: 'bool', default: def, label });

const INK = '#111111';
const centre = { cx: num(0, 1, 0.5, 'Centre across', 0.01), cy: num(0, 1, 0.5, 'Centre down', 0.01) };

/** emanata@1 symbols, in picker order. */
export const FX_EMANATA_SYMBOLS = ['sweat', 'shake', 'surprise', 'anger', 'heart', 'star', 'steam', 'sleep', 'note', 'gloom', 'exclaim', 'spiral'] as const;
/** emanata@1 arrangements. */
export const FX_EMANATA_ARRANGEMENTS = ['arc', 'ring', 'rise', 'row', 'sides', 'scatter'] as const;
/** frame-border@1 styles, in picker order (rough … film are also PanelFrameBorder styles). */
export const FX_BORDER_STYLES = ['rough', 'brush', 'double', 'dashed', 'dotted', 'wavy', 'jagged', 'film', 'torn', 'scallop'] as const;

const gen = (id: string, v: number, group: FxGroup, params: Record<string, FxParamSpec>): FxGenerator =>
  Object.freeze({ gen: id, v, name: FX_NAMES[id] ?? id, group, params: Object.freeze(params) });

/** Every registered generator version. A version is never removed or changed once shipped. */
export const FX_GENERATORS: readonly FxGenerator[] = Object.freeze([
  // ── lines ──
  gen('speed-lines', 1, 'lines', {
    mode: choice(['linear', 'radial', 'curved'], 'linear', 'Kind'),
    count: int(4, 96, 40, 'Lines'),
    angle: num(-180, 180, 0, 'Angle', 1),
    length: num(0.1, 1, 0.7, 'Length', 0.01),
    weight: num(0.002, 0.06, 0.012, 'Weight', 0.001),
    taper: flag(true, 'Tapered'),
    ...centre,
    clear: num(0, 0.9, 0.3, 'Clear middle', 0.01),
    bend: num(-1, 1, 0.4, 'Bend', 0.01),
    jitter: num(0, 1, 0.5, 'Variation', 0.01),
    color: colour(INK, 'Colour')
  }),
  gen('focus-lines', 1, 'lines', {
    count: int(12, 120, 64, 'Lines'),
    clear: num(0.05, 0.9, 0.4, 'Clear middle', 0.01),
    spread: num(0.004, 0.06, 0.018, 'Wedge width', 0.001),
    jitter: num(0, 1, 0.5, 'Variation', 0.01),
    ...centre,
    oval: flag(true, 'Follow the box shape'),
    color: colour(INK, 'Colour')
  }),
  // ── bursts ──
  gen('burst', 1, 'bursts', {
    points: int(6, 48, 16, 'Points'),
    inner: num(0.3, 0.95, 0.62, 'Depth', 0.01),
    jitter: num(0, 1, 0.3, 'Variation', 0.01),
    round: flag(false, 'Puffy'),
    fill: colour('#ffd23f', 'Fill'),
    outline: colour(INK, 'Outline'),
    outlineW: num(0, 0.08, 0.03, 'Outline width', 0.001)
  }),
  gen('sunburst', 1, 'bursts', {
    rays: int(8, 64, 24, 'Rays'),
    ...centre,
    core: num(0, 0.5, 0.06, 'Open middle', 0.01),
    color: colour('#ffe066', 'Colour'),
    opacity: num(0.05, 1, 0.6, 'Opacity', 0.01)
  }),
  gen('explosion', 1, 'bursts', {
    points: int(8, 32, 14, 'Points'),
    jitter: num(0, 1, 0.55, 'Variation', 0.01),
    debris: int(0, 16, 8, 'Debris'),
    outer: colour('#e63946', 'Outer'),
    mid: colour('#ff9f1c', 'Middle'),
    core: colour('#fff3b0', 'Core'),
    outline: colour(INK, 'Outline')
  }),
  gen('shock-rings', 1, 'bursts', {
    rings: int(1, 8, 3, 'Rings'),
    cx: num(0.2, 0.8, 0.5, 'Centre across', 0.01),
    cy: num(0.2, 0.8, 0.5, 'Centre down', 0.01),
    reach: num(0.2, 1, 0.9, 'Size', 0.01),
    weight: num(0.005, 0.08, 0.025, 'Weight', 0.001),
    wobble: num(0, 1, 0.3, 'Wobble', 0.01),
    color: colour(INK, 'Colour')
  }),
  // ── emanata ──
  gen('emanata', 1, 'emanata', {
    symbol: choice(FX_EMANATA_SYMBOLS, 'sweat', 'Mark'),
    count: int(1, 12, 3, 'How many'),
    size: num(0.05, 0.6, 0.22, 'Size', 0.01),
    arrange: choice(FX_EMANATA_ARRANGEMENTS, 'arc', 'Arrangement'),
    spread: num(0, 1, 0.6, 'Spread', 0.01),
    tilt: num(-45, 45, 0, 'Tilt', 1),
    jitter: num(0, 1, 0.25, 'Variation', 0.01),
    outline: flag(true, 'Ink outline'),
    color: colour(INK, 'Ink'),
    fill: colour('#ffffff', 'Fill')
  }),
  // ── atmosphere ──
  gen('rain', 1, 'atmosphere', {
    count: int(10, 130, 70, 'Drops'),
    slant: num(-1, 1, -0.25, 'Slant', 0.01),
    length: num(0.02, 0.3, 0.1, 'Length', 0.01),
    weight: num(0.001, 0.02, 0.004, 'Weight', 0.001),
    color: colour('#5b7c99', 'Colour'),
    opacity: num(0.05, 1, 0.6, 'Opacity', 0.01)
  }),
  gen('snow', 1, 'atmosphere', {
    count: int(10, 80, 50, 'Flakes'),
    minR: num(0.002, 0.03, 0.004, 'Smallest', 0.001),
    maxR: num(0.004, 0.05, 0.012, 'Largest', 0.001),
    color: colour('#ffffff', 'Colour'),
    opacity: num(0.05, 1, 0.9, 'Opacity', 0.01)
  }),
  gen('petals', 1, 'atmosphere', {
    count: int(4, 80, 24, 'Petals'),
    size: num(0.01, 0.08, 0.03, 'Size', 0.001),
    color: colour('#f6a8c8', 'Colour'),
    shade: colour('#e58fb1', 'Shade')
  }),
  gen('bokeh', 1, 'atmosphere', {
    count: int(1, 40, 14, 'Lights'),
    minR: num(0.02, 0.2, 0.04, 'Smallest', 0.005),
    maxR: num(0.03, 0.3, 0.11, 'Largest', 0.005),
    soft: flag(true, 'Soft edge'),
    color: colour('#ffe8a3', 'Colour'),
    opacity: num(0.05, 1, 0.5, 'Opacity', 0.01)
  }),
  gen('sparkle', 1, 'atmosphere', {
    count: int(1, 40, 18, 'Sparkles'),
    size: num(0.01, 0.12, 0.04, 'Size', 0.001),
    glow: flag(true, 'Glow'),
    color: colour('#fff6c2', 'Colour')
  }),
  gen('smoke', 1, 'atmosphere', {
    count: int(1, 20, 7, 'Puffs'),
    size: num(0.08, 0.5, 0.24, 'Size', 0.01),
    rise: flag(true, 'Rising column'),
    color: colour('#b8bcc2', 'Colour'),
    shade: colour('#8a9097', 'Shade'),
    opacity: num(0.05, 1, 0.7, 'Opacity', 0.01)
  }),
  // ── borders ──
  gen('frame-border', 1, 'borders', {
    style: choice(FX_BORDER_STYLES, 'rough', 'Style'),
    weight: num(0.004, 0.08, 0.02, 'Weight', 0.001),
    inset: num(0, 0.2, 0.02, 'Inset', 0.005),
    roughness: num(0, 1, 0.5, 'Roughness', 0.01),
    step: int(4, 24, 14, 'Marks along a side'),
    color: colour(INK, 'Colour')
  })
]);

/** The registered generator for `gen@v`, or undefined (unknown: the effect is kept but draws nothing). */
export const fxGeneratorOf = (gen: string, v: number): FxGenerator | undefined => FX_GENERATORS.find((g) => g.gen === gen && g.v === v);

/** The newest registered version of `gen` (what a new effect is created with), or undefined. */
export const latestFxGenerator = (gen: string): FxGenerator | undefined =>
  FX_GENERATORS.filter((g) => g.gen === gen).reduce<FxGenerator | undefined>((best, g) => (!best || g.v > best.v ? g : best), undefined);

/** Every schema default of a generator (what an effect holds when a parameter is absent). */
export const fxDefaultsOf = (generator: Pick<FxGenerator, 'params'>): Record<string, FxParamValue> =>
  Object.fromEntries(Object.entries(generator.params).map(([k, spec]) => [k, spec.default]));

// ── Named presets ────────────────────────────────────────────────────────────────────────────────────────────────

/** A named starting point (§2.6 "Effects … named presets"): a generator version, a seed and full parameters. */
export interface FxPreset {
  /** Unique, lower-case words joined by '-'. */
  id: string;
  /** Plain words for the picker: "Radial speed lines". */
  name: string;
  group: FxGroup;
  gen: string;
  v: number;
  /** The seed a new effect from this preset starts with (Shuffle picks another). */
  seed: number;
  /** Every parameter of the generator's schema, each within it. */
  params: Readonly<Record<string, FxParamValue>>;
  /** Search words for the picker. */
  keywords: readonly string[];
}

const preset = (id: string, name: string, gen: string, seed: number, keywords: readonly string[], params: Record<string, FxParamValue> = {}): FxPreset => {
  const g = latestFxGenerator(gen);
  if (!g) throw new Error(`fx preset ${id}: no generator ${gen}`);
  return Object.freeze({ id, name, group: g.group, gen, v: g.v, seed, params: Object.freeze({ ...fxDefaultsOf(g), ...params }), keywords: Object.freeze([...keywords]) });
};

/** The 42 S2 presets: lines 6, bursts 8, emanata 12, atmosphere 6, borders 10. */
export const FX_PRESETS: readonly FxPreset[] = Object.freeze([
  // lines 6
  preset('speed-lines', 'Speed lines', 'speed-lines', 101, ['speed', 'motion', 'fast', 'action', 'whoosh']),
  preset('falling-lines', 'Falling lines', 'speed-lines', 102, ['fall', 'drop', 'vertical', 'plunge'], { angle: 90, count: 32, length: 0.8 }),
  preset('radial-speed-lines', 'Radial speed lines', 'speed-lines', 103, ['radial', 'zoom', 'rush', 'charge'], { mode: 'radial', count: 56, length: 0.55, clear: 0.32, weight: 0.014 }),
  preset('curved-speed-lines', 'Curved speed lines', 'speed-lines', 104, ['curve', 'swing', 'swoosh', 'spin'], { mode: 'curved', count: 28, bend: 0.6, length: 0.75, weight: 0.014 }),
  preset('focus-lines', 'Focus lines', 'focus-lines', 105, ['focus', 'shock', 'reveal', 'manga', 'concentration']),
  preset('impact-focus', 'Impact focus', 'focus-lines', 106, ['impact', 'hit', 'dramatic', 'intense'], { count: 110, clear: 0.26, spread: 0.012, jitter: 0.8 }),
  // bursts 8
  preset('star-burst', 'Star burst', 'burst', 201, ['star', 'pow', 'bang', 'pop'], { points: 14, inner: 0.58, jitter: 0.2 }),
  preset('shout-burst', 'Shout burst', 'burst', 202, ['shout', 'yell', 'loud', 'scream'], { points: 28, inner: 0.74, jitter: 0.55, fill: '#ffffff' }),
  preset('puff-burst', 'Puff burst', 'burst', 203, ['puff', 'cloud', 'poof', 'soft'], { round: true, points: 11, inner: 0.82, jitter: 0.25, fill: '#ffffff' }),
  preset('spiky-burst', 'Spiky burst', 'burst', 204, ['spiky', 'crash', 'danger', 'alarm'], { points: 36, inner: 0.45, jitter: 0.65, fill: '#e63946' }),
  preset('sunburst', 'Sunburst', 'sunburst', 205, ['sun', 'rays', 'glory', 'shine']),
  preset('ray-flash', 'Ray flash', 'sunburst', 206, ['flash', 'rays', 'dramatic', 'light'], { rays: 48, core: 0.16, color: '#ffffff', opacity: 0.55 }),
  preset('explosion', 'Explosion', 'explosion', 207, ['explosion', 'boom', 'blast', 'kaboom']),
  preset('shock-rings', 'Shock rings', 'shock-rings', 208, ['shock', 'ripple', 'impact', 'wave'], { rings: 3, wobble: 0.35 }),
  // emanata 12
  preset('sweat-drops', 'Sweat drops', 'emanata', 301, ['sweat', 'nervous', 'worry', 'drop'], { symbol: 'sweat', count: 3, arrange: 'arc', fill: '#8ecae6' }),
  preset('shake-marks', 'Shake marks', 'emanata', 302, ['shake', 'tremble', 'vibrate', 'shiver'], { symbol: 'shake', count: 2, arrange: 'sides', size: 0.3 }),
  preset('surprise-lines', 'Surprise lines', 'emanata', 303, ['surprise', 'shock', 'startle', 'alert'], { symbol: 'surprise', count: 7, arrange: 'arc', size: 0.16, jitter: 0.15 }),
  preset('anger-mark', 'Anger mark', 'emanata', 304, ['anger', 'angry', 'mad', 'vein'], { symbol: 'anger', count: 1, arrange: 'scatter', size: 0.4, color: '#d62828' }),
  preset('love-hearts', 'Love hearts', 'emanata', 305, ['love', 'heart', 'crush', 'romance'], { symbol: 'heart', count: 5, arrange: 'rise', fill: '#e63946', size: 0.2 }),
  preset('dizzy-stars', 'Dizzy stars', 'emanata', 306, ['dizzy', 'stars', 'knocked', 'daze'], { symbol: 'star', count: 5, arrange: 'ring', spread: 0.75, fill: '#ffd23f', size: 0.18 }),
  preset('steam-puffs', 'Steam puffs', 'emanata', 307, ['steam', 'fume', 'furious', 'huff'], { symbol: 'steam', count: 3, arrange: 'rise', spread: 0.3, size: 0.24 }),
  preset('sleep-z', 'Sleep Zs', 'emanata', 308, ['sleep', 'zzz', 'snore', 'tired'], { symbol: 'sleep', count: 3, arrange: 'rise', spread: 0.5, size: 0.22 }),
  preset('music-notes', 'Music notes', 'emanata', 309, ['music', 'notes', 'sing', 'hum'], { symbol: 'note', count: 3, arrange: 'rise', spread: 0.6, size: 0.24 }),
  preset('gloom-lines', 'Gloom lines', 'emanata', 310, ['gloom', 'sad', 'depressed', 'despair'], { symbol: 'gloom', count: 7, arrange: 'row', spread: 0.8, size: 0.4, jitter: 0.35 }),
  preset('exclamation', 'Exclamation', 'emanata', 311, ['exclamation', 'alert', 'notice', 'idea'], { symbol: 'exclaim', count: 1, arrange: 'scatter', size: 0.5, jitter: 0 }),
  preset('dizzy-swirl', 'Dizzy swirl', 'emanata', 312, ['swirl', 'spiral', 'confused', 'dizzy'], { symbol: 'spiral', count: 1, arrange: 'scatter', size: 0.5, jitter: 0 }),
  // atmosphere 6
  preset('rain', 'Rain', 'rain', 401, ['rain', 'storm', 'wet', 'weather']),
  preset('snow', 'Snow', 'snow', 402, ['snow', 'winter', 'cold', 'flakes']),
  preset('falling-petals', 'Falling petals', 'petals', 403, ['petals', 'sakura', 'blossom', 'spring', 'romance']),
  preset('bokeh-lights', 'Bokeh lights', 'bokeh', 404, ['bokeh', 'lights', 'glow', 'night', 'dreamy']),
  preset('sparkles', 'Sparkles', 'sparkle', 405, ['sparkle', 'shine', 'magic', 'glitter']),
  preset('smoke', 'Smoke', 'smoke', 406, ['smoke', 'fire', 'dust', 'fog']),
  // borders 10
  preset('rough-border', 'Rough ink border', 'frame-border', 501, ['rough', 'ink', 'sketch', 'hand-drawn'], { style: 'rough' }),
  preset('brush-border', 'Brush border', 'frame-border', 502, ['brush', 'paint', 'sumi', 'stroke'], { style: 'brush', weight: 0.028, roughness: 0.7 }),
  preset('double-rule', 'Double rule', 'frame-border', 503, ['double', 'classic', 'formal', 'line'], { style: 'double', weight: 0.024 }),
  preset('dashed-border', 'Dashed border', 'frame-border', 504, ['dashed', 'cut', 'coupon', 'line'], { style: 'dashed', weight: 0.012, step: 16 }),
  preset('dotted-border', 'Dotted border', 'frame-border', 505, ['dotted', 'dots', 'playful', 'line'], { style: 'dotted', weight: 0.014, step: 18 }),
  preset('wavy-border', 'Wavy border', 'frame-border', 506, ['wavy', 'dream', 'memory', 'flashback'], { style: 'wavy', weight: 0.012, step: 10, roughness: 0.4 }),
  preset('jagged-border', 'Jagged border', 'frame-border', 507, ['jagged', 'shock', 'tension', 'spiky'], { style: 'jagged', weight: 0.014, step: 18, roughness: 0.6 }),
  preset('film-strip', 'Film strip', 'frame-border', 508, ['film', 'movie', 'cinema', 'flashback'], { style: 'film', weight: 0.024, inset: 0, step: 12 }),
  preset('torn-paper', 'Torn paper', 'frame-border', 509, ['torn', 'paper', 'rip', 'collage'], { style: 'torn', weight: 0.03, inset: 0, roughness: 0.7, color: '#f4ecd8' }),
  preset('scalloped-border', 'Scalloped border', 'frame-border', 510, ['scallop', 'cloud', 'thought', 'dream'], { style: 'scallop', weight: 0.02, inset: 0, step: 12 })
]);

/** The preset with this id, or undefined. */
export const fxPresetOf = (id: string): FxPreset | undefined => FX_PRESETS.find((p) => p.id === id);

/** A new effect from a preset (its own copy of the parameters; `seed` overrides the preset's), or undefined. */
export const fxFromPreset = (id: string, seed?: number): LayerFx | undefined => {
  const p = fxPresetOf(id);
  if (!p) return undefined;
  const s = typeof seed === 'number' && Number.isInteger(seed) && seed >= -2147483648 && seed <= 2147483647 ? seed : p.seed;
  return { gen: p.gen, v: p.v, seed: s, params: { ...p.params } };
};

// ── Drawing: dispatch, memo and budget ───────────────────────────────────────────────────────────────────────────

/**
 * A registered drawing: pure and deterministic. It reads its parameters through fxParamsOf (fx/index.ts), so a stored
 * value outside the schema still draws inside it, and returns paths, circles and rects in the layer's 0..1 box.
 */
export type FxDraw = (fx: LayerFx, ctx: FxDrawContext) => FxNode[];

const DRAWS = new Map<string, FxDraw>();
const keyOf = (gen: string, v: number) => `${gen}@${v}`;

/** Results by (gen, v, seed, aspect, params); the oldest is dropped past MEMO_MAX. */
const MEMO = new Map<string, FxNode[]>();
const MEMO_MAX = 256;

/**
 * Registers the drawing of a registered `gen@v` (fx/generators.ts does it for every S2 generator; a test may register
 * a fake). Throws for a version FX_GENERATORS does not hold, so the server's schemas and the drawings never drift.
 */
export const registerFxDraw = (gen: string, v: number, draw: FxDraw): void => {
  if (!fxGeneratorOf(gen, v)) throw new Error(`fx: ${keyOf(gen, v)} is not a registered generator`);
  DRAWS.set(keyOf(gen, v), draw);
  MEMO.clear();
};

/** True when this build can draw `gen@v` now (registered and its drawing loaded). */
export const fxCanDraw = (fx: Pick<LayerFx, 'gen' | 'v'> | undefined): boolean => !!fx && typeof fx.gen === 'string' && typeof fx.v === 'number' && DRAWS.has(keyOf(fx.gen, fx.v));

/** The aspect a drawing uses: finite and positive (else 1), within 0.05..20, to 3 decimals (so the memo is exact). */
export const fxAspectOf = (ctx: Partial<FxDrawContext> | undefined): number => {
  const a = Number(ctx?.aspect);
  if (!Number.isFinite(a) || a <= 0) return 1;
  return Math.round(Math.min(20, Math.max(0.05, a)) * 1000) / 1000;
};

/** Drawing segments of nodes: each L, H, V, Q, T, C, S, A and Z in a path; a rect or a circle counts 4. */
export const fxSegmentsOf = (nodes: readonly FxNode[]): number => {
  let n = 0;
  for (const node of nodes) n += node.tag === 'path' ? (node.d.match(/[LlHhVvQqTtCcSsAaZz]/g)?.length ?? 0) : 4;
  return n;
};

const paramsKey = (params: unknown): string => {
  if (!params || typeof params !== 'object' || Array.isArray(params)) return '';
  return JSON.stringify(
    Object.keys(params)
      .sort()
      .map((k) => [k, (params as Record<string, unknown>)[k]])
  );
};

/** Nodes within FX_LIMITS.segmentsMax (later nodes dropped whole), frozen: a memoized result is shared. */
const sealed = (nodes: FxNode[]): FxNode[] => {
  const out: FxNode[] = [];
  let used = 0;
  for (const node of Array.isArray(nodes) ? nodes : []) {
    const cost = fxSegmentsOf([node]);
    if (used + cost > FX_LIMITS.segmentsMax) break;
    used += cost;
    out.push(Object.freeze({ ...node }) as FxNode);
  }
  return Object.freeze(out) as FxNode[];
};

/**
 * What an effect draws, in its layer's 0..1 box: deterministic (the same fx and aspect give byte-identical nodes),
 * paths, circles and rects only, filled (no strokes), ≤ FX_LIMITS.segmentsMax segments. Draw the nodes under one
 * transform that maps the 0..1 box onto the layer box (x · width, y · height); the generator already used `ctx.aspect`
 * so every mark keeps its shape and weight. Returns [] when `gen@v` is unknown to this build or its drawing is not
 * loaded yet (fx/generators.ts). Memoized by (gen, v, seed, aspect, params): the result is shared and frozen.
 */
export const renderFx = (fx: LayerFx, ctx: FxDrawContext): FxNode[] => {
  if (!fx || typeof fx.gen !== 'string' || typeof fx.v !== 'number') return [];
  const draw = DRAWS.get(keyOf(fx.gen, fx.v));
  if (!draw) return [];
  const aspect = fxAspectOf(ctx);
  const seed = typeof fx.seed === 'number' && Number.isFinite(fx.seed) ? fx.seed | 0 : 0;
  let key: string | undefined;
  try {
    key = `${keyOf(fx.gen, fx.v)}|${seed}|${aspect}|${paramsKey(fx.params)}`;
  } catch {
    key = undefined;
  }
  if (key !== undefined) {
    const hit = MEMO.get(key);
    if (hit) {
      MEMO.delete(key);
      MEMO.set(key, hit);
      return hit;
    }
  }
  let nodes: FxNode[];
  try {
    nodes = sealed(draw({ gen: fx.gen, v: fx.v, seed, params: fx.params }, { aspect }));
  } catch {
    nodes = sealed([]);
  }
  if (key !== undefined) {
    MEMO.set(key, nodes);
    if (MEMO.size > MEMO_MAX) MEMO.delete(MEMO.keys().next().value as string);
  }
  return nodes;
};
