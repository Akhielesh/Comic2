import React from 'react';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ComicDoc } from '../../../shared/comic/doc';
import { fakeUrlFor, makeSampleDoc } from '../board/__fixtures__/sampleDoc';
import { resetIosFullscreenNoteForTests } from '../../../services/fullscreen';
import { pageImageCache } from '../immersive/pageImageCache';
import { historyLayers, layerKey, resetBackStack } from '../mobile/backStack';
import { ComicReaderView } from './ComicReaderView';

// The v4 reader on phones (mobile-reading hotfix, F1/F4/F5): Full screen did nothing on iPhone (no API, a silently
// swallowed TypeError), buttons were 32 px, and turning a page preloaded several full-size pages in parallel with the
// one on screen. Full screen now uses services/fullscreen.ts with a full-viewport fallback, buttons are 44 px on
// coarse pointers, and only the next page preloads, after the current one has loaded.
// v5: the viewport mode's history entry is a 'fullscreen' layer on the Back stack (mobile/backStack.ts), and pages
// load through the shared page-image cache (fetch → decode), so preloading is observed as fetches.

const drawnDoc = (mutate?: (d: ComicDoc) => void) =>
  makeSampleDoc((d) => {
    d.cover.render = { status: 'ready', history: [], asset: { path: 'u/cover.png', source: 'generated', at: 0, w: 1000, h: 1500 } };
    d.pages.forEach((p, i) => {
      if (!p.render.asset) p.render = { ...p.render, status: 'ready', asset: { path: `u/p${i + 1}.png`, source: 'generated', at: 0 } };
    });
    mutate?.(d);
  });

const IPHONE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/156.0 Mobile/15E148 Safari/604.1';
const realUA = window.navigator.userAgent;
const reader = () => screen.getByTestId('comic-reader');
const fsButton = () => screen.getByRole('button', { name: /full screen/i });
const removeFsApi = () => {
  delete (HTMLElement.prototype as unknown as Record<string, unknown>).requestFullscreen;
  delete (document as unknown as Record<string, unknown>).fullscreenElement;
};

beforeEach(() => {
  window.localStorage.clear();
  resetIosFullscreenNoteForTests();
  removeFsApi();
  // v5 pages load through the shared page-image cache (fetch → object URL → decode): give it the same instant fakes
  // ComicReaderView.test.tsx uses, so no download is left hanging (the cache runs at most 3 at once).
  vi.stubGlobal('fetch', vi.fn(async () => new Response(new Blob(['img'], { type: 'image/png' }), { status: 200 })));
  let n = 0;
  (URL as unknown as { createObjectURL: (b: Blob) => string }).createObjectURL = () => `blob:test/${(n += 1)}`;
  (URL as unknown as { revokeObjectURL: (u: string) => void }).revokeObjectURL = () => undefined;
  (HTMLImageElement.prototype as unknown as { decode: () => Promise<void> }).decode = () => Promise.resolve();
});
afterEach(() => {
  vi.unstubAllGlobals();
  pageImageCache.clear();
  resetBackStack();
  Object.defineProperty(window.navigator, 'userAgent', { value: realUA, configurable: true });
  removeFsApi();
  document.documentElement.style.overflow = '';
  document.body.style.overflow = '';
});

