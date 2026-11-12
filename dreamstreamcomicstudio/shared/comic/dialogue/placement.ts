// Dialogue understanding: where a balloon goes (agent-editor plan §3 B2 placement.ts). Pure and free.
//
// Every position starts from where the balloon is DRAWN today (the lettering plan the editor and the director's
// arrange_balloons start from), so a balloon never jumps back to a stored spot it is not shown at. Frames:
// - panel: the line's panel box inside the page safe area (the director's positionIn, tools/lettering.ts);
// - page: the page safe area;
// - edge: a full-width bar inside the frame, at its top or bottom;
// - near / relation: beside a character's head mark (SpeakerMark), falling back to where the page staged them, with a
//   sentence saying so (never silent about a fallback);
// - between: the midpoint of two heads;
// - nudge: 0.02 of the page for "a bit", 0.08 for "a lot".
// compile.ts commits the result through the editor's setBoxEdit, so locks, undo and the stored shape match the editor.

import { POS9, type Balloon, type Box, type ComicDoc, type Line, type Page, type Pos9 } from '../doc.js';
import { framesShown, buildScene, type PageScene, type SceneObject } from '../editor/scene.js';
import { drawnBalloonOf, drawnSpotPatch, estimateMeasure, letteringAspect, letteringSizer, planLettering, PLAN_W, type LetterPlan } from '../lettering/layout.js';
import { safeAreaBox, stagedSpeakerX } from '../lettering/place.js';
import { DEFAULT_LETTERING, DEFAULT_SAFE_MARGIN } from '../lettering/style.js';
import type { DocOp } from '../ops.js';
import { normalizeLetteringText } from '../textLayout.js';
import { castList, matchSpeaker, noSuchSpeaker, speakerName } from './speakers.js';
import type { Placement, PlacementResult } from './types.js';

/** How far a nudge moves (page fractions): "a bit" and "a lot" (plan §3 B2). */
export const NUDGE_STEP = { bit: 0.02, lot: 0.08 } as const;
/** Inset inside a panel (the director's PANEL_PAD). */
export const PANEL_PAD = 0.012;
/** Gap between a head mark's centre and a balloon placed above or below it (page heights). */
export const HEAD_CLEAR = 0.05;
/** Gap between a head mark and a balloon placed beside it (page widths). */
export const SIDE_CLEAR = 0.04;
/** Width limits of a balloon's text box (the director's resize clamp). */
export const BALLOON_W = { min: 0.08, max: 0.95 } as const;
/** Render-time page margin an outline keeps (visualqa §4). */
const PAGE_MARGIN = 0.008;

const r4 = (n: number): number => Math.round(n * 10000) / 10000;
const clamp = (n: number, lo: number, hi: number): number => (Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : lo);
const validFrame = (b: unknown): b is Box =>
  !!b && typeof b === 'object' && ['x', 'y', 'w', 'h'].every((k) => Number.isFinite((b as Record<string, number>)[k])) && (b as Box).w > 0 && (b as Box).h > 0;

// ── Cells ────────────────────────────────────────────────────────────────────

/** Where a cell sits in its frame: 0 = start, 0.5 = middle, 1 = end, per axis. */
export const cellFractions = (cell: Pos9): { fx: number; fy: number } => ({
  fx: cell.endsWith('left') ? 0 : cell.endsWith('right') ? 1 : 0.5,
  fy: cell.startsWith('top') ? 0 : cell.startsWith('bottom') ? 1 : 0.5
});

/** The words for a cell ("top left", "middle"). */
export const cellWords = (cell: Pos9): string => (cell === 'center' ? 'middle' : cell.replace('-', ' '));

/**
 * The box of one of the nine cells of a page-normalized frame: its top-left corner (each cell is a third of the frame
 * on each axis, so its size is frame.w / 3 × frame.h / 3). Null for an unknown cell or an empty frame.
 */
export function cellBox(frame: { x: number; y: number; w: number; h: number }, cell: Pos9): { x: number; y: number } | null {
  if (!validFrame(frame) || !(POS9 as readonly string[]).includes(cell)) return null;
  const col = cell.endsWith('left') ? 0 : cell.endsWith('right') ? 2 : 1;
  const row = cell.startsWith('top') ? 0 : cell.startsWith('bottom') ? 2 : 1;
  return { x: r4(frame.x + (col * frame.w) / 3), y: r4(frame.y + (row * frame.h) / 3) };
}

