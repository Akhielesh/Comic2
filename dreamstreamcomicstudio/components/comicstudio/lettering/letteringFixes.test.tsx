// Lettering fixes from the v5 bug hunt and the device matrix, each written so it fails on the code before
// the fix:
//   LE-7   Tidy: no op when only the stored order differs; a line with empty text keeps its balloon;
//   LE-10  Easy font chips on a non-Latin comic: only faces that can write it, with a VISIBLE reason;
//   dense pages: pinning a balloon keeps the size it is drawn at (a line-style size override);
//   touch: the tail dot and width grip keep their 44 px areas off the selected balloon's own target.

import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { makeSampleDoc } from '../board/__fixtures__/sampleDoc';
import { makeQaDoc } from '../testing/qaFixtures';
import { applyOps } from '../../../shared/comic/ops';
import { estimateMeasure, letteringAspect, planLettering } from '../../../shared/comic/lettering/layout';
import { resolveLetteringFont, fontCoversLanguage } from '../../../shared/comic/lettering/fonts';
import { keepDrawnSizeOps, keptSizes, sameBalloons, tidyOps } from './styleOps';
import { CROWDED_COPY, LetteringInspector, densityNote } from './LetteringInspector';
import { resolvePlacements, withDrawnGeometry } from './useLetterPlans';
import type { DocOp } from '../../../shared/comic/ops';
import { FontPicker, easyFontsFor, EASY_FONTS } from './FontPicker';
import { BalloonLayer, balloonHitRect, handlePositions } from '../board/BalloonLayer';
import { inspectorSheetMaxHeight, MIN_SHEET_PX, PHONE_SHEET_OPEN_MIN_H, selectionSlide, toolsSheetOpenAtStart } from '../board/PageEditor';

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

