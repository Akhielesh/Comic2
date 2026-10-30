// Vector bubble library (contract §10.2, lettering.md §5). Pure and deterministic.
//
// Every generator works in balloon-local units: (0, 0) is the text box's top-left corner and (w, h)
// its size; `inset` is the text padding inside that box. Paths use only M L C Q A Z, so the same
// string is valid for SVG <path d> AND canvas `new Path2D(d)`.
//
// The classic shapes (squircle speech, cloud, burst, caption rect, curved/straight tails, thought
// trail) are the pre-v5 balloonGeometry.ts generators byte-for-byte: the `classic` preset draws
// exactly what it always drew (shapes.test.ts parity).
//
// DRAW ORDER (identical in SVG and canvas, per z-ordered group = a balloon plus its linked chain):
//   1. stroke body, tail, extras, link necks at lineWidth = 2 × stroke ("fat stroke under")
//   2. fill the same paths ("fill over": tails and necks merge seamlessly with the body)
//   3. stroke `inner` (double borders, the explosion's inner burst, scroll rolls/curls) — whenever
//      present and borderStyle ≠ 'none'
//   4. draw the text.
// Translucent fills: draw the group into its own layer at full alpha, then composite with opacity.
// `extras` fill with EXTRA_SHADE[shape] applied to the fill colour (ribbon fishtails sit in shadow).

import type { Box, LineKind } from '../doc.js';
import type { BorderStyle, BubbleShape, TailStyle } from './style.js';

export interface Circle {
  cx: number;
  cy: number;
  r: number;
}
export interface BubbleGeometry {
  /** Closed outline (absent for 'none'). */
  body?: string;
  /** Stroked after the fill pass: double border, explosion inner burst, scroll roll outlines + curls. */
  inner?: string;
  /** Filled + stroked decorations (scroll rolls, ribbon fishtails); fill shaded by EXTRA_SHADE[shape]. */
  extras?: string[];
  /** Tail wedge / pointer / lightning polygon. */
  tail?: string;
  /** Thought trail. */
  bubbles: Circle[];
  /** Outline bbox relative to the text box (body + extras; tails and trails excluded) — placement + safe area. */
  bounds: Box;
}

export interface Pt {
  x: number;
  y: number;
}
/** Text inset inside a balloon box (local units). */
export interface TextInset {
  x: number;
  y: number;
}

// ── Numbers ──────────────────────────────────────────────────────────────────

const clampN = (n: number, lo: number, hi: number): number => (Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : lo);
const roundN = (n: number, places = 2) => {
  const f = 10 ** places;
  return Math.round(n * f) / f;
};
const fmt = (n: number) => String(roundN(n));