// ── The page as drawn ────────────────────────────────────────────────────────

/** One page's lettering geometry: panel boxes, safe area and every lettered line where it is drawn. */
export interface PageGeo {
  doc: ComicDoc;
  page: Page;
  /** Page width ÷ height as shown. */
  aspect: number;
  /** One box per panel, in the page's panel order (frames as the editor shows them). */
  boxes: Box[];
  safe: Box;
  rtl: boolean;
  plans: readonly LetterPlan[];
  scene: PageScene;
}

/** Docs are immutable (every op returns a new one), so a page's geometry is computed once per doc. */
const geoCache = new WeakMap<ComicDoc, Map<string, PageGeo>>();

export function pageGeo(doc: ComicDoc, page: Page): PageGeo {
  let byPage = geoCache.get(doc);
  if (!byPage) {
    byPage = new Map();
    geoCache.set(doc, byPage);
  }
  const hit = byPage.get(page.id);
  if (hit && hit.page === page) return hit;
  const aspect = letteringAspect(doc, page);
  const ls = doc.letterStyle ?? DEFAULT_LETTERING;
  const plans = planLettering(doc, page, aspect, estimateMeasure);
  const geo: PageGeo = {
    doc,
    page,
    aspect,
    boxes: framesShown(doc, page).boxes,
    safe: safeAreaBox(typeof ls.safeMargin === 'number' ? ls.safeMargin : DEFAULT_SAFE_MARGIN, aspect),
    rtl: doc.format?.readingDirection === 'rtl',
    plans,
    scene: buildScene(doc, page, { plans })
  };
  byPage.set(page.id, geo);
  return geo;
}

/** Where one line's balloon is drawn: its outline and text box (page fractions), panel and stored balloon. */
export interface LineGeo {
  line: Line;
  panelIndex: number;
  /** The outline box (what the reader sees). */
  box: Box;
  /** The text box the outline is drawn around (the stored x, y, w). */
  text: { x: number; y: number; w: number };
  /** Text-box height (page-height fraction). */
  h: number;
  stored?: Balloon;
  locked: boolean;
  object: SceneObject;
}

export function lineGeo(geo: PageGeo, lineId: string): LineGeo | undefined {
  const panelIndex = geo.page.panels.findIndex((p) => p.lines.some((l) => l.id === lineId));
  if (panelIndex < 0) return undefined;
  const line = geo.page.panels[panelIndex].lines.find((l) => l.id === lineId)!;
  const object = geo.scene.objects.find((o) => o.kind === 'balloon' && o.id === lineId);
  if (!object || !object.text) return undefined;
  const plan = geo.plans.find((p) => p.lineId === lineId);
  const H = PLAN_W / geo.aspect;
  const stored = geo.page.balloons.find((b) => b.lineId === lineId);
  const h = plan ? plan.h / H : Math.max(0.01, object.box.h - 0.024 * geo.aspect);
  return { line, panelIndex, box: object.box, text: object.text, h, stored, locked: !!stored?.locked, object };
}

/** The outline box of a line as drawn on its page (undefined when it is not lettered there). */
export const lineBox = (doc: ComicDoc, page: Page, lineId: string): Box | undefined => lineGeo(pageGeo(doc, page), lineId)?.box;

/**
 * The balloon behind a line as the creator SEES it: a pinned or locked balloon where it is stored; an unpinned or
 * software-placed one where the lettering plan draws it (layout.ts withDrawnSpots, the editor's rule).
 */
export function drawnBalloon(geo: PageGeo, lineId: string): Balloon | undefined {
  const stored = geo.page.balloons.find((b) => b.lineId === lineId);
  if (stored && (stored.pinned || stored.locked)) return stored;
  const plan = geo.plans.find((p) => p.lineId === lineId);
  if (!plan) return stored;
  return drawnBalloonOf(stored ?? { lineId, x: 0, y: 0, w: 0 }, plan, PLAN_W / geo.aspect);
}

