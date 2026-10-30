// Frame operations (Ship 2, B9; pro plan §4.5, design §4.4): the free, labelled, undoable edits of a page's panel
// frames. Every edit returns K2a ops (page_frames, page_cuts, panel_add, panel_remove, panels_order, layer, panel,
// page) with their inverse from the K2a undo path. Each one respects EDITOR_LIMITS.frameMin, the page's frame style,
// DOC_LIMITS (9 panels, 8 lines) and EDITOR_LIMITS.sourcesPerPage, and refuses a locked panel in plain words.
//
// Where frames can be edited: a page shown in frames (artModeOf 'panels'), or a page not drawn yet (its frames are
// the plan; on such a page the derived layout sentence and panel sizes follow, so the writer and the image prompt see
// the frames). A drawn page shown as drawn must be made editable first (free; B2's panelize_page).
//
// Lettering: frame moves and resizes let K2a carry the lettering through the picture (I6). Splits and close-ups keep
// every balloon exactly where it is on the page (each half shows the art that was under it) and route each line to
// the half holding its balloon. Pure: no clock, no I/O.

import {
  artModeOf,
  cutFor,
  frameStyleOf,
  normalizeUnitBox,
  type Box,
  type ComicDoc,
  type FrameStyle,
  type Page,
  type Panel,
  type PanelCut,
  type PanelCuts,
  type PanelFrame,
  type PanelFrameFit,
  type PanelFrameSource,
  type VersionMeta
} from '../doc.js';
import { versionList } from '../book.js';
import { DOC_LIMITS, EDITOR_LIMITS, PRO_PAGE_LIMITS } from '../limits.js';
import { applyOp, type DocOp } from '../ops.js';
import { drawnLayoutBoxes, harmonizePanelSizes, parseLayout } from '../pageGeometry.js';
import { formatAspectOf, frameAffine, upscaleOf } from '../panelize/space.js';
import { layoutTextFits, layoutTextOf } from './layoutText.js';
import { readingOrderOf } from './readingOrder.js';
import {
  buildScene,
  cap1,
  centreOf,
  clamp,
  containsPoint,
  defaultIds,
  editOf,
  framesShown,
  freshId,
  isUndrawn,
  lockedReason,
  NOTHING_TO_CHANGE,
  panelWord,
  r4,
  refuse,
  roundBox,
  sameBox,
  takenIds,
  type EditResult,
  type FramesMode,
  type IdFactory
} from './scene.js';
import { type Handle } from './transform.js';

const TOL = 0.006;
const FRAME_MIN = EDITOR_LIMITS.frameMin;
/** Gutter-drag detents: the split lands on ½, ⅓ or ⅔ of the row when released this close (share of the row). */
export const GUTTER_DETENTS: readonly number[] = [1 / 3, 1 / 2, 2 / 3];
export const DETENT_SNAP = 0.02;

// ── Context ──────────────────────────────────────────────────────────────────

interface Ctx {
  doc: ComicDoc;
  page: Page;
  style: FrameStyle;
  mode: FramesMode;
  /** Boxes as shown, one per panel (page panel order). */
  boxes: Box[];
  undrawn: boolean;
  rtl: boolean;
}

const ctxOf = (doc: ComicDoc, page: Page | undefined): Ctx | string => {
  if (!page) return 'That page is not in this comic.';
  const undrawn = isUndrawn(page);
  if (artModeOf(page) !== 'panels' && !undrawn) return `Page ${page.n} is shown as drawn. Make its panels editable first (free).`;
  if (!page.panels.length) return `Page ${page.n} has no panels yet.`;
  const shown = framesShown(doc, page);
  return { doc, page, style: frameStyleOf(page), mode: shown.mode, boxes: shown.boxes.map((b) => roundBox(b)), undrawn, rtl: doc.format?.readingDirection === 'rtl' };
};

const lockOf = (page: Page, ids: Iterable<string>): string | undefined => {
  for (const id of ids) {
    const r = lockedReason(page, { kind: 'frame', id });
    if (r) return r;
  }
  return undefined;
};

const indexOf = (page: Page, id: string) => page.panels.findIndex((p) => p.id === id);
const nOf = (page: Page, id: string) => page.panels.find((p) => p.id === id)?.n ?? 0;
const panelsWord = (page: Page, ids: string[]): string => {
  const ns = ids.map((id) => nOf(page, id)).sort((a, b) => a - b);
  if (ns.length === 1) return `panel ${ns[0]}`;
  return `panels ${ns.slice(0, -1).join(', ')} and ${ns[ns.length - 1]}`;
};

/** The frame a panel ends up with: its stored frame (or a new one) at `box`; `patch` keys replace (undefined drops). */
const frameAt = (panel: Panel, box: Box, patch: Partial<Record<keyof PanelFrame, unknown>> = {}): PanelFrame => {
  const out: Record<string, unknown> = { ...(panel.frame ?? {}), box: roundBox(box) };
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) delete out[k];
    else out[k] = v;
  }
  return out as unknown as PanelFrame;
};

/**
 * The page_frames op for new boxes (by panel index) and frame patches. Panels without a stored frame (an undrawn page
 * planned from its blueprint) get one at their shown box, so the page's frames stay complete.
 */
const framesOpOf = (ctx: Ctx, boxes: Box[], patches: Map<string, Partial<Record<keyof PanelFrame, unknown>>> = new Map(), moveBalloons?: false): DocOp | undefined => {
  const frames: { panelId: string; frame: PanelFrame }[] = [];
  ctx.page.panels.forEach((panel, i) => {
    const patch = patches.get(panel.id);
    const box = boxes[i] ?? ctx.boxes[i];
    if (!panel.frame || !sameBox(panel.frame.box, box, 1e-5) || patch) frames.push({ panelId: panel.id, frame: frameAt(panel, box, patch) });
  });
  if (!frames.length) return undefined;
  return { op: 'page_frames', pageId: ctx.page.id, frames, ...(moveBalloons === false ? { moveBalloons: false } : {}) };
};

/** Apply ops (pure; no clock). */
const applyAll = (doc: ComicDoc, ops: DocOp[]): ComicDoc => ops.reduce((d, op) => applyOp(d, op), doc);

/**
 * On a page not drawn yet the frames are the plan: the layout sentence (when it can be said in parseLayout's words
 * for this many panels and says something new) and the panel sizes follow them, so the writer and the prompt agree.
 */
const planFollowups = (ctx: Ctx, ops: DocOp[]): DocOp[] => {
  if (!ctx.undrawn) return [];
  const after = applyAll(ctx.doc, ops).pages.find((p) => p.id === ctx.page.id);
  if (!after || !after.panels.length || !after.panels.every((p) => p.frame?.box)) return [];
  const text = layoutTextOf(after.panels.map((p) => p.frame!.box), { rtl: ctx.rtl, kind: ctx.doc.format?.kind });
  const out: DocOp[] = [];
  if (!layoutTextFits(text, after.panels.length)) return out;
  const parsed = parseLayout(text)!;
  if (JSON.stringify(parseLayout(after.layout || '')) !== JSON.stringify(parsed)) out.push({ op: 'page', id: after.id, patch: { layout: text } });
  const sized = harmonizePanelSizes(after.panels, parsed, ctx.rtl);
  after.panels.forEach((p, i) => {
    if (sized[i] && sized[i].size !== p.size) out.push({ op: 'panel', pageId: after.id, id: p.id, patch: { size: sized[i].size } });
  });
  return out;
};

const finish = (ctx: Ctx, ops: DocOp[], label: string, notes: string[] = []): EditResult => {
  const all = ops.filter(Boolean);
  if (!all.length) return refuse(NOTHING_TO_CHANGE);
  return editOf(ctx.doc, [...all, ...planFollowups(ctx, all)], label, notes);
};

