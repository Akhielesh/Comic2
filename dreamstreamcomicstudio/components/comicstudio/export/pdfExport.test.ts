import { describe, expect, it, vi } from 'vitest';
import { PDFDocument } from '@cantoo/pdf-lib';
import { emptyRender, type ComicDoc } from '../../../shared/comic/doc';
import { COMIC_TRIM_WIDTH_PT, collectPdfTargets, exportComicPdf, pdfPageSize } from './pdfExport';
import { blobBytes } from './zipExport';
import { makeSampleDoc as sampleDoc } from '../board/__fixtures__/sampleDoc';

// 1×1 images: pdf-lib parses real headers, so these must be valid files.
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

  it('sizes PDF pages at comic trim width by the art aspect', () => {
    expect(pdfPageSize(1696, 2528)).toEqual({ width: COMIC_TRIM_WIDTH_PT, height: Math.round(COMIC_TRIM_WIDTH_PT * (2528 / 1696) * 100) / 100 });
  });

  it('builds a real multi-page PDF, keeps going past a failed page, and downloads it', async () => {
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
    expect(fileName).toMatch(/\.pdf$/);
    expect(pdfBlob.type).toBe('application/pdf');
    const parsed = await PDFDocument.load(await blobBytes(pdfBlob as Blob));
    expect(parsed.getPageCount()).toBe(expectedPages);
    expect(parsed.getTitle()).toBe(doc.brief.title);
    expect(parsed.getPage(0).getWidth()).toBeCloseTo(COMIC_TRIM_WIDTH_PT);
  });

  it('refuses to export a comic with nothing drawn', async () => {
    const doc = sampleDoc();
    doc.cover = { ...doc.cover, render: emptyRender() };
    doc.pages = doc.pages.map((p) => ({ ...p, render: emptyRender() }));
    await expect(exportComicPdf(doc, urlFor, { download: vi.fn() })).rejects.toThrow(/Nothing to export yet/);
  });
});
