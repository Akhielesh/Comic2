// Line effects (master plan §2.6 "Effects": lines 6, PE-FX): speed lines (linear, radial, curved) and focus lines.
// Pure; the registry never imports this file (fx/generators.ts registers the draws). Every draw reads parameters that
// fxParamsOf already clamped to the generator's schema (fx/registry.ts), works in the isotropic frame (seed.ts) and fills
// shapes only: tapered spindles, wedges and ribbons, at most 400 segments.
//
// Also home of the procedural library's motion-line geometry (speedLines, focusLines), moved here unchanged from
// components/comicstudio/library/procedural/textures.ts, which re-exports it.

import type { FxNode } from './types.js';
import {
  chordIn,
  clampNum,
  cornersBetween,
  dirOf,
  edgePt,
  fillPath,
  FxPath,
  fxFrame,
  fxRng,
  inFrame,
  pBool,
  pNum,
  pStr,
  r2,
  rayToEdge,
  rng,
  seedOf,
  TAU,
  type FxParams,
  type Pt
} from './seed.js';

// ── Library geometry (moved from library/procedural/textures.ts; byte-identical) ──────────────────────────────────

/** One straight speed line in a w×h frame (React SVG strokes it). */
export interface SpeedLine {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  w: number;
}

/**
 * Radial speed lines toward a focus point inside a w×h frame: they start at the frame edge and
 * stop short of the focus, leaving a clear centre (manga action, impact panels).
 */
export function speedLines(seed: number | string, cx: number, cy: number, o: { count?: number; w?: number; h?: number; inner?: number } = {}): SpeedLine[] {
  const rand = rng(seedOf(seed));
  const W = o.w ?? 100;
  const H = o.h ?? 100;
  const count = Math.round(clampNum(o.count ?? 28, 4, 96));
  const reach = Math.hypot(W, H);
  const inner = clampNum(o.inner ?? 0.32, 0.05, 0.9);
  const out: SpeedLine[] = [];
  for (let i = 0; i < count; i += 1) {
    const a = (i / count) * Math.PI * 2 + rand() * ((Math.PI * 2) / count) * 0.8;
    const start = reach * (inner + rand() * 0.18);
    out.push({
      x1: r2(cx + Math.cos(a) * reach),
      y1: r2(cy + Math.sin(a) * reach),
      x2: r2(cx + Math.cos(a) * start),
      y2: r2(cy + Math.sin(a) * start),
      w: r2(0.35 + rand() * 1.1)
    });
  }
  return out;
}

/** Wedge-shaped focus lines as one closed path (filled ink), centred in a w×h frame. */
export function focusLines(seed: number | string, o: { count?: number; w?: number; h?: number; inner?: number } = {}): string {
  const rand = rng(seedOf(seed) ^ 0x5bd1e995);
  const W = o.w ?? 100;
  const H = o.h ?? 100;
  const cx = W / 2;
  const cy = H / 2;
  const count = Math.round(clampNum(o.count ?? 36, 6, 120));
  const reach = Math.hypot(W, H);
  const inner = clampNum(o.inner ?? 0.36, 0.05, 0.9) * Math.min(W, H);
  let d = '';
  for (let i = 0; i < count; i += 1) {
    const a = (i / count) * Math.PI * 2 + rand() * 0.05;
    const spread = 0.012 + rand() * 0.022;
    const tip = inner * (0.9 + rand() * 0.35);
    d += `M${r2(cx + Math.cos(a) * tip)} ${r2(cy + Math.sin(a) * tip)}L${r2(cx + Math.cos(a - spread) * reach)} ${r2(cy + Math.sin(a - spread) * reach)}L${r2(cx + Math.cos(a + spread) * reach)} ${r2(cy + Math.sin(a + spread) * reach)}Z`;
  }
  return d;
}

// ── speed-lines@1 ────────────────────────────────────────────────────────────────────────────────────────────────

const SPEED_SALT = 0x51ed27a1;
const FOCUS_SALT = 0x7f4a7c15;

