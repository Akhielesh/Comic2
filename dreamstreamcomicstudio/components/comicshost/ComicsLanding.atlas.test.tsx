// @vitest-environment jsdom
// The comics landing in the Atlas public composition (docs/design/design-system.md, Landing row): tokens only (the
// comic art aside), the display eyebrows, the Library in the header and its menu, the one-line lockup, one hero call
// to action per state, the app's own sticky header, the steps rail, and nothing fetched on render.
import React from 'react';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DISPLAY_HERO, DISPLAY_SECTION, FONT_DISPLAY, OVERLINE, OVERLINE_DISPLAY } from '../chat/studioDesign';
import { ComicsLanding } from './ComicsLanding';

let frames: FrameRequestCallback[] = [];
const flushFrames = () =>
  act(() => {
    const run = frames;
    frames = [];
    for (const cb of run) cb(0);
  });

beforeEach(() => {
  frames = [];
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb: FrameRequestCallback) => frames.push(cb));
  vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => undefined);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  Object.defineProperty(window, 'scrollY', { configurable: true, value: 0 });
});

const handlers = () => ({
  onSignIn: vi.fn(),
  onRequestAccess: vi.fn(),
  onOpenComics: vi.fn(),
  onBrowseGallery: vi.fn(),
  onOpenPrivacy: vi.fn(),
  onOpenTerms: vi.fn()
});
const classes = (el: Element) => (el.getAttribute('class') || '').split(/\s+/).filter(Boolean);
const hasAll = (el: Element, recipe: string) => recipe.split(/\s+/).every((c) => classes(el).includes(c));

/** The landing's own markup, without the comic art it draws (the palette there is art content). */
const ownMarkup = (container: HTMLElement): HTMLElement => {
  const own = container.cloneNode(true) as HTMLElement;
  for (const el of own.querySelectorAll('[data-comic-art]')) el.remove();
  return own;
};

