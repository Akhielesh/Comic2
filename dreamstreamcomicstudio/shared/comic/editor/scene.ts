// The editor's page scene (Ship 2, B9; pro plan §4.5): every object a creator can touch on one page, in four bands.
//
//   band 0  the page (paper, frame style)
//   band 1  the art: panel frames, and the overlays kept inside a panel (drawn with their frame)
//   band 2  page overlays (stickers, images, shapes not kept in a panel)
//   band 3  lettering (balloons, captions, sound effects), always on top
//
// Z-order is free only WITHIN a band, so a sticker can never bury dialogue. Reading order belongs to panels and their
// lines (readingOrder.ts), never to z. Pure: no React, no server imports, no clock, no I/O.
//
// This module also holds what every editor operation shares: the result shape (K2a ops plus their inverse from the one
// undo path, `inverseOps`, never a parallel undo system), refusals in plain words, locks, and fresh ids.

import { artModeOf, cutFor, layersOf, type Balloon, type Box, type ComicDoc, type Line, type LineKind, type Page, type PageLayer, type Panel } from '../doc.js';
import { i18nOf } from '../i18n.js';
import { PLAN_W, type LetterPlan } from '../lettering/layout.js';
import type { DocOp } from '../ops.js';
import { panelBoxesFor, type Point } from '../pageGeometry.js';
import { composeAspect } from '../panelize/space.js';
import { estimateTextHeight, normalizeLetteringText } from '../textLayout.js';
import { inverseOps } from '../undo.js';

export type { Point };

// ── Results ──────────────────────────────────────────────────────────────────

/** An edit the editor can commit: K2a ops, a plain-words label, and the exact inverse from undo.ts. */
export interface EditOk {
  ok: true;
  ops: DocOp[];
  /** What the edit does, in plain words ("Split panel 2 side by side"). */
  label: string;
  /** The inverse ops (undo.ts inverseOps against the doc the edit was made on). */
  undo: DocOp[];
  /** Honest side notes ("Panel 1 may look soft at this size"). */
  notes?: string[];
}
/** An edit the editor will not make, and why (plain words, never a code). */
export interface EditRefused {
  ok: false;
  reason: string;
}
export type EditResult = EditOk | EditRefused;

export const refuse = (reason: string): EditRefused => ({ ok: false, reason });

/** Nothing would change: the honest refusal every editor op shares. */
export const NOTHING_TO_CHANGE = 'It already looks like that.';

/** An edit from its ops, with the inverse computed by the K2a undo path. No ops → the "nothing to change" refusal. */
export const editOf = (doc: ComicDoc, ops: DocOp[], label: string, notes?: readonly string[]): EditResult => {
  if (!ops.length) return refuse(NOTHING_TO_CHANGE);
  const out: EditOk = { ok: true, ops, label, undo: inverseOps(doc, ops) };
  if (notes && notes.length) out.notes = [...notes];
  return out;
};

// ── Small shared helpers ─────────────────────────────────────────────────────

export const UNIT_BOX: Box = { x: 0, y: 0, w: 1, h: 1 };
export const r4 = (n: number): number => Math.round(n * 10000) / 10000;
export const clamp = (n: number, lo: number, hi: number): number => (Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : lo);
export const roundBox = (b: Box): Box => ({ x: r4(b.x), y: r4(b.y), w: r4(b.w), h: r4(b.h) });
export const boxArea = (b: Box | undefined): number => (b && b.w > 0 && b.h > 0 ? b.w * b.h : 0);
export const centreOf = (b: Box): Point => ({ x: b.x + b.w / 2, y: b.y + b.h / 2 });
export const containsPoint = (b: Box, p: Point): boolean => p.x >= b.x && p.x <= b.x + b.w && p.y >= b.y && p.y <= b.y + b.h;
export const intersectBox = (a: Box, b: Box): Box | null => {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  const w = Math.min(a.x + a.w, b.x + b.w) - x;
  const h = Math.min(a.y + a.h, b.y + b.h) - y;
  return w > 1e-9 && h > 1e-9 ? { x, y, w, h } : null;
};
export const sameBox = (a: Box | undefined, b: Box | undefined, eps = 1e-6): boolean =>
  !!a && !!b && Math.abs(a.x - b.x) <= eps && Math.abs(a.y - b.y) <= eps && Math.abs(a.w - b.w) <= eps && Math.abs(a.h - b.h) <= eps;

