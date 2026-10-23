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
// not silently dropped, and the rest still export. The finished PNGs stay Blobs (browser blob storage,
// not the page's JS heap) and the archive is written in Blob slices (zipToBlob). The whole archive
// still has to exist before it is saved, so a memory guard (zipMemory.ts) sizes the export to the
// device BEFORE any work: full size when it fits, smaller images with an honest `notice` when not, or
// a clear refusal ('too_big': "download one language at a time" / "use the PDF") — never a crashed tab.

import type { ComicDoc } from '../../../shared/comic/doc';
import { languageSpec, sameLanguage } from '../../../shared/comic/languages';
import { downloadBlob } from '../../../services/download';
import { forEachReported, plateWidthFor, renderSlotWith, checkCancelled, type ExportProgress, type FailedSlot, type SlotRenderers } from './batch';
import { CANCELLED, ExportError } from './errors';
import { exportFileStem, languageFolderName } from './filenames';
import { prepareExportFonts } from './fonts';
import { loadExportImage, renderSlotToBlob, type LoadedImage, type RasterOptions } from './rasterize';
import { collectExportSlots, exportLanguages, localizedFor, type ExportSlot, type UrlFor } from './sequence';
import { planZipMemory, zipReducedNotice, zipTooBigMessage, type ZipMemoryPlan } from './zipMemory';

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
  /** Set when the memory guard drew the images smaller than full size: their long-edge cap (px). */
  maxEdge?: number;
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
  /** PNG bytes this export may hold at once (default: zipMemoryBudget() for this device). */
  memoryBudget?: number;
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

/** Size the ZIP to the device before any work: throws 'too_big' when it can't fit even smaller. */
const guardMemory = (slots: readonly ExportSlot[], languages: number, opts: ZipExportOptions, plateWidth: number): { plan: ZipMemoryPlan; oneFits: boolean } => {
  const plan = planZipMemory(slots, languages, { longEdge: opts.longEdge, plateWidth, budget: opts.memoryBudget });
  if (!plan.fits) throw new ExportError(zipTooBigMessage(plan, { languages, pages: slots.length }), 'too_big');
  const oneFits = languages > 1 && !!plan.maxEdge && !planZipMemory(slots, 1, { longEdge: opts.longEdge, plateWidth, budget: plan.budget }).maxEdge;
  return { plan, oneFits };
};

const joinNotices = (...notes: (string | undefined)[]): string | undefined => {
  const out = notes.filter((n): n is string => !!n);
  return out.length ? out.join(' ') : undefined;
};

/** The written archive is moved into blob storage in slices of this size (the JS heap never holds it). */
const BLOB_SLICE_BYTES = 8 * 1024 * 1024;

/** The bits of JSZip this module drives (typed loosely so tests can pass a stand-in). */
interface ZipStreamSource {
  generateInternalStream(o: { type: 'uint8array'; compression: 'STORE' }): {
    on(event: 'data', cb: (chunk: Uint8Array) => void): unknown;
    on(event: 'error', cb: (err: Error) => void): unknown;
    on(event: 'end', cb: () => void): unknown;
    resume(): unknown;
    pause(): unknown;
  };
}

/**
 * Write the archive straight into Blob slices: JSZip reads each PNG Blob when it gets to it, and every
 * 8 MB of output becomes a Blob part, so the page's JS heap holds about one image at a time instead of
 * every PNG twice (the old Uint8Array input + output buffer). Cancelling stops the writer.
 */
export const zipToBlob = (zip: ZipStreamSource, signal?: AbortSignal): Promise<Blob> =>
  new Promise<Blob>((resolve, reject) => {
    const parts: Blob[] = [];
    let pending: Uint8Array[] = [];
    let pendingBytes = 0;
    let settled = false;
    const flush = () => {
      if (!pending.length) return;
      parts.push(new Blob(pending as BlobPart[]));
      pending = [];
      pendingBytes = 0;
    };
    const stream = zip.generateInternalStream({ type: 'uint8array', compression: 'STORE' });
    const onAbort = () => {
      if (settled) return;
      settled = true;
      stream.pause();
      pending = [];
      reject(new ExportError(CANCELLED));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    stream.on('data', (chunk: Uint8Array) => {
      if (settled) return;
      pending.push(chunk);
      pendingBytes += chunk.byteLength;
      if (pendingBytes >= BLOB_SLICE_BYTES) flush();
    });
    stream.on('error', (err: Error) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', onAbort);
      reject(err instanceof ExportError ? err : new ExportError('Couldn’t write the ZIP file. Try again, or download fewer pages at a time.'));
    });
    stream.on('end', () => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', onAbort);
      flush();
      resolve(new Blob(parts, { type: 'application/zip' }));
    });
    if (signal?.aborted) onAbort();
    else stream.resume();
  });

