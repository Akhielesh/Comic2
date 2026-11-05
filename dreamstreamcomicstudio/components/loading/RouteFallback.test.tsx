import React from 'react';
import { act, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_ROUTE_LOADING, ROUTE_LOADING, RouteFallback, routeLoadingFor } from './RouteFallback';
import { resetBackendWakeForTests, trackBackendWake, WAKE_HINT_AFTER_MS } from './backendWake';
import { WAKE_HINT_TEXT } from './WakeHint';

beforeEach(() => resetBackendWakeForTests());
afterEach(() => {
  resetBackendWakeForTests();
  vi.useRealTimers();
});

describe('RouteFallback: the route Suspense fallback, shaped like the destination', () => {
  it.each(Object.entries(ROUTE_LOADING))('%s: one live region that says what is loading', (view, route) => {
    render(<RouteFallback view={view} />);
    const status = screen.getByRole('status');
    expect(status).toHaveAttribute('aria-live', 'polite');
    expect(status).toHaveTextContent(route.label);
    if (route.shape === 'studio') {
      expect(status).toHaveAttribute('data-slot', 'content-loader');
      expect(status).toHaveAttribute('data-fill', route.fill ?? 'content');
      expect(status.querySelector('svg')).toHaveAttribute('data-studio', route.studio);
    } else {
      expect(status).toHaveAttribute('data-slot', 'route-fallback');
      expect(status).toHaveAttribute('data-shape', route.shape);
      expect(status).toHaveAttribute('aria-busy', 'true');
      // The label is for assistive tech; the blocks are decoration.
      expect(screen.getByText(route.label)).toHaveClass('sr-only');
      const blocks = status.querySelectorAll('[data-slot="skeleton"]');
      expect(blocks.length).toBeGreaterThan(4);
      blocks.forEach((b) => expect(b).toHaveAttribute('aria-hidden', 'true'));
    }
  });

  it('never covers the header: no fallback is fixed, and the full-height ones are only the header-less views', () => {
    for (const [view, route] of Object.entries(ROUTE_LOADING)) {
      const { unmount } = render(<RouteFallback view={view} />);
      expect(screen.getByRole('status').className, view).not.toMatch(/\bfixed\b/);
      unmount();
      if (route.fill === 'viewport') expect(['chat', 'comicstudio', 'editor', 'pagestudio', 'reader', 'shared']).toContain(view);
    }
  });

  it('maps the views by shape', () => {
    expect(routeLoadingFor('dashboard').shape).toBe('library');
    expect(routeLoadingFor('gallery').shape).toBe('library');
    expect(routeLoadingFor('privacy').shape).toBe('article');
    expect(routeLoadingFor('terms').shape).toBe('article');
    expect(routeLoadingFor('settings').shape).toBe('settings');
    expect(routeLoadingFor('comicstudio')).toMatchObject({ shape: 'studio', studio: 'comic', fill: 'viewport' });
  });

  it('an unknown view (or a prototype key) gets the default loader', () => {
    expect(routeLoadingFor('nope')).toBe(DEFAULT_ROUTE_LOADING);
    expect(routeLoadingFor('constructor')).toBe(DEFAULT_ROUTE_LOADING);
    render(<RouteFallback view="nope" />);
    expect(screen.getByRole('status')).toHaveTextContent(DEFAULT_ROUTE_LOADING.label);
  });

  it('fades in after a beat, so a cached route never flashes a skeleton', () => {
    render(<RouteFallback view="dashboard" />);
    expect(screen.getByRole('status').className).toContain('ds-fade-in');
    expect(screen.getByRole('status').className).toContain('[animation-delay:150ms]');
  });

  it('says the studio is waking when the boot probe is slow', () => {
    vi.useFakeTimers();
    trackBackendWake(new Promise(() => undefined));
    render(<RouteFallback view="dashboard" />);
    expect(screen.queryByText(WAKE_HINT_TEXT)).toBeNull();
    act(() => {
      vi.advanceTimersByTime(WAKE_HINT_AFTER_MS);
    });
    expect(screen.getByRole('status')).toHaveTextContent(WAKE_HINT_TEXT);
  });

  it('library cards: two rows at every width (4 on a phone, 6 on a tablet, 8 on a desktop)', () => {
    const { container } = render(<RouteFallback view="gallery" />);
    const grid = container.querySelector('.grid')!;
    const cards = [...grid.children];
    expect(cards).toHaveLength(8);
    expect(cards.filter((c) => !c.className.includes('hidden'))).toHaveLength(4);
    expect(cards.filter((c) => c.className.includes('sm:block'))).toHaveLength(2);
    expect(cards.filter((c) => c.className.includes('lg:block'))).toHaveLength(2);
  });
});
