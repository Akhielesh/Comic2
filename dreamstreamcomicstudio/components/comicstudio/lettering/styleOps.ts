// UI intent → DocOps for lettering (pure, tested). Every lettering edit is software: deterministic, local
// and free (no render, no AI). The inspector, toolbar, keyboard and balloon layer all go through here so
// that one intent always produces the same ops (and the same undo entry).
//
// Balloon ops always carry the FULL balloon when the line has no stored balloon yet (it was placed by
// software): the `balloon` op otherwise completes a missing balloon with a 0.1/0.1/0.28 default.

import { newId, type Balloon, type Box, type ComicDoc, type Line, type LineKind, type Page, type Panel } from '../../../shared/comic/doc';
import { applyOp, type DocOp } from '../../../shared/comic/ops';
import { PRO_LETTER_LIMITS } from '../../../shared/comic/limits';
import { buildScene, editOf, NOTHING_TO_CHANGE, refuse, sameBox, sceneObject, zOrderEdit, type EditResult, type PageScene, type SceneObject, type SceneRef } from '../../../shared/comic/editor/scene';
import { alignBoxes, alignEdit, distributeEdit, type AlignMode, type DistributeAxis } from '../../../shared/comic/editor/align';
import { setBoxEdit } from '../../../shared/comic/editor/transform';
import { panelBoxesFor } from '../../../shared/comic/pageGeometry';
import { estimateTextHeight, estimateWidthForText } from '../../../shared/comic/textLayout';
import { drawnSpotPatch, letteringSizer, placementCoverOptions, type LetterPlan, type Measure } from '../../../shared/comic/lettering/layout';
import { placeBalloonsWholeWords, safeAreaBox } from '../../../shared/comic/lettering/place';
import {
  DEFAULT_LETTERING,
  DEFAULT_SAFE_MARGIN,
  resolveLetterStyle,
  type LetteringPresetId,
  type LetteringStyleOpPatch,
  type LetterStyle,
  type LetterStylePatch,
  type NamedLetterStyle
} from '../../../shared/comic/lettering/style';

export type StyleScope = 'selection' | 'kind_page' | 'kind_comic' | 'speaker' | 'comic';

const SPOKEN: ReadonlySet<LineKind> = new Set<LineKind>(['speech', 'thought', 'whisper', 'shout']);
const r4 = (n: number) => Math.round(n * 10000) / 10000;
const clamp = (n: number, lo: number, hi: number) => (Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : lo);
const MAX_LINE_IDS = 80;

export interface LineRef {
  panel: Panel;
  line: Line;
  index: number;
}

/** Find a line on a page with its panel and index. */
export const findLineRef = (page: Page, lineId: string): LineRef | undefined => {
  for (const panel of page.panels) {
    const index = panel.lines.findIndex((l) => l.id === lineId);
    if (index >= 0) return { panel, line: panel.lines[index], index };
  }
  return undefined;
};

/** Lines of a page in reading order, filtered to `ids` (unknown ids dropped). */
export const linesOf = (page: Page, ids: readonly string[]): Line[] => {
  const want = new Set(ids);
  return page.panels.flatMap((p) => p.lines.filter((l) => want.has(l.id)));
};

const chunk = <T,>(xs: T[], n: number): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n));
  return out;
};

const lineStyleOps = (pageId: string, lineIds: string[], patch: LetterStylePatch | null, mode?: 'merge' | 'replace'): DocOp[] =>
  chunk(lineIds, MAX_LINE_IDS).map((ids) => ({ op: 'line_style', pageId, lineIds: ids, patch, ...(mode ? { mode } : {}) }) as DocOp);

/**
 * Per-line overrides that would hide a scope-level change: lines in scope that override any of `keys`
 * get those keys removed (`line_style replace` with what is left, or a clear when nothing is left).
 */
const clearShadowingOverrides = (doc: ComicDoc, keys: string[], inScope: (line: Line) => boolean): DocOp[] => {
  const ops: DocOp[] = [];
  for (const page of doc.pages) {
    const groups = new Map<string, { patch: LetterStylePatch | null; ids: string[] }>();
    for (const panel of page.panels) {
      for (const line of panel.lines) {
        if (!line.style || !inScope(line) || !keys.some((k) => k in line.style!)) continue;
        const rest: Record<string, unknown> = { ...line.style };
        for (const k of keys) delete rest[k];
        const patch = Object.keys(rest).length ? (rest as LetterStylePatch) : null;
        const key = JSON.stringify(patch);
        const g = groups.get(key) ?? { patch, ids: [] };
        g.ids.push(line.id);
        groups.set(key, g);
      }
    }
    for (const g of groups.values()) ops.push(...lineStyleOps(page.id, g.ids, g.patch, g.patch ? 'replace' : undefined));
  }
  return ops;
};

/**
 * "Apply this style to…" (lettering.md §7.4 Apply): this balloon / all {kind} on this page / all {kind}
 * in the comic / all of {speaker}'s lines / the whole comic. Comic-wide scopes also lift per-line
 * overrides of the same keys, so the change is visible everywhere it claims to apply.
 */
export function styleScopeOps(doc: ComicDoc, page: Page, lineIds: readonly string[], patch: LetterStylePatch, scope: StyleScope): DocOp[] {
  const selected = linesOf(page, lineIds);
  if (!selected.length || !patch || !Object.keys(patch).length) return [];
  const keys = Object.keys(patch);
  const first = selected[0];
  switch (scope) {
    case 'selection':
      return lineStyleOps(page.id, selected.map((l) => l.id), patch);
    case 'kind_page': {
      const ids = page.panels.flatMap((p) => p.lines.filter((l) => l.kind === first.kind).map((l) => l.id));
      return lineStyleOps(page.id, ids, patch);
    }
    case 'kind_comic':
      return [{ op: 'letter_style', patch: { kinds: { [first.kind]: patch } } }, ...clearShadowingOverrides(doc, keys, (l) => l.kind === first.kind)];
    case 'speaker': {
      const id = first.speakerId;
      if (!id || !doc.cast.some((c) => c.id === id)) return [];
      return [{ op: 'letter_style', patch: { speakers: { [id]: patch } } }, ...clearShadowingOverrides(doc, keys, (l) => l.speakerId === id)];
    }
    case 'comic':
      return [{ op: 'letter_style', patch: { base: patch } }, ...clearShadowingOverrides(doc, keys, () => true)];
    default:
      return [];
  }
}

/** Remove every per-line override on these lines (back to the comic's style). */
export const clearStyleOps = (page: Page, lineIds: readonly string[]): DocOp[] => {
  const ids = linesOf(page, lineIds).filter((l) => l.style).map((l) => l.id);
  return ids.length ? lineStyleOps(page.id, ids, null) : [];
};

/** Switch the whole comic's lettering preset (a manual pick stops automatic preset switching). */
export const presetOps = (presetId: LetteringPresetId, keepOverrides = false): DocOp[] => [
  { op: 'letter_style', patch: { presetId, keepOverrides, auto: null } }
];