const zipAndDownload = async (zip: ZipStreamSource, fileName: string, opts: ZipExportOptions, total: number) => {
  opts.onProgress?.({ done: total, total, label: 'Zipping…' });
  // PNGs are already compressed — store them as-is (fast, same size).
  const blob = await zipToBlob(zip, opts.signal);
  checkCancelled(opts.signal);
  (opts.download || downloadBlob)(blob, fileName);
  opts.onProgress?.({ done: total, total, label: 'Done' });
};

export async function exportPngZip(doc: ComicDoc, urlFor: UrlFor, opts: ZipExportOptions = {}): Promise<ZipExportResult> {
  const book = localizedFor(doc, opts.lang);
  const { slots, skipped } = collectExportSlots(book, urlFor, { plates: opts.plates });
  if (!hasArt(slots)) throw new ExportError(NOTHING);
  checkCancelled(opts.signal);
  const plateWidth = plateWidthFor(slots, opts.longEdge);
  const memory = guardMemory(slots, 1, opts, plateWidth).plan;

  const fonts = usesOverrides(opts) ? null : await prepareExportFonts([book]);
  const stem = exportFileStem(book, suffixLang(doc, opts.lang));
  const { default: JSZip } = await import('jszip');
  const zip = new JSZip();
  const folder = zip.folder(stem) || zip;
  const raster: RasterOptions = { longEdge: opts.longEdge, signal: opts.signal, measure: fonts?.measure, plateWidth, ...(memory.maxEdge ? { maxEdge: memory.maxEdge } : {}) };
  const coverUrl = slots.find((s) => s.kind === 'cover')?.url;
  let files = 0;

  const failed = await forEachReported(
    slots,
    (s) => s.label,
    async (slot) => {
      const blob = await renderSlotWith(book, slot, raster, { ...opts, coverUrl });
      checkCancelled(opts.signal);
      folder.file(`${slot.fileBase}.png`, blob, { binary: true });
      files += 1;
    },
    opts
  );
  if (!files) throw new ExportError(`Couldn’t export any pages. ${failed[0]?.message || ''}`.trim());

  const fileName = `${stem}-pages.zip`;
  await zipAndDownload(zip, fileName, opts, slots.length);
  const notice = joinNotices(zipReducedNotice(memory, { languages: 1 }), fonts?.notice);
  return { fileName, files, failed, skipped, ...(notice ? { notice } : {}), ...(memory.maxEdge ? { maxEdge: memory.maxEdge } : {}) };
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
  const plateWidth = plateWidthFor(slots, opts.longEdge);
  // Every language holds its own lettered copy of every image: size the whole archive up front.
  const { plan: memory, oneFits } = guardMemory(slots, books.length, opts, plateWidth);

  const overrides = usesOverrides(opts);
  const fonts = overrides ? null : await prepareExportFonts(books.map((b) => b.doc));
  const stem = exportFileStem(doc);
  const { default: JSZip } = await import('jszip');
  const zip = new JSZip();
  const root = zip.folder(stem) || zip;
  const raster: RasterOptions = { longEdge: opts.longEdge, signal: opts.signal, measure: fonts?.measure, plateWidth, ...(memory.maxEdge ? { maxEdge: memory.maxEdge } : {}) };
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
            (root.folder(b.folder) || root).file(`${slot.fileBase}.png`, blob, { binary: true });
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
  const notice = joinNotices(zipReducedNotice(memory, { languages: books.length, oneLanguageFits: oneFits }), fonts?.notice);
  return { fileName, files, failed, skipped, languages: langs, ...(notice ? { notice } : {}), ...(memory.maxEdge ? { maxEdge: memory.maxEdge } : {}) };
}
