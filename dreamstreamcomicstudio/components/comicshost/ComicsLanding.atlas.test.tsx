// @vitest-environment jsdom
// The comics landing in the Atlas public composition (docs/design/design-system.md, Landing row): tokens only (the
// comic art aside), the display eyebrows, the Library in the header and its menu, the one-line lockup, one hero call
// to action per state, the app's own sticky header, the steps rail, and nothing fetched on render.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import React from 'react';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DISPLAY_HERO, DISPLAY_SECTION, FONT_DISPLAY, HUE_SOLID, INK_TILE, OVERLINE, OVERLINE_DISPLAY, SPARK_FILL, WASH_HERO } from '../chat/studioDesign';
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

/** Give every element a scroll width and a client width (jsdom lays nothing out). */
const stubWidths = (scrollWidth: number, clientWidth: number) => {
  Object.defineProperty(HTMLElement.prototype, 'scrollWidth', { configurable: true, get: () => scrollWidth });
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => clientWidth });
};
const unstubWidths = () => {
  delete (HTMLElement.prototype as { scrollWidth?: unknown }).scrollWidth;
  delete (HTMLElement.prototype as { clientWidth?: unknown }).clientWidth;
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
      'Easy or Pro',
      'Print it or keep it'
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

  it('landmarks: one banner, one main, one contentinfo; the looks scroller is a labelled region', () => {
    render(<ComicsLanding signedIn={false} {...handlers()} />);
    expect(screen.getAllByRole('banner')).toHaveLength(1);
    expect(screen.getAllByRole('main')).toHaveLength(1);
    expect(screen.getAllByRole('contentinfo')).toHaveLength(1);
    const looks = screen.getByRole('region', { name: 'Six looks' });
    expect(within(looks).getAllByRole('listitem').map((li) => li.querySelector('figcaption')?.textContent)).toEqual([
      'Ligne claire',
      'Manga',
      'Noir ink',
      'Storybook watercolor',
      'Indie riso',
      'Retro pop'
    ]);
  });

  it('the looks band is a tab stop only while it scrolls: measured on mount and again on resize', () => {
    try {
      stubWidths(1136, 1216); // 1280 px: the six pages fit
      render(<ComicsLanding signedIn={false} {...handlers()} />);
      const looks = screen.getByRole('region', { name: 'Six looks' });
      expect(looks).not.toHaveAttribute('tabindex');
      stubWidths(1136, 390); // a phone: the band scrolls inside its region
      act(() => {
        window.dispatchEvent(new Event('resize'));
      });
      expect(looks).toHaveAttribute('tabindex', '0');
    } finally {
      unstubWidths();
    }
  });

  it('one fill in the first view: the banner and the hero hold exactly one filled control, signed out and signed in', () => {
    for (const signedIn of [false, true]) {
      const { unmount } = render(<ComicsLanding signedIn={signedIn} {...handlers()} />);
      const hero = screen.getByRole('heading', { level: 1 }).closest('section') as HTMLElement;
      const filled = [screen.getByRole('banner'), hero].flatMap((root) => [...root.querySelectorAll('[data-variant="default"],[data-variant="create"]')]);
      expect(filled, `signedIn=${signedIn}`).toHaveLength(1);
      expect(filled[0]).toBe(screen.getByTestId('comics-hero-cta'));
      unmount();
    }
  });

  it('the proof is the studio as drawn: ink-and-screentone pages, the plan’s Look from the data, initials, the composer', () => {
    const { container } = render(<ComicsLanding signedIn={false} {...handlers()} />);
    const preview = screen.getByTestId('studio-preview');
    const pages = [...preview.querySelectorAll('[data-comic-art]')];
    expect(pages).toHaveLength(2);
    for (const page of pages) expect(page).toHaveAttribute('data-specimen-look', 'manga-screentone');
    expect(within(preview).getByText('Manga · locked')).toBeInTheDocument();
    expect(preview.textContent).not.toMatch(/Ligne claire/);
    // The cast chips carry the character's initial, as the studio's cast avatars do.
    for (const name of ['Mira', 'Biscuit']) {
      const chip = within(preview).getByText(name).closest('[data-slot="chip"]') as HTMLElement;
      // The initial sits in the chip's icon slot (a flex item beside the name, never stacked above it).
      expect(chip.firstElementChild).toHaveAttribute('aria-hidden', 'true');
      expect(chip.firstElementChild).toHaveTextContent(name[0]);
    }
    // The composer still, with the studio's own placeholder, and no control inside the replica.
    const composer = preview.querySelector('[data-slot="preview-composer"]') as HTMLElement;
    expect(composer).toHaveTextContent('Reply, or describe a change…');
    expect(preview.querySelectorAll('button, a, input, textarea')).toHaveLength(0);
    // The six looks band keeps its colour looks, Ligne claire first.
    expect(container.querySelector('#looks [data-comic-art]')).toHaveAttribute('data-specimen-look', 'ligne-claire');
  });

  it('the feature titles hold two lines in the two-column tablet grid, so the bodies in a row start level', () => {
    render(<ComicsLanding signedIn={false} {...handlers()} />);
    const titles = ['Characters that stay themselves', 'Lettering you control', 'Easy or Pro', 'Print it or keep it'].map((t) => screen.getByRole('heading', { level: 3, name: t }));
    for (const h3 of titles) expect(classes(h3), h3.textContent!).toEqual(expect.arrayContaining(['md:min-h-14', 'lg:min-h-0']));
    expect(classes(titles[0].closest('ul')!)).toEqual(expect.arrayContaining(['grid', 'md:grid-cols-2']));
  });

  it('the phone footer puts its two link lists side by side (the brand spans both) and goes to three columns from md', () => {
    render(<ComicsLanding signedIn={false} {...handlers()} />);
    const grid = screen.getByRole('navigation', { name: 'Comic Studio links' }).parentElement as HTMLElement;
    expect(classes(grid)).toEqual(expect.arrayContaining(['grid', 'grid-cols-2', 'md:grid-cols-[1.4fr_1fr_1fr]']));
    expect(classes(grid.firstElementChild!)).toEqual(expect.arrayContaining(['col-span-2', 'md:col-span-1']));
  });
});

