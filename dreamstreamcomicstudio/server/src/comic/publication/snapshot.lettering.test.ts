// @vitest-environment node
// The published comic letters every page exactly as the studio does (the coverage cap re-places stored, unpinned
// balloons at render time, so everything it reads must reach the snapshot): the children's cap, the faces and heads
// the page check found, and who is in each panel. A snapshot published before the faces were never has its stored
// balloons moved blind.

import { describe, expect, it } from 'vitest';
import type { ComicDoc, KeepOut, Page } from '../../../../shared/comic/doc.js';
import { p2ShapedDoc, type P2Options } from '../../../../shared/comic/lettering/__fixtures__/letterFit.js';
import { estimateMeasure, letteringAspect, planLettering, PLAN_W, storedFrozen, type LetterPlan, type Measure } from '../../../../shared/comic/lettering/layout.js';
import { PUBLIC_QC_CHECKED_AT } from '../../../../shared/comic/publication.js';
import { buildSnapshot, planSnapshot } from './snapshot.js';

const wideMeasure: Measure = (text, font) => estimateMeasure(text, font) * 1.2;
const MEASURES: [string, Measure][] = [
  ['the estimate measure', estimateMeasure],
  ['a 1.2× wider measure', wideMeasure]
];

const publish = (doc: ComicDoc): ComicDoc => {
  const plan = { ...planSnapshot(doc, { assetKey: 'K'.repeat(22), pageIds: doc.pages.map((p) => p.id), includeCover: false, languages: ['en'] }), publicationId: 'pub-1', publishedAt: 5, rev: 1 };
  return buildSnapshot(doc, plan);
};

const plansOf = (doc: ComicDoc, page: Page, measure: Measure): LetterPlan[] => planLettering(doc, page, letteringAspect(doc, page), measure);

/** A face the page check found in panel 4, right where a face-blind cap re-places panel 5's balloon (ln_5). */
const FACE: KeepOut = { panel: 4, box: { x: 0.235, y: 0.69, w: 0.07, h: 0.09 }, kind: 'face' };

/** Share of a face box the drawn outlines cover (0..1). */
const faceCovered = (plans: readonly LetterPlan[], face: KeepOut, H: number): number => {
  const f = { x: face.box.x * PLAN_W, y: face.box.y * H, w: face.box.w * PLAN_W, h: face.box.h * H };
  let covered = 0;
  for (const p of plans) {
    const o = { x: p.x + p.geometry.bounds.x, y: p.y + p.geometry.bounds.y, w: p.geometry.bounds.w, h: p.geometry.bounds.h };
    const w = Math.min(f.x + f.w, o.x + o.w) - Math.max(f.x, o.x);
    const h = Math.min(f.y + f.h, o.y + o.h) - Math.max(f.y, o.y);
    if (w > 0 && h > 0) covered += w * h;
  }
  return Math.min(1, covered / (f.w * f.h));
};

/** A kids' comic (not a storybook): only the brief says it is for children. */
const kidsComic = (opts: P2Options = {}) => {
  const { doc, page } = p2ShapedDoc(opts);
  doc.format.kind = 'comic';
  doc.brief = { ...doc.brief, audience: 'kids 6-9', premise: 'PRIVATE premise', notes: ['PRIVATE note'] };
  return { doc, page };
};

/** The p2 page with the face (and the speakers' heads) the page check stored. */
const withFaces = ({ doc, page }: { doc: ComicDoc; page: Page }) => {
  page.render.qc = {
    ...page.render.qc!,
    keepOut: [FACE],
    heads: [
      { panel: 5, characterId: 'c_kal', head: { x: 0.48, y: 0.83 }, mouth: { x: 0.48, y: 0.86 } },
      { panel: 6, characterId: 'c_meera', head: { x: 0.8, y: 0.85 } }
    ]
  };
  return { doc, page };
};

