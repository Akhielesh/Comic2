// The inline reader shell (reader.md §11.1, contract §13.3, jsdom): one layout decision with the
// immersive reader (cover alone on its side, page 1 facing the inside cover), turns by key / swipe /
// toolbar, deep links in (`initialPage`, honest fallback for an undrawn page) and out (`?p=`), the
// language slot, the withheld tile (never an <img>), the rating badge, Report only when offered, the
// End card, auto-hiding chrome, zoom, and the immersive entry.
import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ComicDoc } from '../../../shared/comic/doc';
import { fakeUrlFor, makeSampleDoc } from '../board/__fixtures__/sampleDoc';
import { pageImageCache } from '../immersive/pageImageCache';
import { FormFactorProvider, formFactorFor } from '../mobile/useFormFactor';
import { ComicReaderView } from './ComicReaderView';

const pdfMock = vi.hoisted(() => ({ exportComicPdf: vi.fn() }));
vi.mock('../export/pdfExport', () => pdfMock);

const drawnDoc = (mutate?: (d: ComicDoc) => void) =>
  makeSampleDoc((d) => {
    d.cover.render = { status: 'ready', history: [], asset: { path: 'u/cover.png', source: 'generated', at: 0, w: 1000, h: 1500 } };
    d.pages.forEach((p, i) => {
      if (!p.render.asset) p.render = { ...p.render, status: 'ready', asset: { path: `u/p${i + 1}.png`, source: 'generated', at: 0 } };
    });
    mutate?.(d);
  });

const shownKeys = () => screen.queryAllByTestId('reader-page').map((el) => el.getAttribute('data-key'));
const reader = () => screen.getByTestId('comic-reader');
const press = (key: string) => fireEvent.keyDown(reader(), { key });

beforeEach(() => {
  window.localStorage.clear();
  window.sessionStorage.clear();
  Object.defineProperty(window, 'innerWidth', { value: 1280, configurable: true });
  Object.defineProperty(window, 'innerHeight', { value: 800, configurable: true });
  vi.stubGlobal('fetch', vi.fn(async () => new Response(new Blob(['img'], { type: 'image/png' }), { status: 200 })));
  let n = 0;
  (URL as unknown as { createObjectURL: (b: Blob) => string }).createObjectURL = () => `blob:test/${(n += 1)}`;
  (URL as unknown as { revokeObjectURL: (u: string) => void }).revokeObjectURL = () => undefined;
  (HTMLImageElement.prototype as unknown as { decode: () => Promise<void> }).decode = () => Promise.resolve();
  window.history.replaceState(null, '', '/c/AbCdEfGhIjKlMnOpQ');
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  window.localStorage.clear();
  window.sessionStorage.clear();
  pageImageCache.clear();
  pdfMock.exportComicPdf.mockReset();
});

