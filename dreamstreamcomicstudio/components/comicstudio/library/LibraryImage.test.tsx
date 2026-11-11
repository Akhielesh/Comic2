// LibraryImage reveal (Program 3 MO-1; styles.md §7.3 M1 + M12): the procedural fallback holds the box until
// the library picture has loaded AND decoded; the picture then fades in over it (a 2 % settle on fine pointers
// only; nothing under reduced motion; nothing for a picture already in memory), and once it is in, the
// fallback (and its SVG filters) is gone from the DOM. Props are unchanged (A3's OptionsCard and the other
// consumers pass the same five).
import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LibraryIndex } from '../../../shared/comic/library';
import { LibraryImage, type LibraryImageProps } from './LibraryImage';
import { __resetComicLibraryForTests } from './useComicLibrary';

const ASSET: LibraryIndex['assets'][number] = {
  id: 'style.noir-ink',
  kind: 'style_preview',
  presetId: 'noir-ink',
  theme: 'any',
  aspect: '4:5',
  w: 800,
  h: 1000,
  url: 'https://cdn.test/library/v1/style.noir-ink/1.webp',
  thumbs: { 320: 'https://cdn.test/library/v1/style.noir-ink/1@320.webp', 640: 'https://cdn.test/library/v1/style.noir-ink/1@640.webp' },
  alt: 'Noir ink sample',
  tags: [],
  palette: ['#111111'],
  rev: 1
};
const INDEX: LibraryIndex = { manifestVersion: 1, generatedAt: 1, assets: [ASSET] };

interface Played {
  el: Element;
  keyframes: Keyframe[];
  timing: KeyframeAnimationOptions;
  finish: () => void;
}

let played: Played[] = [];
let decodeGate: { promise: Promise<void>; resolve: () => void } | null = null;
const realAnimate = (Element.prototype as unknown as { animate?: unknown }).animate;
const realDecode = (HTMLImageElement.prototype as unknown as { decode?: unknown }).decode;
const realMatchMedia = window.matchMedia;

const installAnimate = () => {
  (Element.prototype as unknown as { animate?: unknown }).animate = function (this: Element, keyframes: Keyframe[], timing: KeyframeAnimationOptions) {
    let finish!: () => void;
    const finished = new Promise<void>((r) => (finish = r));
    played.push({ el: this, keyframes, timing, finish });
    return { finished, cancel: () => {} } as unknown as Animation;
  };
};
const installDecode = () => {
  (HTMLImageElement.prototype as unknown as { decode?: unknown }).decode = vi.fn(() => {
    let resolve!: () => void;
    const promise = new Promise<void>((r) => (resolve = r));
    decodeGate = { promise, resolve };
    return promise;
  });
};
const setMedia = ({ reduce = false, coarse = false }: { reduce?: boolean; coarse?: boolean }) => {
  (window as unknown as { matchMedia: unknown }).matchMedia = (query: string) => ({
    matches: (reduce && query.includes('prefers-reduced-motion')) || (coarse && query === '(pointer: coarse)'),
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => true
  });
};

beforeEach(() => {
  __resetComicLibraryForTests();
  played = [];
  decodeGate = null;
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify(INDEX), { status: 200, headers: { 'content-type': 'application/json' } }))
  );
});
afterEach(() => {
  if (realAnimate === undefined) delete (Element.prototype as unknown as { animate?: unknown }).animate;
  else (Element.prototype as unknown as { animate?: unknown }).animate = realAnimate;
  if (realDecode === undefined) delete (HTMLImageElement.prototype as unknown as { decode?: unknown }).decode;
  else (HTMLImageElement.prototype as unknown as { decode?: unknown }).decode = realDecode;
  window.matchMedia = realMatchMedia;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  __resetComicLibraryForTests();
});

const fallback = <span data-testid="procedural">procedural</span>;
const renderImage = () => render(<LibraryImage id="style.noir-ink" sizes="120px" fallback={fallback} className="rounded-lg" />);
const decodeNow = async () => {
  await act(async () => {
    decodeGate!.resolve();
    await decodeGate!.promise;
  });
};
const finishAll = async () => {
  await act(async () => {
    for (const a of played) a.finish();
    await Promise.resolve();
    await Promise.resolve();
  });
};

