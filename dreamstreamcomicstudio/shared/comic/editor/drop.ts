// Drop resolution (Ship 2, B9; pro plan §4.5 drop table, design §4.7): what happens when something from the asset bin
// lands on the page — the exact K2a ops, a one-line plain-words label shown BEFORE release, and what it costs (always
// free now; a cast or place change on a drawn panel is "free now, redraw quoted"). The same function serves the
// director's `place` tool. Pure.
//
//   character / prop  → panel (not drawn)   cast + staging from the drop's x               free
//   character / prop  → panel (drawn)       the same edit; the panel waits for a redraw     free now, redraw quoted
//   character         → balloon             the speaker, and the tail aimed at their head   free
//   place             → panel               the panel's place                               free now (drawn: redraw quoted)
//   lettering preset  → panel               a new line there; the text editor opens         free
//   image             → frame               Fill the panel, or a sticker kept in it          free
//   image             → page outside frames a page overlay                                  free
//   earlier take      → frame               "Use panel 2 from take 1"                        free
//   shape             → anywhere            an overlay (kept in the panel it lands in)       free
//   anything          → a locked object, or the page margin: no drop, and the label says why

import {
  collectAssetPaths,
  layersOf,
  type Balloon,
  type ComicDoc,
  type LayerShapeType,
  type Line,
  type LineKind,
  type Page,
  type PageLayer,
  type Panel,
  type PanelDirection,
  type RefAsset
} from '../doc.js';
import { DOC_LIMITS, EDITOR_LIMITS } from '../limits.js';
import type { DocOp } from '../ops.js';
import { assetSizeOf, pageSpaceQc } from '../panelize/space.js';
import { estimateTextHeight, estimateWidthForText } from '../textLayout.js';
import type { LetterStylePatch } from '../lettering/style.js';
import { useTakeEdit } from './frames.js';
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
  lineKindWord,
  lockedReason,
  NOTHING_TO_CHANGE,
  objectAt,
  panelWord,
  r4,
  refuse,
  roundBox,
  takenIds,
  type EditOk,
  type EditRefused,
  type EditResult,
  type IdFactory,
  type PageScene,
  type Point,
  type SceneObject,
  type SceneRef
} from './scene.js';

/**
 * PD-5 (provisional default): a photo of a real person dropped on the page starts as "Guide only" (never printed): the
 * guide-only sticker is the default choice, filling a panel with it (printed) stays an explicit second choice.
 */
export const PERSON_PHOTO_GUIDE_ONLY = true;

/** Design §6.4: what a drop that changes a drawn panel's plan adds to its label (the price is the editor's). */
export const NEEDS_REDRAW = ' · needs a redraw to show';

export type DropItem =
  /** A character or a prop (a cast member of kind 'object'). */
  | { kind: 'cast'; id: string }
  | { kind: 'place'; id: string }
  /** A lettering preset: a new line of this kind (optionally styled). */
  | { kind: 'lettering'; lineKind: LineKind; style?: LetterStylePatch; text?: string }
  /** An image of this comic (an upload, a reference, a sheet, any version's art). */
  | { kind: 'image'; path: string; name?: string }
  /** A take (a version) of this page; `fromPanelId` = which of its panels (default: the panel it lands on). */
  | { kind: 'take'; path: string; fromPanelId?: string }
  | { kind: 'shape'; shape: LayerShapeType };

export interface DropTarget {
  /** Page-normalized drop point. */
  point: Point;
  /** What is under it (default: the topmost object of the scene at the point). */
  ref?: SceneRef;
}

export type DropCost = 'free' | { redraw: 'panel' | 'page' };

export interface DropChoice {
  key: 'fill' | 'sticker';
  label: string;
  ops: DocOp[];
  undo: DocOp[];
  warning?: string;
}

export interface DropOk extends EditOk {
  cost: DropCost;
  /**
   * Two ways to drop an image on a frame: `ops`, `label` and `warning` are the first. Fill comes first, except for a
   * real person's photo (PD-5), where the guide-only sticker does.
   */
  choices?: DropChoice[];
  /** The new line whose text editor opens (lettering presets). */
  focusLineId?: string;
  /** Said once before the drop lands (a real person's photo). */
  warning?: string;
}
export type DropResult = DropOk | EditRefused;
const refusalOf = (r: EditResult): EditRefused => ({ ok: false, reason: (r as EditRefused).reason });

export interface DropOptions {
  /** For an image on a frame: pick fill or sticker (default: both offered; fill first, a real person's photo sticker first). */
  as?: 'fill' | 'sticker';
  ids?: IdFactory;
  scene?: PageScene;
}

