// The single client decode/downscale path for reference photos (refs.md §7.1 prepareImage, §3).
// Owner: P1-REFS. Shared with the composer (which used to reject anything over 10 MB BEFORE
// shrinking — a 15 MB, 48 MP phone JPEG was refused for no reason).
//
//   original file (≤ 40 MB, JPG/PNG/WebP/GIF/AVIF, or a HEIC the browser can decode)
//     → sha256 of the ORIGINAL bytes (first 16 hex: the exact-duplicate hint)
//     → decode upright (EXIF orientation honoured)
//     → long edge ≤ 2048 → WebP 0.9 (JPEG fallback) — never larger than the original
//     → ≤ 10 MB upload body
// Every failure is a PrepareError with copy the queue row shows as is.

import { REF_LIMITS, UPLOAD_MIME } from '../../../shared/comic/refs';
import { HEIC_HELP, isHeicFile, readHead } from './heic';

/** The file-picker `accept`: HEIC deliberately omitted so iOS hands us JPEG (refs.md §7.4). */
export const ACCEPT_ATTR = 'image/jpeg,image/png,image/webp,image/gif,image/avif';
/** Stored long edge (the server keeps ≤ 2048 too). */
export const MAX_EDGE = 2048;
/** Below this, an allowed original that needs no resize is sent as is (no generation loss). */
const SEND_AS_IS_BYTES = 1.5 * 1024 * 1024;
const QUALITY = 0.9;

export type PrepareErrorCode = 'empty' | 'type' | 'too_big' | 'heic' | 'decode' | 'too_small';

export class PrepareError extends Error {
  readonly code: PrepareErrorCode;
  constructor(code: PrepareErrorCode, message: string) {
    super(message);
    this.name = 'PrepareError';
    this.code = code;
  }
}

export const PREPARE_COPY: Record<Exclude<PrepareErrorCode, 'heic'>, string> = {
  empty: 'That file is empty.',
  type: 'Use a JPG, PNG, WebP, GIF or AVIF image.',
  too_big: `That photo is over ${Math.round(REF_LIMITS.maxSourceBytes / 1024 / 1024)} MB — choose a smaller one.`,
  decode: "That file couldn't be opened as an image.",
  too_small: `That image is too small to be useful (under ${REF_LIMITS.minEdgePx} px).`
};

export interface PreparedImage {
  blob: Blob;
  mimeType: string;
  w: number;
  h: number;
  /** sha256(original bytes), first 16 hex; undefined when crypto.subtle is unavailable. */
  hash?: string;
  name: string;
  bytes: number;
  sourceBytes: number;
}

export interface DecodedImage {
  width: number;
  height: number;
  source: CanvasImageSource;
  close?(): void;
}

/** Seams for tests and odd browsers. */
export interface PrepareDeps {
  decode?(file: Blob): Promise<DecodedImage>;
  encode?(img: DecodedImage, w: number, h: number, type: 'image/webp' | 'image/jpeg', quality: number): Promise<Blob | null>;
  digest?(bytes: ArrayBuffer): Promise<ArrayBuffer>;
}

const ALLOWED = new Set<string>(UPLOAD_MIME);
const EXT_TYPE: Record<string, string> = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif', avif: 'image/avif' };

const nameOf = (file: Blob & { name?: string }) => (typeof file.name === 'string' && file.name ? file.name : 'image');
const typeOf = (file: Blob & { name?: string }): string => {
  const t = (file.type || '').toLowerCase();
  if (t === 'image/jpg' || t === 'image/pjpeg') return 'image/jpeg';
  if (t) return t;
  const ext = /\.([a-z0-9]{2,5})$/i.exec(nameOf(file))?.[1]?.toLowerCase();
  return (ext && EXT_TYPE[ext]) || '';
};
const isMarkup = (type: string, name: string) => /svg|html|xml|^text\//i.test(type) || /\.(svg|html?|xml)$/i.test(name);

const toHex16 = (buf: ArrayBuffer) =>
  Array.from(new Uint8Array(buf).slice(0, 8))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');

async function readAll(file: Blob): Promise<ArrayBuffer> {
  if (typeof (file as Blob & { arrayBuffer?: () => Promise<ArrayBuffer> }).arrayBuffer === 'function') return file.arrayBuffer();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as ArrayBuffer);
    reader.onerror = () => reject(reader.error);
    reader.readAsArrayBuffer(file);
  });
}

/** sha256 of the original bytes, first 16 hex (the server's exact-duplicate hint). */
export async function sha256Hex16(file: Blob, digest?: PrepareDeps['digest']): Promise<string | undefined> {
  try {
    const subtle = typeof crypto !== 'undefined' ? crypto.subtle : undefined;
    const fn = digest || (subtle ? (b: ArrayBuffer) => subtle.digest('SHA-256', b) : undefined);
    if (!fn) return undefined;
    return toHex16(await fn(await readAll(file)));
  } catch {
    return undefined;
  }
}

async function defaultDecode(file: Blob): Promise<DecodedImage> {
  if (typeof createImageBitmap === 'function') {
    try {
      const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' } as ImageBitmapOptions);
      return { width: bmp.width, height: bmp.height, source: bmp, close: () => bmp.close() };
    } catch {
      /* fall back to <img> below (older Safari rejects the options bag) */
    }
  }
  if (typeof document === 'undefined' || typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function') throw new Error('no decoder');
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.decoding = 'async';
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error('decode failed'));
      img.src = url;
    });
    return { width: img.naturalWidth, height: img.naturalHeight, source: img };
  } finally {
    // The <img> keeps its decoded pixels; the URL can go once it loaded.
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }
}

