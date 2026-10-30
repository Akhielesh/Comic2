// Page layout guide (plan §4.2 Ship 1, conflict C9; package A2).
//
// A flat PNG of the page's panel boxes at the job's aspect: black panel borders, white gutters
// and page margin, a near-white fill inside each panel, and NOTHING else — no numbers, no
// labels, no anti-aliasing — so the image model has nothing to copy into the art except the
// borders. compilePage attaches it as Image 1 ("PAGE LAYOUT GUIDE", path LAYOUT_REFERENCE_PATH)
// when the job runner passes `layoutGuide`; the runner renders it here at prepare time and
// substitutes the placeholder, exactly as it does for `__region__`. Nothing is stored. The runner
// uses tryRenderPageLayoutGuide: a guide that cannot be drawn drops the guide, never the page job.
//
// Flag: COMIC_LAYOUT_GUIDE, OFF until the owner-approved Model Lab A/B (decision 1, PD-8).
// The boxes are pageLayoutBoxes(doc, page) — the same rectangles the prompt's "box N" and
// "Measured proportions" lines describe, so words and guide never disagree.

import sharp from 'sharp';
import type { AspectRatio, Box, ComicDoc, Page, Resolution } from '../../../../shared/comic/doc.js';
import { aspectRatioOf } from '../../../../shared/comic/models.js';
import { logger } from '../../lib/logger.js';
import { withSharpSlot } from '../imageMeasure.js';
import { LAYOUT_GUIDE_LABEL, LAYOUT_REFERENCE_PATH, pageLayoutBoxes } from '../prompts.js';
import { StudioError } from '../types.js';

export { LAYOUT_GUIDE_LABEL, LAYOUT_REFERENCE_PATH };

/** The server flag that turns the guide on (container env). */
export const COMIC_LAYOUT_GUIDE_FLAG = 'COMIC_LAYOUT_GUIDE';

/**
 * PROVISIONAL DEFAULT: off. The guide stays off until the owner approves the paid A/B test
 * drawings (plan §4.8, §12 decision 1); turning it on is one env var, `COMIC_LAYOUT_GUIDE=1`.
 */
export const layoutGuideEnabled = (env: Record<string, string | undefined> = process.env): boolean =>
  /^(?:1|true|on)$/i.test((env[COMIC_LAYOUT_GUIDE_FLAG] || '').trim());

/** Grey levels (all three channels equal). */
export const GUIDE_BORDER = 0;
export const GUIDE_FILL = 245;
export const GUIDE_GUTTER = 255;
/** Default border width: 0.4% of the page width (the design's default frame stroke). */
export const GUIDE_STROKE = 0.004;
/** The guide never needs more than 2K pixels on its long edge (a 4K job gets a 2K guide). */
export const GUIDE_MAX_EDGE = 2048;

const LONG_EDGE: Record<Resolution, number> = { '512': 512, '1K': 1024, '2K': 2048, '4K': 4096 };

/** Optional frame style: `stroke` is the border width as a fraction of the page width (0 < stroke ≤ 0.05). */
export interface GuideFrameStyle {
  stroke?: number;
}

/** One panel rectangle in guide pixels; right and bottom are exclusive. */
export interface GuideRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface LayoutGuideImage {
  width: number;
  height: number;
  /** Border width in pixels. */
  stroke: number;
  /** The drawn panel rectangles (reading order of the valid boxes). */
  rects: GuideRect[];
  mimeType: 'image/png';
  buffer: Buffer;
  dataUrl: string;
}

/** Pixel size for an aspect at a resolution class: the long edge follows the class (capped at 2K). */
export const layoutGuideSize = (aspect: AspectRatio, res: Resolution): { width: number; height: number } => {
  const long = Math.min(LONG_EDGE[res] || LONG_EDGE['1K'], GUIDE_MAX_EDGE);
  const ratio = aspectRatioOf(aspect);
  return ratio >= 1
    ? { width: long, height: Math.max(1, Math.round(long / ratio)) }
    : { width: Math.max(1, Math.round(long * ratio)), height: long };
};

/** Border width in pixels (≥ 2 so the line survives the model's own downscaling). */
export const guideStrokePx = (width: number, frameStyle?: GuideFrameStyle): number => {
  const s = frameStyle?.stroke;
  const frac = typeof s === 'number' && Number.isFinite(s) && s > 0 && s <= 0.05 ? s : GUIDE_STROKE;
  return Math.max(2, Math.round(width * frac));
};

const finite = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);
const clamp01 = (n: number) => Math.min(1, Math.max(0, n));

/**
 * Page-normalized boxes → pixel rectangles. Invalid boxes are skipped; boxes are clamped to the
 * page; a rectangle too small to hold its own borders is dropped.
 */