/** Resolved style of a line on this doc (for controls showing the current value). */
export const styleOfLine = (doc: ComicDoc, line: Line): LetterStyle => resolveLetterStyle(doc, line);

/** The value every selected line shares for `key`, or undefined when mixed. */
export function sharedValue<K extends keyof LetterStyle>(doc: ComicDoc, lines: readonly Line[], key: K): LetterStyle[K] | undefined {
  if (!lines.length) return undefined;
  const first = JSON.stringify(styleOfLine(doc, lines[0])[key]);
  for (const l of lines.slice(1)) if (JSON.stringify(styleOfLine(doc, l)[key]) !== first) return undefined;
  return styleOfLine(doc, lines[0])[key];
}

/** Size − / +: step every selected line's resolved size (Easy: ±0.1 within 0.6–2.0). */
export function sizeStepOps(doc: ComicDoc, page: Page, lineIds: readonly string[], delta: number, lo = 0.6, hi = 2): DocOp[] {
  const groups = new Map<number, string[]>();
  for (const line of linesOf(page, lineIds)) {
    const current = styleOfLine(doc, line).sizeScale;
    const next = Math.round(clamp(current + delta, lo, hi) * 100) / 100;
    if (next === current) continue;
    groups.set(next, [...(groups.get(next) || []), line.id]);
  }
  return [...groups.entries()].flatMap(([sizeScale, ids]) => lineStyleOps(page.id, ids, { sizeScale }));
}

// ── Easy shapes ───────────────────────────────────────────────────────────────

export type EasyShapeId = 'speech' | 'thought' | 'shout' | 'whisper' | 'caption' | 'robot';
export const EASY_SHAPES: { id: EasyShapeId; label: string; hint: string }[] = [
  { id: 'speech', label: 'Speech', hint: 'A normal speech balloon' },
  { id: 'thought', label: 'Thought', hint: 'A cloud with a bubble trail' },
  { id: 'shout', label: 'Shout', hint: 'A spiky burst' },
  { id: 'whisper', label: 'Whisper', hint: 'A dashed, quieter balloon' },
  { id: 'caption', label: 'Caption', hint: 'A narration box' },
  { id: 'robot', label: 'Robot / radio', hint: 'Electronic zig-zag with a lightning tail' }
];
const SHAPE_KEYS: (keyof LetterStyle)[] = ['shape', 'tail', 'borderStyle'];

/** The Easy shape a line currently shows. */
export const easyShapeOf = (doc: ComicDoc, line: Line): EasyShapeId | undefined => {
  const s = styleOfLine(doc, line);
  if (s.shape === 'electronic') return 'robot';
  if (line.kind === 'thought' || line.kind === 'shout' || line.kind === 'whisper' || line.kind === 'caption') return line.kind;
  return line.kind === 'speech' ? 'speech' : undefined;
};

/**
 * Easy shape picker: semantic shapes change the line's kind (thought/shout/whisper/caption/speech) and
 * drop shape overrides so the comic's look for that kind shows; Robot sets an electronic shape.
 */
export function easyShapeOps(doc: ComicDoc, page: Page, lineIds: readonly string[], shape: EasyShapeId): DocOp[] {
  const ops: DocOp[] = [];
  const clearIds: { line: Line; rest: LetterStylePatch | null }[] = [];
  for (const line of linesOf(page, lineIds)) {
    const ref = findLineRef(page, line.id);
    if (!ref) continue;
    if (shape === 'robot') continue;
    const kind: LineKind = shape;
    if (line.kind !== kind) {
      const patch: Partial<Line> = { kind };
      if (!SPOKEN.has(kind) && line.speakerId) patch.speakerId = null as unknown as undefined;
      if (SPOKEN.has(kind) && !line.speakerId && ref.panel.castIds[0]) patch.speakerId = ref.panel.castIds[0];
      ops.push({ op: 'line', pageId: page.id, panelId: ref.panel.id, id: line.id, patch });
    }
    if (line.style && SHAPE_KEYS.some((k) => k in line.style!)) {
      const rest: Record<string, unknown> = { ...line.style };
      for (const k of SHAPE_KEYS) delete rest[k];
      clearIds.push({ line, rest: Object.keys(rest).length ? (rest as LetterStylePatch) : null });
    }
  }
  if (shape === 'robot') return lineStyleOps(page.id, linesOf(page, lineIds).map((l) => l.id), { shape: 'electronic', tail: 'lightning', borderStyle: 'solid' });
  for (const { line, rest } of clearIds) ops.push(...lineStyleOps(page.id, [line.id], rest, rest ? 'replace' : undefined));
  return ops;
}

// ── Tails ─────────────────────────────────────────────────────────────────────

/** Does this line draw a tail now? */
export const hasVisibleTail = (doc: ComicDoc, line: Line, balloon?: Balloon): boolean => {
  const s = styleOfLine(doc, line);
  if (s.shape === 'none' || s.tail === 'none') return false;
  return SPOKEN.has(line.kind) || (typeof balloon?.tailX === 'number' && typeof balloon?.tailY === 'number');
};

/** Tail on/off. Turning a tail on for a caption/SFX also gives it a tip just below the balloon. */
export function tailToggleOps(doc: ComicDoc, page: Page, lineIds: readonly string[], on: boolean, balloons: ReadonlyMap<string, Balloon>, H: number): DocOp[] {
  const lines = linesOf(page, lineIds);
  if (!lines.length) return [];
  const ops: DocOp[] = lineStyleOps(page.id, lines.map((l) => l.id), { tail: on ? 'auto' : 'none' });
  if (on) {
    for (const line of lines) {
      const b = balloons.get(line.id);
      if (!b || SPOKEN.has(line.kind) || (typeof b.tailX === 'number' && typeof b.tailY === 'number')) continue;
      const h = estimateTextHeight(line.text, b.w, 1000 / H, 'en');
      ops.push(balloonOp(page, line.id, { ...b, tailX: r4(clamp(b.x + b.w * 0.42, 0, 1)), tailY: r4(clamp(b.y + h + 0.05, 0, 1)) }, balloons));
    }
  }
  return ops;
}

// ── Balloon ops ───────────────────────────────────────────────────────────────

const storedOf = (page: Page, lineId: string): Balloon | undefined => page.balloons.find((b) => b.lineId === lineId);

/** A `balloon` op: just the patch when the balloon is stored, else the full resolved balloon + patch. */
export function balloonOp(page: Page, lineId: string, patch: Partial<Balloon>, resolved: ReadonlyMap<string, Balloon>): DocOp {
  const stored = storedOf(page, lineId);
  if (stored) {
    const { lineId: _drop, ...rest } = patch as Balloon;
    return { op: 'balloon', pageId: page.id, lineId, patch: rest };
  }
  const base = resolved.get(lineId);
  const full: Partial<Balloon> = { ...(base || {}), ...patch };
  delete (full as { lineId?: string }).lineId;
  return { op: 'balloon', pageId: page.id, lineId, patch: full };
}

