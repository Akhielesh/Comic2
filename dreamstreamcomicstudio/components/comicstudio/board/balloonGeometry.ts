// Balloon geometry for overlay lettering (pure, dependency-free).
//
// One source of truth for how a lettered balloon looks, shared by the live board
// (BalloonLayer, SVG), the print view (HTML + SVG) and the PNG exporter (canvas, via
// Path2D on the same path strings) — so what the user arranges on the board is exactly
// what prints and exports.
//
// Coordinates:
//  - A Balloon (shared/comic/doc.ts) is page-normalized: x, y = top-left corner, w = width
//    as a fraction of the page WIDTH, tailX/tailY = the tail tip. Its height is not stored:
//    it follows from the text at the lettering metrics below.
//  - Shape helpers work in balloon-local pixels: (0, 0) is the balloon's top-left corner,
//    (w, h) its size, and the tail tip is given relative to that corner.
//
// The lettering metrics mirror the server's balloon sizing (server/src/comic/vision.ts:
// one glyph ≈ 1/95 of the page width, line ≈ 0.022 page widths, 0.03/0.026 total padding),
// so balloons the vision pass sized from the text fit the text we actually draw.

import type { AspectRatio, Balloon, ComicDoc, Line, LineKind, Page } from '../../../shared/comic/doc';
import { panelBoxesFor } from './pageLayout';

export const LETTERING = {
  /** Font size as a fraction of the rendered page width (≈ 1.7%). */
  fontScale: 0.017,
  /** Never letter smaller than this (readability on small thumbnails is handled by hiding detail, not shrinking text). */
  minFontPx: 9,
  /** Line height in ems. 1.7% × 1.3 ≈ the server's 0.022 page-width line. */
  lineHeight: 1.3,
  /** Inner padding per side (fractions of the page WIDTH): 2 × 0.015 = the server's 0.03. */
  padX: 0.015,
  /** 2 × 0.013 = the server's 0.026. */
  padY: 0.013,
  /** Server sizing metrics (page-width units). */
  charW: 0.0105,
  lineH: 0.022,
  padW: 0.03,
  padH: 0.026,
  /** Balloon width bounds (fraction of page width). */
  minW: 0.04,
  maxW: 0.95,
  /** Outline weight as a fraction of page width (≈ 2px on a 700px page). */
  strokeScale: 0.0028,
  minStrokePx: 1.25,
  fill: '#ffffff',
  captionFill: '#fff6c8',
  ink: '#111111'
} as const;

/** Server-side width bounds for auto-sized balloons (vision.ts MIN/MAX_BALLOON_W). */
const AUTO_MIN_W = 0.16;
const AUTO_MAX_W = 0.34;

const SPOKEN: ReadonlySet<LineKind> = new Set<LineKind>(['speech', 'thought', 'whisper', 'shout']);
export const isSpokenKind = (kind: LineKind) => SPOKEN.has(kind);
/** Kinds drawn with a tail (or a thought trail) toward the speaker. */
export const hasTail = (kind: LineKind) => SPOKEN.has(kind);

const KIND_FONT_SCALE: Record<LineKind, number> = {
  speech: 1,
  thought: 1,
  whisper: 0.94,
  shout: 1.08,
  caption: 0.95,
  sfx: 2.4
};

// ── Numbers ──────────────────────────────────────────────────────────────────

export const clamp = (n: number, lo: number, hi: number): number => (Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : lo);
export const clamp01 = (n: number) => clamp(n, 0, 1);
const round = (n: number, places = 2) => {
  const f = 10 ** places;
  return Math.round(n * f) / f;
};
const round4 = (n: number) => round(n, 4);
const fmt = (n: number) => String(round(n));

const clean = (value: unknown): string => (typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '');

/** Width / height of an aspect ratio string ("2:3" → 0.667). */
export const aspectNumber = (aspect?: AspectRatio | string | null): number => {
  if (!aspect) return 2 / 3;
  const [w, h] = String(aspect).split(':').map(Number);
  return w > 0 && h > 0 ? w / h : 2 / 3;
};