/**
 * A `balloon` op that never leaves a half balloon behind (mirrors the director's balloonOp): a line with no stored balloon
 * gets its complete drawn balloon plus the patch; a stored unpinned balloon drawn elsewhere is pinned at its DRAWN spot
 * when the patch pins it. Undefined when the line has no balloon on the page at all.
 */
export function balloonPatchOp(geo: PageGeo, lineId: string, patch: Partial<Balloon>): DocOp | undefined {
  const stored = geo.page.balloons.find((b) => b.lineId === lineId);
  const drawn = drawnBalloon(geo, lineId);
  if (!stored && !drawn) return undefined;
  const pins = patch.pinned === true || patch.locked === true;
  let full: Partial<Balloon>;
  if (!stored) {
    const { lineId: _id, ...rest } = drawn!;
    full = { ...rest, ...patch };
  } else if (pins && drawn) {
    full = { ...drawnSpotPatch(geo.page, lineId, new Map([[lineId, drawn]])), ...patch };
  } else full = patch;
  const clean: Partial<Balloon> = {};
  for (const [k, v] of Object.entries(full)) {
    if (k === 'lineId' || v === undefined) continue;
    (clean as Record<string, unknown>)[k] = typeof v === 'number' ? r4(v) : v;
  }
  return { op: 'balloon', pageId: geo.page.id, lineId, patch: clean };
}

// ── Regions ──────────────────────────────────────────────────────────────────

interface Region {
  x: number;
  y: number;
  r: number;
  b: number;
}

const panelRegion = (geo: PageGeo, panelIndex: number): Region => {
  const box = geo.boxes[panelIndex] ?? { x: 0, y: 0, w: 1, h: 1 };
  return {
    x: Math.max(box.x + PANEL_PAD, geo.safe.x),
    y: Math.max(box.y + PANEL_PAD, geo.safe.y),
    r: Math.min(box.x + box.w - PANEL_PAD, geo.safe.x + geo.safe.w),
    b: Math.min(box.y + box.h - PANEL_PAD, geo.safe.y + geo.safe.h)
  };
};
const pageRegion = (geo: PageGeo): Region => ({ x: geo.safe.x, y: geo.safe.y, r: geo.safe.x + geo.safe.w, b: geo.safe.y + geo.safe.h });

/** The outline's offset and size relative to its text box. */
interface Rel {
  bx: number;
  by: number;
  bw: number;
  bh: number;
}
const relOf = (g: LineGeo): Rel => ({ bx: g.box.x - g.text.x, by: g.box.y - g.text.y, bw: g.box.w, bh: g.box.h });

/** The text-box spot that puts the outline at fractions (fx, fy) of the room the region leaves (centred when too small). */
const spotIn = (region: Region, rel: Rel, fx: number, fy: number): { x: number; y: number } => {
  const xLo = region.x - rel.bx;
  const xHi = region.r - (rel.bx + rel.bw);
  const yLo = region.y - rel.by;
  const yHi = region.b - (rel.by + rel.bh);
  return {
    x: xHi >= xLo ? xLo + (xHi - xLo) * fx : (xLo + xHi) / 2,
    y: yHi >= yLo ? yLo + (yHi - yLo) * fy : (yLo + yHi) / 2
  };
};

/** A text-box spot moved (not resized) so its outline lies inside the region; reports whether it had to move. */
const keepInside = (spot: { x: number; y: number }, rel: Rel, region: Region): { x: number; y: number; moved: boolean } => {
  const xLo = region.x - rel.bx;
  const xHi = region.r - (rel.bx + rel.bw);
  const yLo = region.y - rel.by;
  const yHi = region.b - (rel.by + rel.bh);
  const x = xHi >= xLo ? clamp(spot.x, xLo, xHi) : (xLo + xHi) / 2;
  const y = yHi >= yLo ? clamp(spot.y, yLo, yHi) : (yLo + yHi) / 2;
  return { x, y, moved: Math.abs(x - spot.x) > 1e-4 || Math.abs(y - spot.y) > 1e-4 };
};

// ── Characters on the page ───────────────────────────────────────────────────

/** Where a character is in a panel: their head mark (with the mouth when marked), else where the page staged them. */
export interface CharacterSpot {
  head: { x: number; y: number };
  mouth?: { x: number; y: number };
  /** No head mark: the position the page prompt staged them at (a guess, said out loud). */
  staged: boolean;
  panelIndex: number;
}

