// Procedural print textures (assets.md §6; owner P1-LIBRARY): halftone, screentone, Ben-Day,
// raster lines, crosshatch, paper grain, riso grain, speed and focus lines. Free and instant,
// deterministic per seed, ≤ ~1.5 KB each. Two forms:
//   - tiles: tiny SVG documents as `data:` URLs / CSS backgrounds (reader page mat, swatches);
//   - geometry: plain numbers and path strings that React SVG (PresetThumb, BubblePreview) draws.
// Colours here are ART content (preset palettes, ink and paper), not UI chrome; chrome uses --ds-*.

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
const clamp = (n: number, lo: number, hi: number) => (Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : lo);
/** Escape an attribute value (colours come from presets, but never trust a string into markup). */
const attr = (v: string | number): string => String(v).replace(/[^#a-zA-Z0-9.,()% -]/g, '');

export interface TextureTile {
  /** The SVG document. */
  svg: string;
  /** Tile edge in px. */
  size: number;
  /** data: URL of the SVG. */
  url: string;
  /** CSS `background-image` value. */
  css: string;
}

const tile = (svg: string, size: number): TextureTile => {
  const url = `data:image/svg+xml,${encodeURIComponent(svg)}`;
  return { svg, size, url, css: `url("${url}")` };
};

const doc = (size: number, body: string, w = size, h = size) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${r2(w)}" height="${r2(h)}" viewBox="0 0 ${r2(w)} ${r2(h)}">${body}</svg>`;

// ── Dot and line screens ─────────────────────────────────────────────────────

export interface HalftoneOptions {
  /** Cell size in px (default 8). */
  cell?: number;
  /** Screen angle in degrees (default 45). */
  angle?: number;
  color?: string;
  opacity?: number;
  /** Dot radius as a fraction of the cell (default 0.32). */
  radius?: number;
}

/**
 * Screen directions whose lattice repeats exactly inside a square tile: tan θ = a/b with small
 * integers (0°, ±26.6°, ±45°, ±63.4°, 90°). A tile drawn on any other angle shows a seam every
 * repeat when it is used as a CSS background, so angles snap to the nearest of these.
 */
const SEAMLESS_DIRS: ReadonlyArray<readonly [number, number]> = [
  [1, 0],
  [2, 1],
  [1, 1],
  [1, 2],
  [0, 1]
];

/** The seamless direction (b, a) nearest `angleDeg`, and k = |(b, a)| (the tile holds k² lattice cells). */
export function seamlessDirection(angleDeg: number): { a: number; b: number; k: number; deg: number } {
  const t = clamp(angleDeg, -90, 90);
  let best: readonly [number, number] = SEAMLESS_DIRS[0];
  let err = Infinity;
  for (const d of SEAMLESS_DIRS) {
    const e = Math.abs((Math.atan2(d[1], d[0]) * 180) / Math.PI - Math.abs(t));
    if (e < err) {
      err = e;
      best = d;
    }
  }
  const a = t < 0 ? -best[1] : best[1];
  const b = best[0];
  return { a, b, k: Math.hypot(a, b), deg: r2((Math.atan2(a, b) * 180) / Math.PI) };
}

/**
 * Rotated dot screen (classic print halftone) as a SEAMLESS tile: the dot lattice is rotated to a
 * seamless direction and its spacing nudged so the tile edge is a whole number of pixels; dots
 * that cross an edge are drawn again on the opposite side.
 */
export function halftone(o: HalftoneOptions = {}): TextureTile {
  const want = clamp(o.cell ?? 8, 2, 64);
  const { a, b, k } = seamlessDirection(o.angle ?? 45);
  const T = Math.max(2, Math.round(want * k));
  const cell = T / k;
  const rad = clamp(o.radius ?? 0.32, 0.02, 0.7) * cell;
  const s = cell / k;
  // Lattice basis e1 = s(b, a), e2 = s(-a, b) (|e| = cell), offset so dots sit inside the tile
  // where they can (centred for 0°/90°, at the quarter points for 45°).
  const off = T / (2 * k * k);
  const wrap = (v: number) => {
    const m = ((v % T) + T) % T;
    return T - m < 1e-6 ? 0 : m;
  };
  const centres = new Map<string, [number, number]>();
  const n = Math.ceil(k) + 2;
  for (let i = -n; i <= n; i += 1) {
    for (let j = -n; j <= n; j += 1) {
      const x = wrap(off + s * (i * b - j * a));
      const y = wrap(off + s * (i * a + j * b));
      centres.set(`${r2(x)}:${r2(y)}`, [x, y]);
    }
  }
  // Every dot, plus its copy across each edge it crosses (so the repeat has no seam).
  const drawn = new Map<string, [number, number]>();
  for (const [x, y] of centres.values()) {
    for (const dx of [-T, 0, T]) {
      for (const dy of [-T, 0, T]) {
        const cx = x + dx;
        const cy = y + dy;
        if (cx + rad > 0 && cx - rad < T && cy + rad > 0 && cy - rad < T) drawn.set(`${r2(cx)}:${r2(cy)}`, [cx, cy]);
      }
    }
  }
  const dots = [...drawn.values()];
  const body =
    `<g fill="${attr(o.color ?? '#000000')}" fill-opacity="${r2(clamp(o.opacity ?? 0.35, 0, 1))}">` +
    dots.map(([x, y]) => `<circle cx="${r2(x)}" cy="${r2(y)}" r="${r2(rad)}"/>`).join('') +
    '</g>';
  return tile(doc(T, body), T);
}

/** Dot radius (fraction of the cell) that covers `level` % of the area. */
export const screentoneRadius = (level: number): number => Math.sqrt(clamp(level, 1, 78) / 100 / Math.PI);

/** Manga screentone at 10–60 % coverage (straight 45° dots, solid ink). */
export function screentone(level = 30, o: Omit<HalftoneOptions, 'radius'> = {}): TextureTile {
  return halftone({ cell: 6, angle: 45, opacity: 1, color: '#111111', ...o, radius: screentoneRadius(clamp(level, 10, 60)) });
}

/** Ben-Day dots: an offset (staggered) dot grid, the 1960s newsprint look. */
export function benDay(o: { color?: string; cell?: number; radius?: number; opacity?: number } = {}): TextureTile {
  const c = clamp(o.cell ?? 10, 4, 48);
  const r = clamp(o.radius ?? 0.26, 0.05, 0.5) * c;
  const fill = `fill="${attr(o.color ?? '#d62828')}" fill-opacity="${r2(clamp(o.opacity ?? 0.9, 0, 1))}"`;
  const body = `<circle cx="${r2(c / 4)}" cy="${r2(c / 4)}" r="${r2(r)}" ${fill}/><circle cx="${r2((c * 3) / 4)}" cy="${r2((c * 3) / 4)}" r="${r2(r)}" ${fill}/>`;
  return tile(doc(c, body), c);
}

/** Parallel raster lines (engraving / TV-scan feel), seamless at any snapped angle. */
export function rasterLines(o: { spacing?: number; angle?: number; color?: string; width?: number; opacity?: number } = {}): TextureTile {
  const want = clamp(o.spacing ?? 6, 2, 48);
  const { a, b, k } = seamlessDirection(o.angle ?? 0);
  const T = Math.max(2, Math.round(want * k));
  const sp = T / k;
  const w = clamp(o.width ?? 1, 0.25, sp);
  // Lines run along u = (b, a)/k, spaced sp along n = (-a, b)/k; the family repeats every T px.
  const ux = b / k;
  const uy = a / k;
  const nx = -a / k;
  const ny = b / k;
  const proj = [0, nx * T, ny * T, (nx + ny) * T];
  const lo = Math.floor(Math.min(...proj) / sp) - 1;
  const hi = Math.ceil(Math.max(...proj) / sp) + 1;
  const L = T * 2;
  let d = '';
  for (let m = lo; m <= hi; m += 1) {
    const off = (m + 0.5) * sp;
    const px = nx * off;
    const py = ny * off;
    d += `M${r2(px - ux * L)} ${r2(py - uy * L)}L${r2(px + ux * L)} ${r2(py + uy * L)}`;
  }
  const body = `<path d="${d}" fill="none" stroke="${attr(o.color ?? '#000000')}" stroke-width="${r2(w)}" stroke-opacity="${r2(clamp(o.opacity ?? 0.4, 0, 1))}"/>`;
  return tile(doc(T, body), T);
}

/** Two crossing hatch directions (pen-and-ink midtones). */
export function crosshatch(o: { spacing?: number; color?: string; width?: number; opacity?: number } = {}): TextureTile {
  const s = clamp(o.spacing ?? 7, 3, 40);
  const stroke = `stroke="${attr(o.color ?? '#000000')}" stroke-width="${r2(clamp(o.width ?? 0.8, 0.2, 4))}" stroke-opacity="${r2(clamp(o.opacity ?? 0.45, 0, 1))}"`;
  const body = `<path d="M0 ${r2(s)}L${r2(s)} 0M${r2(-s / 2)} ${r2(s / 2)}L${r2(s / 2)} ${r2(-s / 2)}M${r2(s / 2)} ${r2(s * 1.5)}L${r2(s * 1.5)} ${r2(s / 2)}" ${stroke}/><path d="M0 0L${r2(s)} ${r2(s)}" ${stroke}/>`;
  return tile(doc(s, body), s);
}

// ── Grain (feTurbulence) ─────────────────────────────────────────────────────

/** Paper grain: fractal noise tinted to a warm paper fibre (multiply it over a fill). */
export function paperGrain(seed: number | string = 1, o: { frequency?: number; opacity?: number; size?: number; tint?: string } = {}): TextureTile {
  const size = clamp(o.size ?? 160, 32, 512);
  const s = seedOf(seed) % 997;
  const body =
    `<filter id="g" x="0" y="0" width="100%" height="100%"><feTurbulence type="fractalNoise" baseFrequency="${r2(clamp(o.frequency ?? 0.9, 0.05, 3))}" numOctaves="3" seed="${s}" stitchTiles="stitch"/>` +
    `<feColorMatrix values="0 0 0 0 0.35  0 0 0 0 0.3  0 0 0 0 0.22  0 0 0 ${r2(clamp(o.opacity ?? 0.18, 0, 1))} 0"/></filter>` +
    `<rect width="100%" height="100%" fill="${attr(o.tint ?? 'transparent')}"/><rect width="100%" height="100%" filter="url(#g)"/>`;
  return tile(doc(size, body), size);
}

/** Riso grain: two speckled ink layers, slightly misregistered. */
export function risoGrain(inkA = '#ff48b0', inkB = '#00838a', offset = 2, seed: number | string = 7): TextureTile {
  const size = 140;
  const s = seedOf(seed) % 997;
  const layer = (id: string, ink: string, dx: number, sd: number) =>
    `<filter id="${id}"><feTurbulence type="fractalNoise" baseFrequency="1.4" numOctaves="2" seed="${sd}" stitchTiles="stitch"/><feComponentTransfer><feFuncA type="discrete" tableValues="0 0 0.55 0.85"/></feComponentTransfer><feFlood flood-color="${attr(ink)}"/><feComposite operator="in" in2="SourceGraphic"/></filter>` +
    `<rect x="${r2(dx)}" width="100%" height="100%" filter="url(#${id})" opacity="0.5"/>`;
  return tile(doc(size, layer('a', inkA, 0, s) + layer('b', inkB, clamp(offset, 0, 8), s + 13)), size);
}

// ── Motion lines (geometry for React SVG) ────────────────────────────────────

export interface Line {
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
export function speedLines(seed: number | string, cx: number, cy: number, o: { count?: number; w?: number; h?: number; inner?: number } = {}): Line[] {
  const rand = rng(seedOf(seed));
  const W = o.w ?? 100;
  const H = o.h ?? 100;
  const count = Math.round(clamp(o.count ?? 28, 4, 96));
  const reach = Math.hypot(W, H);
  const inner = clamp(o.inner ?? 0.32, 0.05, 0.9);
  const out: Line[] = [];
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
  const count = Math.round(clamp(o.count ?? 36, 6, 120));
  const reach = Math.hypot(W, H);
  const inner = clamp(o.inner ?? 0.36, 0.05, 0.9) * Math.min(W, H);
  let d = '';
  for (let i = 0; i < count; i += 1) {
    const a = (i / count) * Math.PI * 2 + rand() * 0.05;
    const spread = 0.012 + rand() * 0.022;
    const tip = inner * (0.9 + rand() * 0.35);
    d += `M${r2(cx + Math.cos(a) * tip)} ${r2(cy + Math.sin(a) * tip)}L${r2(cx + Math.cos(a - spread) * reach)} ${r2(cy + Math.sin(a - spread) * reach)}L${r2(cx + Math.cos(a + spread) * reach)} ${r2(cy + Math.sin(a + spread) * reach)}Z`;
  }
  return d;
}

/** Soft round "bokeh" lights (x, y, r, opacity) for glowing backgrounds. */
export function bokeh(seed: number | string, o: { count?: number; w?: number; h?: number; minR?: number; maxR?: number } = {}): { x: number; y: number; r: number; o: number }[] {
  const rand = rng(seedOf(seed) ^ 0x2545f491);
  const W = o.w ?? 100;
  const H = o.h ?? 100;
  const n = Math.round(clamp(o.count ?? 9, 1, 40));
  const lo = o.minR ?? 3;
  const hi = o.maxR ?? 11;
  return Array.from({ length: n }, () => ({ x: r2(rand() * W), y: r2(rand() * H), r: r2(lo + rand() * (hi - lo)), o: r2(0.25 + rand() * 0.45) }));
}

/** Diagonal rain streaks as one path. */
export function rainPath(seed: number | string, o: { count?: number; w?: number; h?: number; slant?: number; len?: number } = {}): string {
  const rand = rng(seedOf(seed) ^ 0x68e31da4);
  const W = o.w ?? 100;
  const H = o.h ?? 100;
  const n = Math.round(clamp(o.count ?? 40, 1, 200));
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

/** Relative luminance (0..1) of a '#rrggbb' colour; 0.5 for anything else. */
export function luminance(hex: string): number {
  const m = /^#?([0-9a-f]{6})$/i.exec((hex || '').trim());
  if (!m) return 0.5;
  const n = parseInt(m[1], 16);
  const ch = (v: number) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * ch((n >> 16) & 255) + 0.7152 * ch((n >> 8) & 255) + 0.0722 * ch(n & 255);
}

/** Mix two '#rrggbb' colours (t = 0 → a, 1 → b). */
export function mix(a: string, b: string, t: number): string {
  const pa = /^#?([0-9a-f]{6})$/i.exec(a || '');
  const pb = /^#?([0-9a-f]{6})$/i.exec(b || '');
  if (!pa || !pb) return pa ? `#${pa[1]}` : pb ? `#${pb[1]}` : '#808080';
  const x = parseInt(pa[1], 16);
  const y = parseInt(pb[1], 16);
  const k = clamp(t, 0, 1);
  const ch = (s: number) => Math.round(((x >> s) & 255) * (1 - k) + ((y >> s) & 255) * k);
  return `#${[16, 8, 0].map((s) => ch(s).toString(16).padStart(2, '0')).join('')}`;
}