const softNotes = (ctx: Ctx, ops: DocOp[], panelIds: string[]): string[] => {
  if (ctx.undrawn) return [];
  const doc = applyAll(ctx.doc, ops);
  const page = doc.pages.find((p) => p.id === ctx.page.id);
  if (!page) return [];
  const out: string[] = [];
  for (const id of panelIds) {
    const up = upscaleOf(doc, page, id);
    if (up !== undefined && up > EDITOR_LIMITS.upscaleSoft) out.push(`${cap1(panelWord(page, id))} may look soft at this size (shown ${up}× larger than drawn).`);
  }
  return out;
};

// ── Gutters ──────────────────────────────────────────────────────────────────

/** A gap between frames that moves as one handle (a split pane): `before` frames end at it, `after` frames start. */
export interface Gutter {
  axis: 'x' | 'y';
  before: string[];
  after: string[];
  /** The middle of the gap (page fraction along the axis). */
  at: number;
  gap: number;
  /** Its extent across the axis. */
  from: number;
  to: number;
}

interface Item {
  id: string;
  box: Box;
}
const span = (b: Box, axis: 'x' | 'y') => (axis === 'x' ? { s: b.x, e: b.x + b.w } : { s: b.y, e: b.y + b.h });
const perp = (b: Box, axis: 'x' | 'y') => span(b, axis === 'x' ? 'y' : 'x');
const overlap = (a: { s: number; e: number }, b: { s: number; e: number }) => Math.min(a.e, b.e) - Math.max(a.s, b.s);
const contains = (o: Box, i: Box) => i.x >= o.x - 1e-6 && i.y >= o.y - 1e-6 && i.x + i.w <= o.x + o.w + 1e-6 && i.y + i.h <= o.y + o.h + 1e-6;

/** Every gutter between the frames (insets — frames inside another — take no part). */
export function guttersIn(items: readonly Item[], gutter: number): Gutter[] {
  const flat = items.filter((it) => !items.some((o) => o !== it && contains(o.box, it.box)));
  const maxGap = Math.max(gutter * 2.5, 0.012);
  const out: Gutter[] = [];
  for (const axis of ['x', 'y'] as const) {
    const pairs: { a: Item; b: Item; key: string; e1: number; e2: number }[] = [];
    for (const a of flat) {
      for (const b of flat) {
        if (a === b) continue;
        const e1 = span(a.box, axis).e;
        const e2 = span(b.box, axis).s;
        const gap = e2 - e1;
        if (gap < -TOL || gap > maxGap || overlap(perp(a.box, axis), perp(b.box, axis)) <= TOL) continue;
        pairs.push({ a, b, key: `${Math.round(e1 * 500)}|${Math.round(e2 * 500)}`, e1, e2 });
      }
    }
    const parent = pairs.map((_, i) => i);
    const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
    for (let i = 0; i < pairs.length; i++) {
      for (let j = i + 1; j < pairs.length; j++) {
        const p = pairs[i];
        const q = pairs[j];
        if (p.key !== q.key) continue;
        const linked = p.a === q.a || p.b === q.b || overlap(perp(p.a.box, axis), perp(q.a.box, axis)) > TOL || overlap(perp(p.b.box, axis), perp(q.b.box, axis)) > TOL;
        if (linked) parent[find(i)] = find(j);
      }
    }
    const groups = new Map<number, typeof pairs>();
    pairs.forEach((p, i) => {
      const r = find(i);
      groups.set(r, [...(groups.get(r) || []), p]);
    });
    for (const g of groups.values()) {
      const before = [...new Set(g.map((p) => p.a.id))];
      const after = [...new Set(g.map((p) => p.b.id))];
      const all = [...g.map((p) => p.a.box), ...g.map((p) => p.b.box)].map((b) => perp(b, axis));
      const e1 = Math.max(...g.map((p) => p.e1));
      const e2 = Math.min(...g.map((p) => p.e2));
      out.push({ axis, before, after, at: r4((e1 + e2) / 2), gap: r4(Math.max(0, e2 - e1)), from: r4(Math.min(...all.map((s) => s.s))), to: r4(Math.max(...all.map((s) => s.e))) });
    }
  }
  return out;
}

/** The gutters of a page's frames as shown. */
export function guttersOf(doc: ComicDoc, page: Page): Gutter[] {
  const shown = framesShown(doc, page);
  return guttersIn(page.panels.map((p, i) => ({ id: p.id, box: shown.boxes[i] })), frameStyleOf(page).gutter);
}

/** Move a gutter by `delta` (clamped so every frame keeps EDITOR_LIMITS.frameMin), detents optional. */
function dragGutter(items: Item[], g: Gutter, delta: number, detents: boolean): { items: Item[]; d: number } | string {
  const axis = g.axis;
  const size = (b: Box) => (axis === 'x' ? b.w : b.h);
  const before = items.filter((it) => g.before.includes(it.id));
  const after = items.filter((it) => g.after.includes(it.id));
  if (!before.length || !after.length) return 'That gap is not on this page any more.';
  const lo = Math.max(...before.map((it) => FRAME_MIN - size(it.box)));
  const hi = Math.min(...after.map((it) => size(it.box) - FRAME_MIN));
  if (lo > hi + 1e-9) return 'Those panels are already as small as panels can be.';
  let d = clamp(delta, lo, hi);
  if (detents) {
    const start = Math.min(...before.map((it) => span(it.box, axis).s));
    const end = Math.max(...after.map((it) => span(it.box, axis).e));
    const edge = Math.max(...before.map((it) => span(it.box, axis).e));
    const content = end - start - g.gap;
    if (content > 0) {
      for (const t of GUTTER_DETENTS) {
        const dt = start + t * content - edge;
        if (Math.abs(d - dt) <= DETENT_SNAP * content && dt >= lo - 1e-9 && dt <= hi + 1e-9) {
          d = dt;
          break;
        }
      }
    }
  }
  const next = items.map((it) => {
    if (g.before.includes(it.id)) return { ...it, box: roundBox(axis === 'x' ? { ...it.box, w: it.box.w + d } : { ...it.box, h: it.box.h + d }) };
    if (g.after.includes(it.id)) return { ...it, box: roundBox(axis === 'x' ? { ...it.box, x: it.box.x + d, w: it.box.w - d } : { ...it.box, y: it.box.y + d, h: it.box.h - d }) };
    return it;
  });
  return { items: next, d };
}

const itemsOf = (ctx: Ctx): Item[] => ctx.page.panels.map((p, i) => ({ id: p.id, box: ctx.boxes[i] }));
const boxesOfItems = (ctx: Ctx, items: Item[]): Box[] => ctx.page.panels.map((p) => items.find((it) => it.id === p.id)!.box);

export interface GutterRef {
  axis: 'x' | 'y';
  before: readonly string[];
  after: readonly string[];
}

/**
 * Drag the gap between neighbouring frames (one handle for the whole row or column): the frames before it grow as the
 * ones after it shrink, so the row keeps its width; nobody goes below EDITOR_LIMITS.frameMin; with detents the split
 * lands on ½, ⅓ or ⅔ of the row when released close to one.
 */
