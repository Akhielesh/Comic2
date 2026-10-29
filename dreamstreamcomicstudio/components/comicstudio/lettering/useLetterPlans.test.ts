// The balloon behind a drawn plan is the one the user SEES: after the render-time settle / dense-page repack
// moved a balloon, its first drag or lock starts from the drawn spot (and tail), never the placement's.

import { describe, expect, it } from 'vitest';
import { makeQaDoc } from '../testing/qaFixtures';
import { estimateMeasure, letteringAspect, planLettering } from '../../../shared/comic/lettering/layout';
import { resolvePlacements, withDrawnGeometry } from './useLetterPlans';

describe('withDrawnGeometry', () => {
  it('moves the balloons behind settled / repacked plans to where they are drawn; pinned ones stay', () => {
    const doc = makeQaDoc('stress');
    const page = doc.pages.find((p) => p.id === 'pg_11')!;
    const aspect = letteringAspect(doc, page);
    const H = 1000 / aspect;
    const plans = planLettering(doc, page, aspect, estimateMeasure);
    const raw = resolvePlacements(doc, page, aspect, estimateMeasure);
    const before = new Map(raw.balloons);
    const p = withDrawnGeometry(raw, plans, H);
    const crowded = plans.filter((x) => x.crowded);
    expect(crowded.length).toBeGreaterThan(0);
    let moved = 0;
    for (const plan of crowded) {
      expect(p.crowded.has(plan.lineId)).toBe(true);
      const b = p.balloons.get(plan.lineId)!;
      if (b.pinned || b.locked) continue;
      expect(b.x).toBeCloseTo(plan.x / 1000, 3);
      expect(b.y).toBeCloseTo(plan.y / H, 3);
      if (plan.tip) {
        expect(b.tailX).toBeCloseTo(plan.tip.x / 1000, 3);
        expect(b.tailY).toBeCloseTo(plan.tip.y / H, 3);
      }
      const was = before.get(plan.lineId)!;
      if (Math.abs(was.x - b.x) > 1e-3 || Math.abs(was.y - b.y) > 1e-3) moved += 1;
    }
    // Without this the editor's "full balloon" is the pre-settle placement: a first drag would jump.
    expect(moved).toBeGreaterThan(0);
    for (const b of page.balloons.filter((x) => x.pinned || x.locked)) expect(p.balloons.get(b.lineId)).toEqual(b);
  });
});
