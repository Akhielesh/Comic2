// PopSheet (visualqa P0-4, §6): header popovers can never start off-screen on a phone again — the fixed
// strategy is placed from the anchor's rect and clamped to the viewport with 12 px gutters.

import React, { useRef, useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { PopSheet, SHEET_GUTTER, SlideOver, clampSheetX, placeSheet } from './PopSheet';

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
