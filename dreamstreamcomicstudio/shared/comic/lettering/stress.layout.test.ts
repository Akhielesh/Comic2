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
import { makeSampleDoc } from '../../../components/comicstudio/board/__fixtures__/sampleDoc';
import type { Box, ComicDoc, Page } from '../doc';
import { DENSITY_STEPS, estimateMeasure, letteringAspect, letteringSizer, planLettering, type LetterPlan, type Measure } from './layout';
import { panelBoxesFor } from '../pageGeometry';
import { balloonFootprint, placeBalloonsDetailed } from './place';

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
        const rtl = doc.format.readingDirection === 'rtl';
        if (p.y < prev.y - tol || (sameRow && (rtl ? p.x > prev.x + 0.01 : p.x < prev.x - 0.01))) out.push(`${line.id}: before ${prevLine.id}`);
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

  it('right-to-left comics read in order too (heist-12p, lake-1p, deep-40p mirrored)', () => {
    for (const fixture of ['heist-12p', 'lake-1p', 'deep-40p'] as const) {
      const doc = makeQaDoc(fixture, { rtl: true });
      for (const page of drawnPages(doc)) {
        const plans = planLettering(doc, page, letteringAspect(doc, page), estimateMeasure);
        expect(readingOrderBreaks(doc, page, plans), `${fixture} rtl ${page.id}`).toEqual([]);
      }
    }
  });

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

// ── Reading order against the NEXT line the owner fixed in a panel ───────────────────────────────────────

/**
 * The fixtures with holes punched: every line whose next line in its panel has a stored balloon loses its own,
 * so the engine places it in front of a line the owner already fixed (`pin` pins the kept ones, so the
 * dense-page repack cannot move them either). The sample doc's page 1 is that shape as shipped.
 */
const withHoles = (doc: ComicDoc, pin: boolean): ComicDoc => {
  for (const page of drawnPages(doc)) {
    const stored = new Set(page.balloons.map((b) => b.lineId));
    const drop = new Set<string>();
    for (const panel of page.panels) {
      const lines = panel.lines.filter((l) => l.text.trim());
      lines.forEach((l, k) => {
        if (k + 1 < lines.length && stored.has(lines[k + 1].id)) drop.add(l.id);
      });
    }
    page.balloons = page.balloons.filter((b) => !drop.has(b.lineId)).map((b) => (pin ? { ...b, pinned: true } : b));
  }
  return doc;
};

/**
 * Every software-placed line that the reader meets AFTER a later line of its panel the owner fixed (stored,
 * drawn where stored, met in that panel, and read after the placed line's previous line) — unless the engine
 * reports it read out of turn (`crowdedReason: 'order'`). Returns "line: why" strings.
 */
const nextFixedBreaks = (doc: ComicDoc, page: Page, plans: readonly LetterPlan[]): string[] => {
  const aspect = letteringAspect(doc, page);
  const H = 1000 / aspect;
  const tol = 0.02 * H;
  const rtl = doc.format.readingDirection === 'rtl';
  const boxes = panelBoxesFor(doc, page).map((b) => ({ x: b.x * 1000, y: b.y * H, w: b.w * 1000, h: b.h * H }));
  const by = new Map(plans.map((p) => [p.lineId, p]));
  const stored = new Map(page.balloons.map((b) => [b.lineId, b]));
  /** Text box `a` is read before `b` (tops within the row tolerance share a row). */
  const before = (a: LetterPlan, b: LetterPlan) => a.y < b.y - tol || (Math.abs(a.y - b.y) < tol && (rtl ? a.x >= b.x - 0.01 : a.x <= b.x + 0.01));
  const out: string[] = [];
  page.panels.forEach((panel, index) => {
    const own = boxes[index];
    const metHere = (p: LetterPlan) => {
      const cx = p.x + p.w / 2;
      return cx >= own.x && cx <= own.x + own.w && p.y >= own.y - 0.01 * H && p.y <= own.y + own.h;
    };
    const lines = panel.lines.filter((l) => l.text.trim());
    lines.forEach((line, k) => {
      const a = by.get(line.id)!;
      if (!a.fallback) return;
      const prevLine = lines[k - 1];
      const prev = prevLine ? by.get(prevLine.id) : undefined;
      const ps = prevLine ? stored.get(prevLine.id) : undefined;
      const anchoredPrev = prev && (!(ps?.pinned || ps?.locked) || metHere(prev)) ? prev : undefined;
      for (const later of lines.slice(k + 1)) {
        const b = by.get(later.id)!;
        const s = stored.get(later.id);
        if (!s || Math.abs(b.x - s.x * 1000) >= 40 || Math.abs(b.y - s.y * H) >= 40 || !metHere(b)) continue; // not where the owner fixed it
        if (anchoredPrev && before(b, anchoredPrev)) continue; // the owner already stored it before the previous line
        if (!before(a, b) && a.crowdedReason !== 'order') out.push(`${line.id}: read after ${later.id}`);
      }
    });
  });
  return out;
};

