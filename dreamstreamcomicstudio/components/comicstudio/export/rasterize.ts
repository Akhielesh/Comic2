// Raster export: a page's art plus its overlay lettering, flattened into a PNG on a canvas.
//
// Uses the board's balloon geometry (balloonGeometry) through Path2D on the very same
// path strings, wraps text with the same metrics, so the PNG matches what the user laid
// out. Images are fetched with CORS (Supabase signed URLs allow it) so the canvas stays
// exportable; a cache-busted <img crossOrigin> load is the fallback.

import type { ComicDoc, LineKind, Page } from '../../../shared/comic/doc';
import {
  LETTERING,
  balloonFontPx,
  balloonPaddingPx,
  balloonShape,
  dashArray,
  hashSeed,
  letteringText,
  resolveBalloons,
  sfxFontPx,
  sfxStyle,
  strokePx,
  tailTipOf,
  wrapBalanced,
  type BalloonShape
} from '../board/balloonGeometry';

export class ExportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ExportError';
  }
}

/** Largest edge we will draw (canvas memory limits on mobile browsers). */
export const MAX_EXPORT_EDGE = 4096;

export interface RasterOptions {
  /** Scale so the longest edge is this many px (default: the image's own size, capped). */
  longEdge?: number;
  signal?: AbortSignal;
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

export const fontFor = (kind: LineKind, fontPx: number): string =>
  kind === 'sfx'
    ? `${fontPx}px "Bangers", Impact, sans-serif`
    : `${kind === 'whisper' ? 'italic ' : ''}700 ${fontPx}px "Comic Neue", "Comic Sans MS", cursive`;

export interface CanvasBalloonPlan {
  lineId: string;
  kind: LineKind;
  /** Top-left corner and size in canvas px. */
  x: number;
  y: number;
  w: number;
  h: number;
  fontPx: number;
  lineHeightPx: number;
  padX: number;
  padY: number;
  lines: string[];
  shape: BalloonShape;
  stroke: number;
  sfx?: { color: string; rotate: number };
}

/**
 * Everything to draw for a page's lettering on a W×H canvas. `measure` returns a string's
 * width at a font size for a line kind (ctx.measureText in the browser; a stub in tests).
 */
export const planCanvasBalloons = (
  doc: ComicDoc,
  page: Page,
  W: number,
  H: number,
  measure: (text: string, fontPx: number, kind: LineKind) => number
): CanvasBalloonPlan[] => {
  if (doc.format.lettering !== 'overlay') return [];
  const stroke = strokePx(W);
  return resolveBalloons(doc, page).map(({ line, balloon: b }) => {
    const kind = line.kind;
    const text = letteringText(line.text, doc.format.language);
    const bw = b.w * W;
    let fontPx: number;
    let lineHeightPx: number;
    let padX = 0;
    let padY = 0;
    let lines: string[];
    if (kind === 'sfx') {
      fontPx = sfxFontPx(text, bw, W);
      lineHeightPx = fontPx;
      lines = wrapBalanced(text, bw, (s) => measure(s, fontPx, kind));
    } else {
      fontPx = balloonFontPx(W, kind);
      lineHeightPx = fontPx * LETTERING.lineHeight;
      const pad = balloonPaddingPx(W);
      padX = pad.x;
      padY = pad.y;
      lines = wrapBalanced(text, Math.max(1, bw - 2 * padX), (s) => measure(s, fontPx, kind));
    }
    const h = Math.max(lineHeightPx, lines.length * lineHeightPx + 2 * padY);
    const tip = tailTipOf(b, kind, H ? h / H : 0);
    const local = tip ? { x: (tip.tailX - b.x) * W, y: (tip.tailY - b.y) * H } : null;
    return {
      lineId: line.id,
      kind,
      x: b.x * W,
      y: b.y * H,
      w: bw,
      h,
      fontPx,
      lineHeightPx,
      padX,
      padY,
      lines,
      shape: balloonShape(kind, bw, h, { tip: local, seed: hashSeed(line.id), inset: { x: padX, y: padY } }),
      stroke,
      ...(kind === 'sfx' ? { sfx: sfxStyle(line.id) } : {})
    };
  });
};

type PathFactory = (d: string) => Path2D;

/** Draw planned balloons onto a 2D context (Path2D from the shared SVG path data). */
export const drawCanvasBalloons = (ctx: CanvasRenderingContext2D, plans: CanvasBalloonPlan[], makePath: PathFactory = (d) => new Path2D(d)): void => {
  for (const p of plans) {
    ctx.save();
    ctx.translate(p.x, p.y);
    ctx.lineJoin = 'round';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    if (p.kind === 'sfx' && p.sfx) {
      ctx.translate(p.w / 2, p.h / 2);
      ctx.rotate((p.sfx.rotate * Math.PI) / 180);
      ctx.font = fontFor('sfx', p.fontPx);
      const top = -p.h / 2;
      const shadow = Math.max(1, p.fontPx * 0.05);
      p.lines.forEach((text, i) => {
        const y = top + p.lineHeightPx * (i + 0.5);
        ctx.fillStyle = LETTERING.ink;
        ctx.fillText(text, shadow, y + shadow);
        ctx.lineWidth = Math.max(1, p.fontPx * 0.12);
        ctx.strokeStyle = LETTERING.ink;
        ctx.strokeText(text, 0, y);
        ctx.fillStyle = p.sfx!.color;
        ctx.fillText(text, 0, y);
      });
      ctx.restore();
      continue;
    }
    const s = p.shape;
    const dash = s.dashed ? dashArray(p.stroke).split(' ').map(Number) : [];
    ctx.fillStyle = s.fill;
    ctx.strokeStyle = s.stroke;
    if (s.tail) {
      const tail = makePath(s.tail);
      ctx.setLineDash(dash);
      ctx.lineWidth = p.stroke * 2;
      ctx.fill(tail);
      ctx.stroke(tail);
    }
    ctx.setLineDash([]);
    ctx.lineWidth = p.stroke;
    for (const c of s.bubbles) {
      ctx.beginPath();
      ctx.arc(c.cx, c.cy, c.r, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }
    if (s.body) {
      const body = makePath(s.body);
      ctx.setLineDash(dash);
      ctx.fill(body);
      ctx.stroke(body);
      ctx.setLineDash([]);
    }
    if (s.tail) ctx.fill(makePath(s.tail));
    ctx.fillStyle = LETTERING.ink;
    ctx.font = fontFor(p.kind, p.fontPx);
    p.lines.forEach((text, i) => ctx.fillText(text, p.w / 2, p.padY + p.lineHeightPx * (i + 0.5)));
    ctx.restore();
  }
};

interface LoadedImage {
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
    const onAbort = () => reject(new ExportError('Export cancelled.'));
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

/** Load an image for canvas drawing without tainting the canvas. */
export const loadExportImage = async (url: string, signal?: AbortSignal): Promise<LoadedImage> => {
  if (signal?.aborted) throw new ExportError('Export cancelled.');
  if (typeof fetch === 'function' && !/^(data|blob):/i.test(url)) {
    let res: Response | null = null;
    try {
      res = await fetch(url, { mode: 'cors', credentials: 'omit', signal });
    } catch (err) {
      if (signal?.aborted) throw new ExportError('Export cancelled.');
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

/** Make sure the lettering fonts are ready before measuring/drawing text (bounded wait). */
export const ensureLetteringFonts = async (timeoutMs = 5000): Promise<void> => {
  const fonts = typeof document !== 'undefined' ? (document as Document & { fonts?: FontFaceSet }).fonts : undefined;
  if (!fonts?.load) return;
  try {
    await Promise.race([
      Promise.all([fonts.load('700 32px "Comic Neue"'), fonts.load('italic 700 32px "Comic Neue"'), fonts.load('32px "Bangers"')]),
      new Promise((resolve) => setTimeout(resolve, timeoutMs))
    ]);
  } catch {
    /* draw with fallbacks */
  }
};

const canvasToPng = (canvas: HTMLCanvasElement): Promise<Blob> =>
  new Promise((resolve, reject) => {
    try {
      canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new ExportError('The browser couldn’t encode this page as PNG (it may be too large).'))), 'image/png');
    } catch (err) {
      reject(
        (err as Error)?.name === 'SecurityError'
          ? new ExportError('Your browser blocked reading this image for export. Use Print / PDF instead.')
          : new ExportError('The browser couldn’t encode this page as PNG.')
      );
    }
  });

const drawToBlob = async (
  url: string,
  opts: RasterOptions,
  letter?: (ctx: CanvasRenderingContext2D, width: number, height: number) => Promise<void> | void
): Promise<Blob> => {
  const image = await loadExportImage(url, opts.signal);
  try {
    const { width, height } = rasterSize(image.width, image.height, opts.longEdge);
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new ExportError('This browser can’t draw images for export.');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, width, height);
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(image.source, 0, 0, width, height);
    if (letter) await letter(ctx, width, height);
    if (opts.signal?.aborted) throw new ExportError('Export cancelled.');
    return await canvasToPng(canvas);
  } finally {
    image.release();
  }
};

/** A page's art with its overlay lettering as a PNG blob. */
export const renderPageToBlob = (doc: ComicDoc, page: Page, imageUrl: string, opts: RasterOptions = {}): Promise<Blob> =>
  drawToBlob(imageUrl, opts, async (ctx, width, height) => {
    if (doc.format.lettering !== 'overlay') return;
    await ensureLetteringFonts();
    const measure = (text: string, fontPx: number, kind: LineKind) => {
      ctx.font = fontFor(kind, fontPx);
      return ctx.measureText(text).width;
    };
    drawCanvasBalloons(ctx, planCanvasBalloons(doc, page, width, height, measure));
  });

/** A plain image (the cover, lettered in-art) as a PNG blob. */
export const renderImageToBlob = (imageUrl: string, opts: RasterOptions = {}): Promise<Blob> => drawToBlob(imageUrl, opts);
