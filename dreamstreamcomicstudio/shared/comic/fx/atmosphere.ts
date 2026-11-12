// Atmosphere effects (master plan §2.6 "Effects": atmosphere 6, PE-FX): rain, snow, falling petals, bokeh lights,
// sparkles and smoke. Pure; registered by fx/generators.ts, never imported by the registry. Parameters arrive clamped
// (fxParamsOf); every mark is filled (no strokes) in the isotropic frame (draw.ts), kept inside the box, at most 400
// segments. Pro code only: the procedural library's bokeh and rainPath live in seed.ts, so the library shim never
// loads this file.

import type { FxNode } from './types.js';
import { fillPath, FxPath, fxFrame, fxRng, pBool, pNum, pStr, TAU, turn, type FxParams, type Pt } from './draw.js';
import { clampNum } from './seed.js';

// ── Generators ───────────────────────────────────────────────────────────────────────────────────────────────────

const RAIN_SALT = 0x68e31da5;
const SNOW_SALT = 0x2c1b3c6d;
const PETAL_SALT = 0x297a2d39;
const BOKEH_SALT = 0x2545f492;
const SPARK_SALT = 0x5f356495;
const SMOKE_SALT = 0x4b4b2e1d;

/** A random point at least `m` inside the frame on every side (the middle when the frame is too small). */
const inside = (rand: () => number, A: number, m: number): Pt => {
  const x = rand();
  const y = rand();
  return [m < A / 2 ? m + x * (A - 2 * m) : A / 2, m < 0.5 ? m + y * (1 - 2 * m) : 0.5];
};

/** rain@1: slanted tapered streaks, each wholly inside the box. */
export const drawRain = (p: FxParams, seed: number, aspect: number): FxNode[] => {
  const { A, S } = fxFrame(aspect);
  const rand = fxRng(seed, RAIN_SALT);
  const count = pNum(p, 'count');
  const slant = pNum(p, 'slant');
  const w0 = pNum(p, 'weight') * S;
  const path = new FxPath(A);
  for (let i = 0; i < count; i += 1) {
    const ly = pNum(p, 'length') * (0.6 + 0.8 * rand());
    const w = w0 * (0.6 + 0.8 * rand());
    const rx = rand();
    const ryv = rand();
    const dx = slant * ly;
    const xLo = Math.max(w, -dx + w);
    const xHi = Math.min(A - w, A - dx - w);
    if (xHi <= xLo || ly >= 1) continue;
    const a: Pt = [xLo + rx * (xHi - xLo), ryv * (1 - ly)];
    path.lens(a, [a[0] + dx, a[1] + ly], w);
  }
  return fillPath(path, pStr(p, 'color'), pNum(p, 'opacity'));
};

/** snow@1: round flakes in two sizes of drift (the far ones smaller and fainter). */
export const drawSnow = (p: FxParams, seed: number, aspect: number): FxNode[] => {
  const { A, S } = fxFrame(aspect);
  const rand = fxRng(seed, SNOW_SALT);
  const count = pNum(p, 'count');
  const a = pNum(p, 'minR') * S;
  const b = pNum(p, 'maxR') * S;
  const lo = Math.min(a, b);
  const hi = Math.max(a, b);
  const near = new FxPath(A);
  const far = new FxPath(A);
  for (let i = 0; i < count; i += 1) {
    const t = rand();
    const r = lo + (hi - lo) * t * t;
    const c = inside(rand, A, r);
    (t < 0.5 ? far : near).ellipse(c, r, r);
  }
  const color = pStr(p, 'color');
  const opacity = pNum(p, 'opacity');
  return [...fillPath(far, color, opacity * 0.6), ...fillPath(near, color, opacity)];
};

/** petals@1: notched blossom petals tumbling at every angle, in two shades. */
export const drawPetals = (p: FxParams, seed: number, aspect: number): FxNode[] => {
  const { A, S } = fxFrame(aspect);
  const rand = fxRng(seed, PETAL_SALT);
  const count = pNum(p, 'count');
  const size = pNum(p, 'size') * S;
  const light = new FxPath(A);
  const dark = new FxPath(A);
  for (let i = 0; i < count; i += 1) {
    const len = size * (0.65 + 0.7 * rand());
    const half = len * 0.36;
    const spin = rand() * TAU;
    const c = inside(rand, A, len * 0.6);
    // A petal along +x from its base, centred on c: base, two lobes and a notch at the tip.
    const pt = (x: number, y: number): Pt => turn([c[0] + x - len / 2, c[1] + y], c, spin);
    (rand() < 0.35 ? dark : light)
      .m(pt(0, 0))
      .q(pt(len * 0.3, -half * 1.6), pt(len, -half * 0.55))
      .l(pt(len * 0.84, 0))
      .l(pt(len, half * 0.55))
      .q(pt(len * 0.3, half * 1.6), pt(0, 0))
      .z();
  }
  return [...fillPath(light, pStr(p, 'color')), ...fillPath(dark, pStr(p, 'shade'))];
};