const SPOKEN: ReadonlySet<LineKind> = new Set<LineKind>(['speech', 'thought', 'whisper', 'shout']);
const DEFAULT_TEXT: Record<LineKind, string> = { speech: '', thought: '', whisper: '', shout: '', caption: '', sfx: 'POW' };
const SHAPE_DEFAULTS: Record<LayerShapeType, PageLayer['shape']> = {
  rect: { type: 'rect', fill: '#ffffff', stroke: '#111111', strokeW: 0.003 },
  ellipse: { type: 'ellipse', fill: '#ffffff', stroke: '#111111', strokeW: 0.003 },
  line: { type: 'line', stroke: '#111111', strokeW: 0.004 }
};
const POS_WORD = { left: 'on the left', center: 'in the middle', right: 'on the right' } as const;

const ok = (doc: ComicDoc, ops: DocOp[], label: string, cost: DropCost, extra: Partial<DropOk> = {}): DropResult => {
  const r = editOf(doc, ops, label, extra.notes);
  if (r.ok === false) return refusalOf(r);
  return { ...(r as EditOk), cost, ...extra };
};

/** Every reference image of the doc (to know a real person's photo). */
const refsOfDoc = (doc: ComicDoc): RefAsset[] => [
  ...doc.cast.flatMap((c) => c.refs || []),
  ...doc.places.flatMap((p) => p.refs || []),
  ...(doc.style?.refs || []),
  ...(doc.refInbox || [])
];
const isPersonPhoto = (doc: ComicDoc, path: string): boolean => refsOfDoc(doc).some((r) => r.path === path && r.subject === 'person');

/** The target object of a drop: the given ref, else what is on top at the point (a balloon first for cast). */
const targetOf = (scene: PageScene, item: DropItem, t: DropTarget): SceneObject | undefined => {
  if (t.ref) return scene.objects.find((o) => o.kind === t.ref!.kind && o.id === t.ref!.id);
  if (item.kind === 'cast') {
    const b = objectAt(scene, t.point, (o) => o.kind === 'balloon');
    if (b) return b;
  }
  const hit = objectAt(scene, t.point, (o) => o.kind === 'frame' || (o.kind === 'overlay' && o.locked));
  return hit ?? scene.objects[0];
};

/** The frame under a point (its panel), for objects inside a panel. */
const frameUnder = (scene: PageScene, point: Point): SceneObject | undefined => objectAt(scene, point, (o) => o.kind === 'frame');

const posOf = (box: { x: number; w: number }, x: number): 'left' | 'center' | 'right' => {
  const t = (x - box.x) / (box.w || 1);
  return t < 1 / 3 ? 'left' : t > 2 / 3 ? 'right' : 'center';
};

/**
 * What a drop does: exact ops, a label to show before release, and its cost. A locked target, the page margin for
 * things that belong in a panel, or anything this page cannot take refuses with the reason in plain words.
 */