describe('Full screen always does something', () => {
  it('no API (iPhone): the reader fills the viewport, locks the page, says "Exit full screen"; Exit and Esc leave', () => {
    render(<ComicReaderView doc={drawnDoc()} urlFor={fakeUrlFor} initialMode="page" />);
    expect(reader()).toHaveAttribute('data-fullscreen', 'off');
    expect(() => fireEvent.click(fsButton())).not.toThrow();
    expect(reader()).toHaveAttribute('data-fullscreen', 'viewport');
    expect(reader().style.position).toBe('fixed');
    expect(reader().style.height).toBe('100dvh');
    expect(document.documentElement.style.overflow).toBe('hidden');
    expect(fsButton()).toHaveAccessibleName('Exit full screen');
    fireEvent.click(fsButton());
    expect(reader()).toHaveAttribute('data-fullscreen', 'off');
    expect(reader().style.position).toBe('');
    expect(document.documentElement.style.overflow).toBe('');
    fireEvent.click(fsButton());
    fireEvent.keyDown(reader(), { key: 'Escape' });
    expect(reader()).toHaveAttribute('data-fullscreen', 'off');
  });

  it('iPhone: a one-time note, exact copy, then never again', () => {
    Object.defineProperty(window.navigator, 'userAgent', { value: IPHONE_UA, configurable: true });
    const { unmount } = render(<ComicReaderView doc={drawnDoc()} urlFor={fakeUrlFor} initialMode="page" />);
    fireEvent.click(fsButton());
    const note = screen.getByRole('status', { name: 'Full screen on iPhone' });
    expect(note).toHaveTextContent('iPhone browsers keep their toolbars. Share → Add to Home Screen opens comics edge-to-edge.');
    fireEvent.click(within(note).getByRole('button', { name: 'Got it' }));
    expect(screen.queryByText(/keep their toolbars/)).toBeNull();
    unmount();
    render(<ComicReaderView doc={drawnDoc()} urlFor={fakeUrlFor} initialMode="page" />);
    fireEvent.click(fsButton());
    expect(screen.queryByText(/keep their toolbars/)).toBeNull();
  });

  it('a refused request falls back to the viewport mode, never a false "Exit" while pending, no unhandled rejection', async () => {
    let reject!: (e: Error) => void;
    const req = vi.fn(() => new Promise<void>((_, rej) => (reject = rej)));
    (HTMLElement.prototype as unknown as Record<string, unknown>).requestFullscreen = req;
    render(<ComicReaderView doc={drawnDoc()} urlFor={fakeUrlFor} initialMode="page" />);
    fireEvent.click(fsButton());
    expect(req).toHaveBeenCalledWith({ navigationUI: 'hide' });
    expect(fsButton()).toHaveAccessibleName('Full screen');
    await act(async () => {
      reject(new TypeError('Permissions check failed'));
      await Promise.resolve();
    });
    expect(reader()).toHaveAttribute('data-fullscreen', 'viewport');
    expect(fsButton()).toHaveAccessibleName('Exit full screen');
  });

  it('native: the label follows fullscreenchange only', () => {
    (HTMLElement.prototype as unknown as Record<string, unknown>).requestFullscreen = vi.fn(() => Promise.resolve());
    render(<ComicReaderView doc={drawnDoc()} urlFor={fakeUrlFor} initialMode="page" />);
    fireEvent.click(fsButton());
    expect(fsButton()).toHaveAccessibleName('Full screen');
    act(() => {
      Object.defineProperty(document, 'fullscreenElement', { value: reader(), configurable: true });
      document.dispatchEvent(new Event('fullscreenchange'));
    });
    expect(reader()).toHaveAttribute('data-fullscreen', 'native');
    expect(fsButton()).toHaveAccessibleName('Exit full screen');
    act(() => {
      Object.defineProperty(document, 'fullscreenElement', { value: null, configurable: true });
      document.dispatchEvent(new Event('fullscreenchange'));
    });
    expect(fsButton()).toHaveAccessibleName('Full screen');
  });
});

