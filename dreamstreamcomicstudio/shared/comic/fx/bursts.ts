// Burst effects (master plan §2.6 "Effects": bursts 8, PE-FX): spiky and puffy bursts, sunburst rays, a layered
// explosion and shock rings. Pure; registered by fx/generators.ts, never imported by the registry. Parameters arrive
// clamped (fxParamsOf); every draw fills shapes in the isotropic frame (draw.ts), at most 400 segments.

import type { FxNode } from './types.js';
import { cornersBetween, dirOf, edgePt, fillPath, FxPath, fxFrame, fxRng, inFrame, pBool, pNum, pStr, TAU, type FxParams, type Pt } from './draw.js';

const BURST_SALT = 0x3c6ef372;
const SUN_SALT = 0x1b873593;
const BOOM_SALT = 0x6a09e667;
const RING_SALT = 0x243f6a88;

interface Spike {
  /** Angle (radians, 0 = right, growing clockwise on screen). */
  t: number;
  /** Radius as a fraction of the shape's semi-axes. */
  r: number;
}

/** A star outline: `points` tips (r ≈ 1) and valleys (r ≈ inner), varied by `jitter`. First tip at the top. */
const spikes = (rand: () => number, points: number, inner: number, jitter: number): Spike[] => {
  const out: Spike[] = [];
  const step = Math.PI / points;
  for (let k = 0; k < points * 2; k += 1) {
    const tip = k % 2 === 0;
    const t = -Math.PI / 2 + k * step + (rand() - 0.5) * step * 0.7 * jitter;
    const r = tip ? 1 - jitter * 0.28 * rand() : inner * (1 - jitter * 0.3 * (rand() - 0.5));
    out.push({ t, r: Math.min(1, r) });
  }
  return out;
};

/** The spike polygon on an ellipse centred at c with semi-axes (rx, ry), pushed out radially by `grow` (iso units). */
const spikePoints = (s: readonly Spike[], c: Pt, rx: number, ry: number, grow = 0): Pt[] =>
  s.map(({ t, r }) => {
    const [dx, dy] = dirOf(t);
    const x = dx * rx * r;
    const y = dy * ry * r;
    const len = Math.hypot(x, y) || 1;
    return [c[0] + x + (x / len) * grow, c[1] + y + (y / len) * grow] as Pt;
  });

/** A puffy (scalloped) outline: one quadratic bump per tip, valley to valley; the bump reaches the tip. */
const puffy = (path: FxPath, pts: readonly Pt[], reverse = false): void => {
  const valleys = pts.filter((_, i) => i % 2 === 1);
  const tips = pts.filter((_, i) => i % 2 === 0);
  const n = valleys.length;
  if (n < 3) return;
  // Bump k runs from valley k-1 to valley k over tip k (tips[k] lies between them).
  const seg = (k: number): [Pt, Pt, Pt] => {
    const v0 = valleys[(k - 1 + n) % n];
    const v1 = valleys[k];
    const tip = tips[k];
    return [v0, [2 * tip[0] - (v0[0] + v1[0]) / 2, 2 * tip[1] - (v0[1] + v1[1]) / 2], v1];
  };
  if (!reverse) {
    path.m(valleys[n - 1]);
    for (let k = 0; k < n; k += 1) {
      const [, c, v1] = seg(k);
      path.q(c, v1);
    }
  } else {
    path.m(valleys[n - 1]);
    for (let k = n - 1; k >= 0; k -= 1) {
      const [v0, c] = seg(k);
      path.q(c, v0);
    }
  }
  path.z();
};

const outlineAndFill = (pts: Pt[], outer: Pt[], round: boolean, A: number, fill: string, ink: string): FxNode[] => {
  const nodes: FxNode[] = [];
  if (outer.length) {
    // The outline is a ring (outer contour, then the fill contour wound the other way), so a layer's opacity never
    // shows the ink through the fill.
    const ring = new FxPath(A);
    if (round) {
      puffy(ring, outer);
      puffy(ring, pts, true);
    } else {
      ring.poly(outer);
      ring.poly([...pts].reverse());
    }
    nodes.push(...fillPath(ring, ink));
  }
  const body = new FxPath(A);
  if (round) puffy(body, pts);
  else body.poly(pts);
  nodes.push(...fillPath(body, fill));
  return nodes;
};

/** burst@1: a spiky (or puffy) burst filling the box, with an optional ink outline. */
export const drawBurst = (p: FxParams, seed: number, aspect: number): FxNode[] => {
  const { A, S } = fxFrame(aspect);
  const rand = fxRng(seed, BURST_SALT);
  const round = pBool(p, 'round');
  const ow = pNum(p, 'outlineW') * S;
  const c: Pt = [A / 2, 0.5];
  // Puffy bumps bulge to the tip, so their tips sit a little in; the outline grows outward from the body.
  const fit = round ? 0.96 : 1;
  const rx = Math.max(0.01, A / 2 - ow) * fit;
  const ry = Math.max(0.01, 0.5 - ow) * fit;
  const s = spikes(rand, pNum(p, 'points'), pNum(p, 'inner'), pNum(p, 'jitter'));
  const body = spikePoints(s, c, rx, ry);
  const outer = ow > 0 ? spikePoints(s, c, rx, ry, ow) : [];
  return outlineAndFill(body, outer, round, A, pStr(p, 'fill'), pStr(p, 'outline'));
};

