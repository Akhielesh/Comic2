// The procedural library's seeded geometry (master plan §2.6; PE-FX): the seeds, stable rounding and the motion and
// atmosphere geometry that components/comicstudio/library/procedural/textures.ts re-exports (moved here unchanged from
// that file, so every output is byte-identical). The reader (ComicReader's page mat) and the library thumbnails
// (PresetThumb) load this file through the shim, so it holds the library code and nothing else: the Pro effect drawing
// helpers live in draw.ts and the Pro drawings in lines, bursts, emanata, atmosphere and borders, which the shim never
// reaches (registry.test.ts walks its imports). Rollup splits by module, not by function, so a Pro helper added here
// would ship to every reader. Pure and dependency-free. The registry never imports this file.

// ── Seeds and rounding ───────────────────────────────────────────────────────────────────────────────────────────

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

// ── Motion lines (speedLines, focusLines) ────────────────────────────────────────────────────────────────────────

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

// ── Atmosphere (bokeh, rainPath) ──────────────────────────────────────────────────────────────────────────────────

/** Soft round "bokeh" lights (x, y, r, opacity) for glowing backgrounds. */
export function bokeh(seed: number | string, o: { count?: number; w?: number; h?: number; minR?: number; maxR?: number } = {}): { x: number; y: number; r: number; o: number }[] {
  const rand = rng(seedOf(seed) ^ 0x2545f491);
  const W = o.w ?? 100;
  const H = o.h ?? 100;
  const n = Math.round(clampNum(o.count ?? 9, 1, 40));
  const lo = o.minR ?? 3;
  const hi = o.maxR ?? 11;
  return Array.from({ length: n }, () => ({ x: r2(rand() * W), y: r2(rand() * H), r: r2(lo + rand() * (hi - lo)), o: r2(0.25 + rand() * 0.45) }));
}

/** Diagonal rain streaks as one path. */
export function rainPath(seed: number | string, o: { count?: number; w?: number; h?: number; slant?: number; len?: number } = {}): string {
  const rand = rng(seedOf(seed) ^ 0x68e31da4);
  const W = o.w ?? 100;
  const H = o.h ?? 100;
  const n = Math.round(clampNum(o.count ?? 40, 1, 200));
  const slant = o.slant ?? -0.25;
  const len = o.len ?? 9;
  let d = '';
  for (let i = 0; i < n; i += 1) {
    const x = rand() * W;
    const y = rand() * H;
    const l = len * (0.6 + rand() * 0.8);
    d += `M${r2(x)} ${r2(y)}l${r2(slant * l)} ${r2(l)}`;
  }
  return d;
}
