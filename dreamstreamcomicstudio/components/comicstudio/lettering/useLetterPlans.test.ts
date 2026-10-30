// The balloon behind a drawn plan is the one the user SEES: after the render-time settle / dense-page repack
// moved a balloon, its first drag or lock starts from the drawn spot (and tail), never the placement's.

import { describe, expect, it } from 'vitest';
import { makeQaDoc } from '../testing/qaFixtures';
import { p2ShapedDoc } from '../../../shared/comic/lettering/__fixtures__/letterFit';
import { estimateMeasure, letteringAspect, planLettering } from '../../../shared/comic/lettering/layout';
import { letteringKey, planLetteringCached, resolvePlacements, withDrawnGeometry } from './useLetterPlans';

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

describe('withDrawnGeometry keeps the drawn width', () => {
  it('the balloon behind a dense-page plan is as wide as it is drawn, so pinning it never moves its left edge', () => {
    const doc = makeQaDoc('stress');
    const page = doc.pages.find((p) => p.id === 'pg_11')!;
    const aspect = letteringAspect(doc, page);
    const plans = planLettering(doc, page, aspect, estimateMeasure);
    const p = withDrawnGeometry(resolvePlacements(doc, page, aspect, estimateMeasure), plans, 1000 / aspect);
    let checked = 0;
    for (const plan of plans) {
      const b = p.balloons.get(plan.lineId)!;
      if (b.pinned || b.locked || !(plan.crowded || plan.fallback)) continue;
      expect(b.w, plan.lineId).toBeCloseTo(plan.w / 1000, 3);
      checked += 1;
    }
    expect(checked).toBeGreaterThan(0);
  });
});

describe('planLetteringCached (plans survive doc changes that leave a page’s lettering alone)', () => {
  const setup = () => {
    const doc = makeQaDoc('stress');
    const page = doc.pages.find((p) => p.id === 'pg_11')!;
    return { doc, page, aspect: letteringAspect(doc, page) };
  };

  it('a new doc object with an unrelated change returns the very same plans (no re-plan)', () => {
    const { doc, page, aspect } = setup();
    const first = planLetteringCached(doc, page, aspect, estimateMeasure);
    // Another page edited, the title changed: new doc and page objects, same lettering content.
    const doc2 = { ...doc, brief: { ...doc.brief, title: 'Retitled' }, pages: doc.pages.map((p) => ({ ...p, summary: p.summary + ' (edited)' })) };
    const page2 = doc2.pages.find((p) => p.id === 'pg_11')!;
    expect(planLetteringCached(doc2, page2, aspect, estimateMeasure)).toBe(first);
    expect(first).toEqual(planLettering(doc, page, aspect, estimateMeasure));
  });

  it('re-plans when anything planLettering reads changes: text, a balloon, the letter style, the language, the measure', () => {
    const { doc, page, aspect } = setup();
    const first = planLetteringCached(doc, page, aspect, estimateMeasure);
    const id = page.panels[0].lines[0].id;
    const edited = { ...page, panels: page.panels.map((pn, i) => (i ? pn : { ...pn, lines: pn.lines.map((l) => (l.id === id ? { ...l, text: 'Short now.' } : l)) })) };
    const second = planLetteringCached(doc, edited, aspect, estimateMeasure);
    expect(second).not.toBe(first);
    expect(second.find((p) => p.lineId === id)!.runs.map((r) => r.text).join(' ').toLowerCase()).toContain('short now');
    const moved = { ...page, balloons: page.balloons.map((b, i) => (i ? b : { ...b, x: b.x + 0.05 })) };
    expect(planLetteringCached(doc, moved, aspect, estimateMeasure)).not.toBe(first);
    const restyled = { ...doc, letterStyle: { ...doc.letterStyle, base: { ...(doc.letterStyle?.base ?? {}), sizeScale: 0.9 } } } as typeof doc;
    expect(letteringKey(restyled, page, aspect)).not.toBe(letteringKey(doc, page, aspect));
    const hindi = { ...doc, format: { ...doc.format, language: 'hi' } };
    expect(letteringKey(hindi, page, aspect)).not.toBe(letteringKey(doc, page, aspect));
    const otherMeasure = (t: string, f: string) => estimateMeasure(t, f);
    expect(planLetteringCached(doc, page, aspect, otherMeasure)).not.toBe(first);
  });

  it('re-plans when the brief changes the coverage cap (an audience edit to a children’s book)', () => {
    // A kids' comic (not a storybook): only the brief says so, and it lowers the cap from 0.30 to 0.25.
    const { doc, page } = p2ShapedDoc({ panel6: 'one' });
    const aspect = letteringAspect(doc, page);
    const before = planLetteringCached(doc, page, aspect, estimateMeasure);
    const kids = { ...doc, brief: { ...doc.brief, audience: 'kids 6-9' } };
    const after = planLetteringCached(kids, page, aspect, estimateMeasure);
    expect(after).not.toBe(before);
    expect(after).toEqual(planLettering(kids, page, aspect, estimateMeasure));
    const ln5 = (ps: readonly { lineId: string; x: number }[]) => ps.find((p) => p.lineId === 'ln_5')!.x;
    expect(ln5(after)).not.toBeCloseTo(ln5(before), 0);
  });
});
