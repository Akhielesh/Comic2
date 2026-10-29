// Lettering fixes from the v5 bug hunt and the device matrix, each written so it fails on the code before
// the fix:
//   LE-7   Tidy: no op when only the stored order differs; a line with empty text keeps its balloon;
//   LE-10  Easy font chips on a non-Latin comic: only faces that can write it, with a VISIBLE reason;
//   dense pages: pinning a balloon keeps the size it is drawn at (a line-style size override);
//   touch: the tail dot and width grip keep their 44 px areas off the selected balloon's own target.

import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { makeSampleDoc } from '../board/__fixtures__/sampleDoc';
import { makeQaDoc } from '../testing/qaFixtures';
import { applyOps } from '../../../shared/comic/ops';
import { estimateMeasure, letteringAspect, planLettering } from '../../../shared/comic/lettering/layout';
import { resolveLetteringFont, fontCoversLanguage } from '../../../shared/comic/lettering/fonts';
import { keepDrawnSizeOps, keptSizes, sameBalloons, tidyOps } from './styleOps';
import { FontPicker, easyFontsFor, EASY_FONTS } from './FontPicker';
import { balloonHitRect, handlePositions } from '../board/BalloonLayer';
import { inspectorSheetMaxHeight, MIN_SHEET_PX } from '../board/PageEditor';

const ASPECT = 2 / 3;

describe('LE-7: Tidy', () => {
  it('returns nothing to do when every balloon is pinned and only the stored order differs', () => {
    const doc = makeSampleDoc((d) => {
      const page = d.pages[0];
      page.balloons = [...page.balloons.map((b) => ({ ...b, pinned: true })), { lineId: 'pg_1_l4', x: 0.3, y: 0.55, w: 0.25, tailX: 0.4, tailY: 0.7, pinned: true }].reverse();
    });
    expect(tidyOps(doc, doc.pages[0], ASPECT, estimateMeasure)).toEqual([]);
  });

  it('keeps the stored balloon of a line whose text is (temporarily) empty', () => {
    const doc = makeSampleDoc((d) => {
      d.pages[0].panels[0].lines[0].text = '';
      // One unpinned balloon so Tidy has real work to do.
      d.pages[0].balloons = d.pages[0].balloons.map((b, i) => ({ ...b, pinned: i !== 1 }));
    });
    const emptyId = doc.pages[0].panels[0].lines[0].id;
    expect(doc.pages[0].balloons.some((b) => b.lineId === emptyId)).toBe(true);
    const ops = tidyOps(doc, doc.pages[0], ASPECT, estimateMeasure);
    const after = applyOps(doc, ops);
    expect(after.pages[0].balloons.some((b) => b.lineId === emptyId)).toBe(true);
  });

  it('sameBalloons compares by line, not by stored order or key order', () => {
    expect(sameBalloons([{ lineId: 'a', x: 0.1, y: 0.2, w: 0.3 }, { lineId: 'b', w: 0.3, x: 0.5, y: 0.5 }], [{ lineId: 'b', x: 0.5, y: 0.5, w: 0.3 }, { lineId: 'a', x: 0.1, y: 0.2, w: 0.3 }])).toBe(true);
    expect(sameBalloons([{ lineId: 'a', x: 0.1, y: 0.2, w: 0.3 }], [{ lineId: 'a', x: 0.1, y: 0.2, w: 0.31 }])).toBe(false);
  });
});

describe('LE-10: Easy font chips on a non-Latin comic', () => {
  it('Telugu: only faces that write Telugu are offered, the one in use is checked, and a visible line says why', () => {
    const onChange = vi.fn();
    render(<FontPicker simple value="comic-neue" lang="te" onChange={onChange} />);
    // No Latin-only chip that would silently do nothing.
    expect(screen.queryByRole('radio', { name: 'Bangers' })).toBeNull();
    const chips = screen.getAllByRole('radio');
    expect(chips.length).toBeGreaterThan(0);
    for (const f of easyFontsFor('te')) expect(fontCoversLanguage(f, 'te')).toBe(true);
    // The face actually used for a comic-neue style is the checked chip.
    const used = resolveLetteringFont('comic-neue', 'speech', 'te').fontId;
    expect(chips.find((c) => c.getAttribute('aria-checked') === 'true')).toBeTruthy();
    expect(easyFontsFor('te')).toContain(used);
    // Visible text (not a tooltip) explains it.
    expect(screen.getByTestId('font-script-note').textContent).toMatch(/Telugu/);
    fireEvent.click(chips[0]);
    expect(onChange).toHaveBeenCalledWith(easyFontsFor('te')[0]);
  });

  it('Hindi also offers Kalam (a registry face that writes Devanagari); English keeps the friendly six, no note', () => {
    expect(easyFontsFor('hi')).toContain('kalam');
    render(<FontPicker simple value="comic-neue" lang="en" onChange={() => undefined} />);
    expect(screen.getAllByRole('radio')).toHaveLength(EASY_FONTS.length);
    expect(screen.queryByTestId('font-script-note')).toBeNull();
  });
});

