// PF-2 (perf F2 + styles M4): chat render tiles load small variants lazily and say how long a drawing has
// taken against the model's usual time, with the model's name, on ONE shared clock that never fetches.
import React from 'react';
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { createEmptyDoc, variantFor, type AssetRef, type ComicDoc, type RenderState } from '../../../../shared/comic/doc';
import { jobModel } from '../../board/boardModel';
import { RenderOverlay, registerStudioRefresh, SLOW_FACTOR as BOARD_SLOW_FACTOR } from '../../board/ui';
import { CardRenderer } from './CardRenderer';
import { CastAvatar } from './castVisual';
import { RenderThumb, SLOW_FACTOR, TILE_CLOCK_MS, describeTarget, tileProgress, tileSources, unsignableOf } from './renderTile';
import { makeFakeStudio, makeSampleDoc, resetUsageStatus, showUsagePrices } from '../testing/fixtures';
import type { ComicStudioController } from '../../useStudio';

const T0 = 1_780_000_000_000;

/** A stored render with server-style variants (480w and 1080w, only those narrower than the original). */
const stored = (name: string, w = 1536, h = 2304, extra: Partial<AssetRef> = {}): AssetRef => ({
  path: `u/x/p/${name}.png`,
  w,
  h,
  source: 'generated',
  at: T0,
  variants: [480, 1080].filter((vw) => vw < w).map((vw) => ({ path: `u/x/p/${name}_w${vw}.webp`, w: vw, h: Math.round((h * vw) / w) })),
  ...extra
});

/** The production signer's contract: a width picks the smallest stored variant ≥ width × min(dpr, 2). */
const signer = (calls: Array<{ path: string; width?: number }> = []) => (asset?: AssetRef | string | null, opts?: { width?: number }) => {
  if (!asset) return undefined;
  const path = typeof asset === 'string' ? asset : asset.path;
  calls.push({ path, width: opts?.width });
  const pick = typeof asset === 'object' && opts?.width ? variantFor(asset, opts.width, 1) : { path };
  return `https://cdn.test/${pick.path}`;
};

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  resetUsageStatus();
});

describe('tileSources (perf F2: the ≤ 480w variant, never the original)', () => {
  it('asks the signer for the 480w variant and lists only that file in srcSet', () => {
    const calls: Array<{ path: string; width?: number }> = [];
    const s = tileSources(signer(calls), stored('p1'));
    expect(s.url).toBe('https://cdn.test/u/x/p/p1_w480.webp');
    expect(s.srcSet).toBe('https://cdn.test/u/x/p/p1_w480.webp 480w');
    expect(s.heavy).toBe(false);
    // Every request is either the width request or the variant itself: the original is never asked for bare.
    expect(calls.filter((c) => c.path === 'u/x/p/p1.png' && !c.width)).toEqual([]);
  });

  it('waits for the small file instead of showing the original while the variant is still being signed', () => {
    // useStudio.urlFor hands back the ORIGINAL for a width request while the variant is unsigned (it never fetches both).
    const signedOriginalOnly = (asset?: AssetRef | string | null) =>
      asset && typeof asset === 'object' ? `https://cdn.test/${asset.path}` : undefined;
    expect(tileSources(signedOriginalOnly, stored('p2'))).toEqual({ heavy: false });
  });

  it('art stored before variants keeps its original, marked heavy; a small original is not heavy', () => {
    const legacy = { path: 'u/x/p/old.png', w: 1600, h: 2000, source: 'generated', at: T0 } as AssetRef;
    expect(tileSources(signer(), legacy)).toMatchObject({ url: 'https://cdn.test/u/x/p/old.png', heavy: true });
    expect(tileSources(signer(), { ...legacy, w: 400, h: 500 })).toMatchObject({ url: 'https://cdn.test/u/x/p/old.png', heavy: false });
  });

  it('a small file the signer gave up on reads unavailable: nothing is signed, never the original', () => {
    const calls: Array<{ path: string; width?: number }> = [];
    const isUnsignable = (p: string) => p === 'u/x/p/p5_w480.webp';
    expect(tileSources(signer(calls), stored('p5'), undefined, isUnsignable)).toEqual({ heavy: false, unavailable: true });
    expect(calls).toEqual([]);
    // A broken variant keeps its dead URL in the signer's table: without the check the tile would build a srcSet
    // the browser never recovers from (it does not fall back from a failed srcset candidate to src).
    expect(tileSources(signer(), stored('p5')).srcSet).toBe('https://cdn.test/u/x/p/p5_w480.webp 480w');
    // Other files are unaffected.
    expect(tileSources(signer(), stored('p6'), undefined, isUnsignable).srcSet).toBe('https://cdn.test/u/x/p/p6_w480.webp 480w');
  });

  it('unsignableOf reads the controller\'s isUnsignable when it has one', () => {
    expect(unsignableOf(makeFakeStudio())).toBeUndefined();
    const studio = { ...makeFakeStudio(), isUnsignable: (p: string) => p.endsWith('_w480.webp') };
    expect(unsignableOf(studio)?.('u/x/p/a_w480.webp')).toBe(true);
    expect(unsignableOf(studio)?.('u/x/p/a.png')).toBe(false);
  });

  it('a blocked image is never signed', () => {
    const calls: Array<{ path: string; width?: number }> = [];
    const blocked = stored('bad', 1536, 2304, { safety: { assessed: 'X', at: T0 } });
    expect(tileSources(signer(calls), blocked)).toEqual({ heavy: false });
    expect(calls).toEqual([]);
  });
});

