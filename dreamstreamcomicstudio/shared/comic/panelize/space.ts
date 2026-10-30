// Page space ↔ image space for panel frames (Ship 2, K2a; pro plan §4.3, §5.2). Pure and dependency-light, shared by
// the lettering engine, the ops (frames carry their lettering along), the composer (B1), panelization (B2) and the
// region tools.
//
// Two spaces:
//   - PAGE space: the page as the reader sees it, normalized 0..1. In panels mode the page has the BOOK aspect
//     (format.pageAspect) and each panel's picture sits in its frame box. In page mode the page IS the drawing.
//   - IMAGE space: a picture normalized 0..1 — the page's drawing (a panel's cut of it) or a frame's own source
//     (another take, an image).
//
// A frame shows a sub-rectangle of its source: the cut (or src.box), cropped to the frame's shape and centred
// ("cover"), then zoomed by fit.s and panned by fit.x / fit.y (−1 = the left/top edge, +1 = the right/bottom edge).
// frameAffine is that mapping both ways. Every function falls back to page mode (identity) when artModeOf says the
// page is shown as drawn, so a page without Ship 2 data takes exactly today's path.

import { artModeOf, cutFor, type AssetRef, type Box, type ComicDoc, type KeepOut, type Page, type Panel, type PanelPageShape, type QcReport, type RenderState, type SpeakerMark } from '../doc.js';
import { panelBoxesFor, panelForRegion, type Point } from '../pageGeometry.js';

const r4 = (n: number) => Math.round(n * 10000) / 10000;
const clamp01 = (n: number) => (Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0);
const UNIT: Box = { x: 0, y: 0, w: 1, h: 1 };

/** Width / height of a format's page aspect ('2:3' → 0.667; unreadable → 2/3, like letteringAspect always did). */
export const formatAspectOf = (doc: Pick<ComicDoc, 'format'>): number => {
  const [w, h] = String(doc?.format?.pageAspect || '').split(':').map(Number);
  return w > 0 && h > 0 ? w / h : 2 / 3;
};

/** The page shape composeAspect reads: a render, and (optionally) what panels mode needs. */
export type ComposePageShape = Pick<Page, 'render'> & Partial<Pick<Page, 'artMode' | 'panels'>>;

/**
 * Width / height of the page as shown. Panels mode: the BOOK aspect (frames are laid out on it, whatever shape the
 * drawing came back in). Page mode: the drawing's pixel size when known, else the format's aspect — exactly what
 * letteringAspect and the board's pageAspectOf returned before Ship 2.
 */
export const composeAspect = (doc: Pick<ComicDoc, 'format'>, page?: ComposePageShape | null): number => {
  if (page && page.artMode === 'panels' && Array.isArray(page.panels) && artModeOf(page as PanelPageShape) === 'panels') return formatAspectOf(doc);
  const a = page?.render?.asset;
  if (a?.w && a?.h && a.w > 0 && a.h > 0) return a.w / a.h;
  return formatAspectOf(doc);
};

/** Width / height of the page's drawing: its pixel size, else the aspect it was requested at. */
const rasterAspectOf = (render: RenderState | undefined): number | undefined => {
  const a = render?.asset;
  if (a?.w && a?.h && a.w > 0 && a.h > 0) return a.w / a.h;
  const [w, h] = String(render?.aspect || '').split(':').map(Number);
  return w > 0 && h > 0 ? w / h : undefined;
};

// ── Picture sizes by path (frame sources) ────────────────────────────────────

const sizeCache = new WeakMap<object, Map<string, { w: number; h: number }>>();

/** Pixel size of the stored picture at `path`, from any AssetRef of the doc that knows it (cached per doc object). */
export const assetSizeOf = (doc: ComicDoc, path: string): { w: number; h: number } | undefined => {
  if (!doc || typeof path !== 'string' || !path) return undefined;
  let map = sizeCache.get(doc);
  if (!map) {
    const m = new Map<string, { w: number; h: number }>();
    const add = (a?: Partial<AssetRef> | null) => {
      if (a?.path && a.w && a.h && a.w > 0 && a.h > 0 && !m.has(a.path)) m.set(a.path, { w: a.w, h: a.h });
      for (const v of a?.variants || []) if (v?.path && v.w > 0 && v.h > 0 && !m.has(v.path)) m.set(v.path, { w: v.w, h: v.h });
    };
    const render = (r?: RenderState) => {
      add(r?.asset);
      r?.history?.forEach(add);
    };
    doc.pages?.forEach((p) => render(p.render));
    doc.trash?.forEach((t) => render(t.page?.render));
    doc.archive?.forEach(add);
    render(doc.cover?.render);
    doc.cast?.forEach((c) => {
      render(c.sheet);
      c.refs?.forEach(add);
    });
    doc.places?.forEach((p) => {
      render(p.sheet);
      p.refs?.forEach(add);
    });
    doc.style?.refs?.forEach(add);
    add(doc.style?.board);
    doc.style?.options?.forEach((o) => render(o.render));
    doc.refInbox?.forEach(add);
    doc.conversation?.forEach((msg) => msg.attachments?.forEach(add));
    map = m;
    sizeCache.set(doc, map);
  }
  return map.get(path);
};

