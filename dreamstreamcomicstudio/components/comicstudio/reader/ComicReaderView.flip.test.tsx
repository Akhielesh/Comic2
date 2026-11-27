// The inline reader's page turns (fx-reader): a comic that never chose a style flips — the new page swings in from
// the spine — while a creator's or a reader's own pick wins; reduced motion lands at once; Home and End swing too;
// a webtoon's next page opens at its top; the toolbar keeps its arrows pinned; the page's "of N" is the book's count.
import React from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ComicDoc } from '../../../shared/comic/doc';
import { fakeUrlFor, makeSampleDoc } from '../board/__fixtures__/sampleDoc';
import { pageImageCache } from '../immersive/pageImageCache';
import { ComicReaderView } from './ComicReaderView';

const sound = vi.hoisted(() => ({ playPageTurn: vi.fn(), primePaperSound: vi.fn() }));
vi.mock('../immersive/paperSound', () => sound);

const FLIP_NEXT = 'animate-page-flip-next';
const FLIP_PREV = 'animate-page-flip-prev';

const drawnDoc = (mutate?: (d: ComicDoc) => void) =>
  makeSampleDoc((d) => {
    d.cover.render = { status: 'ready', history: [], asset: { path: 'u/cover.png', source: 'generated', at: 0, w: 1000, h: 1500 } };
    d.pages.forEach((p, i) => {
      if (!p.render.asset) p.render = { ...p.render, status: 'ready', asset: { path: `u/p${i + 1}.png`, source: 'generated', at: 0 } };
    });
    mutate?.(d);
  });
const prefs = (p: Record<string, unknown>) => window.localStorage.setItem('comicstudio.reader.prefs.v1', JSON.stringify(p));

const shownKeys = () => screen.queryAllByTestId('reader-page').map((el) => el.getAttribute('data-key'));
const reader = () => screen.getByTestId('comic-reader');
const press = (key: string) => fireEvent.keyDown(reader(), { key });
const surface = () => document.querySelector<HTMLElement>('[data-paper-turn-surface]')!;
const face = () => surface().querySelector<HTMLElement>('.paper-turn-face')!;
const flipping = () => !!document.querySelector(`.${FLIP_NEXT}, .${FLIP_PREV}`);

const box = (width: number, height: number) => ({ x: 0, y: 0, left: 0, top: 0, width, height, right: width, bottom: height, toJSON: () => ({}) }) as DOMRect;

beforeEach(() => {
  window.localStorage.clear();
  sound.playPageTurn.mockReset();
  Object.defineProperty(window, 'innerWidth', { value: 1280, configurable: true });
  Object.defineProperty(window, 'innerHeight', { value: 800, configurable: true });
  vi.stubGlobal('fetch', vi.fn(async () => new Response(new Blob(['img'], { type: 'image/png' }), { status: 200 })));
  let n = 0;
  (URL as unknown as { createObjectURL: (b: Blob) => string }).createObjectURL = () => `blob:test/${(n += 1)}`;
  (URL as unknown as { revokeObjectURL: (u: string) => void }).revokeObjectURL = () => undefined;
  (HTMLImageElement.prototype as unknown as { decode: () => Promise<void> }).decode = () => Promise.resolve();
  // jsdom lays nothing out: the turn stage and the toolbar get boxes, and a picture with a source counts as loaded.
  const rect = HTMLElement.prototype.getBoundingClientRect;
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    if (this.hasAttribute('data-paper-turn-surface')) return box(400, 600);
    if (this.dataset.testid === 'reader-toolbar') return box(1280, 52);
    return rect.call(this);
  });
  vi.spyOn(HTMLImageElement.prototype, 'complete', 'get').mockImplementation(function (this: HTMLImageElement) {
    return !!this.getAttribute('src');
  });
  window.history.replaceState(null, '', '/c/AbCdEfGhIjKlMnOpQ');
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  window.localStorage.clear();
  pageImageCache.clear();
});

