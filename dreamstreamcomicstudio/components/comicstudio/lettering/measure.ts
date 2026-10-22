// Text measuring for the lettering engine (client). `planLettering(doc, page, aspect, measure)` takes a
// Measure = (text, fontShorthand) → width in page units; the font's px value IS in page units (W = 1000),
// so a canvas measureText at that size returns page units directly.
//
// A face is measured with the canvas only once it has really loaded (fontLoader.isFontReady):
// measuring with a fallback face would size balloons for the wrong font. Until then — and on the
// server, in jsdom, or without a canvas — the registry-calibrated `estimateMeasure` is used, which is
// deliberately a little wide so balloons are never too small. Each font generation gets a NEW function
// identity, which is what invalidates planLettering's per-measure memo when real metrics arrive.

import { estimateMeasure, type Measure } from '../../../shared/comic/lettering/layout';
import { fontByFamily } from '../../../shared/comic/lettering/fonts';
import { isFontReady } from './fontLoader';

const FONT_RE = /^(italic\s+)?(?:(\d{3})\s+)?([\d.]+)px\s+"([^"]+)"/;

export interface ParsedFont {
  italic: boolean;
  weight: number;
  px: number;
  family: string;
}

/** Parse a lettering font shorthand ("italic 700 17px "DSL Comic Neue", …"). */
export const parseFont = (font: string): ParsedFont | null => {
  const m = FONT_RE.exec((font || '').trim());
  if (!m) return null;
  return { italic: !!m[1], weight: m[2] ? Number(m[2]) : 400, px: Number(m[3]), family: m[4] };
};

let sharedCtx: CanvasRenderingContext2D | null | undefined;
const canvasContext = (): CanvasRenderingContext2D | null => {
  if (sharedCtx !== undefined) return sharedCtx;
  sharedCtx = null;
  try {
    if (typeof document === 'undefined') return null;
    // jsdom prints "not implemented" for getContext; skip it there.
    if (typeof navigator !== 'undefined' && /jsdom/i.test(navigator.userAgent || '')) return null;
    const canvas = document.createElement('canvas');
    sharedCtx = canvas.getContext('2d');
  } catch {
    sharedCtx = null;
  }
  return sharedCtx;
};

/** True when the face named in `font` has loaded and can be measured for real. */
export const fontIsMeasurable = (font: string): boolean => {
  const p = parseFont(font);
  if (!p) return false;
  const meta = fontByFamily(p.family);
  return !!meta && isFontReady(meta.id, p.weight, p.italic);
};

const CACHE_MAX = 4000;

/**
 * A fresh Measure: canvas metrics for loaded faces, estimates otherwise. Pass `ready` to override the
 * readiness check (tests); pass `ctx` to supply a context.
 */
export function createMeasure(opts: { ready?: (font: string) => boolean; ctx?: CanvasRenderingContext2D | null } = {}): Measure {
  const ready = opts.ready ?? fontIsMeasurable;
  const cache = new Map<string, number>();
  return (text: string, font: string): number => {
    if (!text) return 0;
    const key = `${font}\u0000${text}`;
    const hit = cache.get(key);
    if (hit !== undefined) return hit;
    let width: number | undefined;
    const ctx = opts.ctx !== undefined ? opts.ctx : canvasContext();
    if (ctx && ready(font)) {
      try {
        ctx.font = font;
        const w = ctx.measureText(text).width;
        if (Number.isFinite(w) && w > 0) width = w;
      } catch {
        width = undefined;
      }
    }
    if (width === undefined) width = estimateMeasure(text, font);
    if (cache.size >= CACHE_MAX) {
      const oldest = cache.keys().next().value;
      if (oldest !== undefined) cache.delete(oldest);
    }
    cache.set(key, width);
    return width;
  };
}

let current: { generation: number; measure: Measure } | null = null;
/** One shared Measure per font generation (stable identity → planLettering memo hits across components). */
export function measureForGeneration(generation: number): Measure {
  if (!current || current.generation !== generation) current = { generation, measure: createMeasure() };
  return current.measure;
}