/** bokeh@1: out-of-focus lights in three brightnesses; `soft` adds a faint halo around each. */
export const drawBokeh = (p: FxParams, seed: number, aspect: number): FxNode[] => {
  const { A, S } = fxFrame(aspect);
  const rand = fxRng(seed, BOKEH_SALT);
  const count = pNum(p, 'count');
  const soft = pBool(p, 'soft');
  const a = pNum(p, 'minR') * S;
  const b = pNum(p, 'maxR') * S;
  const lo = Math.min(a, b);
  const hi = Math.max(a, b);
  const TIERS = [0.5, 0.75, 1];
  const cores = TIERS.map(() => new FxPath(A));
  const halos = TIERS.map(() => new FxPath(A));
  for (let i = 0; i < count; i += 1) {
    const r = lo + (hi - lo) * rand();
    const c = inside(rand, A, r);
    const tier = Math.min(TIERS.length - 1, Math.floor(rand() * TIERS.length));
    if (soft) {
      halos[tier].ellipse(c, r, r);
      cores[tier].ellipse(c, r * 0.72, r * 0.72);
    } else cores[tier].ellipse(c, r, r);
  }
  const color = pStr(p, 'color');
  const opacity = pNum(p, 'opacity');
  const out: FxNode[] = [];
  TIERS.forEach((k, i) => {
    out.push(...fillPath(halos[i], color, opacity * k * 0.4), ...fillPath(cores[i], color, opacity * k));
  });
  return out;
};

/** sparkle@1: four-point twinkles (some small, some turned); `glow` adds a faint disc behind each. */
export const drawSparkle = (p: FxParams, seed: number, aspect: number): FxNode[] => {
  const { A, S } = fxFrame(aspect);
  const rand = fxRng(seed, SPARK_SALT);
  const count = pNum(p, 'count');
  const glow = pBool(p, 'glow');
  const size = pNum(p, 'size') * S;
  const stars = new FxPath(A);
  const discs = new FxPath(A);
  for (let i = 0; i < count; i += 1) {
    const r = (size / 2) * (0.45 + 0.55 * rand());
    const c = inside(rand, A, r);
    const spin = rand() < 0.3 ? Math.PI / 4 : 0;
    const k = r * 0.12;
    const pt = (x: number, y: number): Pt => turn([c[0] + x, c[1] + y], c, spin);
    stars
      .m(pt(0, -r))
      .q(pt(k, -k), pt(r, 0))
      .q(pt(k, k), pt(0, r))
      .q(pt(-k, k), pt(-r, 0))
      .q(pt(-k, -k), pt(0, -r))
      .z();
    if (glow) discs.ellipse(c, r * 0.45, r * 0.45);
  }
  const color = pStr(p, 'color');
  return [...fillPath(discs, color, 0.35), ...fillPath(stars, color)];
};

/** smoke@1: puffs rising in a column (or drifting), growing as they rise, each with a darker shadow. */
export const drawSmoke = (p: FxParams, seed: number, aspect: number): FxNode[] => {
  const { A, S } = fxFrame(aspect);
  const rand = fxRng(seed, SMOKE_SALT);
  const count = pNum(p, 'count');
  const rise = pBool(p, 'rise');
  const size = pNum(p, 'size') * S;
  const phase = rand() * TAU;
  const shade = new FxPath(A);
  const main = new FxPath(A);
  for (let i = 0; i < count; i += 1) {
    const t = count === 1 ? 0.5 : i / (count - 1);
    const r = (size / 2) * (rise ? 0.5 + 0.5 * t : 0.7 + 0.3 * rand());
    // The puff and its shadow (offset by 0.12 r) reach 1.12 r from the centre.
    const m = r * 1.15;
    let c: Pt;
    if (rise) {
      const x = A / 2 + Math.sin(phase + t * 3.2) * (A / 2 - m) * 0.35;
      c = [clampNum(x, Math.min(m, A / 2), Math.max(A - m, A / 2)), m < 0.5 ? 1 - m - t * (1 - 2 * m) : 0.5];
    } else c = inside(rand, A, m);
    // A cloud of seven scallops of uneven size, over its darker shadow.
    const swell = Array.from({ length: 7 }, () => 0.82 + 0.18 * rand());
    const spin = rand() * TAU;
    shade.cloud([c[0] + r * 0.08, c[1] + r * 0.08], r * 1.02, 7, 0.17, spin, swell);
    main.cloud(c, r * 0.94, 7, 0.17, spin, swell);
  }
  const opacity = pNum(p, 'opacity');
  return [...fillPath(shade, pStr(p, 'shade'), opacity), ...fillPath(main, pStr(p, 'color'), opacity)];
};
