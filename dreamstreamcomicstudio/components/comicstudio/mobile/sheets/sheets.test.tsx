// Sheets (mobile.md §4, §10.1): presentation per device, detent math and snapping, the stack-aware
// Esc, focus restore, and the back gesture closing the top sheet first.

import React, { useRef, useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { FormFactorProvider, formFactorFor } from '../useFormFactor';
import { resetBackStack, openLayers } from '../backStack';
import { AdaptiveSheet } from './AdaptiveSheet';
import { BottomSheet } from './BottomSheet';
import { SideSheet } from './SideSheet';
import { FLICK_VELOCITY, detentHeights, resolvePresentation, rubber, snapDetent } from './snap';

const PHONE = formFactorFor({ w: 390, h: 844, coarse: true });
const PHONE_LANDSCAPE = formFactorFor({ w: 852, h: 393, coarse: true });
const TABLET = formFactorFor({ w: 820, h: 1180, coarse: true });
const DESKTOP = formFactorFor({ w: 1440, h: 900 });

beforeEach(() => resetBackStack());
afterEach(() => resetBackStack());

describe('resolvePresentation', () => {
  it.each<[string, ReturnType<typeof formFactorFor>, Parameters<typeof resolvePresentation>[1], Parameters<typeof resolvePresentation>[2], string]>([
    ['phone auto', PHONE, 'auto', {}, 'bottom'],
    ['phone landscape auto', PHONE_LANDSCAPE, 'auto', {}, 'bottom'],
    ['touch tablet panel', TABLET, 'auto', { panel: true }, 'side'],
    ['touch tablet, room above', TABLET, 'auto', { anchorRect: { top: 600 } }, 'popover'],
    ['touch tablet, keyboard up (< 280 px above)', TABLET, 'auto', { anchorRect: { top: 200 } }, 'bottom'],
    ['desktop auto', DESKTOP, 'auto', {}, 'popover'],
    ['desktop panel stays a popover', DESKTOP, 'auto', { panel: true }, 'popover'],
    ['explicit side on a phone becomes bottom', PHONE, 'side', {}, 'bottom'],
    ['explicit side on desktop', DESKTOP, 'side', {}, 'side'],
    ['explicit bottom anywhere', DESKTOP, 'bottom', {}, 'bottom'],
    ['explicit popover anywhere', PHONE, 'popover', {}, 'popover']
  ])('%s → %s', (_label, ff, requested, opts, expected) => {
    expect(resolvePresentation(ff, requested, opts)).toBe(expected);
  });
});

describe('detents and snapping (pure)', () => {
  it('detentHeights: peek ≥ 160, half, full, content capped at full, fractions and px; sorted and unique', () => {
    expect(detentHeights(['full', 'peek', 'half'], 800, 0)).toEqual([200, 400, 800]);
    expect(detentHeights(['peek'], 500, 0)).toEqual([160]);
    expect(detentHeights(['content'], 800, 1200)).toEqual([800]);
    expect(detentHeights(['content', 0.5, 300], 800, 300)).toEqual([300, 400]);
    expect(detentHeights(undefined, 800, 240)).toEqual([240]);
  });

  it('snapDetent: nearest when slow, one step in the flick direction when fast, dismiss below the lowest', () => {
    const hs = [200, 400, 800];
    expect(snapDetent(380, 0, hs)).toBe(1);
    expect(snapDetent(650, 0, hs)).toBe(2);
    expect(snapDetent(390, FLICK_VELOCITY + 1, hs)).toBe(0); // flick down from ~half → peek
    expect(snapDetent(390, -(FLICK_VELOCITY + 1), hs)).toBe(1); // flick up from just below half → half
    expect(snapDetent(410, -(FLICK_VELOCITY + 1), hs)).toBe(2); // flick up from half → full
    expect(snapDetent(190, FLICK_VELOCITY + 1, hs)).toBe(-1); // flick down from the lowest → dismiss
    expect(snapDetent(190, FLICK_VELOCITY + 1, hs, { dismissible: false })).toBe(0);
    expect(snapDetent(60, 0, hs)).toBe(-1); // dragged well below the lowest
    expect(snapDetent(60, 0, hs, { dismissible: false })).toBe(0);
  });

  it('rubber resists past the bounds', () => {
    expect(rubber(110, 0, 100)).toBeCloseTo(103.5);
    expect(rubber(-10, 0, 100)).toBeCloseTo(-3.5);
    expect(rubber(50, 0, 100)).toBe(50);
  });
});

const Harness: React.FC<{ ff: ReturnType<typeof formFactorFor>; presentation?: 'auto' | 'bottom' | 'side' | 'popover'; panel?: boolean }> = ({ ff, presentation, panel }) => {
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLButtonElement>(null);
  return (
    <FormFactorProvider value={ff}>
      <button ref={anchor} type="button" onClick={() => setOpen(true)}>
        Open
      </button>
      <AdaptiveSheet open={open} onClose={() => setOpen(false)} label="Options" title="Options" anchorRef={anchor} presentation={presentation} panel={panel}>
        <button type="button">Inside</button>
      </AdaptiveSheet>
    </FormFactorProvider>
  );
};

describe('AdaptiveSheet', () => {
  it.each<[string, ReturnType<typeof formFactorFor>, boolean | undefined, string]>([
    ['phone', PHONE, undefined, 'bottom'],
    ['touch tablet, panel', TABLET, true, 'side'],
    ['desktop', DESKTOP, undefined, 'popover']
  ])('presents as the right sheet on a %s', (_l, ff, panel, kind) => {
    render(<Harness ff={ff} panel={panel} />);
    fireEvent.click(screen.getByRole('button', { name: 'Open' }));
    expect(screen.getByRole(kind === 'side' ? 'region' : 'dialog', { name: 'Options' })).toHaveAttribute('data-sheet', kind);
  });

  it('touch tablets: a header popover (opens below) stays a popover even though its anchor is at the top', () => {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ left: 700, right: 744, top: 6, bottom: 50, width: 44, height: 44, x: 700, y: 6, toJSON: () => ({}) } as DOMRect);
    const Header: React.FC = () => {
      const anchor = useRef<HTMLButtonElement>(null);
      return (
        <FormFactorProvider value={TABLET}>
          <button ref={anchor} type="button">
            Quality
          </button>
          <AdaptiveSheet open onClose={vi.fn()} label="Quality" anchorRef={anchor} placement="below" align="end">
            <p>tiers</p>
          </AdaptiveSheet>
          <AdaptiveSheet open onClose={vi.fn()} label="Format" anchorRef={anchor} strategy="absolute">
            <p>panel above the composer</p>
          </AdaptiveSheet>
        </FormFactorProvider>
      );
    };
    render(<Header />);
    expect(screen.getByRole('dialog', { name: 'Quality' })).toHaveAttribute('data-sheet', 'popover');
    // The same anchor with a panel that opens ABOVE it and no room there (keyboard up): a bottom sheet.
    expect(screen.getByRole('dialog', { name: 'Format' })).toHaveAttribute('data-sheet', 'bottom');
    vi.restoreAllMocks();
  });

  it('a desktop popover is portalled and clamped inside the viewport', () => {
    render(<Harness ff={DESKTOP} />);
    fireEvent.click(screen.getByRole('button', { name: 'Open' }));
    const sheet = screen.getByRole('dialog', { name: 'Options' });
    expect(sheet.parentElement).toBe(document.body);
    expect(sheet.className).toContain('fixed');
  });

  it('bottom sheet: Esc closes it, focus returns to the opener, and it registers a back layer', async () => {
    render(<Harness ff={PHONE} />);
    const opener = screen.getByRole('button', { name: 'Open' });
    opener.focus();
    fireEvent.click(opener);
    expect(openLayers()).toEqual(['sheet:Options']);
    const sheet = screen.getByRole('dialog', { name: 'Options' });
    expect(sheet).toHaveAttribute('aria-modal', 'true');
    expect(sheet.style.bottom).toBe('var(--kb, 0px)');
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(screen.queryByRole('dialog', { name: 'Options' })).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  it('the back gesture (popstate) closes the open sheet instead of leaving the page', async () => {
    render(<Harness ff={PHONE} />);
    fireEvent.click(screen.getByRole('button', { name: 'Open' }));
    expect(screen.getByRole('dialog', { name: 'Options' })).toBeInTheDocument();
    await act(async () => {
      window.history.back();
      await new Promise((r) => setTimeout(r, 30));
    });
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Options' })).toBeNull());
  });

  it('Esc closes only the top sheet of a stack', () => {
    const Stack: React.FC = () => {
      const [a, setA] = useState(true);
      const [b, setB] = useState(true);
      return (
        <FormFactorProvider value={PHONE}>
          <BottomSheet open={a} onClose={() => setA(false)} label="Lower">
            <p>lower</p>
          </BottomSheet>
          <BottomSheet open={b} onClose={() => setB(false)} label="Upper">
            <p>upper</p>
          </BottomSheet>
        </FormFactorProvider>
      );
    };
    render(<Stack />);
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(screen.queryByRole('dialog', { name: 'Upper' })).toBeNull();
    expect(screen.getByRole('dialog', { name: 'Lower' })).toBeInTheDocument();
  });

  it('a non-dismissible bottom sheet ignores Esc and the scrim', () => {
    const onClose = vi.fn();
    render(
      <FormFactorProvider value={PHONE}>
        <BottomSheet open onClose={onClose} label="Locked" dismissible={false}>
          <p>x</p>
        </BottomSheet>
      </FormFactorProvider>
    );
    fireEvent.keyDown(document.body, { key: 'Escape' });
    fireEvent.click(document.querySelector('[data-sheet-scrim]') as Element);
    expect(onClose).not.toHaveBeenCalled();
  });

  it('a multi-detent sheet cycles detents from its grabber (keyboard-accessible resize)', () => {
    render(
      <FormFactorProvider value={PHONE}>
        <BottomSheet open onClose={vi.fn()} label="Tools" detents={['peek', 'half', 'full']} modal={false}>
          <p>tools</p>
        </BottomSheet>
      </FormFactorProvider>
    );
    const sheet = screen.getByRole('region', { name: 'Tools' });
    expect(sheet).toHaveAttribute('data-detent', 'peek');
    fireEvent.click(screen.getByRole('button', { name: 'Resize sheet' }));
    expect(sheet).toHaveAttribute('data-detent', 'half');
    // Non-modal: no scrim, the canvas behind stays usable.
    expect(document.querySelector('[data-sheet-scrim]')).toBeNull();
  });
});

describe('SideSheet', () => {
  it('modal side sheets trap focus behind a scrim; non-modal ones are labelled regions', () => {
    const onClose = vi.fn();
    const { rerender } = render(
      <FormFactorProvider value={TABLET}>
        <SideSheet open onClose={onClose} label="Settings" modal>
          <button type="button">Inside</button>
        </SideSheet>
      </FormFactorProvider>
    );
    expect(screen.getByRole('dialog', { name: 'Settings' })).toHaveAttribute('aria-modal', 'true');
    fireEvent.click(document.querySelector('[data-sheet-scrim]') as Element);
    expect(onClose).toHaveBeenCalled();
    rerender(
      <FormFactorProvider value={TABLET}>
        <SideSheet open onClose={onClose} label="Inspector">
          <button type="button">Inside</button>
        </SideSheet>
      </FormFactorProvider>
    );
    expect(screen.getByRole('region', { name: 'Inspector' })).toBeInTheDocument();
    expect(document.querySelector('[data-sheet-scrim]')).toBeNull();
  });
});