describe('ComicsLanding on Atlas', () => {
  it('(a) spells no hue: no hex or rgba in any class, no terracotta, no comic chrome outside the art', () => {
    const { container } = render(<ComicsLanding signedIn={false} {...handlers()} />);
    const own = ownMarkup(container);
    expect(own.innerHTML).not.toMatch(/#d97757|#c2603f|#c2643f|#fdfbf7/i);
    expect(own.innerHTML).not.toMatch(/#[0-9a-f]{3,8}\b/i);
    for (const el of own.querySelectorAll('[class]')) expect(el.getAttribute('class'), el.tagName).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(/i);
    expect(own.innerHTML).not.toMatch(/border-black|shadow-comic|font-comic|(?<![\w-])font-display|brand-(?:yellow|blue|red)|text-white/);
    // The art is really there: six looks in the band, two pages in the proof, one in the reader room.
    expect(container.querySelectorAll('[data-comic-art]')).toHaveLength(9);
  });

  it('(b) section eyebrows are OVERLINE_DISPLAY; the Beta chip and the footer heads are OVERLINE', () => {
    render(<ComicsLanding signedIn={false} {...handlers()} />);
    for (const text of ['How it works', 'Read and share']) {
      const eyebrow = within(screen.getByRole('main')).getAllByText(text).find((el) => el.tagName === 'P') as HTMLElement;
      expect(classes(eyebrow), text).toContain(OVERLINE_DISPLAY);
    }
    expect(classes(document.getElementById('comics-looks')!)).toContain(OVERLINE_DISPLAY);
    expect(hasAll(within(screen.getByRole('banner')).getByText('Beta'), OVERLINE)).toBe(true);
    const footer = screen.getByRole('contentinfo');
    for (const head of ['Comic Studio', 'Legal']) expect(hasAll(within(footer).getByText(head), OVERLINE), head).toBe(true);
  });

  it('the h1 and the section titles take the public display recipes (Space Grotesk, the Atlas scale)', () => {
    render(<ComicsLanding signedIn={false} {...handlers()} />);
    const h1 = screen.getByRole('heading', { level: 1 });
    expect(hasAll(h1, DISPLAY_HERO)).toBe(true);
    for (const id of ['comics-how', 'comics-read', 'comics-access']) {
      const h2 = document.getElementById(id)!;
      expect(h2.tagName).toBe('H2');
      expect(hasAll(h2, DISPLAY_SECTION), id).toBe(true);
      expect(classes(h2), id).toContain(FONT_DISPLAY);
      expect(h2).toHaveAttribute('tabindex', '-1');
    }
  });

  it('(c) the Library is in the header nav and in the opened menu', () => {
    const h = handlers();
    render(<ComicsLanding signedIn={false} {...h} />);
    const banner = screen.getByRole('banner');
    const nav = within(banner).getByRole('navigation', { name: 'Comic Studio' });
    expect(within(nav).getAllByRole('button').map((b) => b.textContent)).toEqual(['How it works', 'Looks', 'Library']);
    fireEvent.click(within(banner).getByRole('button', { name: 'Menu' }));
    const menu = banner.querySelector('[data-slot="comics-menu"]') as HTMLElement;
    expect(menu).not.toHaveAttribute('hidden');
    fireEvent.click(within(menu).getByRole('button', { name: 'Library' }));
    expect(h.onBrowseGallery).toHaveBeenCalledTimes(1);
    expect(menu).toHaveAttribute('hidden');
  });

  it('(d) the lockup reads "Comic Studio" on one line at every width, never screen-reader-only', () => {
    render(<ComicsLanding signedIn={false} {...handlers()} />);
    const lockup = screen.getByRole('button', { name: 'Comic Studio, home' });
    const comic = within(lockup).getByText('Comic');
    const studio = within(lockup).getByText('Studio');
    for (const el of [comic, studio]) {
      expect(classes(el)).not.toContain('sr-only');
      expect(classes(el)).not.toContain('hidden');
    }
    expect(lockup.querySelector('[data-slot="comics-mark"]')).not.toBeNull();
  });

  it('(e) one hero call to action per state: the spark to start signed out, the ink primary to open the comics signed in', () => {
    const h = handlers();
    const { unmount } = render(<ComicsLanding signedIn={false} {...h} />);
    expect(screen.getAllByTestId('comics-hero-cta')).toHaveLength(1);
    expect(screen.getByTestId('comics-hero-cta')).toHaveAttribute('data-variant', 'create');
    fireEvent.click(screen.getByTestId('comics-hero-cta'));
    expect(h.onSignIn).toHaveBeenCalledTimes(1);
    unmount();
    render(<ComicsLanding signedIn {...h} />);
    expect(screen.getAllByTestId('comics-hero-cta')).toHaveLength(1);
    expect(screen.getByTestId('comics-hero-cta')).toHaveAttribute('data-variant', 'default');
    fireEvent.click(screen.getByTestId('comics-hero-cta'));
    expect(h.onOpenComics).toHaveBeenCalledTimes(1);
  });

  it('(f) the header is the app header (AppHeader): plain at rest, frosted once the page scrolls under it', () => {
    render(<ComicsLanding signedIn={false} {...handlers()} />);
    const header = screen.getByRole('banner');
    expect(header).toHaveAttribute('data-slot', 'app-header');
    flushFrames();
    expect(header).toHaveAttribute('data-scrolled', 'false');
    Object.defineProperty(window, 'scrollY', { configurable: true, value: 120 });
    window.dispatchEvent(new Event('scroll'));
    flushFrames();
    expect(header).toHaveAttribute('data-scrolled', 'true');
  });

  it('(g) the steps rail: four steps on an ink rule, numbered 01–04', () => {
    render(<ComicsLanding signedIn={false} {...handlers()} />);
    const steps = [...document.querySelectorAll('#how-it-works ol > li')];
    expect(steps).toHaveLength(4);
    steps.forEach((li, i) => {
      expect(classes(li)).toEqual(expect.arrayContaining(['border-t', 'border-[var(--ds-ink)]']));
      expect(li.querySelector('p[aria-hidden]')).toHaveTextContent(`0${i + 1}`);
      expect(li.querySelector('h3')).not.toBeNull();
    });
    expect(within(screen.getByRole('main')).getAllByRole('heading', { level: 3 }).map((h) => h.textContent)).toEqual([
      'Tell it the idea',
      'Agree the plan',
      'Lock the look',
      'Polish and share',
      'Characters that stay themselves',
      'Lettering you control',
      'Easy or Pro'
    ]);
    // Never the untrue promise: small image runs can start without a gate.
    expect(document.body.textContent).not.toMatch(/nothing is drawn until/i);
  });

  it('(h) fetches nothing on render: no fetch, no XMLHttpRequest, no timer-driven request', () => {
    const fetchSpy = vi.fn(() => Promise.reject(new Error('no network in this test')));
    vi.stubGlobal('fetch', fetchSpy);
    const open = vi.spyOn(XMLHttpRequest.prototype, 'open');
    try {
      render(<ComicsLanding signedIn={false} {...handlers()} />);
      render(<ComicsLanding signedIn {...handlers()} />);
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(open).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('the section links scroll to their section and move focus to its heading (behaviour follows reduced motion)', () => {
    const scrollIntoView = vi.fn();
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: scrollIntoView });
    try {
      render(<ComicsLanding signedIn={false} {...handlers()} />);
      fireEvent.click(within(screen.getByRole('navigation', { name: 'Comic Studio' })).getByRole('button', { name: 'Looks' }));
      expect(scrollIntoView).toHaveBeenCalledWith({ block: 'start', behavior: 'smooth' });
      expect(document.activeElement).toBe(document.getElementById('comics-looks'));
      fireEvent.click(within(screen.getByRole('contentinfo')).getByRole('button', { name: 'How it works' }));
      expect(document.activeElement).toBe(document.getElementById('comics-how'));
    } finally {
      delete (HTMLElement.prototype as { scrollIntoView?: unknown }).scrollIntoView;
    }
  });

  it('landmarks: one banner, one main, one contentinfo; the looks scroller is a labelled, focusable region', () => {
    render(<ComicsLanding signedIn={false} {...handlers()} />);
    expect(screen.getAllByRole('banner')).toHaveLength(1);
    expect(screen.getAllByRole('main')).toHaveLength(1);
    expect(screen.getAllByRole('contentinfo')).toHaveLength(1);
    const looks = screen.getByRole('region', { name: 'Six looks' });
    expect(looks).toHaveAttribute('tabindex', '0');
    expect(within(looks).getAllByRole('listitem').map((li) => li.querySelector('figcaption')?.textContent)).toEqual([
      'Ligne claire',
      'Manga',
      'Noir ink',
      'Storybook watercolor',
      'Indie riso',
      'Retro pop'
    ]);
  });
});