export function resolveDrop(doc: ComicDoc, page: Page, item: DropItem, target: DropTarget, opts: DropOptions = {}): DropResult {
  const scene = opts.scene ?? buildScene(doc, page);
  const ids = opts.ids ?? defaultIds;
  const hit = targetOf(scene, item, target);
  if (hit && hit.kind !== 'page') {
    const locked = lockedReason(page, hit);
    if (locked) return refuse(locked.replace('Unlock it to change it.', 'Unlock it to drop things on it.'));
  }
  const drawn = !isUndrawn(page);
  const panelOf = (o: SceneObject | undefined): Panel | undefined => (o?.kind === 'frame' ? page.panels.find((p) => p.id === o.id) : undefined);

  switch (item.kind) {
    case 'cast': {
      const who = doc.cast.find((c) => c.id === item.id);
      if (!who) return refuse('That character is not in this comic.');
      if (hit?.kind === 'balloon') return speakerDrop(doc, page, scene, who.id, who.name, hit);
      const panel = panelOf(hit);
      if (!panel || !hit) return refuse(`Drop ${who.name} on a panel.`);
      const pos = posOf(hit.box, target.point.x);
      const has = panel.castIds.includes(who.id);
      const dir: PanelDirection = panel.direction ? { ...panel.direction } : {};
      const castDir = { ...(dir.cast ?? {}) };
      if (has && castDir[who.id]?.pos === pos) return refuse(NOTHING_TO_CHANGE);
      castDir[who.id] = { ...(castDir[who.id] ?? {}), pos };
      const direction: PanelDirection = { ...dir, cast: castDir, by: 'user' };
      const patch: Partial<Panel> = { direction };
      if (!has) patch.castIds = [...panel.castIds, who.id];
      // Design §6.4 on a drawn page: "Put Meera in panel 2 · needs a redraw to show".
      const label = has
        ? `Move ${who.name} ${POS_WORD[pos]} in ${panelWord(page, panel.id)}${drawn ? NEEDS_REDRAW : ''}`
        : drawn
          ? `Put ${who.name} in ${panelWord(page, panel.id)}${NEEDS_REDRAW}`
          : `Add ${who.name} to ${panelWord(page, panel.id)}, ${POS_WORD[pos]}`;
      return ok(doc, [{ op: 'panel', pageId: page.id, id: panel.id, patch }], label, drawn ? { redraw: 'panel' } : 'free');
    }
    case 'place': {
      const place = doc.places.find((p) => p.id === item.id);
      if (!place) return refuse('That place is not in this comic.');
      const panel = panelOf(hit);
      if (!panel) return refuse(`Drop ${place.name} on a panel.`);
      if (panel.placeId === place.id) return refuse(NOTHING_TO_CHANGE);
      const base = `Set ${panelWord(page, panel.id)} in ${place.name}`;
      return ok(doc, [{ op: 'panel', pageId: page.id, id: panel.id, patch: { placeId: place.id } }], drawn ? `${base}${NEEDS_REDRAW}` : base, drawn ? { redraw: 'panel' } : 'free');
    }
    case 'lettering': {
      const frame = hit?.kind === 'frame' ? hit : frameUnder(scene, target.point);
      const panel = panelOf(frame);
      if (!panel || !frame) return refuse('Drop it inside a panel.');
      const panelLock = lockedReason(page, { kind: 'frame', id: panel.id });
      if (panelLock) return refuse(panelLock.replace('Unlock it to change it.', 'Unlock it to drop things on it.'));
      if (panel.lines.length >= DOC_LIMITS.linesPerPanel) return refuse(`${cap1(panelWord(page, panel.id))} already holds ${DOC_LIMITS.linesPerPanel} lines.`);
      return letteringDrop(doc, page, scene, panel, item, target.point, ids);
    }
    case 'take': {
      const panel = panelOf(hit);
      if (!panel) return refuse('Drop the take on a panel.');
      const r = useTakeEdit(doc, page, panel.id, { path: item.path, ...(item.fromPanelId ? { fromPanelId: item.fromPanelId } : {}) });
      return r.ok === false ? refusalOf(r) : { ...(r as EditOk), cost: 'free' };
    }
    case 'image':
    case 'shape': {
      if (item.kind === 'image' && !collectAssetPaths(doc).includes(item.path)) return refuse('Add the image to this comic first (upload it), then place it.');
      if (layersOf(page).length >= EDITOR_LIMITS.layersPerPage) return refuse(`A page holds at most ${EDITOR_LIMITS.layersPerPage} overlays.`);
      const frame = hit?.kind === 'frame' ? hit : undefined;
      return overlayDrop(doc, page, scene, item, target.point, frame, opts, ids);
    }
  }
}

/** A character dropped on a balloon: the speaker, and the tail aimed at their head when the page check knows it. */
function speakerDrop(doc: ComicDoc, page: Page, scene: PageScene, castId: string, name: string, balloon: SceneObject): DropResult {
  const found = page.panels.flatMap((p) => p.lines.map((l) => ({ l, p }))).find((x) => x.l.id === balloon.id);
  if (!found) return refuse('That balloon is not on this page.');
  const { l: line, p: panel } = found;
  if (!SPOKEN.has(line.kind)) return refuse(`${lineKindWord(line.kind)}s have no speaker.`);
  const ops: DocOp[] = [];
  if (line.speakerId !== castId) ops.push({ op: 'line', pageId: page.id, panelId: panel.id, id: line.id, patch: { speakerId: castId } });
  const heads = pageSpaceQc(doc, page)?.heads;
  const mark = Array.isArray(heads) ? heads.find((h) => h && h.characterId === castId && h.panel === panel.n) : undefined;
  const p = mark?.mouth ?? mark?.head;
  let aimed = false;
  if (p && Number.isFinite(p.x) && Number.isFinite(p.y)) {
    const c = centreOf(balloon.box);
    const d = Math.hypot(c.x - p.x, c.y - p.y) || 1;
    const pull = Math.min(0.02, d / 2);
    const tailX = r4(clamp(p.x + ((c.x - p.x) / d) * pull, 0, 1));
    const tailY = r4(clamp(p.y + ((c.y - p.y) / d) * pull, 0, 1));
    const stored = page.balloons.find((b) => b.lineId === line.id);
    const patch: Partial<Balloon> = { tailX, tailY, pinned: true };
    if (!stored && balloon.text) Object.assign(patch, { x: r4(balloon.text.x), y: r4(balloon.text.y), w: r4(balloon.text.w) });
    if (!stored || stored.tailX !== tailX || stored.tailY !== tailY) {
      ops.push({ op: 'balloon', pageId: page.id, lineId: line.id, patch });
      aimed = true;
    }
  }
  if (!ops.length) return refuse(NOTHING_TO_CHANGE);
  return ok(doc, ops, aimed ? `${name} says this line, with the tail pointing at ${name}` : `${name} says this line`, 'free');
}

