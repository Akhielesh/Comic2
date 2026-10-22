// Deterministic image measurement, $0 (contract §12.8, assets.md §4.2), plus the one sharp
// concurrency gate every Comic Studio image pipeline shares (assets.ts, derive.ts, the library
// pipeline). Owned by P1-STORAGE.
//
// Memory: the backend is a single 1 GiB container with a 512 MB Node heap. libvips allocates
// outside the heap, so the only reliable bound is how many decodes run at once — at most
// SHARP_SLOTS (3); everything else waits in a FIFO queue. Every pipeline here also decodes with
// `limitInputPixels`, so a tiny, highly-compressible file can never expand to gigabytes.

import sharp from 'sharp';
import { aspectFromSize, aspectRatioOf } from '../../../shared/comic/models.js';
import type { AspectRatio } from '../../../shared/comic/doc.js';
import { StudioError } from './types.js';

// ── Decode limits (shared by every sharp call in the studio) ─────────────────

/** 50 MP comfortably covers 4K renders (≈16 MP) and phone photos. */
export const MAX_INPUT_PIXELS = 50_000_000;
/** Longest source edge any decode accepts. */
export const MAX_SOURCE_EDGE = 12_000;
/** Options for every `sharp(input, …)` call: tolerant of truncated tails, hard pixel cap. */
export const SHARP_INPUT = { failOn: 'none' as const, limitInputPixels: MAX_INPUT_PIXELS };

// ── Sharp concurrency gate ───────────────────────────────────────────────────

/** Concurrent sharp pipelines allowed in this process. */
export const SHARP_SLOTS = 3;

let active = 0;
let peak = 0;
const waiters: (() => void)[] = [];

/**
 * Run one sharp pipeline while holding a slot of the 3-slot gate. FIFO; a failure always
 * releases its slot. NEVER call withSharpSlot from inside another withSharpSlot callback (three
 * nested holders would wait on each other forever): gate leaf pipelines only.
 */
export async function withSharpSlot<T>(work: () => Promise<T>): Promise<T> {
  if (active >= SHARP_SLOTS) await new Promise<void>((resolve) => waiters.push(resolve));
  else active += 1;
  peak = Math.max(peak, active);
  try {
    return await work();
  } finally {
    const next = waiters.shift();
    // Hand the slot straight to the next waiter (active stays the same), or free it.
    if (next) next();
    else active -= 1;
  }
}

/** Gate statistics (tests, diagnostics). */
export const sharpSlotStats = (): { active: number; queued: number; peak: number } => ({ active, queued: waiters.length, peak });

/** Test hook: reset the peak counter. */
export const __resetSharpSlotPeakForTests = (): void => {
  peak = active;
};

// ── Measurement ──────────────────────────────────────────────────────────────

export interface ImageMeasure {
  w: number;
  h: number;
  bytes: number;
  aspectWanted: AspectRatio;
  aspectActual: number;
  /** |log(actual / wanted)| */
  aspectError: number;
  /** aspectError < 0.04 (≈ 4 %). */
  aspectOk: boolean;
  /** 0..1 */
  meanLuma: number;
  /** Blank / near-uniform detection (0..1 scale, standard deviation of luma). */
  lumaStdev: number;
  /** lumaStdev < 0.02 (never for texture seeds). */
  blank: boolean;
  /** Up to 5 hex colours by share (median cut on a 64×64 downscale), most common first. */
  palette: string[];
  /** Texture tiles only: mean |left−right| and |top−bottom| edge difference, 0..1 (0 = seamless). */
  edgeSeamDelta?: number;
}

/** Aspect error under which an image counts as the requested shape. */
export const ASPECT_OK_ERROR = 0.04;
/** Luma standard deviation under which an image counts as blank. */
export const BLANK_LUMA_STDEV = 0.02;
const SAMPLE_EDGE = 64;
const PALETTE_SIZE = 5;