describe('ComicReaderView', () => {
  it('starts on the cover, shows it through the page cache, and turns with the arrow keys', async () => {
    render(<ComicReaderView doc={drawnDoc()} urlFor={fakeUrlFor} initialMode="page" />);
    expect(shownKeys()).toEqual(['cover']);
    // The cover is decoded through the shared cache before it shows (no white flash on turns).
    const cover = await screen.findByRole('img', { name: 'Cover of The Saffron Thief' });
    expect(cover.getAttribute('src')).toMatch(/^blob:test\//);
    expect(fetch).toHaveBeenCalledWith('https://cdn.test/u/cover.png', expect.objectContaining({ credentials: 'omit' }));
    press('ArrowRight');
    expect(shownKeys()).toEqual(['pg_1']);
    expect(screen.getByTestId('reader-counter')).toHaveTextContent('Page 1 · 2/7');
    press('ArrowRight');
    press('ArrowLeft');
    expect(shownKeys()).toEqual(['pg_1']);
  });

  it('jumps with Home/End and stops at the ends', () => {
    render(<ComicReaderView doc={drawnDoc()} urlFor={fakeUrlFor} initialMode="page" />);
    press('End');
    expect(shownKeys()).toEqual(['pg_6']);
    press('ArrowRight');
    expect(shownKeys()).toEqual(['pg_6']);
    press('Home');
    expect(shownKeys()).toEqual(['cover']);
    press('ArrowLeft');
    expect(shownKeys()).toEqual(['cover']);
  });

  it('lays a spread out like print: the cover alone on the right, page 1 facing the inside cover', () => {
    render(<ComicReaderView doc={drawnDoc()} urlFor={fakeUrlFor} initialMode="spread" />);
    expect(reader()).toHaveAttribute('data-layout', 'spread');
    expect(shownKeys()).toEqual(['cover']);
    expect(screen.getByTestId('reader-page')).toHaveAttribute('data-side', 'right');
    press('ArrowRight');
    expect(shownKeys()).toEqual(['pg_1']);
    expect(screen.getByTestId('endpaper-front')).toBeInTheDocument();
    press('ArrowRight');
    expect(shownKeys()).toEqual(['pg_2', 'pg_3']);
    expect(screen.getByTestId('reader-counter')).toHaveTextContent('Pages 2–3 · 3/5');
  });

  it('reads right to left: ← is next, the cover sits on the left and the earlier page on the right', () => {
    render(<ComicReaderView doc={drawnDoc((d) => (d.format.readingDirection = 'rtl'))} urlFor={fakeUrlFor} initialMode="spread" />);
    expect(screen.getByText('Reads right to left')).toBeInTheDocument();
    expect(screen.getByTestId('reader-page')).toHaveAttribute('data-side', 'left');
    press('ArrowLeft');
    press('ArrowLeft');
    // Screen order (left → right): page 3, page 2.
    expect(shownKeys()).toEqual(['pg_3', 'pg_2']);
    press('ArrowRight');
    expect(shownKeys()).toEqual(['pg_1']);
  });

  it('falls back to single pages where a spread cannot fit, and leaves the Spread option out', () => {
    Object.defineProperty(window, 'innerWidth', { value: 700, configurable: true });
    render(<ComicReaderView doc={drawnDoc()} urlFor={fakeUrlFor} initialMode="spread" />);
    expect(reader()).toHaveAttribute('data-layout', 'single');
    expect(screen.queryByRole('radio', { name: /Spread/ })).toBeNull();
  });

  it('keeps your place when switching modes, and remembers the choice for both readers', () => {
    render(<ComicReaderView doc={drawnDoc()} urlFor={fakeUrlFor} initialMode="spread" />);
    press('ArrowRight');
    press('ArrowRight');
    expect(shownKeys()).toEqual(['pg_2', 'pg_3']);
    fireEvent.click(screen.getByRole('radio', { name: /Page/ }));
    expect(shownKeys()).toEqual(['pg_2']);
    expect(window.localStorage.getItem('comicstudio.reader.mode')).toBe('page');
  });

  it('turns pages with swipes', () => {
    render(<ComicReaderView doc={drawnDoc()} urlFor={fakeUrlFor} initialMode="page" />);
    const stage = screen.getByTestId('reader-stage');
    fireEvent.pointerDown(stage, { clientX: 300, clientY: 100, pointerType: 'touch' });
    fireEvent.pointerUp(stage, { clientX: 150, clientY: 110, pointerType: 'touch' });
    expect(shownKeys()).toEqual(['pg_1']);
    fireEvent.pointerDown(stage, { clientX: 100, clientY: 100, pointerType: 'touch' });
    fireEvent.pointerUp(stage, { clientX: 260, clientY: 100, pointerType: 'touch' });
    expect(shownKeys()).toEqual(['cover']);
  });

  it('uses the toolbar arrows', () => {
    render(<ComicReaderView doc={drawnDoc()} urlFor={fakeUrlFor} initialMode="page" />);
    const toolbar = screen.getByTestId('reader-counter').parentElement!;
    const [prev, next] = Array.from(toolbar.querySelectorAll('button'));
    expect(prev).toBeDisabled();
    fireEvent.click(next);
    expect(shownKeys()).toEqual(['pg_1']);
  });

  it('scroll mode lays every page out vertically, lettered', () => {
    render(<ComicReaderView doc={drawnDoc()} urlFor={fakeUrlFor} initialMode="scroll" />);
    expect(shownKeys()).toEqual(['cover', 'pg_1', 'pg_2', 'pg_3', 'pg_4', 'pg_5', 'pg_6']);
    expect(screen.getByTestId('reader-scroll').querySelectorAll('[data-testid="balloon"]').length).toBeGreaterThan(0);
    expect(screen.getByText('The end.')).toBeInTheDocument();
  });

  it('webtoons always scroll (no mode switch to offer)', () => {
    render(<ComicReaderView doc={drawnDoc((d) => (d.format.kind = 'webtoon'))} urlFor={fakeUrlFor} initialMode="page" />);
    expect(reader()).toHaveAttribute('data-layout', 'scroll');
    expect(screen.queryByRole('radiogroup', { name: 'Reading mode' })).toBeNull();
  });

  it('reads only what is drawn, and says so', () => {
    render(<ComicReaderView doc={makeSampleDoc()} urlFor={fakeUrlFor} initialMode="page" />);
    expect(shownKeys()).toEqual(['pg_1']);
    expect(screen.getByText('2 of 6 pages drawn')).toBeInTheDocument();
  });

  it('has an empty state', () => {
    const doc = makeSampleDoc((d) => d.pages.forEach((p) => (p.render = { status: 'none', history: [] })));
    render(<ComicReaderView doc={doc} urlFor={fakeUrlFor} />);
    expect(screen.getByText('Nothing to read yet')).toBeInTheDocument();
  });

  it('renders extra toolbar controls', () => {
    render(<ComicReaderView doc={drawnDoc()} urlFor={fakeUrlFor} toolbarExtra={<button type="button">Export it</button>} />);
    expect(screen.getByRole('button', { name: 'Export it' })).toBeInTheDocument();
  });

  it('opens a deep link at its page, and says honestly when that page is not drawn', () => {
    const { unmount } = render(<ComicReaderView doc={drawnDoc()} urlFor={fakeUrlFor} initialMode="page" initialPage={3} />);
    expect(shownKeys()).toEqual(['pg_3']);
    unmount();
    render(<ComicReaderView doc={makeSampleDoc()} urlFor={fakeUrlFor} initialMode="page" initialPage={4} />);
    // Pages 1 and 5 are drawn: the nearest (page 5, one away) is shown, and the reader says so.
    expect(screen.getByRole('status')).toHaveTextContent('Page 4 isn’t drawn yet — showing page 5.');
    expect(shownKeys()).toEqual(['pg_5']);
  });

  it('reports the settled page and writes ?p= (keeping other params) once the reader moves — never on open', async () => {
    window.history.replaceState(null, '', '/c/AbCdEfGhIjKlMnOpQ?via=x');
    const onPageChange = vi.fn();
    render(<ComicReaderView doc={drawnDoc()} urlFor={fakeUrlFor} initialMode="page" syncUrl onPageChange={onPageChange} />);
    expect(onPageChange).toHaveBeenLastCalledWith(0);
    await new Promise((r) => setTimeout(r, 350));
    expect(window.location.search).toBe('?via=x');
    press('ArrowRight');
    press('ArrowRight');
    expect(onPageChange).toHaveBeenLastCalledWith(2);
    await waitFor(() => expect(window.location.search).toBe('?via=x&p=2'));
  });

  it('offers to continue where you left off (never jumps on its own)', () => {
    const doc = drawnDoc();
    window.localStorage.setItem(`comicstudio.reader.pos.${doc.id}`, JSON.stringify({ key: 'pg_4', at: Date.now() - 1000 }));
    render(<ComicReaderView doc={doc} urlFor={fakeUrlFor} initialMode="page" />);
    expect(shownKeys()).toEqual(['cover']);
    fireEvent.click(screen.getByRole('button', { name: 'Continue from page 4' }));
    expect(shownKeys()).toEqual(['pg_4']);
    expect(screen.queryByRole('button', { name: 'Continue from page 4' })).toBeNull();
  });

  it('shows the language picker from the slot and reads the chosen edition', () => {
    const doc = drawnDoc((d) => {
      const line = d.pages[0].panels[0].lines[0];
      d.i18n = {
        editions: { te: { lang: 'te', lines: { [line.id]: { text: 'తెలుగు వాక్యం', status: 'edited', sourceHash: 'x' } }, balloons: {}, register: 'neutral' } as never },
        glossary: []
      };
    });
    const onChange = vi.fn();
    render(
      <ComicReaderView
        doc={doc}
        urlFor={fakeUrlFor}
        initialMode="scroll"
        language={{ current: 'te', options: [{ code: 'en', label: 'English', status: 'ready' }, { code: 'te', label: 'Telugu', native: 'తెలుగు', status: 'ready' }], onChange }}
      />
    );
    expect(screen.getAllByText('తెలుగు వాక్యం').length).toBeGreaterThan(0);
    // Untranslated lines fall back to the original — and the reader says so.
    expect(screen.getByTestId('reader-fallback-chip')).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: /తెలుగు|Telugu|Language/ }).length).toBeGreaterThan(0);
  });

  it('never fetches or shows a withheld (safety-blocked) page — a neutral tile instead', async () => {
    const doc = drawnDoc((d) => {
      d.pages[0].render.asset = { path: 'u/blocked.png', source: 'generated', at: 0, safety: { assessed: 'X', at: 1 } };
    });
    render(<ComicReaderView doc={doc} urlFor={fakeUrlFor} initialMode="page" initialPage={1} />);
    expect(shownKeys()).toEqual(['pg_1']);
    expect(await screen.findByRole('img', { name: 'Image withheld' })).toBeInTheDocument();
    expect(document.querySelector('img[src*="blocked"]')).toBeNull();
    expect((fetch as unknown as ReturnType<typeof vi.fn>).mock.calls.some(([u]) => String(u).includes('blocked'))).toBe(false);
  });

  it('shows the rating badge, and Report only when the host offers it (never for the owner)', () => {
    const onReport = vi.fn();
    const { unmount } = render(<ComicReaderView doc={drawnDoc()} urlFor={fakeUrlFor} initialMode="page" rating="PG" />);
    expect(screen.getByRole('img', { name: 'Rated PG' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'More' })).toBeNull();
    unmount();
    render(<ComicReaderView doc={drawnDoc()} urlFor={fakeUrlFor} initialMode="page" initialPage={2} onReport={onReport} />);
    fireEvent.click(screen.getByRole('button', { name: 'More' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Report this comic' }));
    expect(onReport).toHaveBeenCalledWith(2);
  });

  it('downloads a PDF only when allowed, from the images it already shows (withheld excluded)', async () => {
    pdfMock.exportComicPdf.mockResolvedValue({ fileName: 'x.pdf', pages: 7, failed: [], skipped: [] });
    render(<ComicReaderView doc={drawnDoc()} urlFor={fakeUrlFor} initialMode="page" allowDownload />);
    fireEvent.click(screen.getByRole('button', { name: 'More' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Download (PDF)' }));
    await waitFor(() => expect(screen.getByText('Downloaded the PDF.')).toBeInTheDocument());
    const urlFor = pdfMock.exportComicPdf.mock.calls[0][1] as (a: unknown) => string | undefined;
    expect(urlFor({ path: 'u/bad.png', source: 'generated', at: 0, safety: { assessed: 'X', at: 1 } })).toBeUndefined();
    expect(urlFor({ path: 'u/p1.png', source: 'generated', at: 0 })).toBe('https://cdn.test/u/p1.png');
  });

  it('closes with the End card when the host gives one', () => {
    const onMakeYourOwn = vi.fn();
    render(<ComicReaderView doc={drawnDoc()} urlFor={fakeUrlFor} initialMode="page" endCard={{ onMakeYourOwn }} />);
    press('End');
    expect(screen.getByTestId('end-card')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'The End' })).toHaveFocus();
    fireEvent.click(screen.getByRole('button', { name: /Make your own comic/ }));
    expect(onMakeYourOwn).toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: /Read again/ }));
    expect(shownKeys()).toEqual(['cover']);
  });

  it('auto-hides its chrome while reading and brings it back on a center tap', () => {
    vi.useFakeTimers();
    render(<ComicReaderView doc={drawnDoc()} urlFor={fakeUrlFor} initialMode="page" chrome="auto-hide" />);
    const toolbar = screen.getByTestId('reader-toolbar');
    expect(toolbar).toHaveAttribute('data-shown', 'true');
    act(() => {
      vi.advanceTimersByTime(2600);
    });
    expect(toolbar).toHaveAttribute('data-shown', 'false');
    const stage = screen.getByTestId('reader-stage');
    stage.getBoundingClientRect = () => ({ left: 0, top: 0, width: 1000, height: 700, right: 1000, bottom: 700, x: 0, y: 0, toJSON: () => ({}) });
    fireEvent.pointerDown(stage, { clientX: 500, clientY: 300, pointerType: 'touch' });
    fireEvent.pointerUp(stage, { clientX: 500, clientY: 300, pointerType: 'touch' });
    expect(toolbar).toHaveAttribute('data-shown', 'true');
  });

  it('pinch-zooms the page (TouchCanvas), but never in scroll mode', () => {
    const { unmount } = render(<ComicReaderView doc={drawnDoc()} urlFor={fakeUrlFor} initialMode="page" />);
    expect(screen.getByRole('group', { name: 'Zoomable page' })).toBeInTheDocument();
    unmount();
    render(<ComicReaderView doc={drawnDoc()} urlFor={fakeUrlFor} initialMode="scroll" />);
    expect(screen.queryByRole('group', { name: 'Zoomable page' })).toBeNull();
  });

  it('pauses swipes while zoomed (a drag pans), but an arrow key or toolbar button still turns and snaps back to fit', () => {
    render(<ComicReaderView doc={drawnDoc()} urlFor={fakeUrlFor} initialMode="page" />);
    const canvas = screen.getByRole('group', { name: 'Zoomable page' });
    // Trackpad pinch (ctrl+wheel) zooms in.
    fireEvent.wheel(canvas, { ctrlKey: true, deltaY: -300, clientX: 10, clientY: 10 });
    expect(Number(canvas.getAttribute('data-zoom'))).toBeGreaterThan(1.05);
    const stage = screen.getByTestId('reader-stage');
    fireEvent.pointerDown(stage, { clientX: 300, clientY: 100, pointerType: 'touch' });
    fireEvent.pointerUp(stage, { clientX: 150, clientY: 110, pointerType: 'touch' });
    expect(shownKeys()).toEqual(['cover']);
    // An explicit control is never dead: it turns, and the new page opens at fit.
    press('ArrowRight');
    expect(shownKeys()).toEqual(['pg_1']);
    expect(screen.getByRole('group', { name: 'Zoomable page' })).toHaveAttribute('data-zoom', '1.00');
    fireEvent.wheel(screen.getByRole('group', { name: 'Zoomable page' }), { ctrlKey: true, deltaY: -300, clientX: 10, clientY: 10 });
    const next = screen.getByTestId('reader-counter').parentElement!.querySelectorAll('button')[1];
    fireEvent.click(next);
    expect(shownKeys()).toEqual(['pg_2']);
  });

  it('never puts invisible tap buttons on touch screens (mouse-only side zones)', () => {
    const { unmount } = render(<ComicReaderView doc={drawnDoc()} urlFor={fakeUrlFor} initialMode="page" />);
    expect(document.querySelectorAll('[data-zone]')).toHaveLength(2);
    unmount();
    render(
      <FormFactorProvider value={formFactorFor({ w: 1024, h: 768, coarse: true })}>
        <ComicReaderView doc={drawnDoc()} urlFor={fakeUrlFor} initialMode="page" />
      </FormFactorProvider>
    );
    expect(document.querySelector('[data-zone]')).toBeNull();
    // The outer thirds still turn by tap, through the stage itself.
    const stage = screen.getByTestId('reader-stage');
    stage.getBoundingClientRect = () => ({ left: 0, top: 0, width: 1000, height: 700, right: 1000, bottom: 700, x: 0, y: 0, toJSON: () => ({}) });
    fireEvent.pointerDown(stage, { clientX: 900, clientY: 300, pointerType: 'touch' });
    fireEvent.pointerUp(stage, { clientX: 900, clientY: 300, pointerType: 'touch' });
    expect(shownKeys()).toEqual(['pg_1']);
  });

  it('opens the immersive reader at the current page and comes back to where it ended', () => {
    const onImmersiveChange = vi.fn();
    vi.spyOn(window.history, 'back').mockImplementation(() => undefined);
    render(<ComicReaderView doc={drawnDoc()} urlFor={fakeUrlFor} initialMode="page" initialPage={2} immersiveEntry onImmersiveChange={onImmersiveChange} />);
    fireEvent.click(screen.getByRole('button', { name: 'Full screen' }));
    const dialog = screen.getByTestId('immersive-reader');
    expect(dialog).toHaveAttribute('role', 'dialog');
    expect(onImmersiveChange).toHaveBeenLastCalledWith(true);
    fireEvent.keyDown(dialog, { key: 'ArrowRight' });
    fireEvent.click(screen.getAllByRole('button', { name: /^Close/ })[0]);
    expect(screen.queryByTestId('immersive-reader')).toBeNull();
    expect(onImmersiveChange).toHaveBeenLastCalledWith(false);
  });
});
