// Word and PowerPoint files in the browser (platform plan §12 W1.7): the one door to packages/platform-render.
//
// The renderers (docx, the vendored PptxGenJS, unified/remark) are big and used only when someone exports, so this
// file never imports them statically: `loadPlatformRender()` pulls them in with one `import()` the first time a file
// is made, Vite splits them into their own lazy chunk, and the entry chunk never contains them
// (tests/config/platformChunks.test.ts, W1.8, checks the built entry). Callers (the comic pitch deck, the chat
// document and deck cards) import only this module.
//
// Every failure comes back as an `ExportError` whose message is written for the person exporting, like every other
// export in the app (components/comicstudio/export/errors.ts): a renderer refusal (`RenderError`), a chunk that would
// not load, a file over the caller's size cap, a cancel. `PlatformExportError` keeps the renderer's code and, for a
// deck, the overlapping pairs, so a caller can point at them.
//
// Nothing here fetches: images reach the renderers as `data:` images, and a host asset id goes through the caller's
// own `resolveAsset`. WebP images are re-encoded as PNG on a canvas (`browserTranscoder`), because DOCX and PPTX
// readers do not all take WebP.

import type { DeckSpec } from '../packages/platform-core/src/contract/deck';
import type { RichDoc } from '../packages/platform-core/src/contract/richdoc';
import type * as PlatformRender from '../packages/platform-render/src/index';
import type { DocxRenderOptions, ImageTranscoder, MarkdownOptions, PptxRenderOptions, RenderErrorCode, SlideOverlap } from '../packages/platform-render/src/index';
import { CANCELLED, ExportError } from '../components/comicstudio/export/errors';
import { sanitizeFilename } from '../components/comicstudio/export/filenames';
import { downloadBlob } from './download';

export type PlatformRenderModule = typeof PlatformRender;

export const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
export const PPTX_MIME = 'application/vnd.openxmlformats-officedocument.presentationml.presentation';

/** An `ExportError` from a platform export, with the renderer's reason when there was one. */
export class PlatformExportError extends ExportError {
  /** The renderer's code (`blocked`, `overlap`, …); absent for a load failure, a cap or a cancel. */
  readonly renderCode?: RenderErrorCode;
  /** For `overlap`: every overlapping pair, so the caller can point at them. */
  readonly overlaps?: SlideOverlap[];

  constructor(message: string, opts: { code?: ConstructorParameters<typeof ExportError>[1]; renderCode?: RenderErrorCode; overlaps?: SlideOverlap[] } = {}) {
    super(message, opts.code);
    this.name = 'ExportError';
    if (opts.renderCode) this.renderCode = opts.renderCode;
    if (opts.overlaps) this.overlaps = opts.overlaps;
  }
}

// ── Loading ────────────────────────────────────────────────────────────────────────────────────────────────────

let loading: Promise<PlatformRenderModule> | null = null;

/** The renderers, loaded once on first use (a failed load is retried on the next call). */
export const loadPlatformRender = (): Promise<PlatformRenderModule> => {
  if (!loading) {
    loading = import('../packages/platform-render/src/index').catch((err: unknown) => {
      loading = null;
      throw err;
    });
  }
  return loading;
};

/** True once the renderer chunk has been requested (tests and diagnostics). */
export const platformRenderRequested = (): boolean => loading !== null;

// ── Errors ─────────────────────────────────────────────────────────────────────────────────────────────────────

export type PlatformFileKind = 'docx' | 'pptx';

const WHAT: Record<PlatformFileKind, string> = { docx: 'Word file', pptx: 'PowerPoint file' };

const isRenderErrorLike = (err: unknown): err is { name: 'RenderError'; code: RenderErrorCode; message: string; overlaps?: SlideOverlap[] } =>
  typeof err === 'object' && err !== null && (err as { name?: unknown }).name === 'RenderError' && typeof (err as { code?: unknown }).code === 'string';