export function gutterDragEdit(doc: ComicDoc, page: Page, ref: GutterRef, delta: number, opts: { detents?: boolean } = {}): EditResult {
  const ctx = ctxOf(doc, page);
  if (typeof ctx === 'string') return refuse(ctx);
  const g = guttersIn(itemsOf(ctx), ctx.style.gutter).find((x) => x.axis === ref.axis && ref.before.some((id) => x.before.includes(id)) && ref.after.some((id) => x.after.includes(id)));
  if (!g) return refuse('Those panels do not share a gap any more.');
  const locked = lockOf(page, [...g.before, ...g.after]);
  if (locked) return refuse(locked);
  const moved = dragGutter(itemsOf(ctx), g, Number.isFinite(delta) ? delta : 0, opts.detents !== false);
  if (typeof moved === 'string') return refuse(moved);
  if (Math.abs(moved.d) < 1e-5) return refuse(NOTHING_TO_CHANGE);
  const op = framesOpOf(ctx, boxesOfItems(ctx, moved.items));
  if (!op) return refuse(NOTHING_TO_CHANGE);
  const ops = [op];
  return finish(ctx, ops, `Resize ${panelsWord(page, g.before)} and ${panelsWord(page, g.after)}`, softNotes(ctx, ops, [...g.before, ...g.after]));
}

/** How far an edge may move freely (no neighbour across a gutter): to the margin or the nearest frame beyond. */
function freeEdge(items: Item[], i: number, side: 'n' | 's' | 'e' | 'w', delta: number, style: FrameStyle): Box {
  const b = items[i].box;
  const axis = side === 'e' || side === 'w' ? 'x' : 'y';
  const others = items.filter((_, k) => k !== i && overlap(perp(items[k].box, axis), perp(b, axis)) > TOL && !contains(items[k].box, b) && !contains(b, items[k].box));
  const sp = span(b, axis);
  if (side === 'e' || side === 's') {
    let limit = 1 - style.margin;
    for (const o of others) if (span(o.box, axis).s >= sp.e - TOL) limit = Math.min(limit, span(o.box, axis).s - style.gutter);
    const e = clamp(sp.e + delta, sp.s + FRAME_MIN, Math.max(sp.s + FRAME_MIN, limit));
    return roundBox(axis === 'x' ? { ...b, w: e - b.x } : { ...b, h: e - b.y });
  }
  let limit = style.margin;
  for (const o of others) if (span(o.box, axis).e <= sp.s + TOL) limit = Math.max(limit, span(o.box, axis).e + style.gutter);
  const s = clamp(sp.s + delta, Math.min(limit, sp.e - FRAME_MIN), sp.e - FRAME_MIN);
  return roundBox(axis === 'x' ? { ...b, x: s, w: sp.e - s } : { ...b, y: s, h: sp.e - s });
}

/**
 * Resize a frame with one of its eight handles. An edge that faces neighbours across a gutter moves that gutter (the
 * neighbours give or take the space, so the row or column stays tiled); a free edge moves up to the margin or the
 * nearest frame. Frames never go below EDITOR_LIMITS.frameMin.
 */
export function resizeFrameEdit(doc: ComicDoc, page: Page, panelId: string, handle: Handle, dx: number, dy: number): EditResult {
  const ctx = ctxOf(doc, page);
  if (typeof ctx === 'string') return refuse(ctx);
  const i = indexOf(page, panelId);
  if (i < 0) return refuse('That panel is not on this page.');
  const locked = lockOf(page, [panelId]);
  if (locked) return refuse(locked);
  let items = itemsOf(ctx);
  const touched = new Set<string>([panelId]);
  const sides: { side: 'n' | 's' | 'e' | 'w'; d: number }[] = [];
  if (handle.includes('e')) sides.push({ side: 'e', d: dx });
  if (handle.includes('w')) sides.push({ side: 'w', d: dx });
  if (handle.includes('n')) sides.push({ side: 'n', d: dy });
  if (handle.includes('s')) sides.push({ side: 's', d: dy });
  for (const { side, d } of sides) {
    if (!Number.isFinite(d) || Math.abs(d) < 1e-6) continue;
    const axis = side === 'e' || side === 'w' ? 'x' : 'y';
    const g = guttersIn(items, ctx.style.gutter).find((x) => x.axis === axis && ((side === 'e' || side === 's') ? x.before.includes(panelId) : x.after.includes(panelId)));
    if (g) {
      const lockedN = lockOf(page, [...g.before, ...g.after]);
      if (lockedN) return refuse(lockedN);
      const moved = dragGutter(items, g, d, false);
      if (typeof moved === 'string') return refuse(moved);
      items = moved.items;
      [...g.before, ...g.after].forEach((id) => touched.add(id));
    } else {
      const k = items.findIndex((it) => it.id === panelId);
      items = items.map((it, idx) => (idx === k ? { ...it, box: freeEdge(items, k, side, d, ctx.style) } : it));
    }
  }
  const op = framesOpOf(ctx, boxesOfItems(ctx, items));
  if (!op) return refuse(NOTHING_TO_CHANGE);
  const ops = [op];
  return finish(ctx, ops, `Resize ${panelWord(page, panelId)}`, softNotes(ctx, ops, [...touched]));
}

/**
 * Put a frame at a new box (a free move, or a resize from the inspector): inside the page margins, at least
 * EDITOR_LIMITS.frameMin a side, never overlapping another frame — except fully inside one, where it becomes an inset
 * drawn above it.
 */
export function moveFrameEdit(doc: ComicDoc, page: Page, panelId: string, to: Box): EditResult {
  const ctx = ctxOf(doc, page);
  if (typeof ctx === 'string') return refuse(ctx);
  const i = indexOf(page, panelId);
  if (i < 0) return refuse('That panel is not on this page.');
  const locked = lockOf(page, [panelId]);
  if (locked) return refuse(locked);
  if (![to.x, to.y, to.w, to.h].every(Number.isFinite)) return refuse('That size does not fit on the page.');
  const m = ctx.style.margin;
  const w = clamp(to.w, FRAME_MIN, 1 - 2 * m);
  const h = clamp(to.h, FRAME_MIN, 1 - 2 * m);
  const box = roundBox({ x: clamp(to.x, m, 1 - m - w), y: clamp(to.y, m, 1 - m - h), w, h });
  const others = ctx.page.panels.map((p, k) => ({ p, box: ctx.boxes[k] })).filter((x) => x.p.id !== panelId);
  const host = others.find((o) => contains(o.box, box) && !contains(box, o.box));
  const hits = others.filter((o) => o !== host && !contains(box, o.box) && overlap(span(o.box, 'x'), span(box, 'x')) > 1e-4 && overlap(span(o.box, 'y'), span(box, 'y')) > 1e-4);
  // Frames inside the moved one (its own insets) ride along only when it moves whole; here they must stay inside.
  if (hits.length) return refuse('Panels cannot overlap. Move it into free space, or fully inside another panel as an inset.');
  if (others.some((o) => contains(box, o.box) && !contains(ctx.boxes[i], o.box))) return refuse('Panels cannot overlap. Move it into free space, or fully inside another panel as an inset.');
  const patches = new Map<string, Partial<Record<keyof PanelFrame, unknown>>>();
  if (host) {
    const hz = host.p.frame?.z ?? 0;
    if ((page.panels[i].frame?.z ?? 0) <= hz) patches.set(panelId, { z: Math.min(PRO_PAGE_LIMITS.zMax, hz + 1) });
  }
  const boxes = ctx.boxes.slice();
  boxes[i] = box;
  const op = framesOpOf(ctx, boxes, patches);
  if (!op) return refuse(NOTHING_TO_CHANGE);
  const resized = Math.abs(box.w - ctx.boxes[i].w) > 1e-4 || Math.abs(box.h - ctx.boxes[i].h) > 1e-4;
  const ops = [op];
  return finish(ctx, ops, `${resized ? 'Resize' : 'Move'} ${panelWord(page, panelId)}`, softNotes(ctx, ops, [panelId]));
}

// ── Split, join, add, delete ─────────────────────────────────────────────────