describe('the published comic is lettered like the studio (coverage cap inputs reach the snapshot)', () => {
  for (const [label, measure] of MEASURES)
    for (const panel6 of ['one', 'two'] as const)
      it(`a kids' comic with faces, panel 6 with ${panel6} line(s), ${label}: identical plans`, () => {
        const { doc, page } = withFaces(kidsComic({ panel6 }));
        const snap = publish(doc);
        expect(plansOf(snap, snap.pages[0], measure)).toEqual(plansOf(doc, page, measure));
      });

  it('carries only the category word for the audience, and geometry only from the page check', () => {
    const { doc } = withFaces(kidsComic());
    const snap = publish(doc);
    expect(snap.brief).toEqual({ title: doc.brief.title, notes: [], audience: 'children' });
    expect(JSON.stringify(snap)).not.toContain('PRIVATE');
    const qc = snap.pages[0].render.qc!;
    expect(qc.checkedAt).toBe(PUBLIC_QC_CHECKED_AT);
    expect(qc.keepOut).toEqual([FACE]);
    expect(qc.heads!.map((h) => h.characterId)).toEqual(['c_kal', 'c_meera']);
    expect(snap.pages[0].panels.map((pn) => pn.castIds)).toEqual(doc.pages[0].panels.map((pn) => pn.castIds));
    expect(storedFrozen(snap.pages[0])).toBe(false);
  });

  it('an adult comic or a storybook publishes no audience at all', () => {
    const adult = p2ShapedDoc();
    adult.doc.brief = { ...adult.doc.brief, audience: 'adults' };
    expect(publish(adult.doc).brief.audience).toBeUndefined();
    const story = p2ShapedDoc({ kids: true });
    expect(publish(story.doc).brief.audience).toBeUndefined();
  });

  it('a page whose check stored no faces publishes empty face lists and still letters like the studio', () => {
    const { doc, page } = p2ShapedDoc();
    const snap = publish(doc);
    expect(snap.pages[0].render.qc).toMatchObject({ keepOut: [], heads: [] });
    for (const [, measure] of MEASURES) expect(plansOf(snap, snap.pages[0], measure)).toEqual(plansOf(doc, page, measure));
  });

  it('the reader never re-places a stored balloon onto a face the studio letters around', () => {
    const { doc, page } = withFaces(p2ShapedDoc({ panel6: 'one' }));
    const snap = publish(doc);
    const H = PLAN_W / letteringAspect(doc, page);
    for (const [, measure] of MEASURES) {
      const studio = faceCovered(plansOf(doc, page, measure), FACE, H);
      expect(faceCovered(plansOf(snap, snap.pages[0], measure), FACE, H)).toBeLessThanOrEqual(studio + 1e-9);
    }
  });
});

describe('a snapshot published before the faces were (geometry-only check, no face lists)', () => {
  /** What the old publicQc stored: the panel boxes only. */
  const legacy = (snap: ComicDoc): ComicDoc => ({
    ...snap,
    pages: snap.pages.map((p) => ({ ...p, render: { ...p.render, qc: { score: 0, issues: [], checkedAt: 0, panelBoxes: p.render.qc!.panelBoxes } } }))
  });

  for (const [label, measure] of MEASURES)
    it(`draws its stored balloons where they are stored (never moved blind onto a face), ${label}`, () => {
      const { doc, page } = withFaces(p2ShapedDoc({ panel6: 'one' }));
      const old = legacy(publish(doc));
      const oldPage = old.pages[0];
      expect(storedFrozen(oldPage)).toBe(true);
      const H = PLAN_W / letteringAspect(old, oldPage);
      const plans = plansOf(old, oldPage, measure);
      void page;
      for (const b of oldPage.balloons) {
        const plan = plans.find((p) => p.lineId === b.lineId)!;
        expect(plan.crowdedReason).not.toBe('cover');
        if (b.pinned) continue;
        // Where it is stored, give or take the render-time settle's small nudge (as before the cap existed).
        expect(Math.abs(plan.x / PLAN_W - b.x)).toBeLessThan(0.02);
        expect(Math.abs(plan.y / H - b.y)).toBeLessThan(0.02);
      }
      // The panel is still flagged when it is over the cap (the editor and the breakdown read `dense`).
      const studio = plansOf(doc, page, measure);
      if (studio.some((p) => p.lineId === 'ln_5' && p.dense)) expect(plans.find((p) => p.lineId === 'ln_5')!.dense).toBeTruthy();
      // The pre-cap drawing (stored spots) kept ln_5 off the face; the old snapshot still does.
      expect(faceCovered(plans.filter((p) => p.lineId === 'ln_5'), FACE, H)).toBeLessThan(0.25);
    });

  it('a live page is never frozen: the studio caps it (with or without face data)', () => {
    const { page } = p2ShapedDoc();
    expect(storedFrozen(page)).toBe(false);
    expect(storedFrozen(withFaces(p2ShapedDoc()).page)).toBe(false);
  });
});
