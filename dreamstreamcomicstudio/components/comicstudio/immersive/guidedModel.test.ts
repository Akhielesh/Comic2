// Guided View model (reader.md §5.1 tests): overview on/off, RTL row bands on measured boxes, the
// estimate fallback when the measured count doesn't match, double-tap entry, and a camera that keeps
// the frame on the page with zoom clamped to 1..4.
import { describe, expect, it } from 'vitest';
import { createEmptyDoc, type Box, type ComicDoc, type Page } from '../../../shared/comic/doc';
import type { ReaderItem } from '../reader/readerModel';
import { cameraDuration, cameraFor, guidedStops, IDENTITY_CAMERA, lerpCamera, readingOrder, spotlightRect, stopAtPoint } from './guidedModel';

const page = (over: Partial<Page> = {}): Page => ({
  id: 'pg_1',
  n: 1,
  summary: 'The chase',
  layout: 'Row 1: one wide panel. Row 2: two equal panels.',
  panels: [1, 2, 3].map((n) => ({
    id: `pn_${n}`,
    n,
    size: 'medium',
    shot: 'medium',
    action: `Action ${n}`,
    castIds: [],
    lines: n === 2 ? [{ id: 'l2a', kind: 'speech', text: 'Run!' }, { id: 'l2b', kind: 'caption', text: '  ' }] : []
  })),
  render: { status: 'ready', history: [], asset: { path: 'u/p1.webp', source: 'generated', at: 0, w: 800, h: 1200 } },
  balloons: [],
  ...over
});

const docWith = (p: Page, rtl = false): ComicDoc => {
  const d = createEmptyDoc('d1', 'T', 0);
  d.format = { ...d.format, readingDirection: rtl ? 'rtl' : 'ltr', pageAspect: '2:3' };
  d.pages = [p];
  return d;
};
const itemOf = (p: Page): ReaderItem => ({ key: p.id, kind: 'page', label: `Page ${p.n}`, asset: p.render.asset!, page: p });

describe('readingOrder', () => {
  const grid: Box[] = [
    { x: 0.05, y: 0.05, w: 0.9, h: 0.4 }, // wide top
    { x: 0.05, y: 0.5, w: 0.43, h: 0.45 }, // bottom left
    { x: 0.52, y: 0.5, w: 0.43, h: 0.45 } // bottom right
  ];
  it('rows top to bottom, left→right in LTR, right→left in RTL', () => {
    expect(readingOrder(grid, false)).toEqual([0, 1, 2]);
    expect(readingOrder(grid, true)).toEqual([0, 2, 1]);
  });

  it('a tall panel beside two stacked ones belongs to the first row', () => {
    const boxes: Box[] = [
      { x: 0.52, y: 0.03, w: 0.45, h: 0.45 }, // right top (listed first)
      { x: 0.03, y: 0.03, w: 0.45, h: 0.94 }, // tall left
      { x: 0.52, y: 0.52, w: 0.45, h: 0.45 } // right bottom
    ];
    expect(readingOrder(boxes, false)).toEqual([1, 0, 2]);
    expect(readingOrder(boxes, true)).toEqual([0, 1, 2]);
  });

  it('measured boxes that came out in a different order are re-sorted visually (row tolerance 0.08)', () => {
    const measured: Box[] = [
      { x: 0.55, y: 0.06, w: 0.4, h: 0.4 },
      { x: 0.05, y: 0.02, w: 0.4, h: 0.4 }
    ];
    expect(readingOrder(measured, false)).toEqual([1, 0]);
  });
});