/** sunburst@1: alternating rays from a centre out to the box edge (the corners included), around an open core. */
export const drawSunburst = (p: FxParams, seed: number, aspect: number): FxNode[] => {
  const { A, S } = fxFrame(aspect);
  const rand = fxRng(seed, SUN_SALT);
  const rays = pNum(p, 'rays');
  const F: Pt = [pNum(p, 'cx') * A, pNum(p, 'cy')];
  const core = (pNum(p, 'core') * S) / 2;
  const turn = rand() * (TAU / rays);
  const path = new FxPath(A);
  for (let i = 0; i < rays; i += 1) {
    const a0 = turn + (TAU * i) / rays;
    const a1 = a0 + Math.PI / rays;
    const [c0, s0] = dirOf(a0);
    const [c1, s1] = dirOf(a1);
    // The open core is kept inside the box too (a centre near an edge).
    const pts: Pt[] = [inFrame([F[0] + c0 * core, F[1] + s0 * core], A), edgePt(F, a0, A), ...cornersBetween(F, a0, a1, A), edgePt(F, a1, A)];
    if (core > 0) pts.push(inFrame([F[0] + c1 * core, F[1] + s1 * core], A));
    path.poly(pts);
  }
  return fillPath(path, pStr(p, 'color'), pNum(p, 'opacity'));
};

/** explosion@1: an inked outer burst, a mid burst and a hot core, with debris shards flying out. */
export const drawExplosion = (p: FxParams, seed: number, aspect: number): FxNode[] => {
  const { A, S } = fxFrame(aspect);
  const rand = fxRng(seed, BOOM_SALT);
  const points = pNum(p, 'points');
  const jitter = pNum(p, 'jitter');
  const debris = pNum(p, 'debris');
  const c: Pt = [A / 2, 0.5];
  const ow = 0.022 * S;
  // Debris flies in the outer ring of the box, so the bursts keep to its inner 78 %.
  const room = debris > 0 ? 0.78 : 1;
  const rx = (A / 2 - ow) * room;
  const ry = (0.5 - ow) * room;
  const outer = spikes(rand, points, 0.62, jitter);
  const mid = spikes(rand, points, 0.6, jitter);
  const core = spikes(rand, Math.max(6, Math.round(points * 0.75)), 0.58, jitter);
  const ink = new FxPath(A).poly(spikePoints(outer, c, rx, ry, ow));
  const outerPath = new FxPath(A).poly(spikePoints(outer, c, rx, ry));
  const midPath = new FxPath(A).poly(spikePoints(mid, c, rx * 0.66, ry * 0.66));
  const corePath = new FxPath(A).poly(spikePoints(core, c, rx * 0.36, ry * 0.36));
  const shards = new FxPath(A);
  for (let i = 0; i < debris; i += 1) {
    const a = (TAU * (i + rand() * 0.8)) / debris;
    const [dx, dy] = dirOf(a);
    // Between the burst's edge (78 %) and the box edge: a shard reaches 1.6 × size ≤ 0.056 S past its centre.
    const t = 0.8 + 0.08 * rand();
    const at: Pt = [c[0] + dx * (A / 2) * t, c[1] + dy * 0.5 * t];
    const size = S * (0.015 + 0.02 * rand());
    const spin = rand() * TAU;
    const tri: Pt[] = [0, 1, 2].map((k) => {
      const [kx, ky] = dirOf(spin + (k * TAU) / 3 + (k === 0 ? 0 : 0.4 * (rand() - 0.5)));
      const r = k === 0 ? size * 1.6 : size;
      return [at[0] + kx * r, at[1] + ky * r] as Pt;
    });
    shards.poly(tri);
  }
  return [
    ...fillPath(ink, pStr(p, 'outline')),
    ...fillPath(outerPath, pStr(p, 'outer')),
    ...fillPath(midPath, pStr(p, 'mid')),
    ...fillPath(corePath, pStr(p, 'core')),
    ...fillPath(shards, pStr(p, 'outline'))
  ];
};

/** shock-rings@1: concentric (slightly wobbling) rings spreading from an impact point, fitted to the box. */
export const drawShockRings = (p: FxParams, seed: number, aspect: number): FxNode[] => {
  const { A, S } = fxFrame(aspect);
  const rand = fxRng(seed, RING_SALT);
  const rings = pNum(p, 'rings');
  const wobble = pNum(p, 'wobble');
  const reach = pNum(p, 'reach');
  const w = pNum(p, 'weight') * S;
  const F: Pt = [pNum(p, 'cx') * A, pNum(p, 'cy')];
  // The smooth curve stays inside its control points, which the wobble pushes out by at most 8 %.
  const fit = 1 / (1 + 0.08 * wobble);
  const rxMax = Math.min(F[0], A - F[0]) * fit;
  const ryMax = Math.min(F[1], 1 - F[1]) * fit;
  const VERTS = 12;
  const path = new FxPath(A);
  for (let k = 1; k <= rings; k += 1) {
    const t = (reach * k) / rings;
    const rx = rxMax * t;
    const ry = ryMax * t;
    const turn = rand() * TAU;
    const wob = Array.from({ length: VERTS }, () => 1 + 0.16 * wobble * (rand() - 0.5));
    const ring = (dr: number): Pt[] =>
      wob.map((f, i) => {
        const [dx, dy] = dirOf(turn + (TAU * i) / VERTS);
        return [F[0] + dx * Math.max(0, rx * f - dr), F[1] + dy * Math.max(0, ry * f - dr)] as Pt;
      });
    path.smooth(ring(0));
    if (Math.min(rx, ry) > w * 1.5) path.smooth(ring(w).reverse());
  }
  return fillPath(path, pStr(p, 'color'));
};
