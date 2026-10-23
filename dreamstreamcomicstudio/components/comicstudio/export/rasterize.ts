// Raster export: one book slot — a page's art with its overlay lettering, the cover with its overlay
// title, or a software plate — flattened onto a canvas and encoded (PNG, or JPEG for PDFs).
//
// Lettering is drawn from the shared engine's LetterPlans (`planLettering`) through the canvas
// renderer in canvasDraw.ts, which draws the very node tree the board's SVG draws — same wrap, same
// outlines, same draw order — after the exact faces have loaded (fonts.ts). Images are fetched with
// CORS and no credentials (signed or public URLs allow it) so the canvas stays exportable; a
// cache-busted <img crossOrigin> load is the fallback.

import type { ComicDoc, LineKind, Page } from '../../../shared/comic/doc';
import { letteringAspect, planLettering, type Measure } from '../../../shared/comic/lettering/layout';
import { fontString, resolveLetteringFont } from '../../../shared/comic/lettering/fonts';
import { dirOf } from '../../../shared/comic/languages';
import { plateLayout, type PlateKind } from '../timeline/plates';
import { drawLetteringOnPage, drawSvgNodes, type LayerFactory, type PathFactory } from './canvasDraw';
import { coverTitleNodes } from './coverTitle';
import { CANCELLED, ExportError } from './errors';
import { prepareExportFonts, type ExportFonts } from './fonts';
import { drawPlate, type PlateArtImage } from './plateDraw';
import type { ExportSlot } from './sequence';

export { ExportError } from './errors';

/** Largest edge we will draw (canvas memory limits on mobile browsers). */
export const MAX_EXPORT_EDGE = 4096;
/** Default width of a software plate when no page sets the book's resolution. */
export const DEFAULT_PLATE_WIDTH = 1600;

export interface RasterOptions {
  /** Scale so the longest edge is this many px (default: the image's own size, capped). */
  longEdge?: number;
  signal?: AbortSignal;
  /** Output encoding (default PNG). JPEG keeps multi-page PDFs small. */
  mime?: 'image/png' | 'image/jpeg';
  /** JPEG quality 0–1 (default 0.9). */
  quality?: number;
  /** Measure prepared after the fonts loaded (batch exports prepare once; otherwise prepared here). */
  measure?: Measure;
  /** Width in px of a software plate (default: DEFAULT_PLATE_WIDTH). */
  plateWidth?: number;
  /** Tests / special canvases. */
  makePath?: PathFactory;
  createLayer?: LayerFactory;
}

/** Output canvas size for an image (keeps aspect; never above MAX_EXPORT_EDGE). */
export const rasterSize = (naturalW: number, naturalH: number, longEdge?: number): { width: number; height: number } => {
  const w = Math.max(1, naturalW || 1);
  const h = Math.max(1, naturalH || 1);
  const long = Math.max(w, h);
  const target = Math.min(MAX_EXPORT_EDGE, longEdge && longEdge > 0 ? longEdge : long);
  const scale = target / long;
  return { width: Math.max(1, Math.round(w * scale)), height: Math.max(1, Math.round(h * scale)) };
};

/**
 * Canvas font shorthand for a line kind in a language — the face the lettering engine resolves for
 * the classic style (Comic Neue dialogue, Bangers SFX; the script's Noto face for Telugu, Hindi…).
 */
export const fontFor = (kind: LineKind, fontPx: number, lang = 'en'): string => {
  const r = resolveLetteringFont(kind === 'sfx' ? 'bangers' : 'comic-neue', kind, lang, { weight: kind === 'sfx' ? 400 : 700, italic: kind === 'whisper' });
  return fontString(r.fontId, fontPx, r.weight, r.italic);
};

/** Load the faces these docs letter with; resolves with a measure to plan with (never rejects). */
export const ensureLetteringFonts = (docs: ComicDoc | readonly ComicDoc[] = [], timeoutMs?: number): Promise<ExportFonts> =>
  prepareExportFonts(Array.isArray(docs) ? docs : [docs as ComicDoc], { timeoutMs });

export interface LoadedImage {
  source: CanvasImageSource;
  width: number;
  height: number;
  release: () => void;
}

const loadViaImg = (url: string, signal?: AbortSignal): Promise<LoadedImage> =>
  new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.decoding = 'async';
    const onAbort = () => reject(new ExportError(CANCELLED));
    signal?.addEventListener('abort', onAbort, { once: true });
    img.onload = () => {
      signal?.removeEventListener('abort', onAbort);
      resolve({ source: img, width: img.naturalWidth, height: img.naturalHeight, release: () => undefined });
    };
    img.onerror = () => {
      signal?.removeEventListener('abort', onAbort);
      reject(new ExportError('The image couldn’t be loaded for export — its link may have expired. Refresh the page and try again.'));
    };
    // A distinct URL so a cached non-CORS copy of the image can't taint the canvas.
    img.src = /^(data|blob):/i.test(url) ? url : `${url}${url.includes('?') ? '&' : '?'}cs_export=1`;
  });