/** A failed dynamic import (offline, a deploy replaced the chunk) as browsers and bundlers report it. */
const isChunkLoadError = (err: unknown): boolean => {
  const e = err as { name?: unknown; message?: unknown } | null;
  const msg = e && typeof e.message === 'string' ? e.message : '';
  return (
    (e && e.name === 'ChunkLoadError') ||
    /dynamically imported module|Importing a module script failed|Failed to fetch|error loading dynamically imported|Unable to preload CSS/i.test(msg)
  );
};

/** Any failure of a platform export as the `ExportError` the app shows. */
export const toExportError = (err: unknown, kind: PlatformFileKind): ExportError => {
  if (err instanceof ExportError) return err;
  const what = WHAT[kind];
  if (isRenderErrorLike(err)) {
    const base = { renderCode: err.code };
    switch (err.code) {
      case 'overlap':
        return new PlatformExportError(err.message || 'Some things on a slide overlap. Move them apart, then export again.', { ...base, overlaps: err.overlaps });
      case 'blocked':
        return new PlatformExportError(`This ${what} can't include one of its images: only pictures already saved in your library can go into a download.`, base);
      case 'asset-missing':
        return new PlatformExportError(`One of the images in this ${what} couldn't be found. Try again, or remove that image.`, base);
      case 'unsupported':
        return new PlatformExportError(`One of the images is in a format that can't go into a ${what}. Try again in another browser, or replace that image.`, base);
      case 'too-large':
        return new PlatformExportError(`This is too big for a ${what}. ${err.message}`.trim(), { ...base, code: 'too_big' });
      case 'invalid':
      default:
        return new PlatformExportError(`This couldn't be turned into a ${what}. Try again; if it keeps happening, tell us.`, base);
    }
  }
  if (isChunkLoadError(err)) return new PlatformExportError(`Couldn't load the ${what} maker. Check your connection and try again.`);
  return new PlatformExportError(`Something went wrong making the ${what}. Try again.`);
};

// ── Images ─────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * WebP → PNG on a canvas, in the browser. Undefined where the browser has no `createImageBitmap` (the renderers then
 * refuse WebP images with a clear message instead of writing a file some readers cannot open).
 */
export const browserTranscoder = (): ImageTranscoder | undefined => {
  if (typeof createImageBitmap !== 'function' || typeof Blob === 'undefined') return undefined;
  return async ({ bytes, mime }) => {
    const bitmap = await createImageBitmap(new Blob([bytes as BlobPart], { type: mime }));
    try {
      let blob: Blob | null;
      if (typeof OffscreenCanvas !== 'undefined') {
        const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
        const ctx = canvas.getContext('2d');
        if (!ctx) throw new Error('no 2d canvas');
        ctx.drawImage(bitmap, 0, 0);
        blob = await canvas.convertToBlob({ type: 'image/png' });
      } else {
        const canvas = document.createElement('canvas');
        canvas.width = bitmap.width;
        canvas.height = bitmap.height;
        const ctx = canvas.getContext('2d');
        if (!ctx) throw new Error('no 2d canvas');
        ctx.drawImage(bitmap, 0, 0);
        blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
      }
      if (!blob) throw new Error('the image could not be re-encoded');
      return { bytes: new Uint8Array(await blob.arrayBuffer()), mime: 'image/png' as const };
    } finally {
      bitmap.close();
    }
  };
};

// ── Exports ────────────────────────────────────────────────────────────────────────────────────────────────────

/** A made file, ready to download or attach. */
export interface PlatformFile {
  blob: Blob;
  fileName: string;
  mime: string;
  /** Size in bytes. */
  size: number;
}

interface CommonExportOptions {
  /** The download name without extension; default the document's title. Sanitized either way. */
  fileName?: string;
  /** Refuse a file bigger than this many bytes (`ExportError` with code `too_big`). */
  maxBytes?: number;
  signal?: AbortSignal;
  /** The renderers (tests); default the lazy chunk. */
  load?: () => Promise<PlatformRenderModule>;
}

