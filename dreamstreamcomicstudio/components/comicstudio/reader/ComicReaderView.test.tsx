// The inline reader shell (reader.md §11.1, contract §13.3, jsdom): one layout decision with the
// immersive reader (cover alone on its side, page 1 facing the inside cover), turns by key / swipe /
// toolbar, deep links in (`initialPage`, honest fallback for an undrawn page) and out (`?p=`), the
// language slot, the withheld tile (never an <img>), the rating badge, Report only when offered, the
// End card, auto-hiding chrome, zoom, and the immersive entry.
import React from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ComicDoc } from '../../../shared/comic/doc';
import { fakeUrlFor, makeSampleDoc } from '../board/__fixtures__/sampleDoc';
import { pageImageCache } from '../immersive/pageImageCache';
import { FormFactorProvider, formFactorFor } from '../mobile/useFormFactor';
import { ComicReaderView, ReaderMenu } from './ComicReaderView';

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

  it('shows the export notice with the done line, and a failure calmly (never a raw error)', async () => {
    pdfMock.exportComicPdf.mockResolvedValueOnce({ fileName: 'x.pdf', pages: 7, failed: [], skipped: [], notice: 'Some lettering used a fallback font.' });
    const doc = drawnDoc();
    const { unmount } = render(<ComicReaderView doc={doc} urlFor={fakeUrlFor} initialMode="page" allowDownload />);
    fireEvent.click(screen.getByRole('button', { name: 'More' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Download (PDF)' }));
    await waitFor(() => expect(screen.getByText('Downloaded the PDF. Some lettering used a fallback font.')).toBeInTheDocument());
    // The source doc goes to the export (it localizes the edition itself and names the file by language).
    expect(pdfMock.exportComicPdf.mock.calls[0][0]).toBe(doc);
    unmount();
    pdfMock.exportComicPdf.mockRejectedValueOnce(new TypeError("Cannot read properties of undefined (reading 'w')"));
    render(<ComicReaderView doc={drawnDoc()} urlFor={fakeUrlFor} initialMode="page" allowDownload />);
    fireEvent.click(screen.getByRole('button', { name: 'More' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Download (PDF)' }));
    await waitFor(() => expect(screen.getByText('Couldn’t make the PDF. Please try again.')).toBeInTheDocument());
    expect(screen.queryByText(/Cannot read properties/)).toBeNull();
  });

  it('a host download (the share-link embed) also replaces the immersive reader’s built-in PDF', async () => {
    vi.spyOn(window.history, 'back').mockImplementation(() => undefined);
    const onDownload = vi.fn(async () => 'Downloaded the PDF (Hindi).');
    render(<ComicReaderView doc={drawnDoc()} urlFor={fakeUrlFor} initialMode="page" immersiveEntry onDownload={onDownload} />);
    fireEvent.click(screen.getByRole('button', { name: 'Full screen' }));
    const dialog = screen.getByTestId('immersive-reader');
    await act(async () => {
      fireEvent.click(within(dialog).getAllByRole('button', { name: 'Download' })[0]);
    });
    expect(onDownload).toHaveBeenCalledTimes(1);
    expect(pdfMock.exportComicPdf).not.toHaveBeenCalled();
    expect(await within(dialog).findByText('Downloaded the PDF (Hindi).')).toBeInTheDocument();
  });

  it('readerDownload: offered in the full-screen reader and on the End card, never as a second entry in the ⋯ menu', async () => {
    vi.spyOn(window.history, 'back').mockImplementation(() => undefined);
    const readerDownload = vi.fn(async () => 'Downloaded the PDF.');
    render(<ComicReaderView doc={drawnDoc()} urlFor={fakeUrlFor} initialMode="page" immersiveEntry endCard={{}} readerDownload={readerDownload} />);
    // The host's header carries Download: nothing here duplicates it.
    expect(screen.queryByRole('button', { name: 'More' })).toBeNull();
    press('End');
    expect(within(screen.getByTestId('end-card')).getByRole('button', { name: /Download/ })).toBeInTheDocument();
    press('Home');
    fireEvent.click(screen.getByRole('button', { name: 'Full screen' }));
    const dialog = screen.getByTestId('immersive-reader');
    await act(async () => {
      fireEvent.click(within(dialog).getAllByRole('button', { name: 'Download' })[0]);
    });
    expect(readerDownload).toHaveBeenCalledTimes(1);
    expect(pdfMock.exportComicPdf).not.toHaveBeenCalled();
  });

  it('inline, a host download runs once per tap; its own notice is the one on screen, a throw reads calmly', async () => {
    let finish!: (v: string) => void;
    const onDownload = vi.fn(() => new Promise<string>((r) => (finish = r)));
    const { unmount } = render(<ComicReaderView doc={drawnDoc()} urlFor={fakeUrlFor} initialMode="page" onDownload={onDownload} />);
    fireEvent.click(screen.getByRole('button', { name: 'More' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Download (PDF)' }));
    fireEvent.click(screen.getByRole('button', { name: 'More' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Preparing…' }));
    expect(onDownload).toHaveBeenCalledTimes(1);
    await act(async () => finish('Downloaded the PDF (Hindi).'));
    expect(screen.queryByText('Downloaded the PDF (Hindi).')).toBeNull();
    expect(pdfMock.exportComicPdf).not.toHaveBeenCalled();
    unmount();
    render(<ComicReaderView doc={drawnDoc()} urlFor={fakeUrlFor} initialMode="page" onDownload={() => Promise.reject(new Error('NetworkError when attempting to fetch resource.'))} />);
    fireEvent.click(screen.getByRole('button', { name: 'More' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Download (PDF)' }));
    await waitFor(() => expect(screen.getByText('Couldn’t make the PDF. Please try again.')).toBeInTheDocument());
    expect(screen.queryByText(/NetworkError/)).toBeNull();
  });

  it('the reader menu lets a long download label wrap (the edition stays readable at 320 px)', () => {
    const label = 'Download page images (.zip) (Telugu)';
    render(<ReaderMenu label="More" items={[{ id: 'zip', label, icon: <span aria-hidden>z</span>, onSelect: () => undefined }]} />);
    fireEvent.click(screen.getByRole('button', { name: 'More' }));
    const text = screen.getByText(label);
    expect(text.className).not.toMatch(/\btruncate\b/);
    expect(text.className).toMatch(/whitespace-normal/);
    expect(text.className).toMatch(/\[overflow-wrap:anywhere\]/);
    expect(screen.getByRole('menuitem', { name: label })).toBeInTheDocument();
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

// Device-matrix follow-ups (ui-findings 2026-10-29, P2-READER-PUBLIC / P2-BOARD): on a dual-screen
// foldable the zoomable page straddled the hinge; in a split pane the stage ran into the home-indicator
// inset; the phone-landscape (fit-to-width) scroller had no keyboard access; the toolbar wrapped to two
// rows in a 99 px tall landscape pane.
describe('ComicReaderView on devices', () => {
  const segments = (w: number, h: number) => {
    const rect = (x: number, width: number) => ({ x, y: 0, left: x, top: 0, width, height: h, right: x + width, bottom: h, toJSON: () => ({}) }) as DOMRectReadOnly;
    return { count: 2 as const, axis: 'horizontal' as const, rects: [rect(0, w / 2), rect(w / 2, w / 2)], hinge: { start: w / 2, end: w / 2 } };
  };
  const size = (w: number, h: number) => {
    Object.defineProperty(window, 'innerWidth', { value: w, configurable: true });
    Object.defineProperty(window, 'innerHeight', { value: h, configurable: true });
  };
  const paneOf = (el: HTMLElement) => el.closest('[data-pane]')!.getAttribute('style') || '';

  it('dual-screen spread: each page sits in its own segment with its own zoomable canvas; nothing spans the fold', () => {
    size(882, 1104);
    render(
      <FormFactorProvider value={formFactorFor({ w: 882, h: 1104, coarse: true, segments: segments(882, 1104) })}>
        <ComicReaderView doc={drawnDoc()} urlFor={fakeUrlFor} />
      </FormFactorProvider>
    );
    expect(reader()).toHaveAttribute('data-layout', 'spread');
    // The cover alone on the right: no canvas is rendered for the empty left side.
    expect(screen.queryByRole('group', { name: 'Zoomable page' })).toBeNull();
    expect(screen.queryByRole('group', { name: 'Zoomable left page' })).toBeNull();
    expect(paneOf(screen.getByRole('group', { name: 'Zoomable right page' }))).toMatch(/left: 441px/);
    press('ArrowRight');
    expect(shownKeys()).toEqual(['pg_1']);
    const left = screen.getByRole('group', { name: 'Zoomable left page' });
    expect(paneOf(left)).toMatch(/width: 441px/);
    expect(paneOf(left)).toMatch(/left: 0px/);
    expect(paneOf(screen.getByRole('group', { name: 'Zoomable right page' }))).toMatch(/left: 441px/);
  });

  it('dual-screen, one page at a time: the page lays on the recto segment, never across the fold', () => {
    size(882, 1104);
    render(
      <FormFactorProvider value={formFactorFor({ w: 882, h: 1104, coarse: true, segments: segments(882, 1104) })}>
        <ComicReaderView doc={drawnDoc()} urlFor={fakeUrlFor} initialMode="page" />
      </FormFactorProvider>
    );
    expect(reader()).toHaveAttribute('data-layout', 'single');
    const pane = paneOf(screen.getByRole('group', { name: 'Zoomable page' }));
    expect(pane).toMatch(/left: 441px/);
    expect(pane).toMatch(/width: 441px/);
  });

  it('phone landscape: the fit-to-width page scroller is keyboard-focusable (a named region)', () => {
    size(734, 343);
    const { unmount } = render(
      <FormFactorProvider value={formFactorFor({ w: 734, h: 343, coarse: true })}>
        <ComicReaderView doc={drawnDoc()} urlFor={fakeUrlFor} initialMode="page" />
      </FormFactorProvider>
    );
    const box = screen.getByTestId('reader-stage-box');
    expect(box.className).toContain('overflow-y-auto');
    // The page inside the scroller is the focusable content (the box itself can be ~40 px tall in a
    // landscape studio pane; the page is always ≥ 44 px).
    const page = within(box).getByTestId('reader-page-scroller');
    expect(page).toHaveAttribute('tabindex', '0');
    expect(page).toHaveAttribute('role', 'region');
    expect(page.getAttribute('aria-label')).toBeTruthy();
    expect(page).toContainElement(screen.getByTestId('reader-book'));
    unmount();
    size(1280, 800);
    render(<ComicReaderView doc={drawnDoc()} urlFor={fakeUrlFor} initialMode="page" />);
    expect(screen.getByTestId('reader-stage-box')).not.toHaveAttribute('tabindex');
    expect(screen.queryByTestId('reader-page-scroller')).toBeNull();
  });

  it('pads the stage by the bottom safe area only when the reader ends at the viewport bottom', () => {
    size(1280, 800);
    const rect = (flush: boolean) => ({ x: 0, y: 0, left: 0, top: 0, width: 1280, height: 800, right: 1280, bottom: flush ? 800 : 0, toJSON: () => ({}) }) as DOMRect;
    const spy = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      return rect(this.dataset?.testid === 'comic-reader');
    });
    const { unmount } = render(<ComicReaderView doc={drawnDoc()} urlFor={fakeUrlFor} initialMode="page" />);
    expect(screen.getByTestId('reader-stage').style.paddingBottom).toBe('var(--sa-bottom-eff, 0px)');
    unmount();
    spy.mockImplementation(() => rect(false));
    render(<ComicReaderView doc={drawnDoc()} urlFor={fakeUrlFor} initialMode="page" />);
    expect(screen.getByTestId('reader-stage').style.paddingBottom).toBe('');
  });

  it('fullscreenControl={false} leaves the browser full-screen button out (the host has its own)', () => {
    size(1280, 800);
    const { unmount } = render(<ComicReaderView doc={drawnDoc()} urlFor={fakeUrlFor} initialMode="page" fullscreenControl={false} />);
    expect(screen.queryByRole('button', { name: 'Full screen' })).toBeNull();
    unmount();
    render(<ComicReaderView doc={drawnDoc()} urlFor={fakeUrlFor} initialMode="page" />);
    expect(screen.getByRole('button', { name: 'Full screen' })).toBeInTheDocument();
  });

  it('compact height: one toolbar row — segment labels go icon-only (still named) and the row never wraps', () => {
    size(734, 343);
    render(
      <FormFactorProvider value={formFactorFor({ w: 734, h: 343, coarse: true })}>
        <ComicReaderView doc={drawnDoc()} urlFor={fakeUrlFor} initialMode="page" />
      </FormFactorProvider>
    );
    const toolbar = screen.getByTestId('reader-toolbar');
    expect(toolbar.className).toContain('flex-nowrap');
    expect(toolbar.className).not.toContain('flex-wrap');
    const scroll = within(toolbar).getByRole('radio', { name: 'Scroll' });
    expect(scroll.querySelector('.sr-only')).toHaveTextContent('Scroll');
  });
});
