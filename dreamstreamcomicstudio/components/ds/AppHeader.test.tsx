/**
 * AppHeader (redesign plan §11.3 M1c): one header grid shared with its skeleton (Atlas header-layout.ts), the
 * sticky header recipe with its glass layer, plain at rest and frosted once the window scrolls under it.
 */
import React from 'react';
import { act, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HEADER_GLASS, STICKY_HEADER } from './recipes';
import { expectClasses } from './ds.testkit';
import { AppHeader, AppHeaderSkeleton, HEADER_GRID, HEADER_REGION } from './AppHeader';

// Animation frames run when the test says so (the hook reads the scroll at most once per frame).
let frames: FrameRequestCallback[] = [];
const flushFrames = () => {
  const due = frames;
  frames = [];
  for (const cb of due) cb(0);
};
const scrollTo = (y: number) => {
  Object.defineProperty(window, 'scrollY', { configurable: true, value: y });
  window.dispatchEvent(new Event('scroll'));
  flushFrames();
};

beforeEach(() => {
  frames = [];
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb: FrameRequestCallback) => frames.push(cb));
  vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => undefined);
  Object.defineProperty(window, 'scrollY', { configurable: true, value: 0 });
});
afterEach(() => vi.restoreAllMocks());

const header = (props: Partial<React.ComponentProps<typeof AppHeader>> = {}) => (
  <AppHeader
    aria-label="Site"
    brand={<a href="/">DreamStream</a>}
    nav={<nav aria-label="Products">Products</nav>}
    actions={<button type="button">Sign in</button>}
    {...props}
  />
);

describe('AppHeader and AppHeaderSkeleton share one grid', () => {
  it('the same header recipe, glass layer, grid and region cells, so the real header lands where its placeholders were', () => {
    const { container } = render(
      <>
        {header()}
        <AppHeaderSkeleton />
      </>
    );
    const [real, skeleton] = [...container.querySelectorAll('header')];
    expect(real).toHaveAttribute('data-slot', 'app-header');
    expect(skeleton).toHaveAttribute('data-slot', 'app-header-skeleton');
    expect(real.className).toBe(skeleton.className);
    expectClasses(real, STICKY_HEADER);

    const gridOf = (h: Element) => h.querySelector('[data-slot="app-header-grid"]')!;
    expect(gridOf(real).className).toBe(HEADER_GRID);
    expect(gridOf(skeleton).className).toBe(HEADER_GRID);
    expect(gridOf(real).parentElement!.className).toBe(gridOf(skeleton).parentElement!.className);
    for (const region of Object.keys(HEADER_REGION) as Array<keyof typeof HEADER_REGION>) {
      const a = gridOf(real).querySelector(`[data-region="${region}"]`)!;
      const b = gridOf(skeleton).querySelector(`[data-region="${region}"]`)!;
      expect(a.className, region).toBe(HEADER_REGION[region]);
      expect(b.className, region).toBe(HEADER_REGION[region]);
    }
    for (const h of [real, skeleton]) {
      const glass = h.firstElementChild!;
      expect(glass).toHaveAttribute('aria-hidden', 'true');
      expect(glass.className).toBe(HEADER_GLASS);
    }
  });

  it('the grid is the chrome-height row: brand, a flexible middle, actions', () => {
    expect(HEADER_GRID).toContain('min-h-[var(--header-h,56px)]');
    expect(HEADER_GRID).toContain('grid-cols-[auto_minmax(0,1fr)_auto]');
    expect(HEADER_REGION.brand).toContain('col-start-1');
    expect(HEADER_REGION.nav).toContain('col-start-2');
    expect(HEADER_REGION.actions).toContain('col-start-3');
  });

  it('the skeleton is static placeholders with words for assistive tech', () => {
    render(<AppHeaderSkeleton label="Loading your comics…" />);
    const skeleton = document.querySelector('[data-slot="app-header-skeleton"]')!;
    expect(skeleton).toHaveAttribute('aria-busy', 'true');
    expect(screen.getByText('Loading your comics…')).toHaveClass('sr-only');
    expect(skeleton.querySelectorAll('[data-slot="skeleton"]').length).toBeGreaterThanOrEqual(1 + 4 + 2);
    for (const region of skeleton.querySelectorAll('[data-region]')) expect(region).toHaveAttribute('aria-hidden', 'true');
  });
});

describe('AppHeader: plain at rest, frosted once the page scrolls under it', () => {
  it('follows the window scroll past 4 px and back', () => {
    render(header());
    const h = screen.getByRole('banner', { name: 'Site' });
    expect(h).toHaveAttribute('data-scrolled', 'false');
    act(() => flushFrames());
    expect(h).toHaveAttribute('data-scrolled', 'false');
    act(() => scrollTo(3));
    expect(h).toHaveAttribute('data-scrolled', 'false');
    act(() => scrollTo(120));
    expect(h).toHaveAttribute('data-scrolled', 'true');
    act(() => scrollTo(0));
    expect(h).toHaveAttribute('data-scrolled', 'false');
    // Many scroll events in one frame read the position once.
    act(() => {
      for (let i = 0; i < 10; i += 1) window.dispatchEvent(new Event('scroll'));
    });
    expect(frames).toHaveLength(1);
    act(() => flushFrames());
  });

  it('a controlled `scrolled` wins and the window is not watched', () => {
    const add = vi.spyOn(window, 'addEventListener');
    render(header({ scrolled: true }));
    expect(screen.getByRole('banner', { name: 'Site' })).toHaveAttribute('data-scrolled', 'true');
    expect(add.mock.calls.filter(([type]) => type === 'scroll')).toEqual([]);
    act(() => scrollTo(0));
    expect(screen.getByRole('banner', { name: 'Site' })).toHaveAttribute('data-scrolled', 'true');
  });

  it('the frosting is the glass layer, never the header (a fixed descendant is not trapped)', () => {
    expect(STICKY_HEADER).not.toMatch(/backdrop-blur/);
    expect(HEADER_GLASS).toMatch(/group-data-\[scrolled=true\]\/header:backdrop-blur-\[var\(--ds-header-blur\)\]/);
  });

  it('renders the banner above the row and the children below it', () => {
    render(header({ banner: <p>News</p>, children: <div>Menu panel</div> }));
    const h = screen.getByRole('banner', { name: 'Site' });
    const parts = [...h.children].map((el) => el.textContent);
    expect(parts[1]).toBe('News');
    expect(parts[3]).toBe('Menu panel');
  });
});