// ── The frame affine ─────────────────────────────────────────────────────────

/** One panel's picture placed in its frame: the mapping between page space and the source picture, both ways. */
export interface FrameAffine {
  panelId: string;
  /** The frame (page space). */
  dst: Box;
  /** The part of the source picture actually shown (image space): the cut or src box, cropped to the frame and fitted. */
  src: Box;
  /** The whole cut (or src box) the frame crops from (image space). */
  cut: Box;
  /** The picture: the page drawing's path (raster) or the frame's own source path. */
  path?: string;
  /** True when the picture is the page's own drawing (a cut of it). */
  raster: boolean;
  /** Pixel width of the source picture, when known. */
  srcPx?: number;
  toPage(p: Point): Point;
  toImage(p: Point): Point;
  boxToPage(b: Box): Box;
  boxToImage(b: Box): Box;
}

/**
 * The source rectangle a frame shows: `cut` (image space) cropped to the frame's physical shape and centred, then
 * zoomed (fit.s ≥ 1) and panned (fit.x, fit.y in −1..1). When the source picture's aspect is unknown the cut is
 * shown whole (the renderer, which knows the picture's size, crops it).
 */
export const visibleSource = (cut: Box, srcAspect: number | undefined, frame: Box, bookAspect: number, fit?: { s: number; x: number; y: number }): Box => {
  const af = (frame.w * bookAspect) / frame.h;
  let sw = cut.w;
  let sh = cut.h;
  if (srcAspect && srcAspect > 0 && Number.isFinite(af) && af > 0) {
    const ac = (cut.w * srcAspect) / cut.h;
    if (ac > af) sw = (af * cut.h) / srcAspect;
    else sh = (cut.w * srcAspect) / af;
  }
  const s = fit && Number.isFinite(fit.s) && fit.s >= 1 ? fit.s : 1;
  sw /= s;
  sh /= s;
  const px = fit && Number.isFinite(fit.x) ? Math.min(1, Math.max(-1, fit.x)) : 0;
  const py = fit && Number.isFinite(fit.y) ? Math.min(1, Math.max(-1, fit.y)) : 0;
  return { x: cut.x + ((cut.w - sw) / 2) * (1 + px), y: cut.y + ((cut.h - sh) / 2) * (1 + py), w: sw, h: sh };
};

const affineOf = (panelId: string, dst: Box, src: Box, cut: Box, raster: boolean, path?: string, srcPx?: number): FrameAffine => {
  const toPage = (p: Point): Point => ({ x: dst.x + ((p.x - src.x) * dst.w) / src.w, y: dst.y + ((p.y - src.y) * dst.h) / src.h });
  const toImage = (q: Point): Point => ({ x: src.x + ((q.x - dst.x) * src.w) / dst.w, y: src.y + ((q.y - dst.y) * src.h) / dst.h });
  const box = (b: Box, f: (p: Point) => Point): Box => {
    const a = f({ x: b.x, y: b.y });
    const c = f({ x: b.x + b.w, y: b.y + b.h });
    return { x: Math.min(a.x, c.x), y: Math.min(a.y, c.y), w: Math.abs(c.x - a.x), h: Math.abs(c.y - a.y) };
  };
  return {
    panelId,
    dst,
    src,
    cut,
    raster,
    ...(path ? { path } : {}),
    ...(srcPx && srcPx > 0 ? { srcPx } : {}),
    toPage,
    toImage,
    boxToPage: (b) => box(b, toPage),
    boxToImage: (b) => box(b, toImage)
  };
};

/**
 * Page ↔ image mapping of one panel's frame (any art mode: callers decide when the page is shown in frames). Null
 * when the panel has no usable frame, or its frame shows the page's drawing and that panel has no cut (an empty
 * frame: nothing to map).
 */
export const frameAffine = (doc: ComicDoc, page: Pick<Page, 'panels' | 'render'>, panel: Pick<Panel, 'id' | 'frame'> | string): FrameAffine | null => {
  const p = typeof panel === 'string' ? page?.panels?.find((x) => x.id === panel) : panel;
  const frame = p?.frame;
  const dst = frame?.box;
  if (!p || !frame || !dst || !(dst.w > 0) || !(dst.h > 0)) return null;
  const book = formatAspectOf(doc);
  if (frame.src?.path) {
    const cut = frame.src.box ?? UNIT;
    const size = assetSizeOf(doc, frame.src.path);
    const src = visibleSource(cut, size ? size.w / size.h : undefined, dst, book, frame.fit);
    return affineOf(p.id, dst, src, cut, false, frame.src.path, size?.w);
  }
  const c = cutFor(page, p);
  const asset = page.render?.asset;
  if (!c || !asset?.path) return null;
  const src = visibleSource(c.box, rasterAspectOf(page.render), dst, book, frame.fit);
  return affineOf(p.id, dst, src, c.box, true, asset.path, asset.w);
};