/** Delete lines (their balloons go with them; undo restores both at the same index). */
export const deleteLinesOps = (page: Page, lineIds: readonly string[]): DocOp[] =>
  lineIds
    .map((id) => findLineRef(page, id))
    .filter((r): r is LineRef => !!r)
    .map((r) => ({ op: 'line', pageId: page.id, panelId: r.panel.id, id: r.line.id, patch: null }) as DocOp);

/** Duplicate a line right after itself, same style, balloon offset by 0.02. */
export function duplicateLineOps(page: Page, lineId: string, resolved: ReadonlyMap<string, Balloon>, id = newId('ln')): DocOp[] {
  const ref = findLineRef(page, lineId);
  const b = resolved.get(lineId);
  if (!ref) return [];
  const { id: _old, ...fields } = ref.line;
  const ops: DocOp[] = [{ op: 'line', pageId: page.id, panelId: ref.panel.id, id, patch: { ...fields }, index: ref.index + 1 }];
  if (b) {
    const nb: Partial<Balloon> = { x: r4(clamp(b.x + 0.02, 0, 1 - b.w)), y: r4(clamp(b.y + 0.02, 0, 0.98)), w: b.w, pinned: true };
    if (typeof b.tailX === 'number' && typeof b.tailY === 'number') {
      nb.tailX = r4(clamp(b.tailX + 0.02, 0, 1));
      nb.tailY = r4(clamp(b.tailY + 0.02, 0, 1));
    }
    ops.push({ op: 'balloon', pageId: page.id, lineId: id, patch: nb });
  }
  return ops;
}

export type ZMove = 'front' | 'back' | 'forward' | 'backward';

/** Bring to front / send to back (z −100..100, default = reading order). */
export function zOrderOps(page: Page, lineIds: readonly string[], move: ZMove, plans: readonly LetterPlan[], resolved: ReadonlyMap<string, Balloon>): DocOp[] {
  const zOf = new Map(plans.map((p) => [p.lineId, p.z]));
  const all = [...zOf.values()];
  if (!all.length) return [];
  const max = Math.max(...all);
  const min = Math.min(...all);
  return lineIds
    .filter((id) => zOf.has(id))
    .map((id, i) => {
      const z = zOf.get(id)!;
      const next = move === 'front' ? max + 1 + i : move === 'back' ? min - lineIds.length + i : move === 'forward' ? z + 2 : z - 2;
      return balloonOp(page, id, { z: Math.round(clamp(next, -100, 100)) }, resolved);
    });
}

// drawnSpotPatch lives in the shared engine (layout.ts) so the director's arrange_balloons pins the drawn spot too.
export { drawnSpotPatch };

/**
 * Lock / unlock (locked balloons are never moved by auto-layout or drags). Locking pins the balloon where it is
 * DRAWN (drawnSpotPatch): a crowded or cap-moved stored balloon stays put instead of jumping back to its stored spot.
 */
export const lockOps = (page: Page, lineIds: readonly string[], locked: boolean, resolved: ReadonlyMap<string, Balloon>): DocOp[] =>
  lineIds.map((id) => balloonOp(page, id, locked ? { ...drawnSpotPatch(page, id, resolved), locked: true, pinned: true } : { locked: false }, resolved));

/**
 * Is this balloon part of a connector chain — linked to the previous line (its own `linkTo`) or linked
 * INTO by the next one? (`linkTo` points to the PREVIOUS line in reading order — contract §2.)
 */
export const isLinked = (page: Page, lineId: string): boolean =>
  page.balloons.some((b) => (b.lineId === lineId && !!b.linkTo) || b.linkTo === lineId);

/**
 * Link a balloon to the previous line of the same panel (a connector neck), or unlink it. Unlinking
 * clears the links at BOTH ends of the balloon (its own and one pointing into it), the same as the
 * director's arrange_balloons — so "Unlink" always removes every connector the selection shows.
 */
export function linkOps(page: Page, lineId: string, link: boolean, resolved: ReadonlyMap<string, Balloon>): DocOp[] {
  const ref = findLineRef(page, lineId);
  if (!ref) return [];
  if (link) {
    const prev = ref.panel.lines[ref.index - 1];
    if (!prev) return [];
    const ops: DocOp[] = [];
    if (!storedOf(page, prev.id) && resolved.get(prev.id)) ops.push(balloonOp(page, prev.id, { pinned: true }, resolved));
    ops.push(balloonOp(page, lineId, { linkTo: prev.id }, resolved));
    return ops;
  }
  if (!isLinked(page, lineId)) return [];
  return [
    {
      op: 'balloons',
      pageId: page.id,
      balloons: page.balloons.map((b) => (b.lineId === lineId || b.linkTo === lineId ? (({ linkTo: _l, ...rest }) => rest)(b) : b))
    }
  ];
}

/** May this line link to the previous line of its panel? */
export const canLinkToPrevious = (page: Page, lineId: string): boolean => {
  const ref = findLineRef(page, lineId);
  return !!ref && ref.index > 0;
};

// ── Arrange ───────────────────────────────────────────────────────────────────

export type AlignEdge = 'left' | 'center' | 'right' | 'top' | 'middle' | 'bottom';

/** Outline boxes of plans in page fractions. */
export const outlineFractions = (plan: LetterPlan, H: number): Box => ({
  x: (plan.x + plan.geometry.bounds.x) / 1000,
  y: (plan.y + plan.geometry.bounds.y) / H,
  w: plan.geometry.bounds.w / 1000,
  h: plan.geometry.bounds.h / H
});

/** Align the selected balloons' outlines to a common edge (multi-select). */
export function alignOps(page: Page, plans: readonly LetterPlan[], lineIds: readonly string[], edge: AlignEdge, H: number, resolved: ReadonlyMap<string, Balloon>): DocOp[] {
  const sel = plans.filter((p) => lineIds.includes(p.lineId) && !p.locked);
  if (sel.length < 2) return [];
  const boxes = sel.map((p) => ({ p, o: outlineFractions(p, H) }));
  const target =
    edge === 'left' ? Math.min(...boxes.map((b) => b.o.x))
      : edge === 'right' ? Math.max(...boxes.map((b) => b.o.x + b.o.w))
        : edge === 'center' ? boxes.reduce((s, b) => s + b.o.x + b.o.w / 2, 0) / boxes.length
          : edge === 'top' ? Math.min(...boxes.map((b) => b.o.y))
            : edge === 'bottom' ? Math.max(...boxes.map((b) => b.o.y + b.o.h))
              : boxes.reduce((s, b) => s + b.o.y + b.o.h / 2, 0) / boxes.length;
  return boxes.map(({ p, o }) => {
    const dx = edge === 'left' ? target - o.x : edge === 'right' ? target - (o.x + o.w) : edge === 'center' ? target - (o.x + o.w / 2) : 0;
    const dy = edge === 'top' ? target - o.y : edge === 'bottom' ? target - (o.y + o.h) : edge === 'middle' ? target - (o.y + o.h / 2) : 0;
    return balloonOp(page, p.lineId, moveBalloon(p, H, dx, dy, resolved.get(p.lineId)), resolved);
  });
}