/** Deterministic 32-bit seed from a string (moved from balloonGeometry.ts; same output). */
export function hashSeed(input: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Small seeded PRNG (mulberry32) → [0, 1). */
const rng = (seed: number) => {
  let a = seed >>> 0 || 1;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

// ── Classic generators (verbatim from balloonGeometry.ts) ────────────────────

/**
 * Points on a superellipse filling a w×h box (exponent n: 2 = ellipse, higher = squarer).
 * `scaleX/scaleY` let the outline bleed past the text box.
 */
export const superellipsePoints = (
  w: number,
  h: number,
  opts: { n?: number; steps?: number; scaleX?: number; scaleY?: number; phase?: number } = {}
): Pt[] => {
  const n = opts.n ?? 3;
  const steps = Math.max(8, opts.steps ?? 32);
  const a = (w / 2) * (opts.scaleX ?? 1.04);
  const b = (h / 2) * (opts.scaleY ?? 1.1);
  const e = 2 / n;
  const out: Pt[] = [];
  for (let i = 0; i < steps; i += 1) {
    const t = (opts.phase ?? 0) + (2 * Math.PI * i) / steps;
    const c = Math.cos(t);
    const s = Math.sin(t);
    out.push({ x: w / 2 + a * Math.sign(c) * Math.abs(c) ** e, y: h / 2 + b * Math.sign(s) * Math.abs(s) ** e });
  }
  return out;
};

/** Smooth closed path through points (Catmull-Rom → cubic Bézier). */
export const smoothClosedPath = (points: Pt[]): string => {
  const n = points.length;
  if (n < 3) return '';
  const p = (i: number) => points[(i + n) % n];
  let d = `M${fmt(p(0).x)} ${fmt(p(0).y)}`;
  for (let i = 0; i < n; i += 1) {
    const p0 = p(i - 1);
    const p1 = p(i);
    const p2 = p(i + 1);
    const p3 = p(i + 2);
    const c1 = { x: p1.x + (p2.x - p0.x) / 6, y: p1.y + (p2.y - p0.y) / 6 };
    const c2 = { x: p2.x - (p3.x - p1.x) / 6, y: p2.y - (p3.y - p1.y) / 6 };
    d += `C${fmt(c1.x)} ${fmt(c1.y)} ${fmt(c2.x)} ${fmt(c2.y)} ${fmt(p2.x)} ${fmt(p2.y)}`;
  }
  return `${d}Z`;
};

const polygonPath = (points: Pt[]): string => (points.length < 3 ? '' : `M${points.map((pt) => `${fmt(pt.x)} ${fmt(pt.y)}`).join('L')}Z`);

/** Approximate perimeter of the ellipse inscribed in w×h (Ramanujan). */
const perimeter = (w: number, h: number) => {
  const a = w / 2;
  const b = h / 2;
  return Math.PI * (3 * (a + b) - Math.sqrt((3 * a + b) * (a + 3 * b)));
};

const defaultInset = (w: number, h: number): TextInset => ({ x: w * 0.06, y: h * 0.2 });

/**
 * Outline scale (relative to the w×h box) that keeps the text block's corners inside a
 * superellipse of exponent n with some breathing room.
 */
export const fitOutlineScale = (
  w: number,
  h: number,
  n: number,
  base: { x: number; y: number },
  inset: TextInset = defaultInset(w, h),
  fill = 0.86
): { x: number; y: number } => {
  if (w <= 0 || h <= 0) return base;
  const rx = clampN(1 - (2 * inset.x) / w, 0, 1);
  const ry = clampN(1 - (2 * inset.y) / h, 0, 1);
  const v = (rx / base.x) ** n + (ry / base.y) ** n;
  if (v <= fill) return base;
  const f = (v / fill) ** (1 / n);
  return { x: base.x * f, y: base.y * f };
};

/** Rounded balloon outline (classic speech / whisper). */
export const speechBodyPath = (w: number, h: number, inset?: TextInset): string => {
  const scale = fitOutlineScale(w, h, 3, { x: 1.04, y: 1.1 }, inset);
  return smoothClosedPath(superellipsePoints(w, h, { n: 3, steps: 32, scaleX: scale.x, scaleY: scale.y }));
};

/** Scalloped thought cloud around the text box. */
export const cloudPath = (w: number, h: number, seed = 1, inset?: TextInset): string => {
  const bump = clampN(Math.min(w, h) * 0.42, 7, 36);
  const count = Math.round(clampN(perimeter(w * 1.04, h * 1.12) / bump, 7, 18));
  const phase = rng(seed)() * ((2 * Math.PI) / count);
  const scale = fitOutlineScale(w, h, 2.6, { x: 1.02, y: 1.08 }, inset);
  const pts = superellipsePoints(w, h, { n: 2.6, steps: count, scaleX: scale.x, scaleY: scale.y, phase });
  const cx = w / 2;
  const cy = h / 2;
  let d = `M${fmt(pts[0].x)} ${fmt(pts[0].y)}`;
  for (let i = 0; i < pts.length; i += 1) {
    const a = pts[i];
    const b = pts[(i + 1) % pts.length];
    const mx = (a.x + b.x) / 2;
    const my = (a.y + b.y) / 2;
    let nx = -(b.y - a.y);
    let ny = b.x - a.x;
    const len = Math.hypot(nx, ny) || 1;
    nx /= len;
    ny /= len;
    if (nx * (mx - cx) + ny * (my - cy) < 0) {
      nx = -nx;
      ny = -ny;
    }
    const chord = Math.hypot(b.x - a.x, b.y - a.y);
    d += `Q${fmt(mx + nx * chord * 0.55)} ${fmt(my + ny * chord * 0.55)} ${fmt(b.x)} ${fmt(b.y)}`;
  }
  return `${d}Z`;
};

/** Spiky burst points for shouts (deterministic per seed): bold radial spikes of steady length. */
export const burstPoints = (w: number, h: number, seed = 1, inset?: TextInset): Pt[] => {
  const short = Math.min(w, h);
  const count = Math.round(clampN(perimeter(w, h) / clampN(short * 0.55, 10, 34), 10, 20));
  const rand = rng(seed);
  const scale = fitOutlineScale(w, h, 2.4, { x: 1.06, y: 1.18 }, inset);
  const inner = superellipsePoints(w, h, { n: 2.4, steps: count, scaleX: scale.x, scaleY: scale.y });
  const cx = w / 2;
  const cy = h / 2;
  const spike = clampN(short * 0.32, 6, 20);
  const out: Pt[] = [];
  for (let i = 0; i < count; i += 1) {
    const a = inner[i];
    const b = inner[(i + 1) % count];
    out.push(a);
    const mx = (a.x + b.x) / 2;
    const my = (a.y + b.y) / 2;
    const len = Math.hypot(mx - cx, my - cy) || 1;
    const reach = spike * (0.75 + rand() * 0.5);
    out.push({ x: mx + ((mx - cx) / len) * reach, y: my + ((my - cy) / len) * reach });
  }
  return out;
};

export const burstPath = (w: number, h: number, seed = 1, inset?: TextInset): string => polygonPath(burstPoints(w, h, seed, inset));

/** Rectangular caption box. */
export const captionPath = (w: number, h: number): string =>
  polygonPath([
    { x: 0, y: 0 },
    { x: w, y: 0 },
    { x: w, y: h },
    { x: 0, y: h }
  ]);

/** True when a balloon-local point falls inside the ellipse inscribed in the w×h box. */
export const insideBody = (w: number, h: number, pt: Pt): boolean => {
  const a = w / 2;
  const b = h / 2;
  if (a <= 0 || b <= 0) return false;
  const dx = (pt.x - a) / a;
  const dy = (pt.y - b) / b;
  return dx * dx + dy * dy <= 1;
};

/** Radius of the ellipse inscribed in w×h along a direction. */
const ellipseRadius = (w: number, h: number, theta: number) => {
  const a = w / 2;
  const b = h / 2;
  return (a * b) / Math.sqrt((b * Math.cos(theta)) ** 2 + (a * Math.sin(theta)) ** 2);
};

/**
 * Tail wedge toward the tip. Its base sits just inside the outline (0.7 × the inscribed ellipse
 * radius) so it leaves the balloon at full width; null when the tip is inside the balloon.
 * `widthScale` = the style's tailWidth (1 = classic).
 */
export const tailPath = (w: number, h: number, tip: Pt, style: 'curved' | 'straight' = 'curved', widthScale = 1): string | null => {
  if (!Number.isFinite(tip.x) || !Number.isFinite(tip.y) || insideBody(w, h, tip)) return null;
  const cx = w / 2;
  const cy = h / 2;
  const dx = tip.x - cx;
  const dy = tip.y - cy;
  const len = Math.hypot(dx, dy);
  const theta = Math.atan2(dy, dx);
  const edge = ellipseRadius(w, h, theta);
  if (len <= edge * 1.02) return null;
  const baseR = edge * 0.7;
  const base = { x: cx + Math.cos(theta) * baseR, y: cy + Math.sin(theta) * baseR };
  const nx = -Math.sin(theta);
  const ny = Math.cos(theta);
  const half = clampN(Math.min(w, h) * 0.22 + (len - edge) * 0.025, 4, 20) * widthScale;
  const b1 = { x: base.x + nx * half, y: base.y + ny * half };
  const b2 = { x: base.x - nx * half, y: base.y - ny * half };
  if (style === 'straight') return `M${fmt(b1.x)} ${fmt(b1.y)}L${fmt(tip.x)} ${fmt(tip.y)}L${fmt(b2.x)} ${fmt(b2.y)}Z`;
  const bend = (len - baseR) * 0.1;
  const c1 = { x: (b1.x + tip.x) / 2 + nx * bend, y: (b1.y + tip.y) / 2 + ny * bend };
  const c2 = { x: (b2.x + tip.x) / 2 + nx * bend * 0.6, y: (b2.y + tip.y) / 2 + ny * bend * 0.6 };
  return `M${fmt(b1.x)} ${fmt(b1.y)}Q${fmt(c1.x)} ${fmt(c1.y)} ${fmt(tip.x)} ${fmt(tip.y)}Q${fmt(c2.x)} ${fmt(c2.y)} ${fmt(b2.x)} ${fmt(b2.y)}Z`;
};

/** Thought trail: three shrinking bubbles leaving the cloud toward the tip. */
export const thoughtBubbles = (w: number, h: number, tip: Pt): Circle[] => {
  if (!Number.isFinite(tip.x) || !Number.isFinite(tip.y) || insideBody(w, h, tip)) return [];
  const cx = w / 2;
  const cy = h / 2;
  const theta = Math.atan2(tip.y - cy, tip.x - cx);
  const r = ellipseRadius(w, h, theta) * 1.12;
  const edge = { x: cx + Math.cos(theta) * r, y: cy + Math.sin(theta) * r };
  const run = Math.hypot(tip.x - edge.x, tip.y - edge.y);
  const r0 = clampN(Math.min(w, h) * 0.16, 4, 13);
  if (run < r0 * 1.2) return [];
  const steps = [
    { d: r0 * 1.4, r: r0 },
    { d: r0 * 3.4, r: r0 * 0.66 },
    { d: r0 * 4.9, r: r0 * 0.42 }
  ];
  const ux = Math.cos(theta);
  const uy = Math.sin(theta);
  return steps
    .filter((s, i) => i === 0 || s.d <= run + r0 * 0.5)
    .map((s) => ({ cx: roundN(edge.x + ux * Math.min(s.d, run)), cy: roundN(edge.y + uy * Math.min(s.d, run)), r: roundN(s.r) }));
};

/** Dash pattern for a border style, scaled to the stroke (dashed = classic whisper dashes). */
export const borderDashArray = (style: BorderStyle, stroke: number): number[] | null => {
  if (style === 'dashed') return [roundN(stroke * 3), roundN(stroke * 2.2)];
  if (style === 'dotted') return [0.01, roundN(stroke * 2.2)];
  return null;
};

// ── New tails ────────────────────────────────────────────────────────────────

/** Short manga pointer: a narrow straight wedge rooted on the body edge, capped in length. */
const pointerTail = (w: number, h: number, tip: Pt, widthScale: number): string | null => {
  if (!Number.isFinite(tip.x) || !Number.isFinite(tip.y) || insideBody(w, h, tip)) return null;
  const cx = w / 2;
  const cy = h / 2;
  const theta = Math.atan2(tip.y - cy, tip.x - cx);
  const len = Math.hypot(tip.x - cx, tip.y - cy);
  const edge = ellipseRadius(w, h, theta);
  if (len <= edge * 1.02) return null;
  const rootR = edge * 0.85;
  const reach = Math.min(len - rootR, Math.max(16, Math.min(w, h) * 0.9));
  const ux = Math.cos(theta);
  const uy = Math.sin(theta);
  const root = { x: cx + ux * rootR, y: cy + uy * rootR };
  const end = { x: root.x + ux * reach, y: root.y + uy * reach };
  const half = clampN(Math.min(w, h) * 0.12, 3, 10) * widthScale;
  return `M${fmt(root.x - uy * half)} ${fmt(root.y + ux * half)}L${fmt(end.x)} ${fmt(end.y)}L${fmt(root.x + uy * half)} ${fmt(root.y - ux * half)}Z`;
};

/** Lightning tail: a 3-segment zig-zag from the root to the tip, tapering 1.0 → 0.2. */
const lightningTail = (w: number, h: number, tip: Pt, widthScale: number): string | null => {
  if (!Number.isFinite(tip.x) || !Number.isFinite(tip.y) || insideBody(w, h, tip)) return null;
  const cx = w / 2;
  const cy = h / 2;
  const theta = Math.atan2(tip.y - cy, tip.x - cx);
  const len = Math.hypot(tip.x - cx, tip.y - cy);
  const edge = ellipseRadius(w, h, theta);
  if (len <= edge * 1.02) return null;
  const baseR = edge * 0.7;
  const ux = Math.cos(theta);
  const uy = Math.sin(theta);
  const nx = -uy;
  const ny = ux;
  const run = len - baseR;
  const half = clampN(Math.min(w, h) * 0.2, 4, 16) * widthScale;
  const zig = Math.min(run * 0.12, half * 1.6);
  const nodes = [0, 1 / 3, 2 / 3].map((t, i) => ({
    x: cx + ux * (baseR + run * t) + nx * (i === 1 ? zig : i === 2 ? -zig : 0),
    y: cy + uy * (baseR + run * t) + ny * (i === 1 ? zig : i === 2 ? -zig : 0),
    hw: half * (1 - 0.8 * t)
  }));
  const left = nodes.map((p) => ({ x: p.x + nx * p.hw, y: p.y + ny * p.hw }));
  const right = nodes.map((p) => ({ x: p.x - nx * p.hw, y: p.y - ny * p.hw })).reverse();
  return polygonPath([...left, { x: tip.x, y: tip.y }, ...right]);
};

const SPIKY: ReadonlySet<BubbleShape> = new Set<BubbleShape>(['burst', 'explosion', 'jagged']);

/** 'auto' tails: thought → bubbles, shout → straight, electronic → lightning, otherwise curved. */
export function resolveTailStyle(tail: TailStyle, kind: LineKind | undefined, shape: BubbleShape): Exclude<TailStyle, 'auto'> {
  if (tail !== 'auto') return tail;
  if (kind === 'thought' || (!kind && shape === 'cloud')) return 'bubbles';
  if (shape === 'electronic') return 'lightning';
  if (kind === 'shout' || (!kind && SPIKY.has(shape))) return 'straight';
  return 'curved';
}

// ── New bodies ───────────────────────────────────────────────────────────────

/** Superellipse ring scaled about the box centre, optionally pushed out/in radially per point. */
const ring = (w: number, h: number, n: number, steps: number, scale: { x: number; y: number }, phase = 0): Pt[] =>
  superellipsePoints(w, h, { n, steps, scaleX: scale.x, scaleY: scale.y, phase });

const radial = (p: Pt, cx: number, cy: number, by: number): Pt => {
  const dx = p.x - cx;
  const dy = p.y - cy;
  const len = Math.hypot(dx, dy) || 1;
  return { x: p.x + (dx / len) * by, y: p.y + (dy / len) * by };
};

/** Extra uniform scale so a ring that dips inward by `dip` (absolute) still clears the text block. */
const dipAllowance = (w: number, h: number, scale: { x: number; y: number }, dip: number) => {
  const k = 1 + (2 * dip) / Math.max(1e-6, Math.min(w * scale.x, h * scale.y));
  return { x: scale.x * k, y: scale.y * k };
};

const ovalPath = (w: number, h: number, inset: TextInset) => {
  const scale = fitOutlineScale(w, h, 2, { x: 1.08, y: 1.18 }, inset);
  return smoothClosedPath(ring(w, h, 2, 40, scale));
};

/** Exact rounded rectangle: r = min(w,h)·0.32 (≤ 18u), never so large the text corners leave it. */
const roundedRectPath = (w: number, h: number, inset: TextInset): string => {
  const ix = Math.max(0, inset.x);
  const iy = Math.max(0, inset.y);
  const r = Math.max(0, Math.min(Math.min(w, h) * 0.32, 18, ix + iy + Math.sqrt(2 * ix * iy), w / 2, h / 2));
  if (r < 0.5) return captionPath(w, h);
  const a = (x: number, y: number) => `A${fmt(r)} ${fmt(r)} 0 0 1 ${fmt(x)} ${fmt(y)}`;
  return (
    `M${fmt(r)} 0L${fmt(w - r)} 0${a(w, r)}L${fmt(w)} ${fmt(h - r)}${a(w - r, h)}` +
    `L${fmt(r)} ${fmt(h)}${a(0, h - r)}L0 ${fmt(r)}${a(r, 0)}Z`
  );
};

/** Rect with the reading-start top corner cut (5-point polygon); rtl mirrors. */
const notchedPath = (w: number, h: number, inset: TextInset, rtl: boolean): string => {
  const c = Math.max(0, Math.min(Math.min(w, h) * 0.2, Math.max(0, inset.x) + Math.max(0, inset.y)));
  return rtl
    ? polygonPath([{ x: 0, y: 0 }, { x: w - c, y: 0 }, { x: w, y: c }, { x: w, y: h }, { x: 0, y: h }])
    : polygonPath([{ x: c, y: 0 }, { x: w, y: 0 }, { x: w, y: h }, { x: 0, y: h }, { x: 0, y: c }]);
};

const ellipsePath = (cx: number, cy: number, rx: number, ry: number): string =>
  `M${fmt(cx - rx)} ${fmt(cy)}A${fmt(rx)} ${fmt(ry)} 0 1 0 ${fmt(cx + rx)} ${fmt(cy)}A${fmt(rx)} ${fmt(ry)} 0 1 0 ${fmt(cx - rx)} ${fmt(cy)}Z`;

/** Parchment scroll: gentle sine top/bottom edges + two rolled ends (extras) with curls (inner). */
const scrollParts = (w: number, h: number, seed: number) => {
  const amp = h * 0.015;
  const phase = rng(seed)() * Math.PI * 2;
  const samples = 20;
  const top: Pt[] = [];
  const bottom: Pt[] = [];
  for (let i = 0; i <= samples; i += 1) {
    const x = (w * i) / samples;
    const t = (4 * Math.PI * i) / samples + phase;
    top.push({ x, y: amp * Math.sin(t) });
    bottom.push({ x: w - x, y: h + amp * Math.sin(t + Math.PI / 3) });
  }
  const body = polygonPath([...top, ...bottom]);
  const rx = Math.max(2, w * 0.06);
  const ry = h * 0.55;
  const rolls = [ellipsePath(0, h / 2, rx, ry), ellipsePath(w, h / 2, rx, ry)];
  const curls = [ellipsePath(-rx * 0.15, h / 2 + ry * 0.2, rx * 0.45, ry * 0.4), ellipsePath(w + rx * 0.15, h / 2 + ry * 0.2, rx * 0.45, ry * 0.4)];
  return { body, extras: rolls, inner: [...rolls, ...curls].join(''), extent: { x: -rx, y: Math.min(-amp, h / 2 - ry), w: w + 2 * rx, h: Math.max(h + 2 * amp, 2 * ry) } };
};

/** Banner: body rect + two V-notched fishtails behind it at the ends (shaded). */
const ribbonParts = (w: number, h: number) => {
  const t = h * 0.35;
  const top = h * 0.25;
  const bottom = h * 1.15;
  const notch = (top + bottom) / 2;
  const left = polygonPath([{ x: 0, y: top }, { x: -t, y: top }, { x: -t * 0.55, y: notch }, { x: -t, y: bottom }, { x: 0, y: bottom }]);
  const right = polygonPath([{ x: w, y: top }, { x: w + t, y: top }, { x: w + t * 0.55, y: notch }, { x: w + t, y: bottom }, { x: w, y: bottom }]);
  return { body: captionPath(w, h), extras: [left, right], extent: { x: -t, y: 0, w: w + 2 * t, h: bottom } };
};

/** Explosion: 14–24 spikes of irregular reach (×0.5…1.7). */
const explosionPoints = (w: number, h: number, seed: number, inset: TextInset): Pt[] => {
  const short = Math.min(w, h);
  const rand = rng(seed ^ 0x9e3779b9);
  const count = 14 + Math.floor(rand() * 11);
  const scale = fitOutlineScale(w, h, 2.4, { x: 1.06, y: 1.18 }, inset);
  const base = ring(w, h, 2.4, count, scale, rand() * ((2 * Math.PI) / count));
  const cx = w / 2;
  const cy = h / 2;
  const spike = clampN(short * 0.34, 6, 22);
  const out: Pt[] = [];
  for (let i = 0; i < count; i += 1) {
    const a = base[i];
    const b = base[(i + 1) % count];
    out.push(a);
    const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    out.push(radial(mid, cx, cy, spike * (0.5 + rand() * 1.2)));
  }
  return out;
};

/** Jagged: 36–60 small triangular teeth on a superellipse. */
const jaggedPoints = (w: number, h: number, seed: number, inset: TextInset): Pt[] => {
  const amp = Math.max(1.5, Math.min(w, h) * 0.06);
  const scale = fitOutlineScale(w, h, 2.4, { x: 1.06, y: 1.14 }, inset);
  const count = Math.round(clampN(perimeter(w * scale.x, h * scale.y) / (amp * 2.2), 36, 60));
  const rand = rng(seed ^ 0x51ed270b);
  const base = ring(w, h, 2.4, count, scale);
  const cx = w / 2;
  const cy = h / 2;
  const out: Pt[] = [];
  for (let i = 0; i < count; i += 1) {
    const a = base[i];
    const b = base[(i + 1) % count];
    out.push(a);
    out.push(radial({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, cx, cy, amp * (0.7 + rand() * 0.6)));
  }
  return out;
};

/** Wavy: r(θ) = r₀(1 + a·sin(kθ + φ)), a = 0.035, k = round(perimeter / 22u), 72 smoothed samples. */
const wavyPath = (w: number, h: number, seed: number, inset: TextInset): string => {
  const a = 0.035;
  const s0 = fitOutlineScale(w, h, 2, { x: 1.08, y: 1.18 }, inset);
  const scale = { x: s0.x / (1 - a), y: s0.y / (1 - a) };
  const rx = (w / 2) * scale.x;
  const ry = (h / 2) * scale.y;
  const k = Math.max(5, Math.round(perimeter(2 * rx, 2 * ry) / 22));
  const phi = rng(seed ^ 0x2545f491)() * Math.PI * 2;
  const pts: Pt[] = [];
  for (let i = 0; i < 72; i += 1) {
    const t = (2 * Math.PI * i) / 72;
    const f = 1 + a * Math.sin(k * t + phi);
    pts.push({ x: w / 2 + rx * Math.cos(t) * f, y: h / 2 + ry * Math.sin(t) * f });
  }
  return smoothClosedPath(pts);
};

/** Electronic: square-wave crenellation (±a, a = 0.05·min(w,h)) on a superellipse; sharp corners. */
const electronicPoints = (w: number, h: number, inset: TextInset): Pt[] => {
  const amp = Math.max(1, Math.min(w, h) * 0.05);
  const scale = dipAllowance(w, h, fitOutlineScale(w, h, 3, { x: 1.06, y: 1.14 }, inset), amp);
  let count = Math.round(clampN(perimeter(w * scale.x, h * scale.y) / Math.max(8, amp * 3), 16, 64));
  count += (4 - (count % 4)) % 4;
  const base = ring(w, h, 3, count, scale);
  const cx = w / 2;
  const cy = h / 2;
  const out: Pt[] = [];
  for (let i = 0; i < count; i += 1) {
    const level = i % 2 === 0 ? amp : -amp;
    out.push(radial(base[i], cx, cy, level));
    out.push(radial(base[(i + 1) % count], cx, cy, level));
  }
  return out;
};

// ── Path utilities (bounds, transforms, point-in-outline) ────────────────────

const TOKEN_RE = /[MLCQAZ]|-?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?/gi;

/** Apply a point transform to every coordinate of an M/L/C/Q/A/Z path (A radii scaled by sx/sy). */
const transformPath = (d: string, map: (p: Pt) => Pt, sx = 1, sy = 1): string => {
  const tokens = d.match(TOKEN_RE) ?? [];
  let out = '';
  let i = 0;
  const num = () => Number(tokens[i++]);
  while (i < tokens.length) {
    const cmd = tokens[i++].toUpperCase();
    if (cmd === 'Z') {
      out += 'Z';
      continue;
    }
    const pairs = cmd === 'C' ? 3 : cmd === 'Q' ? 2 : 1;
    if (cmd === 'A') {
      const rx = num();
      const ry = num();
      const rot = num();
      const large = num();
      const sweep = num();
      const p = map({ x: num(), y: num() });
      out += `A${fmt(rx * sx)} ${fmt(ry * sy)} ${rot} ${large} ${sweep} ${fmt(p.x)} ${fmt(p.y)}`;
      continue;
    }
    const pts: string[] = [];
    for (let k = 0; k < pairs; k += 1) {
      const p = map({ x: num(), y: num() });
      pts.push(`${fmt(p.x)} ${fmt(p.y)}`);
    }
    out += `${cmd}${pts.join(' ')}`;
  }
  return out;
};

/** Bounding box of the anchor + control points of an M/L/C/Q path (A: endpoints only). */
const pointBounds = (d: string | undefined): Box | null => {
  if (!d) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  transformPath(d, (p) => {
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x);
    maxY = Math.max(maxY, p.y);
    return p;
  });
  return Number.isFinite(minX) ? { x: minX, y: minY, w: maxX - minX, h: maxY - minY } : null;
};

const unionBox = (boxes: (Box | null | undefined)[]): Box | null => {
  const list = boxes.filter((b): b is Box => !!b);
  if (!list.length) return null;
  const x = Math.min(...list.map((b) => b.x));
  const y = Math.min(...list.map((b) => b.y));
  const x2 = Math.max(...list.map((b) => b.x + b.w));
  const y2 = Math.max(...list.map((b) => b.y + b.h));
  return { x, y, w: x2 - x, h: y2 - y };
};

/** Polygon point-in-outline test (even-odd), used to fit inner bursts around the text block. */
const insidePolygon = (pts: Pt[], p: Pt): boolean => {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i, i += 1) {
    const a = pts[i];
    const b = pts[j];
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y || 1e-12) + a.x) inside = !inside;
  }
  return inside;
};

