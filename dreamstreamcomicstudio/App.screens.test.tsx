/**
 * The app shell's own screens (DS-2): the full-screen loader, the product gate, the could-not-open screen
 * and the root's page are on the DS states and recipes, with no legacy kit class and no raw hue.
 */
import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('./services/liveLink', () => ({ openLiveApp: vi.fn(async () => undefined) }));

import { AppLoader, LEGACY_PAPER_VIEWS, ProductGateScreen, SystemErrorScreen, appRootSurface } from './App';
import { CANVAS_BG } from './components/chat/studioDesign';
import { openLiveApp } from './services/liveLink';

/** Every class on every element under `root`. */
const classesIn = (root: Element): string[] => [root, ...root.querySelectorAll('*')].flatMap((el) => (el.getAttribute('class') ?? '').split(/\s+/)).filter(Boolean);
/** The legacy kit (DS-0's legacyKit guard) and the raw hues this shell used to spell. */
const LEGACY = /^(?:[\w-]+:)*(?:border-black|shadow-comic|font-comic|font-display|(?:bg|text|border)-brand-\w+|bg-slate-\d+|text-slate-\d+|bg-zinc-\d+|(?:bg|text|border)-red-\d+(?:\/\d+)?|animate-pulse)$/;

describe('AppLoader', () => {
  it('is the DS loading state on the canvas, saying what loads', () => {
    const { container } = render(<AppLoader label="Opening project…" />);
    const loader = container.querySelector('[data-slot="app-loader"]')!;
    expect(loader).toHaveAttribute('aria-busy', 'true');
    expect(loader.className).toContain(CANVAS_BG);
    const status = screen.getByRole('status');
    expect(status).toHaveAttribute('data-slot', 'loading-state');
    expect(status).toHaveTextContent('Opening project…');
    expect(classesIn(container).filter((c) => LEGACY.test(c))).toEqual([]);
  });

  it('says "Loading…" by default', () => {
    render(<AppLoader />);
    expect(screen.getByRole('status')).toHaveTextContent('Loading…');
  });
});

describe('ProductGateScreen', () => {
  it('is the DS empty state: what is missing, why, and the way home', () => {
    const onGoHome = vi.fn();
    const { container } = render(<ProductGateScreen productLabel="Comic Studio" canStream={false} onGoHome={onGoHome} />);
    expect(container.querySelector('[data-slot="empty-state"]')).not.toBeNull();
    expect(screen.getByRole('heading', { level: 2 })).toHaveTextContent('This account doesn’t include Comic Studio');
    expect(screen.getByText(/Ask your admin to enable Comic Studio for you/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Open Stream Studio' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Back to home' }));
    expect(onGoHome).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: 'Back to home' })).toHaveAttribute('data-slot', 'button');
    expect(classesIn(container).filter((c) => LEGACY.test(c))).toEqual([]);
  });

  it('offers Stream Studio first when the account has it', () => {
    render(<ProductGateScreen productLabel="Chat Studio" canStream onGoHome={() => undefined} />);
    const buttons = screen.getAllByRole('button');
    expect(buttons.map((b) => b.textContent)).toEqual(['Open Stream Studio', 'Back to home']);
    fireEvent.click(buttons[0]);
    expect(openLiveApp).toHaveBeenCalledWith('/live.html');
  });
});

describe('SystemErrorScreen', () => {
  it('is the DS error state on the canvas: the reason, Try again and Dismiss, never a red slab', () => {
    const onRetry = vi.fn();
    const onDismiss = vi.fn();
    const { container } = render(<SystemErrorScreen message="Comic not found or private." onRetry={onRetry} onDismiss={onDismiss} />);
    const alert = screen.getByRole('alert');
    expect(alert).toHaveAttribute('data-slot', 'error-state');
    expect(alert).toHaveTextContent('That didn’t open');
    expect(alert).toHaveTextContent('Comic not found or private.');
    expect(screen.queryByText(/System Error/i)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(onDismiss).toHaveBeenCalledTimes(1);
    expect(container.querySelector('[data-slot="system-error"]')!.className).toContain(CANVAS_BG);
    expect(classesIn(container).filter((c) => LEGACY.test(c))).toEqual([]);
  });
});

describe('the root page under the views', () => {
  it('is the canvas token, except for the legacy views that still need their light page', () => {
    for (const view of ['home', 'chat', 'auth', 'auth-callback', 'gallery', 'settings', 'comicstudio', 'publiccomic', 'shared']) {
      expect(appRootSurface(view), view).toBe(CANVAS_BG);
    }
    expect([...LEGACY_PAPER_VIEWS].sort()).toEqual(['dashboard', 'editor', 'fontlab', 'learn']);
    for (const view of LEGACY_PAPER_VIEWS) expect(appRootSurface(view), view).not.toBe(CANVAS_BG);
  });
});