/** Distribute the selected balloons vertically with equal gaps between outlines. */
export function distributeOps(page: Page, plans: readonly LetterPlan[], lineIds: readonly string[], H: number, resolved: ReadonlyMap<string, Balloon>): DocOp[] {
  const sel = plans.filter((p) => lineIds.includes(p.lineId) && !p.locked).map((p) => ({ p, o: outlineFractions(p, H) }));
  if (sel.length < 3) return [];
  sel.sort((a, b) => a.o.y - b.o.y);
  const top = sel[0].o.y;
  const bottom = sel[sel.length - 1].o.y + sel[sel.length - 1].o.h;
  const total = sel.reduce((s, b) => s + b.o.h, 0);
  const gap = (bottom - top - total) / (sel.length - 1);
  let cursor = top;
  return sel.map(({ p, o }) => {
    const dy = cursor - o.y;
    cursor += o.h + gap;
    return balloonOp(page, p.lineId, moveBalloon(p, H, 0, dy, resolved.get(p.lineId)), resolved);
  });
}

/** The drawn text box of a plan moved by (dx, dy) page fractions, with its tail tip, pinned. */
export function moveBalloon(plan: LetterPlan, H: number, dx: number, dy: number, base?: Balloon): Partial<Balloon> {
  const x = plan.x / 1000 + dx;
  const y = plan.y / H + dy;
  const out: Partial<Balloon> = { x: r4(clamp(x, 0, 1)), y: r4(clamp(y, 0, 1)), w: r4(plan.w / 1000), pinned: true };
  if (base && typeof base.tailX === 'number' && typeof base.tailY === 'number') {
    out.tailX = r4(clamp(base.tailX + dx, 0, 1));
    out.tailY = r4(clamp(base.tailY + dy, 0, 1));
  }
  return out;
}

/** Shift balloons whose outline leaves the safe area back inside it (the inspector's "Fix"). */
export function fixSafeAreaOps(doc: ComicDoc, page: Page, plans: readonly LetterPlan[], H: number, resolved: ReadonlyMap<string, Balloon>, only?: readonly string[]): DocOp[] {
  const ls = doc.letterStyle ?? DEFAULT_LETTERING;
  const safe = safeAreaBox(typeof ls.safeMargin === 'number' ? ls.safeMargin : DEFAULT_SAFE_MARGIN, 1000 / H);
  const ops: DocOp[] = [];
  for (const p of plans) {
    if (!p.outOfSafeArea || p.locked || (only && !only.includes(p.lineId))) continue;
    const o = outlineFractions(p, H);
    const dx = o.w > safe.w ? safe.x + (safe.w - o.w) / 2 - o.x : clamp(o.x, safe.x, safe.x + safe.w - o.w) - o.x;
    const dy = o.h > safe.h ? safe.y + (safe.h - o.h) / 2 - o.y : clamp(o.y, safe.y, safe.y + safe.h - o.h) - o.y;
    if (Math.abs(dx) < 1e-5 && Math.abs(dy) < 1e-5) continue;
    ops.push(balloonOp(page, p.lineId, moveBalloon(p, H, dx, dy, resolved.get(p.lineId)), resolved));
  }
  return ops;
}

/**
 * Tidy (free, deterministic): re-place every balloon the user has not pinned or locked around the ones
 * they did, with the same placer the board uses, under the comic's coverage cap (placementCoverOptions).
 * Returns [] when nothing would move.
 */
export function tidyOps(doc: ComicDoc, page: Page, aspect: number, measure: Measure): DocOp[] {
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
    ...placementCoverOptions(doc)
  });
  // Keep z/locked/linkTo of re-placed balloons.
  const prev = new Map(page.balloons.map((b) => [b.lineId, b]));
  const balloons = result.balloons.map((b) => {
    const p = prev.get(b.lineId);
    if (!p) return b;
    const out: Balloon = { ...b };
    if (p.z !== undefined) out.z = p.z;
    if (p.locked) out.locked = true;
    if (p.linkTo) out.linkTo = p.linkTo;
    return out;
  });
  // The placer skips lines with no text (and balloons of lines that no longer exist): their stored
  // balloons are kept as they are — a `balloons` replace without them would delete them (LE-7).
  const placedIds = new Set(balloons.map((b) => b.lineId));
  for (const b of page.balloons || []) {
    if (placedIds.has(b.lineId)) continue;
    placedIds.add(b.lineId);
    balloons.push(b);
  }
  // Nothing moves when only the stored ORDER differs (the placer returns reading order): no op, so the
  // toolbar's Tidy is disabled and no empty undo entry is made.
  if (sameBalloons(balloons, page.balloons || [])) return [];
  return [{ op: 'balloons', pageId: page.id, balloons }];
}

/** Canonical form of a balloon (keys sorted, absent = undefined) for order-insensitive comparison. */
const balloonKey = (b: Balloon): string =>
  JSON.stringify(
    Object.keys(b)
      .filter((k) => (b as unknown as Record<string, unknown>)[k] !== undefined)
      .sort()
      .map((k) => [k, (b as unknown as Record<string, unknown>)[k]])
  );

/** The same balloons by lineId (first one per line, like the engine), whatever their stored order. */
export const sameBalloons = (a: readonly Balloon[], b: readonly Balloon[]): boolean => {
  const first = (list: readonly Balloon[]) => {
    const m = new Map<string, string>();
    for (const x of list) if (!m.has(x.lineId)) m.set(x.lineId, balloonKey(x));
    return m;
  };
  const ma = first(a);
  const mb = first(b);
  if (ma.size !== mb.size) return false;
  for (const [id, k] of ma) if (mb.get(id) !== k) return false;
  return true;
};

/**
 * Dense pages: the engine letters software-placed balloons a step smaller (LetterPlan.densityScale) and a
 * pinned or locked balloon at its style's size. The style size each of these lines is DRAWN at
 * (sizeScale × densityScale, two decimals), by line id — what a drag keeps while the balloon moves.
 */
export const keptSizes = (plans: readonly LetterPlan[], lineIds?: readonly string[]): Map<string, number> => {
  const want = lineIds ? new Set(lineIds) : undefined;
  const out = new Map<string, number>();
  for (const p of plans) {
    if (want && !want.has(p.lineId)) continue;
    if (typeof p.densityScale !== 'number' || !(p.densityScale > 0 && p.densityScale < 1)) continue;
    const base = Number.isFinite(p.style.sizeScale) && p.style.sizeScale > 0 ? p.style.sizeScale : 1;
    out.set(p.lineId, Math.round(clamp(base * p.densityScale, 0.5, 3.5) * 100) / 100);
  }
  return out;
};

/**
 * Pinning a balloon on a dense page (a drag, a nudge, "Keep here", Lock) would letter it at full size: a
 * line-style size override keeps the size the user sees. One `line_style` op per distinct size; [] when no
 * line of `lineIds` is lettered smaller.
 */
export function keepDrawnSizeOps(page: Page, plans: readonly LetterPlan[], lineIds: readonly string[]): DocOp[] {
  const by = new Map<number, string[]>();
  for (const [id, size] of keptSizes(plans, lineIds)) by.set(size, [...(by.get(size) || []), id]);
  return [...by].map(([sizeScale, ids]) => ({ op: 'line_style', pageId: page.id, lineIds: ids, patch: { sizeScale }, mode: 'merge' }) as DocOp);
}

