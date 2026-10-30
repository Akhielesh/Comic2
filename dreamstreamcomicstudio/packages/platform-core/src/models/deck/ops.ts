/**
 * DeckSpec ops (plan §5.2): `applyDeckOps(deck, ops) → {doc, applied, rejected}` with exact inverses, and
 * `overlapCheck(slide)`: export is refused while two `content` elements of a slide overlap, because the decks we hand
 * to an engine are laid out by explicit rectangles and no engine is trusted to move things apart.
 *
 * The op rules are in models/common.ts; what is DeckSpec's own:
 * - Slide ids are unique in a deck, element ids within a slide; an op that would repeat one is refused (`invalid`;
 *   a slide that repeats an element id already fails the op's own check).
 * - Positions are exact: `add_slide` at most at the end, `move_slide` to an existing position (`invalid` otherwise).
 * - At most `DECK_LIMITS.slides` slides (`limit`). Overlaps are allowed while editing; only export refuses them.
 */
import type { OpId } from '../../contract/schema.js';
import type { DeckOp, DeckOpResult, DeckRect, DeckSpec, OverlapPair, Slide } from '../../contract/deck.js';
import { DECK_LIMITS } from '../../contract/deck.js';
import type { ApplyOptions, InverseMeta, OpKernel, Step } from '../common.js';
import { applyOpsWith, indexById, insertAt, invertOpWith, invertOpsWith, isRecord, removeAt, replaceAt, stepFail, stepOk } from '../common.js';
import { DECK_OVERLAP_EPSILON, DeckOpSchema, isLineShape, refineDeckOp } from './schema.js';

const step = (deck: DeckSpec, op: DeckOp): Step<DeckSpec> => {
  switch (op.op) {
    case 'add_slide': {
      if (indexById(deck.slides, op.slide.id) !== -1) return stepFail('invalid', `slide id ${op.slide.id} is already used`);
      const index = op.index === undefined ? deck.slides.length : op.index;
      if (index > deck.slides.length) return stepFail('invalid', `index ${index} is past the end of the slides (${deck.slides.length})`);
      if (deck.slides.length >= DECK_LIMITS.slides) return stepFail('limit', `a deck holds at most ${DECK_LIMITS.slides} slides`);
      return stepOk({ ...deck, slides: insertAt(deck.slides, index, op.slide) });
    }
    case 'update_slide': {
      const at = indexById(deck.slides, op.slideId);
      if (at === -1) return stepFail('not-found', `there is no slide ${op.slideId}`);
      return stepOk({ ...deck, slides: replaceAt(deck.slides, at, op.slide) });
    }
    case 'remove_slide': {
      const at = indexById(deck.slides, op.slideId);
      if (at === -1) return stepFail('not-found', `there is no slide ${op.slideId}`);
      return stepOk({ ...deck, slides: removeAt(deck.slides, at) });
    }
    case 'move_slide': {
      const at = indexById(deck.slides, op.slideId);
      if (at === -1) return stepFail('not-found', `there is no slide ${op.slideId}`);
      if (op.index >= deck.slides.length) return stepFail('invalid', `index ${op.index} is past the last slide (${deck.slides.length - 1})`);
      return stepOk({ ...deck, slides: insertAt(removeAt(deck.slides, at), op.index, deck.slides[at]) });
    }
    case 'set_theme':
      return stepOk({ ...deck, theme: op.theme });
  }
};

const invert = (before: DeckSpec, op: DeckOp, id: OpId, baseRev: number): DeckOp | null => {
  switch (op.op) {
    case 'add_slide':
      return { op: 'remove_slide', id, baseRev, slideId: op.slide.id };
    case 'update_slide': {
      const at = indexById(before.slides, op.slideId);
      return at === -1 ? null : { op: 'update_slide', id, baseRev, slideId: op.slideId, slide: before.slides[at] };
    }
    case 'remove_slide': {
      const at = indexById(before.slides, op.slideId);
      return at === -1 ? null : { op: 'add_slide', id, baseRev, index: at, slide: before.slides[at] };
    }
    case 'move_slide': {
      const at = indexById(before.slides, op.slideId);
      return at === -1 ? null : { op: 'move_slide', id, baseRev, slideId: op.slideId, index: at };
    }
    case 'set_theme':
      return { op: 'set_theme', id, baseRev, theme: before.theme };
  }
};

const KERNEL: OpKernel<DeckSpec, DeckOp> = { noun: 'deck', schema: DeckOpSchema, refine: refineDeckOp, step, invert };

/**
 * Apply `ops` to `deck`: pure, immutable, never throws. Returns the next deck (the same object when nothing applied),
 * the ops that applied (checked copies) and the refused ones with why. See the op rules in models/common.ts.
 */
export const applyDeckOps = (deck: DeckSpec, ops: readonly DeckOp[], options?: ApplyOptions): DeckOpResult => applyOpsWith(KERNEL, deck, ops, options);

/**
 * The undo batch for the ops one `applyDeckOps(before, …)` call applied: newest first, stamped with
 * `meta.id(op, index)` and `meta.baseRev`. `add_slide` ↔ `remove_slide` (back at its old index); `update_slide`,
 * `move_slide` and `set_theme` invert to themselves with the old slide, position or theme. Null when an op does not
 * apply to `before`.
 */