describe('RenderThumb images', () => {
  it('renders a lazy, async-decoded <img> with the variant srcSet', () => {
    const asset = stored('p3');
    const src = tileSources(signer(), asset);
    render(
      <RenderThumb render={{ status: 'ready', history: [], asset }} label="Page 3" aspect="2 / 3" url={src.url} srcSet={src.srcSet} sizes={src.sizes} heavy={src.heavy} />
    );
    const img = screen.getByAltText('Page 3');
    expect(img).toHaveAttribute('src', 'https://cdn.test/u/x/p/p3_w480.webp');
    expect(img).toHaveAttribute('srcset', 'https://cdn.test/u/x/p/p3_w480.webp 480w');
    expect(img).toHaveAttribute('loading', 'lazy');
    expect(img).toHaveAttribute('decoding', 'async');
    expect(img).not.toHaveAttribute('data-heavy-img');
  });

  it('an unavailable preview reads "Preview unavailable", still: no shimmer, no <img>', () => {
    const asset = stored('p7');
    const { container } = render(<RenderThumb render={{ status: 'ready', history: [], asset }} label="Page 7" aspect="2 / 3" unavailable />);
    expect(screen.getByRole('img', { name: 'Page 7: preview unavailable here' })).toHaveTextContent('Preview unavailable');
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('.studio-shimmer')).toBeNull();
  });

  it('a blocked image reads "Withheld" and mounts no <img>', () => {
    const asset = stored('bad', 1536, 2304, { safety: { assessed: 'X', at: T0 } });
    const { container } = render(<RenderThumb render={{ status: 'ready', history: [], asset }} label="Page 4" aspect="2 / 3" url={undefined} />);
    expect(screen.getByRole('img', { name: 'Page 4: image withheld' })).toHaveTextContent('Withheld');
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('.studio-shimmer')).toBeNull();
  });
});