/**
 * Lock, "Keep here" or any other pin from a menu or a panel: `ops` plus, in the original language, the size
 * override that keeps a dense page's balloon at the size it is drawn at (keepDrawnSizeOps) — one patch, one
 * undo entry. A translated edition shares the original's line styles, so there it is `ops` alone.
 */
export function pinKeepingSizeOps(ops: DocOp[], page: Page, plans: readonly LetterPlan[], lineIds: readonly string[], editionLang?: string): DocOp[] {
  return editionLang ? ops : [...ops, ...keepDrawnSizeOps(page, plans, lineIds)];
}

// ── Lines ─────────────────────────────────────────────────────────────────────

const DEFAULT_TEXT: Record<LineKind, string> = {
  speech: '',
  thought: '',
  whisper: '',
  shout: '',
  caption: '',
  sfx: 'POW'
};

/**
 * Add a line of `kind` in the panel under a page point, with its balloon centred there (clamped to the
 * page) and a tail pointing down for spoken kinds. Returns the ops and the new id.
 */
export function addLineAtOps(doc: ComicDoc, page: Page, kind: LineKind, point: { x: number; y: number }, aspect: number, id = newId('ln')): { ops: DocOp[]; id: string; panelId?: string } {
  const boxes = panelBoxesFor(doc, page);
  let panelIndex = boxes.findIndex((b) => point.x >= b.x && point.x <= b.x + b.w && point.y >= b.y && point.y <= b.y + b.h);
  if (panelIndex < 0) {
    // Nearest panel centre.
    let best = Infinity;
    boxes.forEach((b, i) => {
      const d = Math.hypot(point.x - (b.x + b.w / 2), point.y - (b.y + b.h / 2));
      if (d < best) {
        best = d;
        panelIndex = i;
      }
    });
  }
  const panel = page.panels[panelIndex] ?? page.panels[0];
  if (!panel) return { ops: [], id };
  const spoken = SPOKEN.has(kind);
  const patch: Partial<Line> = { kind, text: DEFAULT_TEXT[kind] };
  if (spoken && panel.castIds[0]) patch.speakerId = panel.castIds[0];
  const sample = kind === 'sfx' ? 'POW' : 'A new line of dialogue';
  const w = r4(kind === 'sfx' ? 0.2 : estimateWidthForText(sample, doc.format?.language || 'en'));
  const h = estimateTextHeight(sample, w, aspect, doc.format?.language || 'en');
  const x = r4(clamp(point.x - w / 2, 0.02, 0.98 - w));
  const y = r4(clamp(point.y - h / 2, 0.02, 0.98 - h));
  const balloon: Partial<Balloon> = { x, y, w, pinned: true };
  if (spoken) {
    balloon.tailX = r4(clamp(x + w * 0.42, 0, 1));
    balloon.tailY = r4(clamp(y + h + 0.05, 0, 1));
  }
  return {
    id,
    panelId: panel.id,
    ops: [
      { op: 'line', pageId: page.id, panelId: panel.id, id, patch },
      { op: 'balloon', pageId: page.id, lineId: id, patch: balloon }
    ]
  };
}

/**
 * Move a line to another panel (the crowded-panel fix, and a Layers drag to another panel group); its balloon is
 * re-placed there by software. `index` is its place in the target panel's reading order (default first).
 */
export function moveLineToPanelOps(page: Page, lineId: string, toPanelId: string, index = 0): DocOp[] {
  const ref = findLineRef(page, lineId);
  const target = page.panels.find((p) => p.id === toPanelId);
  if (!ref || !target || target.id === ref.panel.id) return [];
  const at = Math.max(0, Math.min(target.lines.length, Number.isFinite(index) ? Math.round(index) : 0));
  // The line travels whole — never a delete + create, which would prune its translations, their review state and
  // the editions' balloons (paid, reviewed work). Its stored balloon is released so the placer sets it in the new panel.
  const ops: DocOp[] = [{ op: 'line_move', pageId: page.id, id: lineId, toPanelId: target.id, index: at }];
  if (page.balloons.some((b) => b.lineId === lineId)) ops.push({ op: 'balloons', pageId: page.id, balloons: page.balloons.filter((b) => b.lineId !== lineId) });
  const { kind, speakerId } = ref.line;
  if (SPOKEN.has(kind) && speakerId && !target.castIds.includes(speakerId) && target.castIds[0]) {
    ops.push({ op: 'line', pageId: page.id, panelId: target.id, id: lineId, patch: { speakerId: target.castIds[0] } });
  }
  return ops;
}

/** Commit inline text (no-op when unchanged). */
export const textEditOps = (page: Page, lineId: string, text: string): DocOp[] => {
  const ref = findLineRef(page, lineId);
  if (!ref || ref.line.text === text) return [];
  return [{ op: 'line', pageId: page.id, panelId: ref.panel.id, id: lineId, patch: { text } }];
};

/** "Reset position (auto)": let the placer choose a spot for these lines again (locked ones stay), under the comic's coverage cap. */
export function resetPositionOps(doc: ComicDoc, page: Page, lineIds: readonly string[], aspect: number, measure: Measure): DocOp[] {
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
    only: lineIds,
    lang: doc.format?.language,
    ...placementCoverOptions(doc)
  });
  const want = new Set(lineIds);
  const ops: DocOp[] = [];
  for (const b of result.balloons) {
    if (!want.has(b.lineId)) continue;
    const prev = page.balloons.find((x) => x.lineId === b.lineId);
    if (prev?.locked) continue;
    const { lineId, ...rest } = b;
    const patch: Partial<Balloon> = { ...rest, pinned: false };
    if (typeof b.tailX !== 'number' || typeof b.tailY !== 'number') {
      delete patch.tailX;
      delete patch.tailY;
    }
    ops.push({ op: 'balloon', pageId: page.id, lineId, patch });
  }
  return ops;
}

/** Where the vision pass saw this line's speaker (mouth, else head), if it did. */
export const speakerMarkFor = (page: Page, lineId: string): { x: number; y: number } | undefined => {
  const ref = findLineRef(page, lineId);
  const heads = page.render?.qc?.heads;
  if (!ref || !ref.line.speakerId || !Array.isArray(heads)) return undefined;
  const mark = heads.find((h) => h && h.characterId === ref.line.speakerId && h.panel === ref.panel.n);
  const p = mark?.mouth ?? mark?.head;
  return p && Number.isFinite(p.x) && Number.isFinite(p.y) ? { x: clamp(p.x, 0, 1), y: clamp(p.y, 0, 1) } : undefined;
};