export type SplitDir = 'across' | 'down';

interface SplitPlan {
  ops: DocOp[];
  newId: string;
  /** Page-space boxes: the original's part and the new panel's. */
  keep: Box;
  fresh: Box;
}

/** Image-space box clamped onto the picture (smallest side PRO_PAGE_LIMITS.boxMin). */
const imageBox = (b: Box): Box | undefined => normalizeUnitBox(b, PRO_PAGE_LIMITS.boxMin);

/**
 * The shared split: the frame is cut in two along `dir` at `at` (share of the frame, a gutter between the halves);
 * `newSide` says which half becomes the new panel (inserted before or after the original in reading order). On a drawn
 * page each half shows exactly the art that was under it (the cut — or the frame's own source — is sliced through the
 * frame's picture mapping), every balloon stays where it is, each line goes to the half holding its balloon, and
 * overlays kept in the panel go with the half holding their centre.
 */
function planSplit(ctx: Ctx, panelId: string, dir: SplitDir, at: number, newSide: 'first' | 'second', ids: IdFactory, newShows?: PanelFrameSource): SplitPlan | string {
  const { doc, page } = ctx;
  const i = indexOf(page, panelId);
  if (i < 0) return 'That panel is not on this page.';
  if (page.panels.length >= DOC_LIMITS.panelsPerPage) return `A page holds at most ${DOC_LIMITS.panelsPerPage} panels.`;
  const panel = page.panels[i];
  const F = ctx.boxes[i];
  const g = ctx.style.gutter;
  const t = clamp(Number.isFinite(at) ? at : 0.5, 0.05, 0.95);
  const len = dir === 'across' ? F.w : F.h;
  const a = (len - g) * t;
  const b = len - g - a;
  if (a < FRAME_MIN || b < FRAME_MIN) return `${cap1(panelWord(page, panelId))} is too small to split.`;
  let first: Box = dir === 'across' ? { ...F, w: a } : { ...F, h: a };
  let second: Box = dir === 'across' ? { ...F, x: F.x + a + g, w: b } : { ...F, y: F.y + a + g, h: b };
  // Right-to-left: the half that reads first is on the right.
  if (dir === 'across' && ctx.rtl) [first, second] = [{ ...F, x: F.x + b + g, w: a }, { ...F, w: b }];
  first = roundBox(first);
  second = roundBox(second);
  const keep = newSide === 'first' ? second : first;
  const fresh = newSide === 'first' ? first : second;
  const taken = takenIds(doc, page);
  const newId = freshId('panel', taken, ids);

  // Lines: by where their balloon is (estimated or stored outline centre); unplaced lines stay.
  const scene = buildScene(doc, page);
  const inFresh = (lineId: string) => {
    const o = scene.objects.find((x) => x.kind === 'balloon' && x.id === lineId);
    return !!o && containsPoint(dir === 'across' ? { ...fresh, y: -1, h: 3 } : { ...fresh, x: -1, w: 3 }, centreOf(o.box));
  };
  const moving = panel.lines.filter((l) => inFresh(l.id)).map((l) => ({ id: l.id, kind: l.kind, text: l.text }));

  const aff = ctx.mode === 'panels' ? frameAffine(doc, page, panel) : null;
  const ownSrc = panel.frame?.src;
  const keepPatch: Partial<Record<keyof PanelFrame, unknown>> = {};
  let freshFrame: PanelFrame = { box: fresh, ...(panel.frame?.border ? { border: { ...panel.frame.border } } : {}) };
  let cutsOp: DocOp | undefined;
  if (aff) {
    const keepImg = imageBox(aff.boxToImage(keep));
    const freshImg = imageBox(aff.boxToImage(fresh));
    keepPatch.fit = undefined;
    if (ownSrc?.path) {
      if (keepImg) keepPatch.src = { path: ownSrc.path, box: keepImg };
      if (freshImg && !newShows) freshFrame = { ...freshFrame, src: { path: ownSrc.path, box: freshImg } };
    } else if (keepImg && page.render.asset?.path && page.render.cuts) {
      // Name every cut by its panel, then slice this panel's cut in two.
      const cuts: PanelCut[] = [];
      page.panels.forEach((p) => {
        const c = cutFor(page, p);
        if (!c) return;
        if (p.id === panelId) {
          cuts.push({ ...c, panelId: p.id, box: keepImg });
          if (freshImg && !newShows) cuts.push({ panelId: newId, drawn: c.drawn, box: freshImg, conf: c.conf, ...(c.shows !== undefined ? { shows: c.shows } : {}) });
        } else cuts.push({ ...c, panelId: p.id });
      });
      if (cuts.length > EDITOR_LIMITS.maxCuts) return `This drawing already has ${EDITOR_LIMITS.maxCuts} panel cuts.`;
      const value: PanelCuts = { ...page.render.cuts, cuts };
      cutsOp = { op: 'page_cuts', pageId: page.id, path: page.render.asset.path, cuts: value, moveBalloons: false };
    }
  }
  if (newShows) freshFrame = { ...freshFrame, src: newShows };
  const drawn = !ctx.undrawn;
  const newPanel: Panel = {
    id: newId,
    n: 0,
    size: 'medium',
    shot: panel.shot,
    action: drawn ? panel.action : '',
    castIds: [...panel.castIds],
    lines: moving as Panel['lines'],
    frame: freshFrame,
    ...(panel.angle && drawn ? { angle: panel.angle } : {}),
    ...(panel.placeId ? { placeId: panel.placeId } : {}),
    ...(panel.mood ? { mood: panel.mood } : {})
  };
  const ops: DocOp[] = [{ op: 'panel_add', pageId: page.id, panel: newPanel, index: newSide === 'first' ? i : i + 1 }];
  const boxes = ctx.boxes.slice();
  boxes[i] = keep;
  const fop = framesOpOf(ctx, boxes, new Map([[panelId, keepPatch]]), false);
  if (fop) ops.push(fop);
  if (cutsOp) ops.push(cutsOp);
  for (const layer of page.layers ?? []) {
    if (layer.clip === panelId && containsPoint(fresh, centreOf(layer.box))) ops.push({ op: 'layer', pageId: page.id, id: layer.id, patch: { clip: newId } });
  }
  return { ops, newId, keep, fresh };
}

/**
 * Split a panel in two, side by side ('across') or top and bottom ('down'). On a drawn page each half keeps the art
 * that was under it (a free slice of the drawing) and lines go to the half holding their balloon; on a page not drawn
 * yet it adds a planned panel. The new panel reads right after the original.
 */
export function splitFrameEdit(doc: ComicDoc, page: Page, panelId: string, dir: SplitDir, opts: { at?: number; ids?: IdFactory } = {}): EditResult {
  const ctx = ctxOf(doc, page);
  if (typeof ctx === 'string') return refuse(ctx);
  const locked = lockOf(page, [panelId]);
  if (locked) return refuse(locked);
  const plan = planSplit(ctx, panelId, dir, opts.at ?? 0.5, 'second', opts.ids ?? defaultIds);
  if (typeof plan === 'string') return refuse(plan);
  return finish(ctx, plan.ops, `Split ${panelWord(page, panelId)} ${dir === 'across' ? 'side by side' : 'top and bottom'}`);
}

/** What a frame shows: its own source, its cut of the drawing, or nothing (an empty frame). */
const pictureOf = (page: Page, panel: Panel): PanelFrameSource | undefined => {
  if (panel.frame?.src?.path) return panel.frame.src;
  const c = cutFor(page, panel);
  return c && page.render.asset?.path ? { path: page.render.asset.path, box: c.box } : undefined;
};
/** A frame shows art (a cut of the drawing or its own source). */
const showsArt = (ctx: Ctx, panel: Panel): boolean => (ctx.mode === 'panels' ? !!frameAffine(ctx.doc, ctx.page, panel) : !!panel.frame?.src?.path);