describe('LibraryImage: decode-gated reveal', () => {
  it('the fallback is gone from the DOM once the picture has loaded (no Web Animations: at once)', async () => {
    renderImage();
    const img = await screen.findByRole('img');
    expect(screen.getByTestId('procedural')).toBeInTheDocument();
    act(() => {
      fireEvent.load(img);
    });
    expect(img.className).toContain('opacity-100');
    expect(screen.queryByTestId('procedural')).toBeNull();
    expect(screen.queryByText('procedural')).toBeNull();
  });

  it('holds the fallback through the decode, fades in only after it, and drops the fallback when the fade ends', async () => {
    installAnimate();
    installDecode();
    renderImage();
    const img = await screen.findByRole('img');
    act(() => {
      fireEvent.load(img);
    });
    expect(img.className).toContain('opacity-0');
    expect(img.closest('[data-reveal]')).toHaveAttribute('data-reveal', 'decoding');
    expect(screen.getByTestId('procedural')).toBeInTheDocument();
    expect(played).toEqual([]);

    await decodeNow();
    expect(img.className).toContain('opacity-100');
    expect(played).toHaveLength(1);
    expect(played[0].el).toBe(img);
    expect(played[0].keyframes).toEqual([
      { opacity: 0, transform: 'scale(1.02)' },
      { opacity: 1, transform: 'none' }
    ]);
    expect(played[0].timing).toMatchObject({ duration: 280, fill: 'backwards' });
    // A cross-fade: the fallback stays under the picture until the fade has finished.
    expect(screen.getByTestId('procedural')).toBeInTheDocument();
    await finishAll();
    expect(screen.queryByTestId('procedural')).toBeNull();
  });

  it('a coarse pointer fades only (no scale)', async () => {
    installAnimate();
    installDecode();
    setMedia({ coarse: true });
    renderImage();
    const img = await screen.findByRole('img');
    act(() => {
      fireEvent.load(img);
    });
    await decodeNow();
    expect(played[0].keyframes).toEqual([
      { opacity: 0, transform: 'none' },
      { opacity: 1, transform: 'none' }
    ]);
  });

  it('reduced motion: no animation; the picture swaps in after its decode and the fallback goes at once', async () => {
    installAnimate();
    installDecode();
    setMedia({ reduce: true });
    renderImage();
    const img = await screen.findByRole('img');
    act(() => {
      fireEvent.load(img);
    });
    expect(img.className).toContain('opacity-0');
    await decodeNow();
    expect(played).toEqual([]);
    expect(img.className).toContain('opacity-100');
    expect(screen.queryByTestId('procedural')).toBeNull();
  });

  it('a picture already in memory shows in the same frame, with no entrance replayed', async () => {
    installAnimate();
    installDecode();
    vi.spyOn(HTMLImageElement.prototype, 'complete', 'get').mockReturnValue(true);
    vi.spyOn(HTMLImageElement.prototype, 'naturalWidth', 'get').mockReturnValue(640);
    renderImage();
    const img = await screen.findByRole('img');
    expect(img.className).toContain('opacity-100');
    expect(played).toEqual([]);
    expect(screen.queryByTestId('procedural')).toBeNull();
  });

  it('an error drops back to the fallback alone', async () => {
    renderImage();
    const img = await screen.findByRole('img');
    act(() => {
      fireEvent.error(img);
    });
    expect(screen.queryByRole('img')).toBeNull();
    expect(screen.getByTestId('procedural')).toBeInTheDocument();
  });

  it('keeps its five props', () => {
    const props: Required<LibraryImageProps> = { id: 'style.noir-ink', sizes: '1px', fallback: null, className: '', alt: '' };
    expect(Object.keys(props).sort()).toEqual(['alt', 'className', 'fallback', 'id', 'sizes']);
  });
});
