// The arrow fix's overlay nudge (graft 4; PE-SHELL): a selected overlay moves one engine step per arrow press (Shift: a
// big step). LAZY: the page editor loads it the first time an overlay is selected, so the B9 transform engine
// (transform.ts → scene.ts) stays out of the page editor's first load (master plan §2.8).

import type { ComicDoc, Page } from '../../../shared/comic/doc';
import type { DocOp } from '../../../shared/comic/ops';
import { NUDGE, moveEdit } from '../../../shared/comic/editor/transform';

/**
 * The ops (and the undo label) that move the selected overlays by one nudge in (dx, dy) — unit steps, −1 / 0 / 1. A
 * locked or missing overlay is skipped; nothing to move → no ops. Pure.
 */
export const overlayNudgeOps = (doc: ComicDoc, page: Page, layerIds: readonly string[], dx: number, dy: number, big = false): { ops: DocOp[]; label: string } => {
  const step = big ? NUDGE.big : NUDGE.step;
  const ops: DocOp[] = [];
  let label = '';
  for (const id of layerIds) {
    const r = moveEdit(doc, page, { kind: 'overlay', id }, dx * step, dy * step);
    if (r.ok) {
      ops.push(...r.ops);
      label = label ? 'Move overlays' : r.label;
    }
  }
  return { ops, label };
};