/** "Aim at speaker": tail tip at the speaker's mouth/head (pulled 0.02 toward the balloon). */
export function aimAtSpeakerOps(page: Page, plans: readonly LetterPlan[], lineIds: readonly string[], H: number, resolved: ReadonlyMap<string, Balloon>): DocOp[] {
  const ops: DocOp[] = [];
  for (const id of lineIds) {
    const mark = speakerMarkFor(page, id);
    const plan = plans.find((p) => p.lineId === id);
    if (!mark || !plan) continue;
    const cx = (plan.x + plan.w / 2) / 1000;
    const cy = (plan.y + plan.h / 2) / H;
    const d = Math.hypot(cx - mark.x, cy - mark.y) || 1;
    const pull = Math.min(0.02, d / 2);
    ops.push(balloonOp(page, id, { tailX: r4(clamp(mark.x + ((cx - mark.x) / d) * pull, 0, 1)), tailY: r4(clamp(mark.y + ((cy - mark.y) / d) * pull, 0, 1)), pinned: true }, resolved));
  }
  return ops;
}

/**
 * "Widen" (the overflow warning's fix): make each balloon WIDER than it is drawn now — never narrower,
 * which the balanced "Fit text" width can be for a balloon the user already widened — and keep it on
 * the page (shifted left near the right edge). Pinned, tail kept.
 */
export function widenOps(doc: ComicDoc, page: Page, plans: readonly LetterPlan[], lineIds: readonly string[], resolved: ReadonlyMap<string, Balloon>): DocOp[] {
  const margin = 0.008;
  const ops: DocOp[] = [];
  for (const line of linesOf(page, lineIds)) {
    const plan = plans.find((p) => p.lineId === line.id);
    if (!plan || plan.locked) continue;
    const cur = plan.w / 1000;
    const want = Math.max(cur * 1.25, cur + 0.04, estimateWidthForText(line.text, line.lang || doc.format?.language || 'en'));
    const w = r4(clamp(want, cur, 1 - 2 * margin));
    if (w <= cur + 1e-4) continue;
    const x = r4(clamp(plan.x / 1000, margin, 1 - margin - w));
    ops.push(balloonOp(page, line.id, { x, w, pinned: true }, resolved));
  }
  return ops;
}

/** "Fit text": a balanced width for the line's text (the same curve auto-placement uses). */
export function fitWidthOps(doc: ComicDoc, page: Page, lineIds: readonly string[], resolved: ReadonlyMap<string, Balloon>): DocOp[] {
  return linesOf(page, lineIds).map((l) => balloonOp(page, l.id, { w: estimateWidthForText(l.text, l.lang || doc.format?.language || 'en'), pinned: true }, resolved));
}

// ── Pro inspector (PE-INSPECT; agent-editor plan §3 C2, C3, C7) ──────────────────────────────────────────────────────
//
// Every edit below is a B9 EditResult or plain K2a ops the inspector sends through studio.patch with a label (never
// editActionFor, never studio.act): free, undoable, and one undo entry per intent.

/** The kind row's order, and its keys 1–6 (agent-editor plan §3 C3). */
export const KIND_ROW: readonly LineKind[] = ['speech', 'thought', 'whisper', 'shout', 'caption', 'sfx'];

/**
 * The kind row: `line {kind}` for every selected line that is not that kind already. Kind and look are separate
 * (C3): the comic's look for the kind follows through the cascade, and a shape the creator picked stays theirs. The
 * speaker follows the script editor's rule (PageEditor lineKindOps): a caption or sound effect has none, and a spoken
 * line without one takes its panel's first character.
 */
export function kindOps(page: Page, lineIds: readonly string[], kind: LineKind): DocOp[] {
  const ops: DocOp[] = [];
  for (const line of linesOf(page, lineIds)) {
    if (line.kind === kind) continue;
    const ref = findLineRef(page, line.id);
    if (!ref) continue;
    const patch: Partial<Line> = { kind };
    // null clears the speaker (the line op merges its patch; the wire type has no null, hence the cast).
    if (!SPOKEN.has(kind) && line.speakerId) patch.speakerId = null as unknown as undefined;
    if (SPOKEN.has(kind) && !line.speakerId && ref.panel.castIds[0]) patch.speakerId = ref.panel.castIds[0];
    ops.push({ op: 'line', pageId: page.id, panelId: ref.panel.id, id: line.id, patch });
  }
  return ops;
}

/** Where an align lines things up: the selection's bounds, the first balloon's panel, or the page (its safe area). */
export type AlignTo = 'selection' | 'panel' | 'page';

const ALIGN_MODE: Record<AlignEdge, AlignMode> = { left: 'left', center: 'centre', right: 'right', top: 'top', middle: 'middle', bottom: 'bottom' };
const ALIGN_PAGE_WORD: Record<AlignEdge, string> = {
  left: 'Align to the page’s left edge',
  center: 'Centre on the page',
  right: 'Align to the page’s right edge',
  top: 'Align to the top of the page',
  middle: 'Centre on the page, top to bottom',
  bottom: 'Align to the bottom of the page'
};

/** The page scene the inspector edits: exact outlines from the drawn plans. */
export const sceneFor = (doc: ComicDoc, page: Page, plans: readonly LetterPlan[]): PageScene => buildScene(doc, page, { plans });

const balloonRefs = (lineIds: readonly string[]): SceneRef[] => lineIds.map((id) => ({ kind: 'balloon', id }));

/**
 * Align the selected balloons (editor/align.ts): to the selection's bounds (two or more), to the panel the first one
 * sits in, or to the page. "The page" is its lettering safe area — the edge the placer and the safe-area warning use —
 * so a balloon aligned to the page never lands outside it. Locked balloons stay put.
 */
export function alignToEdit(doc: ComicDoc, page: Page, plans: readonly LetterPlan[], lineIds: readonly string[], edge: AlignEdge, to: AlignTo, aspect: number): EditResult {
  const scene = sceneFor(doc, page, plans);
  const refs = balloonRefs(lineIds);
  if (to !== 'page') return alignEdit(doc, page, refs, ALIGN_MODE[edge], { relativeTo: to, scene });
  const objs = refs.map((r) => sceneObject(scene, r)).filter((o): o is SceneObject => !!o);
  if (!objs.length) return refuse('Pick a balloon to align.');
  if (objs.every((o) => o.locked)) return refuse('Everything you picked is locked.');
  const ls = doc.letterStyle ?? DEFAULT_LETTERING;
  const area = safeAreaBox(typeof ls.safeMargin === 'number' ? ls.safeMargin : DEFAULT_SAFE_MARGIN, aspect);
  const boxes = alignBoxes(objs.map((o) => o.box), ALIGN_MODE[edge], area);
  const ops: DocOp[] = [];
  objs.forEach((o, i) => {
    if (o.locked || sameBox(o.box, boxes[i], 1e-4)) return;
    const r = setBoxEdit(doc, page, { kind: o.kind, id: o.id }, boxes[i], scene);
    if (r.ok) ops.push(...r.ops);
  });
  return ops.length ? editOf(doc, ops, ALIGN_PAGE_WORD[edge]) : refuse(NOTHING_TO_CHANGE);
}

/** Space three or more balloons evenly across (h) or down (v), the first and last staying put (editor/align.ts). */
export const distributeToEdit = (doc: ComicDoc, page: Page, plans: readonly LetterPlan[], lineIds: readonly string[], axis: DistributeAxis): EditResult =>
  distributeEdit(doc, page, balloonRefs(lineIds), axis, { scene: sceneFor(doc, page, plans) });

