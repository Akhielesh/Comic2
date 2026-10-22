// Ambient room colour (reader.md §6.2). $0: a 32×32 downscale of the page the reader already loaded,
// a 4-bit-per-channel histogram, and a weight that favours saturated mid-tones so paper white and ink
// black never win. The room glows faintly with the page's colours; HUD chips stay dark glass, so
// contrast never depends on the tint.

export interface RGB {
  r: number;
  g: number;
  b: number;
}

export interface Palette {
  dominant: RGB;
  accent: RGB;
  /** Mean luminance of the page, 0..1. */
  lum: number;
  /** No colourful content (a grey or line-art page): the room stays neutral. */
  neutral: boolean;
}

export const NEUTRAL_RGB: RGB = { r: 92, g: 84, b: 76 };

const clamp01 = (n: number) => Math.min(1, Math.max(0, n));

const toHsl = (r: number, g: number, b: number): { h: number; s: number; l: number } => {
  const R = r / 255;
  const G = g / 255;
  const B = b / 255;
  const max = Math.max(R, G, B);
  const min = Math.min(R, G, B);
  const l = (max + min) / 2;
  const d = max - min;
  if (d < 1e-6) return { h: 0, s: 0, l };
  const s = d / (1 - Math.abs(2 * l - 1));
  let h: number;
  if (max === R) h = ((G - B) / d) % 6;
  else if (max === G) h = (B - R) / d + 2;
  else h = (R - G) / d + 4;
  return { h: (h * 60 + 360) % 360, s: clamp01(s), l };
};

const fromHsl = (h: number, s: number, l: number): RGB => {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  const [r, g, b] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  return { r: Math.round((r + m) * 255), g: Math.round((g + m) * 255), b: Math.round((b + m) * 255) };
};

/** Keep a tint usable as a glow: never near-white or near-black. */
const tame = (c: RGB): RGB => {
  const { h, s, l } = toHsl(c.r, c.g, c.b);
  return fromHsl(h, Math.min(0.85, s), Math.min(0.68, Math.max(0.24, l)));
};

const hueDistance = (a: number, b: number) => {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
};

/** Palette of an RGBA buffer (any size; the reader feeds a 32×32 downscale). */
export function extractPalette(rgba: Uint8ClampedArray, w: number, h: number): Palette {
  const n = Math.min(w * h, Math.floor(rgba.length / 4));
  const weight = new Float64Array(4096);
  const sumR = new Float64Array(4096);
  const sumG = new Float64Array(4096);
  const sumB = new Float64Array(4096);
  let lumSum = 0;
  let counted = 0;
  let totalWeight = 0;
  for (let i = 0; i < n; i += 1) {
    const o = i * 4;
    if (rgba[o + 3] < 128) continue;
    const r = rgba[o];
    const g = rgba[o + 1];
    const b = rgba[o + 2];
    counted += 1;
    lumSum += (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
    const { s, l } = toHsl(r, g, b);
    const wgt = s * Math.max(0, 1 - Math.abs(l - 0.5) * 1.6);
    if (wgt <= 0) continue;
    const bucket = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4);
    weight[bucket] += wgt;
    sumR[bucket] += r * wgt;
    sumG[bucket] += g * wgt;
    sumB[bucket] += b * wgt;
    totalWeight += wgt;
  }
  const lum = counted ? lumSum / counted : 0.5;
  // A page with (almost) no colour — greyscale or line art — keeps the room neutral.
  if (!counted || totalWeight / counted < 0.03) return { dominant: NEUTRAL_RGB, accent: NEUTRAL_RGB, lum, neutral: true };
  let top = 0;
  for (let i = 1; i < 4096; i += 1) if (weight[i] > weight[top]) top = i;
  // Dominant = weighted mean of the top bucket's 3×3×3 neighbourhood (smooths bucket edges).
  const tr = top >> 8;
  const tg = (top >> 4) & 15;
  const tb = top & 15;
  let wsum = 0;
  let rs = 0;
  let gs = 0;
  let bs = 0;
  for (let dr = -1; dr <= 1; dr += 1)
    for (let dg = -1; dg <= 1; dg += 1)
      for (let db = -1; db <= 1; db += 1) {
        const R = tr + dr;
        const G = tg + dg;
        const B = tb + db;
        if (R < 0 || G < 0 || B < 0 || R > 15 || G > 15 || B > 15) continue;
        const k = (R << 8) | (G << 4) | B;
        wsum += weight[k];
        rs += sumR[k];
        gs += sumG[k];
        bs += sumB[k];
      }
  const dominantRaw = { r: rs / wsum, g: gs / wsum, b: bs / wsum };
  const domHue = toHsl(dominantRaw.r, dominantRaw.g, dominantRaw.b).h;
  // Accent: the strongest bucket at least 60° of hue away from the dominant.
  let accentIdx = -1;
  for (let i = 0; i < 4096; i += 1) {
    if (weight[i] <= 0) continue;
    const c = { r: sumR[i] / weight[i], g: sumG[i] / weight[i], b: sumB[i] / weight[i] };
    if (hueDistance(toHsl(c.r, c.g, c.b).h, domHue) < 60) continue;
    if (accentIdx < 0 || weight[i] > weight[accentIdx]) accentIdx = i;
  }
  const accentRaw = accentIdx >= 0 ? { r: sumR[accentIdx] / weight[accentIdx], g: sumG[accentIdx] / weight[accentIdx], b: sumB[accentIdx] / weight[accentIdx] } : dominantRaw;
  return { dominant: tame(dominantRaw), accent: tame(accentRaw), lum, neutral: false };
}