export function characterSpot(geo: PageGeo, panelIndex: number, characterId: string): CharacterSpot | undefined {
  const panel = geo.page.panels[panelIndex];
  if (!panel) return undefined;
  const mark = (geo.page.render?.qc?.heads ?? []).find((m) => m.panel === panel.n && m.characterId === characterId);
  if (mark && Number.isFinite(mark.head?.x) && Number.isFinite(mark.head?.y)) {
    return { head: { ...mark.head }, ...(mark.mouth ? { mouth: { ...mark.mouth } } : {}), staged: false, panelIndex };
  }
  if (!(panel.castIds ?? []).includes(characterId)) return undefined;
  const box = geo.boxes[panelIndex] ?? { x: 0, y: 0, w: 1, h: 1 };
  return { head: { x: box.x + stagedSpeakerX(geo.page, panelIndex, characterId, 0, geo.rtl) * box.w, y: box.y + box.h * 0.4 }, staged: true, panelIndex };
}

/** The panels of a page a character appears in (by head mark or cast list), as panel numbers. */
const panelsWith = (page: Page, characterId: string): number[] =>
  page.panels
    .filter((p) => (p.castIds ?? []).includes(characterId) || (page.render?.qc?.heads ?? []).some((m) => m.panel === p.n && m.characterId === characterId))
    .map((p) => p.n);

const notInPanel = (doc: ComicDoc, page: Page, panelN: number, characterId: string): string => {
  const name = speakerName(doc, characterId) ?? 'They';
  const elsewhere = panelsWith(page, characterId);
  return `${name} isn't in panel ${panelN}${elsewhere.length ? ` (they appear in panel ${elsewhere.join(', ')} on page ${page.n})` : ` on page ${page.n}`}.`;
};

const stagedNote = (doc: ComicDoc, page: Page, ids: readonly string[]): string =>
  `Placed by the staging: there's no face data for ${castList(doc, ids)} on page ${page.n} yet.`;

/** Who a name means, for placement and tails: one id, or a plain-words failure (with the candidates to ask about). */
type Who = { ok: true; id: string } | { ok: false; reason: string; candidates?: string[] };
const whoIs = (doc: ComicDoc, name: string, pronounOf?: string): Who => {
  const m = matchSpeaker(doc, name, { pronounOf });
  if (m.status === 'one') return { ok: true, id: m.characterId };
  if (m.status === 'many') return { ok: false, reason: `“${name}” could be ${castList(doc, m.characterIds)}. Which one?`, candidates: m.characterIds };
  return { ok: false, reason: noSuchSpeaker(doc, name) };
};

// ── Placement ────────────────────────────────────────────────────────────────

/**
 * Why a character-relative spot failed, so the studio can ask instead of only refusing: `candidates` = a name that could
 * be several people; `absent` = that character isn't drawn in the line's panel (`elsewhere`: the panels of the page that
 * show them; `drawn`: who the line's panel does show); `pairs` = "between them" with more than two people (`drawn`);
 * `few` = "between them" with fewer than two (`drawn`).
 */
export interface PlaceMiss {
  reason: string;
  candidates?: string[];
  absent?: { characterId: string; panelN: number; elsewhere: number[]; drawn: string[] };
  pairs?: string[];
  few?: string[];
}

/** A placement outcome: the stored spot (text box x, y and, for a bar, its width) with a plain-words `where`, or why not. */
export type PlaceOutcome = { ok: true; x: number; y: number; w?: number; note?: string; where: string } | ({ ok: false } & PlaceMiss);

/** Who a panel shows (its cast, plus anyone with a head mark there), in cast order. */
const drawnIn = (page: Page, panelIndex: number): string[] => {
  const panel = page.panels[panelIndex];
  if (!panel) return [];
  const marked = (page.render?.qc?.heads ?? []).filter((m) => m.panel === panel.n).map((m) => m.characterId);
  return [...new Set([...(panel.castIds ?? []), ...marked])];
};

/** The miss for a character not drawn in the line's panel. */
const absentMiss = (doc: ComicDoc, page: Page, panelIndex: number, panelN: number, characterId: string): { ok: false } & PlaceMiss => ({
  ok: false,
  reason: notInPanel(doc, page, panelN, characterId),
  absent: { characterId, panelN, elsewhere: panelsWith(page, characterId).filter((n) => n !== panelN), drawn: drawnIn(page, panelIndex).filter((id) => id !== characterId) }
});