/** A straight ribbon from a to b, `w` thick (4 segments). */
const ribbon = (path: FxPath, a: Pt, b: Pt, w: number): void => {
  const len = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
  const nx = (-(b[1] - a[1]) / len) * (w / 2);
  const ny = ((b[0] - a[0]) / len) * (w / 2);
  path.poly([
    [a[0] + nx, a[1] + ny],
    [b[0] + nx, b[1] + ny],
    [b[0] - nx, b[1] - ny],
    [a[0] - nx, a[1] - ny]
  ]);
};

/** A ribbon from a to b bent through its middle by `bulge` along the normal, `w` thick (4 segments). */
const bentRibbon = (path: FxPath, a: Pt, b: Pt, w: number, bulge: number): void => {
  const len = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
  const nx = -(b[1] - a[1]) / len;
  const ny = (b[0] - a[0]) / len;
  const hw = w / 2;
  const mx = (a[0] + b[0]) / 2 + nx * bulge * 2;
  const my = (a[1] + b[1]) / 2 + ny * bulge * 2;
  path
    .m([a[0] + nx * hw, a[1] + ny * hw])
    .q([mx + nx * hw, my + ny * hw], [b[0] + nx * hw, b[1] + ny * hw])
    .l([b[0] - nx * hw, b[1] - ny * hw])
    .q([mx - nx * hw, my - ny * hw], [a[0] - nx * hw, a[1] - ny * hw])
    .z();
};

/** Parallel (linear) or bent (curved) speed lines streaming along `angle`, each kept inside the box. */
const parallelLines = (p: FxParams, seed: number, A: number, S: number, curved: boolean, path: FxPath): void => {
  const rand = fxRng(seed, SPEED_SALT);
  const count = pNum(p, 'count');
  const jitter = pNum(p, 'jitter');
  const length = pNum(p, 'length');
  const taper = pBool(p, 'taper');
  const bend = curved ? pNum(p, 'bend') : 0;
  const th = (pNum(p, 'angle') * Math.PI) / 180;
  const u: Pt = [Math.cos(th), Math.sin(th)];
  const n: Pt = [-u[1], u[0]];
  const across = [0, A * n[0], n[1], A * n[0] + n[1]];
  const lo = Math.min(...across);
  const hi = Math.max(...across);
  const w0 = pNum(p, 'weight') * S;
  for (let i = 0; i < count; i += 1) {
    const o = lo + ((hi - lo) * (i + 0.5 + (rand() - 0.5) * jitter)) / count;
    const w = w0 * (0.35 + 0.65 * rand());
    const r1 = rand();
    const r2v = rand();
    const chord = chordIn([n[0] * o, n[1] * o], u, A, w / 2);
    if (!chord) continue;
    const span = chord[1] - chord[0];
    const L = span * length * (1 - jitter * 0.6 * r1);
    if (L < w) continue;
    const s = chord[0] + (span - L) * r2v;
    const a: Pt = [n[0] * o + u[0] * s, n[1] * o + u[1] * s];
    const b: Pt = [a[0] + u[0] * L, a[1] + u[1] * L];
    let bulge = 0;
    if (curved && bend !== 0) {
      // The centre line bends by bend·L/4 at its middle (4t(1−t) of that along it), never past the box edge: the room
      // is measured at points along the chord, where the box edge may come closer than at the middle.
      const side = bend > 0 ? Math.atan2(n[1], n[0]) : Math.atan2(-n[1], -n[0]);
      let room = Math.abs(bend) * L * 0.25;
      for (const t of [0.15, 0.3, 0.5, 0.7, 0.85]) {
        const at: Pt = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
        room = Math.min(room, Math.max(0, rayToEdge(at, side, A) - w) / (4 * t * (1 - t)));
      }
      bulge = Math.sign(bend) * room;
    }
    if (taper) path.lens(a, b, w, bulge);
    else if (bulge) bentRibbon(path, a, b, w, bulge);
    else ribbon(path, a, b, w);
  }
};

