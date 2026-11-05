// Letter fit (plan §10 A4; investigation FX2, F8, FX6): a per-panel coverage cap for new AND stored balloons, never a
// balloon over another balloon's text, and a render-time minimum width for pinned balloons. Synthetic fixtures only.
//
// Each test fails on the engine before this change (46beb66a), for example: the p2-shaped page drew panel 6 at 0.343
// coverage (over the 0.30 cap) with its stored, unpinned balloons placed verbatim; the 1-word-wide pinned balloon was
// drawn 40 units wide with "CALIBRATI / NG" broken and flagged overflow; on the stress fixture at a 1.5× measure
// pg_11_p4_l1 sat over pg_11_p2_l2's text although the page had a text-free spot for it.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { makeQaDoc } from '../../../components/comicstudio/testing/qaFixtures';
import { makeSampleDoc } from '../../../components/comicstudio/board/__fixtures__/sampleDoc';
import { hashString } from '../hash';
import { normalizeDoc, type Box, type ComicDoc, type Page } from '../doc';
import { PANEL_LIMITS } from '../panelRules';
import { panelBoxesFor } from '../pageGeometry';
import {
  COVER_STEPS,
  coverCapFor,
  coverStepsFor,
  estimateMeasure,
  LETTER_FIT_POLICY,
  letteringAspect,
  letteringSizer,
  panelCoverage,
  placementCoverOptions,
  planLettering,
  type LetterPlan,
  type Measure
} from './layout';
import { coverageOf, placeBalloonsWholeWords, settleBalloons, type SettleItem } from './place';
import { p2ShapedDoc } from './__fixtures__/letterFit';
import { applyOps, type DocOp } from '../ops';
import { FIT_FONT_FLOOR } from '../textLayout';
import { resolvePlacements, withDrawnGeometry } from '../../../components/comicstudio/lettering/useLetterPlans';
import { keepDrawnSizeOps } from '../../../components/comicstudio/lettering/styleOps';

/** The engine's plans before this change, hashed (see the file's note). */
const golden = JSON.parse(readFileSync(join(__dirname, '__fixtures__', 'letterFit.golden.json'), 'utf8')) as { pages: Record<string, string>; lines: Record<string, Record<string, string>> };

const wide: Measure = (text, font) => estimateMeasure(text, font) * 1.2;
const MEASURES: [string, Measure][] = [
  ['est', estimateMeasure],
  ['wide', wide]
];
const plansOf = (doc: ComicDoc, page: Page, m: Measure = estimateMeasure) => planLettering(doc, page, letteringAspect(doc, page), m);
const outline = (p: LetterPlan): Box => ({ x: p.x + p.geometry.bounds.x, y: p.y + p.geometry.bounds.y, w: p.geometry.bounds.w, h: p.geometry.bounds.h });
const text = (p: LetterPlan): Box => ({ x: p.x, y: p.y, w: p.w, h: p.h });
/** An overlap thinner than 1 plan unit (0.1 % of the page width) is not text under a balloon (layout.ts TEXT_SLIVER). */
const SLIVER = 1;
const overlaps = (a: Box, b: Box, eps = SLIVER) => Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x) > eps && Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y) > eps;
const withoutDense = (p: LetterPlan) => {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { dense: _d, ...rest } = p;
  return rest;
};

/** Run `fn` with the owner's shrink policy set (LETTER_FIT_POLICY is one constant; tests restore it). */
const withShrink = <T,>(on: boolean, fn: () => T): T => {
  const was = LETTER_FIT_POLICY.coverShrink;
  LETTER_FIT_POLICY.coverShrink = on;
  try {
    return fn();
  } finally {
    LETTER_FIT_POLICY.coverShrink = was;
  }
};
/** Panel 6's coverage on the engine before the cap (46beb66a): its stored, unpinned balloons placed verbatim. */
const STORED_COVER_6: Record<string, number> = { est: 0.3433, wide: 0.4354 };