describe('dense pages: Lock and "Keep here" keep the drawn size too (one patch with the pin)', () => {
  const stressPg11 = () => {
    const doc = makeQaDoc('stress');
    const page = doc.pages.find((p) => p.id === 'pg_11')!;
    const aspect = letteringAspect(doc, page);
    const H = 1000 / aspect;
    const plans = planLettering(doc, page, aspect, estimateMeasure);
    const placements = withDrawnGeometry(resolvePlacements(doc, page, aspect, estimateMeasure), plans, H);
    return { doc, page, plans, placements, H };
  };
  const renderInspector = (lineId: string, mode: 'easy' | 'pro', editionLang?: string) => {
    const { doc, page, plans, placements, H } = stressPg11();
    const apply = vi.fn();
    render(
      <LetteringInspector
        doc={doc}
        page={page}
        lineIds={[lineId]}
        plans={plans}
        placements={placements}
        H={H}
        apply={apply}
        onEditText={vi.fn()}
        onDeselect={vi.fn()}
        mode={mode}
        onModeChange={vi.fn()}
        canPro
        anchor={{ left: 100, top: 100, right: 200, bottom: 160 }}
        compact={false}
        onClose={vi.fn()}
        editionLang={editionLang}
      />
    );
    return { apply, plans };
  };
  const sizeOp = (ops: DocOp[], id: string) => ops.find((o) => o.op === 'line_style' && o.lineIds.includes(id)) as Extract<DocOp, { op: 'line_style' }> | undefined;

  it('"Keep here" on a crowded dense balloon pins it AND keeps its size, in the same patch', () => {
    const { plans } = stressPg11();
    const target = plans.find((p) => p.crowded && p.densityScale && p.crowdedReason !== 'overlap')!;
    expect(target, 'stress pg_11 has a crowded balloon lettered smaller').toBeTruthy();
    const { apply } = renderInspector(target.lineId, 'easy');
    fireEvent.click(screen.getByRole('button', { name: 'Keep here' }));
    const [ops, opts] = apply.mock.calls.at(-1)!;
    expect(opts).toEqual({ label: 'Keep balloon here' });
    expect(ops[0]).toMatchObject({ op: 'balloon', lineId: target.lineId, patch: { pinned: true } });
    expect(sizeOp(ops, target.lineId)?.patch.sizeScale).toBeCloseTo(target.style.sizeScale * target.densityScale!, 2);
  });

  it('the Pro panel Lock keeps the size too; Unlock does not touch it; a translated edition never sends a line style', () => {
    const { plans } = stressPg11();
    const target = plans.find((p) => p.densityScale && !p.locked)!;
    const { apply } = renderInspector(target.lineId, 'pro');
    fireEvent.click(screen.getByRole('tab', { name: /Arrange/i }));
    fireEvent.click(screen.getByRole('button', { name: /^Lock$/ }));
    const [ops, opts] = apply.mock.calls.at(-1)!;
    expect(opts).toMatchObject({ label: 'Lock balloon' });
    expect(ops.some((o: DocOp) => o.op === 'balloon' && o.lineId === target.lineId && (o.patch as { locked?: boolean }).locked === true)).toBe(true);
    expect(sizeOp(ops, target.lineId)).toBeTruthy();
    cleanup();
    // A translated edition never sends a line style: lock is shared by every language and belongs to the original
    // (LE-3), so the edition offers it disabled with the reason instead of half-applying it.
    const edition = renderInspector(target.lineId, 'pro', 'hi');
    fireEvent.click(screen.getByRole('tab', { name: /Arrange/i }));
    const lock = screen.getByRole('button', { name: /^Lock$/ });
    expect(lock).toBeDisabled();
    expect(lock.getAttribute('title')).toMatch(/belong to/);
    fireEvent.click(lock);
    expect(edition.apply).not.toHaveBeenCalled();
  });

  it('the inspector says why honestly: a moved balloon never "overlaps another"; a dense balloon explains its size in visible text', () => {
    const { plans } = stressPg11();
    const moved = plans.find((p) => p.crowded && (p.crowdedReason === 'moved' || p.crowdedReason === 'outside'))!;
    expect(moved).toBeTruthy();
    renderInspector(moved.lineId, 'easy');
    const reason = screen.getByTestId('crowded-reason');
    expect(reason.textContent).not.toMatch(/overlaps another/);
    expect(reason.textContent).toBe(CROWDED_COPY[moved.crowdedReason!]);
    expect(screen.getByTestId('density-note').textContent).toBe(densityNote(moved.densityScale!));
    expect(screen.getByTestId('density-note').textContent).toMatch(/\d+%/);
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

  it('neither handle lands on a NEIGHBOUR’s target either (iPhone SE: the grip sat on the next balloon, the dot on the caption below)', () => {
    const plan = { x: 100, y: 60, w: 250, h: 25 };
    const outline = { x: 0.09, y: 0.035, w: 0.27, h: 0.03 };
    const avoid = balloonHitRect(outline, page, 44);
    // A thought balloon right of it and a caption just below its tail.
    const neighbours = [balloonHitRect({ x: 0.4, y: 0.035, w: 0.27, h: 0.07 }, page, 44), balloonHitRect({ x: 0.05, y: 0.2, w: 0.25, h: 0.02 }, page, 44)];
    const pos = handlePositions(plan, H, { x: 0.15, y: 0.17 }, page, 1, 44, avoid, neighbours);
    for (const b of [avoid, ...neighbours]) {
      expect(overlaps(sq(pos.dot!), b)).toBe(false);
      expect(overlaps(sq(pos.grip), b)).toBe(false);
    }
    expect(overlaps(sq(pos.dot!), sq(pos.grip))).toBe(false);
  });

  it('without `avoid` (a mouse) the handles sit at the tip and the right edge as before', () => {
    const plan = { x: 400, y: 600, w: 200, h: 100 };
    const pos = handlePositions(plan, H, { x: 0.3, y: 0.9 }, page, 1);
    expect(pos.dot).toEqual({ x: 0.3 * page.w, y: 0.9 * page.h });
    expect(pos.grip.x).toBeCloseTo(0.6 * page.w + 2, 5);
  });
});

describe('page tools sheet at start', () => {
  it('a short phone opens the editor with the tools closed (unless the user left them open); taller ones and tablets open', () => {
    expect(toolsSheetOpenAtStart(null, 'phone', 659)).toBe(false);
    expect(toolsSheetOpenAtStart('open', 'phone', 659)).toBe(true);
    expect(toolsSheetOpenAtStart(null, 'phone', PHONE_SHEET_OPEN_MIN_H)).toBe(true);
    expect(toolsSheetOpenAtStart('closed', 'phone', 900)).toBe(false);
    expect(toolsSheetOpenAtStart(null, 'tablet-portrait', 600)).toBe(true);
  });
});

describe('phone lettering sheet: the page holds still under the finger', () => {
  it('no slide when the selection is already above the sheet; just enough (12 px clear) when it is covered', () => {
    expect(selectionSlide({ top: 150, bottom: 190 }, 100, 400)).toBe(0);
    expect(selectionSlide({ top: 350, bottom: 420 }, 100, 400)).toBe(32);
  });
  it('never slides the selection’s own top out of the stage', () => {
    expect(selectionSlide({ top: 130, bottom: 520 }, 100, 400)).toBe(22);
    expect(selectionSlide({ top: Number.NaN, bottom: 1 }, 0, 0)).toBe(0);
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

describe('a drag re-plans only the dragged balloon', () => {
  it('an unpinned neighbour the dragged balloon passes over stays where it is drawn until the drop', () => {
    const doc = makeSampleDoc((d) => {
      d.pages[0].balloons = d.pages[0].balloons.map((b) => ({ ...b, pinned: false }));
    });
    const page = doc.pages[0];
    const onBalloonChange = vi.fn();
    const { container } = render(
      <div style={{ position: 'relative', width: 600, height: 900 }}>
        <BalloonLayer doc={doc} page={page} pageWidth={600} pageHeight={900} editable onBalloonChange={onBalloonChange} />
      </div>
    );
    const hit = (id: string) => container.querySelector<HTMLElement>(`[data-testid="balloon-hit"][data-line-id="${id}"]`)!;
    const [a, b] = [...container.querySelectorAll<HTMLElement>('[data-testid="balloon-hit"]')].map((el) => el.getAttribute('data-line-id')!);
    const pos = (id: string) => `${hit(id).style.left}|${hit(id).style.top}`;
    const before = pos(b);
    // Drag `a` right onto `b` (layer rect is 0×0 in jsdom: travel falls back to the 600×900 page).
    const pa = { x: parseFloat(hit(a).style.left) * 6, y: parseFloat(hit(a).style.top) * 9 };
    const pb = { x: parseFloat(hit(b).style.left) * 6, y: parseFloat(hit(b).style.top) * 9 };
    fireEvent.pointerDown(hit(a), { clientX: pa.x, clientY: pa.y, button: 0, pointerType: 'mouse' });
    fireEvent.pointerMove(window, { clientX: pb.x, clientY: pb.y });
    // Mid-drag: `a` moved, `b` did not dodge.
    expect(pos(b)).toBe(before);
    expect(hit(a).style.left).not.toBe(`${pa.x / 6}%`);
    fireEvent.pointerUp(window, { clientX: pb.x, clientY: pb.y });
    expect(onBalloonChange).toHaveBeenCalledTimes(1);
  });
});

describe('long-press vs lift-and-drag on a busy frame', () => {
  it('a drag whose first moves arrive just after the 450 ms mark (held up by a busy frame) moves the balloon, never opens the menu', () => {
    vi.useFakeTimers();
    try {
      const doc = makeSampleDoc();
      const onBalloonMenu = vi.fn();
      const onBalloonChange = vi.fn();
      const { container } = render(
        <div style={{ position: 'relative', width: 600, height: 900 }}>
          <BalloonLayer doc={doc} page={doc.pages[0]} pageWidth={600} pageHeight={900} editable onBalloonChange={onBalloonChange} onBalloonMenu={onBalloonMenu} />
        </div>
      );
      const hit = container.querySelector<HTMLElement>('[data-testid="balloon-hit"][data-line-id="pg_1_l3"]')!;
      fireEvent.pointerDown(hit, { clientX: 300, clientY: 300, pointerType: 'touch', pointerId: 3 });
      // The hold lifts the balloon at 220 ms (no selection yet: the lettering sheet must not rise under the
      // dragging finger); the long-press timer is due at 450 ms…
      act(() => {
        vi.advanceTimersByTime(451);
      });
      expect(hit.getAttribute('aria-pressed')).toBe('false');
      // …and the finger's moves, queued behind the busy frame, are handled before the next frame.
      fireEvent.pointerMove(window, { clientX: 330, clientY: 300, pointerId: 3 });
      fireEvent.pointerMove(window, { clientX: 360, clientY: 300, pointerId: 3 });
      act(() => {
        vi.advanceTimersByTime(40);
      });
      fireEvent.pointerUp(window, { clientX: 360, clientY: 300, pointerId: 3 });
      expect(onBalloonMenu).not.toHaveBeenCalled();
      expect(onBalloonChange).toHaveBeenCalledTimes(1);
      // Put down: now it is the selection.
      expect(container.querySelector('[data-testid="balloon-hit"][data-line-id="pg_1_l3"]')!.getAttribute('aria-pressed')).toBe('true');
    } finally {
      vi.useRealTimers();
    }
  });
});