async function defaultEncode(img: DecodedImage, w: number, h: number, type: 'image/webp' | 'image/jpeg', quality: number): Promise<Blob | null> {
  if (typeof OffscreenCanvas !== 'undefined') {
    const canvas = new OffscreenCanvas(w, h);
    const ctx = canvas.getContext('2d');
    if (ctx) {
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(img.source, 0, 0, w, h);
      const blob = await canvas.convertToBlob({ type, quality }).catch(() => null);
      if (blob && blob.type === type) return blob;
    }
  }
  if (typeof document === 'undefined') return null;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img.source, 0, 0, w, h);
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob((b) => resolve(b), type, quality));
  // Safari without WebP encode silently returns PNG: treat that as "not supported".
  return blob && blob.type === type ? blob : null;
}

/** Fit inside MAX_EDGE (never enlarge). */
export const fitEdge = (w: number, h: number, max = MAX_EDGE): { w: number; h: number } => {
  const scale = Math.min(1, max / Math.max(w, h));
  return { w: Math.max(1, Math.round(w * scale)), h: Math.max(1, Math.round(h * scale)) };
};

/**
 * Validate, hash and downscale one picked/dropped/pasted image for upload. Throws PrepareError
 * with user-facing copy. HEIC works when the browser can decode it (converted to WebP).
 */
export async function prepareImageFile(file: Blob & { name?: string }, deps: PrepareDeps = {}): Promise<PreparedImage> {
  const name = nameOf(file);
  if (!file || !file.size) throw new PrepareError('empty', PREPARE_COPY.empty);
  const type = typeOf(file);
  if (isMarkup(type, name)) throw new PrepareError('type', PREPARE_COPY.type);
  const heic = await isHeicFile(file);
  if (!heic && type && !ALLOWED.has(type)) throw new PrepareError('type', PREPARE_COPY.type);
  if (file.size > REF_LIMITS.maxSourceBytes) throw new PrepareError('too_big', PREPARE_COPY.too_big);

  const hash = await sha256Hex16(file, deps.digest);
  let img: DecodedImage;
  try {
    img = await (deps.decode || defaultDecode)(file);
  } catch {
    if (heic) throw new PrepareError('heic', HEIC_HELP);
    // A file whose bytes say "image" but the browser can't read (corrupt, exotic codec).
    throw new PrepareError('decode', PREPARE_COPY.decode);
  }
  try {
    const { width, height } = img;
    if (!width || !height) throw new PrepareError('decode', PREPARE_COPY.decode);
    if (Math.min(width, height) < REF_LIMITS.minEdgePx) throw new PrepareError('too_small', PREPARE_COPY.too_small);
    const target = fitEdge(width, height);
    const resized = target.w !== width || target.h !== height;
    const sendable = !heic && ALLOWED.has(type) && file.size <= REF_LIMITS.maxUploadBytes;
    // Small and already the right size: send the original (the server re-encodes anyway).
    if (!resized && sendable && file.size <= SEND_AS_IS_BYTES) {
      return { blob: file, mimeType: type, w: width, h: height, ...(hash ? { hash } : {}), name, bytes: file.size, sourceBytes: file.size };
    }
    const encode = deps.encode || defaultEncode;
    let blob = await encode(img, target.w, target.h, 'image/webp', QUALITY);
    if (!blob) blob = await encode(img, target.w, target.h, 'image/jpeg', QUALITY);
    // Never larger than the original when the original could be sent as it is.
    if ((!blob || blob.size >= file.size) && sendable && !resized) {
      return { blob: file, mimeType: type, w: width, h: height, ...(hash ? { hash } : {}), name, bytes: file.size, sourceBytes: file.size };
    }
    if (!blob) {
      if (heic) throw new PrepareError('heic', HEIC_HELP);
      throw new PrepareError('decode', PREPARE_COPY.decode);
    }
    if (blob.size > REF_LIMITS.maxUploadBytes) {
      const smaller = await encode(img, target.w, target.h, 'image/jpeg', 0.8);
      if (!smaller || smaller.size > REF_LIMITS.maxUploadBytes) throw new PrepareError('too_big', 'That photo is still over 10 MB after shrinking — choose a smaller one.');
      blob = smaller;
    }
    return { blob, mimeType: blob.type, w: target.w, h: target.h, ...(hash ? { hash } : {}), name, bytes: blob.size, sourceBytes: file.size };
  } finally {
    img.close?.();
  }
}

/** Cheap pre-check before queuing (type + source size only; no decode). Returns copy or null. */
export async function quickReject(file: Blob & { name?: string }): Promise<string | null> {
  const name = nameOf(file);
  if (!file.size) return PREPARE_COPY.empty;
  const type = typeOf(file);
  if (isMarkup(type, name)) return PREPARE_COPY.type;
  if (type && !ALLOWED.has(type) && !(await isHeicFile(file))) return PREPARE_COPY.type;
  if (file.size > REF_LIMITS.maxSourceBytes) return PREPARE_COPY.too_big;
  return null;
}

export { readHead };