describe('coverage cap on a stored page (F8): the p2-shaped page', () => {
  for (const [name, m] of MEASURES) {
    it(`panel 6 ends at or under the cap, or flagged with less of it covered; pinned balloons stay put; nothing overflows or leaves the page (${name})`, () => {
      const { doc, page } = p2ShapedDoc();
      const storedBefore = JSON.parse(JSON.stringify(page.balloons));
      const aspect = letteringAspect(doc, page);
      const H = 1000 / aspect;
      const plans = plansOf(doc, page, m);
      const cover = panelCoverage(doc, page, plans, aspect);
      const six = plans.filter((p) => p.panelN === 6);
      expect(six.length).toBe(2);
      // Panel 6 ≤ coverCap, OR flagged dense with less covered than its stored balloons covered (re-placed only: the
      // shrink is off until the owner decides, FX2/RC8).
      if (cover[5] > PANEL_LIMITS.coverCap + 1e-9) {
        for (const p of six) {
          expect(p.dense, p.lineId).toBeDefined();
          expect(p.dense!.cover).toBeCloseTo(STORED_COVER_6[name], 3);
          expect(p.dense!.drawn).toBeCloseTo(cover[5], 3);
          expect(p.dense!.drawn).toBeLessThan(p.dense!.cover - 0.01);
        }
      }
      // No other panel is pushed over the cap.
      cover.forEach((c, i) => {
        if (i !== 5) expect(c, `panel ${i + 1}`).toBeLessThanOrEqual(PANEL_LIMITS.coverCap + 1e-9);
      });
      // Every lettered line is drawn (lines == plans), none overflows, none leaves the page.
      const lines = page.panels.flatMap((p) => p.lines.filter((l) => l.text.trim()).map((l) => l.id));
      expect(plans.map((p) => p.lineId).sort()).toEqual([...lines].sort());
      expect(plans.filter((p) => p.overflow)).toEqual([]);
      for (const p of plans) {
        const o = outline(p);
        expect(o.x, p.lineId).toBeGreaterThanOrEqual(-0.5);
        expect(o.y, p.lineId).toBeGreaterThanOrEqual(-0.5);
        expect(o.x + o.w, p.lineId).toBeLessThanOrEqual(1000.5);
        expect(o.y + o.h, p.lineId).toBeLessThanOrEqual(H + 0.5);
      }
      // Pinned balloons are drawn exactly where the owner put them (and exactly as before the change).
      for (const b of page.balloons.filter((x) => x.pinned)) {
        const p = plans.find((q) => q.lineId === b.lineId)!;
        expect(p.x, b.lineId).toBeCloseTo(b.x * 1000, 2);
        expect(p.y, b.lineId).toBeCloseTo(b.y * H, 2);
        expect(hashString(JSON.stringify(p)), b.lineId).toBe(golden.lines[`p2|${name}`][b.lineId]);
      }
      // In memory only: the stored balloons are untouched.
      expect(page.balloons).toEqual(storedBefore);
      // Every movable balloon is lettered at full size: no shrink (phone legibility), no density step.
      for (const p of plans.filter((q) => !page.balloons.find((b) => b.lineId === q.lineId && b.pinned))) {
        expect(p.fontSize, p.lineId).toBe(17);
        expect(p.densityScale, p.lineId).toBeUndefined();
      }
      // The panel says it has too much text: words, about how many it holds, the cap.
      for (const p of six) {
        expect(p.dense).toBeDefined();
        expect(p.dense!.panelN).toBe(6);
        expect(p.dense!.cover).toBeGreaterThan(PANEL_LIMITS.coverCap);
        expect(p.dense!.words).toBeGreaterThan(p.dense!.fits);
        expect(p.dense!.cap).toBe(PANEL_LIMITS.coverCap);
        expect(p.dense!.scale).toBeUndefined();
        // Drawn elsewhere than stored: crowded, reason 'cover' (the editor drags, Keeps and Locks it where it is drawn).
        expect(p.crowded, p.lineId).toBe(true);
        expect(p.crowdedReason, p.lineId).toBe('cover');
      }
      // The panels that fit say nothing.
      expect(plans.filter((p) => p.panelN !== 6 && p.dense)).toEqual([]);
    });
  }

  it('is deterministic', () => {
    const a = p2ShapedDoc();
    const b = p2ShapedDoc();
    expect(plansOf(a.doc, a.page)).toEqual(plansOf(b.doc, b.page));
  });

  it("children's books cap at 0.25: re-placed at full size, and said so", () => {
    const { doc, page } = p2ShapedDoc({ kids: true });
    expect(coverCapFor(doc)).toBe(PANEL_LIMITS.coverCapKids);
    const plans = plansOf(doc, page);
    const cover = panelCoverage(doc, page, plans);
    const six = plans.find((p) => p.panelN === 6)!;
    expect(six.dense!.cap).toBe(PANEL_LIMITS.coverCapKids);
    // 26 words in a 0.10 panel cannot fit a children's book: the panel covers less than it did, still over, and the
    // editor says so (with how much it holds). Nothing is lettered smaller.
    expect(cover[5]).toBeLessThan(six.dense!.cover - 0.01);
    expect(six.dense!.drawn).toBeCloseTo(cover[5], 3);
    expect(six.dense!.scale).toBeUndefined();
    expect(plans.every((p) => p.fontSize >= 17 || page.balloons.find((b) => b.lineId === p.lineId && b.pinned))).toBe(true);
    // Panel 5 (0.27 of its picture, over the kids' cap too) comes under it by re-placement alone.
    expect(cover[4]).toBeLessThanOrEqual(PANEL_LIMITS.coverCapKids + 1e-9);
    expect(plans.find((p) => p.panelN === 5)!.dense).toBeUndefined();
  });
});