/** Every panel's frame affine (panels without one are left out). */
export const frameAffines = (doc: ComicDoc, page: Pick<Page, 'panels' | 'render'>): FrameAffine[] =>
  (page?.panels || []).map((p) => frameAffine(doc, page, p)).filter((a): a is FrameAffine => !!a);

// ── QC in page space ─────────────────────────────────────────────────────────

const intersect = (a: Box, b: Box): Box | null => {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  const w = Math.min(a.x + a.w, b.x + b.w) - x;
  const h = Math.min(a.y + a.h, b.y + b.h) - y;
  return w > 1e-9 && h > 1e-9 ? { x, y, w, h } : null;
};
const contains = (b: Box, p: Point) => p.x >= b.x && p.x <= b.x + b.w && p.y >= b.y && p.y <= b.y + b.h;
const roundBox = (b: Box): Box => ({ x: r4(b.x), y: r4(b.y), w: r4(b.w), h: r4(b.h) });
const clampInto = (p: Point, b: Box): Point => ({ x: r4(Math.min(b.x + b.w, Math.max(b.x, p.x))), y: r4(Math.min(b.y + b.h, Math.max(b.y, p.y))) });

/**
 * The page check in PAGE space (what the lettering places around). Page mode: the stored report itself (the same
 * object — the lettering takes today's path byte for byte). Panels mode: keep-outs and speakers' heads are moved from
 * the drawing into the frames that show them (a keep-out is clipped to its frame; one whose art is not shown is
 * dropped), and panelBoxes are the frames. Text, score and every other field are unchanged.
 */
export const pageSpaceQc = (doc: ComicDoc, page: PanelPageShape): QcReport | undefined => {
  const qc = page?.render?.qc;
  if (!qc || artModeOf(page) !== 'panels') return qc;
  const shown = page.panels.map((panel) => ({ panel, aff: frameAffine(doc, page, panel) })).filter((x) => x.aff?.raster) as {
    panel: Panel;
    aff: FrameAffine;
  }[];
  const cuts = page.render.cuts?.cuts || [];
  /** The panel showing an image point: the cut holding it, else the cut with that drawn number. */
  const ownerOf = (pt: Point, drawn?: number) =>
    shown.find((x) => contains(x.aff.cut, pt)) ||
    (typeof drawn === 'number' ? shown.find((x) => cuts.some((c) => c.drawn === drawn && c.box === x.aff.cut)) : undefined);
  const out: QcReport = { ...qc, panelBoxes: page.panels.map((p) => ({ ...p.frame!.box })) };
  delete out.drawnBoxes;
  if (Array.isArray(qc.keepOut)) {
    const keepOut: KeepOut[] = [];
    for (const k of qc.keepOut) {
      if (!k?.box) continue;
      const owner = ownerOf({ x: k.box.x + k.box.w / 2, y: k.box.y + k.box.h / 2 }, k.panel);
      const visible = owner ? intersect(owner.aff.boxToPage(k.box), owner.aff.dst) : null;
      if (owner && visible) keepOut.push({ ...k, panel: owner.panel.n, box: roundBox(visible) });
    }
    out.keepOut = keepOut;
  }
  if (Array.isArray(qc.heads)) {
    const heads: SpeakerMark[] = [];
    for (const h of qc.heads) {
      if (!h?.head) continue;
      const owner = ownerOf(h.head, h.panel);
      if (!owner) continue;
      const mark: SpeakerMark = { ...h, panel: owner.panel.n, head: clampInto(owner.aff.toPage(h.head), owner.aff.dst) };
      if (h.mouth) mark.mouth = clampInto(owner.aff.toPage(h.mouth), owner.aff.dst);
      heads.push(mark);
    }
    out.heads = heads;
  }
  return out;
};

// ── Regions and sharpness ────────────────────────────────────────────────────

/** A page-space region on the picture it shows: the panel (panels mode), the picture's path and the image box. */
export interface ImageRegion {
  panelId?: string;
  path?: string;
  box: Box;
}

/**
 * A region marked on the page, in the picture's space. Page mode: the same box on the page drawing. Panels mode: the
 * part of it inside the frame it mostly covers, mapped into that frame's picture. Null when it covers no frame, or that
 * frame shows nothing (an empty frame).
 */