describe('RenderThumb develops each new picture once it has arrived (MO-1 x PF-2: useImageReveal on the children path)', () => {
  type Played = { el: Element; finish: () => void; cancel: ReturnType<typeof vi.fn> };
  let played: Played[] = [];
  let decodes: Array<() => void> = [];
  const realAnimate = (Element.prototype as unknown as { animate?: unknown }).animate;
  const realDecode = (HTMLImageElement.prototype as unknown as { decode?: unknown }).decode;

  beforeEach(() => {
    played = [];
    decodes = [];
    (Element.prototype as unknown as { animate?: unknown }).animate = function (this: Element) {
      let finish!: () => void;
      const finished = new Promise<void>((r) => (finish = r));
      const cancel = vi.fn();
      played.push({ el: this, finish, cancel });
      return { finished, cancel } as unknown as Animation;
    };
    (HTMLImageElement.prototype as unknown as { decode?: unknown }).decode = vi.fn(() => new Promise<void>((r) => decodes.push(r)));
  });
  afterEach(() => {
    if (realAnimate === undefined) delete (Element.prototype as unknown as { animate?: unknown }).animate;
    else (Element.prototype as unknown as { animate?: unknown }).animate = realAnimate;
    if (realDecode === undefined) delete (HTMLImageElement.prototype as unknown as { decode?: unknown }).decode;
    else (HTMLImageElement.prototype as unknown as { decode?: unknown }).decode = realDecode;
  });

  const develop = (container: HTMLElement) => container.querySelector('[data-develop]') as HTMLElement;
  const arrive = async (img: HTMLElement) => {
    act(() => {
      fireEvent.load(img);
    });
    await act(async () => {
      for (const r of decodes.splice(0)) r();
      await Promise.resolve();
    });
  };
  const settle = async () => {
    await act(async () => {
      for (const a of played) a.finish();
      await Promise.resolve();
      await Promise.resolve();
    });
  };
  const thumb = (asset: AssetRef, url: string, status: RenderState['status'] = 'ready') => (
    <RenderThumb render={{ status, history: [], asset, updatedAt: Date.now() }} label="Page 2" aspect="2 / 3" url={url} />
  );

  it('a tile whose small file is signed late mounts its <img> with the gate and develops it', async () => {
    const asset = stored('late');
    const { container, rerender } = render(<RenderThumb render={{ status: 'ready', history: [], asset, updatedAt: Date.now() }} label="Page 2" aspect="2 / 3" url={undefined} />);
    expect(container.querySelector('.studio-shimmer')).not.toBeNull();
    expect(container.querySelector('img')).toBeNull();
    rerender(thumb(asset, 'https://cdn.test/u/x/p/late_w480.webp'));
    expect(develop(container)).toHaveAttribute('data-develop', 'loading');
    expect(played).toEqual([]);
    await arrive(screen.getByAltText('Page 2'));
    expect(develop(container)).toHaveAttribute('data-develop', 'revealed');
    expect(played.length).toBeGreaterThan(0);
    await settle();
    expect(container.querySelector('[data-develop-placeholder]')).toBeNull();
  });

  it('a redraw that lands in the same tile waits for the new art and develops it; a re-signed url does neither', async () => {
    const one = stored('one');
    const { container, rerender } = render(thumb(one, 'https://cdn.test/u/x/p/one_w480.webp'));
    await arrive(screen.getByAltText('Page 2'));
    await settle();
    expect(container.querySelector('[data-develop-placeholder]')).toBeNull();
    const firstDevelop = played.length;
    expect(firstDevelop).toBeGreaterThan(0);

    // The same file, signed again (a new query string): it stays on screen and does not develop again.
    rerender(thumb(one, 'https://cdn.test/u/x/p/one_w480.webp?sig=2'));
    expect(develop(container)).toHaveAttribute('data-develop', 'revealed');
    expect(container.querySelector('[data-develop-placeholder]')).toBeNull();
    expect(played).toHaveLength(firstDevelop);

    // The redraw is drawing: the old picture stays up (rendering + url) …
    rerender(thumb(one, 'https://cdn.test/u/x/p/one_w480.webp?sig=2', 'rendering'));
    expect(screen.getByAltText('Page 2')).toHaveAttribute('src', 'https://cdn.test/u/x/p/one_w480.webp?sig=2');
    // … then the new picture arrives in the same tile: it is held until it has loaded and decoded, then develops.
    const two = stored('two');
    rerender(thumb(two, 'https://cdn.test/u/x/p/two_w480.webp'));
    expect(develop(container)).toHaveAttribute('data-develop', 'loading');
    expect(container.querySelector('[data-develop-placeholder]')).not.toBeNull();
    expect(played).toHaveLength(firstDevelop);
    await arrive(screen.getByAltText('Page 2'));
    expect(develop(container)).toHaveAttribute('data-develop', 'revealed');
    expect(played.length).toBeGreaterThan(firstDevelop);
    await settle();
    expect(container.querySelector('[data-develop-placeholder]')).toBeNull();
  });
});