/** Rec. 601 luma of an 8-bit RGB triple, 0..1. */
const luma = (r: number, g: number, b: number): number => (0.299 * r + 0.587 * g + 0.114 * b) / 255;

const hex2 = (n: number): string => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0');
export const rgbHex = (r: number, g: number, b: number): string => `#${hex2(r)}${hex2(g)}${hex2(b)}`;

type Box3 = { px: number[]; lo: [number, number, number]; hi: [number, number, number] };

const boxOf = (px: number[], rgb: Uint8Array): Box3 => {
  const lo: [number, number, number] = [255, 255, 255];
  const hi: [number, number, number] = [0, 0, 0];
  for (const i of px) {
    for (let c = 0; c < 3; c += 1) {
      const v = rgb[i * 3 + c];
      if (v < lo[c]) lo[c] = v;
      if (v > hi[c]) hi[c] = v;
    }
  }
  return { px, lo, hi };
};

/**
 * Median-cut palette of packed RGB pixels: repeatedly split the box with the widest channel range
 * at its median until `size` boxes exist (or nothing can be split). Each box's mean colour is one
 * entry; entries are sorted by pixel share and de-duplicated. Deterministic.
 */
export function medianCutPalette(rgb: Uint8Array, size = PALETTE_SIZE): string[] {
  const count = Math.floor(rgb.length / 3);
  if (!count) return [];
  const boxes: Box3[] = [boxOf(Array.from({ length: count }, (_, i) => i), rgb)];
  while (boxes.length < size) {
    let pick = -1;
    let widest = 0;
    let channel = 0;
    boxes.forEach((b, i) => {
      if (b.px.length < 2) return;
      for (let c = 0; c < 3; c += 1) {
        const range = b.hi[c] - b.lo[c];
        if (range > widest) {
          widest = range;
          pick = i;
          channel = c;
        }
      }
    });
    if (pick < 0 || widest === 0) break;
    const box = boxes[pick];
    const sorted = box.px.slice().sort((a, b) => rgb[a * 3 + channel] - rgb[b * 3 + channel] || a - b);
    // Cut at the value boundary nearest the median, so one flat colour is never split in two.
    const mid = Math.floor(sorted.length / 2);
    const v = (k: number) => rgb[sorted[k] * 3 + channel];
    let cut = -1;
    for (let d = 0; d < sorted.length; d += 1) {
      const lo = mid - d;
      const hi = mid + d;
      if (lo > 0 && v(lo - 1) !== v(lo)) {
        cut = lo;
        break;
      }
      if (hi > 0 && hi < sorted.length && v(hi - 1) !== v(hi)) {
        cut = hi;
        break;
      }
    }
    if (cut <= 0) break;
    boxes.splice(pick, 1, boxOf(sorted.slice(0, cut), rgb), boxOf(sorted.slice(cut), rgb));
  }
  const entries = boxes
    .filter((b) => b.px.length)
    .map((b) => {
      let r = 0;
      let g = 0;
      let bl = 0;
      for (const i of b.px) {
        r += rgb[i * 3];
        g += rgb[i * 3 + 1];
        bl += rgb[i * 3 + 2];
      }
      const n = b.px.length;
      return { hex: rgbHex(r / n, g / n, bl / n), share: n };
    })
    .sort((a, b) => b.share - a.share || a.hex.localeCompare(b.hex));
  // Fold near-identical colours (anti-aliased edges) into the more common one.
  const out: string[] = [];
  const dist = (x: string, y: string) =>
    [1, 3, 5].reduce((n, i) => n + Math.abs(parseInt(x.slice(i, i + 2), 16) - parseInt(y.slice(i, i + 2), 16)), 0);
  for (const e of entries) if (!out.some((hex) => dist(hex, e.hex) < 12)) out.push(e.hex);
  return out.slice(0, size);
}

