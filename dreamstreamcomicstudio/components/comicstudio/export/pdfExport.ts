// Real PDF download: the book in reading order — cover, title page, every drawn page, "The End",
// back cover — flattened with its lettering, one per PDF page, no print dialog, no pop-ups.
//
// Uniform trim (book.uniformTrim, default on; timeline.md §4.1): every PDF page is the comic's trim —
// US comic trim width (6.625 in) × format.pageAspect — and art of another shape is letterboxed on
// white, so print-on-demand accepts the file. With uniform trim off, each page takes its art's size.
//
// @cantoo/pdf-lib (MIT, the maintained pdf-lib fork) is loaded only when the user exports. Pages are
// rasterized one at a time as JPEG (a 20-page book stays a few MB instead of ~80 MB of PNGs) at the
// art's own resolution: a 2K page is ≈ 280 dpi at trim, print-ready for print-on-demand. A slot that
// fails is reported; the rest of the book still exports.

import type { ComicDoc } from '../../../shared/comic/doc';
import { sameLanguage } from '../../../shared/comic/languages';
import { downloadBlob } from '../../../services/download';
import { forEachReported, plateWidthFor, renderSlotWith, checkCancelled, type SlotRenderers } from './batch';
import { ExportError } from './errors';
import { exportFileStem } from './filenames';
import { prepareExportFonts } from './fonts';
import type { RasterOptions } from './rasterize';
import { collectExportSlots, localizedFor, trimAspectOf, uniformTrimOf, type ExportSlot } from './sequence';
import { blobBytes, type ExportProgress, type UrlFor } from './zipExport';

/** US comic trim width in PDF points (6.625 in × 72). */
export const COMIC_TRIM_WIDTH_PT = 6.625 * 72;

export interface PdfExportResult {
  fileName: string;
  pages: number;
  failed: { label: string; message: string }[];
  skipped: string[];
  /** Set when a lettering face didn't load (the file may use a fallback face). */
  notice?: string;
}

export interface PdfExportOptions extends SlotRenderers {
  onProgress?: (progress: ExportProgress) => void;
  signal?: AbortSignal;
  /** JPEG quality (default 0.9). */
  quality?: number;
  /** Export this edition of `doc` (localized here; the file name gets "-te"). Default: the doc as given. */
  lang?: string;
  /** Override book.uniformTrim. */
  uniformTrim?: boolean;
  /** Include the book's plates (default true). */
  plates?: boolean;
  /** Override the download (tests). */
  download?: (blob: Blob, fileName: string) => void;
}

/** Cover first, plates and drawn pages in reading order; undrawn / unsigned / withheld ones are reported. */
export const collectPdfTargets = (doc: ComicDoc, urlFor: UrlFor, opts: { plates?: boolean } = {}): { targets: ExportSlot[]; skipped: string[] } => {
  const { slots, skipped } = collectExportSlots(doc, urlFor, opts);
  return { targets: slots, skipped };
};

const round2 = (n: number) => Math.round(n * 100) / 100;

/** PDF page size (points) for an image: trim width, height by the image's aspect (uniform trim off). */
export const pdfPageSize = (imageW: number, imageH: number): { width: number; height: number } => {
  const aspect = imageW > 0 && imageH > 0 ? imageH / imageW : 1.5;
  return { width: COMIC_TRIM_WIDTH_PT, height: round2(COMIC_TRIM_WIDTH_PT * aspect) };
};

/** The book's trim (points): trim width × format.pageAspect. */
export const trimPageSize = (trimAspect: number): { width: number; height: number } => ({
  width: COMIC_TRIM_WIDTH_PT,
  height: round2(COMIC_TRIM_WIDTH_PT / (trimAspect > 0 ? trimAspect : 2 / 3))
});

