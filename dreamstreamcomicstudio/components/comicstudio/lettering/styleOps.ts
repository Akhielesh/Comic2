// UI intent → DocOps for lettering (pure, tested). Every lettering edit is software: deterministic, local
// and free (no render, no AI). The inspector, toolbar, keyboard and balloon layer all go through here so
// that one intent always produces the same ops (and the same undo entry).
//
// Balloon ops always carry the FULL balloon when the line has no stored balloon yet (it was placed by
// software): the `balloon` op otherwise completes a missing balloon with a 0.1/0.1/0.28 default.

import { newId, type Balloon, type Box, type ComicDoc, type Line, type LineKind, type Page, type Panel } from '../../../shared/comic/doc';
import type { DocOp } from '../../../shared/comic/ops';
import { panelBoxesFor } from '../../../shared/comic/pageGeometry';
import { estimateTextHeight, estimateWidthForText } from '../../../shared/comic/textLayout';
import { letteringSizer, type LetterPlan, type Measure } from '../../../shared/comic/lettering/layout';
import { placeBalloonsDetailed, safeAreaBox } from '../../../shared/comic/lettering/place';
import {
  DEFAULT_LETTERING,
  DEFAULT_SAFE_MARGIN,
  resolveLetterStyle,
  type LetteringPresetId,
  type LetterStyle,
  type LetterStylePatch
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

/** Lock / unlock (locked balloons are never moved by auto-layout or drags). */
export const lockOps = (page: Page, lineIds: readonly string[], locked: boolean, resolved: ReadonlyMap<string, Balloon>): DocOp[] =>
  lineIds.map((id) => balloonOp(page, id, locked ? { locked: true, pinned: true } : { locked: false }, resolved));

/** Link a balloon to the previous line of the same panel (a connector neck), or unlink it. */
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
  if (!storedOf(page, lineId)?.linkTo) return [];
  return [{ op: 'balloons', pageId: page.id, balloons: page.balloons.map((b) => (b.lineId === lineId ? (({ linkTo: _l, ...rest }) => rest)(b) : b)) }];
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
 * they did, with the same placer the board uses. Returns [] when nothing would move.
 */
export function tidyOps(doc: ComicDoc, page: Page, aspect: number, measure: Measure): DocOp[] {
  const ls = doc.letterStyle ?? DEFAULT_LETTERING;
  const qc = page.render?.qc;
  const result = placeBalloonsDetailed({
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
    lang: doc.format?.language
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
  if (JSON.stringify(balloons) === JSON.stringify(page.balloons)) return [];
  return [{ op: 'balloons', pageId: page.id, balloons }];
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

/** Move a line to another panel (the crowded-panel fix); its balloon is re-placed there by software. */
export function moveLineToPanelOps(page: Page, lineId: string, toPanelId: string): DocOp[] {
  const ref = findLineRef(page, lineId);
  const target = page.panels.find((p) => p.id === toPanelId);
  if (!ref || !target || target.id === ref.panel.id) return [];
  const { id: _id, ...fields } = ref.line;
  const patch: Partial<Line> = { ...fields };
  if (SPOKEN.has(fields.kind) && fields.speakerId && !target.castIds.includes(fields.speakerId) && target.castIds[0]) patch.speakerId = target.castIds[0];
  return [
    { op: 'line', pageId: page.id, panelId: ref.panel.id, id: lineId, patch: null },
    { op: 'line', pageId: page.id, panelId: target.id, id: lineId, patch, index: 0 }
  ];
}

/** Commit inline text (no-op when unchanged). */
export const textEditOps = (page: Page, lineId: string, text: string): DocOp[] => {
  const ref = findLineRef(page, lineId);
  if (!ref || ref.line.text === text) return [];
  return [{ op: 'line', pageId: page.id, panelId: ref.panel.id, id: lineId, patch: { text } }];
};

/** "Reset position (auto)": let the placer choose a spot for these lines again (locked ones stay). */
export function resetPositionOps(doc: ComicDoc, page: Page, lineIds: readonly string[], aspect: number, measure: Measure): DocOp[] {
  const ls = doc.letterStyle ?? DEFAULT_LETTERING;
  const qc = page.render?.qc;
  const result = placeBalloonsDetailed({
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
    lang: doc.format?.language
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