const describeFrame = (geo: PageGeo, g: LineGeo, frame: Placement['frame']): string =>
  frame === 'page' ? `page ${geo.page.n}` : `panel ${geo.page.panels[g.panelIndex]?.n ?? g.panelIndex + 1}`;

/**
 * Where a placement puts one line's balloon (page fractions of its stored text box). Fails in plain words when the line
 * is not lettered on that page, a named character is ambiguous or absent, or "between them" has not exactly two people.
 */
export function placeLine(doc: ComicDoc, pageId: string, lineId: string, place: Placement): PlaceOutcome {
  const page = doc.pages.find((p) => p.id === pageId);
  if (!page) return { ok: false, reason: 'That page is not in the comic.' };
  const geo = pageGeo(doc, page);
  const g = lineGeo(geo, lineId);
  if (!g) {
    const empty = page.panels.some((p) => p.lines.some((l) => l.id === lineId && !normalizeLetteringText(l.text)));
    return { ok: false, reason: empty ? 'That line has no words yet, so it has no balloon to place.' : 'That line is not on this page.' };
  }
  const rel = relOf(g);
  const frame: Placement['frame'] = place.frame === 'page' ? 'page' : 'panel';
  const region = frame === 'page' ? pageRegion(geo) : panelRegion(geo, g.panelIndex);
  const panelN = page.panels[g.panelIndex]?.n ?? g.panelIndex + 1;

  // Nudge: from where it is drawn, kept on the page.
  if (place.nudge) {
    const d = NUDGE_STEP[place.amount === 'lot' ? 'lot' : 'bit'];
    const dx = place.nudge === 'left' ? -d : place.nudge === 'right' ? d : 0;
    const dy = place.nudge === 'up' ? -d : place.nudge === 'down' ? d : 0;
    const want = { x: g.text.x + dx, y: g.text.y + dy };
    const kept = keepInside(want, rel, { x: PAGE_MARGIN, y: PAGE_MARGIN, r: 1 - PAGE_MARGIN, b: 1 - PAGE_MARGIN });
    const way = place.nudge === 'up' ? 'higher' : place.nudge === 'down' ? 'lower' : `to the ${place.nudge}`;
    return {
      ok: true,
      x: r4(kept.x),
      y: r4(kept.y),
      where: `${place.amount === 'lot' ? 'a lot' : 'a bit'} ${way}`,
      ...(kept.moved ? { note: 'It stopped at the page edge so its outline stays visible.' } : {})
    };
  }

  // A full-width bar at the top or bottom of the frame.
  if (place.edge) {
    const regionW = region.r - region.x;
    const sizer = letteringSizer(doc, page, geo.aspect, estimateMeasure);
    let w = clamp(g.text.w + (regionW - g.box.w), BALLOON_W.min, BALLOON_W.max);
    let s = sizer(g.line, w);
    w = clamp(w + (regionW - s.bounds.w), BALLOON_W.min, BALLOON_W.max);
    s = sizer(g.line, w);
    const x = region.x - s.bounds.x;
    const y = place.edge === 'top' ? region.y - s.bounds.y : region.b - (s.bounds.y + s.bounds.h);
    return { ok: true, x: r4(x), y: r4(y), w: r4(w), where: `a full-width bar across the ${place.edge} of ${describeFrame(geo, g, frame)}` };
  }

  // Between two characters ("between them": the panel's two people).
  if (place.relation === 'between') {
    let ids: string[];
    if (place.near && place.and) {
      const a = whoIs(doc, place.near, g.line.speakerId);
      if (a.ok === false) return { ok: false, reason: a.reason, candidates: a.candidates };
      const b = whoIs(doc, place.and, g.line.speakerId);
      if (b.ok === false) return { ok: false, reason: b.reason, candidates: b.candidates };
      ids = [a.id, b.id];
    } else {
      const cast = [...new Set(page.panels[g.panelIndex]?.castIds ?? [])];
      if (cast.length > 2) {
        return { ok: false, reason: `Panel ${panelN} has ${cast.length} characters (${castList(doc, cast)}), so “between them” could mean any two. Which two?`, pairs: cast };
      }
      if (cast.length < 2) {
        return { ok: false, reason: `Panel ${panelN} has ${cast.length ? `only ${castList(doc, cast)}` : 'nobody'} in it, so there's no “between” there. Where should it go?`, few: cast };
      }
      ids = cast;
    }
    const spots = ids.map((id) => characterSpot(geo, g.panelIndex, id));
    const missing = ids.filter((_, i) => !spots[i]);
    if (missing.length) return absentMiss(doc, page, g.panelIndex, panelN, missing[0]);
    const [a, b] = spots as CharacterSpot[];
    const cx = (a.head.x + b.head.x) / 2;
    const top = Math.min(a.head.y, b.head.y) - HEAD_CLEAR;
    const kept = keepInside({ x: cx - rel.bw / 2 - rel.bx, y: top - rel.bh - rel.by }, rel, region);
    const staged = ids.filter((_, i) => spots[i]!.staged);
    return { ok: true, x: r4(kept.x), y: r4(kept.y), where: `between ${castList(doc, ids)}`, ...(staged.length ? { note: stagedNote(doc, page, staged) } : {}) };
  }

  // Next to a character (above / below / left / right / near).
  if (place.near) {
    const who = whoIs(doc, place.near, g.line.speakerId);
    if (who.ok === false) return { ok: false, reason: who.reason, candidates: who.candidates };
    let spot = characterSpot(geo, g.panelIndex, who.id);
    // "of the page": the character may be in another panel; one panel with them is enough.
    if (!spot && frame === 'page') {
      const others = page.panels.map((_, i) => characterSpot(geo, i, who.id)).filter((s): s is CharacterSpot => !!s);
      if (others.length === 1) spot = others[0];
    }
    if (!spot) return absentMiss(doc, page, g.panelIndex, panelN, who.id);
    const room = frame === 'page' ? region : panelRegion(geo, spot.panelIndex);
    const relation = place.relation ?? 'near';
    const at = spot.head;
    const above = { x: at.x - rel.bw / 2 - rel.bx, y: at.y - HEAD_CLEAR - rel.bh - rel.by };
    let want: { x: number; y: number };
    if (relation === 'below') want = { x: at.x - rel.bw / 2 - rel.bx, y: at.y + HEAD_CLEAR - rel.by };
    else if (relation === 'left') want = { x: at.x - SIDE_CLEAR - rel.bw - rel.bx, y: at.y - rel.bh / 2 - rel.by };
    else if (relation === 'right') want = { x: at.x + SIDE_CLEAR - rel.bx, y: at.y - rel.bh / 2 - rel.by };
    else if (relation === 'above') want = above;
    else {
      // "near": above the head when it fits, else beside it on the side with more room.
      const fitsAbove = above.y + rel.by >= room.y - 1e-6;
      const leftRoom = at.x - room.x;
      const rightRoom = room.r - at.x;
      want = fitsAbove
        ? above
        : rightRoom >= leftRoom
          ? { x: at.x + SIDE_CLEAR - rel.bx, y: at.y - rel.bh / 2 - rel.by }
          : { x: at.x - SIDE_CLEAR - rel.bw - rel.bx, y: at.y - rel.bh / 2 - rel.by };
    }
    const kept = keepInside(want, rel, room);
    const name = speakerName(doc, who.id) ?? 'them';
    const words = relation === 'above' ? `above ${name}'s head` : relation === 'below' ? `below ${name}` : relation === 'left' ? `to the left of ${name}` : relation === 'right' ? `to the right of ${name}` : `next to ${name}`;
    return { ok: true, x: r4(kept.x), y: r4(kept.y), where: words, ...(spot.staged ? { note: stagedNote(doc, page, [who.id]) } : {}) };
  }

  // One of the nine cells of the frame.
  if (place.cell && (POS9 as readonly string[]).includes(place.cell)) {
    const { fx, fy } = cellFractions(place.cell);
    const spot = spotIn(region, rel, fx, fy);
    return { ok: true, x: r4(spot.x), y: r4(spot.y), where: `the ${cellWords(place.cell)} of ${describeFrame(geo, g, frame)}` };
  }

  return { ok: false, reason: 'Where should it go? Say a spot such as “top left”, “across the bottom”, “above Mira” or “up a bit”.' };
}

