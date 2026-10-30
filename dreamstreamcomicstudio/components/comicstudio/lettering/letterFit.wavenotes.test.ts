// A4 wave notes in the editor's own ops (styleOps.ts): Tidy and Reset position save their placement under the comic's
// coverage cap (placementCoverOptions — 0.25 for children's books, with the real outline fills), and Lock pins a
// crowded or cap-moved stored balloon where it is DRAWN instead of sending it back to its stored spot.
import { describe, expect, it } from 'vitest';
import type { Balloon, ComicDoc, Page } from '../../../shared/comic/doc';
import { applyOps } from '../../../shared/comic/ops';
import { PANEL_LIMITS } from '../../../shared/comic/panelRules';
import { panelBoxesFor } from '../../../shared/comic/pageGeometry';
import { estimateMeasure, letteringAspect, letteringSizer, planLettering, placementCoverOptions } from '../../../shared/comic/lettering/layout';
import { coverageOf, placeBalloonsWholeWords } from '../../../shared/comic/lettering/place';
import { p2ShapedDoc } from '../../../shared/comic/lettering/__fixtures__/letterFit';
import { drawnSpotPatch as inspectorDrawnSpotPatch } from './LetteringInspector';
import { drawnSpotPatch, lockOps, resetPositionOps, tidyOps } from './styleOps';
import { resolvePlacements, withDrawnGeometry } from './useLetterPlans';

/** Coverage of each panel by these balloons, in the cap's own units (the doc's outline fills). */
const coverOf = (doc: ComicDoc, page: Page, balloons: readonly Balloon[]): number[] => {
  const aspect = letteringAspect(doc, page);
  const sizer = letteringSizer(doc, page, aspect, estimateMeasure);
  const lines = new Map(page.panels.flatMap((p) => p.lines).map((l) => [l.id, l]));
  const { fillFor } = placementCoverOptions(doc);
  const outlines = balloons.map((b) => {
    const line = lines.get(b.lineId)!;
    const s = sizer(line, b.w);
    return { outline: { x: b.x + s.bounds.x, y: b.y + s.bounds.y, w: s.bounds.w, h: s.bounds.h }, fill: fillFor(line) };
  });
  return panelBoxesFor(doc, page).map((box) => coverageOf(box, outlines));
};

/** A children's book whose panel 5 (one long line, unpinned) covers about 0.27 of its picture: under the default
 *  0.30 cap, over the kids' 0.25. */
const kidsPage = () => p2ShapedDoc({ kids: true, panel6: 'one' });
const KIDS_CAP = PANEL_LIMITS.coverCapKids;

describe('styleOps saves under the comic’s coverage cap (A4 wave note 2)', () => {
  it('the fixture is over the kids’ cap only: the default 0.30 placement leaves panel 5 above 0.25', () => {
    const { doc, page } = kidsPage();
    const aspect = letteringAspect(doc, page);
    const plain = placeBalloonsWholeWords({
      page,
      boxes: panelBoxesFor(doc, page),
      aspect,
      rtl: false,
      plansFor: letteringSizer(doc, page, aspect, estimateMeasure),
      safeMargin: 0.03,
      existing: page.balloons,
      keep: 'pinned',
      lang: doc.format.language
    });
    expect(coverOf(doc, page, plain.balloons)[4]).toBeGreaterThan(KIDS_CAP + 0.01);
  });

  it('Tidy brings panel 5 under the kids’ cap and keeps the pinned balloons', () => {
    const { doc, page } = kidsPage();
    const ops = tidyOps(doc, page, letteringAspect(doc, page), estimateMeasure);
    expect(ops.length).toBeGreaterThan(0);
    const after = applyOps(doc, ops).pages[0];
    expect(coverOf(doc, after, after.balloons)[4]).toBeLessThanOrEqual(KIDS_CAP + 1e-9);
    for (const b of page.balloons.filter((x) => x.pinned)) expect(after.balloons.find((x) => x.lineId === b.lineId)).toEqual(b);
  });

  it('Reset position re-places the line under the kids’ cap', () => {
    const { doc, page } = kidsPage();
    const ops = resetPositionOps(doc, page, ['ln_5'], letteringAspect(doc, page), estimateMeasure);
    expect(ops[0]).toMatchObject({ op: 'balloon', lineId: 'ln_5', patch: { pinned: false } });
    const after = applyOps(doc, ops).pages[0];
    expect(coverOf(doc, after, after.balloons)[4]).toBeLessThanOrEqual(KIDS_CAP + 1e-9);
  });
});

describe('Lock pins a balloon where it is drawn (A4 fix-round wave note 2)', () => {
  it('a cap-moved stored balloon is locked at its drawn spot, so locking never moves it', () => {
    const { doc, page } = p2ShapedDoc();
    const aspect = letteringAspect(doc, page);
    const plans = planLettering(doc, page, aspect, estimateMeasure);
    const placements = withDrawnGeometry(resolvePlacements(doc, page, aspect, estimateMeasure), plans, 1000 / aspect);
    const moved = plans.find((p) => p.crowdedReason === 'cover' && !page.balloons.find((b) => b.lineId === p.lineId)?.pinned);
    expect(moved, 'the cap re-placed one of panel 6’s stored balloons').toBeTruthy();
    const id = moved!.lineId;
    const drawn = placements.balloons.get(id)!;
    const stored = page.balloons.find((b) => b.lineId === id)!;
    expect([drawn.x, drawn.y]).not.toEqual([stored.x, stored.y]);

    const [op] = lockOps(page, [id], true, placements.balloons);
    expect(op).toMatchObject({ op: 'balloon', lineId: id, patch: { x: drawn.x, y: drawn.y, w: drawn.w, locked: true, pinned: true } });
    const after = applyOps(doc, [op]);
    const plan = planLettering(after, after.pages[0], aspect, estimateMeasure).find((p) => p.lineId === id)!;
    expect([plan.x, plan.y]).toEqual([moved!.x, moved!.y]);
    // Unlocking only clears the lock.
    expect(lockOps(page, [id], false, placements.balloons)).toEqual([{ op: 'balloon', pageId: page.id, lineId: id, patch: { locked: false } }]);
  });

  it('drawnSpotPatch lives in styleOps and the inspector re-exports the same function', () => {
    expect(inspectorDrawnSpotPatch).toBe(drawnSpotPatch);
  });
});
