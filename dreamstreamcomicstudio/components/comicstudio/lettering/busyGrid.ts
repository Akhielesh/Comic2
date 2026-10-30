// The free busy-area grid (investigation FX3b): a coarse map of where a drawn page is detailed (faces, hands, props,
// texture) and where it is calm (sky, walls, floor, gutters), computed in the browser from a small copy of the page
// image — no AI call, no upload, nothing stored. When a page has no face data (every page checked before faces were
// measured), the placement reads these cells as busy areas (below faces), so a re-lettered balloon goes to calm
// parts of the art instead of the panel's top-left corner. Old comics use it only when the user asks for it
// ("Place around the art · Free"); the paid re-check (recheck_page, ≈$0.004) reads faces exactly.
//
// Pure core (`busyCellsFromPixels`, tested) + a browser loader (`loadBusyGrid`, memoized per image URL, fails soft:
// a cross-origin image the canvas may not read gives no cells, never an error).

import type { Balloon, Box, ComicDoc, Page } from '../../../shared/comic/doc';
import type { DocOp } from '../../../shared/comic/ops';
import { panelBoxesFor } from '../../../shared/comic/pageGeometry';
import { letteringSizer, placementCoverOptions, type Measure } from '../../../shared/comic/lettering/layout';
import { placeBalloonsWholeWords } from '../../../shared/comic/lettering/place';
import { DEFAULT_LETTERING, DEFAULT_SAFE_MARGIN } from '../../../shared/comic/lettering/style';

export interface BusyGridOptions {
  /** Grid columns (default 24); rows follow the image's aspect (about square cells). */
  cols?: number;
  /** A cell is busy when its detail is at or above this share of the page's cells (default 0.6: the busiest 40 %). */
  quantile?: number;
  /** …and at least this much detail (mean luminance step between neighbouring pixels, 0–255; default 6): a flat page has no busy cells. */
  minDetail?: number;
}

/** Busy cells merged into row runs, as page fractions. At most the busiest 40 % of the page (default). */
export function busyCellsFromPixels(data: ArrayLike<number>, width: number, height: number, opts: BusyGridOptions = {}): Box[] {
  const w = Math.floor(width);
  const h = Math.floor(height);
  if (!(w >= 2 && h >= 2) || data.length < w * h * 4) return [];
  const cols = Math.max(2, Math.min(64, Math.round(opts.cols ?? 24)));
  const rows = Math.max(2, Math.min(96, Math.round((cols * h) / w)));
  const quantile = Math.min(0.95, Math.max(0.2, opts.quantile ?? 0.6));
  const minDetail = Math.max(0, opts.minDetail ?? 6);
  // Luminance (Rec. 601) per pixel.
  const lum = new Float32Array(w * h);
  for (let i = 0, p = 0; i < w * h; i += 1, p += 4) lum[i] = 0.299 * data[p] + 0.587 * data[p + 1] + 0.114 * data[p + 2];
  // Detail per cell: the mean absolute luminance step to the right and below neighbours (an edge density).
  const sum = new Float64Array(cols * rows);
  const count = new Uint32Array(cols * rows);
  for (let y = 0; y < h - 1; y += 1) {
    const r = Math.min(rows - 1, Math.floor((y * rows) / h));
    for (let x = 0; x < w - 1; x += 1) {
      const c = Math.min(cols - 1, Math.floor((x * cols) / w));
      const i = y * w + x;
      const k = r * cols + c;
      sum[k] += Math.abs(lum[i + 1] - lum[i]) + Math.abs(lum[i + w] - lum[i]);
      count[k] += 1;
    }
  }
  const detail = Array.from(sum, (s, k) => (count[k] ? s / count[k] : 0));
  const sorted = [...detail].sort((a, b) => a - b);
  const cut = Math.max(minDetail, sorted[Math.min(sorted.length - 1, Math.floor(quantile * sorted.length))]);
  const out: Box[] = [];
  const r4 = (n: number) => Math.round(n * 10000) / 10000;
  for (let r = 0; r < rows; r += 1) {
    let start = -1;
    for (let c = 0; c <= cols; c += 1) {
      const busy = c < cols && detail[r * cols + c] >= cut && detail[r * cols + c] > 0;
      if (busy && start < 0) start = c;
      if (!busy && start >= 0) {
        out.push({ x: r4(start / cols), y: r4(r / rows), w: r4((c - start) / cols), h: r4(1 / rows) });
        start = -1;
      }
    }
  }
  return out;
}

/** The longest side of the copy the grid reads (px): enough for a 24-column grid, a few ms of canvas work. */
export const BUSY_GRID_SIDE = 160;

const CACHE = new Map<string, Promise<Box[]>>();
const CACHE_SIZE = 24;

