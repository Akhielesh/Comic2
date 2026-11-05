// Guided View model (reader.md §5): panel-by-panel stops and the camera that frames them. Pure.
//
// Panel boxes come from panelBoxesFor (measured qc.panelBoxes when they match the panel count, else the
// blueprint estimate), so guided reading is free: no AI call, no new data. Stops follow the page's
// VISUAL reading order (row bands, right-to-left within a row for manga), which also corrects a
// drawing whose panels came out in a different arrangement than planned.

import type { Box, ComicDoc } from '../../../shared/comic/doc';
import { panelAtPoint, panelBoxesFor } from '../../../shared/comic/pageGeometry';
import type { ReaderItem } from '../reader/readerModel';

export interface GuidedStop {
  itemIndex: number;
  /** −1 = the whole page (overview / cover). */
  panelIndex: number;
  box: Box;
  /** Lines with text in this panel (balloon pop, transcript, live region). */
  lineIds: string[];
}

export interface CameraRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Camera {
  /** Scale of the book wrapper (transform-origin 0 0). */
  s: number;
  tx: number;
  ty: number;
  /** The framed rectangle in viewport coordinates at scale 1. */
  rect: CameraRect;
}

export const FULL_BOX: Box = { x: 0, y: 0, w: 1, h: 1 };
/** Row-band tolerance as a fraction of the page height. */
export const ROW_TOLERANCE = 0.08;
export const GUIDED_MAX_ZOOM = 4;
export const GUIDED_PAD = 0.05;

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

/**
 * Visual reading order of panel boxes: rows by their top edge (a tall panel beside two stacked ones
 * belongs to the first row), left→right within a row for LTR, right→left for RTL.
 */
export const readingOrder = (boxes: Box[], rtl: boolean): number[] => {
  const idx = boxes.map((_, i) => i).filter((i) => boxes[i] && boxes[i].w > 0 && boxes[i].h > 0);
  idx.sort((a, b) => boxes[a].y - boxes[b].y || boxes[a].x - boxes[b].x);
  const rows: number[][] = [];
  for (const i of idx) {
    const row = rows[rows.length - 1];
    if (row && Math.abs(boxes[i].y - boxes[row[0]].y) <= ROW_TOLERANCE) row.push(i);
    else rows.push([i]);
  }
  return rows.flatMap((row) => row.sort((a, b) => (rtl ? boxes[b].x + boxes[b].w - (boxes[a].x + boxes[a].w) : boxes[a].x - boxes[b].x)));
};

/** Stops for one reader item: optional whole-page overview, then panels in reading order. */
export const guidedStops = (doc: ComicDoc, item: ReaderItem | undefined, itemIndex: number, opts: { overview: boolean }): GuidedStop[] => {
  const whole: GuidedStop = { itemIndex, panelIndex: -1, box: FULL_BOX, lineIds: [] };
  const page = item?.page;
  if (!page || !page.panels.length) return [whole];
  const boxes = panelBoxesFor(doc, page);
  const order = readingOrder(boxes.slice(0, page.panels.length), doc.format.readingDirection === 'rtl');
  if (!order.length) return [whole];
  const panels: GuidedStop[] = order.map((i) => ({
    itemIndex,
    panelIndex: i,
    box: boxes[i],
    lineIds: (page.panels[i]?.lines || []).filter((l) => l.text.trim()).map((l) => l.id)
  }));
  return opts.overview ? [whole, ...panels] : panels;
};

/** The stop under a point on the page (double-tap entry); falls back to the first panel stop. */
export const stopAtPoint = (stops: GuidedStop[], point: { x: number; y: number }): number => {
  const panelStops = stops.map((s, i) => ({ s, i })).filter(({ s }) => s.panelIndex >= 0);
  if (!panelStops.length) return 0;
  // panelAtPoint is 1-based; a tap in a gutter picks the nearest panel.
  const hit = panelAtPoint(point, panelStops.map(({ s }) => s.box));
  if (hit !== undefined && panelStops[hit - 1]) return panelStops[hit - 1].i;
  let best = panelStops[0];
  let bestD = Infinity;
  for (const ps of panelStops) {
    const b = ps.s.box;
    const d = Math.hypot(point.x - (b.x + b.w / 2), point.y - (b.y + b.h / 2));
    if (d < bestD) [best, bestD] = [ps, d];
  }
  return best.i;
};

