import React from 'react';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { act, render, screen } from '@testing-library/react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppLoader, BOOT_LABEL, ContentLoader } from './AppLoader';
import { BOOT, SPLASH_BAR_SELECTOR } from './bootGeometry';
import { splashSweepDelay } from './bootPhase';
import { resetBackendWakeForTests, trackBackendWake, WAKE_HINT_AFTER_MS } from './backendWake';
import { WAKE_HINT_TEXT } from './WakeHint';

// Under jsdom import.meta.url is not a file URL; vitest runs from the app root (as components/ds/motion.test.tsx).
const INDEX_HTML = readFileSync(path.join(process.cwd(), 'index.html'), 'utf8');
/** index.html's #root, splash and all, as the browser has it before the bundle runs. */
const SPLASH_ROOT = INDEX_HTML.slice(INDEX_HTML.indexOf('<div id="root">'), INDEX_HTML.indexOf('<!-- Watchdog'));

const pending = () => new Promise<never>(() => undefined);

beforeEach(() => resetBackendWakeForTests());
afterEach(() => {
  resetBackendWakeForTests();
  vi.useRealTimers();
  document.body.innerHTML = '';
});

describe('AppLoader: the boot screen (the splash, redrawn in React)', () => {
  it('is one live region that says what is loading, with the brand hidden from assistive tech', () => {
    render(<AppLoader />);
    const status = screen.getByRole('status');
    expect(status).toHaveAttribute('aria-live', 'polite');
    expect(status).toHaveTextContent(BOOT_LABEL);
    expect(screen.getByText(BOOT_LABEL)).toHaveClass('sr-only');
    const lockup = status.querySelector('[data-slot="boot-lockup"]')!;
    expect(lockup).toHaveAttribute('aria-hidden', 'true');
    expect(lockup).toHaveTextContent('DreamStream Studio');
    expect(status.querySelector('[data-slot="boot-track"]')).toHaveAttribute('aria-hidden', 'true');
  });

  it('draws the splash geometry (bootGeometry.ts), full screen on the page canvas', () => {
    const { container } = render(<AppLoader />);
    const root = container.firstElementChild as HTMLElement;
    expect(root.className).toMatch(/\bfixed\b/);
    expect(root.className).toMatch(/\binset-0\b/);
    expect(root.className).toContain('bg-ds-canvas');
    expect(root.className).toContain('text-ds-ink');
    const logo = root.querySelector<HTMLElement>('.ds-logo')!;
    expect(logo.style.getPropertyValue('--ds-logo-mark-size')).toBe(`${BOOT.markPx}px`);
    expect(logo.style.getPropertyValue('--ds-logo-text-size')).toBe(`${BOOT.wordPx}px`);
    expect(logo.style.getPropertyValue('--ds-logo-gap')).toBe(`${BOOT.lockupGapPx}px`);
    const track = root.querySelector<HTMLElement>('[data-slot="boot-track"]')!;
    expect(track.style.width).toBe(`${BOOT.trackWidthPx}px`);
    expect(track.style.height).toBe(`${BOOT.trackHeightPx}px`);
    expect((track.parentElement as HTMLElement).style.gap).toBe(`${BOOT.stackGapPx}px`);
    const bar = root.querySelector<HTMLElement>('[data-slot="boot-bar"]')!;
    expect(bar.style.width).toBe(`${BOOT.barShare * 100}%`);
    // The same sweep as the splash and .ds-progress-indeterminate, and it holds still under reduced motion.
    expect(bar.className).toContain(`animate-[ds-progress-indeterminate_${BOOT.sweepMs}ms_var(--ds-ease)_infinite]`);
    expect(bar.className).toContain('motion-reduce:animate-none');
  });

  it('spells no hue and no legacy comic class', () => {
    const { container } = render(<AppLoader label="Opening DreamStream…" />);
    const html = container.innerHTML;
    expect(html).not.toMatch(/brand-|border-black|shadow-comic|font-display|bg-slate|text-slate/);
    // The only literals are the mark's mask black and white (components/brand).
    const hexes = [...html.matchAll(/#[0-9a-f]{3,8}\b/gi)].map((m) => m[0].toLowerCase());
    expect(hexes.filter((h) => h !== '#fff' && h !== '#000')).toEqual([]);
  });

  it('shows a given label under the bar, and then reads it instead of the generic one', () => {
    render(<AppLoader label="Opening DreamStream…" />);
    expect(screen.getByRole('status')).toHaveTextContent('Opening DreamStream…');
    expect(screen.queryByText(BOOT_LABEL)).toBeNull();
  });

  it('says "Waking up the studio…" when the status probe is slow, and drops it when the server answers', async () => {
    vi.useFakeTimers();
    let answer!: (v: unknown) => void;
    trackBackendWake(new Promise((r) => (answer = r)));
    render(<AppLoader />);
    expect(screen.queryByText(WAKE_HINT_TEXT)).toBeNull();
    act(() => {
      vi.advanceTimersByTime(WAKE_HINT_AFTER_MS);
    });
    expect(screen.getByRole('status')).toHaveTextContent(WAKE_HINT_TEXT);
    await act(async () => {
      answer({ status: 'ok' });
      await Promise.resolve();
    });
    expect(screen.queryByText(WAKE_HINT_TEXT)).toBeNull();
  });
});

describe('the splash hand-off', () => {
  const mountSplash = () => {
    document.body.innerHTML = SPLASH_ROOT;
    return document.getElementById('root')!;
  };

  it('index.html’s splash is in #root with the bar AppLoader reads its phase from', () => {
    mountSplash();
    expect(document.querySelector('#root > #app-splash')).not.toBeNull();
    expect(document.querySelector(SPLASH_BAR_SELECTOR)).not.toBeNull();
  });

  it('reads the splash bar’s sweep phase as a negative delay (and 0ms whenever it cannot)', () => {
    mountSplash();
    const bar = document.querySelector<HTMLElement>(SPLASH_BAR_SELECTOR)!;
    Object.assign(bar, { getAnimations: () => [{ currentTime: BOOT.sweepMs * 3 + 650 }] });
    expect(splashSweepDelay()).toBe('-650ms');
    Object.assign(bar, { getAnimations: () => [{ currentTime: null }] });
    expect(splashSweepDelay()).toBe('0ms');
    Object.assign(bar, {
      getAnimations: () => {
        throw new Error('no');
      }
    });
    expect(splashSweepDelay()).toBe('0ms');
    document.body.innerHTML = '';
    expect(splashSweepDelay()).toBe('0ms');
    expect(splashSweepDelay(undefined)).toBe('0ms');
  });

  it('React replaces the splash with AppLoader, which carries on the sweep where the splash was', async () => {
    const rootEl = mountSplash();
    const bar = document.querySelector<HTMLElement>(SPLASH_BAR_SELECTOR)!;
    Object.assign(bar, { getAnimations: () => [{ currentTime: 900 }] });
    const root = createRoot(rootEl);
    await act(async () => {
      root.render(<AppLoader />);
    });
    expect(document.getElementById('app-splash')).toBeNull();
    const loader = rootEl.querySelector('[data-slot="app-loader"]');
    expect(loader).not.toBeNull();
    expect(rootEl.children).toHaveLength(1);
    expect(rootEl.querySelector<HTMLElement>('[data-slot="boot-bar"]')!.style.animationDelay).toBe('-900ms');
    await act(async () => root.unmount());
  });

  it('without a splash (a later boot screen) the bar simply starts from the left', () => {
    render(<AppLoader label="Opening DreamStream…" />);
    expect(document.querySelector<HTMLElement>('[data-slot="boot-bar"]')!.style.animationDelay).toBe('0ms');
  });
});

describe('ContentLoader: a loader inside the content area', () => {
  it('says what is opening in words, beside the destination studio’s looping mark', () => {
    render(<ContentLoader label="Opening the comic…" studio="comic" />);
    const status = screen.getByRole('status');
    expect(status).toHaveAttribute('aria-live', 'polite');
    expect(status).toHaveTextContent('Opening the comic…');
    const mark = status.querySelector('svg')!;
    expect(mark).toHaveAttribute('data-studio', 'comic');
    expect(mark).toHaveAttribute('aria-hidden', 'true');
    expect(mark.getAttribute('class')).toContain('ds-logo-mark--loading');
    expect(screen.getByText('Opening the comic…')).toHaveClass('ds-shimmer-text');
  });

  it('is never a full-screen takeover: it fills the content area, or the screen only on a view without a header', () => {
    const { rerender } = render(<ContentLoader label="Opening the comic…" />);
    const el = () => screen.getByRole('status');
    expect(el()).toHaveAttribute('data-fill', 'content');
    expect(el().className).not.toMatch(/\bfixed\b/);
    expect(el().className).toContain('min-h-[calc(var(--app-h,100dvh)-4rem)]');
    rerender(<ContentLoader label="Opening the comic…" fill="viewport" />);
    expect(el()).toHaveAttribute('data-fill', 'viewport');
    expect(el().className).not.toMatch(/\bfixed\b/);
    expect(el().className).toContain('min-h-[var(--app-h,100dvh)]');
  });

  it('fades in after a beat (CSS only), so a fast load never flashes it', () => {
    render(<ContentLoader label="Loading…" />);
    expect(screen.getByRole('status').className).toContain('ds-fade-in');
    expect(screen.getByRole('status').className).toContain('[animation-delay:150ms]');
  });

  it('shows the wake hint while the server is cold', () => {
    vi.useFakeTimers();
    trackBackendWake(pending());
    render(<ContentLoader label="Opening the comic…" />);
    act(() => {
      vi.advanceTimersByTime(WAKE_HINT_AFTER_MS);
    });
    expect(screen.getByRole('status')).toHaveTextContent(WAKE_HINT_TEXT);
  });
});