describe("letter-fit policy: the cap's shrink is the owner's decision (FX2/RC8)", () => {
  it('is off by default: the cap only re-places', () => {
    expect(LETTER_FIT_POLICY.coverShrink).toBe(false);
    expect(coverStepsFor()).toEqual([1]);
    // When the owner turns it on, it never goes below the auto-fit floor (children's books included).
    expect(Math.min(...coverStepsFor({ coverShrink: true }))).toBe(FIT_FONT_FLOOR);
    expect(COVER_STEPS).not.toContain(0.72);
  });

  it('turned on, each panel gets its own step: a panel that fits at full size is never lettered smaller for a neighbour', () => {
    withShrink(true, () => {
      // 1.2× measure: re-placed at full size, panel 5 comes to just under the cap; panel 6 needs the smallest step.
      const { doc, page } = p2ShapedDoc();
      const aspect = letteringAspect(doc, page);
      const plans = plansOf(doc, page, wide);
      const cover = panelCoverage(doc, page, plans, aspect);
      const five = plans.find((p) => p.lineId === 'ln_5')!;
      expect(five.fontSize).toBe(17);
      expect(five.densityScale).toBeUndefined();
      expect(five.dense).toBeUndefined();
      expect(cover[4]).toBeLessThanOrEqual(PANEL_LIMITS.coverCap + 1e-9);
      for (const p of plans.filter((q) => q.panelN === 6)) {
        expect(p.dense!.scale).toBe(FIT_FONT_FLOOR);
        // The drawn size is on the plan, so pinning it (a drag, Keep here, Lock) keeps it (styleOps keptSizes).
        expect(p.densityScale).toBe(FIT_FONT_FLOOR);
        expect(p.fontSize).toBeCloseTo(17 * FIT_FONT_FLOOR, 2);
      }
      expect(cover[5]).toBeLessThanOrEqual(PANEL_LIMITS.coverCap + 1e-9);
    });
  });

  it("turned on, children's books step down per panel too, never below the floor", () => {
    withShrink(true, () => {
      const { doc, page } = p2ShapedDoc({ kids: true });
      const plans = plansOf(doc, page, wide);
      // Every lettered-smaller panel says so (dense with its scale), and none goes below the floor.
      for (const p of plans.filter((q) => typeof q.densityScale === 'number')) {
        expect(p.dense?.scale, p.lineId).toBe(p.densityScale);
        expect(p.densityScale!).toBeGreaterThanOrEqual(FIT_FONT_FLOOR);
      }
      expect(plans.find((p) => p.lineId === 'ln_5')!.dense!.scale).toBe(0.9);
      expect(plans.find((p) => p.lineId === 'ln_6a')!.dense!.scale).toBe(FIT_FONT_FLOOR);
    });
  });
});