/**
 * Where a balloon goes (B2 placement.ts): the panel box or the page safe area, a full-width edge bar, beside a head or
 * mouth mark (falling back to the staging, with a note), between two heads, or a nudge (0.02 "a bit", 0.08 "a lot").
 * Null when it cannot be placed (placeLine says why).
 */
export function placementFor(doc: ComicDoc, pageId: string, lineId: string, place: Placement): PlacementResult | null {
  const out = placeLine(doc, pageId, lineId, place);
  if (out.ok === false) return null;
  return { x: out.x, y: out.y, ...(out.w !== undefined ? { w: out.w } : {}), ...(out.note ? { note: out.note } : {}) };
}

// ── Tails ────────────────────────────────────────────────────────────────────

export type TipOutcome = { ok: true; x: number; y: number; note?: string; who?: string } | ({ ok: false } & PlaceMiss);

/**
 * Where a tail should point: at a character (their mouth, else head mark, else where the page staged them, said out
 * loud), at the line's own speaker's mouth ('mouth'), or at the nearest edge of the line's panel ('edge', an off-panel
 * voice).
 */
export function tailTip(doc: ComicDoc, pageId: string, lineId: string, to: { characterId: string } | { name: string } | 'mouth' | 'edge'): TipOutcome {
  const page = doc.pages.find((p) => p.id === pageId);
  if (!page) return { ok: false, reason: 'That page is not in the comic.' };
  const geo = pageGeo(doc, page);
  const g = lineGeo(geo, lineId);
  if (!g) return { ok: false, reason: 'That line has no balloon on this page.' };
  const box = geo.boxes[g.panelIndex] ?? { x: 0, y: 0, w: 1, h: 1 };
  const panelN = page.panels[g.panelIndex]?.n ?? g.panelIndex + 1;
  if (to === 'edge') {
    const cx = g.box.x + g.box.w / 2;
    const cy = g.box.y + g.box.h / 2;
    const d = { left: cx - box.x, right: box.x + box.w - cx, top: cy - box.y, bottom: box.y + box.h - cy };
    const side = (Object.keys(d) as (keyof typeof d)[]).reduce((a, b) => (d[b] < d[a] ? b : a));
    const x = side === 'left' ? box.x : side === 'right' ? box.x + box.w : clamp(cx, box.x, box.x + box.w);
    const y = side === 'top' ? box.y : side === 'bottom' ? box.y + box.h : clamp(cy, box.y, box.y + box.h);
    return { ok: true, x: r4(clamp(x, 0, 1)), y: r4(clamp(y, 0, 1)), who: `the ${side} edge of panel ${panelN}` };
  }
  let id: string;
  if (to === 'mouth') {
    if (!g.line.speakerId) return { ok: false, reason: 'A caption or sound effect has no speaker for its tail to point at.' };
    id = g.line.speakerId;
  } else if ('characterId' in to) id = to.characterId;
  else {
    const who = whoIs(doc, to.name, g.line.speakerId);
    if (who.ok === false) return { ok: false, reason: who.reason, candidates: who.candidates };
    id = who.id;
  }
  const spot = characterSpot(geo, g.panelIndex, id);
  if (!spot) return absentMiss(doc, page, g.panelIndex, panelN, id);
  const name = speakerName(doc, id) ?? 'them';
  if (spot.staged) {
    const y = Math.min(Math.max(g.text.y + g.h + 0.035, box.y + box.h * 0.4), box.y + box.h - PANEL_PAD);
    return { ok: true, x: r4(clamp(spot.head.x, 0, 1)), y: r4(clamp(y, 0, 1)), who: name, note: `Aimed where the page staged ${name}: there's no face data for page ${page.n} yet.` };
  }
  const tip = spot.mouth ?? spot.head;
  const note = to === 'mouth' && !spot.mouth ? `There's no mouth mark for ${name} on page ${page.n}, so the tail points at the head.` : undefined;
  return { ok: true, x: r4(clamp(tip.x, 0, 1)), y: r4(clamp(tip.y, 0, 1)), who: to === 'mouth' ? `${name}'s mouth` : name, ...(note ? { note } : {}) };
}
