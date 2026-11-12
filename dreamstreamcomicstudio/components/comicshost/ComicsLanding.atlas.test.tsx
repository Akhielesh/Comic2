// @vitest-environment jsdom
// The comics landing on Atlas (DS-3, redesign M3; CL-3 for the call to action): tokens only, the OVERLINE
// eyebrow, the hero balloon in ink (currentColor), the Library link visible at every width, one hero call to
// action, and the sticky header that frosts only once the page scrolls under it.
import React from 'react';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FOCUS_RING, OVERLINE, STICKY_HEADER } from '../chat/studioDesign';
import { ComicsLanding } from './ComicsLanding';

afterEach(() => {
  cleanup();
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

describe('ComicsLanding on Atlas', () => {
  it('spells no hue: no terracotta, no hex, no comic chrome, the ink focus ring', () => {
    const { container } = render(<ComicsLanding signedIn={false} {...handlers()} />);
    const markup = container.innerHTML;
    // The landing's own markup, without the drawings it borrows: EmptyArt (its spot is CL-3's wave note) and the
    // brand mark (ComicsMark keeps the logo's terracotta until StudioMark replaces it).
    const own = container.cloneNode(true) as HTMLElement;
    for (const el of own.querySelectorAll('[data-empty-art], header svg:first-of-type')) el.remove();
    expect(own.innerHTML).not.toMatch(/#d97757|#c2643f/i);
    for (const el of container.querySelectorAll('[class]')) expect(el.getAttribute('class'), el.tagName).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(/i);
    expect(markup).not.toMatch(/border-black|shadow-comic|font-comic|(?<![\w-])font-display|brand-(?:yellow|blue|red)|text-white/);
    for (const b of screen.getAllByRole('button')) for (const cls of FOCUS_RING.split(' ')) expect(classes(b)).toContain(cls);
  });

  it('the eyebrows are the OVERLINE recipe and the hero balloon is drawn in ink (currentColor)', () => {
    render(<ComicsLanding signedIn={false} {...handlers()} />);
    const eyebrow = within(screen.getByRole('main')).getByText('Comic Studio');
    for (const cls of OVERLINE.split(' ')) expect(classes(eyebrow)).toContain(cls);
    const balloon = screen.getByTestId('comics-hero-balloon');
    expect(balloon.querySelector('path')).toHaveAttribute('stroke', 'currentColor');
    expect(classes(balloon)).toContain('text-[var(--ds-ink)]');
  });

  it('the Library link is in the header at every width (never hidden on phones)', () => {
    for (const signedIn of [false, true]) {
      const { unmount } = render(<ComicsLanding signedIn={signedIn} {...handlers()} />);
      const library = within(screen.getByRole('banner')).getByRole('button', { name: 'Library' });
      expect(classes(library).some((c) => c === 'hidden' || /:hidden$/.test(c))).toBe(false);
      unmount();
    }
  });

  it('below the medium screen the header mark stands alone; the name stays for screen readers (named screens only)', () => {
    render(<ComicsLanding signedIn={false} {...handlers()} />);
    const wordmark = within(screen.getByRole('banner')).getByTestId('comics-wordmark');
    expect(wordmark).toHaveTextContent('DreamStreamComic Studio');
    // sr-only below 600 px, shown from `medium:` up. Never a min-[…]/max-[…] variant: this config's raw screens
    // disable those, so such a class compiles to no CSS at all (the old max-width 359 px sr-only variant did nothing).
    expect(classes(wordmark)).toEqual(expect.arrayContaining(['sr-only', 'medium:not-sr-only']));
    expect(classes(wordmark).filter((c) => /(?:^|:)!?(?:min|max)-\[[^\]]*\]:/.test(c))).toEqual([]);
  });

  it('one hero call to action per state, and it starts the right thing', () => {
    const h = handlers();
    const { unmount } = render(<ComicsLanding signedIn={false} {...h} />);
    expect(screen.getAllByTestId('comics-hero-cta')).toHaveLength(1);
    fireEvent.click(screen.getByTestId('comics-hero-cta'));
    expect(h.onSignIn).toHaveBeenCalledTimes(1);
    unmount();
    render(<ComicsLanding signedIn {...h} />);
    expect(screen.getAllByTestId('comics-hero-cta')).toHaveLength(1);
    fireEvent.click(screen.getByTestId('comics-hero-cta'));
    expect(h.onOpenComics).toHaveBeenCalledTimes(1);
  });

  it('the header is the sticky Atlas header; its glass frosts only once the page scrolls under it', () => {
    render(<ComicsLanding signedIn={false} {...handlers()} />);
    const header = screen.getByRole('banner');
    for (const cls of STICKY_HEADER.split(' ')) expect(classes(header)).toContain(cls);
    expect(header).toHaveAttribute('data-scrolled', 'false');
    Object.defineProperty(window, 'scrollY', { configurable: true, value: 120 });
    fireEvent.scroll(window);
    expect(header).toHaveAttribute('data-scrolled', 'true');
  });

  it('the step numbers are ink counts, not accent chips', () => {
    const { container } = render(<ComicsLanding signedIn={false} {...handlers()} />);
    const steps = container.querySelectorAll('ol > li > span[aria-hidden]');
    expect(steps).toHaveLength(4);
    for (const s of steps) {
      expect(classes(s)).toContain('text-[var(--ds-ink)]');
      expect(s.getAttribute('class')).not.toMatch(/accent/);
    }
  });
});
