// Page space ↔ image space (Ship 2, K2a). Synthetic fixtures only.
import { describe, expect, it } from 'vitest';
import { createEmptyDoc, normalizeDoc, type Box, type ComicDoc, type Page } from '../doc';
import { applyOps } from '../ops';
import { letteringAspect } from '../lettering/layout';
import { makeSampleDoc } from '../../../components/comicstudio/board/__fixtures__/sampleDoc';
import { historyV4Doc, historyV5Doc } from '../history/__fixtures__/books';
import { assetSizeOf, composeAspect, frameAffine, pageBoxToImage, pageSpaceQc, panelPointMap, upscaleOf, visibleSource } from './space';

const bx = (x: number, y: number, w: number, h: number): Box => ({ x, y, w, h });
const RASTER = 'u/user-s/p/proj-s/img/p1.webp';
const TAKE = 'u/user-s/p/proj-s/img/p1-take.webp';

/** One 2:3 page (1000×1500 drawing), two panels stacked, shown in frames. */
const doc = (frames: Box[] = [bx(0.02, 0.02, 0.96, 0.47), bx(0.02, 0.51, 0.96, 0.47)], cuts: Box[] = frames): ComicDoc => {
  const page: Page = {
    id: 'pg_s',
    n: 1,
    summary: '',
    layout: 'Row 1: one wide panel (panel 1). Row 2: one wide panel (panel 2).',
    artMode: 'panels',
    panels: frames.map((box, i) => ({ id: `ps_${i + 1}`, n: i + 1, size: 'wide', shot: 'medium', action: '', castIds: [], lines: [], frame: { box } })),
    render: {
      status: 'ready',
      history: [{ path: TAKE, source: 'generated', at: 1, w: 500, h: 500 }],
      asset: { path: RASTER, source: 'generated', at: 2, w: 1000, h: 1500 },
      cuts: { status: 'ok', by: 'detect', at: 3, cuts: cuts.map((box, i) => ({ panelId: `ps_${i + 1}`, drawn: i + 1, box, conf: 1 })) }
    },
    balloons: []
  };
  return normalizeDoc({ ...createEmptyDoc('proj-s', 'Space', 1), pages: [page] });
};

describe('visibleSource (cover, zoom, pan)', () => {
  it('a square cut in a wide frame keeps its full width and is cropped to the frame shape, centred', () => {
    // Book 2:3; the frame is the full width and a quarter of the height → 8:3 physically.
    const s = visibleSource(bx(0, 0, 1, 1), 1, bx(0, 0, 1, 0.25), 2 / 3);
    expect(s.w).toBeCloseTo(1, 10);
    expect(s.h).toBeCloseTo(0.375, 10);
    expect(s.y).toBeCloseTo(0.3125, 10);
  });

  it('zoom shrinks the source around its centre; pan −1 / +1 reaches the edges', () => {
    const zoomed = visibleSource(bx(0, 0, 1, 1), 1, bx(0, 0, 1, 0.25), 2 / 3, { s: 2, x: 0, y: 0 });
    expect(zoomed.w).toBeCloseTo(0.5, 10);
    expect(zoomed.x).toBeCloseTo(0.25, 10);
    expect(visibleSource(bx(0, 0, 1, 1), 1, bx(0, 0, 1, 0.25), 2 / 3, { s: 2, x: -1, y: 0 }).x).toBeCloseTo(0, 10);
    const right = visibleSource(bx(0, 0, 1, 1), 1, bx(0, 0, 1, 0.25), 2 / 3, { s: 2, x: 1, y: 1 });
    expect(right.x + right.w).toBeCloseTo(1, 10);
    expect(right.y + right.h).toBeCloseTo(1, 10);
  });

  it('an unknown source aspect shows the cut whole', () => {
    expect(visibleSource(bx(0.1, 0.2, 0.3, 0.4), undefined, bx(0, 0, 1, 1), 2 / 3)).toEqual(bx(0.1, 0.2, 0.3, 0.4));
  });
});