/**
 * Join two neighbouring frames into one (side by side or one above the other, sharing a whole edge). Only for frames
 * that are empty or not drawn yet: two drawn panels are drawn separately, so the menu offers to keep both or redraw.
 * The joined panel keeps the art (if one of them has it) and gets the other's lines.
 */
export function joinFramesEdit(doc: ComicDoc, page: Page, aId: string, bId: string): EditResult {
  const ctx = ctxOf(doc, page);
  if (typeof ctx === 'string') return refuse(ctx);
  const ia = indexOf(page, aId);
  const ib = indexOf(page, bId);
  if (ia < 0 || ib < 0 || ia === ib) return refuse('Pick two panels on this page to join.');
  const locked = lockOf(page, [aId, bId]);
  if (locked) return refuse(locked);
  const A = ctx.boxes[ia];
  const B = ctx.boxes[ib];
  const maxGap = Math.max(ctx.style.gutter * 2.5, 0.012);
  const sideBySide = Math.abs(A.y - B.y) <= TOL && Math.abs(A.h - B.h) <= TOL && Math.min(Math.abs(B.x - (A.x + A.w)), Math.abs(A.x - (B.x + B.w))) <= maxGap;
  const stacked = Math.abs(A.x - B.x) <= TOL && Math.abs(A.w - B.w) <= TOL && Math.min(Math.abs(B.y - (A.y + A.h)), Math.abs(A.y - (B.y + B.h))) <= maxGap;
  if (!sideBySide && !stacked) return refuse('Only panels side by side or one above the other, with a whole edge in common, can be joined.');
  const pa = page.panels[ia];
  const pb = page.panels[ib];
  const artA = showsArt(ctx, pa);
  const artB = showsArt(ctx, pb);
  if (artA && artB) return refuse('These two panels are drawn separately. Keep both, or redraw them as one panel.');
  // Keep the one with art; else the one that reads first.
  const keep = artB && !artA ? pb : ia <= ib ? pa : pb;
  const drop = keep === pa ? pb : pa;
  if (keep.lines.length + drop.lines.length > DOC_LIMITS.linesPerPanel) return refuse(`The joined panel would hold more than ${DOC_LIMITS.linesPerPanel} lines. Move some lines first.`);
  const U = roundBox({ x: Math.min(A.x, B.x), y: Math.min(A.y, B.y), w: Math.max(A.x + A.w, B.x + B.w) - Math.min(A.x, B.x), h: Math.max(A.y + A.h, B.y + B.h) - Math.min(A.y, B.y) });
  const boxes = ctx.boxes.slice();
  boxes[indexOf(page, keep.id)] = U;
  const ops: DocOp[] = [];
  const fop = framesOpOf(ctx, boxes);
  if (fop) ops.push(fop);
  ops.push({ op: 'panel_remove', pageId: page.id, id: drop.id, linesTo: keep.id });
  for (const layer of page.layers ?? []) if (layer.clip === drop.id) ops.push({ op: 'layer', pageId: page.id, id: layer.id, patch: { clip: keep.id } });
  return finish(ctx, ops, `Join ${panelsWord(page, [aId, bId])}`);
}

/**
 * Add a panel: a new frame drawn on the page (the Frame tool), in free space or fully inside another frame (an inset).
 * On a drawn page it is empty until an image is dropped or it is drawn; it reads where its position puts it.
 */
export function addFrameEdit(doc: ComicDoc, page: Page, box: Box, opts: { ids?: IdFactory } = {}): EditResult {
  const ctx = ctxOf(doc, page);
  if (typeof ctx === 'string') return refuse(ctx);
  if (page.panels.length >= DOC_LIMITS.panelsPerPage) return refuse(`A page holds at most ${DOC_LIMITS.panelsPerPage} panels.`);
  if (![box.x, box.y, box.w, box.h].every(Number.isFinite)) return refuse('Draw the panel on the page.');
  const m = ctx.style.margin;
  const w = clamp(box.w, FRAME_MIN, 1 - 2 * m);
  const h = clamp(box.h, FRAME_MIN, 1 - 2 * m);
  const b = roundBox({ x: clamp(box.x, m, 1 - m - w), y: clamp(box.y, m, 1 - m - h), w, h });
  const host = ctx.boxes.findIndex((o) => contains(o, b));
  const hit = ctx.boxes.some((o, k) => k !== host && overlap(span(o, 'x'), span(b, 'x')) > 1e-4 && overlap(span(o, 'y'), span(b, 'y')) > 1e-4);
  if (hit) return refuse('Panels cannot overlap. Draw it in free space, or fully inside another panel as an inset.');
  const order = readingOrderOf([...ctx.boxes, b], ctx.rtl);
  const pos = order.indexOf(ctx.boxes.length);
  const index = order.slice(0, pos).filter((k) => k < ctx.boxes.length).length;
  const id = freshId('panel', takenIds(doc, page), opts.ids ?? defaultIds);
  const frame: PanelFrame = { box: b, ...(host >= 0 ? { z: Math.min(PRO_PAGE_LIMITS.zMax, (page.panels[host].frame?.z ?? 0) + 1) } : {}) };
  const panel: Panel = { id, n: 0, size: 'medium', shot: 'medium', action: '', castIds: [], lines: [], frame };
  const ops: DocOp[] = [];
  // Seed frames for a planned page first, so every panel keeps its place.
  const seed = framesOpOf(ctx, ctx.boxes);
  if (seed) ops.push(seed);
  ops.push({ op: 'panel_add', pageId: page.id, panel, index });
  const notes = ctx.undrawn ? [] : [`Panel ${index + 1} is empty. Drop an image here, or draw this panel.`];
  return finish(ctx, ops, `Add panel ${index + 1}`, notes);
}

/** Extend frames into empty space, up to the margins or the next frame (one gutter away). */
function fillGaps(items: Item[], style: FrameStyle, only?: ReadonlySet<string>): Item[] {
  const out = items.map((it) => ({ ...it, box: { ...it.box } }));
  const isInset = (it: Item) => out.some((o) => o !== it && contains(o.box, it.box));
  for (let pass = 0; pass < 2; pass++) {
    for (const axis of ['x', 'y'] as const) {
      for (const it of out) {
        if ((only && !only.has(it.id)) || isInset(it)) continue;
        const others = out.filter((o) => o !== it && !isInset(o) && overlap(perp(o.box, axis), perp(it.box, axis)) > TOL);
        const sp = span(it.box, axis);
        let hi = 1 - style.margin;
        let lo = style.margin;
        for (const o of others) {
          const os = span(o.box, axis);
          if (os.s >= sp.e - TOL) hi = Math.min(hi, os.s - style.gutter);
          if (os.e <= sp.s + TOL) lo = Math.max(lo, os.e + style.gutter);
        }
        const s = lo < sp.s - TOL ? lo : sp.s;
        const e = hi > sp.e + TOL ? hi : sp.e;
        it.box = roundBox(axis === 'x' ? { ...it.box, x: s, w: e - s } : { ...it.box, y: s, h: e - s });
      }
    }
  }
  return out;
}