/** A lettering preset dropped in a panel: a new line of that kind there, its balloon at the drop point. */
function letteringDrop(doc: ComicDoc, page: Page, scene: PageScene, panel: Panel, item: Extract<DropItem, { kind: 'lettering' }>, point: Point, ids: IdFactory): DropResult {
  const kind = item.lineKind;
  const id = freshId('line', takenIds(doc, page), ids);
  const lang = doc.format?.language || 'en';
  const patch: Partial<Line> = { kind, text: typeof item.text === 'string' ? item.text : DEFAULT_TEXT[kind] };
  if (SPOKEN.has(kind) && panel.castIds[0]) patch.speakerId = panel.castIds[0];
  const sample = kind === 'sfx' ? 'POW' : 'A new line of dialogue';
  const w = r4(kind === 'sfx' ? 0.2 : estimateWidthForText(sample, lang));
  const h = estimateTextHeight(sample, w, scene.aspect, lang);
  const x = r4(clamp(point.x - w / 2, 0.02, 0.98 - w));
  const y = r4(clamp(point.y - h / 2, 0.02, 0.98 - h));
  const balloon: Partial<Balloon> = { x, y, w, pinned: true };
  if (SPOKEN.has(kind)) {
    balloon.tailX = r4(clamp(x + w * 0.42, 0, 1));
    balloon.tailY = r4(clamp(y + h + 0.05, 0, 1));
  }
  const ops: DocOp[] = [
    { op: 'line', pageId: page.id, panelId: panel.id, id, patch },
    { op: 'balloon', pageId: page.id, lineId: id, patch: balloon }
  ];
  if (item.style && typeof item.style === 'object' && Object.keys(item.style).length) ops.push({ op: 'line_style', pageId: page.id, lineIds: [id], patch: item.style });
  return ok(doc, ops, `New ${lineKindWord(kind).toLowerCase()} in ${panelWord(page, panel.id)}`, 'free', { focusLineId: id });
}

