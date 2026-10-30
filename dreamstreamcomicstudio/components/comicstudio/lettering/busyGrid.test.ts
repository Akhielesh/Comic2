// The free busy-area grid (FX3b): detail cells from pixels, and "Place around the art" keeping balloons off them.
// Synthetic pixels and pages only.

import { describe, expect, it } from 'vitest';
import { busyCellsFromPixels, hasFaceData, reletterAroundArtOps } from './busyGrid';
import { createEmptyDoc, emptyRender, type Box, type ComicDoc, type Page } from '../../../shared/comic/doc';
import { estimateMeasure, letteringAspect, letteringSizer } from '../../../shared/comic/lettering/layout';

/** RGBA pixels: `fill(x, y)` gives a grey level. */
const pixels = (w: number, h: number, fill: (x: number, y: number) => number): Uint8ClampedArray => {
  const out = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y += 1)
    for (let x = 0; x < w; x += 1) {
      const v = fill(x, y);
      const i = (y * w + x) * 4;
      out[i] = v;
      out[i + 1] = v;
      out[i + 2] = v;
      out[i + 3] = 255;
    }
  return out;
};
const area = (b: Box) => b.w * b.h;
const inter = (a: Box, b: Box) => Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)) * Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));

describe('busyCellsFromPixels', () => {
  it('a flat page has no busy cells', () => {
    expect(busyCellsFromPixels(pixels(96, 144, () => 200), 96, 144)).toEqual([]);
  });

  it('finds the detailed part of the page (a checkerboard in the top-left quarter) and nothing else', () => {
    const w = 96;
    const h = 144;
    const cells = busyCellsFromPixels(pixels(w, h, (x, y) => (x < w / 2 && y < h / 2 ? ((x + y) % 2 ? 30 : 230) : 180)), w, h);
    expect(cells.length).toBeGreaterThan(0);
    const quarter: Box = { x: 0, y: 0, w: 0.5, h: 0.5 };
    const total = cells.reduce((n, c) => n + area(c), 0);
    const inside = cells.reduce((n, c) => n + inter(c, quarter), 0);
    expect(inside / total).toBeGreaterThan(0.95);
    // Row runs are merged: one box per busy run, every box on the page.
    for (const c of cells) {
      expect(c.x).toBeGreaterThanOrEqual(0);
      expect(c.y).toBeGreaterThanOrEqual(0);
      expect(c.x + c.w).toBeLessThanOrEqual(1 + 1e-9);
      expect(c.y + c.h).toBeLessThanOrEqual(1 + 1e-9);
    }
  });

  it('only the busiest cells count (the quantile), and bad input gives nothing', () => {
    // A left-to-right ramp of detail: the busy cells are the right-hand ones.
    const w = 120;
    const h = 120;
    const cells = busyCellsFromPixels(pixels(w, h, (x, y) => ((x + y) % 2 ? 128 + x : 128 - x)), w, h, { quantile: 0.75 });
    expect(Math.min(...cells.map((c) => c.x))).toBeGreaterThanOrEqual(0.7);
    expect(busyCellsFromPixels(new Uint8ClampedArray(10), 96, 144)).toEqual([]);
    expect(busyCellsFromPixels(pixels(1, 1, () => 0), 1, 1)).toEqual([]);
  });
});

describe('Place around the art (free)', () => {
  const pageWith = (): { doc: ComicDoc; page: Page } => {
    const doc = createEmptyDoc('doc_busy', 'Busy', 1);
    doc.format.pageAspect = '2:3';
    doc.cast = [{ id: 'c_a', name: 'Asha', tier: 'lead', look: { summary: 'x' }, refs: [], sheet: emptyRender() }];
    const page: Page = {
      id: 'pg_1',
      n: 1,
      summary: '',
      layout: 'Row 1: one wide panel.',
      panels: [{ id: 'pn_1', n: 1, size: 'wide', shot: 'wide', action: 'a', castIds: ['c_a'], lines: [{ id: 'l1', kind: 'speech', speakerId: 'c_a', text: 'The lights went out across the whole market at once.' }, { id: 'l2', kind: 'speech', speakerId: 'c_a', text: 'Stay close.' }] }],
      render: { ...emptyRender(), status: 'ready', asset: { path: 'u/doc_busy/p1.png', w: 1000, h: 1500, source: 'generated', at: 1790000000000 }, qc: { score: 0.9, issues: [], checkedAt: 1790000000000 } },
      // Both stored in the top-left corner (where face-blind placement used to put them); l2 pinned by the owner.
      balloons: [
        { lineId: 'l1', x: 0.05, y: 0.04, w: 0.3 },
        { lineId: 'l2', x: 0.6, y: 0.85, w: 0.2, pinned: true }
      ]
    };
    doc.pages = [page];
    return { doc, page };
  };
  // The art is busy across the whole top half (a crowd, a face): calm below.
  const busy: Box[] = [{ x: 0, y: 0, w: 1, h: 0.5 }];

  it('moves unpinned balloons off the busy areas; pinned ones stay exactly where they are', () => {
    const { doc, page } = pageWith();
    const aspect = letteringAspect(doc, page);
    const ops = reletterAroundArtOps(doc, page, aspect, estimateMeasure, busy);
    expect(ops).toHaveLength(1);
    const op = ops[0] as Extract<(typeof ops)[number], { op: 'balloons' }>;
    expect(op.op).toBe('balloons');
    const l1 = op.balloons.find((b) => b.lineId === 'l1')!;
    const l2 = op.balloons.find((b) => b.lineId === 'l2')!;
    expect(l2).toEqual(page.balloons[1]);
    const sizer = letteringSizer(doc, page, aspect, estimateMeasure);
    const s = sizer(page.panels[0].lines[0], l1.w);
    const outline = { x: l1.x + s.bounds.x, y: l1.y + s.bounds.y, w: s.bounds.w, h: s.bounds.h };
    const onBusy = inter(outline, busy[0]) / area(outline);
    expect(onBusy).toBeLessThan(0.05);
    // Without the grid the same placement keeps it up in the busy half.
    const blind = reletterAroundArtOps(doc, page, aspect, estimateMeasure, []);
    const b1 = (blind[0] as typeof op | undefined)?.balloons.find((b) => b.lineId === 'l1') ?? page.balloons[0];
    const sb = sizer(page.panels[0].lines[0], b1.w);
    expect(inter({ x: b1.x + sb.bounds.x, y: b1.y + sb.bounds.y, w: sb.bounds.w, h: sb.bounds.h }, busy[0])).toBeGreaterThan(0);
  });

  it('nothing to move gives no op (no empty undo entry)', () => {
    const { doc, page } = pageWith();
    const aspect = letteringAspect(doc, page);
    const [op] = reletterAroundArtOps(doc, page, aspect, estimateMeasure, busy) as { op: 'balloons'; balloons: Page['balloons'] }[];
    const settled = { ...page, balloons: op.balloons };
    expect(reletterAroundArtOps(doc, settled, aspect, estimateMeasure, busy)).toEqual([]);
  });

  it('a page whose check measured faces already has face data (the free placement avoids them)', () => {
    const { page } = pageWith();
    expect(hasFaceData(page)).toBe(false);
    page.render.qc = { ...page.render.qc!, keepOut: [{ panel: 1, kind: 'face', box: { x: 0.4, y: 0.2, w: 0.1, h: 0.08 } }] };
    expect(hasFaceData(page)).toBe(true);
  });
});