/** "panel 2" (sentence case is the caller's). */
export const panelWord = (page: Pick<Page, 'panels'>, panelId: string): string => {
  const p = page.panels.find((x) => x.id === panelId);
  return p ? `panel ${p.n}` : 'that panel';
};
export const cap1 = (s: string): string => (s ? s[0].toUpperCase() + s.slice(1) : s);

const KIND_WORD: Record<LineKind, string> = {
  speech: 'Balloon',
  thought: 'Thought balloon',
  whisper: 'Whisper',
  shout: 'Shout',
  caption: 'Caption',
  sfx: 'Sound effect'
};
/** "Balloon", "Caption", "Sound effect"… */
export const lineKindWord = (kind: LineKind): string => KIND_WORD[kind] ?? 'Balloon';
/** A line's words, shortened for a label: “Run!” */
export const quoteOf = (text: string, max = 24): string => {
  const t = normalizeLetteringText(text).replace(/\s+/g, ' ').trim();
  return `“${t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t}”`;
};
const SHAPE_WORD: Record<string, string> = { rect: 'Rectangle', ellipse: 'Ellipse', line: 'Line' };
export const layerWord = (layer: PageLayer): string =>
  layer.name || (layer.kind === 'shape' ? SHAPE_WORD[layer.shape?.type ?? 'rect'] ?? 'Shape' : 'Image');

/** The page has no drawing yet (a plan only). */
export const isUndrawn = (page: Pick<Page, 'render'>): boolean => !page.render?.asset?.path;

/** Every id in use in the doc (panels and lines of live and trashed pages) or on one page (overlays). */
export const takenIds = (doc: ComicDoc, page?: Pick<Page, 'layers'>): Set<string> => {
  const out = new Set<string>();
  const add = (p: Page) => {
    for (const panel of p.panels) {
      out.add(panel.id);
      for (const l of panel.lines) out.add(l.id);
    }
  };
  doc.pages.forEach(add);
  doc.trash?.forEach((t) => add(t.page));
  for (const l of page ? layersOf(page) : []) out.add(l.id);
  return out;
};

export type IdKind = 'panel' | 'line' | 'layer';
const ID_BASE: Record<IdKind, string> = { panel: 'pe', line: 'le', layer: 'ly_e' };
/** Id factory: deterministic by default (the first free `pe1`, `le1`, `ly_e1`…); the client may pass a random one. */
export type IdFactory = (kind: IdKind, taken: ReadonlySet<string>) => string;
export const defaultIds: IdFactory = (kind, taken) => {
  const base = ID_BASE[kind];
  for (let k = 1; k < 100000; k++) if (!taken.has(`${base}${k}`)) return `${base}${k}`;
  return `${base}x`;
};
/** A fresh id that is not taken (the factory's answer when it is free, else the deterministic one). */
export const freshId = (kind: IdKind, taken: Set<string>, ids: IdFactory = defaultIds): string => {
  let id = ids(kind, taken);
  if (!id || taken.has(id)) id = defaultIds(kind, taken);
  taken.add(id);
  return id;
};

// ── Frames as shown ──────────────────────────────────────────────────────────

/**
 * Where the panels are on the page as the editor shows them:
 * - 'panels': the page is shown in its frames (artModeOf);
 * - 'planned': an undrawn page whose panels all have frames (from a template or the user) — nothing to cut yet;
 * - 'drawn': the page as drawn (or planned without frames): the measured or blueprint boxes.
 */
