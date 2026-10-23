// PNG ZIP: the book in reading order — cover, plates, every drawn page — flattened with its
// lettering, zipped and downloaded. Files are named in slot order (`00-cover.png`, `01-title.png`,
// `02-page-01.png`…), so any file browser lists them as the book reads.
//
// Two shapes:
//   exportPngZip        one language (the doc as given, or the `lang` edition of it);
//   exportLanguagesZip  "All languages": one folder per published language (`te-telugu/…`). Each art
//                       image is fetched ONCE and re-lettered for every language (the art is shared;
//                       only the overlay lettering, the cover title and the plates change).
// Pages render one at a time (bounded memory on phones) with progress; a page that fails is reported,
// not silently dropped, and the rest still export.

import type { ComicDoc } from '../../../shared/comic/doc';
import { languageSpec, sameLanguage } from '../../../shared/comic/languages';
import { downloadBlob } from '../../../services/download';
import { forEachReported, plateWidthFor, renderSlotWith, checkCancelled, type ExportProgress, type FailedSlot, type SlotRenderers } from './batch';
import { CANCELLED, ExportError } from './errors';
import { exportFileStem, languageFolderName } from './filenames';
import { prepareExportFonts } from './fonts';
import { loadExportImage, renderSlotToBlob, type LoadedImage, type RasterOptions } from './rasterize';
import { collectExportSlots, exportLanguages, localizedFor, type ExportSlot, type UrlFor } from './sequence';

export type { UrlFor } from './sequence';
export type { ExportProgress } from './batch';
export { exportFileStem, sanitizeFilename } from './filenames';

export interface ZipExportResult {
  fileName: string;
  files: number;
  failed: { label: string; message: string }[];
  skipped: string[];
  /** Set when a lettering face didn't load (the file may use a fallback face). */
  notice?: string;
  /** Languages in the ZIP (all-languages export). */
  languages?: string[];
}

export interface ZipExportOptions extends SlotRenderers {
  onProgress?: (progress: ExportProgress) => void;
  signal?: AbortSignal;
  /** Long edge of each PNG (default: the art's own resolution). */
  longEdge?: number;
  /** Export this edition of `doc` (localized here; the file name gets "-te"). Default: the doc as given. */
  lang?: string;
  /** Include the book's title / end / back-cover plates (default true). */
  plates?: boolean;
  /** Override the download (tests). */
  download?: (blob: Blob, fileName: string) => void;
}

/** Blob → bytes (FileReader fallback for engines without Blob.arrayBuffer). */
export const blobBytes = async (blob: Blob): Promise<Uint8Array> => {
  if (typeof blob.arrayBuffer === 'function') return new Uint8Array(await blob.arrayBuffer());
  return new Promise<Uint8Array>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(new Uint8Array(reader.result as ArrayBuffer));
    reader.onerror = () => reject(reader.error || new ExportError('Couldn’t read the rendered page.'));
    reader.readAsArrayBuffer(blob);
  });
};

const NOTHING = 'Nothing to export yet — draw at least one page first.';
const hasArt = (slots: readonly ExportSlot[]) => slots.some((s) => !s.plate);
const usesOverrides = (o: SlotRenderers) => !!(o.renderPage || o.renderImage || o.renderCover || o.renderPlate);
/** "-te" only for an edition that isn't the comic's source language. */
const suffixLang = (doc: ComicDoc, lang?: string) => (lang && !sameLanguage(lang, doc.format?.language || 'en') ? lang : undefined);

const zipAndDownload = async (zip: { generateAsync(o: { type: 'uint8array'; compression: 'STORE' }): Promise<Uint8Array> }, fileName: string, opts: ZipExportOptions, total: number) => {
  opts.onProgress?.({ done: total, total, label: 'Zipping…' });
  // PNGs are already compressed — store them as-is (fast, same size).
  const data = await zip.generateAsync({ type: 'uint8array', compression: 'STORE' });
  checkCancelled(opts.signal);
  (opts.download || downloadBlob)(new Blob([data as BlobPart], { type: 'application/zip' }), fileName);
  opts.onProgress?.({ done: total, total, label: 'Done' });
};

