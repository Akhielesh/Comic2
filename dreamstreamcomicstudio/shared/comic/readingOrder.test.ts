// AV-0 (av.md V9): the visual reading order lives in shared/ (shared never imports components/), and the reader's
// Guided View re-exports the very same function, so the reader, the motion-comic export and Video mode read panels
// in one order.
import { describe, expect, it } from 'vitest';
import * as guided from '../../components/comicstudio/immersive/guidedModel';
import type { Box } from './doc';
import { panelReadingOrder, READING_ROW_TOLERANCE, readingOrder } from './readingOrder';

const grid: Box[] = [
  { x: 0.05, y: 0.05, w: 0.9, h: 0.4 }, // wide top
  { x: 0.05, y: 0.5, w: 0.43, h: 0.45 }, // bottom left
  { x: 0.52, y: 0.5, w: 0.43, h: 0.45 } // bottom right
];

describe('readingOrder (shared)', () => {
  it('reads row bands from the top, left→right for LTR and right→left for RTL', () => {
    expect(readingOrder(grid, false)).toEqual([0, 1, 2]);
    expect(readingOrder(grid, true)).toEqual([0, 2, 1]);
  });

  it('follows the drawing, not the written order, and joins tops within the row tolerance', () => {
    const drawn: Box[] = [
      { x: 0.04, y: 0.52, w: 0.92, h: 0.44 },
      { x: 0.04, y: 0.04, w: 0.44, h: 0.44 },
      { x: 0.52, y: 0.04 + READING_ROW_TOLERANCE * 0.9, w: 0.44, h: 0.4 }
    ];
    expect(readingOrder(drawn, false)).toEqual([1, 2, 0]);
    expect(readingOrder(drawn, true)).toEqual([2, 1, 0]);
  });

  it('is the function Guided View uses (re-exported under its old names)', () => {
    expect(guided.readingOrder).toBe(readingOrder);
    expect(guided.ROW_TOLERANCE).toBe(READING_ROW_TOLERANCE);
  });
});

describe('panelReadingOrder', () => {
  it('returns every panel once: boxed panels in reading order, then the rest in written order', () => {
    const boxes: Box[] = [
      { x: 0.04, y: 0.04, w: 0.44, h: 0.9 },
      { x: 0.52, y: 0.04, w: 0, h: 0.4 }, // degenerate
      { x: 0.52, y: 0.04, w: 0.44, h: 0.44 }
    ];
    expect(panelReadingOrder(boxes, 3, true)).toEqual([2, 0, 1]);
    expect(panelReadingOrder(boxes, 3, false)).toEqual([0, 2, 1]);
    // Fewer boxes than panels, or more: the panel count decides.
    expect(panelReadingOrder(grid.slice(0, 2), 4, false)).toEqual([0, 1, 2, 3]);
    expect(panelReadingOrder(grid, 2, true)).toEqual([0, 1]);
    expect(panelReadingOrder([], 0, false)).toEqual([]);
  });
});