/** Load an image for canvas drawing without tainting the canvas (no cookies, no credentials). */
export const loadExportImage = async (url: string, signal?: AbortSignal): Promise<LoadedImage> => {
  if (signal?.aborted) throw new ExportError(CANCELLED);
  if (typeof fetch === 'function' && !/^(data|blob):/i.test(url)) {
    let res: Response | null = null;
    try {
      res = await fetch(url, { mode: 'cors', credentials: 'omit', signal });
    } catch (err) {
      if (signal?.aborted) throw new ExportError(CANCELLED);
      // CORS/network failure: fall back to an <img crossOrigin> load below.
      void err;
    }
    if (res) {
      if (res.status === 400 || res.status === 403) throw new ExportError('The image link expired. Refresh the page and try again.');
      if (!res.ok) throw new ExportError(`The image couldn’t be downloaded (HTTP ${res.status}).`);
      const blob = await res.blob();
      if (typeof createImageBitmap === 'function') {
        const bitmap = await createImageBitmap(blob);
        return { source: bitmap, width: bitmap.width, height: bitmap.height, release: () => bitmap.close?.() };
      }
      const objectUrl = URL.createObjectURL(blob);
      try {
        const loaded = await loadViaImg(objectUrl, signal);
        return { ...loaded, release: () => URL.revokeObjectURL(objectUrl) };
      } catch (err) {
        URL.revokeObjectURL(objectUrl);
        throw err;
      }
    }
  }
  return loadViaImg(url, signal);
};

const encode = (canvas: HTMLCanvasElement, mime: 'image/png' | 'image/jpeg' = 'image/png', quality = 0.9): Promise<Blob> =>
  new Promise((resolve, reject) => {
    try {
      canvas.toBlob(
        (blob) => (blob ? resolve(blob) : reject(new ExportError('The browser couldn’t encode this page (it may be too large).'))),
        mime,
        mime === 'image/jpeg' ? quality : undefined
      );
    } catch (err) {
      reject(
        (err as Error)?.name === 'SecurityError'
          ? new ExportError('Your browser blocked reading this image for export. Use Print / PDF instead.')
          : new ExportError('The browser couldn’t encode this page as an image.')
      );
    }
  });

/** A white canvas of this size, tagged with the language (engines that read `lang` pick fallbacks by it). */
const makeCanvas = (width: number, height: number, lang?: string): { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } => {
  if (typeof document === 'undefined') throw new ExportError('Exports run in the browser.');
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  if (lang) {
    canvas.setAttribute('lang', lang);
    canvas.setAttribute('dir', dirOf(lang));
  }
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new ExportError('This browser can’t draw images for export.');
  if (lang && 'lang' in ctx) (ctx as CanvasRenderingContext2D & { lang: string }).lang = lang;
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, width, height);
  ctx.imageSmoothingQuality = 'high';
  return { canvas, ctx };
};

type Letter = (ctx: CanvasRenderingContext2D, width: number, height: number) => Promise<void> | void;

/** Draw an already-loaded image (plus optional lettering) and encode it. The image is not released. */
export async function rasterizeImage(image: Pick<LoadedImage, 'source' | 'width' | 'height'>, opts: RasterOptions = {}, letter?: Letter, lang?: string): Promise<Blob> {
  const { width, height } = rasterSize(image.width, image.height, opts.longEdge);
  const { canvas, ctx } = makeCanvas(width, height, lang);
  ctx.drawImage(image.source, 0, 0, width, height);
  if (letter) await letter(ctx, width, height);
  if (opts.signal?.aborted) throw new ExportError(CANCELLED);
  return encode(canvas, opts.mime, opts.quality);
}

const withImage = async <T>(url: string, signal: AbortSignal | undefined, use: (image: LoadedImage) => Promise<T>): Promise<T> => {
  const image = await loadExportImage(url, signal);
  try {
    return await use(image);
  } finally {
    image.release();
  }
};

/** The aspect the lettering is planned at: the art's recorded size (as on the board) unless the file disagrees. */
export const pageAspectFor = (doc: ComicDoc, page: Page, width: number, height: number): number => {
  const recorded = letteringAspect(doc, page);
  const actual = width > 0 && height > 0 ? width / height : recorded;
  return Math.abs(Math.log(actual / recorded)) <= 0.01 ? recorded : actual;
};

const measureFor = async (doc: ComicDoc, opts: RasterOptions): Promise<Measure> => opts.measure ?? (await prepareExportFonts([doc])).measure;

