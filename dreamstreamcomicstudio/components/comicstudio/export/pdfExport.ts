// Real PDF download: the cover and every drawn page, flattened with their lettering,
// laid out one per PDF page at comic trim width — no print dialog, no pop-ups.
//
// @cantoo/pdf-lib (MIT, the maintained pdf-lib fork) is loaded only when the user exports. Pages are rasterized one at a time
// as JPEG (a 20-page book stays a few MB instead of ~80 MB of PNGs) at the art's own
// resolution: a 2K page is ≈280 dpi at US comic trim (6.625"), which is print-ready for
// print-on-demand. Failures are reported per page; the rest of the book still exports.

import type { ComicDoc, Page } from '../../../shared/comic/doc';
import { downloadBlob } from '../../../services/download';
import { ExportError, renderImageToBlob, renderPageToBlob, type RasterOptions } from './rasterize';
import { blobBytes, exportFileStem, type ExportProgress, type UrlFor } from './zipExport';

/** US comic trim width in PDF points (6.625 in × 72). Height follows each page's aspect. */
export const COMIC_TRIM_WIDTH_PT = 6.625 * 72;

export interface PdfExportResult {
  fileName: string;
  pages: number;
  failed: { label: string; message: string }[];
  skipped: string[];
}

export interface PdfExportOptions {
  onProgress?: (progress: ExportProgress) => void;
  signal?: AbortSignal;
  /** JPEG quality (default 0.9). */
  quality?: number;
  /** Override the download (tests). */
  download?: (blob: Blob, fileName: string) => void;
  /** Override the renderers (tests). */
  renderPage?: (doc: ComicDoc, page: Page, url: string, opts: RasterOptions) => Promise<Blob>;
  renderImage?: (url: string, opts: RasterOptions) => Promise<Blob>;
}

interface Target {
  label: string;
  url: string;
  page?: Page;
}

/** Cover first, then drawn pages in reading order; undrawn/unsigned ones are reported as skipped. */
export const collectPdfTargets = (doc: ComicDoc, urlFor: UrlFor): { targets: Target[]; skipped: string[] } => {
  const targets: Target[] = [];
  const skipped: string[] = [];
  const coverAsset = doc.cover.render.asset;
  if (coverAsset?.path) {
    const url = urlFor(coverAsset);
    if (url) targets.push({ label: 'Cover', url });
    else skipped.push('Cover (image link not ready yet)');
  }
  [...doc.pages]
    .sort((a, b) => a.n - b.n)
    .forEach((page) => {
      const label = `Page ${page.n}`;
      if (!page.render.asset?.path) return void skipped.push(`${label} (not drawn yet)`);
      const url = urlFor(page.render.asset);
      if (!url) skipped.push(`${label} (image link not ready yet)`);
      else targets.push({ label, url, page });
    });
  return { targets, skipped };
};

/** PDF page size (points) for an image: trim width, height by the image's aspect. */
export const pdfPageSize = (imageW: number, imageH: number): { width: number; height: number } => {
  const aspect = imageW > 0 && imageH > 0 ? imageH / imageW : 1.5;
  return { width: COMIC_TRIM_WIDTH_PT, height: Math.round(COMIC_TRIM_WIDTH_PT * aspect * 100) / 100 };
};

const friendly = (err: unknown): string =>
  err instanceof ExportError ? err.message : (err as Error)?.message ? `Something went wrong: ${(err as Error).message}` : 'Something went wrong.';

export async function exportComicPdf(doc: ComicDoc, urlFor: UrlFor, opts: PdfExportOptions = {}): Promise<PdfExportResult> {
  const { targets, skipped } = collectPdfTargets(doc, urlFor);
  if (!targets.length) throw new ExportError('Nothing to export yet — draw at least one page first.');

  const { PDFDocument } = await import('@cantoo/pdf-lib');
  const pdf = await PDFDocument.create();
  const title = doc.brief.title?.trim() || 'Untitled comic';
  pdf.setTitle(title);
  if (doc.brief.logline) pdf.setSubject(doc.brief.logline);
  pdf.setCreator('DreamStream Comic Studio');
  pdf.setProducer('DreamStream Comic Studio (@cantoo/pdf-lib)');
  pdf.setLanguage(doc.format.language || 'en');

  const renderPage = opts.renderPage || renderPageToBlob;
  const renderImage = opts.renderImage || renderImageToBlob;
  const raster: RasterOptions = { signal: opts.signal, mime: 'image/jpeg', quality: opts.quality ?? 0.9 };
  const failed: PdfExportResult['failed'] = [];
  const total = targets.length;
  let pages = 0;

  for (let i = 0; i < targets.length; i += 1) {
    if (opts.signal?.aborted) throw new ExportError('Export cancelled.');
    const t = targets[i];
    opts.onProgress?.({ done: i, total, label: `Rendering ${t.label.toLowerCase()} (${i + 1} of ${total})…` });
    try {
      const blob = t.page ? await renderPage(doc, t.page, t.url, raster) : await renderImage(t.url, raster);
      const bytes = await blobBytes(blob);
      const image = blob.type === 'image/png' ? await pdf.embedPng(bytes) : await pdf.embedJpg(bytes);
      const size = pdfPageSize(image.width, image.height);
      const pdfPage = pdf.addPage([size.width, size.height]);
      pdfPage.drawImage(image, { x: 0, y: 0, width: size.width, height: size.height });
      pages += 1;
    } catch (err) {
      if (opts.signal?.aborted) throw new ExportError('Export cancelled.');
      failed.push({ label: t.label, message: friendly(err) });
    }
  }
  if (!pages) throw new ExportError(`Couldn’t export any pages. ${failed[0]?.message || ''}`.trim());

  opts.onProgress?.({ done: total, total, label: 'Building PDF…' });
  const data = await pdf.save();
  const fileName = `${exportFileStem(doc)}.pdf`;
  (opts.download || downloadBlob)(new Blob([data as BlobPart], { type: 'application/pdf' }), fileName);
  opts.onProgress?.({ done: total, total, label: 'Done' });
  return { fileName, pages, failed, skipped };
}
