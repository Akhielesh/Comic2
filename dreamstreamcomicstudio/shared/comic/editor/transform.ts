// Move, resize and rotate (Ship 2, B9; pro plan §4.5, design §4.3). Pure geometry on page-normalized boxes, plus the
// K2a ops that commit a transform of an overlay or a balloon. Frames move and resize through frames.ts (they tile:
// a resize pushes the neighbours that share its gutter). Rotation is in degrees, clockwise, 0 = upright.

import { EDITOR_LIMITS, PRO_PAGE_LIMITS } from '../limits.js';
import { layersOf, type Balloon, type BalloonGeometryOverride, type Box, type ComicDoc, type Page } from '../doc.js';
import { i18nOf } from '../i18n.js';
import { buildScene, clamp, editOf, lockedReason, NOTHING_TO_CHANGE, r4, refuse, roundBox, sameBox, sceneObject, UNIT_BOX, type EditResult, type PageScene, type Point, type SceneRef } from './scene.js';

export type Handle = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw';
export const HANDLES: readonly Handle[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];

/** Arrow keys move 0.5% of the page; with Shift 2% (design §4.3). */
export const NUDGE = { step: 0.005, big: 0.02 } as const;
/** Rotation detents (Shift, or a touch detent): every 15°, which includes 0, 45 and 90. */
export const ROTATE_STEP = 15;
/** Smallest side of a balloon outline or an overlay the handles allow. */
export const MIN_OBJECT_SIDE = 0.02;

/** A box moved (not resized) so it lies inside `bounds`; a box larger than bounds keeps its size and aligns to the start. */
export const clampBoxInto = (box: Box, bounds: Box = UNIT_BOX): Box => {
  const x = box.w >= bounds.w ? bounds.x : clamp(box.x, bounds.x, bounds.x + bounds.w - box.w);
  const y = box.h >= bounds.h ? bounds.y : clamp(box.y, bounds.y, bounds.y + bounds.h - box.h);
  return { x, y, w: box.w, h: box.h };
};

/** Move by (dx, dy), kept inside `bounds`. */
export const moveBox = (box: Box, dx: number, dy: number, bounds: Box = UNIT_BOX): Box => clampBoxInto({ ...box, x: box.x + dx, y: box.y + dy }, bounds);

export type NudgeDir = 'left' | 'right' | 'up' | 'down';
/** One arrow-key nudge (Shift = big). */
export const nudgeBox = (box: Box, dir: NudgeDir, big = false, bounds: Box = UNIT_BOX): Box => {
  const d = big ? NUDGE.big : NUDGE.step;
  return moveBox(box, dir === 'left' ? -d : dir === 'right' ? d : 0, dir === 'up' ? -d : dir === 'down' ? d : 0, bounds);
};

export interface ResizeOptions {
  /** Smallest width / height (page fractions). */
  minW?: number;
  minH?: number;
  /** Keep the box's shape (Shift; image overlays by default). */
  keepAspect?: boolean;
  /** Resize around the centre (Alt). */
  fromCentre?: boolean;
  bounds?: Box;
}

/**
 * Resize by dragging one of the eight handles by (dx, dy) page fractions. The opposite edge (or the centre) stays put;
 * sides never go below their minimum nor outside `bounds`. With keepAspect the box keeps its width : height.
 */