/** Scale a path about the box centre (double border offset / inner burst). */
const scaledAbout = (d: string, cx: number, cy: number, sx: number, sy: number): string =>
  transformPath(d, (p) => ({ x: cx + (p.x - cx) * sx, y: cy + (p.y - cy) * sy }), sx, sy);

// ── Public API ───────────────────────────────────────────────────────────────

/** Fill shading applied to `extras` per shape (ribbon fishtails sit in shadow). */
export const EXTRA_SHADE: Partial<Record<BubbleShape, number>> = { ribbon: -0.15, scroll: -0.06 };

/** Lighten (+) / darken (−) a '#rrggbb[aa]' colour by a fraction; other values pass through. */
export function shadeColor(color: string, amount: number): string {
  const m = /^#([0-9a-f]{6})([0-9a-f]{2})?$/i.exec(color || '');
  if (!m || !Number.isFinite(amount) || !amount) return color;
  const n = parseInt(m[1], 16);
  const ch = (v: number) => Math.round(Math.min(255, Math.max(0, amount < 0 ? v * (1 + amount) : v + (255 - v) * amount)));
  const hex = (v: number) => ch(v).toString(16).padStart(2, '0');
  return `#${hex((n >> 16) & 255)}${hex((n >> 8) & 255)}${hex(n & 255)}${m[2] ?? ''}`;
}