describe('CastAvatar (perf F2)', () => {
  const character = (sheet: RenderState) => ({ ...makeSampleDoc().cast[0], sheet });

  it('loads the sheet’s 480w variant lazily, never the original', () => {
    const { container } = render(<CastAvatar character={character({ status: 'ready', history: [], asset: stored('maya', 1536, 1024) })} urlFor={signer()} size={40} />);
    const img = container.querySelector('img')!;
    expect(img).toHaveAttribute('src', 'https://cdn.test/u/x/p/maya_w480.webp');
    expect(img).toHaveAttribute('loading', 'lazy');
    expect(img).toHaveAttribute('decoding', 'async');
    expect(img).toHaveAttribute('sizes', '40px');
  });

  it('a blocked sheet falls back to initials (no image requested)', () => {
    const calls: Array<{ path: string; width?: number }> = [];
    const asset = stored('maya', 1536, 1024, { safety: { assessed: 'X', at: T0 } });
    const { container } = render(<CastAvatar character={character({ status: 'ready', history: [], asset })} urlFor={signer(calls)} size={40} />);
    expect(container.querySelector('img')).toBeNull();
    expect(container).toHaveTextContent('M');
    expect(calls).toEqual([]);
  });
});

describe('tileProgress (styles M4)', () => {
  it('elapsed vs the usual time, then "taking longer than usual" at the board\'s 2.5×, then a stopped clock', () => {
    expect(tileProgress('rendering', T0, T0 + 12_000, 20)).toEqual({ elapsed: '12s', hint: 'usually ~20s', bar: true, ticking: true });
    // Past 1× is normal (the usual time is the median): the chat keeps saying "usually ~20s", as the board does.
    expect(tileProgress('rendering', T0, T0 + 25_000, 20)).toEqual({ elapsed: '25s', hint: 'usually ~20s', bar: true, ticking: true });
    expect(tileProgress('rendering', T0, T0 + 50_000, 20)).toEqual({ elapsed: '50s', hint: 'usually ~20s', bar: true, ticking: true });
    expect(tileProgress('rendering', T0, T0 + 51_000, 20)).toEqual({ elapsed: '51s', hint: 'taking longer than usual', bar: false, ticking: true });
    expect(tileProgress('rendering', T0, T0 + 201_000, 20)).toEqual({ hint: 'much longer than usual', bar: false, ticking: false, stuck: true });
    expect(tileProgress('rendering', undefined, T0, 20)).toEqual({ hint: 'usually ~20s', bar: true, ticking: false });
    expect(tileProgress('queued', T0, T0 + 5_000, 20)).toEqual({ bar: false, ticking: false });
    // A device clock behind the server's never shows a negative time.
    expect(tileProgress('rendering', T0, T0 - 4_000, 20).elapsed).toBe('0s');
  });
});