describe('the editor pins a cap-moved balloon where it is drawn', () => {
  /** A zero-distance drag commit, as BalloonLayer builds it: the resolved (drawn) balloon, pinned, plus the size it keeps. */
  const dragPin = (doc: ComicDoc, page: Page, id: string, m: Measure) => {
    const aspect = letteringAspect(doc, page);
    const H = 1000 / aspect;
    const plans = plansOf(doc, page, m);
    const resolved = withDrawnGeometry(resolvePlacements(doc, page, aspect, m), plans, H).balloons.get(id)!;
    const { lineId: _id, ...patch } = resolved;
    const ops: DocOp[] = [{ op: 'balloon', pageId: page.id, lineId: id, patch: { ...patch, pinned: true } }, ...keepDrawnSizeOps(page, plans, [id])];
    const doc2 = applyOps(doc, ops);
    const page2 = doc2.pages.find((p) => p.id === page.id)!;
    return { before: plans.find((p) => p.lineId === id)!, after: plansOf(doc2, page2, m).find((p) => p.lineId === id)! };
  };
  for (const shrink of [false, true])
    it(`a drag keeps its size, spot and tail (shrink ${shrink ? 'on' : 'off'})`, () => {
      withShrink(shrink, () => {
        const { doc, page } = p2ShapedDoc();
        const { before, after } = dragPin(doc, page, 'ln_6b', estimateMeasure);
        expect(before.crowdedReason).toBe('cover');
        expect(after.fontSize).toBe(before.fontSize);
        expect(after.x).toBeCloseTo(before.x, 0);
        expect(after.y).toBeCloseTo(before.y, 0);
        expect(after.tip!.x).toBeCloseTo(before.tip!.x, 0);
        expect(after.tip!.y).toBeCloseTo(before.tip!.y, 0);
      });
    });
});

describe('near the cap (fails without the cap: the engine before drew the stored balloons verbatim)', () => {
  it('a panel just over the cap comes under it at full size; pinned balloons are untouched and its neighbour sits as stored', () => {
    // 1.2× measure, one line in panel 6: panel 5's stored balloon covered 0.3169 of it (0.017 over the cap).
    const { doc, page } = p2ShapedDoc({ panel6: 'one' });
    const aspect = letteringAspect(doc, page);
    const plans = plansOf(doc, page, wide);
    const cover = panelCoverage(doc, page, plans, aspect);
    expect(cover.every((c) => c <= PANEL_LIMITS.coverCap + 1e-9)).toBe(true);
    const five = plans.find((p) => p.lineId === 'ln_5')!;
    expect(five.fontSize).toBe(17);
    expect(five.dense).toBeUndefined();
    expect(five.crowdedReason).toBe('cover');
    // Pinned balloons are drawn exactly as before; panel 6's balloon (under the cap) is no longer nudged aside for
    // panel 5's: it is drawn exactly where it is stored.
    for (const id of ['ln_1', 'ln_2', 'ln_4']) expect(hashString(JSON.stringify(plans.find((p) => p.lineId === id))), id).toBe(golden.lines['p2-one|wide'][id]);
    const sixA = plans.find((p) => p.lineId === 'ln_6a')!;
    const stored = page.balloons.find((b) => b.lineId === 'ln_6a')!;
    expect(sixA.x).toBeCloseTo(stored.x * 1000, 2);
    expect(sixA.y).toBeCloseTo(stored.y * (1000 / aspect), 2);
    expect(sixA.crowded).toBeUndefined();
    expect(sixA.dense).toBeUndefined();
  });
});