/** Mean absolute difference (0..1) between opposite edges of a square RGB sample (tileability). */
const edgeSeam = (rgb: Uint8Array, edge: number): number => {
  let sum = 0;
  let n = 0;
  for (let i = 0; i < edge; i += 1) {
    for (let c = 0; c < 3; c += 1) {
      // left vs right column, row i
      sum += Math.abs(rgb[(i * edge) * 3 + c] - rgb[(i * edge + edge - 1) * 3 + c]);
      // top vs bottom row, column i
      sum += Math.abs(rgb[i * 3 + c] - rgb[((edge - 1) * edge + i) * 3 + c]);
      n += 2;
    }
  }
  return n ? sum / n / 255 : 0;
};

/**
 * Real size, aspect check, luma statistics (blank detection), a 5-colour palette and, for texture
 * tiles, the edge seam delta. One gated sharp pass on a 64×64 downscale (alpha flattened on white),
 * so it costs a few milliseconds regardless of the source size. Unreadable input → 400.
 */
export async function measureImage(buffer: Buffer, want?: AspectRatio, opts?: { texture?: boolean }): Promise<ImageMeasure> {
  if (!Buffer.isBuffer(buffer) || !buffer.byteLength) {
    throw new StudioError('BAD_REQUEST', "That file isn't a readable image.", { status: 400 });
  }
  const sample = await withSharpSlot(async () => {
    try {
      const meta = await sharp(buffer, SHARP_INPUT).metadata();
      const w = meta.width || 0;
      const h = meta.height || 0;
      if (!w || !h) return null;
      const { data } = await sharp(buffer, SHARP_INPUT)
        .flatten({ background: '#ffffff' })
        .resize(SAMPLE_EDGE, SAMPLE_EDGE, { fit: 'fill' })
        .removeAlpha()
        .toColourspace('srgb')
        .raw()
        .toBuffer({ resolveWithObject: true });
      return { w, h, rgb: new Uint8Array(data.buffer, data.byteOffset, data.byteLength) };
    } catch (err) {
      if (/pixel limit/i.test(String((err as Error)?.message))) {
        throw new StudioError('BAD_REQUEST', 'That image is too large in pixels (over 50 megapixels).', { status: 413, cause: err });
      }
      throw new StudioError('BAD_REQUEST', "That file isn't a readable image.", { status: 400, cause: err });
    }
  });
  if (!sample) throw new StudioError('BAD_REQUEST', "That file isn't a readable image.", { status: 400 });
  const { w, h, rgb } = sample;

  const pixels = Math.floor(rgb.length / 3);
  let sum = 0;
  let sumSq = 0;
  for (let i = 0; i < pixels; i += 1) {
    const y = luma(rgb[i * 3], rgb[i * 3 + 1], rgb[i * 3 + 2]);
    sum += y;
    sumSq += y * y;
  }
  const meanLuma = pixels ? sum / pixels : 0;
  const lumaStdev = pixels ? Math.sqrt(Math.max(0, sumSq / pixels - meanLuma * meanLuma)) : 0;

  const aspectWanted = want ?? aspectFromSize(w, h);
  const aspectActual = w / h;
  const aspectError = Math.abs(Math.log(aspectActual / aspectRatioOf(aspectWanted)));
  const round4 = (n: number) => Math.round(n * 10000) / 10000;
  const out: ImageMeasure = {
    w,
    h,
    bytes: buffer.byteLength,
    aspectWanted,
    aspectActual: round4(aspectActual),
    aspectError: round4(aspectError),
    aspectOk: aspectError < ASPECT_OK_ERROR,
    meanLuma: round4(meanLuma),
    lumaStdev: round4(lumaStdev),
    blank: !opts?.texture && lumaStdev < BLANK_LUMA_STDEV,
    palette: medianCutPalette(rgb)
  };
  if (opts?.texture) out.edgeSeamDelta = round4(edgeSeam(rgb, SAMPLE_EDGE));
  return out;
}