/** Close the gaps around frames: each one (or only `panelId`) grows into empty space up to its neighbours. */
export function closeGapEdit(doc: ComicDoc, page: Page, panelId?: string): EditResult {
  const ctx = ctxOf(doc, page);
  if (typeof ctx === 'string') return refuse(ctx);
  const ids = panelId ? [panelId] : page.panels.map((p) => p.id);
  if (panelId && indexOf(page, panelId) < 0) return refuse('That panel is not on this page.');
  const free = ids.filter((id) => !lockedReason(page, { kind: 'frame', id }));
  if (!free.length) return refuse(lockOf(page, ids)!);
  const items = fillGaps(itemsOf(ctx), ctx.style, new Set(free));
  const op = framesOpOf(ctx, boxesOfItems(ctx, items));
  if (!op) return refuse('There is no gap to close.');
  return finish(ctx, [op], panelId ? `Close the gap around ${panelWord(page, panelId)}` : 'Close the gaps between panels');
}

/**
 * Delete a panel: its lines go to the previous panel (or the next one for the first), to `linesTo`, or are deleted
 * with it (`linesTo: null`); the frames next to it close the gap.
 */
export function deleteFrameEdit(doc: ComicDoc, page: Page, panelId: string, opts: { linesTo?: string | null } = {}): EditResult {
  const ctx = ctxOf(doc, page);
  if (typeof ctx === 'string') return refuse(ctx);
  const i = indexOf(page, panelId);
  if (i < 0) return refuse('That panel is not on this page.');
  if (page.panels.length < 2) return refuse('A page needs at least one panel.');
  const locked = lockOf(page, [panelId]);
  if (locked) return refuse(locked);
  const panel = page.panels[i];
  const target = opts.linesTo === null ? undefined : opts.linesTo !== undefined ? page.panels.find((p) => p.id === opts.linesTo && p.id !== panelId) : page.panels[i > 0 ? i - 1 : 1];
  if (opts.linesTo && !target) return refuse('Those lines need a panel on this page to go to.');
  if (target && panel.lines.length && target.lines.length + panel.lines.length > DOC_LIMITS.linesPerPanel) {
    return refuse(`${cap1(panelWord(page, target.id))} would hold more than ${DOC_LIMITS.linesPerPanel} lines. Move some lines first, or delete them with the panel.`);
  }
  const removed = ctx.boxes[i];
  const rest = itemsOf(ctx).filter((it) => it.id !== panelId);
  const maxGap = Math.max(ctx.style.gutter * 2.5, 0.012);
  const near = rest.filter((it) => {
    if (lockedReason(page, { kind: 'frame', id: it.id })) return false;
    const gx = Math.max(it.box.x - (removed.x + removed.w), removed.x - (it.box.x + it.box.w));
    const gy = Math.max(it.box.y - (removed.y + removed.h), removed.y - (it.box.y + it.box.h));
    return (gx <= maxGap && overlap(perp(it.box, 'x'), perp(removed, 'x')) > TOL) || (gy <= maxGap && overlap(perp(it.box, 'y'), perp(removed, 'y')) > TOL);
  });
  const grown = fillGaps(rest, ctx.style, new Set(near.map((n) => n.id)));
  const ops: DocOp[] = [];
  const boxes = ctx.page.panels.map((p, k) => grown.find((g) => g.id === p.id)?.box ?? ctx.boxes[k]);
  const fop = framesOpOf(ctx, boxes);
  if (fop && fop.op === 'page_frames') {
    // The deleted panel's own frame is not touched (it leaves with the panel).
    fop.frames = fop.frames!.filter((f) => f.panelId !== panelId);
    if (fop.frames.length) ops.push(fop);
  }
  ops.push({ op: 'panel_remove', pageId: page.id, id: panelId, ...(target ? { linesTo: target.id } : {}) });
  const notes = panel.lines.length ? [target ? `Its lines moved to ${panelWord(page, target.id)}.` : 'Its lines were deleted with it.'] : [];
  return finish(ctx, ops, `Delete ${panelWord(page, panelId)}`, notes);
}

// ── Sizes ────────────────────────────────────────────────────────────────────

/** Frames that share a panel's row (same top and height) or column (same left and width), in order along the axis. */
const lineOf = (ctx: Ctx, panelId: string, axis: 'row' | 'column'): Item[] => {
  const items = itemsOf(ctx);
  const me = items.find((it) => it.id === panelId)!;
  const same = items.filter((it) =>
    axis === 'row' ? Math.abs(it.box.y - me.box.y) <= TOL && Math.abs(it.box.h - me.box.h) <= TOL : Math.abs(it.box.x - me.box.x) <= TOL && Math.abs(it.box.w - me.box.w) <= TOL
  );
  return same.sort((a, b) => (axis === 'row' ? a.box.x - b.box.x : a.box.y - b.box.y));
};

/** Make the panels in a panel's row the same width (or its column the same height), keeping the gaps between them. */
export function equalizeEdit(doc: ComicDoc, page: Page, panelId: string, axis: 'row' | 'column'): EditResult {
  const ctx = ctxOf(doc, page);
  if (typeof ctx === 'string') return refuse(ctx);
  if (indexOf(page, panelId) < 0) return refuse('That panel is not on this page.');
  const line = lineOf(ctx, panelId, axis);
  if (line.length < 2) return refuse(`${cap1(panelWord(page, panelId))} has no neighbours in its ${axis}.`);
  const locked = lockOf(page, line.map((l) => l.id));
  if (locked) return refuse(locked);
  const k = axis === 'row' ? 'x' : 'y';
  const sz = axis === 'row' ? 'w' : 'h';
  const start = line[0].box[k];
  const end = line[line.length - 1].box[k] + line[line.length - 1].box[sz];
  const gaps: number[] = [];
  for (let j = 0; j + 1 < line.length; j++) gaps.push(line[j + 1].box[k] - (line[j].box[k] + line[j].box[sz]));
  const each = (end - start - gaps.reduce((s, g) => s + g, 0)) / line.length;
  if (each < FRAME_MIN) return refuse('There is not enough room to make them equal.');
  let at = start;
  const next = new Map<string, Box>();
  line.forEach((it, j) => {
    next.set(it.id, roundBox({ ...it.box, [k]: at, [sz]: each }));
    at += each + (gaps[j] ?? 0);
  });
  const boxes = ctx.page.panels.map((p, j) => next.get(p.id) ?? ctx.boxes[j]);
  const op = framesOpOf(ctx, boxes);
  if (!op) return refuse(NOTHING_TO_CHANGE);
  const ops = [op];
  return finish(ctx, ops, axis === 'row' ? `Make the panels in ${panelWord(page, panelId)}'s row the same width` : `Make the panels in ${panelWord(page, panelId)}'s column the same height`, softNotes(ctx, ops, line.map((l) => l.id)));
}

/**
 * Make a panel the biggest on the page: its row (band) takes at least half the page height (60% with two bands) and,
 * in a row of panels, it takes ⅔ of the row (½ with three or more). Everything stays tiled and above frameMin.
 */