// ── The landing in colour (CL-10; docs/design/design-system.md § Ink, Paper & Colour) ─────────────────────────
const WASH_CLASS = WASH_HERO.split(/\s+/)[0];
/** Every colour-layer token a class can read (the hues, their steps, the label colour, the washes, the studio accent). */
const LAYER_CLASS = /--ds-(?:hue-\d|on-hue|wash-|studio|art-|chart-(?:seq|div))/;

describe('ComicsLanding in colour', () => {
  it('the hero carries the hero wash, once: full bleed behind the headline and the calls to action, nowhere else on the page', () => {
    const { container } = render(<ComicsLanding signedIn={false} {...handlers()} />);
    const hero = screen.getByTestId('comics-hero');
    const wash = screen.getByTestId('comics-hero-wash');
    expect(hasAll(wash, WASH_HERO), 'the hero wash layer takes WASH_HERO').toBe(true);
    expect(hero).toBe(screen.getByRole('heading', { level: 1 }).closest('section'));
    expect(hero.contains(wash), 'the wash is part of the hero').toBe(true);
    // Sized to the words, not the whole section: the headline and both calls to action sit on it, and the opaque
    // drawn pages do not (on the section the proof hid the orange and stretched the other two into edge bands).
    expect(wash).toContainElement(screen.getByRole('heading', { level: 1 }));
    expect(wash).toContainElement(screen.getByTestId('comics-hero-cta'));
    expect(wash).toContainElement(within(hero).getByRole('button', { name: 'Request access' }));
    expect(wash).not.toContainElement(screen.getByTestId('comics-proof'));
    // Full bleed: the wash is the section's own child, not inside the centred column.
    expect(wash.parentElement).toBe(hero);
    const washed = [...container.querySelectorAll('[class]')].filter((el) => /--ds-wash-/.test(el.getAttribute('class')!));
    expect(washed).toEqual([wash]);
    expect(classes(wash)).toContain(WASH_CLASS);
    expect(container.innerHTML).not.toMatch(/--ds-wash-empty/);
  });

  it('four solid 56 px feature tiles in ink, magenta, leaf and sky (no ultramarine tile), each an icon only', () => {
    render(<ComicsLanding signedIn={false} {...handlers()} />);
    const tiles = [...document.querySelectorAll('[data-feature-tile]')] as HTMLElement[];
    expect(tiles).toHaveLength(4);
    const expected = [INK_TILE, HUE_SOLID[1], HUE_SOLID[5], HUE_SOLID[6]];
    tiles.forEach((tile, i) => {
      expect(hasAll(tile, expected[i]), `tile ${i + 1}: ${tile.getAttribute('class')}`).toBe(true);
      expect(classes(tile), `tile ${i + 1} is 56 px`).toContain('size-14');
      expect(tile).toHaveAttribute('aria-hidden');
      expect(tile.textContent, 'an icon, no words (white on magenta and sky is under 4.5:1)').toBe('');
      expect(tile.querySelectorAll('svg')).toHaveLength(1);
      // Each tile leads its own card, above the card's title.
      const h3 = tile.closest('li')!.querySelector('h3')!;
      expect(h3).not.toBeNull();
      expect(tile.compareDocumentPosition(h3) & Node.DOCUMENT_POSITION_FOLLOWING, 'the tile comes before the title').toBeTruthy();
    });
    // The fourth card promises only what the Reader tab gives everyone: print, a PDF, the pages as images in one ZIP.
    expect(screen.getByRole('heading', { level: 3, name: 'Print it or keep it' }).closest('li')!.textContent).toMatch(/print it, save a PDF, or download the pages as images in one ZIP/);
    // No ultramarine tile: the one blue on the page is the "Start creating" spark.
    for (const tile of tiles) expect(tile.getAttribute('class')).not.toMatch(/--ds-hue-1-|--ds-spark/);
  });

  it('one label colour on the four tiles: the ink tile’s page colour is the hue tiles’ --ds-on-hue (white light, ink dark)', () => {
    // The ink tile paints its icon with --ds-canvas (INK_TILE), the hue tiles with --ds-on-hue (HUE_SOLID).
    expect(INK_TILE).toMatch(/text-\[var\(--ds-canvas\)\]/);
    for (const i of [1, 5, 6]) expect(HUE_SOLID[i]).toMatch(/text-\[var\(--ds-on-hue\)\]/);
    // The comics host always renders under the Atlas skin (index.html ships data-ds-skin="atlas"): its light block and
    // its dark block (top level, before the high-contrast media query) each set both names to one hex.
    const indexCss = readFileSync(path.join(process.cwd(), 'index.css'), 'utf8');
    const block = (selector: string) => {
      const at = indexCss.indexOf(`\n${selector} {`);
      expect(at, selector).toBeGreaterThan(0);
      return indexCss.slice(at, indexCss.indexOf('\n}', at));
    };
    const value = (css: string, name: string) => new RegExp(`\\s${name}:\\s*([^;]+);`).exec(css)?.[1].trim().toLowerCase();
    const light = block('[data-ds-skin="atlas"]');
    const dark = block('.dark [data-ds-skin="atlas"]');
    expect(value(light, '--ds-canvas')).toBe('#ffffff');
    expect(value(light, '--ds-on-hue')).toBe('#ffffff');
    expect(value(dark, '--ds-canvas')).toBe('#0a0a0a');
    expect(value(dark, '--ds-on-hue')).toBe('#0a0a0a');
  });

  it('exactly one spark fill signed out (the "Start creating" call to action), none signed in; ultramarine nowhere else', () => {
    const spark = SPARK_FILL.split(/\s+/)[0];
    // The whole spark family: the spark's own tokens and every hue-1 step (mark, text, soft tint, solid).
    const SPARK_FAMILY = /--ds-spark|--ds-hue-1(?:-|\))/;
    const sparkFills = (root: HTMLElement) =>
      [...root.querySelectorAll('[class]')].filter((el) => classes(el).includes(spark) || SPARK_FAMILY.test(el.getAttribute('class')!));
    const out = render(<ComicsLanding signedIn={false} {...handlers()} />);
    const fills = sparkFills(out.container);
    expect(fills).toEqual([screen.getByTestId('comics-hero-cta')]);
    out.unmount();
    const signedIn = render(<ComicsLanding signedIn {...handlers()} />);
    expect(sparkFills(signedIn.container)).toEqual([]);
  });

  it('no hue as text: every word on the landing stays ink or muted, signed out and signed in', () => {
    for (const signedIn of [false, true]) {
      const { container, unmount } = render(<ComicsLanding signedIn={signedIn} {...handlers()} />);
      const hueText = [...container.querySelectorAll('[class]')].filter((el) => /text-\[(?:color:)?var\(--ds-hue-\d/.test(el.getAttribute('class')!));
      expect(
        hueText.map((el) => `${el.tagName} ${el.textContent!.slice(0, 40)}`),
        `signedIn=${signedIn}`
      ).toEqual([]);
      unmount();
    }
  });

  it('nothing coloured on or beside a price: no price or spend control on the page, and no control reads a colour token', () => {
    for (const signedIn of [false, true]) {
      const { container, unmount } = render(<ComicsLanding signedIn={signedIn} {...handlers()} />);
      expect(container.textContent, 'no price on the landing').not.toMatch(/[$¢€£]|\b\d+\s*(?:credits?|cents?)\b|\bper (?:page|comic)\b/i);
      for (const control of container.querySelectorAll('button, a, [role="button"]')) {
        expect(control.textContent!.trim(), 'no spend control').not.toMatch(/^(?:Approve|Draw|Redraw|Translate|Get more)\b/);
        const coloured = [control, ...control.querySelectorAll('[class]')].filter((el) => LAYER_CLASS.test(el.getAttribute('class') || ''));
        expect(coloured, `${control.textContent} reads no colour-layer token`).toEqual([]);
      }
      unmount();
    }
  });
});