/** Art placed `contain` and centred on a page (points; PDF origin is bottom-left, symmetric here). */
export const containBox = (imageW: number, imageH: number, page: { width: number; height: number }): { x: number; y: number; width: number; height: number } => {
  if (!(imageW > 0 && imageH > 0)) return { x: 0, y: 0, ...page };
  const scale = Math.min(page.width / imageW, page.height / imageH);
  const width = round2(imageW * scale);
  const height = round2(imageH * scale);
  return { x: round2((page.width - width) / 2), y: round2((page.height - height) / 2), width, height };
};

export async function exportComicPdf(doc: ComicDoc, urlFor: UrlFor, opts: PdfExportOptions = {}): Promise<PdfExportResult> {
  const book = localizedFor(doc, opts.lang);
  const { targets, skipped } = collectPdfTargets(book, urlFor, { plates: opts.plates });
  if (!targets.some((t) => !t.plate)) throw new ExportError('Nothing to export yet — draw at least one page first.');
  checkCancelled(opts.signal);

  const overrides = !!(opts.renderPage || opts.renderImage || opts.renderCover || opts.renderPlate);
  const fonts = overrides ? null : await prepareExportFonts([book]);
  const { PDFDocument, rgb } = await import('@cantoo/pdf-lib');
  const pdf = await PDFDocument.create();
  const title = book.cover.title?.trim() || book.brief.title?.trim() || 'Untitled comic';
  pdf.setTitle(title);
  if (book.brief.logline) pdf.setSubject(book.brief.logline);
  pdf.setCreator('DreamStream Comic Studio');
  pdf.setProducer('DreamStream Comic Studio (@cantoo/pdf-lib)');
  pdf.setLanguage(book.format.language || 'en');

  const uniform = opts.uniformTrim ?? uniformTrimOf(book);
  const trim = trimPageSize(trimAspectOf(book));
  const raster: RasterOptions = {
    signal: opts.signal,
    mime: 'image/jpeg',
    quality: opts.quality ?? 0.9,
    measure: fonts?.measure,
    plateWidth: plateWidthFor(targets)
  };
  const coverUrl = targets.find((t) => t.kind === 'cover')?.url;
  let pages = 0;

  const failed = await forEachReported(
    targets,
    (t) => t.label,
    async (t) => {
      const blob = await renderSlotWith(book, t, raster, { ...opts, coverUrl });
      checkCancelled(opts.signal);
      const bytes = await blobBytes(blob);
      const image = blob.type === 'image/png' ? await pdf.embedPng(bytes) : await pdf.embedJpg(bytes);
      if (uniform) {
        const page = pdf.addPage([trim.width, trim.height]);
        const box = containBox(image.width, image.height, trim);
        if (box.width < trim.width - 0.5 || box.height < trim.height - 0.5) page.drawRectangle({ x: 0, y: 0, width: trim.width, height: trim.height, color: rgb(1, 1, 1) });
        page.drawImage(image, box);
      } else {
        const size = pdfPageSize(image.width, image.height);
        const page = pdf.addPage([size.width, size.height]);
        page.drawImage(image, { x: 0, y: 0, width: size.width, height: size.height });
      }
      pages += 1;
    },
    opts
  );
  if (!pages) throw new ExportError(`Couldn’t export any pages. ${failed[0]?.message || ''}`.trim());

  opts.onProgress?.({ done: targets.length, total: targets.length, label: 'Building PDF…' });
  const data = await pdf.save();
  checkCancelled(opts.signal);
  const lang = opts.lang && !sameLanguage(opts.lang, doc.format?.language || 'en') ? opts.lang : undefined;
  const fileName = `${exportFileStem(book, lang)}.pdf`;
  (opts.download || downloadBlob)(new Blob([data as BlobPart], { type: 'application/pdf' }), fileName);
  opts.onProgress?.({ done: targets.length, total: targets.length, label: 'Done' });
  return { fileName, pages, failed, skipped, ...(fonts?.notice ? { notice: fonts.notice } : {}) };
}