export type FramesMode = 'panels' | 'planned' | 'drawn';
export interface FramesShown {
  mode: FramesMode;
  /** One box per panel, in the page's panel order. */
  boxes: Box[];
}
export const framesShown = (doc: Pick<ComicDoc, 'format'>, page: Page): FramesShown => {
  if (artModeOf(page) === 'panels') return { mode: 'panels', boxes: page.panels.map((p) => ({ ...p.frame!.box })) };
  if (isUndrawn(page) && page.panels.length && page.panels.every((p) => !!p.frame?.box)) {
    return { mode: 'planned', boxes: page.panels.map((p) => ({ ...p.frame!.box })) };
  }
  return { mode: 'drawn', boxes: panelBoxesFor(doc, page).map((b) => ({ ...b })) };
};

/**
 * Cuts that name no panel are matched to panels by position (cutFor's fallback). Before an edit adds, removes, joins
 * or reorders panels, every cut is named by the panel that shows it now, so each picture stays with its panel and not
 * with a position (a cut no panel shows stays unnamed). Undefined when there is nothing to name: no drawing, no cuts,
 * or cuts that already name their panels. It changes no picture, so the lettering stays put (moveBalloons: false).
 */
export const nameCutsOp = (page: Page): DocOp | undefined => {
  const cuts = page.render?.cuts;
  const path = page.render?.asset?.path;
  if (!path || !cuts || !Array.isArray(cuts.cuts) || !cuts.cuts.length || cuts.cuts.some((c) => !!c?.panelId)) return undefined;
  const named = cuts.cuts.map((c, i) => {
    const p = page.panels[i];
    return p && cutFor(page, p) === c ? { ...c, panelId: p.id } : { ...c };
  });
  if (!named.some((c) => c.panelId)) return undefined;
  return { op: 'page_cuts', pageId: page.id, path, cuts: { ...cuts, cuts: named }, moveBalloons: false };
};

/** Ops with the cut-naming op first when the page needs one (see nameCutsOp). */
export const withNamedCuts = (page: Page, ops: DocOp[]): DocOp[] => {
  const named = nameCutsOp(page);
  return named ? [named, ...ops] : ops;
};

/** Frames can be edited: the page is shown in frames, or it is not drawn yet (its frames are the plan). */
export const framesEditable = (page: Page): boolean => artModeOf(page) === 'panels' || isUndrawn(page);

/** Why frames cannot be edited on this page right now (plain words), or undefined when they can. */
export const framesBlockedReason = (page: Page): string | undefined =>
  framesEditable(page) ? undefined : `Page ${page.n} is shown as drawn. Make its panels editable first (free).`;

// ── Locks ────────────────────────────────────────────────────────────────────

export type SceneKind = 'page' | 'frame' | 'overlay' | 'balloon';
export interface SceneRef {
  kind: SceneKind;
  /** page: the page id; frame: the panel id; overlay: the layer id; balloon: the line id. */
  id: string;
}

/** The plain-words reason a locked object refuses an edit, or undefined when it is free to change. */
export const lockedReason = (page: Page, ref: SceneRef): string | undefined => {
  if (ref.kind === 'frame') {
    const p = page.panels.find((x) => x.id === ref.id);
    return p?.frame?.locked ? `${cap1(panelWord(page, p.id))} is locked. Unlock it to change it.` : undefined;
  }
  if (ref.kind === 'overlay') {
    const l = layersOf(page).find((x) => x.id === ref.id);
    return l?.locked ? `${layerWord(l)} is locked. Unlock it to change it.` : undefined;
  }
  if (ref.kind === 'balloon') {
    const b = page.balloons.find((x) => x.lineId === ref.id);
    return b?.locked ? 'This balloon is locked. Unlock it to change it.' : undefined;
  }
  return undefined;
};

// ── The scene ────────────────────────────────────────────────────────────────

export const BANDS = { page: 0, art: 1, overlays: 2, lettering: 3 } as const;
export type Band = (typeof BANDS)[keyof typeof BANDS];