export const pageBoxToImage = (doc: ComicDoc, page: PanelPageShape, box: Box): ImageRegion | null => {
  if (!box || !(box.w > 0) || !(box.h > 0)) return null;
  if (artModeOf(page) !== 'panels') return { ...(page.render?.asset?.path ? { path: page.render.asset.path } : {}), box: roundBox(box) };
  const n = panelForRegion(box, page.panels.map((p) => p.frame!.box));
  const panel = n ? page.panels[n - 1] : undefined;
  const aff = panel ? frameAffine(doc, page, panel) : null;
  const inside = aff ? intersect(box, aff.dst) : null;
  if (!panel || !aff || !inside) return null;
  const img = aff.boxToImage(inside);
  const x = clamp01(img.x);
  const y = clamp01(img.y);
  return { panelId: panel.id, ...(aff.path ? { path: aff.path } : {}), box: roundBox({ x, y, w: Math.min(1 - x, img.w), h: Math.min(1 - y, img.h) }) };
};

/**
 * How much a panel's picture is enlarged to fill its frame (1 = native pixels, > EDITOR_LIMITS.upscaleSoft reads soft).
 * The page is measured at `pageWidthPx` (default: the page drawing's width). Undefined when the frame shows nothing or
 * a size is unknown.
 */
export const upscaleOf = (doc: ComicDoc, page: Pick<Page, 'panels' | 'render'>, panelId: string, pageWidthPx?: number): number | undefined => {
  const aff = frameAffine(doc, page, panelId);
  if (!aff?.srcPx) return undefined;
  const pageW = pageWidthPx && pageWidthPx > 0 ? pageWidthPx : page.render?.asset?.w && page.render.asset.w > 0 ? page.render.asset.w : aff.srcPx;
  const shownPx = aff.src.w * aff.srcPx;
  return shownPx > 0 ? Math.round(((aff.dst.w * pageW) / shownPx) * 100) / 100 : undefined;
};

// ── Following a frame (balloons, overlays, translated overrides) ─────────────

/** A separable page-space map (axis-aligned affines keep x and y independent). */
export interface PointMap {
  x(v: number): number;
  y(v: number): number;
}

const sameBox = (a?: Box, b?: Box) => !!a && !!b && a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h;
const boxMap = (from: Box, to: Box): PointMap => ({
  x: (v) => to.x + ((v - from.x) * to.w) / from.w,
  y: (v) => to.y + ((v - from.y) * to.h) / from.h
});
/** The page shape panelPointMap reads (the layout text is the page-mode fallback for panel boxes). */
export type FollowPageShape = PanelPageShape & Pick<Page, 'layout'>;
const panelBoxOf = (doc: ComicDoc, page: FollowPageShape, panelId: string): Box | undefined => {
  const i = page.panels.findIndex((p) => p.id === panelId);
  return i >= 0 ? panelBoxesFor(doc, page)[i] : undefined;
};

/**
 * Where page-space content on one panel goes when the page changes from `before` to `after` (a frame moved or resized,
 * the page switched in or out of panels mode). Through the picture when the panel shows the same picture on both
 * sides — content anchored to the art (a balloon's tail on a head) stays on it — else frame box to frame box.
 * Null when nothing moves (neither side is shown in frames, or the panel's mapping is unchanged).
 */
export const panelPointMap = (beforeDoc: ComicDoc, before: FollowPageShape, afterDoc: ComicDoc, after: FollowPageShape, panelId: string): PointMap | null => {
  const bPanels = artModeOf(before) === 'panels';
  const aPanels = artModeOf(after) === 'panels';
  if (!bPanels && !aPanels) return null;
  const bAff = bPanels ? frameAffine(beforeDoc, before, panelId) : null;
  const aAff = aPanels ? frameAffine(afterDoc, after, panelId) : null;
  const bPath = bPanels ? bAff?.path : before.render?.asset?.path;
  const aPath = aPanels ? aAff?.path : after.render?.asset?.path;
  if ((!bPanels || bAff) && (!aPanels || aAff) && bPath && bPath === aPath) {
    if (bAff && aAff && sameBox(bAff.dst, aAff.dst) && sameBox(bAff.src, aAff.src)) return null;
    const toImage = (p: Point): Point => (bAff ? bAff.toImage(p) : p);
    const toPage = (p: Point): Point => (aAff ? aAff.toPage(p) : p);
    return { x: (v) => toPage(toImage({ x: v, y: 0 })).x, y: (v) => toPage(toImage({ x: 0, y: v })).y };
  }
  const from = panelBoxOf(beforeDoc, before, panelId);
  const to = panelBoxOf(afterDoc, after, panelId);
  if (!from || !to || !(from.w > 0) || !(from.h > 0) || sameBox(from, to)) return null;
  return boxMap(from, to);
};