describe('dense pages: a balloon the user pins keeps the size it is drawn at', () => {
  it('keptSizes / keepDrawnSizeOps give the lettered-smaller lines a line-style size override', () => {
    const doc = makeQaDoc('stress');
    const page = doc.pages.find((p) => p.id === 'pg_11')!;
    const plans = planLettering(doc, page, letteringAspect(doc, page), estimateMeasure);
    const dense = plans.filter((p) => typeof p.densityScale === 'number');
    expect(dense.length).toBeGreaterThan(0);
    const sizes = keptSizes(plans);
    for (const p of dense) expect(sizes.get(p.lineId)).toBeCloseTo(p.style.sizeScale * p.densityScale!, 2);
    const ids = dense.slice(0, 2).map((p) => p.lineId);
    const ops = keepDrawnSizeOps(page, plans, ids);
    expect(ops.length).toBeGreaterThan(0);
    expect(ops.flatMap((o) => (o.op === 'line_style' ? o.lineIds : []))).toEqual(expect.arrayContaining(ids));
    // A full-size balloon needs no override.
    const full = plans.find((p) => p.densityScale === undefined);
    if (full) expect(keepDrawnSizeOps(page, plans, [full.lineId])).toEqual([]);
  });
});

describe('touch handles keep clear of the selected balloon', () => {
  const page = { w: 240, h: 360 };
  const H = 1500;
  const overlaps = (a: { x: number; y: number; w: number; h: number }, b: { x: number; y: number; w: number; h: number }) =>
    Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x) > 0.5 && Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y) > 0.5;
  const sq = (p: { x: number; y: number }) => ({ x: p.x - 22, y: p.y - 22, w: 44, h: 44 });

  it('a small balloon: neither the dot nor the grip area overlaps its 44 px target, nor each other, and both stay on the page', () => {
    // A 24 x 6 px caption-sized balloon near the top of the page, its tail tip just below it.
    const plan = { x: 400, y: 60, w: 100, h: 25 };
    const outline = { x: 0.4, y: 0.04, w: 0.1, h: 0.017 };
    const avoid = balloonHitRect(outline, page, 44);
    expect(avoid.w).toBe(44);
    expect(avoid.h).toBe(44);
    const tip = { x: 0.46, y: 0.08 };
    const pos = handlePositions(plan, H, tip, page, 1, 44, avoid);
    expect(overlaps(sq(pos.dot!), avoid)).toBe(false);
    expect(overlaps(sq(pos.grip), avoid)).toBe(false);
    expect(overlaps(sq(pos.dot!), sq(pos.grip))).toBe(false);
    for (const p of [pos.dot!, pos.grip]) {
      expect(p.x).toBeGreaterThanOrEqual(0);
      expect(p.x).toBeLessThanOrEqual(page.w);
      expect(p.y).toBeGreaterThanOrEqual(0);
      expect(p.y).toBeLessThanOrEqual(page.h);
    }
  });

  it('without `avoid` (a mouse) the handles sit at the tip and the right edge as before', () => {
    const plan = { x: 400, y: 600, w: 200, h: 100 };
    const pos = handlePositions(plan, H, { x: 0.3, y: 0.9 }, page, 1);
    expect(pos.dot).toEqual({ x: 0.3 * page.w, y: 0.9 * page.h });
    expect(pos.grip.x).toBeCloseTo(0.6 * page.w + 2, 5);
  });
});

describe('phone lettering sheet height', () => {
  it('leaves the page at least 45 % of the viewport (240 px floor) and never shrinks below its header row', () => {
    // iPhone SE: 667 px tall, the stage starts under a 76 px header.
    expect(inspectorSheetMaxHeight(76, 667)).toBe(667 - 76 - Math.round(667 * 0.45));
    // A short landscape window: the sheet keeps its minimum and scrolls.
    expect(inspectorSheetMaxHeight(120, 343)).toBe(MIN_SHEET_PX);
  });
});
