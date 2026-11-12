// Effect generators' shared helpers (master plan §2.6, §2.8; PE-FX): the seeded random stream, stable number formatting,
// the drawing frame and a path builder that counts segments. Pure and dependency-free (types only), so the
// generators (lines, bursts, emanata, atmosphere, borders) and the procedural library shim
// (components/comicstudio/library/procedural/textures.ts) share one implementation. The registry never imports this
// file: generator code stays out of the shared barrel (`comic.fx`).
//
// The frame. A generator draws in its layer's 0..1 box (FxNode). It works in an ISOTROPIC frame of width A (the box
// aspect, width ÷ height as shown) and height 1, then divides x by A on output. A renderer draws the nodes under one
// transform that maps the 0..1 box onto the layer box (x · width, y · height), so circles stay round and every mark keeps
// its weight on any aspect. Generators therefore fill shapes and never stroke (a stroke would stretch with the box), and
// round marks are cubic paths, not `circle` nodes.

import type { FxNode, FxParamValue } from './types.js';

// ── Seeds and rounding (moved from library/procedural/textures.ts; byte-identical) ───────────────────────────────

/** Deterministic 32-bit seed from a string (FNV-1a). */
export const seedOf = (input: string | number): number => {
  const s = String(input);
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
};

/** mulberry32: a tiny seeded PRNG in [0, 1). */
export const rng = (seed: number): (() => number) => {
  let a = seed >>> 0 || 0x9e3779b9;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

/** Round for compact, stable SVG numbers (no NaN ever reaches markup). */
export const r2 = (n: number): number => (Number.isFinite(n) ? Math.round(n * 100) / 100 : 0);

/** `n` within [lo, hi]; `lo` when it is not a finite number. */
export const clampNum = (n: number, lo: number, hi: number): number => (Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : lo);

/** Four decimals: an effect's coordinates in its 0..1 box (0.1 px on a 1000 px layer). */
export const r4 = (n: number): number => (Number.isFinite(n) ? Math.round(n * 10000) / 10000 || 0 : 0);

/** A generator's random stream: the stored int32 seed mixed with the generator's own salt. */
export const fxRng = (seed: number, salt: number): (() => number) => rng(((seed | 0) ^ salt) >>> 0);

// ── Parameters (already checked by fxParamsOf: present and of the schema's kind) ─────────────────────────────────

export type FxParams = Readonly<Record<string, FxParamValue>>;
export const pNum = (p: FxParams, key: string): number => (typeof p[key] === 'number' ? (p[key] as number) : 0);
export const pStr = (p: FxParams, key: string): string => (typeof p[key] === 'string' ? (p[key] as string) : '');
export const pBool = (p: FxParams, key: string): boolean => p[key] === true;

/** A generator's drawing: pure; `p` holds every parameter of its schema, clamped (fxParamsOf). */
export type FxDrawFn = (p: FxParams, seed: number, aspect: number) => FxNode[];

// ── The frame ─────────────────────────────────────────────────────────────────────────────────────────────────────

export interface FxFrame {
  /** Width of the isotropic frame (the box aspect); its height is 1. */
  A: number;
  /** The shorter side, min(A, 1): sizes and weights are fractions of it. */
  S: number;
}
export const fxFrame = (aspect: number): FxFrame => {
  const A = Number.isFinite(aspect) && aspect > 0 ? aspect : 1;
  return { A, S: Math.min(A, 1) };
};

export type Pt = readonly [number, number];
export const TAU = Math.PI * 2;
export const dirOf = (angle: number): Pt => [Math.cos(angle), Math.sin(angle)];
export const lerpPt = (a: Pt, b: Pt, t: number): Pt => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
export const midPt = (a: Pt, b: Pt): Pt => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
/** `p` turned by `angle` (radians) about `c`. */
export const turn = (p: Pt, c: Pt, angle: number): Pt => {
  const cs = Math.cos(angle);
  const sn = Math.sin(angle);
  const x = p[0] - c[0];
  const y = p[1] - c[1];
  return [c[0] + x * cs - y * sn, c[1] + x * sn + y * cs];
};
/** `p` kept inside the frame (0..A × 0..1). */
export const inFrame = (p: Pt, A: number): Pt => [clampNum(p[0], 0, A), clampNum(p[1], 0, 1)];

/** Distance from `o` (inside the frame) along `angle` to the frame's edge. */
export const rayToEdge = (o: Pt, angle: number, A: number): number => {
  const [dx, dy] = dirOf(angle);
  let t = Infinity;
  if (dx > 1e-12) t = Math.min(t, (A - o[0]) / dx);
  else if (dx < -1e-12) t = Math.min(t, -o[0] / dx);
  if (dy > 1e-12) t = Math.min(t, (1 - o[1]) / dy);
  else if (dy < -1e-12) t = Math.min(t, -o[1] / dy);
  return Number.isFinite(t) ? Math.max(0, t) : 0;
};

/**
 * The part [t0, t1] of the line p + t·u inside the frame inset by `inset` on every side (Liang–Barsky), or null when the
 * line misses it.
 */
export const chordIn = (p: Pt, u: Pt, A: number, inset: number): [number, number] | null => {
  let t0 = -Infinity;
  let t1 = Infinity;
  const clip = (q: number, d: number, lo: number, hi: number): boolean => {
    if (Math.abs(d) < 1e-12) return q >= lo && q <= hi;
    let a = (lo - q) / d;
    let b = (hi - q) / d;
    if (a > b) [a, b] = [b, a];
    t0 = Math.max(t0, a);
    t1 = Math.min(t1, b);
    return t0 <= t1;
  };
  if (!clip(p[0], u[0], inset, A - inset) || !clip(p[1], u[1], inset, 1 - inset)) return null;
  return Number.isFinite(t0) && Number.isFinite(t1) && t1 > t0 ? [t0, t1] : null;
};

/** The frame's corners seen from `o` strictly between angles a1 and a2 (a2 > a1, going the way angles grow), in order. */
export const cornersBetween = (o: Pt, a1: number, a2: number, A: number): Pt[] => {
  const span = a2 - a1;
  const out: { rel: number; p: Pt }[] = [];
  for (const c of [
    [0, 0],
    [A, 0],
    [A, 1],
    [0, 1]
  ] as Pt[]) {
    let rel = Math.atan2(c[1] - o[1], c[0] - o[0]) - a1;
    rel = ((rel % TAU) + TAU) % TAU;
    if (rel > 1e-9 && rel < span - 1e-9) out.push({ rel, p: c });
  }
  return out.sort((a, b) => a.rel - b.rel).map((c) => c.p);
};

/** A point on the frame's edge seen from `o` along `angle`. */
export const edgePt = (o: Pt, angle: number, A: number): Pt => {
  const d = rayToEdge(o, angle, A);
  const [dx, dy] = dirOf(angle);
  return inFrame([o[0] + dx * d, o[1] + dy * d], A);
};

/** Smooth periodic noise in [0, 1]: `knots` random values joined by cosine easing, read at `t` (any real; period 1). */
export const loopNoise = (rand: () => number, knots: number): ((t: number) => number) => {
  const n = Math.max(2, Math.round(knots));
  const v = Array.from({ length: n }, () => rand());
  return (t: number) => {
    const x = (((t % 1) + 1) % 1) * n;
    const i = Math.floor(x) % n;
    const f = x - Math.floor(x);
    const e = (1 - Math.cos(f * Math.PI)) / 2;
    return v[i] * (1 - e) + v[(i + 1) % n] * e;
  };
};

// ── The path builder ─────────────────────────────────────────────────────────────────────────────────────────────

/** Fill-only path data in the 0..1 box, from points in the isotropic frame. Counts its drawing segments (L Q C Z). */
export class FxPath {
  private d = '';
  /** Drawing commands so far (every L, Q, C and Z; M moves only). */
  segments = 0;
  constructor(private readonly A: number) {}
  private xy(p: Pt): string {
    return `${r4(p[0] / this.A)} ${r4(p[1])}`;
  }
  m(p: Pt): this {
    this.d += `M${this.xy(p)}`;
    return this;
  }
  l(p: Pt): this {
    this.d += `L${this.xy(p)}`;
    this.segments += 1;
    return this;
  }
  q(c: Pt, p: Pt): this {
    this.d += `Q${this.xy(c)} ${this.xy(p)}`;
    this.segments += 1;
    return this;
  }
  c(c1: Pt, c2: Pt, p: Pt): this {
    this.d += `C${this.xy(c1)} ${this.xy(c2)} ${this.xy(p)}`;
    this.segments += 1;
    return this;
  }
  z(): this {
    this.d += 'Z';
    this.segments += 1;
    return this;
  }
  /** A closed polygon. */
  poly(points: readonly Pt[]): this {
    if (points.length < 3) return this;
    this.m(points[0]);
    for (let i = 1; i < points.length; i += 1) this.l(points[i]);
    return this.z();
  }
  /** A closed smooth curve through the midpoints of `points` (quadratic B-spline): inside their hull. */
  smooth(points: readonly Pt[]): this {
    const n = points.length;
    if (n < 3) return this;
    this.m(midPt(points[n - 1], points[0]));
    for (let i = 0; i < n; i += 1) this.q(points[i], midPt(points[i], points[(i + 1) % n]));
    return this.z();
  }
  /**
   * A puffy cloud outline: `bumps` round scallops around c, each a circular arc from valley to valley through its tip
   * at radius r (× `swell[k]` when given); valleys at r·(1 − depth). One cubic per scallop.
   */
  cloud(c: Pt, r: number, bumps: number, depth: number, turn = 0, swell?: readonly number[]): this {
    const n = Math.max(3, Math.round(bumps));
    const valley = (k: number): Pt => {
      const a = turn + (TAU * k) / n;
      const rr = r * (1 - depth) * (swell ? Math.min(swell[k % n], swell[(k + n - 1) % n]) : 1);
      return [c[0] + Math.cos(a) * rr, c[1] + Math.sin(a) * rr];
    };
    this.m(valley(0));
    for (let k = 0; k < n; k += 1) {
      const a = turn + (TAU * (k + 0.5)) / n;
      const rr = r * (swell ? swell[k % n] : 1);
      this.arcThrough(valley(k), [c[0] + Math.cos(a) * rr, c[1] + Math.sin(a) * rr], valley(k + 1));
    }
    return this.z();
  }
  /** The circular arc from the current point a, through m, to b, as one cubic (a straight line when they align). */
  arcThrough(a: Pt, m: Pt, b: Pt): this {
    const d = 2 * (a[0] * (m[1] - b[1]) + m[0] * (b[1] - a[1]) + b[0] * (a[1] - m[1]));
    if (Math.abs(d) < 1e-12) return this.l(b);
    const sq = (p: Pt) => p[0] * p[0] + p[1] * p[1];
    const o: Pt = [
      (sq(a) * (m[1] - b[1]) + sq(m) * (b[1] - a[1]) + sq(b) * (a[1] - m[1])) / d,
      (sq(a) * (b[0] - m[0]) + sq(m) * (a[0] - b[0]) + sq(b) * (m[0] - a[0])) / d
    ];
    const R = Math.hypot(a[0] - o[0], a[1] - o[1]);
    const ang = (p: Pt) => Math.atan2(p[1] - o[1], p[0] - o[0]);
    const norm = (x: number) => ((x % TAU) + TAU) % TAU;
    // Sweep from a to b the way that passes m.
    const toB = norm(ang(b) - ang(a));
    const sweep = norm(ang(m) - ang(a)) < toB ? toB : toB - TAU;
    const k = (4 / 3) * Math.tan(sweep / 4) * R;
    const a0 = ang(a);
    const a1 = a0 + sweep;
    return this.c([a[0] - Math.sin(a0) * k, a[1] + Math.cos(a0) * k], [b[0] + Math.sin(a1) * k, b[1] - Math.cos(a1) * k], b);
  }
  /** An ellipse (four cubic arcs); `reverse` winds it the other way (a hole inside an opposite-wound shape). */
  ellipse(c: Pt, rx: number, ry: number, reverse = false): this {
    const k = 0.5522847498;
    const [x, y] = c;
    const R: Pt = [x + rx, y];
    const B: Pt = [x, y + ry];
    const L: Pt = [x - rx, y];
    const T: Pt = [x, y - ry];
    this.m(R);
    if (!reverse) {
      this.c([x + rx, y + ry * k], [x + rx * k, y + ry], B);
      this.c([x - rx * k, y + ry], [x - rx, y + ry * k], L);
      this.c([x - rx, y - ry * k], [x - rx * k, y - ry], T);
      this.c([x + rx * k, y - ry], [x + rx, y - ry * k], R);
    } else {
      this.c([x + rx, y - ry * k], [x + rx * k, y - ry], T);
      this.c([x - rx * k, y - ry], [x - rx, y - ry * k], L);
      this.c([x - rx, y + ry * k], [x - rx * k, y + ry], B);
      this.c([x + rx * k, y + ry], [x + rx, y + ry * k], R);
    }
    return this.z();
  }
  /** A spindle from a to b, `w` thick at its middle, tapering to both ends; `bulge` bends its centre line sideways. */
  lens(a: Pt, b: Pt, w: number, bulge = 0): this {
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
    const nx = -(b[1] - a[1]) / len;
    const ny = (b[0] - a[0]) / len;
    const m = midPt(a, b);
    // A quadratic's middle sits half-way to its control: controls at ±w from the bent centre give w at the middle.
    const h = bulge * 2;
    this.m(a);
    this.q([m[0] + nx * (h + w), m[1] + ny * (h + w)], b);
    this.q([m[0] + nx * (h - w), m[1] + ny * (h - w)], a);
    return this.z();
  }
  get path(): string {
    return this.d;
  }
}

// ── Nodes ────────────────────────────────────────────────────────────────────────────────────────────────────────

/** A filled path node (no node when the path is empty); opacity is written only when below 1. */
export const fillPath = (path: FxPath, fill: string, opacity = 1): FxNode[] => {
  if (!path.path) return [];
  return opacity < 1 ? [{ tag: 'path', d: path.path, fill, opacity: r4(opacity) }] : [{ tag: 'path', d: path.path, fill }];
};
