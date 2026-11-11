// Visual reading order of a page's panels (reader.md §5; av.md AV-0, V9). Pure: no DOM, no clock, no I/O.
//
// One rule for every surface that walks panels one by one: the reader's Guided View and transcript
// (components/comicstudio/immersive/guidedModel.ts re-exports it under its old names), the motion-comic video
// export, and Video mode's shot list later. Panels read in row bands from the top; within a row left→right, or
// right→left for a right-to-left (manga) book. Geometry wins over the script order, which also corrects a drawing
// whose panels came out in another arrangement than planned. shared/ never imports components/, so this lives here.

import type { Box } from './doc.js';

/** Row-band tolerance as a fraction of the page height (two panels whose tops are this close share a row). */
export const READING_ROW_TOLERANCE = 0.08;

/**
 * Visual reading order of panel boxes: rows by their top edge (a tall panel beside two stacked ones belongs to the
 * first row), left→right within a row for LTR, right→left for RTL. Boxes with no area are left out.
 */
export const readingOrder = (boxes: Box[], rtl: boolean): number[] => {
  const idx = boxes.map((_, i) => i).filter((i) => boxes[i] && boxes[i].w > 0 && boxes[i].h > 0);
  idx.sort((a, b) => boxes[a].y - boxes[b].y || boxes[a].x - boxes[b].x);
  const rows: number[][] = [];
  for (const i of idx) {
    const row = rows[rows.length - 1];
    if (row && Math.abs(boxes[i].y - boxes[row[0]].y) <= READING_ROW_TOLERANCE) row.push(i);
    else rows.push([i]);
  }
  return rows.flatMap((row) => row.sort((a, b) => (rtl ? boxes[b].x + boxes[b].w - (boxes[a].x + boxes[a].w) : boxes[a].x - boxes[b].x)));
};

/**
 * Every panel index of a page (0..panelCount−1) exactly once: the panels with a usable box in visual reading order,
 * then any panel without one (malformed or missing geometry) in its written order, so nothing is ever dropped.
 */
export const panelReadingOrder = (boxes: Box[], panelCount: number, rtl: boolean): number[] => {
  const order = readingOrder(boxes.slice(0, Math.max(0, panelCount)), rtl);
  const seen = new Set(order);
  for (let i = 0; i < panelCount; i += 1) if (!seen.has(i)) order.push(i);
  return order;
};