/** The fixture pages that are over-full even at the smallest lettering (see the reading-order sweep above). */
const OVERFULL_PAGES: Record<string, readonly string[]> = { stress: ['pg_7', 'pg_11', 'pg_19'] };

describe('a placed line is read before the later lines the owner fixed in its panel (every drawn page, holes punched)', () => {
  const docs = (rtl: boolean): [string, ComicDoc][] => [
    ['sample', rtl ? { ...makeSampleDoc(), format: { ...makeSampleDoc().format, readingDirection: 'rtl' } } : makeSampleDoc()],
    ...(['stress', 'heist-12p', 'lake-1p', 'deep-40p'] as const).flatMap((f): [string, ComicDoc][] => [
      [`${f} holes`, withHoles(makeQaDoc(f, { rtl }), false)],
      [`${f} holes pinned`, withHoles(makeQaDoc(f, { rtl }), true)]
    ])
  ];
  for (const rtl of [false, true]) {
    for (const [name, measure] of [
      ['the registry estimates', estimateMeasure],
      ['a 1.2× wider measure', wideMeasure]
    ] as const) {
      it(`${rtl ? 'rtl' : 'ltr'} with ${name}: in turn, or reported read out of turn — and still no overlaps, nothing off the page`, () => {
        let placedBeforeFixed = 0;
        for (const [label, doc] of docs(rtl)) {
          for (const page of drawnPages(doc)) {
            const plans = planLettering(doc, page, letteringAspect(doc, page), measure);
            expect(nextFixedBreaks(doc, page, plans), `${label} ${page.id}`).toEqual([]);
            const aspect = letteringAspect(doc, page);
            const H = 1000 / aspect;
            const owner = new Set(page.balloons.filter((b) => b.pinned || b.locked).map((b) => b.lineId));
            const feet = plans.map((p) => ({ id: p.lineId, box: groupBox(p), linked: p.linkTo }));
            for (const { id, box } of feet) {
              expect(box.x, `${label} ${page.id} ${id} left`).toBeGreaterThanOrEqual(-0.01);
              expect(box.y, `${label} ${page.id} ${id} top`).toBeGreaterThanOrEqual(-0.01);
              expect(box.x + box.w, `${label} ${page.id} ${id} right`).toBeLessThanOrEqual(1000.01);
              expect(box.y + box.h, `${label} ${page.id} ${id} bottom`).toBeLessThanOrEqual(H + 0.01);
            }
            for (let i = 0; i < feet.length; i += 1)
              for (let j = i + 1; j < feet.length; j += 1) {
                if (feet[i].linked === feet[j].id || feet[j].linked === feet[i].id) continue;
                if (owner.has(feet[i].id) && owner.has(feet[j].id)) continue; // two pins the owner overlapped
                const f = overlapFraction(feet[i].box, feet[j].box);
                // An over-full page (more words than room even at the smallest lettering) may be left with an
                // overlap, and then says so; any other page has none.
                const said = [feet[i].id, feet[j].id].some((id) => plans.find((p) => p.lineId === id)?.crowdedReason === 'overlap');
                if (f > 0 && (OVERFULL_PAGES[label.split(' ')[0]] ?? []).includes(page.id)) expect(said, `${label} ${page.id}: ${feet[i].id} × ${feet[j].id} overlap is reported`).toBe(true);
                else expect(f, `${label} ${page.id}: ${feet[i].id} × ${feet[j].id} overlap`).toBe(0);
              }
            // The sweep really exercises the rule: placed lines in front of a fixed one exist.
            const stored = new Set(page.balloons.map((b) => b.lineId));
            for (const panel of page.panels) {
              const ids = panel.lines.filter((l) => l.text.trim()).map((l) => l.id);
              ids.forEach((id, k) => {
                if (!stored.has(id) && ids.slice(k + 1).some((n) => stored.has(n))) placedBeforeFixed += 1;
              });
            }
          }
        }
        expect(placedBeforeFixed).toBeGreaterThan(20);
      });
    }
  }
});