export async function exportPngZip(doc: ComicDoc, urlFor: UrlFor, opts: ZipExportOptions = {}): Promise<ZipExportResult> {
  const book = localizedFor(doc, opts.lang);
  const { slots, skipped } = collectExportSlots(book, urlFor, { plates: opts.plates });
  if (!hasArt(slots)) throw new ExportError(NOTHING);
  checkCancelled(opts.signal);

  const fonts = usesOverrides(opts) ? null : await prepareExportFonts([book]);
  const stem = exportFileStem(book, suffixLang(doc, opts.lang));
  const { default: JSZip } = await import('jszip');
  const zip = new JSZip();
  const folder = zip.folder(stem) || zip;
  const raster: RasterOptions = { longEdge: opts.longEdge, signal: opts.signal, measure: fonts?.measure, plateWidth: plateWidthFor(slots, opts.longEdge) };
  const coverUrl = slots.find((s) => s.kind === 'cover')?.url;
  let files = 0;

  const failed = await forEachReported(
    slots,
    (s) => s.label,
    async (slot) => {
      const blob = await renderSlotWith(book, slot, raster, { ...opts, coverUrl });
      checkCancelled(opts.signal);
      folder.file(`${slot.fileBase}.png`, await blobBytes(blob), { binary: true });
      files += 1;
    },
    opts
  );
  if (!files) throw new ExportError(`Couldn’t export any pages. ${failed[0]?.message || ''}`.trim());

  const fileName = `${stem}-pages.zip`;
  await zipAndDownload(zip, fileName, opts, slots.length);
  return { fileName, files, failed, skipped, ...(fonts?.notice ? { notice: fonts.notice } : {}) };
}

export interface LanguagesZipOptions extends Omit<ZipExportOptions, 'lang'> {
  /** Languages to include (default: the published editions in doc.publication, else the source). */
  languages?: readonly string[];
}

/**
 * "All languages (ZIP)": one folder per language, every art image fetched once and re-lettered per
 * language. `doc` must be the SOURCE doc (with its editions), not a localized copy.
 */
export async function exportLanguagesZip(doc: ComicDoc, urlFor: UrlFor, opts: LanguagesZipOptions = {}): Promise<ZipExportResult> {
  const langs = exportLanguages(doc, opts.languages);
  const books = langs.map((lang) => ({ lang, doc: localizedFor(doc, lang), name: languageSpec(lang)?.english ?? lang, folder: languageFolderName(lang) }));
  const { slots, skipped } = collectExportSlots(doc, urlFor, { plates: opts.plates });
  if (!hasArt(slots)) throw new ExportError(NOTHING);
  checkCancelled(opts.signal);

  const overrides = usesOverrides(opts);
  const fonts = overrides ? null : await prepareExportFonts(books.map((b) => b.doc));
  const stem = exportFileStem(doc);
  const { default: JSZip } = await import('jszip');
  const zip = new JSZip();
  const root = zip.folder(stem) || zip;
  const raster: RasterOptions = { longEdge: opts.longEdge, signal: opts.signal, measure: fonts?.measure, plateWidth: plateWidthFor(slots, opts.longEdge) };
  const coverSlot = slots.find((s) => s.kind === 'cover');
  const coverUrl = coverSlot?.url;
  const multi = books.length > 1;
  // The back cover's vignette (the cover art) is fetched once for every language too.
  let coverArt: LoadedImage | null = null;
  if (!overrides && coverUrl && slots.some((s) => s.plate === 'back_cover')) coverArt = await loadExportImage(coverUrl, opts.signal).catch(() => null);
  let files = 0;
  const failed: FailedSlot[] = [];
  const total = slots.length * books.length;
  let done = 0;

  try {
    for (const slot of slots) {
      checkCancelled(opts.signal);
      // The art is the same in every language: fetch it once.
      let image: LoadedImage | null = null;
      if (!overrides && slot.url && !slot.plate) {
        try {
          image = await loadExportImage(slot.url, opts.signal);
        } catch (err) {
          checkCancelled(opts.signal);
          const message = err instanceof ExportError ? err.message : 'The image couldn’t be loaded.';
          for (const b of books) failed.push({ label: multi ? `${slot.label} · ${b.name}` : slot.label, message });
          done += books.length;
          continue;
        }
      }
      try {
        const results = await forEachReported(
          books,
          (b) => (multi ? `${slot.label} · ${b.name}` : slot.label),
          async (b) => {
            const blob = overrides
              ? await renderSlotWith(b.doc, slot, raster, { ...opts, coverUrl })
              : await renderSlotToBlob(b.doc, slot, { ...raster, ...(image ? { image } : {}), coverUrl, ...(coverArt ? { coverArt } : {}) });
            checkCancelled(opts.signal);
            (root.folder(b.folder) || root).file(`${slot.fileBase}.png`, await blobBytes(blob), { binary: true });
            files += 1;
          },
          {
            signal: opts.signal,
            onProgress: (p) => opts.onProgress?.({ done: done + p.done, total, label: p.label.replace(/\(\d+ of \d+\)/, `(${done + p.done + 1} of ${total})`) })
          }
        );
        failed.push(...results);
      } finally {
        image?.release();
      }
      done += books.length;
    }
  } finally {
    coverArt?.release();
  }
  if (opts.signal?.aborted) throw new ExportError(CANCELLED);
  if (!files) throw new ExportError(`Couldn’t export any pages. ${failed[0]?.message || ''}`.trim());

  const fileName = `${stem}-${multi ? 'all-languages' : 'pages'}.zip`;
  await zipAndDownload(zip, fileName, opts, total);
  return { fileName, files, failed, skipped, languages: langs, ...(fonts?.notice ? { notice: fonts.notice } : {}) };
}
