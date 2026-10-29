// The owner's rule for every page: no overlapping balloons, nothing off the page (visualqa P0-3,
// allowlist `stress-balloons-overlap` / `heist-p9-balloons-overlap`). Measured the way the device harness
// measures it (tests/e2e/helpers/layoutAsserts.ts balloon-*): the box of the drawn group — outline AND
// tail — of every balloon on every drawn page of the QA fixtures, with the registry estimates and with a
// deliberately wider measure (real fonts never match the estimates exactly).
//
// Without the engine's tail-aware footprints, page spill, render-time settle and dense-page repack, the
// stress fixture alone had 16 overlapping pairs (pg_1 p3_l2 × p3_l3 at 90 %, pg_11 p4_l1 × p4_l2 at
// 100 %, …) and heist-12p page 9 had p4_l2's tail across p5_l1 (88 %).

import { describe, expect, it } from 'vitest';
import { makeQaDoc } from '../../../components/comicstudio/testing/qaFixtures';
import type { Box, ComicDoc, Page } from '../doc';
import { DENSITY_STEPS, estimateMeasure, letteringAspect, planLettering, type LetterPlan, type Measure } from './layout';
import { balloonFootprint } from './place';

/** Real fonts run wider than the estimates: 1.2× the registry numbers. */
const wideMeasure: Measure = (text, font) => estimateMeasure(text, font) * 1.2;

const drawnPages = (doc: ComicDoc): Page[] => doc.pages.filter((p) => p.render.status === 'ready' || p.render.status === 'stale');

/** The drawn group's box (outline + tail tip), plan units. */
const groupBox = (p: LetterPlan): Box => balloonFootprint({ x: p.x + p.geometry.bounds.x, y: p.y + p.geometry.bounds.y, w: p.geometry.bounds.w, h: p.geometry.bounds.h }, p.tip);

const overlapFraction = (a: Box, b: Box): number => {
  const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  if (w <= 0 || h <= 0) return 0;
  return (w * h) / Math.min(a.w * a.h, b.w * b.h);
};

const check = (doc: ComicDoc, measure: Measure) => {
  const pages = drawnPages(doc);
  expect(pages.length).toBeGreaterThan(0);
  for (const page of pages) {
    const aspect = letteringAspect(doc, page);
    const H = 1000 / aspect;
    const plans = planLettering(doc, page, aspect, measure);
    const lineIds = page.panels.flatMap((p) => p.lines.filter((l) => l.text.trim()).map((l) => l.id));
    // One plan per lettered line, in reading order.
    expect(plans.map((p) => p.lineId).sort()).toEqual([...lineIds].sort());
    const boxes = plans.map((p) => ({ id: p.lineId, box: groupBox(p), linked: p.linkTo }));
    for (const { id, box } of boxes) {
      // In bounds: the harness allows 2 px on a 143 px page (1.4 %); the engine keeps every outline 0.8 %
      // inside and clamps tails to the page edge.
      expect(box.x, `${page.id} ${id} left`).toBeGreaterThanOrEqual(-0.01);
      expect(box.y, `${page.id} ${id} top`).toBeGreaterThanOrEqual(-0.01);
      expect(box.x + box.w, `${page.id} ${id} right`).toBeLessThanOrEqual(1000.01);
      expect(box.y + box.h, `${page.id} ${id} bottom`).toBeLessThanOrEqual(H + 0.01);
    }
    for (let i = 0; i < boxes.length; i += 1)
      for (let j = i + 1; j < boxes.length; j += 1) {
        const a = boxes[i];
        const b = boxes[j];
        if (a.linked === b.id || b.linked === a.id) continue; // linked balloons touch by design
        expect(overlapFraction(a.box, b.box), `${page.id}: ${a.id} × ${b.id} overlap`).toBe(0);
      }
  }
};

describe('every drawn page of the QA fixtures: no balloon overlaps, nothing off the page', () => {
  for (const fixture of ['stress', 'heist-12p', 'lake-1p', 'deep-40p'] as const) {
    it(`${fixture} with the registry estimates`, () => check(makeQaDoc(fixture), estimateMeasure));
    it(`${fixture} with a 1.2× wider measure`, () => check(makeQaDoc(fixture), wideMeasure));
  }

  it('is deterministic (the same page plans identically twice)', () => {
    const doc = makeQaDoc('stress');
    const page = doc.pages.find((p) => p.id === 'pg_11')!;
    const aspect = letteringAspect(doc, page);
    expect(planLettering(doc, page, aspect, estimateMeasure)).toEqual(planLettering(doc, page, aspect, estimateMeasure));
  });

  it('keeps reading order on pages with room: later lines in a panel sit below or after earlier ones', () => {
    const doc = makeQaDoc('heist-12p');
    for (const page of drawnPages(doc)) {
      const aspect = letteringAspect(doc, page);
      const plans = planLettering(doc, page, aspect, estimateMeasure);
      if (plans.some((p) => p.crowded)) continue;
      const by = new Map(plans.map((p) => [p.lineId, p]));
      for (const panel of page.panels) {
        const ids = panel.lines.filter((l) => l.text.trim()).map((l) => l.id);
        for (let k = 1; k < ids.length; k += 1) {
          const prev = by.get(ids[k - 1])!;
          const cur = by.get(ids[k])!;
          if (!prev.fallback || !cur.fallback) continue; // stored balloons sit where their owner put them
          const sameRow = Math.abs(cur.y - prev.y) < 20;
          expect(cur.y >= prev.y - 20 && (!sameRow || cur.x >= prev.x), `${page.id} ${ids[k - 1]} → ${ids[k]} reads in order`).toBe(true);
        }
      }
    }
  });

  it('pinned balloons never move or shrink, and the dense page letters its software-placed balloons smaller', () => {
    const doc = makeQaDoc('stress');
    const page = doc.pages.find((p) => p.id === 'pg_11')!;
    const aspect = letteringAspect(doc, page);
    const H = 1000 / aspect;
    const plans = planLettering(doc, page, aspect, estimateMeasure);
    const pinned = page.balloons.filter((b) => b.pinned);
    expect(pinned.length).toBeGreaterThan(0);
    for (const b of pinned) {
      const plan = plans.find((p) => p.lineId === b.lineId)!;
      // Drawn where it is stored (the render-time page fit only nudges outlines that cross the page edge).
      const outline = { x: plan.x + plan.geometry.bounds.x, y: plan.y + plan.geometry.bounds.y, w: plan.geometry.bounds.w, h: plan.geometry.bounds.h };
      const insideStored = b.x * 1000 + plan.geometry.bounds.x >= 8 && b.y * H + plan.geometry.bounds.y >= 8 && b.x * 1000 + outline.w <= 992 && b.y * H + outline.h <= H - 8;
      if (insideStored) {
        expect(plan.x).toBeCloseTo(b.x * 1000, 1);
        expect(plan.y).toBeCloseTo(b.y * H, 1);
      }
      expect(plan.densityScale).toBeUndefined();
      expect(plan.crowded).toBeUndefined();
    }
    const dense = plans.filter((p) => p.densityScale !== undefined);
    expect(dense.length).toBeGreaterThan(0);
    for (const p of dense) expect(DENSITY_STEPS).toContain(p.densityScale);
    // The ones that had to leave their panel or be moved off another balloon say so (the editor's chip).
    expect(plans.some((p) => p.crowded)).toBe(true);
  });
});