/** Lettering for a page drawn over (0,0,width,height) — overlay comics only. */
export async function letterPage(ctx: CanvasRenderingContext2D, doc: ComicDoc, page: Page, width: number, height: number, opts: RasterOptions = {}): Promise<void> {
  if (doc.format.lettering !== 'overlay') return;
  const measure = await measureFor(doc, opts);
  const plans = planLettering(doc, page, pageAspectFor(doc, page, width, height), measure);
  drawLetteringOnPage(ctx, plans, { x: 0, y: 0, width, height }, { makePath: opts.makePath, createLayer: opts.createLayer });
}

/** The overlay cover title over (0,0,width,height) — textless covers only. */
export async function letterCover(ctx: CanvasRenderingContext2D, doc: ComicDoc, width: number, height: number, opts: RasterOptions = {}): Promise<void> {
  if (doc.cover?.lettering !== 'overlay') return;
  const measure = await measureFor(doc, opts);
  const nodes = coverTitleNodes(doc, width / height, measure);
  if (!nodes.length) return;
  ctx.save();
  ctx.scale(width / 1000, width / 1000);
  drawSvgNodes(ctx, nodes, { makePath: opts.makePath, createLayer: opts.createLayer });
  ctx.restore();
}

/** A page's art with its overlay lettering. */
export const renderPageToBlob = (doc: ComicDoc, page: Page, imageUrl: string, opts: RasterOptions = {}): Promise<Blob> =>
  withImage(imageUrl, opts.signal, (image) => rasterizeImage(image, opts, (ctx, w, h) => letterPage(ctx, doc, page, w, h, opts), doc.format.language));

/** The cover art; a textless cover gets its overlay title (localized doc ⇒ that language's title). */
export const renderCoverToBlob = (doc: ComicDoc, imageUrl: string, opts: RasterOptions = {}): Promise<Blob> =>
  withImage(imageUrl, opts.signal, (image) => rasterizeImage(image, opts, (ctx, w, h) => letterCover(ctx, doc, w, h, opts), doc.format.language));

/** A plain image as is. */
export const renderImageToBlob = (imageUrl: string, opts: RasterOptions = {}): Promise<Blob> => withImage(imageUrl, opts.signal, (image) => rasterizeImage(image, opts));

/**
 * A software plate (title page, "The End", back cover) at `plateWidth` px. The back cover's art
 * vignette is the cover image: pass it loaded (`art`) or by URL (`artUrl`); if it can't be loaded the
 * frame keeps its calm placeholder — a plate never fails because of its vignette.
 */
export async function renderPlateToBlob(
  doc: ComicDoc,
  kind: PlateKind,
  opts: RasterOptions & { art?: PlateArtImage | null; artUrl?: string } = {}
): Promise<Blob> {
  const layout = plateLayout(doc, kind);
  let width = Math.round(Math.min(MAX_EXPORT_EDGE, Math.max(200, opts.plateWidth ?? opts.longEdge ?? DEFAULT_PLATE_WIDTH)));
  let height = Math.round((width * layout.height) / layout.width);
  if (height > MAX_EXPORT_EDGE) {
    width = Math.round((width * MAX_EXPORT_EDGE) / height);
    height = MAX_EXPORT_EDGE;
  }
  let art: PlateArtImage | null | undefined = opts.art;
  let loaded: LoadedImage | null = null;
  if (art === undefined && layout.art && opts.artUrl) {
    try {
      loaded = await loadExportImage(opts.artUrl, opts.signal);
      art = loaded;
    } catch (err) {
      if (opts.signal?.aborted) throw new ExportError(CANCELLED);
      art = null;
    }
  }
  try {
    const { canvas, ctx } = makeCanvas(width, height, doc.format.language);
    ctx.save();
    ctx.scale(width / layout.width, width / layout.width);
    drawPlate(ctx, layout, art);
    ctx.restore();
    if (opts.signal?.aborted) throw new ExportError(CANCELLED);
    return await encode(canvas, opts.mime, opts.quality);
  } finally {
    loaded?.release();
  }
}

/** Render one export slot of a (localized) doc. `image` reuses an art image already loaded. */
export async function renderSlotToBlob(
  doc: ComicDoc,
  slot: ExportSlot,
  opts: RasterOptions & { image?: Pick<LoadedImage, 'source' | 'width' | 'height'>; coverUrl?: string; coverArt?: PlateArtImage | null } = {}
): Promise<Blob> {
  if (slot.plate) return renderPlateToBlob(doc, slot.plate, { ...opts, art: opts.coverArt, artUrl: opts.coverUrl });
  const lang = doc.format.language;
  const letter: Letter | undefined =
    slot.kind === 'cover'
      ? (ctx, w, h) => letterCover(ctx, doc, w, h, opts)
      : slot.page
        ? (ctx, w, h) => letterPage(ctx, doc, slot.page!, w, h, opts)
        : undefined;
  if (opts.image) return rasterizeImage(opts.image, opts, letter, lang);
  if (!slot.url) throw new ExportError(`${slot.label} has no image to export.`);
  return withImage(slot.url, opts.signal, (image) => rasterizeImage(image, opts, letter, lang));
}