/** Radial speed lines: from the box edge toward a focus, stopping short of a clear centre. */
const radialLines = (p: FxParams, seed: number, A: number, S: number, path: FxPath): void => {
  const rand = fxRng(seed, SPEED_SALT ^ 0x2f);
  const count = pNum(p, 'count');
  const jitter = pNum(p, 'jitter');
  const length = pNum(p, 'length');
  const taper = pBool(p, 'taper');
  const F: Pt = [pNum(p, 'cx') * A, pNum(p, 'cy')];
  const clear = pNum(p, 'clear') * 0.5 * Math.hypot(A, 1);
  const w0 = pNum(p, 'weight') * S;
  for (let i = 0; i < count; i += 1) {
    const a = (TAU * (i + rand() * 0.8 * jitter)) / count;
    const w = w0 * (0.4 + 0.6 * rand());
    const r1 = rand();
    const R = rayToEdge(F, a, A);
    const inner = Math.max(clear, R * (1 - length * (1 - jitter * 0.5 * r1)));
    if (R - inner < w * 2) continue;
    const [dx, dy] = dirOf(a);
    const tip: Pt = [F[0] + dx * inner, F[1] + dy * inner];
    const base: Pt = [F[0] + dx * R, F[1] + dy * R];
    const nx = (-dy * w) / 2;
    const ny = (dx * w) / 2;
    if (taper) {
      path.poly([tip, inFrame([base[0] + nx, base[1] + ny], A), inFrame([base[0] - nx, base[1] - ny], A)]);
    } else {
      path.poly([
        inFrame([tip[0] + nx, tip[1] + ny], A),
        inFrame([base[0] + nx, base[1] + ny], A),
        inFrame([base[0] - nx, base[1] - ny], A),
        inFrame([tip[0] - nx, tip[1] - ny], A)
      ]);
    }
  }
};

/** speed-lines@1: lines of motion. `mode` linear (along `angle`), radial (toward cx, cy) or curved (bent by `bend`). */
export const drawSpeedLines = (p: FxParams, seed: number, aspect: number): FxNode[] => {
  const { A, S } = fxFrame(aspect);
  const path = new FxPath(A);
  const mode = pStr(p, 'mode');
  if (mode === 'radial') radialLines(p, seed, A, S, path);
  else parallelLines(p, seed, A, S, mode === 'curved', path);
  return fillPath(path, pStr(p, 'color'));
};

// ── focus-lines@1 ────────────────────────────────────────────────────────────────────────────────────────────────

/** focus-lines@1: filled wedges from the box edge toward a focus, around a clear centre (round, or the box's oval). */
export const drawFocusLines = (p: FxParams, seed: number, aspect: number): FxNode[] => {
  const { A, S } = fxFrame(aspect);
  const rand = fxRng(seed, FOCUS_SALT);
  const path = new FxPath(A);
  const count = pNum(p, 'count');
  const jitter = pNum(p, 'jitter');
  const spread = pNum(p, 'spread');
  const clear = pNum(p, 'clear');
  const oval = pBool(p, 'oval');
  const F: Pt = [pNum(p, 'cx') * A, pNum(p, 'cy')];
  const clearAt = (a: number): number => {
    if (!oval) return (clear * S) / 2;
    const [c, s] = dirOf(a);
    return clear / Math.hypot(c / (A / 2), s / 0.5);
  };
  for (let i = 0; i < count; i += 1) {
    const a = (TAU * (i + (rand() - 0.5) * 0.6 * jitter)) / count;
    const half = spread * (0.6 + 0.8 * rand());
    const tipAt = clearAt(a) * (1 + jitter * 0.45 * rand());
    if (rayToEdge(F, a, A) <= tipAt) continue;
    const [dx, dy] = dirOf(a);
    const tip: Pt = [F[0] + dx * tipAt, F[1] + dy * tipAt];
    path.poly([tip, edgePt(F, a - half, A), ...cornersBetween(F, a - half, a + half, A), edgePt(F, a + half, A)]);
  }
  return fillPath(path, pStr(p, 'color'));
};
