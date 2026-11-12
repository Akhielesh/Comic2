/**
 * The content kit (DS-R1; redesign plan §4, §10): ComicCard's one primary control inside its heading; CoverImage's
 * reserved box, lazy loading, publication rule, sign-when-visible and decode-gated reveal; CardGrid's list semantics
 * and selection-only arrow keys; SelectionBar's live count; Shelf's empty and pointer rules; StatusPill under reduced
 * motion; and no component printing a dollar.
 */
import React from 'react';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CARD_GRID_STAGGER_MAX, CardGrid, nextGridIndex } from './CardGrid';
import { ComicCard } from './ComicCard';
import { CoverImage, isPublicationCoverSource, publicationCoverOrigins, PUBLICATION_PATH_RE } from './CoverImage';
import { FilterChips } from './FilterChips';
import { InlineMeta } from './InlineMeta';
import { layoutFor } from './layout';
import { Lightbox } from './Lightbox';
import { MEDIA_TILE_RING_INSIDE, MediaTile } from './MediaTile';
import { NavTrack } from './NavTrack';
import { PresetGrid } from './PresetGrid';
import { PresetTile } from './PresetTile';
import { Row } from './Row';
import { SearchField } from './SearchField';
import { SelectionBar, selectionText } from './SelectionBar';
import { Shelf } from './Shelf';
import { SourceBadge } from './SourceBadge';
import { StatusBanner } from './StatusBanner';
import { pickPillState, pillName, StatusPill, type StatusPillState } from './StatusPill';
import { PUBLIC_ASSET_PATH_RE } from '../comicstudio/export/publicDownload';

// ── Test doubles ──────────────────────────────────────────────────────────────────────────────────

const setMatchMedia = (matches: (q: string) => boolean) => {
  (window as unknown as { matchMedia: unknown }).matchMedia = (query: string) => ({
    matches: matches(query),
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => true
  });
};
const realMatchMedia = window.matchMedia;

/** A controllable IntersectionObserver: `ioShow(el)` reports the element as in view. */
class FakeIO {
  static all: FakeIO[] = [];
  targets: Element[] = [];
  constructor(private cb: IntersectionObserverCallback) {
    FakeIO.all.push(this);
  }
  observe(el: Element) {
    this.targets.push(el);
  }
  unobserve() {}
  disconnect() {
    this.targets = [];
  }
  takeRecords() {
    return [];
  }
}
const ioShow = (el: Element) => {
  for (const io of [...FakeIO.all]) {
    if (io.targets.includes(el)) {
      (io as unknown as { cb: IntersectionObserverCallback }).cb([{ isIntersecting: true, target: el } as IntersectionObserverEntry], io as unknown as IntersectionObserver);
    }
  }
};

let animate: ReturnType<typeof vi.fn>;
const realAnimate = (Element.prototype as { animate?: unknown }).animate;
const realIO = globalThis.IntersectionObserver;

beforeEach(() => {
  FakeIO.all = [];
  (globalThis as { IntersectionObserver?: unknown }).IntersectionObserver = FakeIO;
  animate = vi.fn(() => ({ cancel: vi.fn(), finished: Promise.resolve() }));
  (Element.prototype as { animate?: unknown }).animate = animate;
  setMatchMedia(() => false);
});

afterEach(() => {
  window.matchMedia = realMatchMedia;
  (globalThis as { IntersectionObserver?: unknown }).IntersectionObserver = realIO;
  (Element.prototype as { animate?: unknown }).animate = realAnimate;
  vi.useRealTimers();
});

const PUB = 'pub/AbCdEfGhIjKlMnOpQrStUv/cover.webp';
/** The test's storage edge: publication cards may load handed-in cover URLs from it (coverOrigins). */
const CDN = ['https://cdn.test'];
const coverBox = (container: HTMLElement) => container.querySelector('[data-slot="cover-image"]') as HTMLElement;

// ── ComicCard ─────────────────────────────────────────────────────────────────────────────────────