/** A page's width/height: the render's pixel size when known, else the format's aspect. */
export const pageAspectOf = (doc: Pick<ComicDoc, 'format'>, page?: Pick<Page, 'render'> | null): number => {
  const a = page?.render?.asset;
  if (a?.w && a?.h && a.w > 0 && a.h > 0) return a.w / a.h;
  return aspectNumber(doc.format.pageAspect);
};

// ── Type ─────────────────────────────────────────────────────────────────────

/** Lettering font size in px for a page rendered `pageWidthPx` wide. */
export const balloonFontPx = (pageWidthPx: number, kind: LineKind = 'speech'): number =>
  round(Math.max(LETTERING.minFontPx, Math.max(0, pageWidthPx) * LETTERING.fontScale * (KIND_FONT_SCALE[kind] ?? 1)));

/**
 * Sound-effect size: big display lettering that still fits its box on one line per word
 * (Bangers is condensed: ≈ 0.5em per glyph).
 */
export const sfxFontPx = (text: string, boxWidthPx: number, pageWidthPx: number): number => {
  const longest = Math.max(1, ...clean(text).split(' ').map((w) => w.length));
  const fit = (Math.max(0, boxWidthPx) * 0.94) / (longest * 0.5);
  return round(Math.max(LETTERING.minFontPx, Math.min(balloonFontPx(pageWidthPx, 'sfx'), fit)));
};

/** Outline weight in px for a page rendered `pageWidthPx` wide. */
export const strokePx = (pageWidthPx: number): number => round(Math.max(LETTERING.minStrokePx, pageWidthPx * LETTERING.strokeScale));

/** Inner padding in px. */
export const balloonPaddingPx = (pageWidthPx: number) => ({ x: round(pageWidthPx * LETTERING.padX), y: round(pageWidthPx * LETTERING.padY) });

/** Locale-aware uppercase lettering (comic convention); scripts without case are unaffected. */
export const letteringText = (text: string, language = 'en'): string => {
  const t = clean(text);
  try {
    return t.toLocaleUpperCase(language || 'en');
  } catch {
    return t.toUpperCase();
  }
};

/** Balloon width from text length — same curve the server uses when it auto-sizes balloons. */
export const balloonWidthForText = (text: string): number => {
  const len = clean(text).length;
  const t = clamp((len - 12) / (110 - 12), 0, 1);
  return round4(AUTO_MIN_W + t * (AUTO_MAX_W - AUTO_MIN_W));
};

/** Estimated balloon height as a fraction of the page HEIGHT (word-wrapped at width w). Mirrors the server. */
export const estimateBalloonHeight = (text: string, w: number, pageAspect = 2 / 3): number => {
  const perLine = Math.max(6, Math.floor((w - LETTERING.padW) / LETTERING.charW));
  let lines = 1;
  let current = 0;
  for (const word of clean(text).split(' ')) {
    if (!word) continue;
    const len = word.length;
    if (current === 0) current = Math.min(len, perLine);
    else if (current + 1 + len <= perLine) current += 1 + len;
    else {
      lines += 1 + Math.floor(Math.max(0, len - 1) / perLine);
      current = len % perLine || perLine;
    }
  }
  return round4((lines * LETTERING.lineH + LETTERING.padH) * pageAspect);
};

/** Keep a balloon on the page with a sane width; tail tips clamped to the page. */
export const clampBalloon = (b: Balloon): Balloon => {
  const w = clamp(typeof b.w === 'number' ? b.w : AUTO_MIN_W, LETTERING.minW, LETTERING.maxW);
  const out: Balloon = {
    ...b,
    w: round4(w),
    x: round4(clamp(typeof b.x === 'number' ? b.x : 0, 0, 1 - w)),
    y: round4(clamp(typeof b.y === 'number' ? b.y : 0, 0, 0.99))
  };
  if (typeof b.tailX === 'number' && typeof b.tailY === 'number' && Number.isFinite(b.tailX) && Number.isFinite(b.tailY)) {
    out.tailX = round4(clamp01(b.tailX));
    out.tailY = round4(clamp01(b.tailY));
  } else {
    delete out.tailX;
    delete out.tailY;
  }
  return out;
};