// ── Copy style / Paste style (⌘⌥C / ⌘⌥V; C2) ─────────────────────────────────

/** What Copy style holds: the look a line adds on top of the comic's style for its kind, and its saved style. */
export interface StyleClip {
  /** The overrides to paste (its saved style's patch folded in when that link cannot be pasted). */
  patch?: LetterStylePatch;
  /** The saved style it uses (pasted only while Pro fields are writable). */
  styleId?: string;
  /** The line it came from (the label). */
  from: string;
}

const namedOf = (doc: Pick<ComicDoc, 'letterStyle'>, styleId: string | undefined): NamedLetterStyle | undefined => {
  const named = doc.letterStyle?.named;
  return styleId && named && Object.prototype.hasOwnProperty.call(named, styleId) ? named[styleId] : undefined;
};

/**
 * Copy a line's look: its speaker's patch under its own style (what makes it look the way it does beyond its kind),
 * plus the saved style it links to. With `linkable` false (Pro fields not writable), the saved style's patch is folded
 * into the copy instead of the link. Undefined for an unknown line.
 */
export function copyStyleOf(doc: ComicDoc, page: Page, lineId: string, linkable: boolean): StyleClip | undefined {
  const ref = findLineRef(page, lineId);
  if (!ref) return undefined;
  const { line } = ref;
  const speaker = line.speakerId ? doc.letterStyle?.speakers?.[line.speakerId] : undefined;
  const named = namedOf(doc, line.styleId);
  const patch = { ...(!linkable && named ? named.patch : {}), ...(speaker || {}), ...(line.style || {}) } as LetterStylePatch;
  return {
    ...(Object.keys(patch).length ? { patch } : {}),
    ...(linkable && named && line.styleId ? { styleId: line.styleId } : {}),
    from: line.id
  };
}

/**
 * Paste a copied look onto lines: each takes exactly the copied overrides (`line_style` replace, or a clear when there
 * are none), in one op for the lot. The patch passes `clean` first (the inspector strips the Pro fields while they are
 * not writable). With `linkable`, the saved-style link follows too (`line {styleId}`, null to unlink).
 */
export function pasteStyleOps(
  doc: ComicDoc,
  page: Page,
  lineIds: readonly string[],
  clip: StyleClip,
  opts: { linkable: boolean; clean?: (p: LetterStylePatch | undefined) => LetterStylePatch | undefined }
): DocOp[] {
  const lines = linesOf(page, lineIds).filter((l) => l.id !== clip.from);
  if (!lines.length) return [];
  const patch = opts.clean ? opts.clean(clip.patch) : clip.patch;
  const same = (l: Line) => JSON.stringify(l.style ?? null) === JSON.stringify(patch ?? null);
  const restyle = lines.filter((l) => !same(l)).map((l) => l.id);
  const ops: DocOp[] = restyle.length ? lineStyleOps(page.id, restyle, patch ?? null, patch ? 'replace' : undefined) : [];
  if (opts.linkable) {
    const want = clip.styleId && namedOf(doc, clip.styleId) ? clip.styleId : undefined;
    for (const l of lines) if ((l.styleId ?? undefined) !== want) ops.push(lineLinkOp(page, l.id, want ?? null));
  }
  return ops;
}

// ── Named styles (C7: Save as style, list, rename, duplicate, delete folds back) ──

const lineLinkOp = (page: Page, lineId: string, styleId: string | null): DocOp => {
  const ref = findLineRef(page, lineId)!;
  // null unlinks (the line op merges its patch; the wire type has no null, hence the cast).
  return { op: 'line', pageId: page.id, panelId: ref.panel.id, id: lineId, patch: { styleId } as unknown as Partial<Line> };
};

/** A `letter_style` op over saved styles: an entry upserts that style, null deletes it. */
export const namedStyleOp = (named: Record<string, NamedLetterStyle | null>): DocOp =>
  ({ op: 'letter_style', patch: { named } as unknown as LetteringStyleOpPatch }) as DocOp;

/** The saved styles in stored order, with how many live lines use each. */
export function namedStylesOf(doc: Pick<ComicDoc, 'letterStyle' | 'pages'>): { id: string; name: string; patch: LetterStylePatch; uses: number }[] {
  const named = doc.letterStyle?.named;
  if (!named) return [];
  const uses = new Map<string, number>();
  for (const p of doc.pages) for (const panel of p.panels) for (const l of panel.lines) if (l.styleId) uses.set(l.styleId, (uses.get(l.styleId) ?? 0) + 1);
  return Object.entries(named)
    .filter(([, v]) => !!v && typeof v.name === 'string')
    .map(([id, v]) => ({ id, name: v.name, patch: v.patch || {}, uses: uses.get(id) ?? 0 }));
}

/** A style name as it is stored: trimmed, one line, at most PRO_LETTER_LIMITS.namedNameChars. */
export const cleanStyleName = (name: string): string => name.replace(/\s+/g, ' ').trim().slice(0, PRO_LETTER_LIMITS.namedNameChars).trim();

/** A name nothing else is called ("Villain", "Villain 2", …). */
export const uniqueStyleName = (doc: Pick<ComicDoc, 'letterStyle' | 'pages'>, want: string, exceptId?: string): string => {
  const base = cleanStyleName(want) || 'Style';
  const taken = new Set(namedStylesOf(doc).filter((s) => s.id !== exceptId).map((s) => s.name.toLowerCase()));
  if (!taken.has(base.toLowerCase())) return base;
  for (let n = 2; n < 1000; n++) {
    const tail = ` ${n}`;
    const cand = `${base.slice(0, PRO_LETTER_LIMITS.namedNameChars - tail.length).trimEnd()}${tail}`;
    if (!taken.has(cand.toLowerCase())) return cand;
  }
  return base;
};

/** The keys a speaker's patch decides (later in the cascade than a saved style, so they must stay on the line). */
const speakerKeys = (doc: ComicDoc, line: Line): Set<string> => {
  const sp = line.speakerId ? doc.letterStyle?.speakers?.[line.speakerId] : undefined;
  return new Set(Object.entries(sp || {}).filter(([, v]) => v !== undefined).map(([k]) => k));
};

/**
 * "Save as style…": the line's overrides (over any saved style it already uses) become a new saved style, and the line
 * links to it. Keys its speaker's patch also sets stay on the line, so the cascade (… → named → speakers → line) draws
 * it exactly as before. [] at the PRO_LETTER_LIMITS.namedStyles cap or for an unknown line.
 */