export function resizeBox(box: Box, handle: Handle, dx: number, dy: number, opts: ResizeOptions = {}): Box {
  const bounds = opts.bounds ?? UNIT_BOX;
  const minW = Math.max(1e-4, opts.minW ?? MIN_OBJECT_SIDE);
  const minH = Math.max(1e-4, opts.minH ?? MIN_OBJECT_SIDE);
  const k = opts.fromCentre ? 2 : 1;
  const sx = handle.includes('e') ? 1 : handle.includes('w') ? -1 : 0;
  const sy = handle.includes('s') ? 1 : handle.includes('n') ? -1 : 0;
  let w = box.w + sx * dx * k;
  let h = box.h + sy * dy * k;
  if (opts.keepAspect && box.w > 0 && box.h > 0) {
    const ratio = box.w / box.h;
    if (sx && sy) {
      // Corner: the larger relative change wins.
      if (Math.abs(w / box.w - 1) >= Math.abs(h / box.h - 1)) h = w / ratio;
      else w = h * ratio;
    } else if (sx) h = w / ratio;
    else w = h * ratio;
  }
  // Room on each side, from the anchor that stays put.
  const cx = box.x + box.w / 2;
  const cy = box.y + box.h / 2;
  const maxW = opts.fromCentre ? 2 * Math.min(cx - bounds.x, bounds.x + bounds.w - cx) : sx > 0 ? bounds.x + bounds.w - box.x : sx < 0 ? box.x + box.w - bounds.x : bounds.w;
  const maxH = opts.fromCentre ? 2 * Math.min(cy - bounds.y, bounds.y + bounds.h - cy) : sy > 0 ? bounds.y + bounds.h - box.y : sy < 0 ? box.y + box.h - bounds.y : bounds.h;
  if (opts.keepAspect && box.w > 0 && box.h > 0) {
    const ratio = box.w / box.h;
    let s = Math.min(1, maxW / Math.max(w, 1e-9), maxH / Math.max(h, 1e-9));
    w *= s;
    h *= s;
    s = Math.max(1, minW / Math.max(w, 1e-9), minH / Math.max(h, 1e-9));
    w = Math.min(w * s, maxW);
    h = Math.min(w / ratio, maxH);
  } else {
    w = clamp(w, Math.min(minW, maxW), maxW);
    h = clamp(h, Math.min(minH, maxH), maxH);
  }
  let x = box.x;
  let y = box.y;
  if (opts.fromCentre) {
    x = cx - w / 2;
    y = cy - h / 2;
  } else {
    if (sx < 0) x = box.x + box.w - w;
    else if (sx === 0) x = cx - w / 2;
    if (sy < 0) y = box.y + box.h - h;
    else if (sy === 0) y = cy - h / 2;
  }
  return roundBox(clampBoxInto({ x, y, w, h }, bounds));
}

/** Degrees into −180..180. */
export const normalizeDeg = (deg: number): number => {
  if (!Number.isFinite(deg)) return 0;
  let d = deg % 360;
  if (d > 180) d -= 360;
  if (d <= -180) d += 360;
  return d === 0 ? 0 : d; // no −0
};
/** The nearest detent (every `step` degrees). */
export const snapAngle = (deg: number, step = ROTATE_STEP): number => normalizeDeg(Math.round(deg / step) * step);
/** Clamp to ±limit (balloons ±45, overlays ±180). */
export const clampRot = (deg: number, limit: number): number => {
  const d = normalizeDeg(deg);
  return d === 180 && limit >= 180 ? 180 : clamp(d, -limit, limit);
};

/**
 * The rotation a pointer sets with the round handle above an object: the angle of the pointer around the object's
 * centre (0 = straight up, clockwise positive), in physical units (`aspect` = page width ÷ height), snapped to 15° when
 * asked and clamped to ±limit.
 */
export const rotationFromPointer = (centre: Point, pointer: Point, opts: { aspect: number; limit: number; snap?: boolean }): number => {
  const dx = (pointer.x - centre.x) * opts.aspect;
  const dy = pointer.y - centre.y;
  if (Math.abs(dx) < 1e-9 && Math.abs(dy) < 1e-9) return 0;
  const deg = (Math.atan2(dx, -dy) * 180) / Math.PI;
  return clampRot(opts.snap ? snapAngle(deg) : Math.round(deg * 10) / 10, opts.limit);
};

/** A point rotated about a centre by `deg` degrees in physical units (page aspect), back in page fractions. */
export const rotatePoint = (p: Point, centre: Point, deg: number, aspect: number): Point => {
  const a = (deg * Math.PI) / 180;
  const dx = (p.x - centre.x) * aspect;
  const dy = p.y - centre.y;
  return { x: centre.x + (dx * Math.cos(a) - dy * Math.sin(a)) / aspect, y: centre.y + (dx * Math.sin(a) + dy * Math.cos(a)) };
};