export type PlatformDocxExportOptions = DocxRenderOptions & CommonExportOptions;
export type PlatformPptxExportOptions = PptxRenderOptions & CommonExportOptions;
export type PlatformMarkdownDocxExportOptions = PlatformDocxExportOptions & { markdown?: MarkdownOptions };

const checkCancelled = (signal: AbortSignal | undefined): void => {
  if (signal && signal.aborted) throw new ExportError(CANCELLED);
};

const fileOf = (bytes: Uint8Array, stem: string, kind: PlatformFileKind, maxBytes: number | undefined): PlatformFile => {
  if (typeof maxBytes === 'number' && bytes.length > maxBytes) {
    const mb = (n: number): string => `${Math.round(n / 100000) / 10} MB`;
    throw new PlatformExportError(`This ${WHAT[kind]} would be ${mb(bytes.length)}, over the ${mb(maxBytes)} limit. Try fewer pages or smaller pictures.`, { code: 'too_big' });
  }
  const mime = kind === 'docx' ? DOCX_MIME : PPTX_MIME;
  return { blob: new Blob([bytes as BlobPart], { type: mime }), fileName: `${sanitizeFilename(stem, { fallback: kind === 'docx' ? 'document' : 'deck' })}.${kind}`, mime, size: bytes.length };
};

const renderOpts = <T extends CommonExportOptions>(opts: T): Omit<T, keyof CommonExportOptions> => {
  const { fileName: _f, maxBytes: _m, signal: _s, load: _l, ...rest } = opts;
  return rest;
};

const run = async <T>(kind: PlatformFileKind, signal: AbortSignal | undefined, work: () => Promise<T>): Promise<T> => {
  try {
    checkCancelled(signal);
    const out = await work();
    checkCancelled(signal);
    return out;
  } catch (err) {
    throw toExportError(err, kind);
  }
};

/** A RichDoc as a Word file. Never fetches; throws `ExportError` (see `toExportError`). */
export const exportDocx = (doc: RichDoc, opts: PlatformDocxExportOptions = {}): Promise<PlatformFile> =>
  run('docx', opts.signal, async () => {
    const mod = await (opts.load || loadPlatformRender)();
    checkCancelled(opts.signal);
    const bytes = await mod.renderDocx(doc, { transcode: browserTranscoder(), ...renderOpts(opts) });
    return fileOf(bytes, opts.fileName || doc.title, 'docx', opts.maxBytes);
  });

/** A DeckSpec as a PowerPoint file; refused while content elements overlap. Throws `ExportError`. */
export const exportPptx = (deck: DeckSpec, opts: PlatformPptxExportOptions = {}): Promise<PlatformFile> =>
  run('pptx', opts.signal, async () => {
    const mod = await (opts.load || loadPlatformRender)();
    checkCancelled(opts.signal);
    const bytes = await mod.renderPptx(deck, { transcode: browserTranscoder(), ...renderOpts(opts) });
    return fileOf(bytes, opts.fileName || deck.title, 'pptx', opts.maxBytes);
  });

/** Markdown (a chat document) as a Word file: raw HTML and unsafe links dropped on the way. Throws `ExportError`. */
export const exportMarkdownDocx = (markdown: string, opts: PlatformMarkdownDocxExportOptions = {}): Promise<PlatformFile> =>
  run('docx', opts.signal, async () => {
    const mod = await (opts.load || loadPlatformRender)();
    checkCancelled(opts.signal);
    const { markdown: mdOpts, ...rest } = opts;
    const doc = mod.richdocFromMarkdown(markdown, { ...(opts.fileName ? { title: opts.fileName } : {}), ...mdOpts });
    const bytes = await mod.renderDocx(doc, { transcode: browserTranscoder(), ...renderOpts(rest) });
    return fileOf(bytes, opts.fileName || doc.title, 'docx', opts.maxBytes);
  });

/** Saves a made file through the app's one download helper. */
export const downloadPlatformFile = (file: PlatformFile, download: (blob: Blob, fileName: string) => void = downloadBlob): void => {
  download(file.blob, file.fileName);
};