describe('frameAffine (both ways)', () => {
  it('maps page ↔ image and back for points and boxes', () => {
    const d = applyOps(doc(), [{ op: 'page_frames', pageId: 'pg_s', frames: [{ panelId: 'ps_1', frame: { box: bx(0.1, 0.05, 0.5, 0.3), fit: { s: 1.5, x: 0.3, y: -0.2 } } }], moveBalloons: false }]);
    const aff = frameAffine(d, d.pages[0], 'ps_1')!;
    expect(aff.raster).toBe(true);
    expect(aff.path).toBe(RASTER);
    for (const p of [{ x: 0.1, y: 0.05 }, { x: 0.33, y: 0.2 }, { x: 0.6, y: 0.35 }]) {
      const back = aff.toPage(aff.toImage(p));
      expect(back.x).toBeCloseTo(p.x, 10);
      expect(back.y).toBeCloseTo(p.y, 10);
    }
    const box = bx(0.2, 0.1, 0.1, 0.1);
    const round = aff.boxToPage(aff.boxToImage(box));
    for (const k of ['x', 'y', 'w', 'h'] as const) expect(round[k]).toBeCloseTo(box[k], 10);
    // The frame's corners are the visible source's corners.
    expect(aff.toImage({ x: aff.dst.x, y: aff.dst.y }).x).toBeCloseTo(aff.src.x, 10);
  });

  it('a frame showing another picture uses that picture (size from the doc); an empty frame maps nothing', () => {
    const d = applyOps(doc(), [{ op: 'page_frames', pageId: 'pg_s', frames: [{ panelId: 'ps_2', frame: { box: bx(0.02, 0.51, 0.96, 0.47), src: { path: TAKE } } }], moveBalloons: false }]);
    const aff = frameAffine(d, d.pages[0], 'ps_2')!;
    expect(aff).toMatchObject({ raster: false, path: TAKE, srcPx: 500 });
    expect(assetSizeOf(d, TAKE)).toEqual({ w: 500, h: 500 });
    const empty = applyOps(d, [{ op: 'panel_add', pageId: 'pg_s', panel: { id: 'ps_e', n: 0, size: 'small', shot: 'insert', action: '', castIds: [], lines: [], frame: { box: bx(0.4, 0.4, 0.2, 0.2) } } }]);
    expect(frameAffine(empty, empty.pages[0], 'ps_e')).toBeNull();
  });
});

describe('page-space helpers', () => {
  it('composeAspect equals the old letteringAspect for every page shown as drawn', () => {
    for (const raw of [makeSampleDoc(), historyV4Doc(), historyV5Doc()]) {
      const d = normalizeDoc(raw);
      for (const p of d.pages) {
        const a = p.render.asset;
        const old = a?.w && a?.h ? a.w / a.h : (([w, h]) => (w > 0 && h > 0 ? w / h : 2 / 3))(String(d.format.pageAspect).split(':').map(Number));
        expect(composeAspect(d, p)).toBe(old);
        expect(letteringAspect(d, p)).toBe(old);
      }
    }
  });

  it('pageBoxToImage: identity as drawn; inside the frame it mostly covers in panels mode; null in a gutter', () => {
    const d = doc();
    const asDrawn = { ...d.pages[0], artMode: undefined };
    expect(pageBoxToImage(d, asDrawn, bx(0.1, 0.1, 0.2, 0.2))).toEqual({ path: RASTER, box: bx(0.1, 0.1, 0.2, 0.2) });
    const moved = applyOps(d, [{ op: 'page_frames', pageId: 'pg_s', frames: [{ panelId: 'ps_2', frame: { box: bx(0.02, 0.51, 0.47, 0.47) } }], moveBalloons: false }]);
    const region = pageBoxToImage(moved, moved.pages[0], bx(0.05, 0.6, 0.3, 0.3))!;
    expect(region.panelId).toBe('ps_2');
    expect(region.path).toBe(RASTER);
    const aff = frameAffine(moved, moved.pages[0], 'ps_2')!;
    expect(region.box.x).toBeGreaterThanOrEqual(aff.src.x - 1e-4);
    expect(region.box.x + region.box.w).toBeLessThanOrEqual(aff.src.x + aff.src.w + 1e-4);
    expect(pageBoxToImage(moved, moved.pages[0], bx(0.6, 0.6, 0.3, 0.3))).toBeNull(); // only paper there
  });

  it('upscaleOf: 1× for a cut shown at its own size, 2× zoomed in, a small take enlarged', () => {
    const d = doc();
    expect(upscaleOf(d, d.pages[0], 'ps_1')).toBe(1);
    const zoomed = applyOps(d, [{ op: 'page_frames', pageId: 'pg_s', frames: [{ panelId: 'ps_1', frame: { box: bx(0.02, 0.02, 0.96, 0.47), fit: { s: 2, x: 0, y: 0 } } }], moveBalloons: false }]);
    expect(upscaleOf(zoomed, zoomed.pages[0], 'ps_1')).toBe(2);
    const take = applyOps(d, [{ op: 'page_frames', pageId: 'pg_s', frames: [{ panelId: 'ps_2', frame: { box: bx(0.02, 0.51, 0.96, 0.47), src: { path: TAKE } } }], moveBalloons: false }]);
    // The 500 px take fills a frame 0.96 of a 1000 px page wide: about 1.92×.
    expect(upscaleOf(take, take.pages[0], 'ps_2')).toBe(1.92);
    expect(upscaleOf(d, d.pages[0], 'ghost')).toBeUndefined();
  });

  it('pageSpaceQc and panelPointMap change nothing on a page shown as drawn', () => {
    const d = doc();
    const asDrawn = { ...d.pages[0], artMode: undefined, render: { ...d.pages[0].render, qc: { score: 1, issues: [], checkedAt: 1, keepOut: [] } } };
    expect(pageSpaceQc(d, asDrawn)).toBe(asDrawn.render.qc);
    expect(panelPointMap(d, asDrawn, d, asDrawn, 'ps_1')).toBeNull();
    expect(panelPointMap(d, d.pages[0], d, d.pages[0], 'ps_1')).toBeNull(); // same frame both sides
  });
});
