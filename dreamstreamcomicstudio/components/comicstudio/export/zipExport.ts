// PNG pages ZIP: the cover and every drawn page, flattened with their lettering, zipped
// and downloaded. Pages render one at a time (bounded memory on phones) with progress;
// a page that fails is reported, not silently dropped, and the rest still export.

import type { AssetRef, ComicDoc, Page } from '../../../shared/comic/doc';
import { downloadBlob } from '../../../services/download';
import { ExportError, renderImageToBlob, renderPageToBlob, type RasterOptions } from './rasterize';

export type UrlFor = (asset?: AssetRef | string | null) => string | undefined;

export interface ExportProgress {
  done: number;
  total: number;
  label: string;
}

export interface ZipExportResult {
  fileName: string;
  files: number;
  failed: { label: string; message: string }[];
  skipped: string[];
}

export interface ZipExportOptions {
  onProgress?: (progress: ExportProgress) => void;
  signal?: AbortSignal;
  /** Long edge of each PNG (default: the art's own resolution). */
  longEdge?: number;
  /** Override the download (tests). */
  download?: (blob: Blob, fileName: string) => void;
  /** Override the renderers (tests). */
  renderPage?: (doc: ComicDoc, page: Page, url: string, opts: RasterOptions) => Promise<Blob>;
  renderImage?: (url: string, opts: RasterOptions) => Promise<Blob>;
}

/** File-name stem from the title ("The Saffron Thief!" → "the-saffron-thief"). */
export const exportFileStem = (doc: ComicDoc): string => {
  const slug = (doc.brief.title || '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return slug || 'comic';
};

const pad2 = (n: number) => String(n).padStart(2, '0');

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

const friendly = (err: unknown): string =>
  err instanceof ExportError ? err.message : (err as Error)?.message ? `Something went wrong: ${(err as Error).message}` : 'Something went wrong.';

interface Target {
  label: string;
  fileName: string;
  url: string;
  page?: Page;
}

export async function exportPngZip(doc: ComicDoc, urlFor: UrlFor, opts: ZipExportOptions = {}): Promise<ZipExportResult> {
  const targets: Target[] = [];
  const skipped: string[] = [];
  const coverAsset = doc.cover.render.asset;
  if (coverAsset?.path) {
    const url = urlFor(coverAsset);
    if (url) targets.push({ label: 'Cover', fileName: '00-cover.png', url });
    else skipped.push('Cover (image link not ready yet)');
  }
  [...doc.pages]
    .sort((a, b) => a.n - b.n)
    .forEach((page) => {
      const label = `Page ${page.n}`;
      if (!page.render.asset?.path) {
        skipped.push(`${label} (not drawn yet)`);
        return;
      }
      const url = urlFor(page.render.asset);
      if (!url) skipped.push(`${label} (image link not ready yet)`);
      else targets.push({ label, fileName: `page-${pad2(page.n)}.png`, url, page });
    });
  if (!targets.length) throw new ExportError('Nothing to export yet — draw at least one page first.');

  const renderPage = opts.renderPage || renderPageToBlob;
  const renderImage = opts.renderImage || renderImageToBlob;
  const stem = exportFileStem(doc);
  const { default: JSZip } = await import('jszip');
  const zip = new JSZip();
  const folder = zip.folder(stem) || zip;
  const failed: ZipExportResult['failed'] = [];
  let files = 0;
  const total = targets.length;

  for (let i = 0; i < targets.length; i += 1) {
    if (opts.signal?.aborted) throw new ExportError('Export cancelled.');
    const t = targets[i];
    opts.onProgress?.({ done: i, total, label: `Rendering ${t.label.toLowerCase()} (${i + 1} of ${total})…` });
    try {
      const raster = { longEdge: opts.longEdge, signal: opts.signal };
      const blob = t.page ? await renderPage(doc, t.page, t.url, raster) : await renderImage(t.url, raster);
      folder.file(t.fileName, await blobBytes(blob), { binary: true });
      files += 1;
    } catch (err) {
      if (opts.signal?.aborted) throw new ExportError('Export cancelled.');
      failed.push({ label: t.label, message: friendly(err) });
    }
  }
  if (!files) throw new ExportError(`Couldn’t export any pages. ${failed[0]?.message || ''}`.trim());

  opts.onProgress?.({ done: total, total, label: 'Zipping…' });
  // PNGs are already compressed — store them as-is (fast, same size).
  const data = await zip.generateAsync({ type: 'uint8array', compression: 'STORE' });
  const fileName = `${stem}-pages.zip`;
  const blob = new Blob([data as BlobPart], { type: 'application/zip' });
  (opts.download || downloadBlob)(blob, fileName);
  opts.onProgress?.({ done: total, total, label: 'Done' });
  return { fileName, files, failed, skipped };
}