describe('ComicCard', () => {
  it('has exactly one primary control, inside its <h3>, named by the title; Read and Open sit outside the heading', () => {
    const onOpen = vi.fn();
    const read = vi.fn();
    const open = vi.fn();
    render(<ComicCard title="The Harbor Lights" onOpen={onOpen} read={{ onClick: read }} open={{ onClick: open }} meta={['Comic', '4 of 6 pages']} />);
    const heading = screen.getByRole('heading', { level: 3 });
    const inHeading = within(heading).getAllByRole('button');
    expect(inHeading).toHaveLength(1);
    expect(inHeading[0]).toHaveAccessibleName('The Harbor Lights');
    const readButton = screen.getByRole('button', { name: 'Read' });
    const openButton = screen.getByRole('button', { name: 'Open' });
    expect(heading.contains(readButton)).toBe(false);
    expect(heading.contains(openButton)).toBe(false);
    // Neither footer control is (or contains) a heading: no heading inside a button.
    for (const b of screen.getAllByRole('button')) expect(b.querySelector('h1,h2,h3,h4,h5,h6')).toBeNull();
    fireEvent.click(readButton);
    fireEvent.click(openButton);
    expect(read).toHaveBeenCalledTimes(1);
    expect(open).toHaveBeenCalledTimes(1);
    expect(onOpen).not.toHaveBeenCalled();
  });

  it('a tap on the cover opens it through the one primary control; a control in the corner keeps its own tap', () => {
    const onOpen = vi.fn();
    const pick = vi.fn();
    const { container } = render(<ComicCard title="Low Tide" onOpen={onOpen} corner={<input type="checkbox" aria-label="Select Low Tide" onChange={pick} />} />);
    fireEvent.click(container.querySelector('[data-slot="media-tile"]')!);
    expect(onOpen).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select Low Tide' }));
    expect(pick).toHaveBeenCalledTimes(1);
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it('a selected card rings its cover (selection on art) INSIDE the art, so the clipped grid card never cuts it off', () => {
    const { container } = render(<ComicCard title="Low Tide" onOpen={() => {}} selected />);
    const card = container.querySelector('[data-slot="comic-card"]')!;
    expect(card).toHaveAttribute('data-selected', 'true');
    // The grid card clips to its radius and the cover sits flush with its top, left and right edges ...
    expect(card.className.split(/\s+/)).toContain('overflow-hidden');
    const tile = container.querySelector('[data-slot="media-tile"]')!;
    // ... so no outline on the tile itself (it would sit 2–4 px outside the art and be clipped) ...
    expect(tile.className).not.toMatch(/(?:^|\s)outline/);
    // ... but an overlay ring INSIDE the art: painted after the picture (an outline on the tile is painted under its
    // positioned art), 2–4 px in from the edge, before the corner controls.
    const ring = tile.querySelector('[data-slot="media-tile-ring"]') as HTMLElement;
    expect(ring).not.toBeNull();
    const ringClasses = ring.className.split(/\s+/);
    expect(ringClasses).toEqual(expect.arrayContaining(['outline', 'outline-2', 'outline-[color:var(--ds-spark)]', 'outline-offset-[-4px]', 'absolute', 'inset-0', 'pointer-events-none']));
    expect(ringClasses).not.toContain('outline-offset-2');
    expect(MEDIA_TILE_RING_INSIDE).toContain('outline-offset-[-4px]');
    const order = Array.from(tile.children).map((c) => (c as HTMLElement).dataset.slot ?? 'other');
    expect(order.indexOf('media-tile-ring')).toBe(order.indexOf('media-tile-art') + 1);
    expect(ring).toHaveAttribute('aria-hidden', 'true');
    // An unselected card has no ring at all.
    const { container: plain } = render(<ComicCard title="High Tide" onOpen={() => {}} />);
    expect(plain.querySelector('[data-slot="media-tile-ring"]')).toBeNull();
    expect(plain.querySelector('[data-slot="media-tile"]')!.className).not.toMatch(/outline/);
  });

  it('the row variant is the plan’s list row: 72 px (library.listRowPx) around a 48 × 64 cover, the title on one line', () => {
    const rowPx = layoutFor({ width: 320, height: 568, layout: 'single' }).library.listRowPx;
    expect(rowPx).toBe(72);
    const { container } = render(<ComicCard variant="row" title="Rain on Seventh Street" onOpen={() => {}} meta={['Comic', '2 of 8 pages']} cover={{ sources: { src: 'https://cdn.test/noir.webp' } }} />);
    const row = container.querySelector('[data-slot="comic-card"]') as HTMLElement;
    const rowClasses = row.className.split(/\s+/);
    // 1 px hairline + 3 px padding + 64 px cover = 72 px, at least (min-height, border-box).
    expect(rowClasses).toEqual(expect.arrayContaining([`min-h-[${rowPx}px]`, 'py-[3px]', 'border', 'items-center']));
    expect(rowClasses).not.toContain('p-3');
    const tile = container.querySelector('[data-slot="media-tile"]') as HTMLElement;
    expect(tile.style.aspectRatio).toBe('3 / 4');
    expect(tile.className.split(/\s+/)).toContain('w-12');
    // The cover inside follows the tile's box.
    expect(coverBox(container).style.aspectRatio).toBe('3 / 4');
    expect(container.querySelector('h3 [data-card-primary] span')!.className).toContain('line-clamp-1');
    // The comic's title is user content: the declutter probe lets it clamp (C6), as it does a cast name.
    expect(container.querySelector('h3 [data-card-primary] span')).toHaveAttribute('data-user-content');
  });

  it('links (href) keep the same shape: one link in the heading, Read outside it; the heading level follows the screen', () => {
    render(<ComicCard variant="public" title="Fox" href="/c/fox" read={{ href: '/c/fox' }} headingLevel={2} creator="@sol" />);
    const heading = screen.getByRole('heading', { level: 2 });
    expect(within(heading).getAllByRole('link')).toHaveLength(1);
    const readLink = screen.getByRole('link', { name: 'Read' });
    expect(heading.contains(readLink)).toBe(false);
  });
});

// ── CoverImage ────────────────────────────────────────────────────────────────────────────────────

describe('CoverImage', () => {
  it('is eager only with priority; every other cover is lazy', () => {
    const { rerender, container } = render(<CoverImage sources={{ w480: 'https://cdn.test/a-480.webp', w1080: 'https://cdn.test/a-1080.webp' }} />);
    const img = container.querySelector('img')!;
    expect(img).toHaveAttribute('loading', 'lazy');
    expect(img).not.toHaveAttribute('fetchpriority');
    expect(img.getAttribute('srcset')).toBe('https://cdn.test/a-480.webp 480w, https://cdn.test/a-1080.webp 1080w');
    rerender(<CoverImage priority sources={{ w480: 'https://cdn.test/a-480.webp', w1080: 'https://cdn.test/a-1080.webp' }} />);
    expect(container.querySelector('img')).toHaveAttribute('loading', 'eager');
    expect(container.querySelector('img')).toHaveAttribute('fetchpriority', 'high');
  });

  it('reserves its box before anything loads: the aspect and the comic tint are set, the picture is hidden until revealed', () => {
    const { container } = render(<CoverImage artColor="hsl(210 45% 55%)" sources={{ w480: 'https://cdn.test/a-480.webp' }} />);
    const box = coverBox(container);
    expect(box.style.aspectRatio).toBe('2 / 3');
    expect(box.style.getPropertyValue('--ds-art')).toBe('hsl(210 45% 55%)');
    expect(box.className).toContain('bg-[var(--ds-art)]');
    expect(container.querySelector('img')!.className).toContain('opacity-0');
  });

  it('shows the line-art EmptyArt in the same box when the cover fails to load (never a broken image)', () => {
    const { container } = render(<CoverImage sources={{ w480: 'https://cdn.test/broken.webp' }} />);
    fireEvent.error(container.querySelector('img')!);
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('[data-slot="cover-empty"] svg')).not.toBeNull();
    expect(coverBox(container).style.aspectRatio).toBe('2 / 3');
  });

  it('a publication card refuses a non-pub/ path or URL: no <img>, no signing, EmptyArt instead', () => {
    const resolve = vi.fn(() => 'https://cdn.test/u/private.webp');
    const { container, rerender } = render(<CoverImage publication path="u/user-1/p/draft/cover.webp" resolve={resolve} priority />);
    expect(container.querySelector('img')).toBeNull();
    expect(coverBox(container).dataset.cover).toBe('refused');
    expect(resolve).not.toHaveBeenCalled();
    rerender(<CoverImage publication coverOrigins={CDN} sources={{ w480: 'https://cdn.test/u/user-1/cover.webp' }} />);
    expect(container.querySelector('img')).toBeNull();
    expect(coverBox(container).dataset.cover).toBe('refused');
    // A published cover from a known origin is shown.
    rerender(<CoverImage publication coverOrigins={CDN} sources={{ w480: `https://cdn.test/${PUB}` }} />);
    expect(container.querySelector('img')).not.toBeNull();
    // The same draft is fine on the owner's own card.
    rerender(<CoverImage sources={{ w480: 'https://cdn.test/u/user-1/cover.webp' }} />);
    expect(container.querySelector('img')).not.toBeNull();
  });

  it('pins the publication path rule to the published-asset rule the exports use', () => {
    expect(PUBLICATION_PATH_RE.source).toBe(PUBLIC_ASSET_PATH_RE.source);
    expect(isPublicationCoverSource(PUB)).toBe(true);
    expect(isPublicationCoverSource(`https://edge.test/${PUB}?sig=1`, ['https://edge.test'])).toBe(true);
    for (const bad of ['u/1/p/2/cover.webp', 'pub/short/cover.webp', `http://evil.test/${PUB}`, `data:image/png;base64,AAAA`, `pub/AbCdEfGhIjKlMnOpQrStUv/../x.webp`, '']) {
      expect(isPublicationCoverSource(bad, ['https://edge.test', 'http://evil.test']), bad).toBe(false);
    }
  });

  it('a publication card refuses a pub/ cover URL from a foreign host (a tainted public row cannot load a third-party image)', () => {
    const foreign = `https://evil.test/${PUB}`;
    // The default origins are the storage origin (VITE_SUPABASE_URL) and this page's own; evil.test is neither.
    expect(publicationCoverOrigins()).not.toContain('https://evil.test');
    expect(publicationCoverOrigins()).toContain(window.location.origin);
    expect(isPublicationCoverSource(foreign)).toBe(false);
    expect(isPublicationCoverSource(foreign, ['https://edge.test'])).toBe(false);
    const { container, rerender } = render(<CoverImage publication sources={{ w480: foreign }} />);
    expect(container.querySelector('img')).toBeNull();
    expect(coverBox(container).dataset.cover).toBe('refused');
    // Adding an unrelated edge origin does not let it in either; the page's own origin is fine.
    rerender(<CoverImage publication coverOrigins={['https://edge.test']} sources={{ w480: foreign }} />);
    expect(container.querySelector('img')).toBeNull();
    rerender(<CoverImage publication sources={{ w480: `${window.location.origin}/${PUB}` }} />);
    expect(container.querySelector('img')).not.toBeNull();
    // The owner's own card is not a publication card: no origin rule there.
    rerender(<CoverImage sources={{ w480: foreign }} />);
    expect(container.querySelector('img')).not.toBeNull();
  });

  it('calls resolve only once the box is in view, and only once per picture', () => {
    const resolve = vi.fn((w: number) => `https://cdn.test/${PUB}?w=${w}`);
    const { container, rerender } = render(<CoverImage publication path={PUB} resolve={resolve} />);
    expect(resolve).not.toHaveBeenCalled();
    expect(container.querySelector('img')).toBeNull();
    act(() => ioShow(coverBox(container)));
    expect(resolve.mock.calls.map((c) => c[0])).toEqual([480, 1080]);
    expect(container.querySelector('img')!.getAttribute('srcset')).toContain('1080w');
    // A parent re-render (a new function identity) never re-signs the same cover.
    rerender(<CoverImage publication path={PUB} resolve={(w: number) => resolve(w)} />);
    expect(resolve).toHaveBeenCalledTimes(2);
  });

  it('Save-Data asks for the 480 px variant only', () => {
    const resolve = vi.fn((w: number) => `https://cdn.test/a-${w}.webp`);
    render(<CoverImage path="u/1/cover.webp" resolve={resolve} saveData priority />);
    expect(resolve.mock.calls.map((c) => c[0])).toEqual([480]);
  });

  it('reveals through useImageReveal: hidden until loaded and decoded, then one entrance; none under reduced motion', async () => {
    const { container, unmount } = render(<CoverImage sources={{ w480: 'https://cdn.test/a.webp' }} />);
    const img = container.querySelector('img')!;
    expect(img).toHaveAttribute('data-reveal', 'loading');
    expect(animate).not.toHaveBeenCalled();
    await act(async () => {
      fireEvent.load(img);
    });
    expect(container.querySelector('img')).toHaveAttribute('data-reveal', 'revealed');
    expect(container.querySelector('img')!.className).toContain('opacity-100');
    expect(animate).toHaveBeenCalledTimes(1);
    unmount();

    animate.mockClear();
    setMatchMedia((q) => q.includes('prefers-reduced-motion'));
    const reduced = render(<CoverImage sources={{ w480: 'https://cdn.test/b.webp' }} />);
    const img2 = reduced.container.querySelector('img')!;
    await act(async () => {
      fireEvent.load(img2);
    });
    expect(reduced.container.querySelector('img')).toHaveAttribute('data-reveal', 'revealed');
    expect(animate).not.toHaveBeenCalled();
  });

  it('a new picture in the same box is a new <img>: the old one (and its loaded pixels) never stands in for it', async () => {
    const { container, rerender } = render(<CoverImage path="u/1/a.webp" sources={{ w480: 'https://cdn.test/a.webp' }} />);
    const first = container.querySelector('img')!;
    await act(async () => {
      fireEvent.load(first);
    });
    expect(first).toHaveAttribute('data-reveal', 'revealed');
    // The first picture is in memory: complete, with pixels.
    Object.defineProperty(first, 'complete', { configurable: true, get: () => true });
    Object.defineProperty(first, 'naturalWidth', { configurable: true, get: () => 480 });
    rerender(<CoverImage path="u/1/b.webp" sources={{ w480: 'https://cdn.test/b.webp' }} />);
    const second = container.querySelector('img')!;
    expect(second).not.toBe(first);
    // Hidden until ITS bytes arrive (a reused element would read the old pixels as "already loaded").
    expect(second).toHaveAttribute('data-reveal', 'loading');
    expect(second.className).toContain('opacity-0');
    await act(async () => {
      fireEvent.load(second);
    });
    expect(container.querySelector('img')).toHaveAttribute('data-reveal', 'revealed');
  });
});

// ── MediaTile ─────────────────────────────────────────────────────────────────────────────────────

describe('MediaTile', () => {
  it('signs its art only when near the viewport, reveals it on load and marks a selected tile pressed', async () => {
    const resolve = vi.fn(() => 'https://cdn.test/u/p1.webp');
    const { container } = render(<MediaTile artKey="u/p1.webp" resolve={resolve} label="Page 1" onOpen={() => {}} selected selecting artColor="hsl(30 50% 50%)" />);
    const tile = container.querySelector('[data-slot="media-tile"]') as HTMLElement;
    expect(resolve).not.toHaveBeenCalled();
    act(() => ioShow(tile));
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(tile.style.getPropertyValue('--ds-art')).toBe('hsl(30 50% 50%)');
    await act(async () => {
      fireEvent.load(container.querySelector('img')!);
    });
    expect(container.querySelector('img')).toHaveAttribute('data-reveal', 'revealed');
    expect(screen.getByRole('button', { name: 'Page 1' })).toHaveAttribute('aria-pressed', 'true');
    // A tile on a grid (gap around it) keeps its ring set off the art.
    expect(tile.className).toContain('outline-offset-2');
    expect(tile.querySelector('[data-slot="media-tile-ring"]')).toBeNull();
  });
});

// ── CardGrid ──────────────────────────────────────────────────────────────────────────────────────

const ITEMS = ['a', 'b', 'c', 'd', 'e'];
const grid = (selecting: boolean, onExit = vi.fn()) => (
  <CardGrid
    items={ITEMS}
    getKey={(x) => x}
    columns={2}
    label="Your comics"
    selecting={selecting}
    onExitSelection={onExit}
    renderItem={(x) => <ComicCard title={`Comic ${x}`} onOpen={() => {}} read={{ onClick: () => {} }} />}
  />
);

describe('CardGrid', () => {
  it('is a list of list items with explicit columns, and every card stays in the natural Tab order', () => {
    render(grid(false));
    const list = screen.getByRole('list', { name: 'Your comics' });
    expect(list.tagName).toBe('UL');
    // Explicit: Safari drops a list's semantics once list-style is none, which the grid sets.
    expect(list).toHaveAttribute('role', 'list');
    expect(within(list).getAllByRole('listitem')).toHaveLength(5);
    expect(list.style.getPropertyValue('--cols')).toBe('2');
    expect(list.className).not.toMatch(/auto-fill|auto-fit/);
    for (const b of within(list).getAllByRole('button')) expect(b.getAttribute('tabindex')).toBeNull();
  });

  it('the first twelve items of a first page rise in, one after another; the thirteenth and later appear at once', () => {
    const many = Array.from({ length: 30 }, (_, i) => `c${i}`);
    const { container, rerender } = render(<CardGrid items={many} getKey={(x) => x} columns={3} label="Your comics" stagger renderItem={(x) => <span>{x}</span>} />);
    const list = screen.getByRole('list', { name: 'Your comics' });
    // No list-wide stagger rule (it animates every child, 300 cards included).
    expect(list.className).not.toContain('ds-stagger');
    const items = Array.from(list.children) as HTMLElement[];
    expect(CARD_GRID_STAGGER_MAX).toBe(12);
    for (let i = 0; i < 12; i++) {
      expect(items[i].className, `item ${i + 1}`).toContain('ds-rise-in');
      expect(items[i].style.animationDelay).toBe(`calc(${i} * var(--ds-motion-stagger))`);
    }
    for (const item of items.slice(12)) {
      expect(item.className).not.toMatch(/ds-rise-in|ds-stagger|animate/);
      expect(item.style.animationDelay).toBe('');
    }
    // A later page or a re-sort (stagger off) appears at once.
    rerender(<CardGrid items={many} getKey={(x) => x} columns={3} label="Your comics" renderItem={(x) => <span>{x}</span>} />);
    expect(container.querySelectorAll('.ds-rise-in')).toHaveLength(0);
  });

  it('takes no arrow key outside selection mode', () => {
    render(grid(false));
    const first = screen.getByRole('button', { name: 'Comic a' });
    first.focus();
    fireEvent.keyDown(first, { key: 'ArrowRight' });
    fireEvent.keyDown(first, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(first);
  });

  it('in selection mode the arrow keys move card to card (by one, by a row) and Esc leaves selection mode', () => {
    const onExit = vi.fn();
    render(grid(true, onExit));
    const first = screen.getByRole('button', { name: 'Comic a' });
    first.focus();
    fireEvent.keyDown(first, { key: 'ArrowRight' });
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Comic b' }));
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Comic d' }));
    fireEvent.keyDown(document.activeElement!, { key: 'End' });
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Comic e' }));
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
    expect(onExit).toHaveBeenCalledTimes(1);
  });

  it('grid moves stop at the ends and mirror right-to-left', () => {
    expect(nextGridIndex('ArrowLeft', 0, 5, 2)).toBe(0);
    expect(nextGridIndex('ArrowRight', 4, 5, 2)).toBe(4);
    expect(nextGridIndex('ArrowDown', 3, 5, 2)).toBe(3);
    expect(nextGridIndex('ArrowUp', 3, 5, 2)).toBe(1);
    expect(nextGridIndex('ArrowRight', 2, 5, 2, true)).toBe(1);
    expect(nextGridIndex('Tab', 0, 5, 2)).toBeNull();
  });
});

// ── SelectionBar ──────────────────────────────────────────────────────────────────────────────────

describe('SelectionBar', () => {
  it('announces its count in a polite live region as it changes', () => {
    const { rerender } = render(<SelectionBar count={3} noun="comic" onClear={() => {}} />);
    const status = screen.getByRole('status');
    expect(status).toHaveAttribute('aria-live', 'polite');
    expect(status).toHaveTextContent('3 comics selected');
    rerender(<SelectionBar count={1} noun="comic" onClear={() => {}} />);
    expect(screen.getByRole('status')).toHaveTextContent('1 comic selected');
    expect(selectionText(0, 'page')).toBe('Nothing selected');
  });

  it('Clear and Select all call back; Select all hides once everything is selected', () => {
    const clear = vi.fn();
    const all = vi.fn();
    const { rerender } = render(<SelectionBar count={2} total={5} onClear={clear} onSelectAll={all} />);
    fireEvent.click(screen.getByRole('button', { name: 'Select all' }));
    fireEvent.click(screen.getByRole('button', { name: 'Clear selection' }));
    expect(all).toHaveBeenCalledTimes(1);
    expect(clear).toHaveBeenCalledTimes(1);
    rerender(<SelectionBar count={5} total={5} onClear={clear} onSelectAll={all} />);
    expect(screen.queryByRole('button', { name: 'Select all' })).toBeNull();
  });
});

// ── Shelf ─────────────────────────────────────────────────────────────────────────────────────────

const shelf = (items: string[], extra: Partial<React.ComponentProps<typeof Shelf<string>>> = {}) => (
  <Shelf title="Trending" items={items} getKey={(x) => x} cardPx={140} renderItem={(x) => <ComicCard variant="rail" title={x} onOpen={() => {}} />} {...extra} />
);

describe('Shelf', () => {
  it('renders nothing when empty (no empty rails)', () => {
    const { container } = render(shelf([]));
    expect(container.innerHTML).toBe('');
  });

  it('shows the arrows only on a fine pointer', () => {
    setMatchMedia((q) => q === '(pointer: coarse)');
    const { unmount } = render(shelf(['a', 'b', 'c']));
    expect(screen.queryByRole('button', { name: /Scroll Trending/ })).toBeNull();
    expect(screen.getByRole('heading', { level: 2, name: 'Trending' })).toBeInTheDocument();
    unmount();
    setMatchMedia((q) => q === '(pointer: fine)');
    render(shelf(['a', 'b', 'c']));
    expect(screen.getByRole('button', { name: 'Scroll Trending left' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Scroll Trending right' })).toBeInTheDocument();
  });

  it('a failed shelf is an inline row with Retry; a loading one shows skeletons', () => {
    const retry = vi.fn();
    const { rerender, container } = render(shelf([], { error: true, onRetry: retry }));
    // A polite status, never an assertive alert (several failed shelves must not interrupt at load).
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByRole('status')).toHaveTextContent("Couldn't load Trending");
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(retry).toHaveBeenCalledTimes(1);
    rerender(shelf([], { loading: true, skeletonCount: 3 }));
    expect(container.querySelectorAll('[data-slot="skeleton"]').length).toBe(6);
  });

  it('the edge fade (a scroll-driven animation) is off under reduced motion: Shelf, scrolling FilterChips and PresetGrid', () => {
    const scrollers = () => {
      const r = render(
        <div>
          {shelf(['a', 'b'])}
          <FilterChips scroll value="all" onChange={() => {}} label="Filter" options={[{ value: 'all', label: 'All' }, { value: 'mine', label: 'Mine' }]} />
          <PresetGrid scroll label="Style" value="a" onChange={() => {}} options={[{ value: 'a', label: 'Ink', art: <span /> }, { value: 'b', label: 'Wash', art: <span /> }]} />
        </div>
      );
      const els = [screen.getByRole('list', { name: 'Trending' }), screen.getByRole('radiogroup', { name: 'Filter' }), screen.getByRole('radiogroup', { name: 'Style' })];
      return { ...r, els };
    };
    const moving = scrollers();
    for (const el of moving.els) expect(el.className, el.getAttribute('aria-label') ?? el.tagName).toContain('ds-fade-edge-x');
    moving.unmount();
    setMatchMedia((q) => q.includes('prefers-reduced-motion'));
    const still = scrollers();
    for (const el of still.els) expect(el.className, el.getAttribute('aria-label') ?? el.tagName).not.toContain('ds-fade-edge-x');
  });
});

// ── StatusPill ────────────────────────────────────────────────────────────────────────────────────

describe('StatusPill', () => {
  it('pings a live dot while drawing, and holds it still (no pulse, no animation) under reduced motion', () => {
    const { container, unmount } = render(<StatusPill state="drawing" label="Drawing 2 of 6" />);
    expect(container.querySelector('.ds-live-dot')).not.toBeNull();
    unmount();
    setMatchMedia((q) => q.includes('prefers-reduced-motion'));
    const reduced = render(<StatusPill state="drawing" label="Drawing 2 of 6" />);
    expect(reduced.container.querySelector('.ds-live-dot')).toBeNull();
    expect(reduced.container.querySelector('[class*="animate-"]')).toBeNull();
    expect(reduced.container.querySelector('[data-slot="status-pill-dot"]')).not.toBeNull();
  });

  it('never pulses at rest, keeps the full words as its name when compact, and follows the priority', () => {
    const { container } = render(<StatusPill state="idle" label="62% left" short="62%" compact onOpen={() => {}} />);
    expect(container.querySelector('.ds-live-dot')).toBeNull();
    expect(screen.getByRole('button', { name: '62% left' })).toHaveTextContent('62%');
    // A short form that is not the start of the words leads the name (label in name, WCAG 2.5.3).
    expect(pillName('2/6', 'Drawing 2 of 6')).toBe('2/6, Drawing 2 of 6');
    expect(pillName('Wait', 'Waiting for you')).toBe('Wait, Waiting for you');
    expect(pickPillState({ saving: true, drawing: true, waiting: true })).toBe('waiting');
    expect(pickPillState({ offline: true, error: true })).toBe('offline');
    expect(pickPillState({})).toBe('idle');
  });
});

// ── House rule: no component prints currency ─────────────────────────────────────────────────────

describe('no component renders a $', () => {
  it('every content-kit component, in its common states, prints no dollar or cent sign of its own', () => {
    setMatchMedia((q) => q === '(pointer: fine)');
    const pills: StatusPillState[] = ['offline', 'error', 'waiting', 'drawing', 'uploading', 'saving', 'idle'];
    const { container } = render(
      <div>
        <ComicCard title="A" onOpen={() => {}} read={{ onClick: () => {} }} open={{ onClick: () => {} }} meta={['Comic', '4 of 6 pages']} progress={{ value: 4, max: 6 }} />
        <ComicCard variant="hero" title="B" description="Logline" onOpen={() => {}} />
        <ComicCard variant="row" title="C" onOpen={() => {}} />
        <CoverImage sources={{ w480: 'https://cdn.test/a.webp' }} />
        <MediaTile caption="Page 1" label="Page 1" onOpen={() => {}} />
        <CardGrid items={['x']} getKey={(x) => x} columns={1} label="L" renderItem={(x) => <span>{x}</span>} />
        {shelf(['a'])}
        <SearchField value="moon" onChange={() => {}} label="Search" resultText="3 comics" />
        <FilterChips value="all" onChange={() => {}} label="Filter" options={[{ value: 'all', label: 'All', count: 4 }]} />
        <SelectionBar count={2} noun="page" onClear={() => {}} onSelectAll={() => {}} total={4} />
        {pills.map((p) => (
          <StatusPill key={p} state={p} label="Working" />
        ))}
        <StatusBanner tone="offline">Reading still works.</StatusBanner>
        <StatusBanner tone="error" title="Couldn't load" action={{ label: 'Retry', onClick: () => {} }} />
        <InlineMeta items={['Comic', '12 pp']} />
        <Row title="Row" meta={['x']} onOpen={() => {}} />
        <SourceBadge licence="OFL" source="Google Fonts" />
        <NavTrack items={[{ id: 'a', label: 'Home' }]} current="a" onSelect={() => {}} label="Places" />
        <PresetGrid label="Style" value="a" onChange={() => {}} options={[{ value: 'a', label: 'Ink', art: <span /> }]} />
        <Lightbox label="Viewer" index={0} onIndexChange={() => {}} items={[{ key: 'k', alt: 'Page 1' }]} />
      </div>
    );
    expect(container.textContent).not.toMatch(/[$¢]/);
    for (const el of Array.from(container.querySelectorAll('[aria-label],[title]'))) {
      expect(`${el.getAttribute('aria-label') ?? ''} ${el.getAttribute('title') ?? ''}`).not.toMatch(/[$¢]/);
    }
  });
});

// ── The rest of the kit's keyboard and semantics ──────────────────────────────────────────────────

describe('FilterChips, PresetGrid, NavTrack, Lightbox, SearchField', () => {
  it('FilterChips is a radio group with counts spoken and roving arrow keys', () => {
    const onChange = vi.fn();
    render(
      <FilterChips
        value="all"
        onChange={onChange}
        label="Filter comics"
        countNoun="comics"
        options={[
          { value: 'all', label: 'All', count: 6 },
          { value: 'drafts', label: 'Drafts', count: 3 }
        ]}
      />
    );
    expect(screen.getByRole('radiogroup', { name: 'Filter comics' })).toBeInTheDocument();
    const all = screen.getByRole('radio', { name: 'All, 6 comics' });
    const drafts = screen.getByRole('radio', { name: 'Drafts, 3 comics' });
    expect(all).toHaveAttribute('tabindex', '0');
    expect(drafts).toHaveAttribute('tabindex', '-1');
    fireEvent.keyDown(all, { key: 'ArrowRight' });
    expect(onChange).toHaveBeenCalledWith('drafts');
  });

  it('PresetGrid: radio semantics choose on arrows; pressed semantics toggle several', () => {
    const onRadio = vi.fn();
    const { unmount } = render(
      <PresetGrid label="Art style" value="ink" onChange={onRadio} columns={2} options={[{ value: 'ink', label: 'Ink', art: <span /> }, { value: 'wash', label: 'Wash', art: <span /> }, { value: 'tone', label: 'Tone', art: <span /> }]} />
    );
    const ink = screen.getByRole('radio', { name: /Ink/ });
    expect(ink).toHaveAttribute('aria-checked', 'true');
    fireEvent.keyDown(ink, { key: 'ArrowDown' });
    expect(onRadio).toHaveBeenCalledWith('tone');
    unmount();
    const onPressed = vi.fn();
    render(<PresetGrid semantics="pressed" label="Looks" value={['ink']} onChange={onPressed} options={[{ value: 'ink', label: 'Ink', art: <span /> }, { value: 'wash', label: 'Wash', art: <span /> }]} />);
    fireEvent.click(screen.getByRole('button', { name: /Wash/ }));
    expect(onPressed).toHaveBeenCalledWith(['ink', 'wash']);
    expect(screen.getByRole('button', { name: /Ink/ })).toHaveAttribute('aria-pressed', 'true');
  });

  it('NavTrack marks the current place, speaks badges and dots, and moves with the arrow keys', () => {
    render(
      <NavTrack
        label="Comic places"
        current="pages"
        onSelect={() => {}}
        items={[
          { id: 'home', label: 'Home' },
          { id: 'pages', label: 'Pages', badge: '4/6', badgeLabel: '4 of 6 pages drawn' },
          { id: 'director', label: 'Director', dot: 'new' }
        ]}
      />
    );
    const nav = screen.getByRole('navigation', { name: 'Comic places' });
    const pages = within(nav).getByRole('button', { name: 'Pages 4/6, 4 of 6 pages drawn' });
    expect(pages).toHaveAttribute('aria-current', 'page');
    expect(within(nav).getByRole('button', { name: 'Director, new reply' })).toHaveAttribute('tabindex', '-1');
    pages.focus();
    fireEvent.keyDown(pages, { key: 'ArrowRight' });
    expect(document.activeElement).toHaveAccessibleName('Director, new reply');
  });

  it('Lightbox: arrows and swipes move, the counter is polite, the ends stop', () => {
    const onIndex = vi.fn();
    render(
      <Lightbox
        label="Assets viewer"
        index={1}
        onIndexChange={onIndex}
        items={[
          { key: 'a', alt: 'A' },
          { key: 'b', alt: 'B' },
          { key: 'c', alt: 'C' }
        ]}
      />
    );
    const viewer = screen.getByRole('group', { name: 'Assets viewer' });
    expect(screen.getByRole('status')).toHaveTextContent('2 of 3');
    fireEvent.keyDown(viewer, { key: 'ArrowRight' });
    expect(onIndex).toHaveBeenLastCalledWith(2);
    // A swipe to the left brings the next picture; to the right, the previous one (the content follows the finger).
    onIndex.mockClear();
    fireEvent.pointerDown(viewer, { pointerType: 'touch', clientX: 200, clientY: 10, pointerId: 1 });
    fireEvent.pointerUp(viewer, { pointerType: 'touch', clientX: 100, clientY: 14, pointerId: 1 });
    expect(onIndex).toHaveBeenCalledTimes(1);
    expect(onIndex).toHaveBeenLastCalledWith(2);
    fireEvent.pointerDown(viewer, { pointerType: 'touch', clientX: 100, clientY: 10, pointerId: 2 });
    fireEvent.pointerUp(viewer, { pointerType: 'touch', clientX: 200, clientY: 12, pointerId: 2 });
    expect(onIndex).toHaveBeenCalledTimes(2);
    expect(onIndex).toHaveBeenLastCalledWith(0);
    // Too short, or more up and down than sideways: not a swipe.
    fireEvent.pointerDown(viewer, { pointerType: 'touch', clientX: 100, clientY: 10, pointerId: 3 });
    fireEvent.pointerUp(viewer, { pointerType: 'touch', clientX: 130, clientY: 10, pointerId: 3 });
    fireEvent.pointerDown(viewer, { pointerType: 'touch', clientX: 100, clientY: 10, pointerId: 4 });
    fireEvent.pointerUp(viewer, { pointerType: 'touch', clientX: 170, clientY: 200, pointerId: 4 });
    expect(onIndex).toHaveBeenCalledTimes(2);
    fireEvent.click(screen.getByRole('button', { name: 'Previous picture' }));
    expect(onIndex).toHaveBeenLastCalledWith(0);
  });

  it('Lightbox cross-fades between pictures with motion allowed, and simply swaps under reduced motion', () => {
    const items = [
      { key: 'a', alt: 'A' },
      { key: 'b', alt: 'B' },
      { key: 'c', alt: 'C' }
    ];
    const moving = render(<Lightbox label="Viewer" index={0} onIndexChange={() => {}} items={items} />);
    expect(animate).not.toHaveBeenCalled();
    moving.rerender(<Lightbox label="Viewer" index={1} onIndexChange={() => {}} items={items} />);
    expect(animate).toHaveBeenCalledTimes(1);
    moving.unmount();
    animate.mockClear();
    setMatchMedia((q) => q.includes('prefers-reduced-motion'));
    const still = render(<Lightbox label="Viewer" index={0} onIndexChange={() => {}} items={items} />);
    still.rerender(<Lightbox label="Viewer" index={1} onIndexChange={() => {}} items={items} />);
    still.rerender(<Lightbox label="Viewer" index={2} onIndexChange={() => {}} items={items} />);
    expect(screen.getByRole('status')).toHaveTextContent('3 of 3');
    expect(animate).not.toHaveBeenCalled();
  });

  it('PresetTile holds phrasing content only: no <div> inside its button', () => {
    render(<PresetTile label="Ink" description="Bold lines" art={<span>art</span>} badge={<span>New</span>} selected onSelect={() => {}} />);
    const tile = screen.getByRole('radio', { name: /Ink/ });
    expect(tile.tagName).toBe('BUTTON');
    expect(tile.querySelectorAll('div')).toHaveLength(0);
    expect(tile.querySelector('[data-slot="media-tile"]')!.tagName).toBe('SPAN');
  });

  it('SearchField: labelled, capped at 60 characters, Esc clears, Clear refocuses, / focuses from the page', () => {
    const onChange = vi.fn();
    const { rerender } = render(<SearchField value="" onChange={onChange} label="Search your comics" shortcut />);
    const input = screen.getByRole('searchbox', { name: 'Search your comics' });
    expect(input).toHaveAttribute('maxlength', '60');
    fireEvent.keyDown(window, { key: '/' });
    expect(document.activeElement).toBe(input);
    rerender(<SearchField value="moon" onChange={onChange} label="Search your comics" shortcut />);
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(onChange).toHaveBeenLastCalledWith('');
    fireEvent.click(screen.getByRole('button', { name: 'Clear search' }));
    expect(document.activeElement).toBe(input);
  });
});
