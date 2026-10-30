// Snapping and smart guides (Ship 2, B9; design §4.8). Generalizes the lettering editor's computeSnap: a box being
// moved snaps, within SNAP_PX screen pixels, to the page margins and centre, the safe area, frame edges and centres,
// gutters, other objects' edges and centres, user guides — and to EQUAL SPACING ("the same gap as between balloons 1
// and 2"). Pure: page fractions in, a correction and the guides to draw out.

import { frameStyleOf, type Box, type Page } from '../doc.js';
import { safeAreaBox } from '../lettering/place.js';
import type { PageScene, SceneObject, SceneRef } from './scene.js';

/** Snap distance in screen pixels (design §4.8). */
export const SNAP_PX = 6;

export type SnapKind = 'page' | 'margin' | 'safe' | 'frame' | 'gutter' | 'object' | 'guide';
export interface SnapLine {
  axis: 'x' | 'y';
  /** Page fraction (x: of the width, y: of the height). */
  at: number;
  kind: SnapKind;
  /** 'edge' or 'centre' of what it came from. */
  part: 'edge' | 'centre';
}
export interface SnapTargets {
  lines: SnapLine[];
  /** Boxes the moving box may space itself evenly against (other objects of its kind, or frames). */
  boxes: Box[];
}

export interface SnapGuide {
  axis: 'x' | 'y';
  at: number;
  kind: SnapKind;
}
/** An equal-spacing hint: the gap the box now repeats, and every gap of that size to draw. */
export interface SpacingHint {
  axis: 'x' | 'y';
  gap: number;
  /** The gaps of this size (from → to along the axis), including the moving box's own. */
  spans: { from: number; to: number }[];
}
export interface SnapResult {
  dx: number;
  dy: number;
  guides: SnapGuide[];
  spacing: SpacingHint[];
}

/** The snap distance in page fractions for a page drawn `pageWidthPx` × `pageHeightPx` on screen. */
export const snapThreshold = (pageWidthPx: number, pageHeightPx: number, px = SNAP_PX): { x: number; y: number } => ({
  x: pageWidthPx > 0 ? px / pageWidthPx : 0.01,
  y: pageHeightPx > 0 ? px / pageHeightPx : 0.01
});

export interface SnapTargetOptions {
  /** User guides (page fractions). */
  guides?: { x?: number[]; y?: number[] };
  /** The lettering safe margin (page fraction of the width); default 0.03. */
  safeMargin?: number;
}

const pushBox = (lines: SnapLine[], b: Box, kind: SnapKind) => {
  lines.push({ axis: 'x', at: b.x, kind, part: 'edge' }, { axis: 'x', at: b.x + b.w / 2, kind, part: 'centre' }, { axis: 'x', at: b.x + b.w, kind, part: 'edge' });
  lines.push({ axis: 'y', at: b.y, kind, part: 'edge' }, { axis: 'y', at: b.y + b.h / 2, kind, part: 'centre' }, { axis: 'y', at: b.y + b.h, kind, part: 'edge' });
};

/** Mid-lines of the gutters between frames that face each other across a gap no wider than 3 gutters. */
const gutterLines = (frames: Box[], gutter: number): SnapLine[] => {
  const out: SnapLine[] = [];
  const maxGap = Math.max(0.005, gutter * 3);
  for (const a of frames) {
    for (const b of frames) {
      if (a === b) continue;
      const gx = b.x - (a.x + a.w);
      const overlapY = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
      if (gx > 0 && gx <= maxGap && overlapY > 0) out.push({ axis: 'x', at: a.x + a.w + gx / 2, kind: 'gutter', part: 'centre' });
      const gy = b.y - (a.y + a.h);
      const overlapX = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
      if (gy > 0 && gy <= maxGap && overlapX > 0) out.push({ axis: 'y', at: a.y + a.h + gy / 2, kind: 'gutter', part: 'centre' });
    }
  }
  return out;
};

/**
 * Every line a moving object may snap to on this page, and the boxes it may space evenly against. The moving object
 * itself (and, for a balloon, nothing below the page band) is left out. Frames snap to margins, gutters and other
 * frames; overlays and balloons also to frames' inner edges and to their own kind.
 */
