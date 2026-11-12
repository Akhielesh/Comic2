// The S2 effect generators (master plan §2.6, §2.12 PE-FX; collisions B-7): importing this module registers the
// drawing of every generator in FX_GENERATORS, so renderFx (fx/registry.ts) draws them. Only the Pro editor and the
// compose path import it (one import each); the shared barrel never does, so generator code stays out of the server,
// the editor scene, History and every bundle that does not draw effects. Until it is imported, renderFx returns [].
//
// Every registered drawing reads its parameters through fxParamsOf (fx/index.ts): a stored value out of the schema's
// range, of the wrong kind or missing draws as the clamped value or the default (PE-0 risk 2: players clamp at draw time).
//
// The named presets (FX_PRESETS) live here too, with the drawings, in the Pro editor's code (§2.6 "Delivery").

import { fxParamsOf } from './index.js';
import { fxDefaultsOf, fxGeneratorOf, latestFxGenerator, registerFxDraw, renderFx, type FxDraw } from './registry.js';
import type { FxGroup, FxParamValue, LayerFx } from './types.js';
import type { FxDrawFn } from './draw.js';
import { drawFocusLines, drawSpeedLines } from './lines.js';
import { drawBurst, drawExplosion, drawShockRings, drawSunburst } from './bursts.js';
import { drawEmanata } from './emanata.js';
import { drawBokeh, drawPetals, drawRain, drawSmoke, drawSnow, drawSparkle } from './atmosphere.js';
import { drawFrameBorder } from './borders.js';

/**
 * The pure drawings by `gen@v`. Module-private: a drawing assumes its parameters are already clamped to the schema and
 * skips the 400-segment cap and the memo, so a stored `count: 100000` would run 100 000 iterations. Everything outside
 * this file draws through renderFx (or FX_DRAW_FNS below, which wraps it).
 */
const DRAW_FNS: Readonly<Record<string, FxDrawFn>> = Object.freeze({
  'speed-lines@1': drawSpeedLines,
  'focus-lines@1': drawFocusLines,
  'burst@1': drawBurst,
  'sunburst@1': drawSunburst,
  'explosion@1': drawExplosion,
  'shock-rings@1': drawShockRings,
  'emanata@1': drawEmanata,
  'rain@1': drawRain,
  'snow@1': drawSnow,
  'petals@1': drawPetals,
  'bokeh@1': drawBokeh,
  'sparkle@1': drawSparkle,
  'smoke@1': drawSmoke,
  'frame-border@1': drawFrameBorder
});

const splitKey = (key: string): [string, number] => {
  const at = key.lastIndexOf('@');
  return [key.slice(0, at), Number(key.slice(at + 1))];
};

/**
 * Every S2 drawing by `gen@v`, safe with stored parameters: each call goes through renderFx (the schema clamp, the
 * 400-segment cap and the memo; the result is shared and frozen). Thumbnails and previews may use it or, better,
 * renderFx(fxFromPreset(id)!, { aspect }) itself; never a raw drawing.
 */
export const FX_DRAW_FNS: Readonly<Record<string, FxDrawFn>> = Object.freeze(
  Object.fromEntries(
    Object.keys(DRAW_FNS).map((key): [string, FxDrawFn] => {
      const [gen, v] = splitKey(key);
      return [key, (p, seed, aspect) => renderFx({ gen, v, seed, params: p as Record<string, FxParamValue> }, { aspect })];
    })
  )
);

/**
 * TESTS ONLY, UNCHECKED: the raw drawing of `gen@v`, with no schema clamp, no segment cap, no memo and no freezing. The
 * budget, bounds and speed tests measure the drawings themselves through it (after fxParamsOf); app code never calls
 * it (use renderFx).
 */
export const fxDrawUncheckedForTests = (key: string): FxDrawFn | undefined => DRAW_FNS[key];

/** The registered drawing of `gen@v`: the schema check, then the pure drawing. */
export const fxDrawFor = (key: string): FxDraw => {
  const [gen, v] = splitKey(key);
  const generator = fxGeneratorOf(gen, v);
  const fn = DRAW_FNS[key];
  if (!generator || !fn) throw new Error(`fx: no generator ${key}`);
  return (fx, ctx) => fn(fxParamsOf(generator, fx.params), fx.seed | 0, ctx.aspect);
};

/** Registers every S2 drawing (idempotent). Called once when this module loads. */
export const registerFxGenerators = (): void => {
  for (const key of Object.keys(DRAW_FNS)) {
    const [gen, v] = splitKey(key);
    registerFxDraw(gen, v, fxDrawFor(key));
  }
};

registerFxGenerators();

/** True once this module has run (a value to import where a bare side-effect import would read oddly). */
export const FX_GENERATORS_LOADED = true;

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

/** The 42 S2 presets: lines 6, bursts 8, emanata 12, atmosphere 6, borders 10. Each starts a new effect at the newest
 *  version of its generator. */
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