export function saveNamedStyleOps(doc: ComicDoc, page: Page, lineId: string, name: string, id = newId('st')): DocOp[] {
  const ref = findLineRef(page, lineId);
  if (!ref || namedStylesOf(doc).length >= PRO_LETTER_LIMITS.namedStyles) return [];
  const { line } = ref;
  const prior = namedOf(doc, line.styleId);
  const patch = { ...(prior?.patch || {}), ...(line.style || {}) } as LetterStylePatch;
  const ops: DocOp[] = [namedStyleOp({ [id]: { name: uniqueStyleName(doc, name), patch } }), lineLinkOp(page, lineId, id)];
  if (line.style) {
    const keep = speakerKeys(doc, line);
    const rest = Object.fromEntries(Object.entries(line.style).filter(([k]) => keep.has(k))) as LetterStylePatch;
    ops.push(...lineStyleOps(page.id, [lineId], Object.keys(rest).length ? rest : null, Object.keys(rest).length ? 'replace' : undefined));
  }
  return ops;
}

/** "Update from this balloon" (Adobe's redefine): the line's overrides join the saved style it uses; every line that
 *  uses it restyles (linked styles, C7). Speaker-decided keys stay on the line, as in Save. */
export function redefineNamedStyleOps(doc: ComicDoc, page: Page, lineId: string): DocOp[] {
  const ref = findLineRef(page, lineId);
  const styleId = ref?.line.styleId;
  const style = namedOf(doc, styleId);
  if (!ref || !styleId || !style || !ref.line.style) return [];
  const keep = speakerKeys(doc, ref.line);
  const rest = Object.fromEntries(Object.entries(ref.line.style).filter(([k]) => keep.has(k))) as LetterStylePatch;
  return [
    namedStyleOp({ [styleId]: { name: style.name, patch: { ...style.patch, ...ref.line.style } } }),
    ...lineStyleOps(page.id, [lineId], Object.keys(rest).length ? rest : null, Object.keys(rest).length ? 'replace' : undefined)
  ];
}

/** Rename a saved style (its look and its lines stay). */
export function renameNamedStyleOps(doc: ComicDoc, styleId: string, name: string): DocOp[] {
  const style = namedOf(doc, styleId);
  const next = cleanStyleName(name);
  if (!style || !next || next === style.name) return [];
  return [namedStyleOp({ [styleId]: { name: uniqueStyleName(doc, next, styleId), patch: style.patch } })];
}

/** Duplicate a saved style ("Villain copy"); no line uses the copy yet. [] at the cap. */
export function duplicateNamedStyleOps(doc: ComicDoc, styleId: string, id = newId('st')): DocOp[] {
  const style = namedOf(doc, styleId);
  if (!style || namedStylesOf(doc).length >= PRO_LETTER_LIMITS.namedStyles) return [];
  return [namedStyleOp({ [id]: { name: uniqueStyleName(doc, `${style.name} copy`), patch: { ...style.patch } } })];
}

/** Link the selected lines to a saved style, or unlink them (null). */
export function useNamedStyleOps(doc: ComicDoc, page: Page, lineIds: readonly string[], styleId: string | null): DocOp[] {
  if (styleId && !namedOf(doc, styleId)) return [];
  return linesOf(page, lineIds)
    .filter((l) => (l.styleId ?? null) !== styleId)
    .map((l) => lineLinkOp(page, l.id, styleId));
}

/**
 * The style a line keeps when its saved style is deleted: the saved patch folded into its own style, wherever nothing
 * later in the cascade (its own style, its speaker's patch) already decides the key — so it draws exactly as before
 * (C7: "deleting a style folds its patch back, so nothing changes visually").
 */
export function foldedStyleOf(doc: ComicDoc, line: Line, styleId: string): LetterStylePatch | undefined {
  const style = namedOf(doc, styleId);
  if (!style || line.styleId !== styleId) return line.style;
  const own = new Set(Object.entries(line.style || {}).filter(([, v]) => v !== undefined).map(([k]) => k));
  const sp = speakerKeys(doc, line);
  const add = Object.fromEntries(Object.entries(style.patch || {}).filter(([k, v]) => v !== undefined && !own.has(k) && !sp.has(k)));
  const out = { ...(line.style || {}), ...add };
  return Object.keys(out).length ? (out as LetterStylePatch) : undefined;
}

/**
 * Delete a saved style in one undo entry: every live line that uses it keeps its look (a `line_style` replace with the
 * folded style), is unlinked (`line {styleId: null}`), then the style goes (`letter_style {named: {id: null}}`).
 */
export function deleteNamedStyleOps(doc: ComicDoc, styleId: string): DocOp[] {
  if (!namedOf(doc, styleId)) return [];
  const ops: DocOp[] = [];
  for (const page of doc.pages) {
    for (const panel of page.panels) {
      for (const line of panel.lines) {
        if (line.styleId !== styleId) continue;
        const folded = foldedStyleOf(doc, line, styleId);
        if (JSON.stringify(folded ?? null) !== JSON.stringify(line.style ?? null)) ops.push(...lineStyleOps(page.id, [line.id], folded ?? null, folded ? 'replace' : undefined));
        ops.push(lineLinkOp(page, line.id, null));
      }
    }
  }
  ops.push(namedStyleOp({ [styleId]: null }));
  return ops;
}

// ── Layers: restack within the lettering band (zOrderEdit) ───────────────────

/**
 * Restack a balloon so it draws just in front of `overId` (when it was behind it) or just behind it (when it was in
 * front): repeated zOrderEdit steps within the lettering band (never across bands, so lettering stays on top). The
 * result is one edit with the final z; a line the software placed (no stored balloon) gets its whole drawn balloon so
 * the restack never moves it.
 */
export function restackEdit(
  doc: ComicDoc,
  page: Page,
  plans: readonly LetterPlan[],
  lineId: string,
  overId: string,
  resolved: ReadonlyMap<string, Balloon>
): EditResult {
  if (lineId === overId) return refuse(NOTHING_TO_CHANGE);
  const ref: SceneRef = { kind: 'balloon', id: lineId };
  const order = (d: ComicDoc, p: Page) => sceneFor(d, p, plans).objects.filter((o) => o.kind === 'balloon').map((o) => o.id);
  const start = order(doc, page);
  if (!start.includes(lineId) || !start.includes(overId)) return refuse('That is not on this page.');
  const forward = start.indexOf(lineId) < start.indexOf(overId);
  let cur = doc;
  let curPage = page;
  let last: EditResult | undefined;
  for (let i = 0; i < start.length; i++) {
    const now = order(cur, curPage);
    const done = forward ? now.indexOf(lineId) > now.indexOf(overId) : now.indexOf(lineId) < now.indexOf(overId);
    if (done) break;
    const r = zOrderEdit(cur, curPage, ref, forward ? 'forward' : 'backward', sceneFor(cur, curPage, plans));
    if (!r.ok) return last?.ok ? last : r;
    last = r;
    cur = r.ops.reduce(applyOp, cur);
    curPage = cur.pages.find((p) => p.id === page.id) ?? curPage;
  }
  if (!last || !last.ok) return refuse(NOTHING_TO_CHANGE);
  const zOp = last.ops.find((o): o is Extract<DocOp, { op: 'balloon' }> => o.op === 'balloon');
  const z = zOp?.patch.z;
  if (typeof z !== 'number') return refuse(NOTHING_TO_CHANGE);
  return editOf(doc, [balloonOp(page, lineId, { z }, resolved)], last.label);
}
