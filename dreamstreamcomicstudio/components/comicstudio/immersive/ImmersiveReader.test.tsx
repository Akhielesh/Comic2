// Immersive reader integration (reader.md §15, jsdom): the cover intro (skippable by key, once per
// session), turns (instant under reduced motion), the End card taking focus, Guided View by `G` with
// "Panel 1 of 3" announced, deep links (?p=3 and an undrawn page), the Escape cascade, the transcript
// with aria-hidden lettering, settings, and closing.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { fakeUrlFor, makeSampleDoc } from '../board/__fixtures__/sampleDoc';
import type { ComicDoc } from '../../../shared/comic/doc';
import { ImmersiveReader, pdfDownloadFailedNote, pdfDownloadNote, readerExportOptions } from './ImmersiveReader';
import { ExportError } from '../export/errors';
import { pageImageCache } from './pageImageCache';

const pdfMock = vi.hoisted(() => ({ exportComicPdf: vi.fn() }));
vi.mock('../export/pdfExport', () => pdfMock);

const drawnDoc = (): ComicDoc =>
  makeSampleDoc((d) => {
    d.cover.render = { status: 'ready', history: [], asset: { path: 'u/cover.png', source: 'generated', at: 0, w: 1000, h: 1500 } };
    d.pages.forEach((p, i) => {
      p.render = { status: 'ready', history: [], asset: { path: `u/p${i + 1}.png`, source: 'generated', at: 0, w: 1000, h: 1500 } };
    });
  });

let reduce = false;
const realMatchMedia = window.matchMedia;
const setViewport = (w: number, h: number) => {
  Object.defineProperty(window, 'innerWidth', { value: w, configurable: true });
  Object.defineProperty(window, 'innerHeight', { value: h, configurable: true });
};

beforeEach(() => {
  reduce = false;
  pdfMock.exportComicPdf.mockReset();
  window.matchMedia = ((query: string) => ({
    matches: query.includes('prefers-reduced-motion') ? reduce : query.includes('hover: hover') || query.includes('any-pointer: fine'),
    media: query,
    onchange: null,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => false
  })) as unknown as typeof window.matchMedia;
  setViewport(390, 844);
  vi.stubGlobal('fetch', vi.fn(async () => new Response(new Blob(['img'], { type: 'image/png' }), { status: 200 })));
  let n = 0;
  (URL as unknown as { createObjectURL: (b: Blob) => string }).createObjectURL = () => `blob:test/${(n += 1)}`;
  (URL as unknown as { revokeObjectURL: (u: string) => void }).revokeObjectURL = () => undefined;
  (HTMLImageElement.prototype as unknown as { decode: () => Promise<void> }).decode = () => Promise.resolve();
  vi.spyOn(window.history, 'back').mockImplementation(() => undefined);
});

afterEach(() => {
  window.matchMedia = realMatchMedia;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  window.localStorage.clear();
  window.sessionStorage.clear();
  pageImageCache.clear();

});

const root = () => screen.getByTestId('immersive-reader');
const press = (key: string, init: Partial<KeyboardEvent> = {}) => fireEvent.keyDown(root(), { key, ...init });
const counter = () => screen.getByTestId('reader-hud-counter').textContent;