/** An image or a shape: fill a frame, or an overlay (kept in the panel it lands in, else on the page). */
function overlayDrop(
  doc: ComicDoc,
  page: Page,
  scene: PageScene,
  item: Extract<DropItem, { kind: 'image' | 'shape' }>,
  point: Point,
  frame: SceneObject | undefined,
  opts: DropOptions,
  ids: IdFactory
): DropResult {
  const id = freshId('layer', takenIds(doc, page), ids);
  const bounds = frame?.box ?? { x: 0, y: 0, w: 1, h: 1 };
  // Size: 40% of the frame (or a quarter of the page) wide, the image's own shape.
  let w = Math.max(0.05, (frame ? frame.box.w : 1) * (frame ? 0.4 : 0.25));
  let h: number;
  if (item.kind === 'image') {
    const size = assetSizeOf(doc, item.path);
    h = size ? (w * scene.aspect * size.h) / size.w : w * scene.aspect;
  } else h = item.shape === 'line' ? 0.01 : w * scene.aspect * 0.7;
  if (h > bounds.h) {
    w *= bounds.h / h;
    h = bounds.h;
  }
  w = Math.min(w, bounds.w);
  const box = roundBox({ x: clamp(point.x - w / 2, bounds.x, bounds.x + bounds.w - w), y: clamp(point.y - h / 2, bounds.y, bounds.y + bounds.h - h), w, h });
  const where = frame ? panelWord(page, frame.id) : 'the page';
  const person = item.kind === 'image' && isPersonPhoto(doc, item.path);
  const layerPatch: Record<string, unknown> =
    item.kind === 'image'
      ? { kind: 'image', box, src: { path: item.path }, ...(item.name ? { name: item.name } : {}) }
      : { kind: 'shape', box, shape: { ...SHAPE_DEFAULTS[item.shape] } };
  if (frame) layerPatch.clip = frame.id;
  if (person && PERSON_PHOTO_GUIDE_ONLY) layerPatch.print = false;
  const stickerOps: DocOp[] = [{ op: 'layer', pageId: page.id, id, patch: layerPatch as never }];
  const what = item.kind === 'image' ? 'image' : item.shape === 'rect' ? 'rectangle' : item.shape === 'ellipse' ? 'ellipse' : 'line';
  // Design §6.4: "Fill panel 2" · "Place as sticker" (the editor adds " · Free").
  const stickerLabel = item.kind === 'image' ? (frame ? 'Place as sticker' : 'Place the image on the page') : `Add a ${what} ${frame ? `in ${where}` : 'on the page'}`;
  const stickerWarning = person
    ? PERSON_PHOTO_GUIDE_ONLY
      ? 'This is a photo of a real person. It is placed as a guide only: you see it in the editor, but it is never printed or shared. You can choose to print it.'
      : 'This photo will appear on the page exactly as it is. Anyone you share the comic with will see it.'
    : undefined;
  if (item.kind === 'shape' || !frame || opts.as === 'sticker') {
    return ok(doc, stickerOps, stickerLabel, 'free', stickerWarning ? { warning: stickerWarning } : {});
  }
  // An image on a frame: fill the panel (when the page shows frames) or a sticker in it.
  const shown = framesShown(doc, page);
  const panel = page.panels.find((p) => p.id === frame.id)!;
  let fillOps: DocOp[] | undefined;
  let fillRefusal: string | undefined;
  if (shown.mode === 'drawn') fillRefusal = isUndrawn(page) ? `Pick a layout for page ${page.n} first, then fill a panel.` : `Page ${page.n} is shown as drawn. Make its panels editable first (free) to fill a panel.`;
  else {
    const extra = new Set(page.panels.map((p) => (p.id === panel.id ? item.path : p.frame?.src?.path)).filter((x): x is string => !!x && x !== page.render.asset?.path));
    if (extra.size > EDITOR_LIMITS.sourcesPerPage) fillRefusal = `This page already shows pictures from ${EDITOR_LIMITS.sourcesPerPage} other takes or images. Flatten the page first (free), or place it as a sticker.`;
    else {
      const idx = page.panels.indexOf(panel);
      const frameNow: Record<string, unknown> = { ...(panel.frame ?? {}), box: roundBox(shown.boxes[idx]), src: { path: item.path } };
      delete frameNow.fit;
      const frames = page.panels
        .map((p, i) => (p.id === panel.id ? { panelId: p.id, frame: frameNow } : !p.frame ? { panelId: p.id, frame: { box: roundBox(shown.boxes[i]) } } : null))
        .filter(Boolean) as { panelId: string; frame: never }[];
      fillOps = [{ op: 'page_frames', pageId: page.id, frames }];
    }
  }
  const fillLabel = `Fill ${where}`;
  const fillWarning = person ? 'This photo will appear on the page exactly as it is. Anyone you share the comic with will see it.' : undefined;
  if (opts.as === 'fill') {
    if (!fillOps) return refuse(fillRefusal!);
    return ok(doc, fillOps, fillLabel, 'free', fillWarning ? { warning: fillWarning } : {});
  }
  const choice = (key: 'fill' | 'sticker', label: string, ops: DocOp[], warning?: string): DropChoice | undefined => {
    const r = editOf(doc, ops, label);
    return r.ok ? { key, label, ops: r.ops, undo: r.undo, ...(warning ? { warning } : {}) } : undefined;
  };
  const fill = fillOps ? choice('fill', fillLabel, fillOps, fillWarning) : undefined;
  const sticker = choice('sticker', stickerLabel, stickerOps, stickerWarning);
  // PD-5: a real person's photo defaults to the guide-only sticker (never printed); filling the panel prints it.
  const ordered = person && PERSON_PHOTO_GUIDE_ONLY ? [sticker, fill] : [fill, sticker];
  const choices = ordered.filter((c): c is DropChoice => !!c);
  const first = choices[0];
  if (!first) return refuse(fillRefusal ?? NOTHING_TO_CHANGE);
  return { ok: true, ops: first.ops, undo: first.undo, label: first.label, cost: 'free', choices, ...(first.warning ? { warning: first.warning } : {}) };
}

/** The one-line label a drop target shows while something is carried over it (the refusal reason when it refuses). */
export const dropLabel = (r: DropResult): string => (r.ok === false ? (r as EditRefused).reason : (r as DropOk).label);

/** True when a point is inside a frame (a drop there lands in a panel). */
export const inAPanel = (scene: PageScene, point: Point): boolean => scene.objects.some((o) => o.kind === 'frame' && containsPoint(o.box, point));
