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
import { panelBoxesFor } from '../pageGeometry';
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
      const plans = planLettering(doc, page, letteringAspect(doc, page), estimateMeasure);
      expect(readingOrderBreaks(doc, page, plans), page.id).toEqual([]);
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

/** Panel indexes in reading order (panel number, then array order). */
const readingOrder = (page: Page): number[] =>
  page.panels
    .map((p, i) => ({ n: p.n, i }))
    .sort((a, b) => a.n - b.n || a.i - b.i)
    .map((p) => p.i);

/**
 * Every line the engine placed or moved (software-placed, or an unpinned stored balloon drawn somewhere else
 * than stored) that a reader meets before its turn: its text centre in a panel earlier in reading order than
 * its own (unless it was stored there), above its own panel's tier, or — inside a panel — before the
 * previous line (row tolerance 2 % of the page height, ltr). Returns "line: why" strings.
 */
const readingOrderBreaks = (doc: ComicDoc, page: Page, plans: readonly LetterPlan[]): string[] => {
  const aspect = letteringAspect(doc, page);
  const H = 1000 / aspect;
  const boxes = panelBoxesFor(doc, page).map((b) => ({ x: b.x * 1000, y: b.y * H, w: b.w * 1000, h: b.h * H }));
  const order = readingOrder(page);
  const pos = new Map(order.map((index, r) => [index, r]));
  const by = new Map(plans.map((p) => [p.lineId, p]));
  const stored = new Map(page.balloons.map((b) => [b.lineId, b]));
  const inside = (b: Box, x: number, y: number) => x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h;
  const out: string[] = [];
  page.panels.forEach((panel, index) => {
    const own = boxes[index];
    const lines = panel.lines.filter((l) => l.text.trim());
    lines.forEach((line, k) => {
      const p = by.get(line.id)!;
      const s = stored.get(line.id);
      if (s && (s.pinned || s.locked)) return; // the owner's spot
      const cx = p.x + p.w / 2;
      const cy = p.y + p.h / 2;
      const sx = s ? s.x * 1000 + p.w / 2 : NaN;
      const sy = s ? s.y * H + p.h / 2 : NaN;
      // A stored balloon the engine drew where it is stored (only the page-edge fit nudged it) is the owner's.
      if (s && Math.abs(p.x - s.x * 1000) < 40 && Math.abs(p.y - s.y * H) < 40) return;
      for (const r of order.slice(0, pos.get(index))) {
        if (inside(boxes[r], cx, cy) && !(s && inside(boxes[r], sx, sy))) out.push(`${line.id}: in panel ${page.panels[r].n}, before its panel ${panel.n}`);
      }
      if (cy < own.y && !(s && sy < own.y)) out.push(`${line.id}: above its panel's tier`);
      const prevLine = lines[k - 1];
      const prev = prevLine ? by.get(prevLine.id) : undefined;
      const ps = prevLine ? stored.get(prevLine.id) : undefined;
      // The previous line counts when the reader meets it in this panel (a pin elsewhere says nothing).
      const anchored = prev && (!(ps?.pinned || ps?.locked) || inside(own, prev.x + prev.w / 2, prev.y));
      if (prev && anchored && !s) {
        const tol = 0.02 * H;
        const sameRow = Math.abs(p.y - prev.y) < tol;
        if (p.y < prev.y - tol || (sameRow && p.x < prev.x - 0.01)) out.push(`${line.id}: before ${prevLine.id}`);
      }
    });
  });
  return out;
};

describe('reading order on every drawn page of the QA fixtures (crowded pages included)', () => {
  /**
   * Pages with more words than room in reading order even at the smallest lettering: stress pages 7, 11 and
   * 19 carry nine to eleven 160-character lines on a 4:5 page, and the owner pinned a panel-2 balloon over
   * the bottom-right of panel 5 and an SFX across the middle tier, so the last tier cannot hold its own
   * lines. There, and only there, a line may be read early — flagged `crowdedReason: 'order'` so the editor
   * says so — and never above its own tier when its own tier has room. Any other page that reads out of
   * order fails.
   */
  const OVERFULL: Record<string, readonly string[]> = { stress: ['pg_7', 'pg_11', 'pg_19'] };

  for (const fixture of ['stress', 'heist-12p', 'lake-1p', 'deep-40p'] as const) {
    for (const [name, measure] of [
      ['the registry estimates', estimateMeasure],
      ['a 1.2× wider measure', wideMeasure]
    ] as const) {
      it(`${fixture} with ${name}: no line the engine placed or moved is read before its turn`, () => {
        const doc = makeQaDoc(fixture);
        for (const page of drawnPages(doc)) {
          const plans = planLettering(doc, page, letteringAspect(doc, page), measure);
          const breaks = readingOrderBreaks(doc, page, plans);
          if (!(OVERFULL[fixture] ?? []).includes(page.id)) {
            expect(breaks, page.id).toEqual([]);
            continue;
          }
          // Over-full: every line read early is flagged with the honest reason.
          for (const b of breaks) {
            const id = b.split(':')[0];
            expect(plans.find((p) => p.lineId === id)?.crowdedReason, `${page.id} ${b}`).toBe('order');
          }
        }
      });
    }
  }

  it('the page that used to read its last line first now reads it in its own tier (stress pg_7, pg_19)', () => {
    // 2f8843f4+builder: pg_7_p5_l2 / pg_19_p5_l2 (panel 5, the last one) were drawn in panel 1 at (0.25, 0.30).
    const doc = makeQaDoc('stress');
    for (const id of ['pg_7', 'pg_19']) {
      const page = doc.pages.find((p) => p.id === id)!;
      const aspect = letteringAspect(doc, page);
      const H = 1000 / aspect;
      const plans = planLettering(doc, page, aspect, estimateMeasure);
      const p = plans.find((q) => q.lineId === `${id}_p5_l2`)!;
      const tierTop = panelBoxesFor(doc, page)[4].y * H;
      expect(p.y + p.h / 2, `${id}_p5_l2 centre`).toBeGreaterThanOrEqual(tierTop);
    }
  });
});