export interface SceneObject extends SceneRef {
  band: Band;
  /** Page fractions (outline for lettering, frame for panels, overlay box). */
  box: Box;
  /** Order within its band (higher draws later). */
  z: number;
  /** Degrees. */
  rot: number;
  locked: boolean;
  /** frame: itself; clipped overlay: its panel; balloon: the panel of its line. */
  panelId?: string;
  /** A clipped overlay draws only inside this frame. */
  clip?: Box;
  /** Guide-only overlay: shown in the editor, never printed. */
  guide?: boolean;
  /** Reading order: a frame's panel number; a balloon's index among the page's lines. */
  order?: number;
  /** Balloons: the stored text box (x, y, w) the outline is drawn around. */
  text?: { x: number; y: number; w: number };
  /** Balloons: the line's kind. */
  lineKind?: LineKind;
  /** Plain-words name ("Panel 2", "Caption: “Tokyo, 3 a.m.”", "Sticker"). */
  label: string;
}

export interface PageScene {
  pageId: string;
  /** Page width ÷ height as shown. */
  aspect: number;
  frames: FramesMode;
  /** Every object, bottom to top (draw order). */
  objects: SceneObject[];
}

export interface SceneOptions {
  /** A language edition: its balloon geometry overrides and translated text. */
  lang?: string;
  /** The lettering plans the canvas draws (exact outlines); without them outlines are estimated from stored balloons. */
  plans?: readonly LetterPlan[];
}

/** Balloon outline padding added around an estimated text box (page fractions of the width). */
const EST_PAD = 0.012;

/** The outline box of a stored balloon, estimated when no lettering plan is at hand. */
export const estimatedBalloonBox = (b: Pick<Balloon, 'x' | 'y' | 'w' | 'minH'>, text: string, aspect: number, lang: string): Box => {
  const w = clamp(b.w, 0.02, 1);
  const textH = estimateTextHeight(text || ' ', w, aspect, lang);
  const h = Math.max(textH + 2 * EST_PAD * aspect, typeof b.minH === 'number' ? b.minH : 0);
  return { x: b.x - EST_PAD, y: b.y - EST_PAD * aspect, w: w + 2 * EST_PAD, h };
};

/** A lettering plan's outline in page fractions. */
export const planOutlineBox = (plan: Pick<LetterPlan, 'x' | 'y' | 'geometry'>, aspect: number): Box => {
  const H = PLAN_W / aspect;
  const g = plan.geometry.bounds;
  return { x: (plan.x + g.x) / PLAN_W, y: (plan.y + g.y) / H, w: g.w / PLAN_W, h: g.h / H };
};

/** Lines of the page in reading order, with their panel. */
export const pageLines = (page: Pick<Page, 'panels'>): { line: Line; panel: Panel; index: number }[] => {
  const out: { line: Line; panel: Panel; index: number }[] = [];
  for (const panel of page.panels) for (const line of panel.lines) out.push({ line, panel, index: out.length });
  return out;
};

/** The page's balloons as the editor sees them in a language (edition overrides applied). */
export const balloonsIn = (doc: ComicDoc, page: Page, lang?: string): Map<string, Balloon> => {
  const map = new Map(page.balloons.map((b) => [b.lineId, b]));
  const ed = lang && lang !== doc.format?.language ? i18nOf(doc).editions[lang] : undefined;
  if (ed) {
    for (const [lineId, ov] of Object.entries(ed.balloons || {})) {
      const b = map.get(lineId);
      if (!b || !ov) continue;
      const next: Balloon = { ...b };
      if (typeof ov.x === 'number') next.x = ov.x;
      if (typeof ov.y === 'number') next.y = ov.y;
      if (typeof ov.w === 'number') next.w = ov.w;
      if (typeof ov.tailX === 'number') next.tailX = ov.tailX;
      if (typeof ov.tailY === 'number') next.tailY = ov.tailY;
      map.set(lineId, next);
    }
  }
  return map;
};

