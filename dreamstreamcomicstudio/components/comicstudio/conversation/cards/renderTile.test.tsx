// PF-2 (perf F2 + styles M4): chat render tiles load small variants lazily and say how long a drawing has
// taken against the model's usual time, with the model's name, on ONE shared clock that never fetches.
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, within } from '@testing-library/react';
import { createEmptyDoc, variantFor, type AssetRef, type ComicDoc, type RenderState } from '../../../../shared/comic/doc';
import { jobModel } from '../../board/boardModel';
import { CardRenderer } from './CardRenderer';
import { CastAvatar } from './castVisual';
import { RenderThumb, TILE_CLOCK_MS, describeTarget, tileProgress, tileSources } from './renderTile';
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

  it('a blocked image reads "Withheld" and mounts no <img>', () => {
    const asset = stored('bad', 1536, 2304, { safety: { assessed: 'X', at: T0 } });
    const { container } = render(<RenderThumb render={{ status: 'ready', history: [], asset }} label="Page 4" aspect="2 / 3" url={undefined} />);
    expect(screen.getByRole('img', { name: 'Page 4: image withheld' })).toHaveTextContent('Withheld');
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('.studio-shimmer')).toBeNull();
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
  it('elapsed vs the usual time, then "taking longer than usual", then a stopped clock', () => {
    expect(tileProgress('rendering', T0, T0 + 12_000, 20)).toEqual({ elapsed: '12s', hint: 'usually ~20s', bar: true, ticking: true });
    expect(tileProgress('rendering', T0, T0 + 25_000, 20)).toEqual({ elapsed: '25s', hint: 'taking longer than usual', bar: false, ticking: true });
    expect(tileProgress('rendering', T0, T0 + 201_000, 20)).toEqual({ hint: 'much longer than usual', bar: false, ticking: false });
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
    expect(tile.querySelector('[data-tile-progress]')).toHaveTextContent('25s · taking longer than usual');
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