describe('under the cap nothing changes (byte-identical plans)', () => {
  const pages = golden.pages;
  const docs: Record<string, ComicDoc> = {
    sample: normalizeDoc(makeSampleDoc()),
    'lake-1p': makeQaDoc('lake-1p'),
    // As recorded: heist page 3 has since become the plan-fit QA page (held back, A5); the guard keeps its pages.
    'heist-12p': makeQaDoc('heist-12p', { heldBack: false }),
    'deep-40p': makeQaDoc('deep-40p'),
    'deep-40p-rtl': makeQaDoc('deep-40p', { rtl: true }),
    'webtoon-20p': makeQaDoc('webtoon-20p')
  };

  it('every QA and sample page plans exactly as before the cap (238 page × measure pairs)', () => {
    let checked = 0;
    for (const [name, doc] of Object.entries(docs))
      for (const [mk, m] of MEASURES)
        for (const page of doc.pages) {
          const want = pages[`${name}|${mk}|${page.id}`];
          if (!want) continue;
          const plans = plansOf(doc, page, m);
          expect(hashString(JSON.stringify(plans)), `${name} ${mk} ${page.id}`).toBe(want);
          checked += 1;
        }
    expect(checked).toBe(238);
  });

  it('a p2-shaped page whose panels all fit (one line in panel 6) plans exactly as before', () => {
    // (With the 1.2× measure panel 5 is over the cap, so only the registry estimates are all under it.)
    const { doc, page } = p2ShapedDoc({ panel6: 'one' });
    const plans = plansOf(doc, page);
    expect(panelCoverage(doc, page, plans).every((c) => c <= PANEL_LIMITS.coverCap)).toBe(true);
    expect(hashString(JSON.stringify(plans))).toBe(pages['p2-one|est|pg_2']);
  });

  it('balloons the owner pinned over the cap never move: the panel is only flagged', () => {
    for (const [mk, m] of MEASURES) {
      const { doc, page } = p2ShapedDoc({ pin6: true });
      const plans = plansOf(doc, page, m);
      const want = golden.lines[`p2-pin6|${mk}`];
      const pinned = new Set(page.balloons.filter((b) => b.pinned).map((b) => b.lineId));
      expect(pinned.size).toBe(5);
      for (const p of plans.filter((q) => pinned.has(q.lineId))) expect(hashString(JSON.stringify(withoutDense(p))), `${mk} ${p.lineId}`).toBe(want[p.lineId]);
      const six = plans.filter((p) => p.panelN === 6);
      expect(six.every((p) => p.dense && p.dense.cover > PANEL_LIMITS.coverCap && p.dense.scale === undefined)).toBe(true);
    }
  });
});