export function snapTargets(scene: PageScene, page: Pick<Page, 'frameStyle'>, moving: SceneRef, opts: SnapTargetOptions = {}): SnapTargets {
  const style = frameStyleOf(page);
  const lines: SnapLine[] = [
    { axis: 'x', at: 0.5, kind: 'page', part: 'centre' },
    { axis: 'y', at: 0.5, kind: 'page', part: 'centre' },
    { axis: 'x', at: style.margin, kind: 'margin', part: 'edge' },
    { axis: 'x', at: 1 - style.margin, kind: 'margin', part: 'edge' },
    { axis: 'y', at: style.margin, kind: 'margin', part: 'edge' },
    { axis: 'y', at: 1 - style.margin, kind: 'margin', part: 'edge' }
  ];
  if (moving.kind !== 'frame') {
    const safe = safeAreaBox(typeof opts.safeMargin === 'number' ? opts.safeMargin : 0.03, scene.aspect);
    lines.push(
      { axis: 'x', at: safe.x, kind: 'safe', part: 'edge' },
      { axis: 'x', at: safe.x + safe.w, kind: 'safe', part: 'edge' },
      { axis: 'y', at: safe.y, kind: 'safe', part: 'edge' },
      { axis: 'y', at: safe.y + safe.h, kind: 'safe', part: 'edge' }
    );
  }
  const isMe = (o: SceneObject) => o.kind === moving.kind && o.id === moving.id;
  const frames = scene.objects.filter((o) => o.kind === 'frame' && !isMe(o)).map((o) => o.box);
  for (const f of frames) pushBox(lines, f, 'frame');
  lines.push(...gutterLines(scene.objects.filter((o) => o.kind === 'frame').map((o) => o.box), style.gutter));
  const peers = scene.objects.filter((o) => o.kind !== 'page' && o.kind !== 'frame' && !isMe(o));
  if (moving.kind !== 'frame') for (const o of peers) pushBox(lines, o.box, 'object');
  for (const x of opts.guides?.x || []) if (Number.isFinite(x)) lines.push({ axis: 'x', at: x, kind: 'guide', part: 'edge' });
  for (const y of opts.guides?.y || []) if (Number.isFinite(y)) lines.push({ axis: 'y', at: y, kind: 'guide', part: 'edge' });
  const boxes = moving.kind === 'frame' ? frames : peers.filter((o) => o.kind === moving.kind).map((o) => o.box);
  return { lines, boxes };
}

/** Candidate positions (box start along the axis) that make the box repeat an existing gap, or sit evenly between two. */
interface SpacingCandidate {
  start: number;
  gap: number;
  spans: { from: number; to: number }[];
}

const along = (b: Box, axis: 'x' | 'y') => (axis === 'x' ? { s: b.x, e: b.x + b.w, ps: b.y, pe: b.y + b.h } : { s: b.y, e: b.y + b.h, ps: b.x, pe: b.x + b.w });

/**
 * Equal-spacing candidates along one axis for a box of `size` whose cross-axis range is [ps, pe]: only boxes that share
 * that range (the same row for x, the same column for y) count. Gaps are measured between neighbours in that row.
 */
function spacingCandidates(box: Box, axis: 'x' | 'y', others: Box[]): SpacingCandidate[] {
  const me = along(box, axis);
  const size = me.e - me.s;
  const row = others
    .map((b) => along(b, axis))
    .filter((o) => Math.min(o.pe, me.pe) - Math.max(o.ps, me.ps) > 0)
    .sort((a, b) => a.s - b.s);
  if (!row.length) return [];
  const gaps: { from: number; to: number }[] = [];
  for (let i = 0; i + 1 < row.length; i++) {
    const g = row[i + 1].s - row[i].e;
    if (g > 1e-4) gaps.push({ from: row[i].e, to: row[i + 1].s });
  }
  const out: SpacingCandidate[] = [];
  // Between two neighbours: centred so both gaps are equal.
  for (let i = 0; i + 1 < row.length; i++) {
    const room = row[i + 1].s - row[i].e - size;
    if (room > 1e-4) {
      const gap = room / 2;
      const start = row[i].e + gap;
      out.push({ start, gap, spans: [{ from: row[i].e, to: start }, { from: start + size, to: row[i + 1].s }] });
    }
  }
  // After or before any box, repeating an existing gap.
  for (const g of gaps) {
    const gap = g.to - g.from;
    const same = gaps.filter((x) => Math.abs(x.to - x.from - gap) < 1e-4);
    for (const o of row) {
      out.push({ start: o.e + gap, gap, spans: [...same, { from: o.e, to: o.e + gap }] });
      out.push({ start: o.s - gap - size, gap, spans: [...same, { from: o.s - gap, to: o.s }] });
    }
  }
  return out;
}

/**
 * Snap a moving box: per axis, the closest match within the threshold wins among (its edges or centre ↔ a target line)
 * and (an equal-spacing position). Returns the correction to add to the box's position, the guides to draw and any
 * equal-spacing hint.
 */
export function snapBox(box: Box, targets: SnapTargets, threshold: { x: number; y: number }): SnapResult {
  const guides: SnapGuide[] = [];
  const spacing: SpacingHint[] = [];
  const axisSnap = (axis: 'x' | 'y'): number => {
    const th = axis === 'x' ? threshold.x : threshold.y;
    const start = axis === 'x' ? box.x : box.y;
    const size = axis === 'x' ? box.w : box.h;
    let best: { d: number; line?: SnapLine; spacing?: SpacingCandidate } | undefined;
    for (const edge of [start, start + size / 2, start + size]) {
      for (const t of targets.lines) {
        if (t.axis !== axis) continue;
        const d = t.at - edge;
        if (Math.abs(d) <= th + 1e-12 && (!best || Math.abs(d) < Math.abs(best.d) - 1e-12)) best = { d, line: t };
      }
    }
    for (const c of spacingCandidates(box, axis, targets.boxes)) {
      const d = c.start - start;
      if (Math.abs(d) <= th + 1e-12 && (!best || Math.abs(d) < Math.abs(best.d) - 1e-12)) best = { d, spacing: c };
    }
    if (!best) return 0;
    if (best.line) guides.push({ axis, at: best.line.at, kind: best.line.kind });
    if (best.spacing) spacing.push({ axis, gap: best.spacing.gap, spans: best.spacing.spans });
    return best.d;
  };
  const dx = axisSnap('x');
  const dy = axisSnap('y');
  return { dx, dy, guides, spacing };
}