/** Mean of several palettes (a spread shows two pages). */
export const averagePalette = (ps: (Palette | null | undefined)[]): Palette | null => {
  const list = ps.filter((p): p is Palette => !!p);
  if (!list.length) return null;
  const colourful = list.filter((p) => !p.neutral);
  const use = colourful.length ? colourful : list;
  const mean = (pick: (p: Palette) => RGB): RGB => ({
    r: Math.round(use.reduce((a, p) => a + pick(p).r, 0) / use.length),
    g: Math.round(use.reduce((a, p) => a + pick(p).g, 0) / use.length),
    b: Math.round(use.reduce((a, p) => a + pick(p).b, 0) / use.length)
  });
  return { dominant: mean((p) => p.dominant), accent: mean((p) => p.accent), lum: list.reduce((a, p) => a + p.lum, 0) / list.length, neutral: !colourful.length };
};

const rgbA = (c: RGB, a: number) => `rgba(${c.r},${c.g},${c.b},${a})`;

/** The room background layers for a palette (falls back to the plain room colour). */
export const roomBackground = (p: Palette | null | undefined): string => {
  if (!p || p.neutral) return 'radial-gradient(120% 90% at 50% 42%, rgba(255,240,220,0.05), transparent 70%), var(--ds-reader-room)';
  return `radial-gradient(120% 90% at 50% 42%, ${rgbA(p.dominant, 0.26)}, transparent 70%), radial-gradient(70% 55% at 85% 95%, ${rgbA(p.accent, 0.16)}, transparent 70%), var(--ds-reader-room)`;
};

/** A colour for `<meta name="theme-color">` while the reader is open (the room, faintly tinted). */
export const themeColorFor = (p: Palette | null | undefined): string => {
  if (!p || p.neutral) return '#0e0d0c';
  const mix = (c: number, base: number) => Math.round(base + (c - base) * 0.12);
  const hex = (n: number) => n.toString(16).padStart(2, '0');
  return `#${hex(mix(p.dominant.r, 14))}${hex(mix(p.dominant.g, 13))}${hex(mix(p.dominant.b, 12))}`;
};

/**
 * Palette from an image blob via a 32×32 bitmap. Null when the browser can't (no createImageBitmap or
 * canvas), so the room simply stays plain. Never throws.
 */
export async function paletteFromBlob(blob: Blob): Promise<Palette | null> {
  try {
    if (typeof createImageBitmap !== 'function') return null;
    const bmp = await createImageBitmap(blob, { resizeWidth: 32, resizeHeight: 32, resizeQuality: 'low' });
    try {
      let ctx: OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D | null = null;
      if (typeof OffscreenCanvas === 'function') ctx = new OffscreenCanvas(32, 32).getContext('2d');
      else if (typeof document !== 'undefined') {
        const c = document.createElement('canvas');
        c.width = 32;
        c.height = 32;
        ctx = c.getContext('2d');
      }
      if (!ctx) return null;
      ctx.drawImage(bmp, 0, 0, 32, 32);
      const data = ctx.getImageData(0, 0, 32, 32).data;
      return extractPalette(data, 32, 32);
    } finally {
      bmp.close?.();
    }
  } catch {
    return null;
  }
}