/** The axis-aligned bounds of a box rotated about its centre (what it covers on the page). */
export const rotatedBounds = (box: Box, deg: number, aspect: number): Box => {
  if (!deg) return { ...box };
  const c = { x: box.x + box.w / 2, y: box.y + box.h / 2 };
  const pts = [
    { x: box.x, y: box.y },
    { x: box.x + box.w, y: box.y },
    { x: box.x, y: box.y + box.h },
    { x: box.x + box.w, y: box.y + box.h }
  ].map((p) => rotatePoint(p, c, deg, aspect));
  const xs = pts.map((p) => p.x);
  const ys = pts.map((p) => p.y);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
};

// ── Ops: overlays and balloons ───────────────────────────────────────────────

const overlayOf = (page: Page, id: string) => layersOf(page).find((l) => l.id === id);

/**
 * Put an overlay or a balloon at a new box (a move, a resize, or both). Overlays take the box as is (clamped to the
 * page, smallest side PRO_PAGE_LIMITS.boxMin). A balloon's text box moves with its outline and its width changes by
 * the outline's; a height change sets its minimum height (the height handle, ≤ EDITOR_LIMITS.minHMax). Frames go
 * through frames.ts. Locked objects refuse.
 *
 * In a language edition's scene (scene.lang) a balloon moves for that language only: an edition_balloon op with its
 * own x, y and width, never the original language's balloon. The height is shared by every language.
 */
export function setBoxEdit(doc: ComicDoc, page: Page, ref: SceneRef, to: Box, scene: PageScene = buildScene(doc, page)): EditResult {
  const locked = lockedReason(page, ref);
  if (locked) return refuse(locked);
  const me = sceneObject(scene, ref);
  if (!me) return refuse('That is not on this page.');
  if (ref.kind === 'page') return refuse('The page itself does not move.');
  if (ref.kind === 'frame') return refuse('Panels move with the panel tools, so the page stays tiled.');
  if (![to.x, to.y, to.w, to.h].every(Number.isFinite) || to.w <= 0 || to.h <= 0) return refuse('That size does not fit on the page.');
  const moved = sameBox(me.box, to, 1e-4) === false;
  if (!moved) return refuse(NOTHING_TO_CHANGE);
  const resized = Math.abs(me.box.w - to.w) > 1e-4 || Math.abs(me.box.h - to.h) > 1e-4;
  const verb = resized ? 'Resize' : 'Move';
  if (ref.kind === 'overlay') {
    const layer = overlayOf(page, ref.id)!;
    const min = PRO_PAGE_LIMITS.boxMin;
    const w = clamp(to.w, min, 1);
    const h = clamp(to.h, min, 1);
    const box = roundBox(clampBoxInto({ x: to.x, y: to.y, w, h }));
    if (sameBox(box, layer.box, 1e-4)) return refuse(NOTHING_TO_CHANGE);
    return editOf(doc, [{ op: 'layer', pageId: page.id, id: layer.id, patch: { box } }], `${verb} ${me.label.toLowerCase()}`);
  }
  if (scene.lang) return editionBoxEdit(doc, page, scene.lang, ref.id, me.box, me.text!, to, verb, me.label);
  // Balloon: move its text box by the outline's offset; width by the outline's; height → minH.
  const text = me.text!;
  const patch: Partial<Balloon> = {
    x: r4(clamp(text.x + (to.x - me.box.x), 0, 1)),
    y: r4(clamp(text.y + (to.y - me.box.y), 0, 1)),
    pinned: true
  };
  if (Math.abs(me.box.w - to.w) > 1e-4) patch.w = r4(clamp(text.w + (to.w - me.box.w), 0.04, 1));
  if (Math.abs(me.box.h - to.h) > 1e-4) patch.minH = r4(clamp(to.h, 0.01, EDITOR_LIMITS.minHMax));
  // The tail tip stays where it points (on a head); only the body moves, as in today's lettering editor. A line the
  // software placed (no stored balloon yet) gets its whole drawn box.
  const b = page.balloons.find((x) => x.lineId === ref.id);
  if (!b && !('w' in patch)) patch.w = r4(text.w);
  return editOf(doc, [{ op: 'balloon', pageId: page.id, lineId: ref.id, patch }], `${verb} ${me.label.split(':')[0].toLowerCase()}`);
}