const textIn = (doc: ComicDoc, line: Line, lang?: string): string => {
  const ed = lang && lang !== doc.format?.language ? i18nOf(doc).editions[lang] : undefined;
  return ed?.lines?.[line.id]?.text || line.text;
};

/**
 * The page scene: every object in draw order (band, then z within the band). Frames come from framesShown; overlays
 * kept inside a panel draw right after their frame; lettering is always last. Lines with neither a stored balloon nor a
 * plan (placed by software at draw time) have no box yet and are left out.
 */
export function buildScene(doc: ComicDoc, page: Page, opts: SceneOptions = {}): PageScene {
  const aspect = composeAspect(doc, page);
  const shown = framesShown(doc, page);
  const objects: SceneObject[] = [{ kind: 'page', id: page.id, band: BANDS.page, box: { ...UNIT_BOX }, z: 0, rot: 0, locked: false, label: `Page ${page.n}` }];

  const layers = layersOf(page);
  const frameIndex = new Map(page.panels.map((p, i) => [p.id, i]));
  const frames = page.panels
    .map((panel, i) => ({ panel, i, z: panel.frame?.z ?? 0 }))
    .sort((a, b) => a.z - b.z || a.i - b.i);
  for (const { panel, i, z } of frames) {
    const box = shown.boxes[i];
    if (!box) continue;
    objects.push({
      kind: 'frame',
      id: panel.id,
      band: BANDS.art,
      box,
      z,
      rot: 0,
      locked: !!panel.frame?.locked,
      panelId: panel.id,
      order: panel.n,
      label: cap1(panelWord(page, panel.id))
    });
    const clipped = layers
      .map((layer, li) => ({ layer, li }))
      .filter((x) => x.layer.clip === panel.id)
      .sort((a, b) => (a.layer.z ?? 0) - (b.layer.z ?? 0) || a.li - b.li);
    for (const { layer } of clipped) objects.push(overlayObject(layer, BANDS.art, box));
  }
  const free = layers
    .map((layer, li) => ({ layer, li }))
    .filter((x) => !x.layer.clip || !frameIndex.has(x.layer.clip))
    .sort((a, b) => (a.layer.z ?? 0) - (b.layer.z ?? 0) || a.li - b.li);
  for (const { layer } of free) objects.push(overlayObject(layer, BANDS.overlays));

  const lang = opts.lang || doc.format?.language || 'en';
  const balloons = balloonsIn(doc, page, opts.lang);
  const plans = new Map((opts.plans || []).map((p) => [p.lineId, p]));
  const lettering: SceneObject[] = [];
  for (const { line, panel, index } of pageLines(page)) {
    const b = balloons.get(line.id);
    const plan = plans.get(line.id);
    let box: Box | undefined;
    let text: { x: number; y: number; w: number } | undefined;
    if (plan) {
      box = planOutlineBox(plan, aspect);
      text = { x: plan.x / PLAN_W, y: plan.y / (PLAN_W / aspect), w: plan.w / PLAN_W };
    } else if (b && Number.isFinite(b.x) && Number.isFinite(b.y) && Number.isFinite(b.w)) {
      box = estimatedBalloonBox(b, textIn(doc, line, opts.lang), aspect, line.lang || lang);
      text = { x: b.x, y: b.y, w: b.w };
    }
    if (!box || !text) continue;
    lettering.push({
      kind: 'balloon',
      id: line.id,
      band: BANDS.lettering,
      box: roundBox(box),
      z: typeof b?.z === 'number' ? b.z : 0,
      rot: typeof b?.rot === 'number' ? b.rot : 0,
      locked: !!b?.locked,
      panelId: panel.id,
      order: index,
      text,
      lineKind: line.kind,
      label: `${lineKindWord(line.kind)}: ${quoteOf(textIn(doc, line, opts.lang))}`
    });
  }
  lettering.sort((a, b) => a.z - b.z || (a.order ?? 0) - (b.order ?? 0));
  objects.push(...lettering);
  return { pageId: page.id, aspect, frames: shown.mode, objects };
}