export const invertDeckOps = (before: DeckSpec, applied: readonly DeckOp[], meta: InverseMeta<DeckOp>): DeckOp[] | null =>
  invertOpsWith(KERNEL, before, applied, meta);

/** The exact inverse of one op as applied to `before`, or null. */
export const invertDeckOp = (before: DeckSpec, op: DeckOp, meta: { id: OpId; baseRev: number }): DeckOp | null => invertOpWith(KERNEL, before, op, meta);

// ── Overlaps ───────────────────────────────────────────────────────────────────────────────────────────────────

export { DECK_OVERLAP_EPSILON };

const E = DECK_OVERLAP_EPSILON;

const rectOf = (el: unknown): DeckRect | null => {
  if (!isRecord(el) || !Array.isArray(el.rect) || el.rect.length !== 4) return null;
  const r = el.rect as unknown[];
  for (const n of r) if (typeof n !== 'number' || !isFinite(n)) return null;
  return r as DeckRect;
};

/** A content element as `overlapCheck` sees it. */
interface Box {
  id: string;
  rect: DeckRect;
  /** A `line` shape with no width or no height: it collides only with a box it runs through. */
  line: boolean;
  /** Any other element with no width or no height (refused by `checkDeckSpec`): it collides with whatever it touches. */
  squashed: boolean;
}

/** How much `[lo1, hi1]` and `[lo2, hi2]` share. */
const shared = (lo1: number, len1: number, lo2: number, len2: number): number => Math.min(lo1 + len1, lo2 + len2) - Math.max(lo1, lo2);

/** A line crosses a box when it runs through the box's inside (lying along its edge does not count). */
const crosses = (line: DeckRect, box: DeckRect): boolean => {
  const [lx, ly, lw, lh] = line;
  const [bx, by, bw, bh] = box;
  if (lw <= E && lh <= E) return false; // a point
  if (lh <= E) return ly > by + E && ly < by + bh - E && shared(lx, lw, bx, bw) > E;
  return lx > bx + E && lx < bx + bw - E && shared(ly, lh, by, bh) > E;
};

/** Two rects meet, edges and corners included. */
const touches = (a: DeckRect, b: DeckRect): boolean => shared(a[0], a[2], b[0], b[2]) >= -E && shared(a[1], a[3], b[1], b[3]) >= -E;

/** The overlap of two content elements as a fraction of the slide (0 for a line through a box), or null for none. */
const overlapOf = (a: Box, b: Box): number | null => {
  // A flat text box or table is still drawn down from its top edge, so it collides with anything it touches.
  if (a.squashed || b.squashed) return touches(a.rect, b.rect) ? 0 : null;
  if (a.line && b.line) return null; // two rules crossing is a drawing, not a collision
  if (a.line) return crosses(a.rect, b.rect) ? 0 : null;
  if (b.line) return crosses(b.rect, a.rect) ? 0 : null;
  const w = shared(a.rect[0], a.rect[2], b.rect[0], b.rect[2]);
  const h = shared(a.rect[1], a.rect[3], b.rect[1], b.rect[3]);
  return w > E && h > E ? w * h : null;
};

/**
 * Every pair of `content` elements on `slide` whose rects overlap, in element order (`a` before `b`), with the
 * overlap's area as a fraction of the slide. `background` elements never count; edges that only touch do not overlap.
 * A `line` shape with no width or no height overlaps a box it runs through, with area 0, and never another line (a
 * diagonal line counts as its bounding box). Any other element with no width or no height (which `checkDeckSpec`
 * refuses) overlaps everything it touches, with area 0. Pure and total on any JSON value: an element it cannot read is
 * skipped.
 */
export const overlapCheck = (slide: Slide): OverlapPair[] => {
  const out: OverlapPair[] = [];
  if (!isRecord(slide) || !Array.isArray(slide.elements)) return out;
  const boxes: Box[] = [];
  for (const el of slide.elements as unknown[]) {
    const rect = rectOf(el);
    if (!rect || !isRecord(el) || el.layer !== 'content' || typeof el.id !== 'string') continue;
    const flat = rect[2] <= E || rect[3] <= E;
    const line = flat && isLineShape(el);
    boxes.push({ id: el.id, rect, line, squashed: flat && !line });
  }
  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      const area = overlapOf(boxes[i], boxes[j]);
      if (area !== null) out.push({ a: boxes[i].id, b: boxes[j].id, area });
    }
  }
  return out;
};

/** The overlaps of one slide, as `deckOverlaps` lists them. */
export interface SlideOverlaps {
  slideId: string;
  pairs: OverlapPair[];
}

/** `overlapCheck` over every slide of `deck`: only the slides that have overlaps, in deck order. [] means exportable. */
export const deckOverlaps = (deck: DeckSpec): SlideOverlaps[] => {
  const out: SlideOverlaps[] = [];
  if (!isRecord(deck) || !Array.isArray(deck.slides)) return out;
  for (const slide of deck.slides as unknown[]) {
    const pairs = overlapCheck(slide as Slide);
    if (pairs.length && isRecord(slide) && typeof slide.id === 'string') out.push({ slideId: slide.id, pairs });
  }
  return out;
};
