import { describe, expect, it } from 'vitest';
import type { Panel } from '../../../shared/comic/doc';
import {
  MIN_REGION,
  estimatePanelBoxes,
  layoutPanelCount,
  panelAtPoint,
  panelBoxesFor,
  panelForRegion,
  parseLayout,
  regionFromPoints,
  synthesizeLayout,
  toPagePoint
} from './pageLayout';
import { makeSampleDoc } from './__fixtures__/sampleDoc';

const panels = (sizes: Panel['size'][]) => sizes.map((size) => ({ size }));

describe('parseLayout', () => {
  it('reads row blueprints', () => {
    const p = parseLayout('Row 1: one wide panel (panel 1). Row 2: two equal panels side by side (panels 2–3).')!;
    expect(p.mode).toBe('rows');
    expect(p.rows.map((r) => r.panels)).toEqual([[0], [1, 2]]);
  });

  it('reads a tall panel beside a stack', () => {
    const p = parseLayout('Rows 1–2: one tall panel on the left (panel 1) beside two stacked panels on the right (panels 2–3). Row 3: one wide panel (panel 4).')!;
    expect(layoutPanelCount(p)).toBe(4);
    expect(p.rows[0].span).toEqual({ tallSide: 'left', stacked: 2 });
  });

  it('reads vertical stacks and splashes', () => {
    expect(parseLayout('Stacked vertically: 4 full-width panels (panels 1–4), top to bottom. Panel 2 is extra tall.')!.rows[1].weight).toBe(1.6);
    expect(parseLayout('One full-page splash panel (panel 1).')!.mode).toBe('single');
  });

  it('gives up on prose it cannot count', () => {
    expect(parseLayout('Something dramatic happens')).toBeNull();
    expect(parseLayout('')).toBeNull();
  });
});

describe('synthesizeLayout', () => {
  it('builds a blueprint from sizes that parses back to the same count', () => {
    const text = synthesizeLayout(panels(['splash', 'small', 'medium', 'tall', 'small', 'wide']), { kind: 'comic', readingDirection: 'ltr' });
    expect(layoutPanelCount(parseLayout(text))).toBe(6);
  });

  it('stacks webtoon panels', () => {
    expect(synthesizeLayout(panels(['medium', 'tall']), { kind: 'webtoon', readingDirection: 'ltr' })).toMatch(/^Stacked vertically: 2/);
  });
});

describe('estimatePanelBoxes', () => {
  it('lays panels out inside the page margins without overlap', () => {
    const doc = makeSampleDoc();
    const boxes = estimatePanelBoxes(doc.pages[0]);
    expect(boxes).toHaveLength(3);
    boxes.forEach((b) => {
      expect(b.x).toBeGreaterThanOrEqual(0.02 - 1e-9);
      expect(b.y).toBeGreaterThanOrEqual(0.02 - 1e-9);
      expect(b.x + b.w).toBeLessThanOrEqual(0.98 + 1e-6);
      expect(b.y + b.h).toBeLessThanOrEqual(0.98 + 1e-6);
    });
    expect(boxes[0].w).toBeCloseTo(0.96, 4);
    expect(boxes[1].x).toBeLessThan(boxes[2].x);
    expect(boxes[1].y).toBeCloseTo(boxes[2].y, 6);
  });

  it('mirrors columns for right-to-left reading', () => {
    const doc = makeSampleDoc();
    const boxes = estimatePanelBoxes(doc.pages[0], { readingDirection: 'rtl' });
    expect(boxes[1].x).toBeGreaterThan(boxes[2].x);
  });

  it('falls back to a grid when the blueprint disagrees with the panel count', () => {
    const doc = makeSampleDoc();
    const page = { ...doc.pages[0], layout: 'Row 1: one wide panel.' };
    expect(estimatePanelBoxes(page)).toHaveLength(3);
  });

  it('prefers measured QC boxes when they match the panel count', () => {
    const doc = makeSampleDoc();
    const measured = [
      { x: 0, y: 0, w: 1, h: 0.3 },
      { x: 0, y: 0.3, w: 0.5, h: 0.7 },
      { x: 0.5, y: 0.3, w: 0.5, h: 0.7 }
    ];
    const page = { ...doc.pages[0], render: { ...doc.pages[0].render, qc: { score: 1, issues: [], checkedAt: 0, panelBoxes: measured } } };
    expect(panelBoxesFor(doc, page)).toBe(measured);
    const wrongCount = { ...page, render: { ...page.render, qc: { score: 1, issues: [], checkedAt: 0, panelBoxes: measured.slice(0, 2) } } };
    expect(panelBoxesFor(doc, wrongCount)).not.toBe(measured);
  });
});

describe('mark-up regions', () => {
  it('normalizes a drag in any direction', () => {
    expect(regionFromPoints({ x: 0.6, y: 0.8 }, { x: 0.2, y: 0.5 })).toEqual({ x: 0.2, y: 0.5, w: 0.4, h: 0.3 });
  });

  it('clamps to the page', () => {
    expect(regionFromPoints({ x: -0.2, y: 0.9 }, { x: 0.3, y: 1.4 })).toEqual({ x: 0, y: 0.9, w: 0.3, h: 0.1 });
  });

  it('ignores clicks that are not drags', () => {
    expect(regionFromPoints({ x: 0.5, y: 0.5 }, { x: 0.5 + MIN_REGION / 2, y: 0.7 })).toBeNull();
  });

  it('maps client coordinates into the page', () => {
    const rect = { left: 100, top: 50, width: 400, height: 600 };
    expect(toPagePoint(140, 350, rect)).toEqual({ x: 0.1, y: 0.5 });
    expect(toPagePoint(0, 9999, rect)).toEqual({ x: 0, y: 1 });
  });

  it('names the panel covering most of the region', () => {
    const doc = makeSampleDoc();
    const boxes = estimatePanelBoxes(doc.pages[0]);
    expect(panelForRegion({ x: 0.1, y: 0.5, w: 0.4, h: 0.3 }, boxes)).toBe(2);
    expect(panelForRegion({ x: 0.45, y: 0.6, w: 0.5, h: 0.2 }, boxes)).toBe(3);
    expect(panelForRegion({ x: 0.1, y: 0.1, w: 0.2, h: 0.2 }, boxes)).toBe(1);
    expect(panelForRegion({ x: 0, y: 0, w: 0.01, h: 0.01 }, boxes)).toBeUndefined();
    expect(panelAtPoint({ x: 0.75, y: 0.75 }, boxes)).toBe(3);
    expect(panelAtPoint({ x: 0.5, y: 0.75 }, boxes)).toBeUndefined();
  });
});