describe('drawing tiles (styles M4)', () => {
  const pageDoc = (status: RenderState['status'], n = 1): ComicDoc => {
    const doc = makeSampleDoc();
    return {
      ...doc,
      pages: doc.pages.map((p, i) => (i < n ? { ...p, render: { status, history: [], updatedAt: T0 } } : p))
    };
  };
  const rendersCard = (doc: ComicDoc, n: number) => ({
    type: 'renders' as const,
    id: 'r1',
    label: 'Drawing pages',
    targets: doc.pages.slice(0, n).map((p) => ({ kind: 'page' as const, id: p.id }))
  });

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout', 'Date'] });
    vi.setSystemTime(T0);
  });

  it('shows the elapsed time, "usually ~20s" and the model while rendering, then "taking longer than usual"', () => {
    const doc = pageDoc('rendering');
    const studio = makeFakeStudio({ doc, urlFor: signer() });
    render(<CardRenderer card={rendersCard(doc, 1)} studio={studio} />);
    const spec = jobModel(doc, 'page');
    const tile = screen.getByText('Page 1').closest('div')!;
    expect(spec.latencySec).toBe(20); // the default model's usual time, from the registry
    expect(within(tile).getByText('Drawing…')).toBeInTheDocument();
    expect(tile.querySelector('[data-tile-progress]')).toHaveTextContent(`0s · usually ~20s${spec.nickname}`);
    expect(tile.querySelector('[data-progress-bar]')).not.toBeNull();
    act(() => void vi.advanceTimersByTime(12 * TILE_CLOCK_MS));
    expect(tile.querySelector('[data-tile-progress]')).toHaveTextContent('12s · usually ~20s');
    expect(within(tile).getByText(spec.nickname)).toBeInTheDocument();
    act(() => void vi.advanceTimersByTime(13 * TILE_CLOCK_MS));
    // 25 s is a normal render (the board still reads "(usually ~20s)" here): no alarm yet, the bar keeps going.
    expect(tile.querySelector('[data-tile-progress]')).toHaveTextContent('25s · usually ~20s');
    expect(tile.querySelector('[data-progress-bar]')).not.toBeNull();
    act(() => void vi.advanceTimersByTime(26 * TILE_CLOCK_MS));
    expect(tile.querySelector('[data-tile-progress]')).toHaveTextContent('51s · taking longer than usual');
    expect(tile.querySelector('[data-progress-bar]')).toBeNull();
  });

  it('one shared clock for every drawing tile: no fetch, nothing while hidden, stopped when done or stuck', () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const intervalSpy = vi.spyOn(globalThis, 'setInterval');
    const doc = pageDoc('rendering', 3);
    const studio = makeFakeStudio({ doc, urlFor: signer() });
    const { rerender } = render(<CardRenderer card={rendersCard(doc, 3)} studio={studio} />);
    expect(intervalSpy).toHaveBeenCalledTimes(1); // three drawing tiles, one interval
    act(() => void vi.advanceTimersByTime(5 * TILE_CLOCK_MS));
    expect(screen.getAllByText(/^5s · usually ~20s$/)).toHaveLength(3);

    // A background tab keeps what it showed (no re-render work while nobody looks).
    const vis = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    act(() => void vi.advanceTimersByTime(4 * TILE_CLOCK_MS));
    expect(screen.getAllByText(/^5s · usually ~20s$/)).toHaveLength(3);
    vis.mockRestore();
    act(() => void vi.advanceTimersByTime(TILE_CLOCK_MS));
    expect(screen.getAllByText(/^10s · usually ~20s$/)).toHaveLength(3);
    expect(fetchSpy).not.toHaveBeenCalled();

    // Everything drew: the clock is gone (nothing left scheduled).
    const done = { ...doc, pages: doc.pages.map((p) => ({ ...p, render: { status: 'ready' as const, history: [], asset: stored(p.id), updatedAt: T0 + 10_000 } })) };
    rerender(<CardRenderer card={rendersCard(doc, 3)} studio={{ ...studio, doc: done } as ComicStudioController} />);
    expect(vi.getTimerCount()).toBe(0);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('a render far past its usual time stops the clock and says so', () => {
    const doc = pageDoc('rendering');
    render(<CardRenderer card={rendersCard(doc, 1)} studio={makeFakeStudio({ doc, urlFor: signer() })} />);
    act(() => void vi.advanceTimersByTime(201 * TILE_CLOCK_MS));
    expect(screen.getByText('much longer than usual')).toBeInTheDocument();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('a queued tile names the model and runs no clock', () => {
    const doc = pageDoc('queued');
    render(<CardRenderer card={rendersCard(doc, 1)} studio={makeFakeStudio({ doc, urlFor: signer() })} />);
    expect(screen.getByText('Queued')).toBeInTheDocument();
    expect(screen.getByText(jobModel(doc, 'page').nickname)).toBeInTheDocument();
    expect(screen.queryByText(/usually ~/)).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('style boards drawing in the style card show the same progress', () => {
    const doc = makeSampleDoc(); // opt_b is rendering since its updatedAt
    const options = doc.style.options.map((o) => (o.id === 'opt_b' ? { ...o, render: { ...o.render, updatedAt: T0 - 7_000 } } : o));
    render(<CardRenderer card={{ type: 'style_choice', id: 'sc' }} studio={makeFakeStudio({ doc: { ...doc, style: { ...doc.style, options } }, urlFor: signer() })} />);
    expect(screen.getByText('7s · usually ~20s')).toBeInTheDocument();
    expect(screen.getByText(jobModel(doc, 'style_option').nickname)).toBeInTheDocument();
  });

  it('governed users read time and model, never dollars', () => {
    showUsagePrices();
    const doc = pageDoc('rendering', 2);
    const { container } = render(<CardRenderer card={rendersCard(doc, 2)} studio={makeFakeStudio({ doc, urlFor: signer() })} />);
    expect(screen.getAllByText(/usually ~20s/)).toHaveLength(2);
    expect(container.textContent).not.toMatch(/[$¢]/);
  });

  it('the live dot is the ds-live-dot (paused off screen, still under reduced motion), not a bare pulse', () => {
    const doc = pageDoc('rendering');
    const { container } = render(<CardRenderer card={rendersCard(doc, 1)} studio={makeFakeStudio({ doc, urlFor: signer() })} />);
    expect(container.querySelector('.ds-live-dot')).not.toBeNull();
    expect(container.querySelector('.animate-pulse')).toBeNull();
    expect(container.querySelector('[data-progress-bar]')).toHaveClass('ds-progress-indeterminate');
  });

  it('describeTarget names the model and its usual time for every kind', () => {
    const doc = makeSampleDoc();
    for (const target of [
      { kind: 'page' as const, id: 'pg_1' },
      { kind: 'cover' as const },
      { kind: 'sheet' as const, id: 'c_maya' },
      { kind: 'style_option' as const, id: 'opt_a' }
    ]) {
      const meta = describeTarget(doc, target)!;
      expect(meta.model).toBeTruthy();
      expect(meta.typicalSec).toBe(20);
    }
    expect(createEmptyDoc('p', 't', T0).pages).toEqual([]);
  });
});

describe('the chat and the board agree on one render (styles M4)', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout', 'Date'] });
  });

  it('"taking longer than usual" and "much longer than usual" start at the same second as the board’s RenderOverlay', () => {
    expect(SLOW_FACTOR).toBe(2.5);
    // One constant, not two that agree today (PF-2 #6): the tiles read board/ui's SLOW_FACTOR, and neither file
    // spells its own threshold.
    expect(SLOW_FACTOR).toBe(BOARD_SLOW_FACTOR);
    const source = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8');
    expect(source('./renderTile.tsx')).not.toMatch(/const SLOW_FACTOR\s*=/);
    expect(source('../../board/ui.tsx')).not.toMatch(/typicalSec \* 2500/);
    for (const sec of [12, 25, 49, 50, 51, 120, 199, 201]) {
      vi.setSystemTime(T0 + sec * 1000);
      const { container } = render(
        <div className="relative">
          <RenderOverlay status="rendering" since={T0} typicalSec={20} model="Test model" />
        </div>
      );
      const board = container.textContent || '';
      cleanup();
      const tile = tileProgress('rendering', T0, T0 + sec * 1000, 20);
      expect({ sec, slow: tile.hint === 'taking longer than usual' }).toEqual({ sec, slow: /taking longer than usual/.test(board) });
      expect({ sec, stuck: !!tile.stuck }).toEqual({ sec, stuck: /much longer than usual/.test(board) });
      expect({ sec, usual: tile.hint === 'usually ~20s' }).toEqual({ sec, usual: /usually ~20s/.test(board) });
    }
  });
});