// Back leaves the viewport mode before it closes the comic: the mode is a 'fullscreen' layer on the Back stack, above
// the reader's own layer where there is one (ComicReader's v4 delegate), as the classic reading mode is. The
// end-to-end Back behaviour inside the public reader is in components/ComicReader.back.test.tsx.
describe('the viewport mode has a history entry of its own (a Back-stack layer)', () => {
  const fullscreenLayers = () => historyLayers().filter((l) => layerKey(l) === 'fullscreen');
  let opening: Record<string, unknown> = {};
  let entryNo = 0;
  beforeEach(() => {
    opening = { __viewportEntry: ++entryNo };
    window.history.pushState(opening, '', window.location.href);
  });
  /** Let every traversal under way land. */
  const settle = async () => {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 30));
    });
  };
  const back = async () => {
    await act(async () => {
      window.history.back();
      await new Promise((r) => setTimeout(r, 30));
    });
  };

  it('entering pushes once; Back (the entry popped) leaves the mode and pops nothing more', async () => {
    const before = window.history.length;
    render(<ComicReaderView doc={drawnDoc()} urlFor={fakeUrlFor} initialMode="page" />);
    fireEvent.click(fsButton());
    expect(reader()).toHaveAttribute('data-fullscreen', 'viewport');
    expect(window.history.length).toBe(before + 1);
    expect(fullscreenLayers()).toHaveLength(1);
    await back();
    expect(reader()).toHaveAttribute('data-fullscreen', 'off');
    expect(reader().style.position).toBe('');
    expect(document.documentElement.style.overflow).toBe('');
    await settle();
    // Back took exactly its entry: still on the entry the mode was entered from, nothing further popped.
    expect(window.history.state).toEqual(opening);
    expect(window.history.length).toBe(before + 1);
  });

  it('leaving with Exit or Esc pops the entry', async () => {
    const before = window.history.length;
    render(<ComicReaderView doc={drawnDoc()} urlFor={fakeUrlFor} initialMode="page" />);
    fireEvent.click(fsButton());
    expect(fullscreenLayers()).toHaveLength(1);
    fireEvent.click(fsButton());
    expect(reader()).toHaveAttribute('data-fullscreen', 'off');
    await settle();
    expect(fullscreenLayers()).toHaveLength(0);
    expect(window.history.state).toEqual(opening);
    fireEvent.click(fsButton());
    expect(fullscreenLayers()).toHaveLength(1);
    fireEvent.keyDown(reader(), { key: 'Escape' });
    expect(reader()).toHaveAttribute('data-fullscreen', 'off');
    await settle();
    expect(fullscreenLayers()).toHaveLength(0);
    expect(window.history.state).toEqual(opening);
    // Two entries were pushed and both popped: the next Back is the page's own, not a dead one.
    expect(window.history.length).toBe(before + 1);
  });

  it('native full screen gets no entry (the browser leaves it on Back itself)', () => {
    (HTMLElement.prototype as unknown as Record<string, unknown>).requestFullscreen = vi.fn(() => Promise.resolve());
    const before = window.history.length;
    render(<ComicReaderView doc={drawnDoc()} urlFor={fakeUrlFor} initialMode="page" />);
    fireEvent.click(fsButton());
    act(() => {
      Object.defineProperty(document, 'fullscreenElement', { value: reader(), configurable: true });
      document.dispatchEvent(new Event('fullscreenchange'));
    });
    expect(reader()).toHaveAttribute('data-fullscreen', 'native');
    expect(fullscreenLayers()).toHaveLength(0);
    expect(window.history.length).toBe(before);
    act(() => {
      Object.defineProperty(document, 'fullscreenElement', { value: null, configurable: true });
      document.dispatchEvent(new Event('fullscreenchange'));
    });
  });

  it('unmounted in the viewport mode: its entry goes too; unmounted outside it: nothing', async () => {
    const a = render(<ComicReaderView doc={drawnDoc()} urlFor={fakeUrlFor} initialMode="page" />);
    fireEvent.click(fsButton());
    expect(fullscreenLayers()).toHaveLength(1);
    a.unmount();
    await settle();
    expect(fullscreenLayers()).toHaveLength(0);
    expect(window.history.state).toEqual(opening);
    const lengthBefore = window.history.length;
    const b = render(<ComicReaderView doc={drawnDoc()} urlFor={fakeUrlFor} initialMode="page" />);
    b.unmount();
    await settle();
    expect(window.history.state).toEqual(opening);
    expect(window.history.length).toBe(lengthBefore);
  });

  it('the studio Read tab (no reader layer under it) keeps working, and Back leaves its viewport mode too', async () => {
    render(<ComicReaderView doc={drawnDoc()} urlFor={fakeUrlFor} initialMode="page" />);
    fireEvent.click(fsButton());
    expect(reader()).toHaveAttribute('data-fullscreen', 'viewport');
    fireEvent.click(fsButton());
    expect(reader()).toHaveAttribute('data-fullscreen', 'off');
    await settle();
    fireEvent.click(fsButton());
    expect(reader()).toHaveAttribute('data-fullscreen', 'viewport');
    await back();
    expect(reader()).toHaveAttribute('data-fullscreen', 'off');
  });
});

