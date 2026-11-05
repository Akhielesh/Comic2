import { describe, expect, it, vi } from 'vitest';
import { PDFDocument } from '@cantoo/pdf-lib';
import { emptyRender, type ComicDoc, type Page } from '../../../shared/comic/doc';
import { COMIC_TRIM_WIDTH_PT, collectPdfTargets, containBox, exportComicPdf, pdfPageSize, trimPageSize } from './pdfExport';
import { blobBytes } from './zipExport';
import { makeSampleDoc as sampleDoc } from '../board/__fixtures__/sampleDoc';
import { makeBook } from './__fixtures__/books';

// pdf-lib parses real headers, so these must be valid files.
const PNG_1x1 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const JPEG_1x1 =
  '/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=';
const bytes = (b64: string) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
const blob = (b64: string, type: string) => new Blob([bytes(b64)], { type });

const drawnDoc = (): ComicDoc => {
  const doc = sampleDoc();
  doc.cover = { ...doc.cover, render: { ...emptyRender(), status: 'ready', asset: { path: 'cover.webp', source: 'generated', at: 1 } } };
  doc.pages = doc.pages.map((p, i) =>
    i === 1 ? { ...p, render: emptyRender() } : { ...p, render: { ...emptyRender(), status: 'ready', asset: { path: `page-${p.n}.webp`, source: 'generated', at: 1 } } }
  );
  return doc;
};
const urlFor = (a?: { path: string } | string | null) => (a ? `https://cdn.test/${typeof a === 'string' ? a : a.path}` : undefined);