describe('never a balloon over another balloon\'s text (FX2): the stress fixture', () => {
  /** A text-free spot for `me` at its drawn size exists on the page as drawn (5-unit lattice). */
  const roomFor = (me: LetterPlan, plans: LetterPlan[], H: number): boolean => {
    const b0 = outline(me);
    const t0 = text(me);
    for (let y = 8; y + b0.h < H - 8; y += 5)
      for (let x = 8; x + b0.w < 992; x += 5) {
        const B = { ...b0, x, y };
        const T = { ...t0, x: t0.x + x - b0.x, y: t0.y + y - b0.y };
        if (!plans.some((q) => q !== me && (overlaps(B, text(q)) || overlaps(T, outline(q))))) return true;
      }
    return false;
  };
  for (const mult of [1, 1.2, 1.5, 2]) {
    it(`no movable balloon covers text or sits with its text under another outline while the page has room for it (${mult}× measure)`, () => {
      const doc = makeQaDoc('stress');
      const m: Measure = (t, f) => estimateMeasure(t, f) * mult;
      let pages = 0;
      for (const page of doc.pages.filter((p) => p.render.status === 'ready' || p.render.status === 'stale')) {
        pages += 1;
        const H = 1000 / letteringAspect(doc, page);
        const plans = plansOf(doc, page, m);
        const fixed = (p: LetterPlan) => !!page.balloons.find((b) => b.lineId === p.lineId && (b.pinned || b.locked));
        for (const me of plans) {
          if (fixed(me)) continue;
          const over = plans.filter((q) => q !== me && q.linkTo !== me.lineId && me.linkTo !== q.lineId && (overlaps(outline(me), text(q)) || overlaps(text(me), outline(q))));
          if (!over.length) continue;
          // Only a page with no text-free room for it at all, and then it says so.
          expect(mult, `${page.id} ${me.lineId} over ${over.map((q) => q.lineId)}`).toBeGreaterThan(1.2);
          expect(roomFor(me, plans, H), `${page.id} ${me.lineId}: a text-free spot exists`).toBe(false);
          expect(me.crowded, `${page.id} ${me.lineId} flagged`).toBe(true);
        }
      }
      expect(pages).toBeGreaterThan(0);
    });
  }

  it('settle: a balloon with no free room moves where it touches outlines but covers no text, and is still reported', () => {
    // Two pinned clouds fill the page except a 60-unit band; the movable cloud's text fits the band.
    const items: SettleItem[] = [
      { id: 'a', outline: { x: 0, y: 0, w: 1000, h: 500 }, body: { x: 0, y: 0, w: 1000, h: 500 }, text: { x: 300, y: 150, w: 400, h: 200 }, movable: false },
      { id: 'b', outline: { x: 0, y: 560, w: 1000, h: 440 }, body: { x: 0, y: 560, w: 1000, h: 440 }, text: { x: 300, y: 700, w: 400, h: 150 }, movable: false },
      { id: 'c', outline: { x: 300, y: 150, w: 300, h: 200 }, body: { x: 300, y: 150, w: 300, h: 200 }, text: { x: 400, y: 225, w: 100, h: 50 }, movable: true }
    ];
    const r = settleBalloons(items, { w: 1000, h: 1000 }, { margin: { x: 8, y: 8 }, gap: 10 });
    expect(r.unresolved).toEqual(['c']);
    const mv = r.moves.get('c')!;
    expect(mv).toBeDefined();
    const body = { x: 300 + mv.dx, y: 150 + mv.dy, w: 300, h: 200 };
    const t = { x: 400 + mv.dx, y: 225 + mv.dy, w: 100, h: 50 };
    for (const o of items.slice(0, 2)) {
      expect(overlaps(body, o.text!, 0)).toBe(false);
      expect(overlaps(t, o.body!, 0)).toBe(false);
    }
  });
});

describe('the settle fallback never carries a stored balloon away from its panel', () => {
  // Two pinned clouds fill the page except a 60-unit band far below the movable cloud's panel (the top 300 units).
  const items = (stored: boolean): SettleItem[] => [
    { id: 'a', outline: { x: 0, y: 0, w: 1000, h: 500 }, body: { x: 0, y: 0, w: 1000, h: 500 }, text: { x: 300, y: 150, w: 400, h: 200 }, movable: false },
    { id: 'b', outline: { x: 0, y: 560, w: 1000, h: 440 }, body: { x: 0, y: 560, w: 1000, h: 440 }, text: { x: 300, y: 700, w: 400, h: 150 }, movable: false },
    {
      id: 'c',
      outline: { x: 300, y: 150, w: 300, h: 200 },
      body: { x: 300, y: 150, w: 300, h: 200 },
      text: { x: 400, y: 225, w: 100, h: 50 },
      region: { x: 0, y: 0, w: 1000, h: 300 },
      movable: true,
      ...(stored ? { stored: true } : {})
    }
  ];
  const run = (stored: boolean) => settleBalloons(items(stored), { w: 1000, h: 1000 }, { margin: { x: 8, y: 8 }, gap: 10 });

  it('a line software-placed for this render may take the text-free band anywhere on the page', () => {
    const r = run(false);
    expect(r.unresolved).toEqual(['c']);
    expect(r.moves.get('c')!.dy).toBeGreaterThan(150);
  });

  it("an old comic's stored balloon stays where it is (still reported) when the only text-free spot is panels away", () => {
    const r = run(true);
    expect(r.unresolved).toEqual(['c']);
    expect(r.moves.get('c')).toBeUndefined();
  });
});