describe('44 px targets on coarse pointers', () => {
  it('toolbar buttons and the reading-mode switch grow to 44 px on touch (desktop sizes unchanged)', () => {
    render(<ComicReaderView doc={drawnDoc()} urlFor={fakeUrlFor} initialMode="page" />);
    for (const name of ['Previous page', 'Next page', 'Full screen']) {
      const b = screen.getAllByRole('button', { name }).find((x) => !x.hasAttribute('data-zone'))!;
      expect(b.className).toMatch(/\bh-8 w-8\b/);
      expect(b.className).toMatch(/\bcoarse:h-11\b/);
      expect(b.className).toMatch(/\bcoarse:w-11\b/);
    }
    // v5: every segment of the switch carries its own 44 px touch size (board/ui Segmented).
    const segments = within(screen.getByRole('radiogroup', { name: 'Reading mode' })).getAllByRole('radio');
    expect(segments.length).toBeGreaterThan(1);
    for (const seg of segments) expect(seg.className).toMatch(/coarse:min-h-\[44px\]/);
  });
});

describe('preload: only the next page, after the current one', () => {
  // v5 pages load through the shared page-image cache: each download is a fetch (then a decode). Downloads here stay
  // pending until a test lets them land.
  const fetched: Array<{ url: string; land: (ok?: boolean) => void }> = [];
  /** Every download not yet landed (a test may reset `fetched` to watch what comes next). */
  const pending = new Set<(ok?: boolean) => void>();
  beforeEach(() => {
    // The cache is shared: pages earlier tests showed must not count as already loaded here.
    pageImageCache.clear();
    fetched.length = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (url: string) =>
          new Promise<Response>((resolve) => {
            const land = (ok = true) => {
              pending.delete(land);
              resolve(ok ? new Response(new Blob(['img'], { type: 'image/png' }), { status: 200 }) : new Response('', { status: 500 }));
            };
            pending.add(land);
            fetched.push({ url, land });
          })
      )
    );
  });
  // Downloads a test left pending land now, so none holds one of the cache's 3 download slots into the next test.
  afterEach(async () => {
    await act(async () => {
      [...pending].forEach((land) => land());
      fetched.length = 0;
      await new Promise((r) => setTimeout(r, 0));
    });
  });
  const land = async (match: RegExp, ok = true) => {
    await act(async () => {
      fetched.filter((f) => match.test(f.url)).forEach((f) => f.land(ok));
      await new Promise((r) => setTimeout(r, 0));
    });
  };

  it('waits for the page on screen, then fetches just the next one (never two ahead, never behind)', async () => {
    render(<ComicReaderView doc={drawnDoc()} urlFor={fakeUrlFor} initialMode="page" />);
    fireEvent.keyDown(reader(), { key: 'ArrowRight' }); // page 1
    fetched.length = 0;
    fireEvent.keyDown(reader(), { key: 'ArrowRight' }); // page 2
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    const now = fetched.map((f) => f.url);
    expect(now.length).toBeGreaterThan(0);
    // Only the current page is touched until it has loaded.
    expect(now.every((url) => url.endsWith('/u/p2.png'))).toBe(true);
    await land(/\/u\/p2\.png$/);
    const after = fetched.map((f) => f.url);
    expect(after.filter((url) => url.endsWith('/u/p3.png'))).toHaveLength(1);
    expect(after.some((url) => /\/p4\.png$|\/p1\.png$|cover/.test(url))).toBe(false);
  });

  it('a failed current page still lets the next one load; scroll mode preloads nothing', async () => {
    const { unmount } = render(<ComicReaderView doc={drawnDoc()} urlFor={fakeUrlFor} initialMode="page" />);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(fetched.map((f) => f.url).some((url) => /\/p1\.png$/.test(url))).toBe(false);
    await land(/cover/, false);
    expect(fetched.map((f) => f.url).some((url) => /\/p1\.png$/.test(url))).toBe(true);
    unmount();
    pageImageCache.clear();
    fetched.length = 0;
    render(<ComicReaderView doc={drawnDoc()} urlFor={fakeUrlFor} initialMode="scroll" />);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(fetched).toHaveLength(0);
  });
});