export function makeBiggestEdit(doc: ComicDoc, page: Page, panelId: string): EditResult {
  const ctx = ctxOf(doc, page);
  if (typeof ctx === 'string') return refuse(ctx);
  const i = indexOf(page, panelId);
  if (i < 0) return refuse('That panel is not on this page.');
  let items = itemsOf(ctx);
  const me = items[i];
  if (items.some((o) => o !== me && contains(o.box, me.box))) return refuse('An inset stays small. Move it out of its panel first.');
  const mine = lockOf(page, [panelId]);
  if (mine) return refuse(mine);
  // Bands: frames grouped by vertical overlap (insets ride in their host's band).
  const bands: Item[][] = [];
  for (const it of [...items].sort((a, b) => a.box.y - b.box.y)) {
    const band = bands.find((b) => b.some((o) => overlap(span(o.box, 'y'), span(it.box, 'y')) > TOL));
    if (band) band.push(it);
    else bands.push([it]);
  }
  const extent = (band: Item[]) => {
    const y = Math.min(...band.map((b) => b.box.y));
    return { y, h: Math.max(...band.map((b) => b.box.y + b.box.h)) - y };
  };
  if (bands.length >= 2) {
    const ext = bands.map(extent);
    const T = bands.findIndex((b) => b.includes(me));
    const total = ext.reduce((s, e) => s + e.h, 0);
    const cur = ext[T].h / total;
    const want = Math.max(cur, bands.length === 2 ? 0.6 : 0.5);
    if (want > cur + 1e-4) {
      const scaleT = (want * total) / ext[T].h;
      const scaleO = ((1 - want) * total) / (total - ext[T].h);
      const gaps = ext.slice(1).map((e, k) => e.y - (ext[k].y + ext[k].h));
      let y = ext[0].y;
      const maps = ext.map((e, k) => {
        const s = k === T ? scaleT : scaleO;
        const m = { from: e.y, to: y, s };
        y += e.h * s + (gaps[k] ?? 0);
        return m;
      });
      const scaled = items.map((it) => {
        const k = bands.findIndex((b) => b.includes(it));
        const m = maps[k];
        return { ...it, box: roundBox({ ...it.box, y: m.to + (it.box.y - m.from) * m.s, h: it.box.h * m.s }) };
      });
      if (scaled.every((it) => it.box.h >= FRAME_MIN - 1e-6)) items = scaled;
    }
  }
  const row = items.filter((it) => Math.abs(it.box.y - items[i].box.y) <= TOL && Math.abs(it.box.h - items[i].box.h) <= TOL).sort((a, b) => a.box.x - b.box.x);
  if (row.length >= 2) {
    const start = row[0].box.x;
    const end = row[row.length - 1].box.x + row[row.length - 1].box.w;
    const gaps: number[] = [];
    for (let j = 0; j + 1 < row.length; j++) gaps.push(row[j + 1].box.x - (row[j].box.x + row[j].box.w));
    const content = end - start - gaps.reduce((s, g) => s + g, 0);
    const self = row.find((r) => r.id === panelId)!;
    const want = Math.max(self.box.w / content, row.length === 2 ? 2 / 3 : 1 / 2) * content;
    const others = (content - want) / (row.length - 1);
    if (others >= FRAME_MIN && want > self.box.w + 1e-4) {
      let x = start;
      const widths = new Map(row.map((r) => [r.id, r.id === panelId ? want : others]));
      const placed = new Map<string, Box>();
      row.forEach((r, j) => {
        placed.set(r.id, roundBox({ ...r.box, x, w: widths.get(r.id)! }));
        x += widths.get(r.id)! + (gaps[j] ?? 0);
      });
      items = items.map((it) => (placed.has(it.id) ? { ...it, box: placed.get(it.id)! } : it));
    }
  }
  const changed = items.filter((it, k) => !sameBox(it.box, ctx.boxes[k], 1e-5)).map((it) => it.id);
  const lockedN = lockOf(page, changed);
  if (lockedN) return refuse(lockedN);
  const op = framesOpOf(ctx, boxesOfItems(ctx, items));
  if (!op) return refuse(`${cap1(panelWord(page, panelId))} is already as big as it can get here.`);
  const ops = [op];
  return finish(ctx, ops, `Make ${panelWord(page, panelId)} the biggest`, softNotes(ctx, ops, page.panels.map((p) => p.id)));
}

// ── Pictures in frames ───────────────────────────────────────────────────────

/** Extra picture sources a page would show besides its own drawing (EDITOR_LIMITS.sourcesPerPage). */
const extraSources = (page: Page, override: Map<string, PanelFrameSource | undefined>): number =>
  new Set(
    page.panels
      .map((p) => (override.has(p.id) ? override.get(p.id)?.path : p.frame?.src?.path))
      .filter((path): path is string => !!path && path !== page.render.asset?.path)
  ).size;
const TOO_MANY_SOURCES = `This page already shows pictures from ${EDITOR_LIMITS.sourcesPerPage} other takes or images. Flatten the page first (free).`;

const framesOnly = (ctx: Ctx): string | undefined =>
  ctx.mode === 'panels' || ctx.mode === 'planned' ? undefined : ctx.undrawn ? `Page ${ctx.page.n} is not drawn yet: pick a layout for it first.` : `Page ${ctx.page.n} is shown as drawn. Make its panels editable first (free).`;

export interface TakeRef {
  /** The take's picture (a version of this page: current, earlier, or archived). */
  path: string;
  /** Use this panel's part of that take (default: the same panel). */
  fromPanelId?: string;
}

/** Where a panel sits on an earlier take: its cuts, else its check's boxes, else the page's blueprint. */
const takeBoxFor = (doc: ComicDoc, page: Page, version: VersionMeta, panelId: string): Box | undefined => {
  const idx = indexOf(page, panelId);
  const cuts = version.cuts?.cuts;
  if (Array.isArray(cuts) && cuts.length) {
    const named = cuts.find((c) => c.panelId === panelId);
    if (named) return named.box;
    if (!cuts.some((c) => c.panelId) && cuts[idx]) return cuts[idx].box;
  }
  const qcBoxes = version.qc?.panelBoxes;
  if (Array.isArray(qcBoxes) && qcBoxes.length === page.panels.length && qcBoxes[idx]) return qcBoxes[idx];
  return drawnLayoutBoxes(doc, page)[idx];
};

/** "Use panel 2 from take 1": a frame shows its panel from another take of this page (free). */
export function useTakeEdit(doc: ComicDoc, page: Page, panelId: string, take: TakeRef): EditResult {
  const ctx = ctxOf(doc, page);
  if (typeof ctx === 'string') return refuse(ctx);
  const blocked = framesOnly(ctx);
  if (blocked) return refuse(blocked);
  const panel = page.panels.find((p) => p.id === panelId);
  if (!panel) return refuse('That panel is not on this page.');
  const locked = lockOf(page, [panelId]);
  if (locked) return refuse(locked);
  const from = take.fromPanelId ?? panelId;
  if (indexOf(page, from) < 0) return refuse('That panel is not on this page.');
  const entry = versionList(doc, { kind: 'page', id: page.id }).find((v) => v.path === take.path);
  if (!entry) return refuse('That picture is not a take of this page.');
  const label = `Use ${panelWord(page, from)} from take ${entry.n}${from !== panelId ? ` in ${panelWord(page, panelId)}` : ''}`;
  let src: PanelFrameSource | undefined;
  if (entry.current && from === panelId && cutFor(page, panel)) src = undefined;
  else {
    const raw = entry.current ? cutFor(page, page.panels[indexOf(page, from)])?.box ?? takeBoxFor(doc, page, page.render, from) : takeBoxFor(doc, page, entry.version as VersionMeta, from);
    const box = raw ? imageBox(raw) : undefined;
    src = { path: entry.path, ...(box ? { box } : {}) };
  }
  if (JSON.stringify(src) === JSON.stringify(panel.frame?.src)) return refuse(NOTHING_TO_CHANGE);
  if (extraSources(page, new Map([[panelId, src]])) > EDITOR_LIMITS.sourcesPerPage) return refuse(TOO_MANY_SOURCES);
  const op = framesOpOf(ctx, ctx.boxes, new Map([[panelId, { src, fit: undefined }]]));
  const ops = op ? [op] : [];
  return finish(ctx, ops, label, softNotes(ctx, ops, [panelId]));
}