describe('the inline reader turns with the page flip by default', () => {
  it('a comic that never chose (its stored "paper" is the old default) flips: the next page swings in, then lands', async () => {
    render(<ComicReaderView doc={drawnDoc()} urlFor={fakeUrlFor} initialMode="page" />);
    expect(surface()).toHaveAttribute('data-turn-style', 'flip');
    press('ArrowRight');
    await waitFor(() => expect(shownKeys()).toEqual(['pg_1']));
    expect(face().classList.contains(FLIP_NEXT)).toBe(true);
    // The swing never folds: no paper back, no clip.
    expect(surface().querySelector('.paper-turn-back')).toBeNull();
    expect(face().style.clipPath).toBe('');
    await waitFor(() => expect(flipping()).toBe(false), { timeout: 2000 });
    press('ArrowLeft');
    await waitFor(() => expect(shownKeys()).toEqual(['cover']));
    expect(face().classList.contains(FLIP_PREV)).toBe(true);
  });

  it('Home and End swing the first or last page in; the toolbar arrows and a swipe flip too', async () => {
    render(<ComicReaderView doc={drawnDoc()} urlFor={fakeUrlFor} initialMode="page" />);
    press('End');
    await waitFor(() => expect(shownKeys()).toEqual(['pg_6']));
    expect(face().classList.contains(FLIP_NEXT)).toBe(true);
    press('Home');
    await waitFor(() => expect(shownKeys()).toEqual(['cover']));
    expect(face().classList.contains(FLIP_PREV)).toBe(true);
    fireEvent.click(within(screen.getByTestId('reader-page-nav')).getByRole('button', { name: 'Next page' }));
    await waitFor(() => expect(shownKeys()).toEqual(['pg_1']));
    const s = surface();
    fireEvent.touchStart(s, { touches: [{ identifier: 0, clientX: 360, clientY: 300 }] });
    fireEvent.touchMove(s, { touches: [{ identifier: 0, clientX: 200, clientY: 304 }] });
    fireEvent.touchEnd(s, { touches: [], changedTouches: [{ identifier: 0, clientX: 200, clientY: 304 }] });
    await waitFor(() => expect(shownKeys()).toEqual(['pg_2']));
    expect(face().classList.contains(FLIP_NEXT)).toBe(true);
  });

  it('right to left: ← is next and the swing is mirrored', async () => {
    render(<ComicReaderView doc={drawnDoc((d) => (d.format.readingDirection = 'rtl'))} urlFor={fakeUrlFor} initialMode="page" />);
    press('ArrowLeft');
    await waitFor(() => expect(shownKeys()).toEqual(['pg_1']));
    expect(face().classList.contains(FLIP_PREV)).toBe(true);
  });

  it('a spread swings as a pair around its spine', async () => {
    render(<ComicReaderView doc={drawnDoc()} urlFor={fakeUrlFor} />);
    expect(screen.getByTestId('comic-reader')).toHaveAttribute('data-layout', 'spread');
    press('ArrowRight');
    await waitFor(() => expect(face().classList.contains(FLIP_NEXT)).toBe(true));
    expect(face().style.transformOrigin).toMatch(/^\d+(\.\d+)?px 50%$/);
  });

  it('the creator’s choice wins over the default, and the reader’s own choice over both', () => {
    const { unmount } = render(<ComicReaderView doc={drawnDoc((d) => (d.reader = { ...d.reader, turn: 'paper', turnChosen: true }))} urlFor={fakeUrlFor} initialMode="page" />);
    expect(surface()).toHaveAttribute('data-turn-style', 'paper');
    unmount();
    const fade = render(<ComicReaderView doc={drawnDoc((d) => (d.reader = { ...d.reader, turn: 'fade' }))} urlFor={fakeUrlFor} initialMode="page" />);
    expect(surface()).toHaveAttribute('data-turn-style', 'fade');
    fade.unmount();
    prefs({ turn: 'flip' });
    render(<ComicReaderView doc={drawnDoc((d) => (d.reader = { ...d.reader, turn: 'slide' }))} urlFor={fakeUrlFor} initialMode="page" />);
    expect(surface()).toHaveAttribute('data-turn-style', 'flip');
  });

  it('the reader’s own Reduce motion lands every turn at once (no flip, no fold)', () => {
    prefs({ reduceMotion: true });
    render(<ComicReaderView doc={drawnDoc()} urlFor={fakeUrlFor} initialMode="page" />);
    press('ArrowRight');
    expect(shownKeys()).toEqual(['pg_1']);
    press('End');
    expect(shownKeys()).toEqual(['pg_6']);
    expect(flipping()).toBe(false);
    expect(surface()).not.toHaveAttribute('data-turning');
  });

  it('plays the reader’s page-turn sound on a turn only when they turned it on', async () => {
    const { unmount } = render(<ComicReaderView doc={drawnDoc()} urlFor={fakeUrlFor} initialMode="page" />);
    press('ArrowRight');
    await waitFor(() => expect(shownKeys()).toEqual(['pg_1']));
    expect(sound.playPageTurn).not.toHaveBeenCalled();
    unmount();
    prefs({ sound: true });
    render(<ComicReaderView doc={drawnDoc()} urlFor={fakeUrlFor} initialMode="page" />);
    press('ArrowRight');
    await waitFor(() => expect(shownKeys()).toEqual(['pg_1']));
    expect(sound.playPageTurn).toHaveBeenCalledTimes(1);
    // Home and End are turns too: they sound like one.
    press('End');
    await waitFor(() => expect(shownKeys()).toEqual(['pg_6']));
    expect(sound.playPageTurn).toHaveBeenCalledTimes(2);
    press('Home');
    await waitFor(() => expect(shownKeys()).toEqual(['cover']));
    expect(sound.playPageTurn).toHaveBeenCalledTimes(3);
  });
});