/**
 * Everything needed to draw one balloon's outline in balloon-local units. `tip` is the tail tip
 * relative to the text box's top-left (omit/null for no tail). `borderStyle` (optional) adds the
 * double-border `inner` outline; the explosion's inner burst shows unless it is 'none'.
 */
export function bubbleGeometry(
  shape: BubbleShape,
  w: number,
  h: number,
  opts: {
    inset: { x: number; y: number };
    seed: number;
    tip?: { x: number; y: number } | null;
    tail: TailStyle;
    tailWidth: number;
    stroke: number;
    rtl?: boolean;
    borderStyle?: BorderStyle;
  }
): BubbleGeometry {
  const W = Number.isFinite(w) && w > 0 ? w : 1;
  const H = Number.isFinite(h) && h > 0 ? h : 1;
  const inset = { x: Number.isFinite(opts.inset?.x) ? opts.inset.x : W * 0.06, y: Number.isFinite(opts.inset?.y) ? opts.inset.y : H * 0.2 };
  const seed = opts.seed >>> 0;
  const stroke = Number.isFinite(opts.stroke) && opts.stroke > 0 ? opts.stroke : 1;
  const tailWidth = Number.isFinite(opts.tailWidth) && opts.tailWidth > 0 ? opts.tailWidth : 1;
  const textBox: Box = { x: 0, y: 0, w: W, h: H };
  const out: BubbleGeometry = { bubbles: [], bounds: textBox };
  if (shape === 'none') return out;

  let body: string;
  let extras: string[] | undefined;
  let inner: string | undefined;
  let extent: Box | null = null;
  let poly: Pt[] | undefined;
  switch (shape) {
    case 'squircle':
      body = speechBodyPath(W, H, inset);
      break;
    case 'oval':
      body = ovalPath(W, H, inset);
      break;
    case 'rounded_rect':
      body = roundedRectPath(W, H, inset);
      extent = textBox;
      break;
    case 'rect':
      body = captionPath(W, H);
      break;
    case 'notched':
      body = notchedPath(W, H, inset, !!opts.rtl);
      break;
    case 'scroll': {
      const s = scrollParts(W, H, seed);
      body = s.body;
      extras = s.extras;
      inner = s.inner;
      extent = s.extent;
      break;
    }
    case 'ribbon': {
      const r = ribbonParts(W, H);
      body = r.body;
      extras = r.extras;
      extent = r.extent;
      break;
    }
    case 'cloud':
      body = cloudPath(W, H, seed, inset);
      break;
    case 'burst':
      body = burstPath(W, H, seed, inset);
      break;
    case 'explosion':
      poly = explosionPoints(W, H, seed, inset);
      body = polygonPath(poly);
      break;
    case 'jagged':
      poly = jaggedPoints(W, H, seed, inset);
      body = polygonPath(poly);
      break;
    case 'wavy':
      body = wavyPath(W, H, seed, inset);
      break;
    case 'electronic':
      poly = electronicPoints(W, H, inset);
      body = polygonPath(poly);
      break;
    default:
      body = speechBodyPath(W, H, inset);
  }
  out.body = body;
  if (extras?.length) out.extras = extras;

  const bodyBox = unionBox([pointBounds(body), extent && shape === 'rounded_rect' ? extent : null]) ?? textBox;
  const cx = W / 2;
  const cy = H / 2;
  const border = opts.borderStyle ?? 'solid';
  if (border === 'double') {
    const sx = Math.max(0.3, 1 - (5 * stroke) / Math.max(1e-6, bodyBox.w));
    const sy = Math.max(0.3, 1 - (5 * stroke) / Math.max(1e-6, bodyBox.h));
    inner = `${scaledAbout(body, cx, cy, sx, sy)}${inner ?? ''}`;
  } else if (shape === 'explosion' && border !== 'none' && poly) {
    // Second burst at 70 % (grown just enough that it never crosses the text block).
    const corners = [
      { x: inset.x, y: inset.y },
      { x: W - inset.x, y: inset.y },
      { x: W - inset.x, y: H - inset.y },
      { x: inset.x, y: H - inset.y }
    ];
    let k = 0.7;
    const scaledPoly = (f: number) => poly!.map((p) => ({ x: cx + (p.x - cx) * f, y: cy + (p.y - cy) * f }));
    while (k < 0.95 && !corners.every((c) => insidePolygon(scaledPoly(k), c))) k += 0.05;
    inner = polygonPath(scaledPoly(k));
  }
  if (inner && border !== 'none') out.inner = inner;

  out.bounds = unionBox([bodyBox, extent, ...(extras || []).map((e) => pointBounds(e))]) ?? textBox;
  out.bounds = { x: roundN(out.bounds.x), y: roundN(out.bounds.y), w: roundN(out.bounds.w), h: roundN(out.bounds.h) };

  // Tail.
  const tip = opts.tip;
  if (tip && Number.isFinite(tip.x) && Number.isFinite(tip.y)) {
    const style = resolveTailStyle(opts.tail, undefined, shape);
    if (style === 'curved' || style === 'straight') out.tail = tailPath(W, H, tip, style, tailWidth) || undefined;
    else if (style === 'pointer') out.tail = pointerTail(W, H, tip, tailWidth) || undefined;
    else if (style === 'lightning') out.tail = lightningTail(W, H, tip, tailWidth) || undefined;
    else if (style === 'bubbles') out.bubbles = thoughtBubbles(W, H, tip);
    if (!out.tail) delete out.tail;
  }
  return out;
}