/** Swap what two frames show (their pictures and crops); the panels keep their lines and their place. */
export function swapPicturesEdit(doc: ComicDoc, page: Page, aId: string, bId: string): EditResult {
  const ctx = ctxOf(doc, page);
  if (typeof ctx === 'string') return refuse(ctx);
  const blocked = framesOnly(ctx);
  if (blocked) return refuse(blocked);
  const pa = page.panels.find((p) => p.id === aId);
  const pb = page.panels.find((p) => p.id === bId);
  if (!pa || !pb || pa === pb) return refuse('Pick two panels on this page.');
  const locked = lockOf(page, [aId, bId]);
  if (locked) return refuse(locked);
  const picA = pictureOf(page, pa);
  const picB = pictureOf(page, pb);
  if (!picA && !picB) return refuse('Both panels are empty.');
  // A picture that is a panel's own cut of the drawing is stored as "no source".
  const asSrc = (panel: Panel, pic: PanelFrameSource | undefined): PanelFrameSource | undefined => {
    const own = cutFor(page, panel);
    if (pic && own && pic.path === page.render.asset?.path && pic.box && sameBox(pic.box, own.box, 1e-6)) return undefined;
    return pic ? { path: pic.path, ...(pic.box ? { box: { ...pic.box } } : {}) } : undefined;
  };
  const srcA = asSrc(pa, picB);
  const srcB = asSrc(pb, picA);
  // An empty frame that would show its own cut again needs a source of nothing: only possible when it has no cut.
  if (!picB && cutFor(page, pa)) return refuse(`${cap1(panelWord(page, bId))} is empty, so there is nothing to swap into ${panelWord(page, aId)}.`);
  if (!picA && cutFor(page, pb)) return refuse(`${cap1(panelWord(page, aId))} is empty, so there is nothing to swap into ${panelWord(page, bId)}.`);
  const patches = new Map<string, Partial<Record<keyof PanelFrame, unknown>>>([
    [aId, { src: srcA, fit: pb.frame?.fit ? { ...pb.frame.fit } : undefined }],
    [bId, { src: srcB, fit: pa.frame?.fit ? { ...pa.frame.fit } : undefined }]
  ]);
  const op = framesOpOf(ctx, ctx.boxes, patches, false);
  const ops = op ? [op] : [];
  return finish(ctx, ops, `Swap the pictures in ${panelsWord(page, [aId, bId])}`, softNotes(ctx, ops, [aId, bId]));
}

/** Crop, pan and zoom the picture inside a frame (fit: zoom 1..EDITOR_LIMITS.fitZoomMax, pan −1..1; null = fill, centred). */
export function reframeEdit(doc: ComicDoc, page: Page, panelId: string, fit: PanelFrameFit | null): EditResult {
  const ctx = ctxOf(doc, page);
  if (typeof ctx === 'string') return refuse(ctx);
  const blocked = framesOnly(ctx);
  if (blocked) return refuse(blocked);
  const panel = page.panels.find((p) => p.id === panelId);
  if (!panel) return refuse('That panel is not on this page.');
  const locked = lockOf(page, [panelId]);
  if (locked) return refuse(locked);
  if (!showsArt(ctx, panel)) return refuse(`${cap1(panelWord(page, panelId))} is empty: there is no picture to crop yet.`);
  let next: PanelFrameFit | undefined;
  if (fit) {
    const s = r4(clamp(fit.s, 1, EDITOR_LIMITS.fitZoomMax));
    const x = r4(clamp(fit.x, -1, 1));
    const y = r4(clamp(fit.y, -1, 1));
    next = s === 1 && x === 0 && y === 0 ? undefined : { s, x, y };
  }
  if (JSON.stringify(next) === JSON.stringify(panel.frame?.fit)) return refuse(NOTHING_TO_CHANGE);
  const op = framesOpOf(ctx, ctx.boxes, new Map([[panelId, { fit: next }]]));
  const ops = op ? [op] : [];
  return finish(ctx, ops, next ? `Crop ${panelWord(page, panelId)}` : `Show all of ${panelWord(page, panelId)}`, softNotes(ctx, ops, [panelId]));
}

/** Default zoom of a close-up against what the panel shows now. */
export const CLOSE_UP_ZOOM = 2;

/**
 * "Make a close-up" (free): the panel's frame is split, and the new half shows a crop around a character's head (from
 * the page check's heads; the panel's centre when unknown) at 2× by default, from the same drawing. The new panel's
 * script reads "Close-up of Maya" with Maya as its cast. The half that keeps the character stays as it is.
 */
export function closeUpEdit(doc: ComicDoc, page: Page, panelId: string, opts: { castId?: string; zoom?: number; ids?: IdFactory } = {}): EditResult {
  const ctx = ctxOf(doc, page);
  if (typeof ctx === 'string') return refuse(ctx);
  if (ctx.mode !== 'panels') return refuse(ctx.undrawn ? 'Draw the page first: a close-up is cut from the drawing.' : `Page ${page.n} is shown as drawn. Make its panels editable first (free).`);
  const i = indexOf(page, panelId);
  if (i < 0) return refuse('That panel is not on this page.');
  const locked = lockOf(page, [panelId]);
  if (locked) return refuse(locked);
  const panel = page.panels[i];
  const aff = frameAffine(doc, page, panel);
  if (!aff || !aff.path) return refuse(`${cap1(panelWord(page, panelId))} is empty: there is nothing to make a close-up of.`);
  // Who: the asked character, else the first speaker of the panel, else its first cast member.
  const speaker = panel.lines.find((l) => l.speakerId)?.speakerId;
  const castId = opts.castId ?? speaker ?? panel.castIds[0];
  const heads = aff.raster ? page.render.qc?.heads ?? [] : [];
  const mark = heads.find((h) => h && h.panel === panel.n && (!castId || h.characterId === castId)) ?? (castId ? undefined : heads.find((h) => h && h.panel === panel.n));
  const centre = mark?.head && Number.isFinite(mark.head.x) && Number.isFinite(mark.head.y) ? mark.head : centreOf(aff.src);
  const zoom = clamp(opts.zoom ?? CLOSE_UP_ZOOM, 1, EDITOR_LIMITS.fitZoomMax);
  const w = aff.src.w / zoom;
  const h = aff.src.h / zoom;
  const crop = imageBox({ x: clamp(centre.x - w / 2, 0, 1 - w), y: clamp(centre.y - h / 2, 0, 1 - h), w, h });
  if (!crop) return refuse('That part of the picture is too small for a close-up.');
  const F = ctx.boxes[i];
  const dir: SplitDir = F.w * formatAspectOf(ctx.doc) >= F.h ? 'across' : 'down';
  // The new half is the one that does NOT show the character now, so the drawn character stays where it is.
  const headOnPage = aff.toPage(centre);
  const firstHalf = dir === 'across' ? (ctx.rtl ? headOnPage.x >= F.x + F.w / 2 : headOnPage.x < F.x + F.w / 2) : headOnPage.y < F.y + F.h / 2;
  const newSide = firstHalf ? 'second' : 'first';
  const plan = planSplit(ctx, panelId, dir, 0.5, newSide, opts.ids ?? defaultIds, { path: aff.path, box: crop });
  if (typeof plan === 'string') return refuse(plan);
  const add = plan.ops[0];
  if (add.op === 'panel_add') {
    const who = castId ? ctx.doc.cast.find((c) => c.id === castId) : undefined;
    add.panel = { ...add.panel, shot: 'close_up', action: who ? `Close-up of ${who.name}` : 'Close-up', castIds: who ? [who.id] : [], lines: add.panel.lines };
  }
  if (extraSources(applyAll(doc, plan.ops).pages.find((p) => p.id === page.id)!, new Map()) > EDITOR_LIMITS.sourcesPerPage) return refuse(TOO_MANY_SOURCES);
  return finish(ctx, plan.ops, `Make a close-up from ${panelWord(page, panelId)}`, softNotes(ctx, plan.ops, [plan.newId]));
}