/**
 * Busy cells of the image at `url` (memoized per URL). Resolves to [] when the image cannot be loaded or read (a
 * cross-origin image without CORS taints the canvas): the caller then places without them, honestly.
 */
export function loadBusyGrid(url: string | undefined, opts: BusyGridOptions = {}): Promise<Box[]> {
  if (!url || typeof document === 'undefined' || typeof Image === 'undefined') return Promise.resolve([]);
  const key = `${url}|${opts.cols ?? ''}|${opts.quantile ?? ''}|${opts.minDetail ?? ''}`;
  const hit = CACHE.get(key);
  if (hit) return hit;
  const job = new Promise<Box[]>((resolve) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.decoding = 'async';
    img.onload = () => {
      try {
        const scale = Math.min(1, BUSY_GRID_SIDE / Math.max(img.naturalWidth || 1, img.naturalHeight || 1));
        const w = Math.max(2, Math.round((img.naturalWidth || 1) * scale));
        const h = Math.max(2, Math.round((img.naturalHeight || 1) * scale));
        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext('2d', { willReadFrequently: true } as CanvasRenderingContext2DSettings);
        if (!ctx) return resolve([]);
        ctx.drawImage(img, 0, 0, w, h);
        resolve(busyCellsFromPixels(ctx.getImageData(0, 0, w, h).data, w, h, opts));
      } catch {
        resolve([]);
      }
    };
    img.onerror = () => resolve([]);
    img.src = url;
  });
  CACHE.set(key, job);
  if (CACHE.size > CACHE_SIZE) {
    const oldest = CACHE.keys().next().value;
    if (oldest !== undefined) CACHE.delete(oldest);
  }
  // A failed read is not remembered: the next ask tries again.
  void job.then((cells) => {
    if (!cells.length) CACHE.delete(key);
  });
  return job;
}

/**
 * "Place around the art · Free": the page's unpinned balloons placed again (pinned and locked ones stay), around the
 * stored face data when the page has it and around the busy cells, under the coverage cap — what the placement saves
 * everywhere else (placeBalloonsWholeWords). One `balloons` op, or [] when nothing would move.
 */
export function reletterAroundArtOps(doc: ComicDoc, page: Page, aspect: number, measure: Measure, busy: readonly Box[]): DocOp[] {
  const ls = doc.letterStyle ?? DEFAULT_LETTERING;
  const qc = page.render?.qc;
  const result = placeBalloonsWholeWords({
    page,
    boxes: panelBoxesFor(doc, page),
    aspect,
    rtl: doc.format?.readingDirection === 'rtl',
    plansFor: letteringSizer(doc, page, aspect, measure),
    keepOut: qc?.keepOut,
    heads: qc?.heads,
    safeMargin: typeof ls.safeMargin === 'number' ? ls.safeMargin : DEFAULT_SAFE_MARGIN,
    existing: page.balloons || [],
    keep: 'pinned',
    lang: doc.format?.language,
    ...placementCoverOptions(doc),
    ...(busy.length ? { busy } : {})
  });
  // A re-placed balloon keeps its z, lock and link; balloons of lines with no text stay as stored.
  const prev = new Map((page.balloons || []).map((b) => [b.lineId, b]));
  const balloons: Balloon[] = result.balloons.map((b) => {
    const p = prev.get(b.lineId);
    if (!p) return b;
    const out: Balloon = { ...b };
    if (p.z !== undefined) out.z = p.z;
    if (p.locked) out.locked = true;
    if (p.linkTo) out.linkTo = p.linkTo;
    return out;
  });
  const placed = new Set(balloons.map((b) => b.lineId));
  for (const b of page.balloons || []) {
    if (placed.has(b.lineId)) continue;
    placed.add(b.lineId);
    balloons.push(b);
  }
  const key = (b: Balloon) => JSON.stringify([b.x, b.y, b.w, b.tailX, b.tailY, b.pinned, b.locked, b.z, b.linkTo]);
  const before = new Map((page.balloons || []).map((b) => [b.lineId, key(b)]));
  const same = before.size === balloons.length && balloons.every((b) => before.get(b.lineId) === key(b));
  return same ? [] : [{ op: 'balloons', pageId: page.id, balloons }];
}

/**
 * Whether a page's stored check looked for faces (then the free placement already avoids any it found, and a paid
 * re-check would only say the same again): its `keepOut` or `heads` is there, even empty — a page with no face in
 * it (scenery, a back view) is measured too. A check that never asked has neither.
 */
export const hasFaceData = (page: Pick<Page, 'render'>): boolean => {
  const qc = page.render?.qc;
  return Array.isArray(qc?.keepOut) || Array.isArray(qc?.heads);
};
