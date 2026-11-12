/**
 * The content kit (DS-R1; redesign plan §4, §10): ComicCard's one primary control inside its heading; CoverImage's
 * reserved box, lazy loading, publication rule, sign-when-visible and decode-gated reveal; CardGrid's list semantics
 * and selection-only arrow keys; SelectionBar's live count; Shelf's empty and pointer rules; StatusPill under reduced
 * motion; and no component printing a dollar.
 */
import React from 'react';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CardGrid, nextGridIndex } from './CardGrid';
import { ComicCard } from './ComicCard';
import { CoverImage, isPublicationCoverSource, PUBLICATION_PATH_RE } from './CoverImage';
import { FilterChips } from './FilterChips';
import { InlineMeta } from './InlineMeta';
import { Lightbox } from './Lightbox';
import { MediaTile } from './MediaTile';
import { NavTrack } from './NavTrack';
import { PresetGrid } from './PresetGrid';
import { Row } from './Row';
import { SearchField } from './SearchField';
import { SelectionBar, selectionText } from './SelectionBar';
import { Shelf } from './Shelf';
import { SourceBadge } from './SourceBadge';
import { StatusBanner } from './StatusBanner';
import { pickPillState, StatusPill, type StatusPillState } from './StatusPill';
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
    rerender(<CoverImage publication sources={{ w480: 'https://cdn.test/u/user-1/cover.webp' }} />);
    expect(container.querySelector('img')).toBeNull();
    expect(coverBox(container).dataset.cover).toBe('refused');
    // A published cover is shown.
    rerender(<CoverImage publication sources={{ w480: `https://cdn.test/${PUB}` }} />);
    expect(container.querySelector('img')).not.toBeNull();
    // The same draft is fine on the owner's own card.
    rerender(<CoverImage sources={{ w480: 'https://cdn.test/u/user-1/cover.webp' }} />);
    expect(container.querySelector('img')).not.toBeNull();
  });

  it('pins the publication path rule to the published-asset rule the exports use', () => {
    expect(PUBLICATION_PATH_RE.source).toBe(PUBLIC_ASSET_PATH_RE.source);
    expect(isPublicationCoverSource(PUB)).toBe(true);
    expect(isPublicationCoverSource(`https://edge.test/${PUB}?sig=1`)).toBe(true);
    for (const bad of ['u/1/p/2/cover.webp', 'pub/short/cover.webp', `http://evil.test/${PUB}`, `data:image/png;base64,AAAA`, `pub/AbCdEfGhIjKlMnOpQrStUv/../x.webp`, '']) {
      expect(isPublicationCoverSource(bad), bad).toBe(false);
    }
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
    expect(within(list).getAllByRole('listitem')).toHaveLength(5);
    expect(list.style.getPropertyValue('--cols')).toBe('2');
    expect(list.className).not.toMatch(/auto-fill|auto-fit/);
    for (const b of within(list).getAllByRole('button')) expect(b.getAttribute('tabindex')).toBeNull();
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
    expect(screen.getByRole('alert')).toHaveTextContent("Couldn't load Trending");
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(retry).toHaveBeenCalledTimes(1);
    rerender(shelf([], { loading: true, skeletonCount: 3 }));
    expect(container.querySelectorAll('[data-slot="skeleton"]').length).toBe(6);
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
    fireEvent.pointerDown(viewer, { pointerType: 'touch', clientX: 200, clientY: 10, pointerId: 1 });
    fireEvent.pointerUp(viewer, { pointerType: 'touch', clientX: 100, clientY: 14, pointerId: 1 });
    expect(onIndex).toHaveBeenLastCalledWith(2);
    fireEvent.click(screen.getByRole('button', { name: 'Previous picture' }));
    expect(onIndex).toHaveBeenLastCalledWith(0);
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
