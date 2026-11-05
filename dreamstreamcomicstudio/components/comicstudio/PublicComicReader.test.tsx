// The public reader (sharing.md §7.2, reader.md §2.1, jsdom). Slug mode: the boot card paints before
// the snapshot arrives, the cover card opens the immersive reader with its intro, a ?p= deep link opens
// the inline reader, ?lang= picks a published edition, Download only when the author allows it, Report
// never for the owner, one "This link isn't active" for every dead link, analytics never for the owner,
// and the embed's minimal chrome. Project mode (legacy links + owner preview) keeps its states and the
// quiet relink of expired signed links.
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ComicDoc } from '../../shared/comic/doc';
import type { PublicComicPayload } from '../../shared/comic/publication';
import { makeSampleDoc } from './board/__fixtures__/sampleDoc';
import { pageImageCache } from './immersive/pageImageCache';
import { readerEntryOnTop } from './immersive/useImmersive';
import { markIntroPlayed } from './immersive/readerPrefs';
import { ExportError } from './export/errors';
import { FormFactorProvider, formFactorFor } from './mobile/useFormFactor';

const api = vi.hoisted(() => ({
  loadPublicComic: vi.fn(),
  loadPublicComicBySlug: vi.fn(),
  trackPublicEvent: vi.fn(async () => undefined),
  reportPublicComic: vi.fn(async () => undefined)
}));
vi.mock('./studioApi', async (importOriginal) => ({ ...(await importOriginal<typeof import('./studioApi')>()), ...api }));
const pdfMock = vi.hoisted(() => ({ exportComicPdf: vi.fn() }));
vi.mock('./export/pdfExport', () => pdfMock);
const zipMock = vi.hoisted(() => ({ exportPngZip: vi.fn(), exportLanguagesZip: vi.fn() }));
vi.mock('./export/zipExport', () => zipMock);

// Imported after the mocks are registered.
const { PublicComicReader } = await import('./PublicComicReader');

const SLUG = 'AbCdEfGhIjKlMnOpQ';
/** A publication's asset key: published objects live at pub/<22-char key>/… */
const KEY = 'AbCdEfGhIjKlMnOpQrStUv';
const urls = { 'u/proj/pages/p1.png': 'https://signed.test/p1.png?token=a', 'u/proj/pages/p5.png': 'https://signed.test/p5.png?token=b' };

const snapshotDoc = (mutate?: (d: ComicDoc) => void): ComicDoc =>
  makeSampleDoc((d) => {
    d.cover.render = { status: 'ready', history: [], asset: { path: `pub/${KEY}/cover.webp`, source: 'generated', at: 0, w: 1000, h: 1500 } };
    d.pages.forEach((p, i) => {
      p.render = { status: 'ready', history: [], asset: { path: `pub/${KEY}/p${i + 1}.webp`, source: 'generated', at: 0, w: 1000, h: 1500 } };
    });
    mutate?.(d);
  });

const payload = (over: Partial<PublicComicPayload['publication']> = {}, doc = snapshotDoc()): PublicComicPayload => ({
  publication: {
    slug: SLUG,
    visibility: 'unlisted',
    languages: [],
    allowDownload: true,
    allowEmbed: true,
    publishedAt: 1,
    updatedAt: 1,
    card: { v: 1, title: 'The Saffron Thief', description: 'x', kindLabel: 'Comic', pageCount: 6, aspect: '2:3', og: {}, i18n: {} },
    ...over
  },
  doc,
  urls: Object.fromEntries(
    [doc.cover.render.asset, ...doc.pages.map((p) => p.render.asset)].filter(Boolean).map((a) => [a!.path, `https://public.test/${a!.path}`])
  )
});

const setBoot = (boot: Record<string, unknown>) => {
  const el = document.createElement('script');
  el.type = 'application/json';
  el.id = 'ds-share-boot';
  el.textContent = JSON.stringify(boot);
  document.body.appendChild(el);
};