/** Tail tip for a speaking balloon that has none: just below, slightly toward the reading start. */
export const defaultTailTip = (b: Pick<Balloon, 'x' | 'y' | 'w'>, heightFrac: number): { tailX: number; tailY: number } => ({
  tailX: round4(clamp01(b.x + b.w * 0.42)),
  tailY: round4(clamp01(b.y + heightFrac + 0.04))
});

// ── Word wrap (canvas) ───────────────────────────────────────────────────────

/** Greedy word wrap; a word longer than the line is broken across lines. */
export const wrapText = (text: string, maxWidth: number, measure: (s: string) => number): string[] => {
  const words = clean(text).split(' ').filter(Boolean);
  if (!words.length) return [];
  const lines: string[] = [];
  let current = '';
  const pushLongWord = (word: string) => {
    let chunk = '';
    for (const ch of word) {
      if (chunk && measure(chunk + ch) > maxWidth) {
        lines.push(chunk);
        chunk = ch;
      } else chunk += ch;
    }
    return chunk;
  };
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (measure(candidate) <= maxWidth) {
      current = candidate;
      continue;
    }
    if (current) lines.push(current);
    current = measure(word) > maxWidth ? pushLongWord(word) : word;
  }
  if (current) lines.push(current);
  return lines;
};

/**
 * Word wrap with balanced line lengths (like CSS `text-wrap: balance`): the narrowest width
 * that keeps the greedy line count, so balloons don't end on a lonely word.
 */
export const wrapBalanced = (text: string, maxWidth: number, measure: (s: string) => number): string[] => {
  const greedy = wrapText(text, maxWidth, measure);
  if (greedy.length <= 1) return greedy;
  let lo = maxWidth * 0.4;
  let hi = maxWidth;
  for (let i = 0; i < 10; i += 1) {
    const mid = (lo + hi) / 2;
    if (wrapText(text, mid, measure).length <= greedy.length) hi = mid;
    else lo = mid;
  }
  return wrapText(text, hi, measure);
};

// ── Shapes ───────────────────────────────────────────────────────────────────

export interface Pt {
  x: number;
  y: number;
}

export interface Circle {
  cx: number;
  cy: number;
  r: number;
}

/** Deterministic 32-bit seed from a string (stable shapes across re-renders and exports). */
export const hashSeed = (input: string): number => {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
};

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

/**
 * Points on a superellipse filling a w×h box (exponent n: 2 = ellipse, higher = squarer).
 * A squircle-ish balloon hugs a block of centered text far better than an ellipse, so the
 * letters never touch the outline. `scaleX/scaleY` let the outline bleed past the text box.
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

const polygonPath = (points: Pt[]): string =>
  points.length < 3 ? '' : `M${points.map((pt) => `${fmt(pt.x)} ${fmt(pt.y)}`).join('L')}Z`;

/** Approximate perimeter of the ellipse inscribed in w×h (Ramanujan). */
const perimeter = (w: number, h: number) => {
  const a = w / 2;
  const b = h / 2;
  return Math.PI * (3 * (a + b) - Math.sqrt((3 * a + b) * (a + 3 * b)));
};

/** Text inset inside a balloon box, in px (defaults approximate the lettering padding). */
export interface TextInset {
  x: number;
  y: number;
}

const defaultInset = (w: number, h: number): TextInset => ({ x: w * 0.06, y: h * 0.2 });

/**
 * Outline scale (relative to the w×h box) that keeps the text block's corners inside a
 * superellipse of exponent n with some breathing room. Short balloons keep the base bleed;
 * tall, full ones grow just enough that lettering never touches the outline.
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
  const rx = clamp(1 - (2 * inset.x) / w, 0, 1);
  const ry = clamp(1 - (2 * inset.y) / h, 0, 1);
  const v = (rx / base.x) ** n + (ry / base.y) ** n;
  if (v <= fill) return base;
  const f = (v / fill) ** (1 / n);
  return { x: base.x * f, y: base.y * f };
};

/** Rounded balloon outline (speech / whisper). */
export const speechBodyPath = (w: number, h: number, inset?: TextInset): string => {
  const scale = fitOutlineScale(w, h, 3, { x: 1.04, y: 1.1 }, inset);
  return smoothClosedPath(superellipsePoints(w, h, { n: 3, steps: 32, scaleX: scale.x, scaleY: scale.y }));
};