/** The height is one for every language (the balloon's minimum height); an edition moves and widens its own balloons. */
export const EDITION_HEIGHT_SHARED = 'The height is the same in every language. Change it in the original language.';

/** A balloon moved or widened in one language edition (edition_balloon), never the original language's balloon. */
function editionBoxEdit(doc: ComicDoc, page: Page, lang: string, lineId: string, from: Box, text: { x: number; y: number; w: number }, to: Box, verb: string, label: string): EditResult {
  const edition = i18nOf(doc).editions[lang];
  if (!edition) return refuse('That language is not in this comic yet.');
  // Only a balloon placed in the original language has a position to adjust for this one.
  if (!page.balloons.some((b) => b.lineId === lineId)) return refuse('Place this balloon in the original language first, then adjust it for this language.');
  const widthChanged = Math.abs(from.w - to.w) > 1e-4;
  const heightChanged = Math.abs(from.h - to.h) > 1e-4;
  // A top or bottom handle (the height alone, its edge moving with it) has nothing to change in one language.
  if (heightChanged && !widthChanged) return refuse(EDITION_HEIGHT_SHARED);
  const patch: BalloonGeometryOverride = {
    x: r4(clamp(text.x + (to.x - from.x), 0, 1)),
    y: r4(clamp(text.y + (to.y - from.y), 0, 1)),
    pinned: true
  };
  if (widthChanged) patch.w = r4(clamp(text.w + (to.w - from.w), 0.04, 1));
  return editOf(doc, [{ op: 'edition_balloon', lang, lineId, patch }], `${verb} ${label.split(':')[0].toLowerCase()}`, heightChanged ? [EDITION_HEIGHT_SHARED] : undefined);
}

/** Move an overlay or a balloon by (dx, dy) — a drag or a nudge. */
export function moveEdit(doc: ComicDoc, page: Page, ref: SceneRef, dx: number, dy: number, scene: PageScene = buildScene(doc, page)): EditResult {
  const me = sceneObject(scene, ref);
  if (!me) return refuse('That is not on this page.');
  return setBoxEdit(doc, page, ref, moveBox(me.box, dx, dy), scene);
}

/**
 * Rotate an overlay (±EDITOR_LIMITS.layerRot) or a balloon (±EDITOR_LIMITS.balloonRot; body and text together, the
 * tail tip stays put). Panels do not rotate.
 */
export function rotateEdit(doc: ComicDoc, page: Page, ref: SceneRef, deg: number): EditResult {
  if (ref.kind === 'frame') return refuse('Panels stay upright. Rotate the picture inside a sticker or an image instead.');
  if (ref.kind === 'page') return refuse('The page itself does not rotate.');
  const locked = lockedReason(page, ref);
  if (locked) return refuse(locked);
  if (ref.kind === 'overlay') {
    const layer = overlayOf(page, ref.id);
    if (!layer) return refuse('That is not on this page.');
    const rot = Math.round(clampRot(deg, EDITOR_LIMITS.layerRot) * 10) / 10;
    if ((layer.rot ?? 0) === rot) return refuse(NOTHING_TO_CHANGE);
    return editOf(doc, [{ op: 'layer', pageId: page.id, id: layer.id, patch: { rot: rot === 0 ? null : rot } }], `Rotate ${(layer.name || (layer.kind === 'shape' ? 'shape' : 'image')).toLowerCase()}`);
  }
  const b = page.balloons.find((x) => x.lineId === ref.id);
  if (!b) return refuse('Place the balloon first, then rotate it.');
  const rot = Math.round(clampRot(deg, EDITOR_LIMITS.balloonRot) * 10) / 10;
  if ((b.rot ?? 0) === rot) return refuse(NOTHING_TO_CHANGE);
  // null clears the rotation (K2a balloon op); the wire type has no null, hence the cast.
  const patch = { rot: rot === 0 ? null : rot, pinned: true } as unknown as Partial<Balloon>;
  return editOf(doc, [{ op: 'balloon', pageId: page.id, lineId: b.lineId, patch }], 'Rotate balloon');
}