/**
 * Camera for a stop. `page` is where the page box sits in the viewport at scale 1 (its fit position).
 * The framed rect is the panel expanded by `pad` and grown to the viewport aspect; the zoom is clamped
 * to 1..maxZoom, and the frame stays on the page whenever it fits (no empty margins when avoidable).
 */
export const cameraFor = (
  stop: Pick<GuidedStop, 'box'>,
  page: { x: number; y: number; w: number; h: number },
  vw: number,
  vh: number,
  opts: { pad?: number; maxZoom?: number } = {}
): Camera => {
  const pad = opts.pad ?? GUIDED_PAD;
  const maxZoom = opts.maxZoom ?? GUIDED_MAX_ZOOM;
  const outAspect = vw / Math.max(1, vh);
  const box = stop.box;
  let w = box.w * page.w * (1 + 2 * pad);
  let h = box.h * page.h * (1 + 2 * pad);
  if (w / Math.max(1e-6, h) > outAspect) h = w / outAspect;
  else w = h * outAspect;
  const cx = page.x + (box.x + box.w / 2) * page.w;
  const cy = page.y + (box.y + box.h / 2) * page.h;
  const s = clamp(vw / Math.max(1e-6, w), 1, maxZoom);
  const rw = vw / s;
  const rh = vh / s;
  let rx = cx - rw / 2;
  let ry = cy - rh / 2;
  if (rw <= page.w) rx = clamp(rx, page.x, page.x + page.w - rw);
  else rx = page.x + (page.w - rw) / 2;
  if (rh <= page.h) ry = clamp(ry, page.y, page.y + page.h - rh);
  else ry = page.y + (page.h - rh) / 2;
  return { s, tx: -rx * s, ty: -ry * s, rect: { x: rx, y: ry, w: rw, h: rh } };
};

/** The panel's rectangle on screen under a camera (spotlight position), viewport px. */
export const spotlightRect = (box: Box, page: { x: number; y: number; w: number; h: number }, cam: Pick<Camera, 's' | 'tx' | 'ty'>): CameraRect => ({
  x: (page.x + box.x * page.w) * cam.s + cam.tx,
  y: (page.y + box.y * page.h) * cam.s + cam.ty,
  w: box.w * page.w * cam.s,
  h: box.h * page.h * cam.s
});

/** Camera move duration (ms): longer for bigger moves and zoom changes, 420–900 ms. */
export const cameraDuration = (from: Camera, to: Camera, vw: number, vh: number): number => {
  const diag = Math.hypot(vw, vh) || 1;
  const c0 = { x: from.rect.x + from.rect.w / 2, y: from.rect.y + from.rect.h / 2 };
  const c1 = { x: to.rect.x + to.rect.w / 2, y: to.rect.y + to.rect.h / 2 };
  const dist = Math.hypot(c1.x - c0.x, c1.y - c0.y) / diag + Math.abs(Math.log(to.s / Math.max(1e-6, from.s)));
  return clamp(380 + 260 * dist, 420, 900);
};

export const lerpCamera = (a: Camera, b: Camera, t: number): Camera => {
  // Interpolate the framed rect (not the raw transform) so zooms feel even; derive the transform.
  const lerp = (x: number, y: number) => x + (y - x) * t;
  // Log-space scale interpolation keeps zoom speed perceptually constant.
  const s = Math.exp(lerp(Math.log(a.s), Math.log(b.s)));
  const cx = lerp(a.rect.x + a.rect.w / 2, b.rect.x + b.rect.w / 2);
  const cy = lerp(a.rect.y + a.rect.h / 2, b.rect.y + b.rect.h / 2);
  const w = a.rect.w * (a.s / s);
  const h = a.rect.h * (a.s / s);
  const rect = { x: cx - w / 2, y: cy - h / 2, w, h };
  return { s, tx: -rect.x * s, ty: -rect.y * s, rect };
};

/** Identity camera (whole book at its fit position). */
export const IDENTITY_CAMERA = (vw: number, vh: number): Camera => ({ s: 1, tx: 0, ty: 0, rect: { x: 0, y: 0, w: vw, h: vh } });