/**
 * Connector "neck" between two linked balloons (centres + text-box sizes, same units): a capsule whose
 * width follows the smaller balloon. Drawn with the group's fat-stroke-then-fill so it merges seamlessly.
 */
export function linkNeck(
  a: { cx: number; cy: number; w: number; h: number },
  b: { cx: number; cy: number; w: number; h: number },
  stroke: number
): string {
  const dx = b.cx - a.cx;
  const dy = b.cy - a.cy;
  const len = Math.hypot(dx, dy);
  if (!Number.isFinite(len) || len < 1e-6) return '';
  const s = Number.isFinite(stroke) && stroke > 0 ? stroke : 1;
  const hw = Math.max(2 * s, Math.min(Math.min(a.h, b.h) * 0.18, Math.min(a.w, b.w) * 0.25));
  const ux = dx / len;
  const uy = dy / len;
  const nx = -uy * hw;
  const ny = ux * hw;
  const r = fmt(hw);
  return (
    `M${fmt(a.cx + nx)} ${fmt(a.cy + ny)}L${fmt(b.cx + nx)} ${fmt(b.cy + ny)}` +
    `A${r} ${r} 0 0 0 ${fmt(b.cx - nx)} ${fmt(b.cy - ny)}` +
    `L${fmt(a.cx - nx)} ${fmt(a.cy - ny)}` +
    `A${r} ${r} 0 0 0 ${fmt(a.cx + nx)} ${fmt(a.cy + ny)}Z`
  );
}