describe('minimum width for pinned balloons (FX6)', () => {
  const pinnedNarrow = (w: number) =>
    makeSampleDoc((d) => {
      const panel = d.pages[0].panels[0];
      panel.lines = [{ id: 'cal', kind: 'speech', speakerId: panel.castIds[0], text: 'Calibrating' }];
      d.pages[0].panels.slice(1).forEach((p) => (p.lines = []));
      d.pages[0].balloons = [{ lineId: 'cal', x: 0.3, y: 0.1, w, pinned: true }];
    });

  it('a 1-word-wide pinned balloon is drawn as wide as its word; the stored width stays', () => {
    for (const [, m] of MEASURES) {
      const doc = pinnedNarrow(0.04);
      const page = doc.pages[0];
      const plan = plansOf(doc, page, m).find((p) => p.lineId === 'cal')!;
      const word = m('CALIBRATING', plan.font);
      expect(plan.w).toBeGreaterThanOrEqual(word + 2 * plan.pad.x - 0.01);
      expect(plan.runs.map((r) => r.text)).toEqual(['CALIBRATING']);
      expect(plan.overflow).toBe(false);
      expect(plan.x).toBeCloseTo(300, 2); // drawn from where the owner put it
      expect(page.balloons[0].w).toBe(0.04);
    }
  });

  it('a pinned balloon wide enough already is drawn exactly as stored', () => {
    const doc = pinnedNarrow(0.3);
    const plan = plansOf(doc, doc.pages[0]).find((p) => p.lineId === 'cal')!;
    expect(plan.w).toBeCloseTo(300, 2);
  });
});

describe('Re-letter page persists the cap (placeBalloonsWholeWords)', () => {
  it('the saved placement covers panel 6 less than the stored balloons did, and keeps pinned balloons', () => {
    const { doc, page } = p2ShapedDoc();
    const aspect = letteringAspect(doc, page);
    const sizer = letteringSizer(doc, page, aspect, estimateMeasure);
    const boxes = panelBoxesFor(doc, page);
    const coverOfBalloons = (balloons: typeof page.balloons): number => {
      const lines = new Map(page.panels.flatMap((p) => p.lines).map((l) => [l.id, l]));
      const opts = placementCoverOptions(doc);
      return coverageOf(
        boxes[5],
        balloons.map((b) => {
          const line = lines.get(b.lineId)!;
          const s = sizer(line, b.w);
          return { outline: { x: b.x + s.bounds.x, y: b.y + s.bounds.y, w: s.bounds.w, h: s.bounds.h }, fill: opts.fillFor(line) };
        })
      );
    };
    const args = { page, boxes, aspect, rtl: false, plansFor: sizer, safeMargin: 0.03, existing: page.balloons, keep: 'pinned' as const, lang: 'en' };
    const uncapped = placeBalloonsWholeWords({ ...args, coverCap: false });
    const saved = placeBalloonsWholeWords({ ...args, ...placementCoverOptions(doc) });
    expect(coverOfBalloons(saved.balloons)).toBeLessThan(coverOfBalloons(uncapped.balloons) - 0.05);
    expect(saved.straddled?.length).toBeGreaterThan(0);
    for (const b of page.balloons.filter((x) => x.pinned)) expect(saved.balloons.find((s) => s.lineId === b.lineId)).toEqual(b);
    // Drawn from the saved balloons, panel 6 covers no more than the render-time cap drew it from the stored ones, and
    // still says it has too much text when it is over the cap.
    const drawnBefore = panelCoverage(doc, page, planLettering(doc, page, aspect, estimateMeasure), aspect)[5];
    const after = { ...page, balloons: saved.balloons };
    const plans = planLettering(doc, after, aspect, estimateMeasure);
    const coverAfter = panelCoverage(doc, after, plans, aspect)[5];
    expect(coverAfter).toBeLessThanOrEqual(drawnBefore + 1e-9);
    if (coverAfter > PANEL_LIMITS.coverCap + 1e-9) expect(plans.filter((p) => p.panelN === 6).every((p) => p.dense)).toBe(true);
  });
});