export const guideRects = (boxes: readonly Box[], width: number, height: number, stroke: number): GuideRect[] => {
  const out: GuideRect[] = [];
  for (const b of boxes || []) {
    if (!b || ![b.x, b.y, b.w, b.h].every(finite) || b.w <= 0 || b.h <= 0) continue;
    const x0 = clamp01(b.x);
    const y0 = clamp01(b.y);
    const x1 = clamp01(b.x + b.w);
    const y1 = clamp01(b.y + b.h);
    const rect = { left: Math.round(x0 * width), top: Math.round(y0 * height), right: Math.round(x1 * width), bottom: Math.round(y1 * height) };
    if (rect.right - rect.left <= 2 * stroke || rect.bottom - rect.top <= 2 * stroke) continue;
    out.push(rect);
  }
  return out;
};

/**
 * The guide as raw 8-bit RGB pixels (pure; no sharp). Gutters first, then every panel's fill,
 * then every panel's border — so an overlapping neighbour's fill never erases a border.
 */
export const rasterizeLayoutGuide = (rects: readonly GuideRect[], width: number, height: number, stroke: number): Buffer => {
  const px = Buffer.alloc(width * height * 3, GUIDE_GUTTER);
  const fillRect = (left: number, top: number, right: number, bottom: number, value: number) => {
    const l = Math.max(0, left);
    const r = Math.min(width, right);
    if (r <= l) return;
    for (let y = Math.max(0, top); y < Math.min(height, bottom); y += 1) px.fill(value, (y * width + l) * 3, (y * width + r) * 3);
  };
  for (const q of rects) fillRect(q.left, q.top, q.right, q.bottom, GUIDE_FILL);
  for (const q of rects) {
    fillRect(q.left, q.top, q.right, q.top + stroke, GUIDE_BORDER);
    fillRect(q.left, q.bottom - stroke, q.right, q.bottom, GUIDE_BORDER);
    fillRect(q.left, q.top, q.left + stroke, q.bottom, GUIDE_BORDER);
    fillRect(q.right - stroke, q.top, q.right, q.bottom, GUIDE_BORDER);
  }
  return px;
};

/**
 * Render the layout guide PNG for `boxes` (page-normalized, reading order) at the job's aspect and
 * resolution class. Throws BAD_REQUEST when no box is drawable. Runs inside the sharp gate.
 */
export async function renderLayoutGuide(
  boxes: readonly Box[],
  aspect: AspectRatio,
  res: Resolution,
  frameStyle?: GuideFrameStyle
): Promise<LayoutGuideImage> {
  const { width, height } = layoutGuideSize(aspect, res);
  const stroke = guideStrokePx(width, frameStyle);
  const rects = guideRects(boxes, width, height, stroke);
  if (!rects.length) throw new StudioError('BAD_REQUEST', 'This page has no panel boxes to draw a layout guide from.', { status: 400 });
  const raw = rasterizeLayoutGuide(rects, width, height, stroke);
  const buffer = await withSharpSlot(() =>
    sharp(raw, { raw: { width, height, channels: 3 } })
      .png({ compressionLevel: 9 })
      .toBuffer()
  );
  return { width, height, stroke, rects, mimeType: 'image/png', buffer, dataUrl: `data:image/png;base64,${buffer.toString('base64')}` };
}

/** The guide for a page: the same boxes the prompt describes (pageLayoutBoxes). */
export const renderPageLayoutGuide = (
  doc: ComicDoc,
  page: Page,
  aspect: AspectRatio,
  res: Resolution,
  frameStyle?: GuideFrameStyle
): Promise<LayoutGuideImage> => renderLayoutGuide(pageLayoutBoxes(doc, page), aspect, res, frameStyle);

/**
 * The page's guide, or null — never a throw. A guide failure (no drawable box, a sharp error) must
 * never fail or re-quote the paid page job: this logs `comic_layout_guide_failed`, and the runner then
 * recompiles with `layoutGuide: false` (the prompt drops its guide lines and the image indexes
 * renumber) and draws the page without it. `context` adds ids to the log line (no user content).
 */
export async function tryRenderPageLayoutGuide(
  doc: ComicDoc,
  page: Page,
  aspect: AspectRatio,
  res: Resolution,
  frameStyle?: GuideFrameStyle,
  context: Record<string, string | number | undefined> = {}
): Promise<LayoutGuideImage | null> {
  try {
    return await renderPageLayoutGuide(doc, page, aspect, res, frameStyle);
  } catch (err) {
    logger.warn('comic_layout_guide_failed', {
      ...context,
      pageId: page.id,
      panels: page.panels.length,
      aspect,
      res,
      message: String((err as Error)?.message || err)
    });
    return null;
  }
}