const deferred = <T,>() => {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

beforeEach(() => {
  Object.values(api).forEach((f) => f.mockReset());
  [pdfMock.exportComicPdf, zipMock.exportPngZip, zipMock.exportLanguagesZip].forEach((f) => f.mockReset());
  api.trackPublicEvent.mockResolvedValue(undefined);
  Object.defineProperty(window, 'innerWidth', { value: 1280, configurable: true });
  Object.defineProperty(window, 'innerHeight', { value: 800, configurable: true });
  vi.stubGlobal('fetch', vi.fn(async () => new Response(new Blob(['img'], { type: 'image/png' }), { status: 200 })));
  let n = 0;
  (URL as unknown as { createObjectURL: (b: Blob) => string }).createObjectURL = () => `blob:test/${(n += 1)}`;
  (URL as unknown as { revokeObjectURL: (u: string) => void }).revokeObjectURL = () => undefined;
  (HTMLImageElement.prototype as unknown as { decode: () => Promise<void> }).decode = () => Promise.resolve();
  window.history.replaceState(null, '', `/c/${SLUG}`);
});
afterEach(async () => {
  // A test that ends with the full-screen reader open: unmount it now and let its history entry's pop land, since
  // closing writes the page it closed on (?p=) onto the entry underneath. Left to RTL's own cleanup, the next test's
  // beforeEach resets the history state before that pop runs, the pop never happens, and the reader's bounded-wait
  // fallback writes ?p= into a LATER test's address 1 s on, which then opens deep-linked (no cover card).
  cleanup();
  await waitFor(() => expect(readerEntryOnTop()).toBe(false));
  await new Promise((r) => setTimeout(r, 0));
  document.getElementById('ds-share-boot')?.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  window.localStorage.clear();
  window.sessionStorage.clear();
  pageImageCache.clear();
});

describe('PublicComicReader — share link (/c/<slug>)', () => {
  it('paints the boot card at once, then opens the comic in the immersive reader with its intro', async () => {
    setBoot({ slug: SLUG, card: { title: 'The Saffron Thief', description: 'A pickpocket steals saffron.', coverUrl: 'https://cdn.test/cover.jpg', aspect: '2:3', pageCount: 6, creator: 'mira' } });
    const d = deferred<PublicComicPayload>();
    api.loadPublicComicBySlug.mockReturnValue(d.promise);
    render(<PublicComicReader source={{ kind: 'slug', slug: SLUG }} />);
    // Before the snapshot arrives: the cover card from the boot data, its Read button waiting.
    expect(screen.getByRole('heading', { level: 1, name: 'The Saffron Thief' })).toBeInTheDocument();
    expect(screen.getByRole('img', { name: 'Cover of The Saffron Thief' })).toHaveAttribute('src', 'https://cdn.test/cover.jpg');
    expect(screen.getByText('by mira')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Opening/ })).toBeDisabled();
    d.resolve(payload());
    const read = await screen.findByRole('button', { name: /Start reading/ });
    fireEvent.click(read);
    const dialog = screen.getByTestId('immersive-reader');
    expect(dialog).toHaveAttribute('data-phase', 'intro');
    expect(api.loadPublicComicBySlug).toHaveBeenCalledWith(SLUG, expect.objectContaining({ signal: expect.any(AbortSignal) }));
  });

  it('says "This link isn’t active" for any dead link — no retry, no hint of why', async () => {
    api.loadPublicComicBySlug.mockRejectedValue(Object.assign(new Error('nope'), { kind: 'not_found', status: 404 }));
    render(<PublicComicReader source={{ kind: 'slug', slug: SLUG }} />);
    expect(await screen.findByText('This link isn’t active')).toBeInTheDocument();
    expect(screen.getByText('The creator may have turned this link off.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Try again/ })).toBeNull();
    expect(screen.getByRole('link', { name: /Go to DreamStream/ })).toHaveAttribute('href', '/');
  });

  it('/c/<slug>/embed with embedding turned off: shows the same "This link isn’t active" the server answered, not the comic', async () => {
    window.history.replaceState(null, '', `/c/${SLUG}/embed`);
    setBoot({ notFound: true }); // what functions/c/[[path]].ts injects for /embed when allowEmbed is false
    api.loadPublicComicBySlug.mockResolvedValue(payload({ allowEmbed: false }));
    render(<PublicComicReader source={{ kind: 'slug', slug: SLUG, embed: true }} />);
    expect(await screen.findByText('This link isn’t active')).toBeInTheDocument();
    expect(screen.queryByTestId('comic-reader')).toBeNull();
    expect(api.loadPublicComicBySlug).not.toHaveBeenCalled();
    expect(document.title).not.toMatch(/Saffron/);
  });

  it('treats a malformed slug as the same dead link without asking the server', async () => {
    render(<PublicComicReader source={{ kind: 'slug', slug: '' }} />);
    expect(await screen.findByText('This link isn’t active')).toBeInTheDocument();
    expect(api.loadPublicComicBySlug).not.toHaveBeenCalled();
  });

  it('offers Try again for network trouble', async () => {
    api.loadPublicComicBySlug.mockRejectedValueOnce(Object.assign(new Error("Couldn't reach the studio server."), { kind: 'network', status: 0 }));
    api.loadPublicComicBySlug.mockResolvedValueOnce(payload());
    render(<PublicComicReader source={{ kind: 'slug', slug: SLUG }} />);
    expect(await screen.findByText("Couldn't reach the studio server.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Try again/ }));
    expect(await screen.findByRole('button', { name: /Start reading/ })).toBeInTheDocument();
    expect(api.loadPublicComicBySlug).toHaveBeenCalledTimes(2);
  });

  it('opens a ?p= deep link straight in the inline reader at that page', async () => {
    api.loadPublicComicBySlug.mockResolvedValue(payload());
    render(<PublicComicReader source={{ kind: 'slug', slug: SLUG }} start={{ page: 3 }} />);
    await waitFor(() => expect(screen.getByTestId('public-comic-reader')).toHaveAttribute('data-view', 'inline'));
    await waitFor(() => expect(screen.getAllByTestId('reader-page').map((el) => el.getAttribute('data-key'))).toContain('pg_3'));
    expect(screen.queryByTestId('reader-cover-card')).toBeNull();
  });

  it('reads the published edition named by ?lang= and offers the language picker', async () => {
    window.history.replaceState(null, '', `/c/${SLUG}?lang=te`);
    const doc = snapshotDoc((d) => {
      d.i18n = { editions: { te: { lang: 'te', lines: {}, balloons: {}, brief: { title: { text: 'కుంకుమపువ్వు దొంగ', status: 'edited', sourceHash: 'h' } }, register: 'neutral' } as never }, glossary: [] };
    });
    api.loadPublicComicBySlug.mockResolvedValue(payload({ languages: ['en', 'te'] }, doc));
    render(<PublicComicReader source={{ kind: 'slug', slug: SLUG }} />);
    expect(await screen.findByRole('heading', { level: 1, name: 'కుంకుమపువ్వు దొంగ' })).toBeInTheDocument();
    expect(screen.getByTestId('public-reader-header').querySelector('button[aria-haspopup="listbox"]')).not.toBeNull();
  });

  it('opens a link without ?lang= in the author’s default edition (a returning reader keeps their own choice)', async () => {
    const doc = snapshotDoc((d) => {
      d.i18n = { editions: { te: { lang: 'te', lines: {}, balloons: {}, brief: { title: { text: 'కుంకుమపువ్వు దొంగ', status: 'edited', sourceHash: 'h' } }, register: 'neutral' } as never }, glossary: [] };
    });
    api.loadPublicComicBySlug.mockResolvedValue(payload({ languages: ['en', 'te'], defaultLang: 'te' }, doc));
    const { unmount } = render(<PublicComicReader source={{ kind: 'slug', slug: SLUG }} />);
    expect(await screen.findByRole('heading', { level: 1, name: 'కుంకుమపువ్వు దొంగ' })).toBeInTheDocument();
    unmount();
    window.localStorage.setItem('comicstudio.reader.lang', 'en');
    render(<PublicComicReader source={{ kind: 'slug', slug: SLUG }} />);
    expect(await screen.findByRole('heading', { level: 1, name: 'The Saffron Thief' })).toBeInTheDocument();
  });

  it('offers downloads only when the author allows them', async () => {
    api.loadPublicComicBySlug.mockResolvedValue(payload({ allowDownload: false }));
    const { unmount } = render(<PublicComicReader source={{ kind: 'slug', slug: SLUG }} />);
    await screen.findByRole('button', { name: /Start reading/ });
    expect(screen.queryByRole('button', { name: 'Download' })).toBeNull();
    unmount();
    pdfMock.exportComicPdf.mockResolvedValue({ fileName: 'x.pdf', pages: 7, failed: [], skipped: [] });
    api.loadPublicComicBySlug.mockResolvedValue(payload({ allowDownload: true }));
    render(<PublicComicReader source={{ kind: 'slug', slug: SLUG }} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Download' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Download PDF' }));
    await waitFor(() => expect(screen.getByText('Downloaded the PDF.')).toBeInTheDocument());
    // Built from the public images in the browser — nothing server-side, nothing private: only
    // pub/<22-char key>/ objects, through the edge's https URL, never a draft or anything else.
    const urlFor = pdfMock.exportComicPdf.mock.calls[0][1] as (a: unknown) => string | undefined;
    expect(urlFor({ path: `pub/${KEY}/p1.webp`, source: 'generated', at: 0 })).toBe(`https://public.test/pub/${KEY}/p1.webp`);
    expect(urlFor({ path: 'u/someone/private.png', source: 'generated', at: 0 })).toBeUndefined();
    expect(urlFor({ path: 'pub/short/p1.webp', source: 'generated', at: 0 })).toBeUndefined();
    expect(urlFor('https://evil.example/x.png')).toBeUndefined();
    expect(urlFor({ path: `pub/${KEY}/p1.webp`, source: 'generated', at: 0, safety: { assessed: 'X', at: 1 } })).toBeUndefined();
  });

  it('downloads only PUBLISHED languages: a reader on an unpublished source is offered the published edition, by name', async () => {
    pdfMock.exportComicPdf.mockResolvedValue({ fileName: 'x-te.pdf', pages: 2, failed: [], skipped: [] });
    const doc = snapshotDoc((d) => {
      d.i18n = { editions: { te: { lang: 'te', lines: {}, balloons: {}, register: 'neutral' } as never }, glossary: [] };
    });
    window.localStorage.setItem('comicstudio.reader.lang', 'en');
    api.loadPublicComicBySlug.mockResolvedValue(payload({ languages: ['te'] }, doc));
    render(<PublicComicReader source={{ kind: 'slug', slug: SLUG }} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Download' }));
    expect(screen.queryByRole('menuitem', { name: /all .* languages/ })).toBeNull();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Download PDF (Telugu)' }));
    await waitFor(() => expect(screen.getByText('Downloaded the PDF (Telugu).')).toBeInTheDocument());
    const [passedDoc, , opts] = pdfMock.exportComicPdf.mock.calls[0] as [ComicDoc, unknown, { lang?: string }];
    // The snapshot in its source language (the exporter localizes it to the published edition).
    expect(passedDoc.format.language).toBe('en');
    expect(passedDoc.i18n?.editions.te).toBeDefined();
    expect(opts.lang).toBe('te');
  });

  it('offers every published language as one ZIP and shows the export’s notice', async () => {
    const FONT = 'Some lettering fonts didn’t load, so the file may use a fallback font. Try again in a moment for the exact lettering.';
    zipMock.exportLanguagesZip.mockResolvedValue({ fileName: 'x-all-languages.zip', files: 4, failed: [], skipped: [], languages: ['en', 'te'], notice: FONT });
    const doc = snapshotDoc((d) => {
      d.i18n = { editions: { te: { lang: 'te', lines: {}, balloons: {}, register: 'neutral' } as never }, glossary: [] };
    });
    api.loadPublicComicBySlug.mockResolvedValue(payload({ languages: ['en', 'te'] }, doc));
    render(<PublicComicReader source={{ kind: 'slug', slug: SLUG }} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Download' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Download all 2 languages (.zip)' }));
    await waitFor(() => expect(screen.getByText(`Downloaded 2 languages, a folder each. ${FONT}`)).toBeInTheDocument());
    const [, urlFor, opts] = zipMock.exportLanguagesZip.mock.calls[0] as [ComicDoc, (a: unknown) => string | undefined, { languages?: string[] }];
    expect(opts.languages).toEqual(['en', 'te']);
    expect(urlFor({ path: 'u/someone/private.png', source: 'generated', at: 0 })).toBeUndefined();
  });

  it('an export that refuses (too big for the device) says why, and the reader keeps working', async () => {
    // The real refusal (zipExport → zipTooBigMessage) is an ExportError, whose message is written for the reader.
    zipMock.exportPngZip.mockRejectedValue(
      new ExportError('This book has too many pages to zip on this device (it would need about 900 MB of memory). Download the PDF instead — it keeps every page in one smaller file — or use a computer.', 'too_big')
    );
    api.loadPublicComicBySlug.mockResolvedValue(payload());
    render(<PublicComicReader source={{ kind: 'slug', slug: SLUG }} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Download' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Download page images (.zip)' }));
    expect(await screen.findByText(/Couldn’t prepare the download: This book has too many pages to zip on this device/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Start reading/ })).toBeEnabled();
  });

  it('a download that fails for any other reason says so calmly — never the raw error', async () => {
    pdfMock.exportComicPdf.mockRejectedValue(new TypeError('Failed to fetch https://public.test/pub/x/p1.webp (net::ERR_CONNECTION_RESET)'));
    api.loadPublicComicBySlug.mockResolvedValue(payload());
    render(<PublicComicReader source={{ kind: 'slug', slug: SLUG }} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Download' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Download PDF' }));
    expect(await screen.findByText('Couldn’t prepare the download. Please try again.')).toBeInTheDocument();
    expect(screen.queryByText(/Failed to fetch|ERR_CONNECTION_RESET/)).toBeNull();
  });

  it('the full-screen reader’s Download is the gated public download (pub/ images only), never its built-in PDF from display URLs', async () => {
    pdfMock.exportComicPdf.mockResolvedValue({ fileName: 'x.pdf', pages: 6, failed: [], skipped: [] });
    const p = payload();
    markIntroPlayed(p.doc.id);
    api.loadPublicComicBySlug.mockResolvedValue(p);
    render(<PublicComicReader source={{ kind: 'slug', slug: SLUG }} />);
    fireEvent.click(await screen.findByRole('button', { name: /Start reading/ }));
    const dialog = await screen.findByTestId('immersive-reader');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Download' }));
    await waitFor(() => expect(pdfMock.exportComicPdf).toHaveBeenCalledTimes(1));
    // downloadPublicComic's resolver: only pub/<22-char key>/ objects through the edge's https URL —
    // the reader's display resolver would hand back any absolute URL as is.
    const urlFor = pdfMock.exportComicPdf.mock.calls[0][1] as (a: unknown) => string | undefined;
    expect(urlFor('https://evil.example/x.png')).toBeUndefined();
    expect(urlFor({ path: 'u/someone/private.png', source: 'generated', at: 0 })).toBeUndefined();
    expect(urlFor({ path: `pub/${KEY}/p1.webp`, source: 'generated', at: 0 })).toBe(`https://public.test/pub/${KEY}/p1.webp`);
    // The full-screen reader covers the page's notice, so it repeats the host's line itself.
    await waitFor(() => expect(within(dialog).getByText('Downloaded the PDF.')).toBeInTheDocument());
  });

  it('the full-screen reader opened from the inline view (a ?p= deep link → Full screen) offers the same gated Download (publish-share-reader-05)', async () => {
    pdfMock.exportComicPdf.mockResolvedValue({ fileName: 'x.pdf', pages: 6, failed: [], skipped: [] });
    api.loadPublicComicBySlug.mockResolvedValue(payload());
    render(<PublicComicReader source={{ kind: 'slug', slug: SLUG }} start={{ page: 1 }} />);
    const inline = await screen.findByTestId('comic-reader');
    // The header carries Download; the inline toolbar adds no second entry for it.
    expect(await screen.findByRole('button', { name: 'Download' })).toBeInTheDocument();
    expect(within(inline).queryByRole('button', { name: 'More' })).toBeNull();
    fireEvent.click(within(inline).getByRole('button', { name: /Full screen/ }));
    const dialog = await screen.findByTestId('immersive-reader');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Download' }));
    await waitFor(() => expect(pdfMock.exportComicPdf).toHaveBeenCalledTimes(1));
    // The share link's gated download (pub/ objects only), never the reader's built-in PDF.
    const urlFor = pdfMock.exportComicPdf.mock.calls[0][1] as (a: unknown) => string | undefined;
    expect(urlFor('https://evil.example/x.png')).toBeUndefined();
    expect(urlFor({ path: `pub/${KEY}/p1.webp`, source: 'generated', at: 0 })).toBe(`https://public.test/pub/${KEY}/p1.webp`);
  });

  it('the full-screen reader opened from the inline view offers no Download when the author turned downloads off', async () => {
    api.loadPublicComicBySlug.mockResolvedValue(payload({ allowDownload: false }));
    render(<PublicComicReader source={{ kind: 'slug', slug: SLUG }} start={{ page: 1 }} />);
    const inline = await screen.findByTestId('comic-reader');
    fireEvent.click(within(inline).getByRole('button', { name: /Full screen/ }));
    const dialog = await screen.findByTestId('immersive-reader');
    expect(within(dialog).queryByRole('button', { name: /PDF|Download/i })).toBeNull();
  });

  it('the full-screen reader offers no Download when the author turned downloads off', async () => {
    const p = payload({ allowDownload: false });
    markIntroPlayed(p.doc.id);
    api.loadPublicComicBySlug.mockResolvedValue(p);
    render(<PublicComicReader source={{ kind: 'slug', slug: SLUG }} />);
    fireEvent.click(await screen.findByRole('button', { name: /Start reading/ }));
    const dialog = await screen.findByTestId('immersive-reader');
    expect(within(dialog).queryByRole('button', { name: /PDF|Download/i })).toBeNull();
    expect(pdfMock.exportComicPdf).not.toHaveBeenCalled();
  });

  it('the embed’s Download goes through the same gated public download', async () => {
    pdfMock.exportComicPdf.mockResolvedValue({ fileName: 'x.pdf', pages: 6, failed: [], skipped: [] });
    api.loadPublicComicBySlug.mockResolvedValue(payload());
    render(<PublicComicReader source={{ kind: 'slug', slug: SLUG, embed: true }} />);
    await screen.findByTestId('comic-reader');
    fireEvent.click(screen.getByRole('button', { name: 'More' }));
    fireEvent.click(screen.getByRole('menuitem', { name: /Download/ }));
    await waitFor(() => expect(pdfMock.exportComicPdf).toHaveBeenCalled());
    const urlFor = pdfMock.exportComicPdf.mock.calls[0][1] as (a: unknown) => string | undefined;
    expect(urlFor('https://evil.example/x.png')).toBeUndefined();
    expect(urlFor({ path: `pub/${KEY}/p1.webp`, source: 'generated', at: 0 })).toBe(`https://public.test/pub/${KEY}/p1.webp`);
  });

  it('a snapshot without publication info offers no download (never the language on screen, even with the boot switch on)', async () => {
    setBoot({ slug: SLUG, allowDownload: true, card: { title: 'The Saffron Thief', description: 'x', aspect: '2:3', pageCount: 6 } });
    const doc = snapshotDoc();
    const { publication: _omit, ...noPublication } = payload({}, doc);
    api.loadPublicComicBySlug.mockResolvedValue(noPublication as unknown as PublicComicPayload);
    render(<PublicComicReader source={{ kind: 'slug', slug: SLUG }} />);
    fireEvent.click(await screen.findByRole('button', { name: /Start reading/ }));
    const dialog = await screen.findByTestId('immersive-reader');
    expect(screen.queryByRole('button', { name: 'Download' })).toBeNull();
    expect(within(dialog).queryByRole('button', { name: /PDF|Download/i })).toBeNull();
    expect(pdfMock.exportComicPdf).not.toHaveBeenCalled();
  });

  it('an embed whose author turned downloads off offers none', async () => {
    api.loadPublicComicBySlug.mockResolvedValue(payload({ allowDownload: false }));
    render(<PublicComicReader source={{ kind: 'slug', slug: SLUG, embed: true }} />);
    await screen.findByTestId('comic-reader');
    // The ⋯ menu still offers Report, but no download of any kind.
    fireEvent.click(screen.getByRole('button', { name: 'More' }));
    expect(screen.getByRole('menuitem', { name: 'Report this comic' })).toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: /Download/ })).toBeNull();
  });

  it('counts one share per share: not again for a click while the copy menu is already open', async () => {
    api.loadPublicComicBySlug.mockResolvedValue(payload());
    render(<PublicComicReader source={{ kind: 'slug', slug: SLUG }} identityReady />);
    await screen.findByRole('button', { name: /Start reading/ });
    const share = within(screen.getByTestId('public-reader-header')).getByRole('button', { name: 'Share' });
    fireEvent.click(share);
    await waitFor(() => expect(share).toHaveAttribute('aria-expanded', 'true'));
    fireEvent.click(share);
    const shares = () => api.trackPublicEvent.mock.calls.filter((c) => JSON.stringify(c).includes('"share"')).length;
    expect(shares()).toBe(1);
  });

  it('Report waits until the reader is known (never flashes for the owner while identity loads)', async () => {
    api.loadPublicComicBySlug.mockResolvedValue(payload());
    const { rerender } = render(<PublicComicReader source={{ kind: 'slug', slug: SLUG }} identityReady={false} />);
    await screen.findByRole('button', { name: /Start reading/ });
    expect(screen.queryByRole('button', { name: 'More' })).toBeNull();
    rerender(<PublicComicReader source={{ kind: 'slug', slug: SLUG }} identityReady />);
    expect(screen.getByRole('button', { name: 'More' })).toBeInTheDocument();
  });

  it('lets readers report the comic, but never shows Report to its owner', async () => {
    api.loadPublicComicBySlug.mockResolvedValue(payload());
    const { unmount } = render(<PublicComicReader source={{ kind: 'slug', slug: SLUG }} isOwner />);
    await screen.findByRole('button', { name: /Start reading/ });
    expect(screen.queryByRole('button', { name: 'More' })).toBeNull();
    unmount();
    render(<PublicComicReader source={{ kind: 'slug', slug: SLUG }} />);
    await screen.findByRole('button', { name: /Start reading/ });
    fireEvent.click(screen.getByRole('button', { name: 'More' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Report this comic' }));
    expect(await screen.findByRole('heading', { name: 'Report this comic' })).toBeInTheDocument();
  });

  it('counts a view once identity has settled, and never for the owner', async () => {
    api.loadPublicComicBySlug.mockResolvedValue(payload());
    const { rerender } = render(<PublicComicReader source={{ kind: 'slug', slug: SLUG }} identityReady={false} />);
    await screen.findByRole('button', { name: /Start reading/ });
    expect(api.trackPublicEvent).not.toHaveBeenCalled();
    rerender(<PublicComicReader source={{ kind: 'slug', slug: SLUG }} identityReady />);
    await waitFor(() => expect(api.trackPublicEvent).toHaveBeenCalledWith(SLUG, expect.objectContaining({ type: 'view' })));
    expect(api.trackPublicEvent).toHaveBeenCalledTimes(1);
  });

  it('a link opened from a share action (?via=) counts its view under that channel and keeps a clean address', async () => {
    window.history.replaceState(null, '', `/c/${SLUG}?via=whatsapp`);
    api.loadPublicComicBySlug.mockResolvedValue(payload());
    render(<PublicComicReader source={{ kind: 'slug', slug: SLUG }} />);
    await waitFor(() => expect(api.trackPublicEvent).toHaveBeenCalledWith(SLUG, expect.objectContaining({ type: 'view', channel: 'whatsapp' })));
    // The channel tag is gone from the address (the reader's own page sync may add ?p= meanwhile).
    expect(new URLSearchParams(window.location.search).has('via')).toBe(false);
  });

  it('counts "complete" only after reading through to the end, never for a link that opens on the last page', async () => {
    api.loadPublicComicBySlug.mockResolvedValue(payload());
    render(<PublicComicReader source={{ kind: 'slug', slug: SLUG }} start={{ page: 6 }} />);
    const reader = await screen.findByTestId('comic-reader');
    await waitFor(() => expect(api.trackPublicEvent).toHaveBeenCalledWith(SLUG, expect.objectContaining({ type: 'view' })));
    const types = () => api.trackPublicEvent.mock.calls.map((c) => (c as unknown[])[1] as { type: string }).map((e) => e.type);
    expect(types()).not.toContain('complete');
    fireEvent.keyDown(reader, { key: 'ArrowLeft' });
    expect(types()).not.toContain('complete');
    fireEvent.keyDown(reader, { key: 'ArrowRight' });
    await waitFor(() => expect(types()).toContain('complete'));
    expect(types().filter((t) => t === 'complete')).toHaveLength(1);
  });

  it('keeps the rating badge on phones (in the reader toolbar) and the inline reader clear of a landscape notch', async () => {
    const doc = snapshotDoc((d) => {
      (d as unknown as { safety: unknown }).safety = { publish: { ok: true, rating: 'PG', checkedAt: 1 } };
    });
    api.loadPublicComicBySlug.mockResolvedValue(payload({}, doc));
    render(
      <FormFactorProvider value={formFactorFor({ w: 390, h: 844, coarse: true })}>
        <PublicComicReader source={{ kind: 'slug', slug: SLUG }} start={{ page: 2 }} />
      </FormFactorProvider>
    );
    const toolbar = await screen.findByTestId('reader-toolbar');
    expect(toolbar.querySelector('[role="img"][aria-label="Rated PG"]')).not.toBeNull();
    const main = screen.getByTestId('public-comic-reader').querySelector('main')!;
    expect(main.style.paddingLeft).toBe('var(--sa-left)');
    expect(main.style.paddingRight).toBe('var(--sa-right)');
  });

  it('sends nothing for the owner reading their own link', async () => {
    api.loadPublicComicBySlug.mockResolvedValue(payload());
    render(<PublicComicReader source={{ kind: 'slug', slug: SLUG }} isOwner identityReady />);
    await screen.findByRole('button', { name: /Start reading/ });
    await new Promise((r) => setTimeout(r, 20));
    expect(api.trackPublicEvent).not.toHaveBeenCalled();
  });

  it('invites readers to make their own (a full navigation out of /c/*)', async () => {
    api.loadPublicComicBySlug.mockResolvedValue(payload());
    render(<PublicComicReader source={{ kind: 'slug', slug: SLUG }} />);
    await screen.findByRole('button', { name: /Start reading/ });
    expect(screen.getByRole('link', { name: /make your own/i })).toHaveAttribute('href', '/');
  });

  it('embeds with minimal chrome: the reader itself, "Open on DreamStream", no call to action', async () => {
    api.loadPublicComicBySlug.mockResolvedValue(payload());
    render(<PublicComicReader source={{ kind: 'slug', slug: SLUG, embed: true }} />);
    expect(await screen.findByTestId('comic-reader')).toBeInTheDocument();
    expect(screen.queryByTestId('public-reader-header')).toBeNull();
    expect(screen.getByRole('link', { name: /Open on DreamStream/ })).toHaveAttribute('href', `https://comics.dreamstreamstudio.ai/c/${SLUG}`);
    expect(screen.getByRole('link', { name: /Open on DreamStream/ })).toHaveAttribute('target', '_blank');
    expect(screen.queryByRole('link', { name: /make your own/i })).toBeNull();
  });
});

describe('PublicComicReader — project link and owner preview', () => {
  it('shows a loading state, then the title, logline and the comic', async () => {
    const d = deferred<unknown>();
    api.loadPublicComic.mockReturnValue(d.promise);
    render(<PublicComicReader projectId="proj_1" />);
    expect(screen.getByText('Opening the comic…')).toBeInTheDocument();
    d.resolve({ doc: makeSampleDoc(), urls });
    expect(await screen.findByRole('heading', { name: 'The Saffron Thief' })).toBeInTheDocument();
    expect(screen.getByText('A pickpocket steals saffron to pay for her brother’s surgery.')).toBeInTheDocument();
    expect(api.loadPublicComic).toHaveBeenCalledWith('proj_1', expect.objectContaining({ signal: expect.any(AbortSignal) }));
    await waitFor(() => expect(fetch).toHaveBeenCalledWith('https://signed.test/p1.png?token=a', expect.anything()));
  });

  it('says plainly when the comic is not published', async () => {
    api.loadPublicComic.mockRejectedValue(Object.assign(new Error('nope'), { kind: 'not_found', status: 404 }));
    render(<PublicComicReader source={{ kind: 'project', projectId: 'proj_1' }} />);
    expect(await screen.findByText('This comic isn’t available')).toBeInTheDocument();
    expect(screen.getByText("This comic isn't published, or its creator made it private.")).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Try again/ })).toBeNull();
  });

  it('offers a retry for network trouble', async () => {
    api.loadPublicComic.mockRejectedValueOnce(Object.assign(new Error("Couldn't reach the studio server."), { kind: 'network', status: 0 }));
    api.loadPublicComic.mockResolvedValueOnce({ doc: makeSampleDoc(), urls });
    render(<PublicComicReader projectId="proj_1" />);
    expect(await screen.findByText("Couldn't reach the studio server.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Try again/ }));
    expect(await screen.findByRole('heading', { name: 'The Saffron Thief' })).toBeInTheDocument();
    expect(api.loadPublicComic).toHaveBeenCalledTimes(2);
  });

  it('closes when asked, and has no close button without onClose', async () => {
    api.loadPublicComic.mockResolvedValue({ doc: makeSampleDoc(), urls });
    const onClose = vi.fn();
    const { unmount } = render(<PublicComicReader projectId="proj_1" onClose={onClose} />);
    await screen.findByRole('heading', { name: 'The Saffron Thief' });
    fireEvent.click(screen.getByRole('button', { name: 'Close reader' }));
    expect(onClose).toHaveBeenCalled();
    unmount();
    render(<PublicComicReader projectId="proj_1" />);
    await screen.findByRole('heading', { name: 'The Saffron Thief' });
    expect(screen.queryByRole('button', { name: 'Close reader' })).toBeNull();
  });

  it('refreshes expired image links quietly when an image fails', async () => {
    api.loadPublicComic.mockResolvedValue({ doc: makeSampleDoc(), urls });
    render(<PublicComicReader projectId="proj_1" />);
    await screen.findByRole('heading', { name: 'The Saffron Thief' });
    const img = await screen.findByRole('img', { name: /Page 1/ });
    fireEvent.error(img);
    await waitFor(() => expect(api.loadPublicComic).toHaveBeenCalledTimes(2));
    // Still reading — no loading screen flash.
    expect(screen.getByRole('heading', { name: 'The Saffron Thief' })).toBeInTheDocument();
    expect(screen.queryByText('Opening the comic…')).toBeNull();
  });

  it('never offers Report on a project link (no public slug), and downloads only to the owner', async () => {
    api.loadPublicComic.mockResolvedValue({ doc: makeSampleDoc(), urls });
    const { unmount } = render(<PublicComicReader projectId="proj_1" />);
    await screen.findByRole('heading', { name: 'The Saffron Thief' });
    expect(screen.queryByRole('button', { name: 'More' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Download' })).toBeNull();
    unmount();
    render(<PublicComicReader projectId="proj_1" isOwner />);
    await screen.findByRole('heading', { name: 'The Saffron Thief' });
    expect(screen.getByRole('button', { name: 'Download' })).toBeInTheDocument();
  });
});
