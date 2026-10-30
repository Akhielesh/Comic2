// Reading order (Ship 2, B9; design §4.16). A page reads in a z-pattern: row by row from the top, each row from the
// start side (left, or right for right-to-left books). Panels own the page's order (Panel.n) and lines own a panel's
// order; once frames and balloons can be moved, the picture can disagree with the script. This module says where, in
// plain words, and gives the free fix as K2a ops. Pure.

import type { Box, ComicDoc, Page } from '../doc.js';
import type { DocOp } from '../ops.js';
import { buildScene, framesShown, quoteOf, type PageScene } from './scene.js';

/**
 * Indices of `boxes` in reading order. A box joins the current row when it overlaps the row's shortest member by at
 * least half the smaller height (so a tall panel and the stack beside it read tall-first, and staggered balloons read
 * higher-first); rows read from the start side.
 */
export function readingOrderOf(boxes: readonly Box[], rtl = false): number[] {
  const idx = boxes.map((_, i) => i).filter((i) => boxes[i] && Number.isFinite(boxes[i].x) && Number.isFinite(boxes[i].y));
  idx.sort((a, b) => boxes[a].y - boxes[b].y || (rtl ? boxes[b].x + boxes[b].w - (boxes[a].x + boxes[a].w) : boxes[a].x - boxes[b].x));
  const rows: number[][] = [];
  let row: number[] = [];
  let minBottom = Infinity;
  let minH = Infinity;
  for (const i of idx) {
    const b = boxes[i];
    if (row.length && minBottom - b.y > 0.5 * Math.min(b.h, minH)) {
      row.push(i);
    } else {
      if (row.length) rows.push(row);
      row = [i];
      minBottom = Infinity;
      minH = Infinity;
    }
    minBottom = Math.min(minBottom, b.y + b.h);
    minH = Math.min(minH, b.h);
  }
  if (row.length) rows.push(row);
  const start = (i: number) => (rtl ? -(boxes[i].x + boxes[i].w) : boxes[i].x);
  return rows.flatMap((r) => r.sort((a, b) => start(a) - start(b) || boxes[a].y - boxes[b].y));
}

export interface PanelOrderIssue {
  /** Panel ids in the order the frames read. */
  order: string[];
  /** The panel that now reads too early, and the one it reads before (panel numbers). */
  early: number;
  before: number;
  /** "Panel 3 now reads before panel 2". */
  text: string;
  /** The free fix: renumber the panels to match where they are. */
  fix: { label: string; ops: DocOp[] };
}

/**
 * Panels whose frames read in another order than their numbers (only where frames are the page's truth: shown in
 * frames, or planned frames on an undrawn page). Undefined when the order agrees or the page is shown as drawn.
 */
export function panelOrderIssue(doc: ComicDoc, page: Page): PanelOrderIssue | undefined {
  const shown = framesShown(doc, page);
  if (shown.mode === 'drawn' || page.panels.length < 2) return undefined;
  const order = readingOrderOf(shown.boxes, doc.format?.readingDirection === 'rtl');
  const i = order.findIndex((k, pos) => k !== pos);
  if (i < 0) return undefined;
  const early = page.panels[order[i]];
  const before = page.panels[i];
  const ids = order.map((k) => page.panels[k].id);
  return {
    order: ids,
    early: early.n,
    before: before.n,
    text: `Panel ${early.n} now reads before panel ${before.n}`,
    fix: { label: 'Renumber the panels to match', ops: [{ op: 'panels_order', pageId: page.id, order: ids }] }
  };
}

export interface LineOrderIssue {
  panelId: string;
  panelN: number;
  /** Line ids in the order their balloons read. */
  order: string[];
  /** The line read too early, and the line it is read before. */
  early: string;
  before: string;
  /** "“Run!” is read before “Stop!”" */
  text: string;
  /** The free fix: put the lines in the order they read. */
  fix: { label: string; ops: DocOp[] };
}

/** Ops that re-order a panel's lines to `want` (line_move within the panel, applied in sequence). */
export const lineOrderOps = (page: Page, panelId: string, want: readonly string[]): DocOp[] => {
  const panel = page.panels.find((p) => p.id === panelId);
  if (!panel) return [];
  const cur = panel.lines.map((l) => l.id);
  const ops: DocOp[] = [];
  want.forEach((id, k) => {
    if (cur[k] === id) return;
    const at = cur.indexOf(id);
    if (at < 0) return;
    cur.splice(at, 1);
    cur.splice(k, 0, id);
    ops.push({ op: 'line_move', pageId: page.id, id, toPanelId: panelId, index: k });
  });
  return ops;
};

/**
 * Per panel, balloons placed so they read in another order than the script's lines (only lines with a balloon on the
 * page count; software-placed ones follow the script by construction). One issue per panel, naming the first pair.
 */
export function lineOrderIssues(doc: ComicDoc, page: Page, scene: PageScene = buildScene(doc, page)): LineOrderIssue[] {
  const rtl = doc.format?.readingDirection === 'rtl';
  const byLine = new Map(scene.objects.filter((o) => o.kind === 'balloon').map((o) => [o.id, o]));
  const out: LineOrderIssue[] = [];
  for (const panel of page.panels) {
    const placed = panel.lines.filter((l) => byLine.has(l.id));
    if (placed.length < 2) continue;
    const order = readingOrderOf(placed.map((l) => byLine.get(l.id)!.box), rtl);
    const i = order.findIndex((k, pos) => k !== pos);
    if (i < 0) continue;
    const early = placed[order[i]];
    const before = placed[i];
    // The whole panel's line order with the placed lines in reading order (unplaced lines keep their slots).
    const readIds = order.map((k) => placed[k].id);
    let r = 0;
    const want = panel.lines.map((l) => (byLine.has(l.id) ? readIds[r++] : l.id));
    const two = order.length === 2;
    out.push({
      panelId: panel.id,
      panelN: panel.n,
      order: readIds,
      early: early.id,
      before: before.id,
      text: `${quoteOf(early.text)} is read before ${quoteOf(before.text)}`,
      fix: { label: two ? 'Swap the two lines' : 'Put the lines in the order they read', ops: lineOrderOps(page, panel.id, want) }
    });
  }
  return out;
}