describe('reader-turn fixes', () => {
  it('a webtoon’s next page opens at its top; going back opens the previous page at its foot', () => {
    prefs({ reduceMotion: true });
    render(<ComicReaderView doc={drawnDoc((d) => (d.format.kind = 'webtoon'))} urlFor={fakeUrlFor} />);
    const scroller = screen.getByTestId('reader-stage-box');
    expect(scroller.className).toMatch(/overflow-y-auto/);
    Object.defineProperty(scroller, 'scrollHeight', { value: 2400, configurable: true });
    press('ArrowRight');
    scroller.scrollTop = 900; // read down the page
    press('ArrowRight');
    expect(scroller.scrollTop).toBe(0);
    scroller.scrollTop = 700;
    press('ArrowLeft');
    expect(scroller.scrollTop).toBe(2400);
    // A jump (Home, End) opens its page at the top.
    press('End');
    expect(scroller.scrollTop).toBe(0);
    scroller.scrollTop = 500;
    press('Home');
    expect(scroller.scrollTop).toBe(0);
    // Home from the second view is a jump too, not one step back: the first page opens at its top, not its foot.
    press('ArrowRight');
    expect(shownKeys()).not.toEqual(['cover']);
    scroller.scrollTop = 600;
    press('Home');
    expect(shownKeys()).toEqual(['cover']);
    expect(scroller.scrollTop).toBe(0);
    // And the step after a jump is read as usual: one step back from the second view opens the first at its foot.
    press('ArrowRight');
    press('ArrowLeft');
    expect(scroller.scrollTop).toBe(2400);
  });

  it('a webtoon page taller than its window swings about the middle of what shows: its top going forward, its foot one step back', async () => {
    render(<ComicReaderView doc={drawnDoc((d) => (d.format.kind = 'webtoon'))} urlFor={fakeUrlFor} />);
    const book = () => face().closest<HTMLElement>('[data-layout]')!;
    const pageH = parseFloat(book().style.height);
    const bookTop = parseFloat(book().style.top);
    // jsdom measures no stage box: the reader lays the page out in the window less the toolbar row.
    const windowH = 800 - 48;
    expect(pageH).toBeGreaterThan(windowH);
    const originY = (prefix: 'left' | 'right') => {
      const m = face().style.transformOrigin.match(new RegExp(`^${prefix} (\\d+)px$`));
      expect(m, `origin "${face().style.transformOrigin}"`).not.toBeNull();
      return Number(m![1]);
    };
    press('ArrowRight');
    await waitFor(() => expect(face().classList.contains(FLIP_NEXT)).toBe(true));
    // Forward: the page opens at its top, so the pivot is the middle of the window, not of the whole tall page.
    expect(originY('left')).toBe(Math.round(windowH / 2 - bookTop));
    press('ArrowRight');
    await waitFor(() => expect(shownKeys()).toEqual(['pg_2']));
    press('ArrowLeft');
    await waitFor(() => expect(face().classList.contains(FLIP_PREV)).toBe(true));
    // One step back: the page opens at its foot, and swings from the other spine edge about the foot's middle.
    expect(originY('right')).toBe(Math.round(pageH + 12 - windowH / 2));
  });

  it('each page is named against the book’s page count, not the drawn pages', () => {
    const doc = drawnDoc((d) => {
      d.pages.forEach((p, i) => {
        if (i !== 1 && i !== 4) p.render = { status: 'none', history: [] };
      });
    });
    prefs({ reduceMotion: true });
    render(<ComicReaderView doc={doc} urlFor={fakeUrlFor} initialMode="page" />);
    press('End');
    const page = screen.getAllByTestId('reader-page').find((el) => el.getAttribute('data-key') === 'pg_5')!;
    expect(page).toHaveAttribute('aria-label', expect.stringMatching(/5 .*6/));
    expect(page.getAttribute('aria-label')).not.toMatch(/ 2$/);
  });

  it('auto-hide chrome: the page stage (and the scroll column) start below the measured toolbar', () => {
    const { unmount } = render(<ComicReaderView doc={drawnDoc()} urlFor={fakeUrlFor} initialMode="page" chrome="auto-hide" />);
    expect(screen.getByTestId('reader-stage').style.paddingTop).toBe('52px');
    unmount();
    render(<ComicReaderView doc={drawnDoc()} urlFor={fakeUrlFor} initialMode="scroll" chrome="auto-hide" />);
    const column = screen.getByTestId('reader-scroll').firstElementChild as HTMLElement;
    expect(column.style.paddingTop).toBe('68px');
  });
});