describe('PDF export', () => {
  it('collects the cover first, then drawn pages in order, reporting undrawn ones', () => {
    const doc = drawnDoc();
    const { targets, skipped } = collectPdfTargets(doc, urlFor);
    expect(targets[0].label).toBe('Cover');
    expect(targets.slice(1).map((t) => t.label)).toEqual(doc.pages.filter((_, i) => i !== 1).map((p) => `Page ${p.n}`));
    expect(skipped).toEqual([`Page ${doc.pages[1].n} (not drawn yet)`]);
  });

  it('sizes pages: the book trim (uniform) or the art’s own aspect', () => {
    expect(pdfPageSize(1696, 2528)).toEqual({ width: COMIC_TRIM_WIDTH_PT, height: Math.round(COMIC_TRIM_WIDTH_PT * (2528 / 1696) * 100) / 100 });
    expect(trimPageSize(2 / 3)).toEqual({ width: COMIC_TRIM_WIDTH_PT, height: 715.5 });
    // A square cover on a 2:3 trim is letterboxed, centred, never cropped.
    expect(containBox(1000, 1000, { width: 477, height: 715.5 })).toEqual({ x: 0, y: 119.25, width: 477, height: 477 });
  });

  it('builds a real multi-page PDF at uniform trim, keeps going past a failed page, and downloads it', async () => {
    const doc = drawnDoc();
    const download = vi.fn();
    const renderPage = vi.fn(async (_d: ComicDoc, page: { n: number }, _url: string, _opts: { mime?: string }) => {
      if (page.n === doc.pages[2]?.n) throw new Error('boom');
      return blob(JPEG_1x1, 'image/jpeg');
    });
    const renderImage = vi.fn(async () => blob(PNG_1x1, 'image/png'));
    const result = await exportComicPdf(doc, urlFor, { download, renderPage, renderImage });

    const expectedPages = 1 + doc.pages.filter((_, i) => i !== 1).length - 1; // cover + drawn − failed
    expect(result.pages).toBe(expectedPages);
    expect(result.failed).toEqual([{ label: `Page ${doc.pages[2].n}`, message: 'Something went wrong: boom' }]);
    expect(renderPage.mock.calls[0][3]).toMatchObject({ mime: 'image/jpeg' });

    const [pdfBlob, fileName] = download.mock.calls[0];
    expect(fileName).toBe('the-saffron-thief.pdf');
    expect(pdfBlob.type).toBe('application/pdf');
    const parsed = await PDFDocument.load(await blobBytes(pdfBlob as Blob));
    expect(parsed.getPageCount()).toBe(expectedPages);
    expect(parsed.getTitle()).toBe(doc.brief.title);
    // Uniform trim: every page is the book's trim, whatever the art's shape (here 1×1 test images).
    for (const page of parsed.getPages()) {
      expect(page.getWidth()).toBeCloseTo(COMIC_TRIM_WIDTH_PT);
      expect(page.getHeight()).toBeCloseTo(715.5);
    }
  });

  it('with uniform trim off, each page takes its art’s own size', async () => {
    const download = vi.fn();
    await exportComicPdf(drawnDoc(), urlFor, { download, uniformTrim: false, renderPage: async () => blob(JPEG_1x1, 'image/jpeg'), renderImage: async () => blob(PNG_1x1, 'image/png') });
    const parsed = await PDFDocument.load(await blobBytes(download.mock.calls[0][0] as Blob));
    expect(parsed.getPage(0).getHeight()).toBeCloseTo(COMIC_TRIM_WIDTH_PT); // 1×1 art → square page
  });

  it('puts the plates in reading order and exports an edition with its language and title', async () => {
    const download = vi.fn();
    const order: string[] = [];
    const renderPlate = vi.fn(async (d: ComicDoc, kind: string) => {
      order.push(kind);
      expect(d.format.language).toBe('te');
      return blob(PNG_1x1, 'image/png');
    });
    const renderPage = vi.fn(async (_d: ComicDoc, p: Page) => {
      order.push(p.id);
      return blob(JPEG_1x1, 'image/jpeg');
    });
    const renderImage = vi.fn(async () => {
      order.push('cover');
      return blob(PNG_1x1, 'image/png');
    });
    const result = await exportComicPdf(makeBook(), urlFor, { lang: 'te', download, renderPage, renderImage, renderPlate });
    expect(order).toEqual(['cover', 'title', 'pg_1', 'pg_5', 'end', 'back_cover']);
    expect(result.pages).toBe(6);
    expect(result.fileName).toBe('కుంకుమపువ్వు-దొంగ-te.pdf'); // the edition's own title, sanitized
    const parsed = await PDFDocument.load(await blobBytes(download.mock.calls[0][0] as Blob), { updateMetadata: false });
    expect(parsed.getTitle()).toBe('కుంకుమపువ్వు దొంగ');
  });

  it('writes only a well-formed language tag into /Lang (pdf-lib does not escape it)', async () => {
    const download = vi.fn();
    const doc = drawnDoc();
    doc.format.language = 'en) /OpenAction << /S /JavaScript /JS (app.alert(1)) >> (';
    await exportComicPdf(doc, urlFor, { download, renderPage: async () => blob(JPEG_1x1, 'image/jpeg'), renderImage: async () => blob(PNG_1x1, 'image/png') });
    const bytes = await blobBytes(download.mock.calls[0][0] as Blob);
    const text = new TextDecoder('latin1').decode(bytes);
    expect(text).not.toContain('/JavaScript');
    expect(text).not.toContain('/OpenAction');
    expect((await PDFDocument.load(bytes)).getLanguage()).toBe('en');
  });

  it('never includes a withheld image', async () => {
    const download = vi.fn();
    const doc = drawnDoc();
    doc.pages[0].render.asset = { ...doc.pages[0].render.asset!, safety: { assessed: 'X', at: 1 } };
    const renderPage = vi.fn(async () => blob(JPEG_1x1, 'image/jpeg'));
    const result = await exportComicPdf(doc, urlFor, { download, renderPage, renderImage: async () => blob(PNG_1x1, 'image/png') });
    expect(renderPage.mock.calls.map((c) => (c as unknown[])[2])).not.toContain('https://cdn.test/page-1.webp');
    expect(result.skipped).toContain('Page 1 (withheld by the safety check)');
  });

  it('refuses to export a comic with nothing drawn', async () => {
    const doc = sampleDoc();
    doc.cover = { ...doc.cover, render: emptyRender() };
    doc.pages = doc.pages.map((p) => ({ ...p, render: emptyRender() }));
    await expect(exportComicPdf(doc, urlFor, { download: vi.fn() })).rejects.toThrow(/Nothing to export yet/);
  });
});