describe('a stuck drawing tile (far past its usual time)', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout', 'Date'] });
    vi.setSystemTime(T0);
  });

  it('holds still, says "Still drawing" and offers a free Check again that reaches only the studio refresh', () => {
    const refresh = vi.fn();
    const off = registerStudioRefresh(refresh);
    try {
      const onOpen = vi.fn();
      const parent = vi.fn();
      const asset = stored('p9');
      vi.setSystemTime(T0 + 201_000);
      const { container } = render(
        <div onClick={parent}>
          <RenderThumb render={{ status: 'rendering', history: [], asset, updatedAt: T0 }} label="Page 9" aspect="2 / 3" url="https://cdn.test/u/x/p/p9_w480.webp" onOpen={onOpen} typicalSec={20} />
        </div>
      );
      expect(screen.getByText('Still drawing')).toBeInTheDocument();
      expect(screen.queryByText('Drawing…')).toBeNull();
      expect(screen.getByText('much longer than usual')).toBeInTheDocument();
      expect(container.querySelector('.ds-live-dot')).toBeNull();
      expect(container.querySelector('[data-still-dot]')).not.toBeNull();
      expect(container.querySelector('[data-progress-bar]')).toBeNull();
      // No button inside a button: while the tile holds Check again it is not itself the open button.
      expect(container.querySelectorAll('button')).toHaveLength(1);
      fireEvent.click(screen.getByRole('button', { name: 'Check again: Page 9' }));
      expect(refresh).toHaveBeenCalledTimes(1);
      expect(onOpen).not.toHaveBeenCalled();
      expect(parent).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0); // user-initiated only: nothing scheduled
    } finally {
      off();
    }
  });

  it('in a renders card: no shimmer, no ping, and Check again uses the card’s own refresh when given none', () => {
    const refresh = vi.fn();
    const off = registerStudioRefresh(refresh);
    try {
      const base = makeSampleDoc();
      const doc = { ...base, pages: base.pages.map((p, i) => (i === 0 ? { ...p, render: { status: 'rendering' as const, history: [], updatedAt: T0 } } : p)) };
      const card = { type: 'renders' as const, id: 'r1', label: 'Drawing pages', targets: [{ kind: 'page' as const, id: doc.pages[0].id }] };
      const { container } = render(<CardRenderer card={card} studio={makeFakeStudio({ doc, urlFor: signer() })} />);
      expect(container.querySelector('.ds-live-dot')).not.toBeNull();
      act(() => void vi.advanceTimersByTime(201 * TILE_CLOCK_MS));
      expect(container.querySelector('.ds-live-dot')).toBeNull();
      expect(container.querySelector('.studio-shimmer')).toBeNull();
      expect(container.querySelector('[data-stuck]')).not.toBeNull();
      fireEvent.click(screen.getByRole('button', { name: `Check again: Page ${doc.pages[0].n}` }));
      expect(refresh).toHaveBeenCalledTimes(1);
    } finally {
      off();
    }
  });

  it('without an open studio there is nothing to re-check: no dead button', () => {
    vi.setSystemTime(T0 + 201_000);
    render(<RenderThumb render={{ status: 'rendering', history: [], updatedAt: T0 }} label="Page 2" aspect="2 / 3" typicalSec={20} />);
    expect(screen.getByText('Still drawing')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Check again/ })).toBeNull();
  });
});