describe('ImmersiveReader', () => {
  it('opens as a modal dialog with the cover intro, skippable by a key (once per session)', () => {
    const onExit = vi.fn();
    const { unmount } = render(<ImmersiveReader doc={drawnDoc()} urlFor={fakeUrlFor} intro onExit={onExit} />);
    expect(root()).toHaveAttribute('role', 'dialog');
    expect(root()).toHaveAttribute('aria-modal', 'true');
    expect(root()).toHaveAttribute('aria-label', 'Reading The Saffron Thief');
    expect(root().dataset.phase).toBe('intro');
    expect(screen.getByTestId('cover-intro')).toHaveAccessibleName('Open The Saffron Thief');
    press('ArrowRight');
    expect(root().dataset.phase).toBe('reading');
    unmount();
    render(<ImmersiveReader doc={drawnDoc()} urlFor={fakeUrlFor} intro onExit={onExit} />);
    expect(root().dataset.phase).toBe('reading');
  });

  it('turns pages with the keyboard (instant crossfade under reduced motion) and lands on the End card with focus', async () => {
    reduce = true;
    render(<ImmersiveReader doc={drawnDoc()} urlFor={fakeUrlFor} intro={false} onExit={() => undefined} />);
    expect(counter()).toBe('Cover');
    press('ArrowRight');
    expect(counter()).toBe('Page 1 of 6');
    press('ArrowLeft');
    expect(counter()).toBe('Cover');
    press(' ');
    press(' ');
    expect(counter()).toBe('Page 2 of 6');
    press('End');
    expect(counter()).toBe('The End');
    await waitFor(() => expect(document.activeElement).toHaveTextContent('The End'));
    expect(screen.getByRole('button', { name: /Read again/ })).toBeInTheDocument();
    expect(screen.getByTestId('reader-live').textContent).toBe('The End.');
  });

  it('a right-to-left comic turns forward with ←', () => {
    reduce = true;
    const doc = drawnDoc();
    doc.format = { ...doc.format, readingDirection: 'rtl', kind: 'manga' };
    render(<ImmersiveReader doc={doc} urlFor={fakeUrlFor} intro={false} onExit={() => undefined} />);
    press('ArrowLeft');
    expect(counter()).toBe('Page 1 of 6');
  });

  it('G opens Guided View one tap away: overview, then "Panel 1 of 3" announced', () => {
    reduce = true;
    render(<ImmersiveReader doc={drawnDoc()} urlFor={fakeUrlFor} intro={false} initialPage={1} onExit={() => undefined} />);
    expect(root().dataset.guided).toBe('false');
    press('g');
    expect(root().dataset.guided).toBe('true');
    expect(screen.getByTestId('reader-live').textContent).toBe('Page 1. Whole page.');
    press('ArrowRight');
    expect(screen.getByTestId('reader-live').textContent).toMatch(/^Panel 1 of 3\. Panel 1\. The spice market at dawn/);
    press('ArrowRight');
    expect(screen.getByTestId('reader-live').textContent).toMatch(/^Panel 2 of 3\..*Maya whispers: “Just one more…”/);
  });

  it('deep links: ?p=3 opens page 3; an undrawn page shows the nearest one and says so', () => {
    reduce = true;
    const { unmount } = render(<ImmersiveReader doc={drawnDoc()} urlFor={fakeUrlFor} intro initialPage={3} onExit={() => undefined} />);
    expect(root().dataset.phase).toBe('reading'); // a deep link skips the intro
    expect(counter()).toBe('Page 3 of 6');
    unmount();
    render(<ImmersiveReader doc={makeSampleDoc()} urlFor={fakeUrlFor} intro={false} initialPage={3} onExit={() => undefined} />);
    expect(counter()).toBe('Page 1 of 2');
    expect(screen.getByRole('status')).toHaveTextContent('Page 3 isn’t drawn yet — showing page 1.');
  });

  it('?guided=1&panel=2 opens Guided View at that panel', () => {
    reduce = true;
    render(<ImmersiveReader doc={drawnDoc()} urlFor={fakeUrlFor} intro={false} initialPage={1} initialGuided initialPanel={2} onExit={() => undefined} />);
    expect(root().dataset.guided).toBe('true');
    expect(screen.getByTestId('reader-live').textContent).toMatch(/^Panel 2 of 3/);
  });

  it('double-tapping the right-hand page of a spread opens Guided View on that page (not the left one)', () => {
    reduce = true;
    setViewport(1280, 800);
    render(<ImmersiveReader doc={drawnDoc()} urlFor={fakeUrlFor} intro={false} initialPage={2} onExit={() => undefined} />);
    expect(root().dataset.layout).toBe('spread');
    expect(counter()).toBe('Pages 2–3 of 6');
    const stage = screen.getByTestId('book-stage');
    // jsdom has no layout: the stage rect is 0×0, so client coordinates are stage coordinates and every tap
    // reads as a centre tap. The book is centred (x ≈ 139..1141); x = 890 is on the right-hand page.
    const tap = (x: number) => {
      fireEvent.pointerDown(stage, { clientX: x, clientY: 400, pointerId: 1, pointerType: 'touch' });
      fireEvent.pointerUp(stage, { clientX: x, clientY: 400, pointerId: 1, pointerType: 'touch' });
    };
    act(() => {
      tap(890);
      tap(890);
    });
    expect(root().dataset.guided).toBe('true');
    expect(counter()).toBe('Page 3 of 6');
  });

  it('Escape: leave Guided View first, then close the reader', () => {
    reduce = true;
    const onExit = vi.fn();
    render(<ImmersiveReader doc={drawnDoc()} urlFor={fakeUrlFor} intro={false} initialPage={1} onExit={onExit} />);
    press('g');
    press('Escape');
    expect(root().dataset.guided).toBe('false');
    expect(onExit).not.toHaveBeenCalled();
    press('Escape');
    expect(onExit).toHaveBeenCalledTimes(1);
  });

  it('screen readers get an ordered transcript; the lettering layer is aria-hidden', async () => {
    reduce = true;
    render(<ImmersiveReader doc={drawnDoc()} urlFor={fakeUrlFor} intro={false} initialPage={1} onExit={() => undefined} />);
    const transcript = screen.getByTestId('reader-transcript');
    expect(transcript).toHaveTextContent('Page 1.');
    expect(transcript).toHaveTextContent('Caption: Old Delhi. Before the heat.');
    expect(transcript).toHaveTextContent('Vendor shouts: “Thief!”');
    await waitFor(() => expect(screen.getAllByTestId('balloon-layer').length).toBeGreaterThan(0));
    for (const layer of screen.getAllByTestId('balloon-layer')) expect(layer).toHaveAttribute('aria-hidden', 'true');
    // The visible page is a labelled group inside the book region.
    expect(screen.getByRole('region', { name: 'The Saffron Thief' })).toBeInTheDocument();
  });

  it('settings persist locally; the close button exits', () => {
    reduce = true;
    const onExit = vi.fn();
    render(<ImmersiveReader doc={drawnDoc()} urlFor={fakeUrlFor} intro={false} onExit={onExit} />);
    fireEvent.click(screen.getByRole('button', { name: 'Reader settings' }));
    const dialog = screen.getByRole('dialog', { name: 'Reader settings' });
    expect(dialog).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText('Page-turn sound'));
    expect(JSON.parse(window.localStorage.getItem('comicstudio.reader.prefs.v1')!)).toMatchObject({ sound: true });
    fireEvent.click(screen.getByRole('radio', { name: 'Slide' }));
    expect(JSON.parse(window.localStorage.getItem('comicstudio.reader.prefs.v1')!)).toMatchObject({ turn: 'slide' });
    press('Escape');
    expect(screen.queryByRole('dialog', { name: 'Reader settings' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Close reader' }));
    expect(onExit).toHaveBeenCalledTimes(1);
  });

  it('downloads only when allowed', () => {
    reduce = true;
    setViewport(1280, 800);
    const { unmount } = render(<ImmersiveReader doc={drawnDoc()} urlFor={fakeUrlFor} intro={false} onExit={() => undefined} />);
    expect(screen.getByRole('button', { name: 'Download' })).toBeInTheDocument();
    unmount();
    render(<ImmersiveReader doc={drawnDoc()} urlFor={fakeUrlFor} intro={false} allowDownload={false} onExit={() => undefined} />);
    expect(screen.queryByRole('button', { name: 'Download' })).toBeNull();
  });

  it('a withheld (blocked) page never goes into the PDF; the toast counts what was left out', async () => {
    reduce = true;
    setViewport(1280, 800);
    const seen: (string | undefined)[] = [];
    const spy = pdfMock.exportComicPdf.mockImplementation(async (d: ComicDoc, urlFor: (a: unknown) => string | undefined) => {
      for (const p of d.pages) seen.push(urlFor(p.render.asset));
      return { fileName: 'x.pdf', pages: 5, failed: [{ label: 'Page 6', message: 'network' }], skipped: ['Page 2 (image link not ready yet)'] };
    });
    const doc = drawnDoc();
    doc.pages[1].render.asset!.safety = { assessed: 'X', at: 1 };
    render(<ImmersiveReader doc={doc} urlFor={fakeUrlFor} intro={false} onExit={() => undefined} />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Download' }));
    });
    await waitFor(() => expect(spy).toHaveBeenCalledTimes(1));
    expect(seen[1]).toBeUndefined();
    expect(seen[0]).toBeTruthy();
    await waitFor(() => expect(screen.getByText(/Downloaded 5 pages — 2 couldn’t be included/)).toBeInTheDocument());
  });

  it('a host download (share links: the gated public one) replaces the built-in PDF; its line shows here', async () => {
    reduce = true;
    setViewport(1280, 800);
    let finish!: (note: string) => void;
    const onDownload = vi.fn(() => new Promise<string>((r) => (finish = r)));
    render(<ImmersiveReader doc={drawnDoc()} urlFor={fakeUrlFor} intro={false} allowDownload={false} onDownload={onDownload} onExit={() => undefined} />);
    const button = screen.getByRole('button', { name: 'Download' });
    await act(async () => {
      fireEvent.click(button);
      fireEvent.click(button); // a double tap never starts two downloads
    });
    expect(onDownload).toHaveBeenCalledTimes(1);
    expect(screen.getByText('Preparing the PDF…')).toBeInTheDocument();
    await act(async () => finish('Downloaded the PDF (Telugu).'));
    expect(await screen.findByText('Downloaded the PDF (Telugu).')).toBeInTheDocument();
    // The display URLs never feed a download on a share link.
    expect(pdfMock.exportComicPdf).not.toHaveBeenCalled();
  });

  it('the built-in PDF exports the edition being read by name and shows the export notice', async () => {
    reduce = true;
    setViewport(1280, 800);
    const spy = pdfMock.exportComicPdf.mockResolvedValue({ fileName: 'x.pdf', pages: 7, failed: [], skipped: [], notice: 'Some lettering used a fallback font.' });
    const doc = drawnDoc();
    render(<ImmersiveReader doc={doc} urlFor={fakeUrlFor} intro={false} onExit={() => undefined} />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Download' }));
    });
    await waitFor(() => expect(spy).toHaveBeenCalledTimes(1));
    expect(spy.mock.calls[0][0]).toBe(doc);
    expect(spy.mock.calls[0][2]).toEqual({});
    expect(await screen.findByText('Downloaded the PDF. Some lettering used a fallback font.')).toBeInTheDocument();
  });

  it('readerExportOptions names an existing edition only (the source and a missing edition export the doc as is)', () => {
    const doc = drawnDoc();
    doc.i18n = { glossary: [], editions: { te: { lang: 'te', register: 'everyday', lines: {}, balloons: {} } } };
    expect(readerExportOptions(doc, 'te')).toEqual({ lang: 'te' });
    expect(readerExportOptions(doc, 'TE')).toEqual({ lang: 'TE' });
    expect(readerExportOptions(doc, doc.format.language)).toEqual({});
    expect(readerExportOptions(doc, 'hi')).toEqual({});
    expect(readerExportOptions(doc, undefined)).toEqual({});
  });

  it('a failed PDF reads calmly, never as a raw error string', async () => {
    reduce = true;
    setViewport(1280, 800);
    pdfMock.exportComicPdf.mockRejectedValue(new TypeError("Cannot read properties of undefined (reading 'width')"));
    render(<ImmersiveReader doc={drawnDoc()} urlFor={fakeUrlFor} intro={false} onExit={() => undefined} />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Download' }));
    });
    expect(await screen.findByText('Couldn’t make the PDF. Please try again.')).toBeInTheDocument();
    expect(screen.queryByText(/Cannot read properties/)).toBeNull();
  });

  it('pdfDownloadNote / pdfDownloadFailedNote', () => {
    expect(pdfDownloadNote({ pages: 1, failed: [], skipped: ['Page 2'] })).toBe('Downloaded 1 page — 1 couldn’t be included (not drawn, withheld or didn’t load).');
    expect(pdfDownloadNote({ pages: 3, failed: [], skipped: [], notice: '  Smaller images were used.  ' })).toBe('Downloaded the PDF. Smaller images were used.');
    expect(pdfDownloadFailedNote(new ExportError('This comic is too big for one PDF on this device.', 'too_big'))).toBe('Couldn’t make the PDF. This comic is too big for one PDF on this device.');
    expect(pdfDownloadFailedNote(new Error('boom'))).toBe('Couldn’t make the PDF. Please try again.');
  });

  it('wide screens read in spreads with the cover alone on the right', () => {
    reduce = true;
    setViewport(1280, 800);
    render(<ImmersiveReader doc={drawnDoc()} urlFor={fakeUrlFor} intro={false} onExit={() => undefined} />);
    expect(root().dataset.layout).toBe('spread');
    const cover = document.querySelector('[data-slot="i0"]') as HTMLElement;
    expect(cover.dataset.side).toBe('right');
    act(() => {
      press('ArrowRight');
    });
    expect(counter()).toBe('Page 1 of 6');
    expect((document.querySelector('[data-slot="ep-front"]') as HTMLElement).dataset.visible).toBe('true');
  });

  it('a real paper turn folds the page, lands, and leaves no styles behind', async () => {
    render(<ImmersiveReader doc={drawnDoc()} urlFor={fakeUrlFor} intro={false} initialPage={1} onExit={() => undefined} />);
    expect(counter()).toBe('Page 1 of 6');
    const page1 = document.querySelector('[data-slot="i1"]') as HTMLElement;
    const page2 = document.querySelector('[data-slot="i2"]') as HTMLElement;
    expect(page2.dataset.visible).toBe('false'); // mounted early (decoded, measured), not shown
    press('ArrowRight');
    expect(page2.dataset.visible).toBe('true'); // revealed under the leaf
    // Polled finely: the fold lives ~560 ms, and a loaded CI box can be slow to schedule frames.
    await waitFor(() => expect(page1.style.clipPath).toMatch(/^polygon\(/), { timeout: 3000, interval: 5 });
    expect(screen.getByTestId('paper-back')).toBeInTheDocument();
    await waitFor(() => expect(counter()).toBe('Page 2 of 6'), { timeout: 3000 });
    expect(page1.style.clipPath).toBe('');
    expect(page1.dataset.visible).toBe('false');
    expect(screen.queryByTestId('paper-back')).toBeNull();
  });

  it('reduced motion: dragging a page is a crossfade that follows the finger — no fold, no paper back', async () => {
    reduce = true;
    render(<ImmersiveReader doc={drawnDoc()} urlFor={fakeUrlFor} intro={false} initialPage={1} onExit={() => undefined} />);
    const stage = screen.getByTestId('book-stage');
    const page1 = document.querySelector('[data-slot="i1"]') as HTMLElement;
    const page2 = document.querySelector('[data-slot="i2"]') as HTMLElement;
    fireEvent.pointerDown(stage, { clientX: 300, clientY: 400, pointerId: 7, pointerType: 'touch' });
    fireEvent.pointerMove(stage, { clientX: 260, clientY: 402, pointerId: 7, pointerType: 'touch' });
    expect(page2.dataset.visible).toBe('true');
    expect(page2.style.opacity).toBe('0'); // fades in as the finger travels
    expect(page1.style.clipPath).toBe('');
    expect(page1.style.transform).toBe('');
    expect(screen.queryByTestId('paper-back')).toBeNull();
    fireEvent.pointerMove(stage, { clientX: -200, clientY: 402, pointerId: 7, pointerType: 'touch' });
    fireEvent.pointerUp(stage, { clientX: -200, clientY: 402, pointerId: 7, pointerType: 'touch' });
    await waitFor(() => expect(counter()).toBe('Page 2 of 6'), { timeout: 3000 });
    expect(page2.style.opacity).toBe('');
  });

  it('the cover intro opens once on a swipe (no double turn from the click that may follow)', async () => {
    render(<ImmersiveReader doc={drawnDoc()} urlFor={fakeUrlFor} intro onExit={() => undefined} />);
    const intro = screen.getByTestId('cover-intro');
    fireEvent.pointerDown(intro, { clientX: 300, clientY: 400, pointerType: 'touch' });
    fireEvent.pointerUp(intro, { clientX: 200, clientY: 400, pointerType: 'touch' });
    fireEvent.click(intro);
    expect(root().dataset.phase).toBe('reading');
    await waitFor(() => expect(counter()).toBe('Page 1 of 6'), { timeout: 3000 });
    // No queued second turn: it stays on page 1.
    await new Promise((r) => setTimeout(r, 1200));
    expect(counter()).toBe('Page 1 of 6');
  });

  it('Tab never leaves the reader; off-screen pages are inert', () => {
    reduce = true;
    render(<ImmersiveReader doc={drawnDoc()} urlFor={fakeUrlFor} intro={false} onExit={() => undefined} />);
    const hidden = document.querySelector('[data-slot][data-visible="false"]') as HTMLElement;
    expect(hidden).toHaveAttribute('inert');
    const close = screen.getByRole('button', { name: 'Close reader' });
    const scrubber = screen.getByRole('slider', { name: 'Page' });
    scrubber.focus();
    fireEvent.keyDown(scrubber, { key: 'Tab' });
    expect(document.activeElement).toBe(close);
    fireEvent.keyDown(close, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(scrubber);
  });

  it('nothing drawn yet: an honest empty state', () => {
    render(<ImmersiveReader doc={makeSampleDoc((d) => d.pages.forEach((p) => (p.render = { status: 'none', history: [] })))} urlFor={fakeUrlFor} intro onExit={() => undefined} />);
    expect(screen.getByText('Nothing to read yet')).toBeInTheDocument();
  });
});
