// Reader downloads from a share link (requirements-addendum "Share links — READ-ONLY + downloadable").
//
// A share-link reader may download the lettered comic — PDF, page images, any published language —
// when the author allows it (`allowDownload`, default true). Everything happens in the reader's
// browser from the PUBLIC, already-sanitized snapshot; nothing here can reach a private object or
// change anything:
//   - only `pub/<22-char key>/…` objects are ever fetched (never a `u/<user>/…` draft, history or
//     reference path, even if one somehow appeared in the payload), only through the URL the edge
//     returned for that exact path, only over https, and never with credentials;
//   - withheld (safety-blocked) images are skipped and reported, never drawn;
//   - only the published languages can be exported;
//   - the author's "no downloads" choice is enforced here too, not just by hiding a button.
// The only network calls are GETs of those public images (and font files); no API is called.

import type { AssetRef } from '../../../shared/comic/doc';
import { canServeToOwner } from '../../../shared/comic/safety';
import { ExportError } from './errors';
import { exportComicPdf, type PdfExportOptions, type PdfExportResult } from './pdfExport';
import { publicDownloadsAllowed, publicExportLanguage, publicExportLanguages, type PublicDownloadSource } from './publicLanguages';
import { exportLanguagesZip, exportPngZip, type ZipExportOptions, type ZipExportResult } from './zipExport';
import type { UrlFor } from './sequence';

export { publicDownloadsAllowed, publicExportLanguage, publicExportLanguages, type PublicDownloadSource } from './publicLanguages';

/** A published object path: `pub/<22-char base62 key>/<file>` (contract §9.3 PublicAsset). */
export const PUBLIC_ASSET_PATH_RE = /^pub\/[A-Za-z0-9]{22}\/[A-Za-z0-9][A-Za-z0-9._-]{0,200}$/;

export const DOWNLOADS_OFF = 'The author turned off downloads for this comic.';

const LOCAL_HOST = /^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?\//i;

/**
 * URL resolver for downloads from a public payload: the edge's URL for a `pub/` path, https only
 * (plain http only for a local dev server), never for a withheld asset. Anything else → undefined,
 * which the export reports as "image link not ready yet" instead of fetching it.
 */
export function publicExportUrlFor(urls: Readonly<Record<string, string>> | null | undefined): UrlFor {
  return (asset?: AssetRef | string | null) => {
    if (!asset || !urls) return undefined;
    const path = typeof asset === 'string' ? asset : asset.path;
    if (typeof path !== 'string' || !PUBLIC_ASSET_PATH_RE.test(path) || path.includes('..')) return undefined;
    if (typeof asset === 'object' && !canServeToOwner(asset)) return undefined;
    if (!Object.prototype.hasOwnProperty.call(urls, path)) return undefined;
    const url = urls[path];
    if (typeof url !== 'string') return undefined;
    if (/^https:\/\//i.test(url) || LOCAL_HOST.test(url)) return url;
    return undefined;
  };
}

export type PublicDownloadKind = 'pdf' | 'zip' | 'zip_all';

export interface PublicDownloadOptions extends Pick<PdfExportOptions, 'onProgress' | 'signal' | 'download'>, Pick<ZipExportOptions, 'longEdge' | 'memoryBudget'> {
  /** The reader's language (must be published; falls back to the publication default, then the source). */
  lang?: string;
}

export const NO_PUBLISHED_LANGUAGE = 'This comic has no published language to download yet.';

/**
 * Download a published comic for a share-link reader: the PDF or the page images of the reader's
 * language, or every published language as one ZIP. Throws DOWNLOADS_OFF when the author said no.
 */
export async function downloadPublicComic(src: PublicDownloadSource, kind: 'pdf', opts?: PublicDownloadOptions): Promise<PdfExportResult>;
export async function downloadPublicComic(src: PublicDownloadSource, kind: 'zip' | 'zip_all', opts?: PublicDownloadOptions): Promise<ZipExportResult>;
export async function downloadPublicComic(src: PublicDownloadSource, kind: PublicDownloadKind, opts: PublicDownloadOptions = {}): Promise<PdfExportResult | ZipExportResult> {
  if (!publicDownloadsAllowed(src.publication)) throw new ExportError(DOWNLOADS_OFF, 'downloads_off');
  const urlFor = publicExportUrlFor(src.urls);
  const lang = publicExportLanguage(src, opts.lang);
  if (!lang) throw new ExportError(NO_PUBLISHED_LANGUAGE, 'no_language');
  const common = { onProgress: opts.onProgress, signal: opts.signal, download: opts.download };
  if (kind === 'pdf') return exportComicPdf(src.doc, urlFor, { ...common, lang });
  if (kind === 'zip') return exportPngZip(src.doc, urlFor, { ...common, lang, longEdge: opts.longEdge, memoryBudget: opts.memoryBudget });
  return exportLanguagesZip(src.doc, urlFor, { ...common, languages: publicExportLanguages(src), longEdge: opts.longEdge, memoryBudget: opts.memoryBudget });
}