function overlayObject(layer: PageLayer, band: Band, clip?: Box): SceneObject {
  const out: SceneObject = {
    kind: 'overlay',
    id: layer.id,
    band,
    box: { ...layer.box },
    z: layer.z ?? 0,
    rot: layer.rot ?? 0,
    locked: !!layer.locked,
    label: layerWord(layer)
  };
  if (layer.clip) out.panelId = layer.clip;
  if (clip) out.clip = { ...clip };
  if (layer.print === false) out.guide = true;
  return out;
}

/** The object a ref names, or undefined. */
export const sceneObject = (scene: PageScene, ref: SceneRef): SceneObject | undefined =>
  scene.objects.find((o) => o.kind === ref.kind && o.id === ref.id);

/** Objects under a page point, topmost first (the page itself last). A clipped overlay only hits inside its frame. */
export const objectsAt = (scene: PageScene, point: Point): SceneObject[] =>
  scene.objects.filter((o) => containsPoint(o.box, point) && (!o.clip || containsPoint(o.clip, point))).reverse();

/** The topmost object under a point that passes `accept` (default: any but the page), or undefined. */
export const objectAt = (scene: PageScene, point: Point, accept: (o: SceneObject) => boolean = (o) => o.kind !== 'page'): SceneObject | undefined =>
  objectsAt(scene, point).find(accept);

// ── Z within a band ──────────────────────────────────────────────────────────

export type ZMove = 'forward' | 'backward' | 'front' | 'back';

/**
 * Change an object's stacking WITHIN its band (frames for insets, overlays, balloons): never across bands, so
 * lettering stays on top. Returns the K2a op that sets its z (−100..100), or a refusal.
 */
export function zOrderEdit(doc: ComicDoc, page: Page, ref: SceneRef, move: ZMove, scene: PageScene = buildScene(doc, page)): EditResult {
  if (ref.kind === 'page') return refuse('The page is always at the back.');
  const locked = lockedReason(page, ref);
  if (locked) return refuse(locked);
  const me = sceneObject(scene, ref);
  if (!me) return refuse('That is not on this page.');
  const peers = scene.objects.filter((o) => o.kind === me.kind && o.band === me.band && (o.kind !== 'overlay' || o.panelId === me.panelId));
  const zs = peers.filter((o) => o !== me).map((o) => o.z);
  const lo = zs.length ? Math.min(...zs) : 0;
  const hi = zs.length ? Math.max(...zs) : 0;
  let z = me.z;
  if (move === 'front') z = hi + 1;
  else if (move === 'back') z = lo - 1;
  else {
    const idx = peers.indexOf(me);
    const other = peers[move === 'forward' ? idx + 1 : idx - 1];
    if (!other) return refuse(move === 'forward' ? 'It is already at the front.' : 'It is already at the back.');
    z = move === 'forward' ? other.z + 1 : other.z - 1;
  }
  z = Math.round(clamp(z, -100, 100));
  if (z === me.z) return refuse(NOTHING_TO_CHANGE);
  const word = move === 'front' ? 'Bring to front' : move === 'back' ? 'Send to back' : move === 'forward' ? 'Bring forward' : 'Send backward';
  if (ref.kind === 'overlay') return editOf(doc, [{ op: 'layer', pageId: page.id, id: ref.id, patch: { z } }], `${word}: ${me.label}`);
  if (ref.kind === 'balloon') return editOf(doc, [{ op: 'balloon', pageId: page.id, lineId: ref.id, patch: { z } }], `${word}: ${me.label}`);
  const panel = page.panels.find((p) => p.id === ref.id);
  if (!panel?.frame) return refuse(framesBlockedReason(page) ?? 'That panel has no frame yet.');
  return editOf(doc, [{ op: 'page_frames', pageId: page.id, frames: [{ panelId: panel.id, frame: { ...panel.frame, z } }], moveBalloons: false }], `${word}: ${me.label}`);
}