describe('guidedStops', () => {
  it('overview first (when on), then panels in reading order with their spoken lines', () => {
    const p = page();
    const stops = guidedStops(docWith(p), itemOf(p), 3, { overview: true });
    expect(stops.map((s) => s.panelIndex)).toEqual([-1, 0, 1, 2]);
    expect(stops[0]).toMatchObject({ itemIndex: 3, box: { x: 0, y: 0, w: 1, h: 1 } });
    expect(stops[2].lineIds).toEqual(['l2a']);
    expect(guidedStops(docWith(p), itemOf(p), 3, { overview: false }).map((s) => s.panelIndex)).toEqual([0, 1, 2]);
  });

  it('RTL pages go right-to-left within a row (estimate already mirrored; measured boxes re-sorted)', () => {
    const p = page();
    const est = guidedStops(docWith(p, true), itemOf(p), 0, { overview: false });
    expect(est.map((s) => s.panelIndex)).toEqual([0, 1, 2]);
    expect(est[1].box.x).toBeGreaterThan(est[2].box.x); // panel 2 sits on the right in a manga
    const measured = page({
      render: {
        ...page().render,
        qc: { score: 1, issues: [], checkedAt: 1, panelBoxes: [{ x: 0.05, y: 0.05, w: 0.9, h: 0.4 }, { x: 0.05, y: 0.5, w: 0.43, h: 0.45 }, { x: 0.52, y: 0.5, w: 0.43, h: 0.45 }] }
      }
    });
    expect(guidedStops(docWith(measured, true), itemOf(measured), 0, { overview: false }).map((s) => s.panelIndex)).toEqual([0, 2, 1]);
  });

  it('uses measured boxes when the count matches, the blueprint estimate otherwise', () => {
    const measured: Box[] = [
      { x: 0.5, y: 0.5, w: 0.4, h: 0.4 },
      { x: 0.05, y: 0.05, w: 0.4, h: 0.4 },
      { x: 0.55, y: 0.05, w: 0.4, h: 0.4 }
    ];
    const ok = page({ render: { ...page().render, qc: { score: 1, issues: [], checkedAt: 1, panelBoxes: measured } } });
    expect(guidedStops(docWith(ok), itemOf(ok), 0, { overview: false }).map((s) => s.panelIndex)).toEqual([1, 2, 0]);
    const mismatch = page({ render: { ...page().render, qc: { score: 1, issues: [], checkedAt: 1, panelBoxes: measured.slice(0, 2) } } });
    // Estimate from the blueprint: wide top, then two below.
    expect(guidedStops(docWith(mismatch), itemOf(mismatch), 0, { overview: false }).map((s) => s.panelIndex)).toEqual([0, 1, 2]);
  });

  it('the cover (or a page without panels) is one whole-page stop', () => {
    const cover: ReaderItem = { key: 'cover', kind: 'cover', label: 'Cover', asset: { path: 'u/c.webp', source: 'generated', at: 0 } };
    expect(guidedStops(docWith(page()), cover, 0, { overview: true })).toHaveLength(1);
    const empty = page({ panels: [] });
    expect(guidedStops(docWith(empty), itemOf(empty), 0, { overview: false })).toHaveLength(1);
  });

  it('double-tap picks the panel under the finger', () => {
    const p = page();
    const stops = guidedStops(docWith(p), itemOf(p), 0, { overview: true });
    expect(stops[stopAtPoint(stops, { x: 0.8, y: 0.8 })].panelIndex).toBe(2);
    expect(stops[stopAtPoint(stops, { x: 0.5, y: 0.2 })].panelIndex).toBe(0);
    // A gutter tap picks the nearest panel, never the overview.
    expect(stops[stopAtPoint(stops, { x: 0.5, y: 0.985 })].panelIndex).toBeGreaterThanOrEqual(1);
  });
});

describe('cameraFor', () => {
  const pageRect = { x: 100, y: 20, w: 400, h: 600 };
  it('frames a panel inside the viewport with the zoom clamped to 1..4', () => {
    const cam = cameraFor({ box: { x: 0.05, y: 0.5, w: 0.43, h: 0.45 } }, pageRect, 600, 640);
    expect(cam.s).toBeGreaterThan(1);
    expect(cam.s).toBeLessThanOrEqual(4);
    // The framed rect fills the viewport exactly.
    expect(cam.rect.w * cam.s).toBeCloseTo(600, 6);
    expect(cam.rect.h * cam.s).toBeCloseTo(640, 6);
    // The panel is inside the viewport.
    const spot = spotlightRect({ x: 0.05, y: 0.5, w: 0.43, h: 0.45 }, pageRect, cam);
    expect(spot.x).toBeGreaterThanOrEqual(-1e-6);
    expect(spot.y).toBeGreaterThanOrEqual(-1e-6);
    expect(spot.x + spot.w).toBeLessThanOrEqual(600 + 1e-6);
    expect(spot.y + spot.h).toBeLessThanOrEqual(640 + 1e-6);
  });

  it('a tiny panel stops at 4× and the whole page never zooms below 1×', () => {
    expect(cameraFor({ box: { x: 0.4, y: 0.4, w: 0.02, h: 0.02 } }, pageRect, 600, 640).s).toBe(4);
    const whole = cameraFor({ box: { x: 0, y: 0, w: 1, h: 1 } }, pageRect, 600, 640);
    expect(whole.s).toBe(1);
  });

  it('keeps the frame on the page when it fits (no empty margins)', () => {
    const cam = cameraFor({ box: { x: 0, y: 0, w: 0.3, h: 0.2 } }, pageRect, 600, 640);
    expect(cam.rect.x).toBeGreaterThanOrEqual(pageRect.x - 1e-6);
    expect(cam.rect.y).toBeGreaterThanOrEqual(pageRect.y - 1e-6);
  });

  it('durations grow with distance and zoom, 420–900 ms; lerp ends exactly on the target', () => {
    const a = IDENTITY_CAMERA(600, 640);
    const b = cameraFor({ box: { x: 0.6, y: 0.6, w: 0.3, h: 0.3 } }, pageRect, 600, 640);
    const d = cameraDuration(a, b, 600, 640);
    expect(d).toBeGreaterThanOrEqual(420);
    expect(d).toBeLessThanOrEqual(900);
    expect(cameraDuration(a, a, 600, 640)).toBe(420);
    const end = lerpCamera(a, b, 1);
    expect(end.s).toBeCloseTo(b.s, 9);
    expect(end.tx).toBeCloseTo(b.tx, 6);
  });
});
