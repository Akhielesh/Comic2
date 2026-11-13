import type { AssetRef, ComicDoc, Page } from '../../../shared/comic/doc';
import { sameLanguage } from '../../../shared/comic/languages';
import { pageComposes } from '../../../shared/comic/panelize/compose';
import { downloadBlob } from '../../../services/download';
import { CANCELLED, ExportError } from './errors';
import { exportFileStem } from './filenames';
import { prepareExportFonts } from './fonts';
import { loadExportImage, pathUrlFor, renderSlotToBlob } from './rasterize';
import { collectExportSlots, localizedFor, trimAspectOf } from './sequence';
import type { ExportProgress, UrlFor } from './zipExport';

export const GIF_MAX_PAGES = 12;
const MAX_EDGE = 540;

interface GifOptions {
  lang?: string;
  signal?: AbortSignal;
  onProgress?: (progress: ExportProgress) => void;
  download?: (blob: Blob, name: string) => void;
}

interface WorkerReply {
  error?: string;
  blob?: Blob;
}

/** Use a signed preview on a flat page, preserving full-resolution sources for crop compositions. */
export function gifPageUrl(page: Page, asset: AssetRef, urlFor: UrlFor): string | undefined {
  if (pageComposes(page)) return urlFor(asset);
  const aspect = asset.w && asset.h ? asset.w / asset.h : 1;
  const dpr = Math.min(2, Math.max(1, globalThis.devicePixelRatio || 1));
  return urlFor(asset, { width: MAX_EDGE * Math.min(1, aspect) / dpr });
}

export async function exportComicGif(doc: ComicDoc, urlFor: UrlFor, opts: GifOptions = {}) {
  const book = localizedFor(doc, opts.lang);
  const { slots: drawnPages, skipped } = collectExportSlots(book, urlFor, {
    finishedPagesOnly: true,
    pageUrlFor: (page, asset) => gifPageUrl(page, asset, urlFor)
  });
  const pages = drawnPages.slice(0, GIF_MAX_PAGES);
  if (pages.length < 2) throw new ExportError('Draw at least two pages to make a GIF.');
  if (drawnPages.length > pages.length) skipped.push(`The GIF preview includes the first ${GIF_MAX_PAGES} available pages`);
  if (opts.signal?.aborted) throw new ExportError(CANCELLED);

  const aspect = trimAspectOf(book);
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(MAX_EDGE * Math.min(1, aspect)));
  canvas.height = Math.max(1, Math.round(MAX_EDGE * Math.min(1, 1 / aspect)));
  const ctx = canvas.getContext('2d', { alpha: false, willReadFrequently: true });
  if (!ctx || typeof Worker === 'undefined') throw new ExportError('GIF export is unavailable in this browser.');

  const fonts = await prepareExportFonts([book]);
  if (opts.signal?.aborted) throw new ExportError(CANCELLED);
  let worker: Worker | undefined;
  const exchange = (request: { pixels: ImageData } | { finish: true }): Promise<WorkerReply> =>
    new Promise((resolve, reject) => {
      if (opts.signal?.aborted) return reject(new ExportError(CANCELLED));
      // Start after rasterizing the first frame, so we can catch an encoder startup error.
      const encoder = worker ??= new Worker(new URL('./gifExport.worker.ts', import.meta.url), { type: 'module' });
      const close = () => {
        opts.signal?.removeEventListener('abort', cancel);
        encoder.onmessage = null;
        encoder.onerror = null;
        encoder.onmessageerror = null;
      };
      const cancel = () => {
        close();
        reject(new ExportError(CANCELLED));
      };
      opts.signal?.addEventListener('abort', cancel, { once: true });
      encoder.onmessage = ({ data }: MessageEvent<WorkerReply>) => {
        close();
        if (data.error) reject(new ExportError(data.error));
        else resolve(data);
      };
      encoder.onerror = () => {
        close();
        reject(new ExportError('The GIF encoder could not start. Reload and try again.'));
      };
      encoder.onmessageerror = () => {
        close();
        reject(new ExportError('The browser couldn’t read the GIF encoder’s response.'));
      };
      try {
        encoder.postMessage(request, 'pixels' in request ? [request.pixels.data.buffer] : []);
      } catch (error) {
        close();
        reject(error);
      }
    });

  let frames = 0;
  try {
    for (const [index, slot] of pages.entries()) {
      if (opts.signal?.aborted) throw new ExportError(CANCELLED);
      opts.onProgress?.({ done: index, total: pages.length, label: `Preparing ${slot.label}…` });
      let pixels: ImageData;
      try {
        const raster = await renderSlotToBlob(book, slot, {
          longEdge: MAX_EDGE, signal: opts.signal, measure: fonts.measure, urlForPath: pathUrlFor(urlFor)
        });
        const url = URL.createObjectURL(raster);
        try {
          const image = await loadExportImage(url, opts.signal);
          try {
            const scale = Math.min(canvas.width / image.width, canvas.height / image.height);
            const width = image.width * scale;
            const height = image.height * scale;
            ctx.fillStyle = '#fff';
            ctx.fillRect(0, 0, canvas.width, canvas.height);
            ctx.drawImage(image.source, (canvas.width - width) / 2, (canvas.height - height) / 2, width, height);
            pixels = ctx.getImageData(0, 0, canvas.width, canvas.height);
          } finally {
            image.release();
          }
        } finally {
          URL.revokeObjectURL(url);
        }
      } catch {
        if (opts.signal?.aborted) throw new ExportError(CANCELLED);
        skipped.push(`${slot.label} (could not be drawn)`);
        continue;
      }
      await exchange({ pixels });
      frames++;
    }
    if (frames < 2) throw new ExportError(`Fewer than two pages could be loaded. ${skipped.join('; ')}`);
    const { blob } = await exchange({ finish: true });
    if (opts.signal?.aborted) throw new ExportError(CANCELLED);
    if (!blob?.size) throw new ExportError('The GIF came out empty. Try again.');
    const language = opts.lang && !sameLanguage(opts.lang, doc.format.language) ? opts.lang : undefined;
    const fileName = `${exportFileStem(book, language)}-preview.gif`;
    (opts.download || downloadBlob)(blob, fileName);
    opts.onProgress?.({ done: pages.length, total: pages.length, label: 'Done' });
    return { fileName, frames, skipped, notice: fonts.notice };
  } finally {
    worker?.terminate();
  }
}