describe('one live pulse per view (declutter C9)', () => {
  const drawing = (n: number, ready: number[] = []): ComicDoc => {
    const doc = makeSampleDoc();
    return {
      ...doc,
      pages: doc.pages.map((p, i) =>
        i < n ? { ...p, render: ready.includes(i) ? { status: 'ready' as const, history: [], asset: stored(p.id), updatedAt: T0 } : { status: 'rendering' as const, history: [], updatedAt: T0 } } : p
      )
    };
  };
  const card = (doc: ComicDoc, n: number) => ({ type: 'renders' as const, id: 'r1', label: 'Drawing pages', targets: doc.pages.slice(0, n).map((p) => ({ kind: 'page' as const, id: p.id })) });

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout', 'Date'] });
    vi.setSystemTime(T0);
  });

  it('three drawing tiles: one ping and one sweeping bar (the first tile’s); the others keep a still dot', () => {
    const doc = drawing(3);
    const studio = makeFakeStudio({ doc, urlFor: signer() });
    const { container, rerender } = render(<CardRenderer card={card(doc, 3)} studio={studio} />);
    expect(container.querySelectorAll('.ds-live-dot')).toHaveLength(1);
    expect(container.querySelectorAll('[data-progress-bar]')).toHaveLength(1);
    expect(container.querySelectorAll('[data-still-dot]')).toHaveLength(2);
    const tileOf = (el: Element | null) => el?.closest('.w-full.min-w-0')?.textContent || '';
    expect(tileOf(container.querySelector('.ds-live-dot'))).toContain(`Page ${doc.pages[0].n}`);

    // The first one finishes: the next drawing tile takes the pulse on the next tick, still exactly one.
    const next = drawing(3, [0]);
    rerender(<CardRenderer card={card(next, 3)} studio={{ ...studio, doc: next } as ComicStudioController} />);
    act(() => void vi.advanceTimersByTime(TILE_CLOCK_MS));
    expect(container.querySelectorAll('.ds-live-dot')).toHaveLength(1);
    expect(container.querySelectorAll('[data-progress-bar]')).toHaveLength(1);
    expect(tileOf(container.querySelector('.ds-live-dot'))).toContain(`Page ${doc.pages[1].n}`);
  });

  it('two cards drawing at once still show one ping between them', () => {
    const doc = drawing(3);
    const studio = makeFakeStudio({ doc, urlFor: signer() });
    const { container } = render(
      <>
        <CardRenderer card={card(doc, 2)} studio={studio} />
        <CardRenderer card={{ ...card(doc, 3), id: 'r2' }} studio={studio} />
      </>
    );
    expect(container.querySelectorAll('.ds-live-dot')).toHaveLength(1);
    expect(container.querySelectorAll('[data-still-dot]')).toHaveLength(4);
  });

  it('live={false} keeps a tile still; live forces the pulse', () => {
    const { container, rerender } = render(<RenderThumb render={{ status: 'rendering', history: [], updatedAt: T0 }} label="Page 1" aspect="2 / 3" typicalSec={20} live={false} />);
    expect(container.querySelector('.ds-live-dot')).toBeNull();
    rerender(<RenderThumb render={{ status: 'rendering', history: [], updatedAt: T0 }} label="Page 1" aspect="2 / 3" typicalSec={20} now={T0 + 3000} live />);
    expect(container.querySelector('.ds-live-dot')).not.toBeNull();
  });
});

