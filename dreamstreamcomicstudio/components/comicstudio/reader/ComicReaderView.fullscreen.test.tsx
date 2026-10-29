import React from 'react';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ComicDoc } from '../../../shared/comic/doc';
import { fakeUrlFor, makeSampleDoc } from '../board/__fixtures__/sampleDoc';
import { resetIosFullscreenNoteForTests } from '../../../services/fullscreen';
import { ComicReaderView } from './ComicReaderView';

// The v4 reader on phones (mobile-reading hotfix, F1/F4/F5): Full screen did nothing on iPhone (no API, a silently
// swallowed TypeError), buttons were 32 px, and turning a page preloaded several full-size pages in parallel with the
// one on screen. Full screen now uses services/fullscreen.ts with a full-viewport fallback, buttons are 44 px on
// coarse pointers, and only the next page preloads, after the current one has loaded.

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
});
afterEach(() => {
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

describe('44 px targets on coarse pointers', () => {
  it('toolbar buttons and the reading-mode switch grow to 44 px on touch (desktop sizes unchanged)', () => {
    render(<ComicReaderView doc={drawnDoc()} urlFor={fakeUrlFor} initialMode="page" />);
    for (const name of ['Previous page', 'Next page', 'Full screen']) {
      const b = screen.getAllByRole('button', { name }).find((x) => !x.hasAttribute('data-zone'))!;
      expect(b.className).toMatch(/\bh-8 w-8\b/);
      expect(b.className).toMatch(/\bcoarse:h-11\b/);
      expect(b.className).toMatch(/\bcoarse:w-11\b/);
    }
    expect(screen.getByRole('radiogroup', { name: 'Reading mode' }).className).toMatch(/coarse:\[&>button\]:min-h-\[44px\]/);
  });
});

describe('preload: only the next page, after the current one', () => {
  const created: Array<{ src: string; fire: (ok?: boolean) => void }> = [];
  const RealImage = globalThis.Image;
  beforeEach(() => {
    created.length = 0;
    const Stub = class {
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      decoding = 'auto';
      private _src = '';
      set src(v: string) {
        this._src = v;
        created.push({ src: v, fire: (ok = true) => (ok ? this.onload?.() : this.onerror?.()) });
      }
      get src() {
        return this._src;
      }
    };
    (globalThis as unknown as { Image: unknown }).Image = Stub;
    (window as unknown as { Image: unknown }).Image = Stub;
  });
  afterEach(() => {
    (globalThis as unknown as { Image: unknown }).Image = RealImage;
    (window as unknown as { Image: unknown }).Image = RealImage;
  });

  it('waits for the page on screen, then fetches just the next one (never two ahead, never behind)', () => {
    render(<ComicReaderView doc={drawnDoc()} urlFor={fakeUrlFor} initialMode="page" />);
    fireEvent.keyDown(reader(), { key: 'ArrowRight' }); // page 1
    created.length = 0;
    fireEvent.keyDown(reader(), { key: 'ArrowRight' }); // page 2
    const now = created.map((c) => c.src);
    expect(now.length).toBeGreaterThan(0);
    // Only the current page is touched until it has loaded.
    expect(now.every((src) => src.endsWith('/u/p2.png'))).toBe(true);
    act(() => created.filter((c) => c.src.endsWith('/u/p2.png')).forEach((c) => c.fire()));
    const after = created.map((c) => c.src);
    expect(after.filter((src) => src.endsWith('/u/p3.png'))).toHaveLength(1);
    expect(after.some((src) => /\/p4\.png$|\/p1\.png$|cover/.test(src))).toBe(false);
  });

  it('a failed current page still lets the next one load; scroll mode preloads nothing', () => {
    const { unmount } = render(<ComicReaderView doc={drawnDoc()} urlFor={fakeUrlFor} initialMode="page" />);
    act(() => created.forEach((c) => c.fire(false)));
    expect(created.map((c) => c.src).some((src) => /\/p1\.png$/.test(src))).toBe(true);
    unmount();
    created.length = 0;
    render(<ComicReaderView doc={drawnDoc()} urlFor={fakeUrlFor} initialMode="scroll" />);
    expect(created).toHaveLength(0);
  });
});