describe('the sample page: a new line before one the owner stored, with no whole-word room in turn', () => {
  it('pg_1_l4 is lettered whole and flagged `order`; nothing the owner lettered moves', () => {
    // Panel 3: l3 pinned at y .50 (its tail reaches down to .75), l4 has no balloon, l5 stored (unpinned) at
    // y .80. The placement tucks l4 in on l3's row (the board's fallback spot), but that gap is too narrow for
    // "EXPLANATION," — it letters "EXPLANATI / ON". The planner places l4 again in whole words only: after
    // l5 (read out of turn, and flagged so the editor says so), and it never moves or shrinks the owner's
    // balloons to make room. Before the fix l4 was drawn after l5 with no flag.
    const doc = makeSampleDoc();
    const page = doc.pages[0];
    const aspect = letteringAspect(doc, page);
    const placed = placeBalloonsDetailed({
      page,
      boxes: panelBoxesFor(doc, page),
      aspect,
      rtl: false,
      plansFor: letteringSizer(doc, page, aspect, estimateMeasure),
      safeMargin: 0.03,
      existing: page.balloons,
      keep: 'all'
    });
    expect(placed.split).toEqual(['pg_1_l4']);
    for (const measure of [estimateMeasure, wideMeasure]) {
      const H = 1000 / aspect;
      const plans = planLettering(doc, page, aspect, measure);
      const by = (id: string) => plans.find((p) => p.lineId === id)!;
      const [l3, l4, l5] = [by('pg_1_l3'), by('pg_1_l4'), by('pg_1_l5')];
      const tol = 0.02 * H;
      expect(l4.fallback).toBe(true);
      expect(l4.runs.map((r) => r.text).join(' '), 'no word split').toBe('YOU OWE ME AN EXPLANATION, MAYA.');
      expect(l4.densityScale).toBeUndefined();
      expect(l4.y, 'l4 is read after l3').toBeGreaterThan(l3.y + tol);
      const inTurn = l4.y < l5.y - tol || (Math.abs(l4.y - l5.y) < tol && l4.x < l5.x);
      expect(inTurn || l4.crowdedReason === 'order', 'read in turn, or flagged').toBe(true);
      expect(l4.crowdedReason).toBe('order');
      for (const id of ['pg_1_l1', 'pg_1_l2', 'pg_1_l3', 'pg_1_l5']) {
        const s = page.balloons.find((b) => b.lineId === id)!;
        const p = by(id);
        expect(p.x, `${id} x`).toBeCloseTo(s.x * 1000, 1);
        expect(p.y, `${id} y`).toBeCloseTo(s.y * H, 1);
        expect(p.w, `${id} w`).toBeCloseTo(s.w * 1000, 1);
        expect(p.crowded, `${id} untouched`).toBeUndefined();
        expect(p.densityScale, `${id} size`).toBeUndefined();
      }
      const groups = plans.map((p) => ({ id: p.lineId, box: groupBox(p) }));
      for (let i = 0; i < groups.length; i += 1)
        for (let j = i + 1; j < groups.length; j += 1) expect(overlapFraction(groups[i].box, groups[j].box), `${groups[i].id} × ${groups[j].id}`).toBe(0);
    }
  });

  it('with room before the stored line, the new line is lettered whole in turn and nothing is flagged', () => {
    // The same page with l5 stored lower (y .90): l4 now fits between l3's tail and l5 in whole words.
    const doc = makeSampleDoc((d) => {
      d.pages[0].balloons = d.pages[0].balloons.map((b) => (b.lineId === 'pg_1_l5' ? { ...b, y: 0.9 } : b));
    });
    const page = doc.pages[0];
    const aspect = letteringAspect(doc, page);
    const H = 1000 / aspect;
    const plans = planLettering(doc, page, aspect, estimateMeasure);
    const by = (id: string) => plans.find((p) => p.lineId === id)!;
    const [l3, l4, l5] = [by('pg_1_l3'), by('pg_1_l4'), by('pg_1_l5')];
    const tol = 0.02 * H;
    expect(l4.y, 'l4 is read after l3').toBeGreaterThan(l3.y + tol);
    expect(l4.y, 'l4 is read before l5').toBeLessThan(l5.y - tol);
    expect(l4.runs.map((r) => r.text).join(' ')).toBe('YOU OWE ME AN EXPLANATION, MAYA.');
    expect(plans.filter((p) => p.crowded).map((p) => p.lineId)).toEqual([]);
    expect(l5.y).toBeCloseTo(0.9 * H, 1);
  });
});