describe('cards load small files only (perf F2)', () => {
  const dprSigner = (asset?: AssetRef | string | null, opts?: { width?: number }) => {
    if (!asset) return undefined;
    if (typeof asset === 'string') return `https://cdn.test/${asset}`;
    return `https://cdn.test/${opts?.width ? variantFor(asset, opts.width, window.devicePixelRatio || 1).path : asset.path}`;
  };
  afterEach(() => {
    Object.defineProperty(window, 'devicePixelRatio', { value: 1, configurable: true });
  });

  it.each([1, 2, 3])('every style board in the style card is a lazy 480w variant at DPR %i, never an original', (dpr) => {
    Object.defineProperty(window, 'devicePixelRatio', { value: dpr, configurable: true });
    const base = makeSampleDoc();
    const options = ['Ink', 'Pastel', 'Retro'].map((name, i) => ({
      id: `opt_${i}`,
      name,
      spec: `${name} look`,
      render: { status: 'ready' as const, history: [], asset: stored(`style-${i}`, 1536, 1920), updatedAt: T0 }
    }));
    const doc: ComicDoc = { ...base, style: { ...base.style, status: 'drafted', options } };
    const { container } = render(<CardRenderer card={{ type: 'style_choice', id: 'sc' }} studio={makeFakeStudio({ doc, urlFor: dprSigner })} />);
    const imgs = [...container.querySelectorAll('img')];
    expect(imgs).toHaveLength(3);
    for (const img of imgs) {
      expect(img.getAttribute('src')).toMatch(/_w480\.webp$/);
      expect(img.getAttribute('srcset')).toMatch(/_w480\.webp 480w$/);
      expect(img).toHaveAttribute('loading', 'lazy');
      expect(img).toHaveAttribute('decoding', 'async');
      expect(img).not.toHaveAttribute('data-heavy-img');
    }
  });

  it('a renders tile whose small file the studio can’t sign reads "Preview unavailable" (with the controller’s isUnsignable)', () => {
    const base = makeSampleDoc();
    const doc = { ...base, pages: base.pages.map((p, i) => (i === 0 ? { ...p, render: { status: 'ready' as const, history: [], asset: stored('broken'), updatedAt: T0 } } : p)) };
    const card = { type: 'renders' as const, id: 'r1', label: 'Pages', targets: [{ kind: 'page' as const, id: doc.pages[0].id }] };
    // useStudio's fallback: a variant it gave up on hands back the original for the width request, and nothing for the variant.
    const urlFor = (asset?: AssetRef | string | null) => (asset && typeof asset === 'object' ? `https://cdn.test/${asset.path}` : undefined);
    const studio = { ...makeFakeStudio({ doc, urlFor }), isUnsignable: (p: string) => p === 'u/x/p/broken_w480.webp' } as ComicStudioController;
    const { container } = render(<CardRenderer card={card} studio={studio} />);
    expect(screen.getByRole('img', { name: `Page ${doc.pages[0].n}: preview unavailable here` })).toBeInTheDocument();
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('.studio-shimmer')).toBeNull();
    // Still opens on the board, where the picture lives.
    fireEvent.click(screen.getByRole('button', { name: `Open Page ${doc.pages[0].n}` }));
    expect(studio.openPage).toHaveBeenCalledWith(doc.pages[0].id);
  });
});