/** Scalloped thought cloud around the text box. */
export const cloudPath = (w: number, h: number, seed = 1, inset?: TextInset): string => {
  const bump = clamp(Math.min(w, h) * 0.42, 7, 36);
  const count = Math.round(clamp(perimeter(w * 1.04, h * 1.12) / bump, 7, 18));
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
    // Bulge outward, perpendicular to the chord (away from the center).
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
  const count = Math.round(clamp(perimeter(w, h) / clamp(short * 0.55, 10, 34), 10, 20));
  const rand = rng(seed);
  const scale = fitOutlineScale(w, h, 2.4, { x: 1.06, y: 1.18 }, inset);
  const inner = superellipsePoints(w, h, { n: 2.4, steps: count, scaleX: scale.x, scaleY: scale.y });
  const cx = w / 2;
  const cy = h / 2;
  const spike = clamp(short * 0.32, 6, 20);
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
export const captionPath = (w: number, h: number): string => polygonPath([
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
 * Tail wedge toward the tip (balloon-local px). Its base sits just inside the outline so
 * it leaves the balloon at full width; drawn under the body and filled again over it, it
 * merges seamlessly with the outline. Null when the tip is inside the balloon.
 */
export const tailPath = (w: number, h: number, tip: Pt, style: 'curved' | 'straight' = 'curved'): string | null => {
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
  // Longer tails get a slightly wider root so they never read as needles.
  const half = clamp(Math.min(w, h) * 0.22 + (len - edge) * 0.025, 4, 20);
  const b1 = { x: base.x + nx * half, y: base.y + ny * half };
  const b2 = { x: base.x - nx * half, y: base.y - ny * half };
  if (style === 'straight') return `M${fmt(b1.x)} ${fmt(b1.y)}L${fmt(tip.x)} ${fmt(tip.y)}L${fmt(b2.x)} ${fmt(b2.y)}Z`;
  // Both edges bow the same way: a gently hooked, tapering tail.
  const bend = (len - baseR) * 0.1;
  const c1 = { x: (b1.x + tip.x) / 2 + nx * bend, y: (b1.y + tip.y) / 2 + ny * bend };
  const c2 = { x: (b2.x + tip.x) / 2 + nx * bend * 0.6, y: (b2.y + tip.y) / 2 + ny * bend * 0.6 };
  return `M${fmt(b1.x)} ${fmt(b1.y)}Q${fmt(c1.x)} ${fmt(c1.y)} ${fmt(tip.x)} ${fmt(tip.y)}Q${fmt(c2.x)} ${fmt(c2.y)} ${fmt(b2.x)} ${fmt(b2.y)}Z`;
};

/** Thought trail: three shrinking bubbles leaving the cloud toward the tip (kept close to the cloud). */
export const thoughtBubbles = (w: number, h: number, tip: Pt): Circle[] => {
  if (!Number.isFinite(tip.x) || !Number.isFinite(tip.y) || insideBody(w, h, tip)) return [];
  const cx = w / 2;
  const cy = h / 2;
  const theta = Math.atan2(tip.y - cy, tip.x - cx);
  // Where the direction leaves the cloud (scallops bulge ~12% past the ellipse).
  const r = ellipseRadius(w, h, theta) * 1.12;
  const edge = { x: cx + Math.cos(theta) * r, y: cy + Math.sin(theta) * r };
  const run = Math.hypot(tip.x - edge.x, tip.y - edge.y);
  const r0 = clamp(Math.min(w, h) * 0.16, 4, 13);
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
    .map((s) => ({ cx: round(edge.x + ux * Math.min(s.d, run)), cy: round(edge.y + uy * Math.min(s.d, run)), r: round(s.r) }));
};

export interface BalloonShape {
  kind: LineKind;
  /** Closed body outline (SVG path data); absent for sound effects. */
  body?: string;
  /** Tail wedge (speech / whisper / shout). */
  tail?: string;
  /** Thought trail toward the speaker. */
  bubbles: Circle[];
  fill: string;
  stroke: string;
  dashed: boolean;
}

/**
 * Everything needed to draw one balloon in balloon-local px. `tip` is the tail tip relative
 * to the balloon's top-left corner (omit for no tail).
 */
export const balloonShape = (
  kind: LineKind,
  w: number,
  h: number,
  opts: { tip?: Pt | null; seed?: number; /** Text padding in px (keeps lettering clear of the outline). */ inset?: TextInset } = {}
): BalloonShape => {
  const inset = opts.inset;
  const tip = opts.tip && hasTail(kind) ? opts.tip : null;
  const base = { kind, fill: LETTERING.fill, stroke: LETTERING.ink, dashed: false, bubbles: [] as Circle[] };
  switch (kind) {
    case 'caption':
      return { ...base, body: captionPath(w, h), fill: LETTERING.captionFill };
    case 'sfx':
      return { ...base, fill: 'none', stroke: 'none' };
    case 'thought':
      return { ...base, body: cloudPath(w, h, opts.seed, inset), bubbles: tip ? thoughtBubbles(w, h, tip) : [] };
    case 'shout':
      return { ...base, body: burstPath(w, h, opts.seed, inset), ...(tip ? { tail: tailPath(w, h, tip, 'straight') || undefined } : {}) };
    case 'whisper':
      return { ...base, body: speechBodyPath(w, h, inset), dashed: true, ...(tip ? { tail: tailPath(w, h, tip) || undefined } : {}) };
    case 'speech':
    default:
      return { ...base, body: speechBodyPath(w, h, inset), ...(tip ? { tail: tailPath(w, h, tip) || undefined } : {}) };
  }
};

/** Dash pattern for whispers, scaled to the stroke. */
export const dashArray = (stroke: number) => `${round(stroke * 3)} ${round(stroke * 2.2)}`;

// ── Sound effects ────────────────────────────────────────────────────────────

const SFX_COLORS = ['#e63946', '#ffb703', '#fb5607', '#3a86ff', '#8338ec', '#06d6a0'];

/** Color and tilt for a sound effect (deterministic per line). */
export const sfxStyle = (lineId: string): { color: string; rotate: number } => {
  const h = hashSeed(lineId || 'sfx');
  return { color: SFX_COLORS[h % SFX_COLORS.length], rotate: ((h >>> 8) % 13) - 6 };
};

// ── Lines → balloons ─────────────────────────────────────────────────────────

export interface ResolvedBalloon {
  line: Line;
  /** 1-based panel number the line belongs to. */
  panelN: number;
  balloon: Balloon;
  /** True when the page had no balloon for this line and we placed it ourselves. */
  fallback: boolean;
}

const validBalloon = (b?: Balloon): b is Balloon =>
  !!b && [b.x, b.y, b.w].every((v) => typeof v === 'number' && Number.isFinite(v)) && b.w > 0;

/** How far each kind's outline reaches past its text box (fractions of the box). */
const OUTLINE_BLEED: Record<LineKind, { x: number; y: number }> = {
  speech: { x: 0.04, y: 0.12 },
  whisper: { x: 0.04, y: 0.12 },
  thought: { x: 0.08, y: 0.25 },
  shout: { x: 0.12, y: 0.45 },
  caption: { x: 0, y: 0 },
  sfx: { x: 0, y: 0.1 }
};

/** A balloon's text box grown to the outline it draws (used to keep placed balloons apart). */
const outlineBounds = (kind: LineKind, r: { x: number; y: number; w: number; h: number }) => {
  const b = OUTLINE_BLEED[kind] || OUTLINE_BLEED.speech;
  const dx = r.w * b.x;
  const dy = r.h * b.y;
  return { x: r.x - dx, y: r.y - dy, w: r.w + 2 * dx, h: r.h + 2 * dy };
};

/**
 * Every non-empty line of a page with the balloon to draw for it, in reading order. Lines
 * without a balloon (new lines, an unfinished layout) get a fallback position stacked at
 * the top of their panel, so no text is ever lost.
 */
export const resolveBalloons = (doc: Pick<ComicDoc, 'format'>, page: Page): ResolvedBalloon[] => {
  const byId = new Map(page.balloons.map((b) => [b.lineId, b]));
  const boxes = panelBoxesFor(doc, page);
  const aspect = pageAspectOf(doc, page);
  const rtl = doc.format.readingDirection === 'rtl';
  const pad = 0.012;
  const gap = 0.01;
  const out: ResolvedBalloon[] = [];
  page.panels.forEach((panel, i) => {
    const box = boxes[i] || { x: 0.02, y: 0.02, w: 0.96, h: 0.96 };
    const lines = panel.lines.filter((l) => clean(l.text));
    // Balloons the page already has are obstacles for the ones we place — measured by the
    // outline they actually draw (bursts and clouds reach well past their text box).
    const taken: { x: number; y: number; w: number; h: number }[] = [];
    for (const line of lines) {
      const b = byId.get(line.id);
      if (validBalloon(b)) {
        const c = clampBalloon(b);
        taken.push(outlineBounds(line.kind, { x: c.x, y: c.y, w: c.w, h: estimateBalloonHeight(line.text, c.w, aspect) }));
      }
    }
    const overlapping = (r: { x: number; y: number; w: number; h: number }) =>
      taken.find((t) => r.x < t.x + t.w + gap && t.x < r.x + r.w + gap && r.y < t.y + t.h + gap && t.y < r.y + r.h + gap);
    let cursor = box.y + pad;
    let spoken = 0;
    for (const line of lines) {
      const existing = byId.get(line.id);
      if (validBalloon(existing)) {
        out.push({ line, panelN: panel.n, balloon: clampBalloon(existing), fallback: false });
        continue;
      }
      const w = Math.min(balloonWidthForText(line.text), Math.max(0.08, box.w - 2 * pad));
      const hFrac = estimateBalloonHeight(line.text, w, aspect);
      const left = box.x + pad;
      const right = box.x + box.w - pad - w;
      let x: number;
      if (line.kind === 'caption') x = rtl ? right : left;
      else if (line.kind === 'sfx') x = box.x + (box.w - w) / 2;
      else {
        const onStart = spoken % 2 === 0;
        x = onStart !== rtl ? left : right;
        spoken += 1;
      }
      const maxY = Math.max(box.y + pad, box.y + box.h - pad - hFrac);
      let y = clamp(cursor, box.y + pad, maxY);
      // Stack below anything already there (stays in the panel; a full panel accepts overlap).
      const bleedTop = y - outlineBounds(line.kind, { x, y, w, h: hFrac }).y;
      for (let guard = 0; guard < 12; guard += 1) {
        const hit = overlapping(outlineBounds(line.kind, { x, y, w, h: hFrac }));
        if (!hit) break;
        const below = hit.y + hit.h + gap + bleedTop;
        if (below > maxY) break;
        y = below;
      }
      taken.push(outlineBounds(line.kind, { x, y, w, h: hFrac }));
      cursor = y + hFrac + gap;
      const balloon: Balloon = { lineId: line.id, x: round4(x), y: round4(y), w: round4(w) };
      if (isSpokenKind(line.kind)) {
        balloon.tailX = round4(clamp01(x + w / 2));
        balloon.tailY = round4(clamp(y + hFrac + 0.05, 0, box.y + box.h - pad));
      }
      out.push({ line, panelN: panel.n, balloon: clampBalloon(balloon), fallback: true });
    }
  });
  return out;
};

/** Line → its tail tip in page coordinates (explicit, else the default below the balloon). */
export const tailTipOf = (balloon: Balloon, kind: LineKind, heightFrac: number): { tailX: number; tailY: number } | null => {
  if (!hasTail(kind)) return null;
  if (typeof balloon.tailX === 'number' && typeof balloon.tailY === 'number') return { tailX: balloon.tailX, tailY: balloon.tailY };
  return defaultTailTip(balloon, heightFrac);
};
