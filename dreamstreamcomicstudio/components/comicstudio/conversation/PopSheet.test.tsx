// PopSheet (visualqa P0-4, §6): header popovers can never start off-screen on a phone again — the fixed
// strategy is placed from the anchor's rect and clamped to the viewport with 12 px gutters.

import React, { useRef, useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { PopSheet, SHEET_GUTTER, SlideOver, clampSheetX, placeSheet, segmentBoundsFor } from './PopSheet';
import { AdaptiveSheet } from '../mobile/sheets/AdaptiveSheet';
import { FormFactorProvider, formFactorFor } from '../mobile/useFormFactor';

describe('clampSheetX / placeSheet (pure)', () => {
  it('a 366 px sheet right-aligned to a button at x=206 on a 390 phone starts at the 12 px gutter', () => {
    expect(clampSheetX(206, 366, 390)).toBe(12);
  });
  it('never runs past the right edge either', () => {
    expect(clampSheetX(1000, 200, 390)).toBe(390 - 200 - SHEET_GUTTER);
  });
  it('places below, flips above when there is clearly more room there, and caps the width to the viewport', () => {
    const anchor = { left: 300, right: 340, top: 10, bottom: 50 };
    expect(placeSheet(anchor, { width: 300, height: 200 }, { width: 390, height: 844 }, 'below', 'end')).toMatchObject({
      left: 40,
      top: 58,
      placement: 'below'
    });
    const low = { left: 20, right: 60, top: 780, bottom: 820 };
    expect(placeSheet(low, { width: 300, height: 300 }, { width: 390, height: 844 }, 'below', 'start').placement).toBe('above');
    const wide = placeSheet(anchor, { width: 900, height: 100 }, { width: 390, height: 844 }, 'below', 'stretch');
    expect(wide.width).toBeLessThanOrEqual(390 - SHEET_GUTTER * 2);
  });
});

describe('dual-screen devices: a popover stays on the screen of its anchor (sheets-span-the-fold)', () => {
  const SEGS = [
    { left: 0, right: 441 },
    { left: 441, right: 882 }
  ];
  it('segmentBoundsFor picks the screen under the anchor; one screen → no bounds', () => {
    expect(segmentBoundsFor({ left: 600, right: 700 }, SEGS)).toEqual({ left: 441, right: 882 });
    expect(segmentBoundsFor({ left: 40, right: 84 }, SEGS)).toEqual({ left: 0, right: 441 });
    expect(segmentBoundsFor({ left: 600, right: 700 }, null)).toBeNull();
    expect(segmentBoundsFor({ left: 600, right: 700 }, [{ left: 0, right: 882 }])).toBeNull();
  });

  it('the 400 px Quality sheet under a header button at x≈690 lands right of the fold (it spanned 246–646)', () => {
    const anchor = { left: 600, right: 690, top: 10, bottom: 54 };
    const vp = { width: 882, height: 1104 };
    const free = placeSheet(anchor, { width: 400, height: 300 }, vp, 'below', 'end');
    expect(free.left).toBeLessThan(441); // the old placement crossed the fold
    const p = placeSheet(anchor, { width: 400, height: 300 }, vp, 'below', 'end', 8, SHEET_GUTTER, segmentBoundsFor(anchor, SEGS));
    expect(p.left).toBeGreaterThanOrEqual(441 + SHEET_GUTTER);
    expect(p.left + (p.width ?? 400)).toBeLessThanOrEqual(882 - SHEET_GUTTER);
    expect(p.maxWidth).toBe(441 - SHEET_GUTTER * 2);
    // Wider than the screen: it shrinks to the screen, never across the hinge.
    const wide = placeSheet(anchor, { width: 600, height: 300 }, vp, 'below', 'end', 8, SHEET_GUTTER, { left: 441, right: 882 });
    expect(wide.width).toBe(441 - SHEET_GUTTER * 2);
    expect(wide.left).toBe(441 + SHEET_GUTTER);
  });

  it('AdaptiveSheet passes the side-by-side segments to its popover', () => {
    const rect = (left: number, width: number) => ({ left, right: left + width, top: 0, bottom: 1104, width, height: 1104, x: left, y: 0, toJSON: () => ({}) }) as DOMRectReadOnly;
    const ff = formFactorFor({ w: 882, h: 1104, coarse: false, segments: { count: 2, axis: 'horizontal', rects: [rect(0, 441), rect(441, 441)], hinge: { start: 441, end: 441 } } });
    const Probe: React.FC = () => {
      const a = useRef<HTMLButtonElement>(null);
      return (
        <div>
          <button ref={a} type="button">
            Quality
          </button>
          <AdaptiveSheet open onClose={() => undefined} label="Quality" anchorRef={a} placement="below" align="end">
            <p>tiers</p>
          </AdaptiveSheet>
        </div>
      );
    };
    const btnRect = { left: 600, right: 690, top: 10, bottom: 54, width: 90, height: 44, x: 600, y: 10, toJSON: () => ({}) } as DOMRect;
    const spy = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(btnRect);
    const original = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetWidth');
    Object.defineProperty(HTMLElement.prototype, 'offsetWidth', { configurable: true, get: () => 400 });
    try {
      render(
        <FormFactorProvider value={ff}>
          <Probe />
        </FormFactorProvider>
      );
      const sheet = screen.getByRole('dialog', { name: 'Quality' });
      expect(parseFloat(sheet.style.left)).toBeGreaterThanOrEqual(441 + SHEET_GUTTER);
      expect(sheet.style.maxWidth).toBe(`${441 - SHEET_GUTTER * 2}px`);
    } finally {
      spy.mockRestore();
      if (original) Object.defineProperty(HTMLElement.prototype, 'offsetWidth', original);
    }
  });
});

const Harness: React.FC<{ strategy?: 'fixed' | 'absolute' }> = ({ strategy }) => {
  const [open, setOpen] = useState(true);
  const anchor = useRef<HTMLButtonElement>(null);
  return (
    <div>
      <button ref={anchor} type="button" onClick={() => setOpen((o) => !o)}>
        Quality
      </button>
      <PopSheet open={open} onClose={() => setOpen(false)} label="Quality" anchorRef={anchor} placement="below" align="end" strategy={strategy}>
        <button type="button">Draft</button>
      </PopSheet>
      <button type="button">Outside</button>
    </div>
  );
};

describe('PopSheet', () => {
  it("strategy='fixed' is portalled, position:fixed, and clamped to the viewport", () => {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ left: 154, right: 206, top: 8, bottom: 52, width: 52, height: 44, x: 154, y: 8, toJSON: () => ({}) } as DOMRect);
    render(<Harness strategy="fixed" />);
    const sheet = screen.getByRole('dialog', { name: 'Quality' });
    expect(sheet.parentElement).toBe(document.body);
    expect(sheet.className).toContain('fixed');
    expect(parseFloat(sheet.style.left)).toBeGreaterThanOrEqual(SHEET_GUTTER);
    expect(sheet.style.maxWidth).toBe(`calc(100vw - ${SHEET_GUTTER * 2}px)`);
    vi.restoreAllMocks();
  });

  it('closes on Escape and on a pointer down outside (not on its anchor)', () => {
    render(<Harness />);
    expect(screen.getByRole('dialog', { name: 'Quality' })).toBeInTheDocument();
    fireEvent.pointerDown(screen.getByRole('button', { name: 'Outside' }));
    expect(screen.queryByRole('dialog', { name: 'Quality' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Quality' }));
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(screen.queryByRole('dialog', { name: 'Quality' })).toBeNull();
  });

  it('SlideOver is safe-area aware', () => {
    render(
      <SlideOver open onClose={vi.fn()} title="Comic settings">
        <p>x</p>
      </SlideOver>
    );
    const panel = screen.getByRole('dialog', { name: 'Comic settings' });
    // (jsdom drops `min()` from inline styles, so only the safe-area padding is asserted here.)
    expect(panel.style.paddingTop).toBe('var(--sa-top, 0px)');
  });
});
