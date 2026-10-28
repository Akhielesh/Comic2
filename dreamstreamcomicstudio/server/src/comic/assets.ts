// Asset storage for Comic Studio (v4/v5): generated renders, user uploads and reference photos,
// reference loading for image jobs, signed display URLs, size variants, derived images
// (fit/crop), quarantine and its restore, and the publication copy primitives. Contract §12.5; owned by
// P1-STORAGE (restoreQuarantined: P2-SERVER-FOLLOWUP).
//
// Rules learned the hard way:
//  - generated images are stored exactly as the model drew them — NO cropping (the old
//    studio center-cropped panels up to 47%); reshaping is an explicit, FREE derived copy,
//  - every stored object gets an image_assets row so the retention job can see it, but a
//    bookkeeping failure never throws away a render the user already paid for,
//  - paths are immutable (uuid names, upsert:false), so reference data URLs and signed
//    URLs are safely cached in-process (bounded) — page N+1 reuses page N without a
//    round-trip to Storage,
//  - two buckets (storagePaths.ts): generated art in the public, non-listable `comic-assets`;
//    reference photos and quarantine in the PRIVATE `comic-private` (5-minute signed URLs),
//  - one container (1 GiB, 512 MB heap): every sharp pipeline runs through the 3-slot gate in
//    imageMeasure.ts and decodes with a 50 MP cap; variants are best-effort and never fail a save.

import crypto from 'crypto';
import sharp from 'sharp';
import type { SupabaseClient } from '@supabase/supabase-js';
import { getSupabaseAdmin } from '../services/supabase.js';
import { logger } from '../lib/logger.js';
import type { AspectRatio, AssetRef, AssetVariant, Box, RefAsset, RefQuality } from '../../../shared/comic/doc.js';
import { REF_LIMITS, UPLOAD_MIME } from '../../../shared/comic/refs.js';
import { StudioError, type AssetStore, type EncodedImage } from './types.js';
import {
  PRIVATE_BUCKET,
  PUBLIC_BUCKET,
  SIGNED_TTL_SEC,
  buildQuarantinePath,
  buildRefPath,
  isLibraryPath,
  isPrivatePath,
  isPublicationPath,
  isQuarantinePath
} from './storagePaths.js';
import { MAX_INPUT_PIXELS, MAX_SOURCE_EDGE, SHARP_INPUT, withSharpSlot } from './imageMeasure.js';
import { fitToAspect as deriveFitToAspect } from './derive.js';

// ── Limits ───────────────────────────────────────────────────────────────────

export const WEBP_QUALITY = 90;
export const WEBP_EFFORT = 4;
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
export const MAX_UPLOAD_EDGE = 2048;
/** Smallest edge a reference photo may have (contract §12.5, refs.md §3). */
export const MIN_REF_EDGE = REF_LIMITS.minEdgePx;
/** Generated renders can be large (4K pages); refuse absurd payloads before decoding. */
const MAX_GENERATED_BYTES = 40 * 1024 * 1024;
/** Public-bucket signed URL lifetime (1 h). */
export const SIGNED_URL_TTL_SECONDS = SIGNED_TTL_SEC.public;
/** Private-bucket (refs, quarantine) signed URL lifetime: 5 minutes, never longer. */
export const PRIVATE_SIGNED_URL_TTL_SECONDS = SIGNED_TTL_SEC.private;
const MAX_SIGN_TTL_SECONDS = 24 * 3600;
const SIGN_TIMEOUT_MS = 12_000;
const SIGN_BATCH = 100;
/** Re-sign when less than this much validity remains (clients may hold URLs a while). */
const SIGNED_URL_MIN_REMAINING_MS = 10 * 60_000;
const SIGNED_URL_CACHE_MAX = 4000;
const DOWNLOAD_TIMEOUT_MS = 30_000;
const UPLOAD_TIMEOUT_MS = 45_000;
const STORAGE_OP_TIMEOUT_MS = 30_000;
export const DATA_URL_CACHE_MAX_ENTRIES = 48;
export const DATA_URL_CACHE_MAX_BYTES = 96 * 1024 * 1024;
const PREVIEW_CACHE_MAX_ENTRIES = 96;
const PREVIEW_CACHE_MAX_BYTES = 24 * 1024 * 1024;
const STORAGE_PATH_MAX_LENGTH = 512;

/** Size variants made at save time (mobile.md §8.1): only widths narrower than the original. */
export const VARIANT_WIDTHS = [480, 1080] as const;
const VARIANT_WEBP_QUALITY = 80;
/** Variants are a speed-up: a save never waits longer than this for them. */
const VARIANT_BUDGET_MS = 15_000;
/** Director/safety previews. */
export const PREVIEW_EDGE = 768;
const PREVIEW_QUALITY = 80;
/** Quarantined objects are held 90 days (safety.md Q1), then the retention sweep may take them. */
export const QUARANTINE_HOLD_DAYS = 90;
/** Reference-photo quality heuristics (refs.md §3), measured on a 512 px greyscale copy. */
export const REF_DARK_MEAN = 45;
export const REF_BLUR_STDEV = 6;
export const REF_LOW_RES_EDGE = 512;
const MEASURE_EDGE = 512;
const REMOVE_BATCH = 100;
const REMOVE_PREFIX_MAX_ROUNDS = 50;

/** Data-URL MIME types the legacy saveUpload path accepts (the shared list + common aliases). */
const LEGACY_UPLOAD_MIME = new Set<string>([...UPLOAD_MIME, 'image/jpg', 'image/pjpeg']);
const PUT_CONTENT_TYPES = new Set(['image/webp', 'image/jpeg', 'image/png']);

const TYPE_MESSAGE = 'Use a JPG, PNG, WebP, GIF or AVIF image.';
const HEIC_MESSAGE = "HEIC photos aren't supported here — on iPhone choose “Most Compatible” in Settings › Camera › Formats, or export the photo as JPEG.";
const MARKUP_MESSAGE = "SVG and HTML files can't be used as images. Use a JPG, PNG, WebP, GIF or AVIF image.";
const PIXELS_MESSAGE = 'That image is too large in pixels. Please upload one under 50 megapixels.';

// ── Helpers ──────────────────────────────────────────────────────────────────

const isUuid = (value?: string): boolean =>
  !!value && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);

const sanitizeSegment = (value: string) => value.replace(/[^a-zA-Z0-9_-]/g, '-');

/**
 * Storage path for a new studio asset. Project-scoped when the project id is a real
 * UUID (the shape routes/system.ts canAccessImagePath and image_assets.project_id
 * expect); otherwise the user's tmp lane — never a path claiming a project it isn't in.
 */
export const buildAssetPath = (userId: string, projectId: string, imageId: string): string => {
  const user = sanitizeSegment(userId);
  return isUuid(projectId) ? `u/${user}/p/${sanitizeSegment(projectId)}/img/${imageId}.webp` : `u/${user}/tmp/${imageId}.webp`;
};

/**
 * Path hygiene for anything we read or sign (no traversal, bounded length).
 * Paths are authorized as literal strings but then signed/downloaded through a URL (storage-js
 * does not encode them), and URL parsing collapses dot segments — including percent-encoded
 * ones — so `u/<me>/%2e%2e/<victim>/…` would pass an ownership prefix check yet resolve to the
 * victim's object. Storage paths are plain segments: refuse percent-escapes, query/fragment
 * markers, control characters, and empty or dot segments (same rule as the image proxy).
 */
export const isSafeStoragePath = (path: unknown): path is string =>
  typeof path === 'string' &&
  path.length > 0 &&
  path.length <= STORAGE_PATH_MAX_LENGTH &&
  !path.startsWith('/') &&
  !path.includes('..') &&
  !path.includes('\\') &&
  !/[%?#\u0000-\u001f\u007f]/.test(path) &&
  !path.split('/').some((segment) => segment === '' || segment === '.');

/** True when a storage path belongs to `userId` (current u/{id}/… layout or the legacy {id}/file). */
export const isOwnedAssetPath = (path: string, userId: string): boolean => {
  if (!isSafeStoragePath(path) || !userId) return false;
  return path.startsWith(`u/${sanitizeSegment(userId)}/`) || new RegExp(`^${userId.replace(/[^a-zA-Z0-9_-]/g, '')}/[^/]+$`).test(path);
};

/** The owner (and project, when project-scoped) encoded in a user-lane path. */
export const pathOwner = (path: string): { userId: string; projectId?: string } | null => {
  if (!isSafeStoragePath(path)) return null;
  const scoped = /^u\/([^/]+)\/p\/([^/]+)\//.exec(path);
  if (scoped) return { userId: scoped[1], projectId: scoped[2] };
  const lane = /^u\/([^/]+)\//.exec(path);
  if (lane) return { userId: lane[1] };
  const quarantine = /^q\/([^/]+)\/([^/]+)\//.exec(path);
  if (quarantine) return { userId: quarantine[1], projectId: quarantine[2] };
  const legacy = /^([0-9a-f-]{36})\/[^/]+$/i.exec(path);
  return legacy ? { userId: legacy[1] } : null;
};

/**
 * The quarantine object for a path: `q/<user>/<project>/<name>-<sha8>.webp` in the private bucket.
 * Deterministic, so a retried quarantine finds its own copy — and a restore can prove that a q/
 * object was taken from exactly the path it is being sent back to (restoreQuarantined accepts
 * only this pairing, never a destination of the caller's choosing).
 */
export const quarantinePathFor = (path: string): string => {
  const owner = pathOwner(path);
  const userId = owner?.userId || (isPublicationPath(path) ? 'pub' : 'platform');
  const lane = owner?.projectId || (owner ? 'tmp' : path.split('/')[1] || 'misc');
  const base = sanitizeSegment(path.split('/').pop()!.replace(/\.[A-Za-z0-9]{1,5}$/, '')).slice(0, 80) || 'image';
  const digest = crypto.createHash('sha256').update(path).digest('hex').slice(0, 8);
  return buildQuarantinePath(userId, lane, `${base}-${digest}`);
};

/**
 * Where a held object may go back to: an owner lane (u/<user>/… or a legacy <uuid>/file) — never
 * the quarantine lane itself, a publication copy or the platform library.
 */
const isRestorableOriginal = (path: string): boolean =>
  isSafeStoragePath(path) && !isQuarantinePath(path) && !isPublicationPath(path) && !isLibraryPath(path) && !!pathOwner(path);

/**
 * The restore guard shared by both stores: the source must be a q/ object and the destination the
 * owner path it was quarantined from (quarantinePathFor(original) === source). A caller can never
 * move held bytes to another user's, project's or lane's path, nor un-hold an arbitrary object.
 */
const assertRestorePair = (quarantinePath: unknown, originalPath: unknown): void => {
  if (typeof quarantinePath !== 'string' || !isSafeStoragePath(quarantinePath) || !isQuarantinePath(quarantinePath)) {
    throw new StudioError('BAD_REQUEST', 'Only an image in the safety hold can be restored.', { status: 400 });
  }
  let expected: string | null = null;
  try {
    // buildQuarantinePath throws a plain Error for a degenerate segment ("u/---/x.webp"): still a 400, never a 500.
    expected = typeof originalPath === 'string' && isRestorableOriginal(originalPath) ? quarantinePathFor(originalPath) : null;
  } catch {
    expected = null;
  }
  if (!expected || expected !== quarantinePath) {
    throw new StudioError('BAD_REQUEST', 'A held image can only go back to the place it was taken from.', { status: 400 });
  }
};

const HOLD_GONE_MESSAGE = "That image is no longer in the safety hold, so it can't be restored.";

/** Size-variant path for an asset path: `<base>_w480.webp` (any source extension is dropped). */
export const variantPathFor = (path: string, width: number): string => `${path.replace(/\.[A-Za-z0-9]{1,5}$/, '')}_w${width}.webp`;

/** Variant paths are never themselves the source of variants. */
const isVariantPath = (path: string): boolean => /_w(480|1080)\.webp$/i.test(path);

/** Only user lanes get variants (publication copies and the library carry their own). */
const canHaveVariants = (path: string): boolean =>
  isSafeStoragePath(path) && !isVariantPath(path) && !path.startsWith('q/') && !isPublicationPath(path) && !isLibraryPath(path) && !path.startsWith('pub/');

export const decodeImageDataUrl = (dataUrl: string): { mimeType: string; buffer: Buffer } => {
  const comma = typeof dataUrl === 'string' ? dataUrl.indexOf(',') : -1;
  const header = comma > 5 ? dataUrl.slice(5, comma) : '';
  if (!dataUrl?.startsWith('data:') || !/;base64$/i.test(header)) {
    throw new StudioError('BAD_REQUEST', 'That file is not a readable image.', { status: 400 });
  }
  const mimeType = (header.replace(/;base64$/i, '') || 'application/octet-stream').toLowerCase();
  const buffer = Buffer.from(dataUrl.slice(comma + 1), 'base64');
  if (!buffer.byteLength) throw new StudioError('BAD_REQUEST', 'That image is empty.', { status: 400 });
  return { mimeType, buffer };
};

const toDataUrl = (mimeType: string, buffer: Buffer) => `data:${mimeType};base64,${buffer.toString('base64')}`;

const mimeFromPath = (path: string): string => {
  const ext = path.split('.').pop()?.toLowerCase();
  if (ext === 'png') return 'image/png';
  if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg';
  if (ext === 'gif') return 'image/gif';
  if (ext === 'avif') return 'image/avif';
  return 'image/webp';
};

const withTimeout = async <T>(work: PromiseLike<T>, ms: number, label: string): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve(work),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(Object.assign(new Error(`${label} timed out after ${ms}ms`), { timeout: true })), ms);
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
};

const errStatus = (err: unknown): number =>
  Number((err as { statusCode?: unknown })?.statusCode ?? (err as { status?: unknown })?.status);
const errMessage = (err: unknown): string => String((err as Error)?.message || err || '');
const isAlreadyExists = (err: unknown): boolean => errStatus(err) === 409 || /already exists|duplicate/i.test(errMessage(err));
const isNotFoundErr = (err: unknown): boolean =>
  errStatus(err) === 404 || errStatus(err) === 400 || /not.?found|does not exist|object not found/i.test(errMessage(err));

const clampInt = (n: unknown, lo: number, hi: number, fallback: number): number =>
  typeof n === 'number' && Number.isFinite(n) ? Math.min(hi, Math.max(lo, Math.round(n))) : fallback;

/** Bounded LRU keyed by string, sized by value length (base64 data URLs are ASCII). */
export class DataUrlLru {
  private map = new Map<string, string>();
  private bytes = 0;

  constructor(
    private readonly maxEntries = DATA_URL_CACHE_MAX_ENTRIES,
    private readonly maxBytes = DATA_URL_CACHE_MAX_BYTES
  ) {}

  get(key: string): string | undefined {
    const value = this.map.get(key);
    if (value === undefined) return undefined;
    this.map.delete(key);
    this.map.set(key, value);
    return value;
  }

  set(key: string, value: string): void {
    if (value.length > this.maxBytes) return; // never evict everything for one giant entry
    const previous = this.map.get(key);
    if (previous !== undefined) {
      this.bytes -= previous.length;
      this.map.delete(key);
    }
    this.map.set(key, value);
    this.bytes += value.length;
    while (this.map.size > this.maxEntries || this.bytes > this.maxBytes) {
      const oldest = this.map.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.bytes -= this.map.get(oldest)!.length;
      this.map.delete(oldest);
    }
  }

  delete(key: string): void {
    const previous = this.map.get(key);
    if (previous === undefined) return;
    this.bytes -= previous.length;
    this.map.delete(key);
  }

  /** Delete every entry whose key starts with `prefix` (e.g. all preview sizes of one path). */
  deletePrefix(prefix: string): void {
    for (const key of [...this.map.keys()]) if (key.startsWith(prefix)) this.delete(key);
  }

  get size(): number {
    return this.map.size;
  }

  get totalBytes(): number {
    return this.bytes;
  }

  clear(): void {
    this.map.clear();
    this.bytes = 0;
  }
}

/**
 * Draw the Mark-up box as an SVG overlay: a thick pure-red rectangle (≈0.6% of the long
 * edge), inset so the whole stroke stays inside the image even at the borders.
 */
export const buildOutlineSvg = (width: number, height: number, box: { x: number; y: number; w: number; h: number }): string => {
  const clamp01 = (n: number) => Math.min(1, Math.max(0, Number.isFinite(n) ? n : 0));
  const x0 = clamp01(box.x);
  const y0 = clamp01(box.y);
  const x1 = clamp01(box.x + box.w);
  const y1 = clamp01(box.y + box.h);
  if (x1 - x0 <= 0 || y1 - y0 <= 0) {
    throw new StudioError('BAD_REQUEST', 'The marked area is empty — drag a box over the part to change.', { status: 400 });
  }
  const stroke = Math.max(3, Math.round(Math.max(width, height) * 0.006));
  const half = stroke / 2;
  const left = Math.min(Math.max(x0 * width, half), width - half);
  const top = Math.min(Math.max(y0 * height, half), height - half);
  const right = Math.max(Math.min(x1 * width, width - half), left + 1);
  const bottom = Math.max(Math.min(y1 * height, height - half), top + 1);
  const r = (n: number) => Math.round(n * 10) / 10;
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">` +
    `<rect x="${r(left)}" y="${r(top)}" width="${r(right - left)}" height="${r(bottom - top)}" ` +
    `fill="none" stroke="#FF0000" stroke-width="${stroke}" stroke-linejoin="miter"/></svg>`
  );
};

/** Composite the outline onto a copy of the image; returns a WebP data URL at the same size. */
export const outlineRegionDataUrl = async (dataUrl: string, box: { x: number; y: number; w: number; h: number }): Promise<string> => {
  const { buffer } = decodeImageDataUrl(dataUrl);
  return withSharpSlot(async () => {
    let meta: Awaited<ReturnType<ReturnType<typeof sharp>['metadata']>>;
    try {
      meta = await sharp(buffer, SHARP_INPUT).metadata();
    } catch (err) {
      throw new StudioError('BAD_REQUEST', 'The page image could not be read for Mark-up.', { status: 400, cause: err });
    }
    const width = meta.width || 0;
    const height = meta.height || 0;
    if (!width || !height) throw new StudioError('BAD_REQUEST', 'The page image could not be read for Mark-up.', { status: 400 });
    const svg = buildOutlineSvg(width, height, box);
    const out = await sharp(buffer, SHARP_INPUT)
      .composite([{ input: Buffer.from(svg), top: 0, left: 0 }])
      .webp({ quality: WEBP_QUALITY, effort: WEBP_EFFORT })
      .toBuffer();
    return toDataUrl('image/webp', out);
  });
};

// ── Upload validation (magic bytes first, then sharp) ────────────────────────

export type SniffedImageType = 'png' | 'jpeg' | 'gif' | 'webp' | 'avif' | 'heic' | 'svg' | 'html' | 'unknown';

const AVIF_BRANDS = new Set(['avif', 'avis']);
const HEIC_BRANDS = new Set(['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'hevm', 'hevs', 'mif1', 'msf1', 'mif2']);

/**
 * Identify an image by its first bytes — never by the declared Content-Type or file name.
 * ISO-BMFF files are AVIF only when an `avif`/`avis` brand is present; any other HEIF brand is
 * HEIC. Text starting with `<` is markup (SVG/HTML) and is never an image here.
 */
export function sniffImageType(buf: Buffer): SniffedImageType {
  if (!Buffer.isBuffer(buf) || buf.byteLength < 4) return 'unknown';
  if (buf.byteLength >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpeg';
  const head6 = buf.subarray(0, 6).toString('latin1');
  if (head6 === 'GIF87a' || head6 === 'GIF89a') return 'gif';
  if (buf.byteLength >= 12 && buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP') return 'webp';
  if (buf.byteLength >= 12 && buf.subarray(4, 8).toString('latin1') === 'ftyp') {
    const boxSize = Math.min(buf.readUInt32BE(0) || 0, buf.byteLength, 256);
    const brands: string[] = [buf.subarray(8, 12).toString('latin1')];
    for (let i = 16; i + 4 <= boxSize; i += 4) brands.push(buf.subarray(i, i + 4).toString('latin1'));
    if (brands.some((b) => AVIF_BRANDS.has(b))) return 'avif';
    if (brands.some((b) => HEIC_BRANDS.has(b))) return 'heic';
    return 'unknown';
  }
  // Markup: skip a UTF-8 BOM and leading whitespace.
  let i = buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf ? 3 : 0;
  while (i < Math.min(buf.byteLength, 1024) && /\s/.test(String.fromCharCode(buf[i]))) i += 1;
  if (buf[i] === 0x3c /* < */) {
    const text = buf.subarray(i, i + 512).toString('utf8').toLowerCase();
    if (text.includes('<svg') || text.startsWith('<?xml')) return 'svg';
    return 'html';
  }
  return 'unknown';
}

/** Lower-case a Content-Type, drop parameters and fold the JPEG aliases. */
export const normalizeUploadMime = (mime: unknown): string => {
  const base = String(mime ?? '').split(';')[0].trim().toLowerCase();
  return base === 'image/jpg' || base === 'image/pjpeg' ? 'image/jpeg' : base;
};

const isMarkupMime = (mime: string) => /svg|html|xml|^text\//.test(mime);
const isHeicMime = (mime: string) => mime === 'image/heic' || mime === 'image/heif' || mime === 'image/heic-sequence' || mime === 'image/heif-sequence';

/**
 * Validate + normalize an image upload to WebP: allow-listed type, magic bytes, ≤ 10 MB,
 * ≤ 50 MP / 12,000 px, min edge `minEdge`, EXIF-upright, long edge ≤ 2048. SVG, HTML and HEIC
 * are never accepted, whatever they claim to be. AVIF is accepted (decoded by sharp's libheif).
 */
async function encodeImageBuffer(buffer: Buffer, declaredMime: string, minEdge: number): Promise<EncodedImage> {
  const mime = normalizeUploadMime(declaredMime);
  if (isHeicMime(mime)) throw new StudioError('BAD_REQUEST', HEIC_MESSAGE, { status: 415 });
  if (isMarkupMime(mime)) throw new StudioError('BAD_REQUEST', MARKUP_MESSAGE, { status: 415 });
  if (!(UPLOAD_MIME as readonly string[]).includes(mime)) throw new StudioError('BAD_REQUEST', TYPE_MESSAGE, { status: 415 });
  if (!Buffer.isBuffer(buffer) || !buffer.byteLength) throw new StudioError('BAD_REQUEST', "That file isn't a readable image.", { status: 400 });
  if (buffer.byteLength > MAX_UPLOAD_BYTES) {
    throw new StudioError('BAD_REQUEST', 'That image is larger than 10 MB. Please upload a smaller one.', { status: 413 });
  }
  const sniffed = sniffImageType(buffer);
  if (sniffed === 'heic') throw new StudioError('BAD_REQUEST', HEIC_MESSAGE, { status: 415 });
  if (sniffed === 'svg' || sniffed === 'html') throw new StudioError('BAD_REQUEST', MARKUP_MESSAGE, { status: 415 });
  if (sniffed === 'unknown') {
    throw new StudioError('BAD_REQUEST', `That file isn't a real image (its contents aren't a JPG, PNG, WebP, GIF or AVIF).`, { status: 415 });
  }

  return withSharpSlot(async () => {
    let meta: Awaited<ReturnType<ReturnType<typeof sharp>['metadata']>>;
    try {
      meta = await sharp(buffer, SHARP_INPUT).metadata();
    } catch (err) {
      if (/pixel limit/i.test(errMessage(err))) throw new StudioError('BAD_REQUEST', PIXELS_MESSAGE, { status: 413, cause: err });
      throw new StudioError('BAD_REQUEST', "That file isn't a readable image.", { status: 400, cause: err });
    }
    const format = meta.format as string | undefined;
    const isAvif = format === 'heif' && String(meta.compression || '') === 'av1';
    if (format === 'heif' && !isAvif) throw new StudioError('BAD_REQUEST', HEIC_MESSAGE, { status: 415 });
    if (!isAvif && !(format && ['png', 'jpeg', 'webp', 'gif'].includes(format))) {
      throw new StudioError('BAD_REQUEST', TYPE_MESSAGE, { status: 415 });
    }
    const w = meta.width || 0;
    const h = meta.height || 0;
    if (!w || !h) throw new StudioError('BAD_REQUEST', "That file isn't a readable image.", { status: 400 });
    if (w * h > MAX_INPUT_PIXELS || w > MAX_SOURCE_EDGE || h > MAX_SOURCE_EDGE) {
      throw new StudioError('BAD_REQUEST', PIXELS_MESSAGE, { status: 413 });
    }
    if (minEdge > 0 && Math.min(w, h) < minEdge) {
      throw new StudioError('BAD_REQUEST', `That image is too small to be useful (under ${minEdge} px). Please use a larger photo.`, { status: 422 });
    }
    try {
      const { data, info } = await sharp(buffer, SHARP_INPUT)
        .rotate() // honour EXIF orientation (phone photos); also strips the metadata
        .resize({ width: MAX_UPLOAD_EDGE, height: MAX_UPLOAD_EDGE, fit: 'inside', withoutEnlargement: true })
        .webp({ quality: WEBP_QUALITY, effort: WEBP_EFFORT })
        .toBuffer({ resolveWithObject: true });
      return { buffer: data, mime: 'image/webp' as const, w: info.width, h: info.height, bytes: data.byteLength };
    } catch (err) {
      if (/pixel limit/i.test(errMessage(err))) throw new StudioError('BAD_REQUEST', PIXELS_MESSAGE, { status: 413, cause: err });
      throw new StudioError('BAD_REQUEST', "That image couldn't be processed. Try a different file.", { status: 400, cause: err });
    }
  });
}

/** Reference-photo encode (contract §12.5): magic bytes, pixel limits, AVIF, min edge 128. */
export const encodeUploadBuffer = (buffer: Buffer, mime: string): Promise<EncodedImage> => encodeImageBuffer(buffer, mime, MIN_REF_EDGE);

type LegacyEncoded = { data: Buffer; width?: number; height?: number };

/** Validate + normalize a legacy data-URL upload (no min edge): real image content, ≤10 MB, long edge ≤2048, upright, WebP. */
export const encodeUpload = async (dataUrl: string): Promise<LegacyEncoded> => {
  const { mimeType, buffer } = decodeImageDataUrl(dataUrl);
  if (!LEGACY_UPLOAD_MIME.has(mimeType)) {
    if (isHeicMime(normalizeUploadMime(mimeType))) throw new StudioError('BAD_REQUEST', HEIC_MESSAGE, { status: 415 });
    throw new StudioError('BAD_REQUEST', TYPE_MESSAGE, { status: 415 });
  }
  const encoded = await encodeImageBuffer(buffer, mimeType, 0);
  return { data: encoded.buffer, width: encoded.w, height: encoded.h };
};

// ── Pure image work (gated) ──────────────────────────────────────────────────

/** 64-bit difference hash (16 hex): 9×8 greyscale, each bit = "left pixel brighter than right". */
async function dHashOf(buffer: Buffer): Promise<string> {
  const { data, info } = await sharp(buffer, SHARP_INPUT)
    .rotate()
    .flatten({ background: '#ffffff' })
    .greyscale()
    .resize(9, 8, { fit: 'fill', kernel: 'cubic' })
    .raw()
    .toBuffer({ resolveWithObject: true });
  const ch = info.channels;
  let hex = '';
  let nibble = 0;
  let bits = 0;
  for (let y = 0; y < 8; y += 1) {
    for (let x = 0; x < 8; x += 1) {
      const left = data[(y * 9 + x) * ch];
      const right = data[(y * 9 + x + 1) * ch];
      nibble = (nibble << 1) | (left > right ? 1 : 0);
      bits += 1;
      if (bits === 4) {
        hex += nibble.toString(16);
        nibble = 0;
        bits = 0;
      }
    }
  }
  return hex;
}

const readImageError = (err: unknown) => {
  if (err instanceof StudioError) return err;
  if (/pixel limit/i.test(errMessage(err))) return new StudioError('BAD_REQUEST', PIXELS_MESSAGE, { status: 413, cause: err });
  return new StudioError('BAD_REQUEST', "That file isn't a readable image.", { status: 400, cause: err });
};

/** The single dHash implementation (refs near-dup + the safety denylist). */
export async function dHashImage(buffer: Buffer): Promise<string> {
  if (!Buffer.isBuffer(buffer) || !buffer.byteLength) throw new StudioError('BAD_REQUEST', "That file isn't a readable image.", { status: 400 });
  return withSharpSlot(async () => {
    try {
      return await dHashOf(buffer);
    } catch (err) {
      throw readImageError(err);
    }
  });
}

/** Free sharp heuristics for a reference photo: dHash plus dark / blurry / low-res flags (never multiSubject). */
export async function measureRefImage(buffer: Buffer): Promise<{ dhash: string; quality?: RefQuality }> {
  if (!Buffer.isBuffer(buffer) || !buffer.byteLength) throw new StudioError('BAD_REQUEST', "That file isn't a readable image.", { status: 400 });
  return withSharpSlot(async () => {
    try {
      const meta = await sharp(buffer, SHARP_INPUT).metadata();
      const w = meta.width || 0;
      const h = meta.height || 0;
      if (!w || !h) throw new StudioError('BAD_REQUEST', "That file isn't a readable image.", { status: 400 });
      const grey = await sharp(buffer, SHARP_INPUT)
        .rotate()
        .flatten({ background: '#ffffff' })
        .greyscale()
        .resize(MEASURE_EDGE, MEASURE_EDGE, { fit: 'inside', withoutEnlargement: true })
        .raw()
        .toBuffer({ resolveWithObject: true });
      const gc = grey.info.channels;
      let sum = 0;
      const n = grey.info.width * grey.info.height;
      for (let i = 0; i < n; i += 1) sum += grey.data[i * gc];
      const mean = n ? sum / n : 0;
      // Laplacian variance, materialized: calling stats() on the convolve pipeline returns 0.
      const lap = await sharp(grey.data, { raw: { width: grey.info.width, height: grey.info.height, channels: gc } })
        .convolve({ width: 3, height: 3, kernel: [0, 1, 0, 1, -4, 1, 0, 1, 0], offset: 128 })
        .raw()
        .toBuffer({ resolveWithObject: true });
      const lc = lap.info.channels;
      const ln = lap.info.width * lap.info.height;
      let ls = 0;
      let lsq = 0;
      for (let i = 0; i < ln; i += 1) {
        const v = lap.data[i * lc];
        ls += v;
        lsq += v * v;
      }
      const lmean = ln ? ls / ln : 0;
      const lapStdev = ln ? Math.sqrt(Math.max(0, lsq / ln - lmean * lmean)) : 0;
      const dhash = await dHashOf(buffer);
      const quality: RefQuality = {};
      if (mean < REF_DARK_MEAN) quality.dark = true;
      if (lapStdev < REF_BLUR_STDEV) quality.blurry = true;
      if (Math.min(w, h) < REF_LOW_RES_EDGE) quality.lowRes = true;
      return Object.keys(quality).length ? { dhash, quality } : { dhash };
    } catch (err) {
      throw readImageError(err);
    }
  });
}

/** ≤ `edge` px WebP data URL (upright, never enlarged) for the safety check and the director's eyes. */
export async function previewImage(buffer: Buffer, edge = PREVIEW_EDGE): Promise<string> {
  const e = clampInt(edge, 64, MAX_UPLOAD_EDGE, PREVIEW_EDGE);
  if (!Buffer.isBuffer(buffer) || !buffer.byteLength) throw new StudioError('BAD_REQUEST', "That file isn't a readable image.", { status: 400 });
  return withSharpSlot(async () => {
    try {
      const out = await sharp(buffer, SHARP_INPUT)
        .rotate()
        .resize(e, e, { fit: 'inside', withoutEnlargement: true })
        .webp({ quality: PREVIEW_QUALITY, effort: WEBP_EFFORT })
        .toBuffer();
      return toDataUrl('image/webp', out);
    } catch (err) {
      throw readImageError(err);
    }
  });
}

type VariantBuffer = { width: number; buffer: Buffer; w: number; h: number };

/** 480/1080-wide WebP downscales of an image, only those narrower than it (ascending). */
async function variantBuffers(buffer: Buffer, knownWidth?: number): Promise<VariantBuffer[]> {
  return withSharpSlot(async () => {
    let srcW = knownWidth || 0;
    if (!srcW) srcW = (await sharp(buffer, SHARP_INPUT).metadata()).width || 0;
    const widths = VARIANT_WIDTHS.filter((w) => w < srcW).sort((a, b) => b - a); // big first: the small one derives from it
    const out: VariantBuffer[] = [];
    let source = buffer;
    for (const width of widths) {
      const { data, info } = await sharp(source, SHARP_INPUT)
        .resize({ width, withoutEnlargement: true })
        .webp({ quality: VARIANT_WEBP_QUALITY, effort: WEBP_EFFORT })
        .toBuffer({ resolveWithObject: true });
      out.push({ width, buffer: data, w: info.width, h: info.height });
      source = data;
    }
    return out.sort((a, b) => a.width - b.width);
  });
}

/** Normalized crop box → source pixel rectangle (clamped, at least `minEdge` px each way). */
export const boxToRect = (box: Box, w: number, h: number, minEdge: number): { left: number; top: number; width: number; height: number } => {
  const f = (n: unknown) => (typeof n === 'number' && Number.isFinite(n) ? n : 0);
  const x0 = Math.min(1, Math.max(0, f(box?.x)));
  const y0 = Math.min(1, Math.max(0, f(box?.y)));
  const x1 = Math.min(1, Math.max(x0, x0 + f(box?.w)));
  const y1 = Math.min(1, Math.max(y0, y0 + f(box?.h)));
  const left = Math.min(w - 1, Math.floor(x0 * w));
  const top = Math.min(h - 1, Math.floor(y0 * h));
  const width = Math.min(w - left, Math.round((x1 - x0) * w));
  const height = Math.min(h - top, Math.round((y1 - y0) * h));
  if (width < minEdge || height < minEdge) {
    throw new StudioError('BAD_REQUEST', `That crop is too small (under ${minEdge} px) — drag a bigger box.`, { status: 400 });
  }
  return { left, top, width, height };
};

const CROP_ASPECTS: Record<'1:1' | '3:4' | '4:3', number> = { '1:1': 1, '3:4': 3 / 4, '4:3': 4 / 3 };

/** Crop an image by a box, or to an aspect around its most interesting region (sharp attention). */
async function cropImage(
  buffer: Buffer,
  opts: { box?: Box; aspect?: '1:1' | '3:4' | '4:3' }
): Promise<{ encoded: EncodedImage; crop: Box; srcW: number; srcH: number }> {
  return withSharpSlot(async () => {
    let w = 0;
    let h = 0;
    try {
      const meta = await sharp(buffer, SHARP_INPUT).rotate().metadata();
      // metadata() reports the stored orientation; swap for EXIF 5–8 (rotated 90°).
      const swap = (meta.orientation || 1) >= 5;
      w = (swap ? meta.height : meta.width) || 0;
      h = (swap ? meta.width : meta.height) || 0;
    } catch (err) {
      throw readImageError(err);
    }
    if (!w || !h) throw new StudioError('BAD_REQUEST', "That file isn't a readable image.", { status: 400 });
    const minEdge = Math.min(MIN_REF_EDGE, w, h);
    let rect: { left: number; top: number; width: number; height: number };
    if (opts.box) {
      rect = boxToRect(opts.box, w, h, minEdge);
    } else {
      const r = CROP_ASPECTS[opts.aspect && opts.aspect in CROP_ASPECTS ? opts.aspect : '1:1'];
      const cw = w / h > r ? Math.round(h * r) : w;
      const ch = w / h > r ? h : Math.round(w / r);
      // Find the attention window on a ≤ 512 px working copy, then map it back to source pixels.
      const s = Math.min(1, 512 / Math.max(w, h));
      const tw = Math.max(1, Math.round(cw * s));
      const th = Math.max(1, Math.round(ch * s));
      const { info } = await sharp(buffer, SHARP_INPUT)
        .rotate()
        .resize(tw, th, { fit: 'cover', position: sharp.strategy.attention })
        .toBuffer({ resolveWithObject: true });
      const offL = Math.abs(Number((info as { cropOffsetLeft?: number }).cropOffsetLeft) || 0) / s;
      const offT = Math.abs(Number((info as { cropOffsetTop?: number }).cropOffsetTop) || 0) / s;
      const left = Math.max(0, Math.min(w - cw, Math.round(offL)));
      const top = Math.max(0, Math.min(h - ch, Math.round(offT)));
      rect = { left, top, width: cw, height: ch };
    }
    try {
      const { data, info } = await sharp(buffer, SHARP_INPUT)
        .rotate()
        .extract(rect)
        .resize({ width: MAX_UPLOAD_EDGE, height: MAX_UPLOAD_EDGE, fit: 'inside', withoutEnlargement: true })
        .webp({ quality: WEBP_QUALITY, effort: WEBP_EFFORT })
        .toBuffer({ resolveWithObject: true });
      const r4 = (n: number) => Math.round(n * 10000) / 10000;
      return {
        encoded: { buffer: data, mime: 'image/webp', w: info.width, h: info.height, bytes: data.byteLength },
        crop: { x: r4(rect.left / w), y: r4(rect.top / h), w: r4(rect.width / w), h: r4(rect.height / h) },
        srcW: w,
        srcH: h
      };
    } catch (err) {
      throw readImageError(err);
    }
  });
}

/** Source lanes a user may derive from (crop/fit): their own paths or the platform library. Never quarantine. */
const assertDerivableSource = (path: string, userId: string) => {
  if (!isSafeStoragePath(path)) throw new StudioError('BAD_REQUEST', 'Invalid image path.', { status: 400 });
  if (path.startsWith('q/')) throw new StudioError('NOT_FOUND', 'That image is no longer available.', { status: 404 });
  if (!isOwnedAssetPath(path, userId) && !isLibraryPath(path)) {
    throw new StudioError('FORBIDDEN', "You don't have access to that image.", { status: 403 });
  }
};

// ── Shared caches (module-level: stores are created per request) ─────────────

const dataUrlCache = new DataUrlLru();
const dataUrlInflight = new Map<string, Promise<string>>();
const previewCache = new DataUrlLru(PREVIEW_CACHE_MAX_ENTRIES, PREVIEW_CACHE_MAX_BYTES);
const previewInflight = new Map<string, Promise<string>>();
const signedUrlCache = new Map<string, { url: string; expiresAt: number }>();

/** Test hook. */
export const __resetAssetCachesForTests = (): void => {
  dataUrlCache.clear();
  dataUrlInflight.clear();
  previewCache.clear();
  previewInflight.clear();
  signedUrlCache.clear();
};

const cacheSignedUrl = (key: string, url: string, expiresAt: number) => {
  if (signedUrlCache.size >= SIGNED_URL_CACHE_MAX) {
    const now = Date.now();
    for (const [k, v] of signedUrlCache) {
      if (v.expiresAt - now < SIGNED_URL_MIN_REMAINING_MS) signedUrlCache.delete(k);
    }
    while (signedUrlCache.size >= SIGNED_URL_CACHE_MAX) {
      const oldest = signedUrlCache.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      signedUrlCache.delete(oldest);
    }
  }
  signedUrlCache.set(key, { url, expiresAt });
};

/** Forget every cached form of a path (after it moved or was removed). */
const evictPath = (bucket: string, path: string) => {
  const key = `${bucket}:${path}`;
  dataUrlCache.delete(key);
  for (const k of [...signedUrlCache.keys()]) if (k.startsWith(`${key}|`)) signedUrlCache.delete(k);
  // Every preview size (previewDataUrl takes any edge from 64 to 2048): a quarantined or removed
  // image must never reach the director or the safety check again from a cached preview.
  previewCache.deletePrefix(`${key}@`);
};

/** Resolve within `ms` or give up (the work keeps running; used for best-effort extras only). */
const withinBudget = async <T>(work: Promise<T>, ms: number, fallback: T): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([work, new Promise<T>((resolve) => (timer = setTimeout(() => resolve(fallback), ms)))]);
  } finally {
    if (timer) clearTimeout(timer);
  }
};

// ── Supabase store ───────────────────────────────────────────────────────────

export interface SupabaseAssetStoreOptions {
  /** Public bucket (generated art, publication copies, library). Default `comic-assets`. */
  bucket?: string;
  /** Private bucket (refs, quarantine). Default `comic-private`. */
  privateBucket?: string;
  /** Admin client factory (tests inject a fake). */
  admin?: () => SupabaseClient;
}

/** Low-level storage operations shared by the AssetStore and server maintenance (routes/comicStorageAdmin.ts). */
export interface StorageOps {
  bucketOf(path: string): string;
  /** Raw bytes of a stored object (cached data URL first). */
  readBytes(path: string): Promise<{ buffer: Buffer; type: string }>;
  /** Server-side copy between any lanes; 'exists' when the destination already holds an object. */
  copy(srcPath: string, dstPath: string): Promise<'copied' | 'exists'>;
  /** Delete objects (grouped per bucket); marks their image_assets rows deleted. Returns the count requested. */
  removeObjects(paths: string[]): Promise<number>;
  /** Register an image_assets row (best-effort). */
  register(row: {
    userId: string;
    projectId?: string;
    path: string;
    bytes: number;
    width?: number;
    height?: number;
    source: string;
    expiresAt?: string | null;
  }): Promise<void>;
}

type StoreInternals = AssetStore & { ops: StorageOps };

export function createSupabaseAssetStore(opts: SupabaseAssetStoreOptions = {}): AssetStore {
  return createSupabaseAssetStoreInternal(opts);
}

/** The AssetStore plus its low-level StorageOps (server maintenance only — never hand `ops` to features). */
export function createSupabaseStorage(opts: SupabaseAssetStoreOptions = {}): StoreInternals {
  return createSupabaseAssetStoreInternal(opts);
}

function createSupabaseAssetStoreInternal(opts: SupabaseAssetStoreOptions): StoreInternals {
  const publicBucket = opts.bucket || PUBLIC_BUCKET;
  const privateBucket = opts.privateBucket || PRIVATE_BUCKET;
  const admin = opts.admin || getSupabaseAdmin;
  const bucketOf = (path: string) => (isPrivatePath(path) ? privateBucket : publicBucket);
  const cacheKey = (path: string) => `${bucketOf(path)}:${path}`;

  const uploadOnce = async (path: string, data: Buffer, contentType: string, cacheControl: string, upsert: boolean) => {
    const { error } = await withTimeout(
      admin().storage.from(bucketOf(path)).upload(path, data, { contentType, cacheControl, upsert }),
      UPLOAD_TIMEOUT_MS,
      'Storage upload'
    );
    if (error) throw error;
  };

  /** Upload with one retry; a hiccup must not cost the user a paid render. 'exists' = already stored. */
  const upload = async (
    path: string,
    data: Buffer,
    o: { contentType?: string; cacheControl?: string; upsert?: boolean } = {}
  ): Promise<'stored' | 'exists'> => {
    const contentType = o.contentType || 'image/webp';
    const cacheControl = o.cacheControl || '31536000';
    const upsert = o.upsert === true;
    try {
      await uploadOnce(path, data, contentType, cacheControl, upsert);
      return 'stored';
    } catch (first) {
      if (!upsert && isAlreadyExists(first)) return 'exists';
      logger.warn('comic_asset_upload_retry', { path, message: errMessage(first) });
      try {
        await uploadOnce(path, data, contentType, cacheControl, upsert);
        return 'stored';
      } catch (err) {
        // The first attempt may have landed after all (timeout racing a slow success).
        if (isAlreadyExists(err)) return 'exists';
        logger.error('comic_asset_upload_failed', { path, message: errMessage(err) });
        throw new StudioError('INTERNAL', "The image was created but couldn't be saved. Please try again.", {
          status: 503,
          retryable: true,
          cause: err
        });
      }
    }
  };

  /** image_assets row so the retention job tracks the object; failures are logged, never thrown. */
  const register: StorageOps['register'] = async (args) => {
    const owner = args.userId;
    if (!isUuid(owner)) return; // image_assets.user_id references auth.users: only real users get rows
    const now = new Date().toISOString();
    const row = {
      id: crypto.randomUUID(),
      user_id: owner,
      project_id: args.projectId && isUuid(args.projectId) ? args.projectId : null,
      bucket: bucketOf(args.path),
      path: args.path,
      mime_type: mimeFromPath(args.path),
      bytes: Math.max(0, Math.round(args.bytes || 0)),
      width: args.width || null,
      height: args.height || null,
      source: args.source,
      created_at: now,
      last_referenced_at: now,
      expires_at: args.expiresAt ?? null,
      deleted_at: null
    };
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      try {
        const { error } = await admin().from('image_assets').insert(row);
        if (!error) return;
        if (String((error as { code?: string }).code) === '23505') return; // already registered
        throw error;
      } catch (err) {
        if (attempt === 2) {
          // Without the row the object is simply never garbage-collected — far better than
          // deleting an image the user paid for.
          logger.error('comic_asset_register_failed', { path: args.path, message: errMessage(err) });
        }
      }
    }
  };

  /** Mark image_assets rows deleted (the objects are gone). Best-effort. */
  const markDeleted = async (paths: string[]) => {
    if (!paths.length) return;
    try {
      for (let i = 0; i < paths.length; i += REMOVE_BATCH) {
        const { error } = await admin()
          .from('image_assets')
          .update({ deleted_at: new Date().toISOString() })
          .in('path', paths.slice(i, i + REMOVE_BATCH));
        if (error) throw error;
      }
    } catch (err) {
      logger.warn('comic_asset_mark_deleted_failed', { count: paths.length, message: errMessage(err) });
    }
  };

  const downloadBytes = async (path: string): Promise<{ buffer: Buffer; type: string }> => {
    const controller = new AbortController();
    try {
      const { data, error } = await withTimeout(
        admin().storage.from(bucketOf(path)).download(path, undefined, { signal: controller.signal }),
        DOWNLOAD_TIMEOUT_MS,
        'Storage download'
      );
      if (error || !data) throw error || new Error('Empty download');
      const buffer = Buffer.from(await (data as Blob).arrayBuffer());
      if (!buffer.byteLength) throw new Error('Empty download');
      const type = typeof (data as Blob).type === 'string' && (data as Blob).type.startsWith('image/') ? (data as Blob).type : mimeFromPath(path);
      return { buffer, type };
    } catch (err) {
      controller.abort();
      if (isNotFoundErr(err)) {
        throw new StudioError('NOT_FOUND', 'A reference image is missing from storage. Re-render or re-upload it and try again.', {
          status: 404,
          cause: err
        });
      }
      throw new StudioError('INTERNAL', "A reference image couldn't be loaded right now. Please try again.", {
        status: 503,
        retryable: true,
        cause: err
      });
    }
  };

  const readBytes: StorageOps['readBytes'] = async (path) => {
    if (!isSafeStoragePath(path)) throw new StudioError('BAD_REQUEST', 'Invalid image path.', { status: 400 });
    const cached = dataUrlCache.get(cacheKey(path));
    if (cached) {
      const { mimeType, buffer } = decodeImageDataUrl(cached);
      return { buffer, type: mimeType };
    }
    return downloadBytes(path);
  };

  const copy: StorageOps['copy'] = async (srcPath, dstPath) => {
    if (!isSafeStoragePath(srcPath) || !isSafeStoragePath(dstPath)) throw new StudioError('BAD_REQUEST', 'Invalid image path.', { status: 400 });
    const srcBucket = bucketOf(srcPath);
    const dstBucket = bucketOf(dstPath);
    try {
      const { error } = await withTimeout(
        admin().storage.from(srcBucket).copy(srcPath, dstPath, srcBucket === dstBucket ? undefined : { destinationBucket: dstBucket }),
        STORAGE_OP_TIMEOUT_MS,
        'Storage copy'
      );
      if (!error) return 'copied';
      throw error;
    } catch (err) {
      if (isAlreadyExists(err)) return 'exists';
      if (errStatus(err) === 404 || /not.?found|does not exist/i.test(errMessage(err))) {
        throw new StudioError('NOT_FOUND', 'That image is missing from storage.', { status: 404, cause: err });
      }
      // Older Storage servers refuse cross-bucket copies: move the bytes through the server once.
      logger.warn('comic_asset_copy_fallback', { srcBucket, dstBucket, message: errMessage(err) });
      const { buffer, type } = await downloadBytes(srcPath);
      return (await upload(dstPath, buffer, { contentType: type })) === 'exists' ? 'exists' : 'copied';
    }
  };

  const removeObjects: StorageOps['removeObjects'] = async (paths) => {
    const byBucket = new Map<string, string[]>();
    for (const path of Array.from(new Set(paths || []))) {
      if (!isSafeStoragePath(path)) continue;
      const bucket = bucketOf(path);
      byBucket.set(bucket, [...(byBucket.get(bucket) || []), path]);
    }
    let count = 0;
    for (const [bucket, list] of byBucket) {
      for (let i = 0; i < list.length; i += REMOVE_BATCH) {
        const chunk = list.slice(i, i + REMOVE_BATCH);
        const { error } = await withTimeout(admin().storage.from(bucket).remove(chunk), STORAGE_OP_TIMEOUT_MS, 'Storage remove');
        if (error) {
          throw new StudioError('INTERNAL', "Stored images couldn't be removed right now. Please try again.", { status: 503, retryable: true, cause: error });
        }
        count += chunk.length;
        chunk.forEach((p) => evictPath(bucket, p));
        await markDeleted(chunk);
      }
    }
    return count;
  };

  const ops: StorageOps = { bucketOf, readBytes, copy, removeObjects, register };

  /**
   * Best-effort 480/1080 variants of a stored image (uploaded + registered); [] on any failure.
   * Variant paths are deterministic (<base>_w480.webp), so an object already sitting there is never
   * adopted: the bytes derived from THIS original replace it (S6 — a planted or stale object at a
   * predictable path must never ride along into a publication). A failed overwrite drops the variant.
   */
  const writeVariants = async (path: string, buffer: Buffer, width?: number): Promise<AssetVariant[]> => {
    if (!canHaveVariants(path)) return [];
    try {
      const made = await variantBuffers(buffer, width);
      if (!made.length) return [];
      const owner = pathOwner(path);
      const results = await Promise.all(
        made.map(async (v) => {
          const vPath = variantPathFor(path, v.width);
          try {
            let outcome = await upload(vPath, v.buffer);
            if (outcome === 'exists') {
              await upload(vPath, v.buffer, { upsert: true });
              outcome = 'stored';
            }
            if (outcome === 'stored' && owner) {
              await register({ userId: owner.userId, projectId: owner.projectId, path: vPath, bytes: v.buffer.byteLength, width: v.w, height: v.h, source: 'variant' });
            }
            return { path: vPath, w: v.w, h: v.h } as AssetVariant;
          } catch (err) {
            logger.warn('comic_asset_variant_failed', { path: vPath, message: errMessage(err) });
            return null;
          }
        })
      );
      return results.filter((v): v is AssetVariant => !!v).sort((a, b) => a.w - b.w);
    } catch (err) {
      logger.warn('comic_asset_variants_failed', { path, message: errMessage(err) });
      return [];
    }
  };

  const store = async (args: {
    userId: string;
    projectId: string;
    encoded: { data: Buffer; width?: number; height?: number };
    source: 'generated' | 'upload';
    registrySource: string;
    model?: string;
  }): Promise<AssetRef> => {
    if (!args.userId) throw new StudioError('FORBIDDEN', 'Sign in to save images.', { status: 401 });
    const id = crypto.randomUUID();
    const path = buildAssetPath(args.userId, args.projectId, id);
    await upload(path, args.encoded.data);
    await register({
      userId: args.userId,
      projectId: args.projectId,
      path,
      bytes: args.encoded.data.byteLength,
      width: args.encoded.width,
      height: args.encoded.height,
      source: args.registrySource
    });
    // Prime the reference cache: the next page uses this one for continuity.
    dataUrlCache.set(cacheKey(path), toDataUrl('image/webp', args.encoded.data));
    const ref: AssetRef = { path, source: args.source, at: Date.now() };
    if (args.encoded.width) ref.w = args.encoded.width;
    if (args.encoded.height) ref.h = args.encoded.height;
    if (args.model) ref.model = args.model;
    const variants = await withinBudget(writeVariants(path, args.encoded.data, args.encoded.width), VARIANT_BUDGET_MS, [] as AssetVariant[]);
    if (variants.length) ref.variants = variants;
    return ref;
  };

  const saveGenerated: AssetStore['saveGenerated'] = async ({ userId, projectId, dataUrl, model }) => {
    const { buffer } = decodeImageDataUrl(dataUrl);
    if (buffer.byteLength > MAX_GENERATED_BYTES) {
      throw new StudioError('NO_IMAGE', 'The image model returned an oversized image. Please try again.', { status: 502, retryable: true });
    }
    let encoded: { data: Buffer; width?: number; height?: number };
    try {
      encoded = await withSharpSlot(async () => {
        const { data, info } = await sharp(buffer, SHARP_INPUT)
          .webp({ quality: WEBP_QUALITY, effort: WEBP_EFFORT })
          .toBuffer({ resolveWithObject: true });
        return { data, width: info.width, height: info.height };
      });
    } catch (err) {
      throw new StudioError('NO_IMAGE', 'The image model returned an unreadable image. Please try again.', {
        status: 502,
        retryable: true,
        cause: err
      });
    }
    return store({
      userId,
      projectId,
      encoded,
      source: 'generated',
      registrySource: model && model.includes('/') ? 'openrouter' : 'gemini',
      model
    });
  };

  const saveUpload: AssetStore['saveUpload'] = async ({ userId, projectId, dataUrl }) => {
    return store({ userId, projectId, encoded: await encodeUpload(dataUrl), source: 'upload', registrySource: 'upload' });
  };

  /** Store an encoded image under a fresh path in the right lane; registers it and makes variants. */
  const storeEncoded = async (args: {
    userId: string;
    projectId: string;
    encoded: EncodedImage;
    privateLane: boolean;
    registrySource: string;
  }): Promise<{ path: string; variants: AssetVariant[] }> => {
    if (!args.userId) throw new StudioError('FORBIDDEN', 'Sign in to save images.', { status: 401 });
    if (!Buffer.isBuffer(args.encoded?.buffer) || !args.encoded.buffer.byteLength) {
      throw new StudioError('BAD_REQUEST', 'That image is empty.', { status: 400 });
    }
    const id = crypto.randomUUID();
    const path = args.privateLane ? buildRefPath(args.userId, args.projectId, id) : buildAssetPath(args.userId, args.projectId, id);
    await upload(path, args.encoded.buffer);
    await register({
      userId: args.userId,
      projectId: args.projectId,
      path,
      bytes: args.encoded.buffer.byteLength,
      width: args.encoded.w,
      height: args.encoded.h,
      source: args.registrySource
    });
    dataUrlCache.set(cacheKey(path), toDataUrl('image/webp', args.encoded.buffer));
    const variants = await withinBudget(writeVariants(path, args.encoded.buffer, args.encoded.w), VARIANT_BUDGET_MS, [] as AssetVariant[]);
    return { path, variants };
  };

  const loadDataUrl: AssetStore['loadDataUrl'] = async (path) => {
    if (!isSafeStoragePath(path)) throw new StudioError('BAD_REQUEST', 'Invalid image path.', { status: 400 });
    const key = cacheKey(path);
    const cached = dataUrlCache.get(key);
    if (cached) return cached;
    const pending = dataUrlInflight.get(key);
    if (pending) return pending;
    const work = (async () => {
      try {
        const { buffer, type } = await downloadBytes(path);
        const dataUrl = toDataUrl(type, buffer);
        dataUrlCache.set(key, dataUrl);
        return dataUrl;
      } finally {
        dataUrlInflight.delete(key);
      }
    })();
    dataUrlInflight.set(key, work);
    return work;
  };

  const signUrls: AssetStore['signUrls'] = async (paths, signOpts) => {
    const out: Record<string, string> = {};
    const now = Date.now();
    const requested = clampInt(signOpts?.ttlSec, 30, MAX_SIGN_TTL_SECONDS, SIGNED_URL_TTL_SECONDS);
    const groups = new Map<string, { ttl: number; paths: string[] }>();
    for (const path of Array.from(new Set(paths || []))) {
      if (!isSafeStoragePath(path)) continue;
      const bucket = bucketOf(path);
      // Private lanes never sign for longer than 5 minutes, whatever the caller asks for.
      const ttl = isPrivatePath(path) ? Math.min(requested, PRIVATE_SIGNED_URL_TTL_SECONDS) : signOpts?.ttlSec ? requested : SIGNED_URL_TTL_SECONDS;
      const key = `${bucket}:${path}|${ttl}`;
      const hit = signedUrlCache.get(key);
      const minRemaining = Math.min(SIGNED_URL_MIN_REMAINING_MS, (ttl * 1000) / 2);
      if (hit && hit.expiresAt - now > minRemaining) {
        out[path] = hit.url;
        continue;
      }
      const groupKey = `${bucket}|${ttl}`;
      const group = groups.get(groupKey) || { ttl, paths: [] };
      group.paths.push(path);
      groups.set(groupKey, group);
    }
    for (const [groupKey, group] of groups) {
      const bucket = groupKey.slice(0, groupKey.lastIndexOf('|'));
      for (let i = 0; i < group.paths.length; i += SIGN_BATCH) {
        const chunk = group.paths.slice(i, i + SIGN_BATCH);
        const signedAt = Date.now();
        try {
          const { data, error } = await withTimeout(
            admin().storage.from(bucket).createSignedUrls(chunk, group.ttl),
            SIGN_TIMEOUT_MS,
            'Storage sign'
          );
          if (error) throw error;
          for (const entry of data || []) {
            if (!entry || entry.error || !entry.signedUrl || !entry.path) continue;
            out[entry.path] = entry.signedUrl;
            cacheSignedUrl(`${bucket}:${entry.path}|${group.ttl}`, entry.signedUrl, signedAt + group.ttl * 1000);
          }
        } catch (err) {
          // Missing/failed paths are omitted (the client shows a placeholder and can re-ask).
          logger.warn('comic_asset_sign_failed', { bucket, count: chunk.length, message: errMessage(err) });
        }
      }
    }
    return out;
  };

  // ── v5 (contract §12.5) ──

  const saveRef: AssetStore['saveRef'] = async ({ userId, projectId, encoded }) => {
    const { path, variants } = await storeEncoded({ userId, projectId, encoded, privateLane: true, registrySource: 'upload' });
    const ref: RefAsset = { path, source: 'upload', at: Date.now(), w: encoded.w, h: encoded.h };
    if (variants.length) ref.variants = variants;
    return ref;
  };

  const previewDataUrl: AssetStore['previewDataUrl'] = async (pathOrBuffer, edge) => {
    const e = clampInt(edge ?? PREVIEW_EDGE, 64, MAX_UPLOAD_EDGE, PREVIEW_EDGE);
    if (Buffer.isBuffer(pathOrBuffer)) return previewImage(pathOrBuffer, e);
    const path = pathOrBuffer;
    if (!isSafeStoragePath(path)) throw new StudioError('BAD_REQUEST', 'Invalid image path.', { status: 400 });
    const key = `${cacheKey(path)}@${e}`;
    const cached = previewCache.get(key);
    if (cached) return cached;
    const pending = previewInflight.get(key);
    if (pending) return pending;
    const work = (async () => {
      try {
        const { buffer } = await readBytes(path);
        const url = await previewImage(buffer, e);
        previewCache.set(key, url);
        return url;
      } finally {
        previewInflight.delete(key);
      }
    })();
    previewInflight.set(key, work);
    return work;
  };

  const cropRef: AssetStore['cropRef'] = async ({ userId, projectId, path, box, aspect }) => {
    assertDerivableSource(path, userId);
    const { buffer } = await readBytes(path);
    const { encoded, crop, srcW, srcH } = await cropImage(buffer, { box, aspect });
    const stored = await storeEncoded({ userId, projectId, encoded, privateLane: true, registrySource: 'derived' });
    const ref: RefAsset = {
      path: stored.path,
      source: 'derived',
      at: Date.now(),
      w: encoded.w,
      h: encoded.h,
      derivedFrom: path,
      crop,
      original: { path, w: srcW, h: srcH }
    };
    if (stored.variants.length) ref.variants = stored.variants;
    return ref;
  };

  const fitToAspect: AssetStore['fitToAspect'] = async ({ userId, projectId, path, aspect, mode }) => {
    assertDerivableSource(path, userId);
    const { buffer } = await readBytes(path);
    const encoded = await deriveFitToAspect(buffer, aspect as AspectRatio, mode);
    // A reshaped reference photo stays private; everything else lands in the art lane.
    const stored = await storeEncoded({ userId, projectId, encoded, privateLane: isPrivatePath(path), registrySource: 'derived' });
    const ref: AssetRef = { path: stored.path, source: 'derived', at: Date.now(), w: encoded.w, h: encoded.h, derivedFrom: path };
    if (stored.variants.length) ref.variants = stored.variants;
    return ref;
  };

  const ensureVariants: AssetStore['ensureVariants'] = async (asset) => {
    const path = asset?.path;
    if (!path || !canHaveVariants(path)) return [];
    const width = asset.w || 0;
    if (width && width <= VARIANT_WIDTHS[0]) return [];
    if (asset.variants?.length) {
      const have = new Set(asset.variants.map((v) => v.w));
      const want = VARIANT_WIDTHS.filter((w) => !width || w < width);
      if (want.every((w) => have.has(w))) return asset.variants.slice().sort((a, b) => a.w - b.w);
    }
    const { buffer } = await readBytes(path);
    return writeVariants(path, buffer, width || undefined);
  };

  const quarantine: AssetStore['quarantine'] = async (path, reason) => {
    if (!isSafeStoragePath(path)) throw new StudioError('BAD_REQUEST', 'Invalid image path.', { status: 400 });
    if (path.startsWith('q/')) return { quarantinePath: path };
    const owner = pathOwner(path);
    // Deterministic: a retried quarantine finds its own copy instead of making another.
    const quarantinePath = quarantinePathFor(path);
    let outcome: 'copied' | 'exists';
    try {
      outcome = await copy(path, quarantinePath);
    } catch (err) {
      // Source already gone: fine only when the quarantined copy exists.
      if (err instanceof StudioError && err.code === 'NOT_FOUND') {
        const probe = await withTimeout(admin().storage.from(privateBucket).download(quarantinePath), DOWNLOAD_TIMEOUT_MS, 'Storage download').catch(
          () => ({ data: null, error: new Error('missing') })
        );
        if (probe && !probe.error && probe.data) return { quarantinePath };
      }
      throw err;
    }
    if (outcome === 'copied' && owner && isUuid(owner.userId)) {
      const expiresAt = new Date(Date.now() + QUARANTINE_HOLD_DAYS * 24 * 3600_000).toISOString();
      await register({ userId: owner.userId, projectId: owner.projectId, path: quarantinePath, bytes: 0, source: 'quarantine', expiresAt });
    }
    // The original stops resolving (its size variants too); quarantine itself is never removed here.
    const siblings = canHaveVariants(path) ? VARIANT_WIDTHS.map((w) => variantPathFor(path, w)) : [];
    await removeObjects([path, ...siblings]);
    // Log a category only — never content (safety D10).
    logger.info('comic_asset_quarantined', { reason: String(reason || '').slice(0, 64), bucket: bucketOf(path) });
    return { quarantinePath };
  };

  const remove: AssetStore['remove'] = async (paths) => {
    const list = Array.from(new Set(paths || [])).filter(isSafeStoragePath);
    // Quarantine is a legal hold: only the retention sweep may ever delete it.
    const held = list.filter((p) => p.startsWith('q/'));
    if (held.length) logger.warn('comic_asset_remove_quarantine_refused', { count: held.length });
    const doomed = list.filter((p) => !p.startsWith('q/'));
    if (doomed.length) await removeObjects(doomed);
  };

  /**
   * HEAD on the object (service role, either bucket). storage-js answers {data:false} only for a 400/404
   * and THROWS for anything else (network, 5xx), so a returned false really means "not there".
   */
  const objectExists = async (path: string): Promise<boolean> => {
    const { data } = await withTimeout(admin().storage.from(bucketOf(path)).exists(path), STORAGE_OP_TIMEOUT_MS, 'Storage exists');
    return data === true;
  };

  /**
   * Quarantine marked these image_assets rows deleted with their objects; once the objects are back the
   * rows live again, so the retention job tracks them like any other image. Best-effort (never fails a restore).
   */
  const reinstateRows = async (paths: string[]) => {
    if (!paths.length) return;
    try {
      const { error } = await admin()
        .from('image_assets')
        .update({ deleted_at: null, expires_at: null, last_referenced_at: new Date().toISOString() })
        .in('path', paths);
      if (error) throw error;
    } catch (err) {
      logger.warn('comic_asset_reinstate_failed', { count: paths.length, message: errMessage(err) });
    }
  };

  /**
   * Bring a held object back (contract §12.5, optional method): an appeal the second opinion cleared,
   * or a moderator's restore. safety/deps.ts restoreFromQuarantine is the ONLY caller (pinned by
   * assets.test.ts) and passes the paths it recorded itself — the doc's asset path and the q/ path
   * the quarantine map holds — never anything a client sent.
   *
   *  - guard: the source is a q/ object and the destination is exactly the owner path it was taken
   *    from (quarantinePathFor); anything else is a 400 and nothing moves,
   *  - copy, then delete: the bytes go back to the original path in that path's own bucket (a
   *    reference photo returns to the PRIVATE bucket, art to the public one — no ACL ever changes, no
   *    URL is minted here); only after the copy landed is the q/ object deleted, which also marks its
   *    hold row deleted,
   *  - idempotent: a repeat after a finished restore (the hold already gone, the original back)
   *    resolves; a repeat after a half-finished one (copied, delete failed) finishes the delete,
   *  - honest: nothing held and nothing back → 404 NOT_FOUND; Storage down → 503, retryable. The caller
   *    then keeps the image hidden and says a human must finish it.
   * The original's image_assets row comes back to life and its 480/1080 variants (removed with it) are
   * rebuilt best-effort, so the doc's variant paths resolve again.
   */
  const restoreQuarantined = async (quarantinePath: string, originalPath: string): Promise<void> => {
    assertRestorePair(quarantinePath, originalPath);
    const bucket = bucketOf(originalPath);
    let outcome: 'copied' | 'exists' | 'already';
    try {
      outcome = await copy(quarantinePath, originalPath);
    } catch (err) {
      if (!(err instanceof StudioError && err.code === 'NOT_FOUND')) throw err;
      let back: boolean;
      try {
        back = await objectExists(originalPath);
      } catch (probeErr) {
        throw new StudioError('INTERNAL', "The image couldn't be restored right now. Please try again.", { status: 503, retryable: true, cause: probeErr });
      }
      if (!back) throw new StudioError('NOT_FOUND', HOLD_GONE_MESSAGE, { status: 404, cause: err });
      outcome = 'already';
    }
    if (outcome === 'exists') {
      // Something already sits at the original path (a half-finished earlier restore — or bytes
      // put there while the image was held): the held bytes win, so the verdict being restored
      // always describes the bytes that are served (S6). A repeat writes the same bytes again.
      const held = await downloadBytes(quarantinePath);
      await upload(originalPath, held.buffer, { contentType: held.type, upsert: true });
    }
    evictPath(bucket, originalPath);
    if (outcome !== 'already') {
      // The original is back, so the hold ends. A failed delete leaves a private, never-signed copy
      // under its 90-day expiry (and a repeat finishes it) — never a reason to report the restore as failed.
      await removeObjects([quarantinePath]).catch((err) => logger.warn('comic_asset_restore_cleanup_failed', { message: errMessage(err) }));
    }
    await reinstateRows([originalPath]);
    if (outcome !== 'already' && canHaveVariants(originalPath)) {
      // The variant rows come back inside the rebuild itself: a rebuild that outlives the budget still
      // lands its rows (register() keeps a quarantine-deleted row as it is, so only this un-deletes it).
      const rebuild = downloadBytes(originalPath)
        .then(async ({ buffer }) => {
          const made = await writeVariants(originalPath, buffer);
          await reinstateRows(made.map((v) => v.path));
          return made;
        })
        .catch(() => [] as AssetVariant[]);
      await withinBudget(rebuild, VARIANT_BUDGET_MS, [] as AssetVariant[]);
    }
    // Bucket and outcome only — never a path or content (safety D10).
    logger.info('comic_asset_restored', { bucket, outcome });
  };

  const copyObject: AssetStore['copyObject'] = async (srcPath, dstPath) => {
    if (!isSafeStoragePath(srcPath) || srcPath.startsWith('q/')) throw new StudioError('BAD_REQUEST', 'That image cannot be copied.', { status: 400 });
    // Copies only ever land in the opaque publication lane: never a guessable user path.
    if (!isPublicationPath(dstPath) || !isSafeStoragePath(dstPath)) {
      throw new StudioError('BAD_REQUEST', 'Copies can only be written to the publication lane.', { status: 400 });
    }
    await copy(srcPath, dstPath);
  };

  const putObject: AssetStore['putObject'] = async (path, buffer, contentType, cacheControl) => {
    if (!isSafeStoragePath(path) || !(isPublicationPath(path) || isLibraryPath(path))) {
      throw new StudioError('BAD_REQUEST', 'Objects can only be written to the publication or library lanes.', { status: 400 });
    }
    const type = normalizeUploadMime(contentType);
    if (!PUT_CONTENT_TYPES.has(type)) throw new StudioError('BAD_REQUEST', 'Only WebP, JPEG or PNG images can be stored.', { status: 415 });
    if (!Buffer.isBuffer(buffer) || !buffer.byteLength || buffer.byteLength > MAX_GENERATED_BYTES) {
      throw new StudioError('BAD_REQUEST', 'That image is empty or too large to store.', { status: 413 });
    }
    // The bytes must really be the declared image type (never markup in a public bucket).
    const sniffed = sniffImageType(buffer);
    if (`image/${sniffed}` !== type) throw new StudioError('BAD_REQUEST', "The image bytes don't match their type.", { status: 415 });
    await upload(path, buffer, { contentType: type, cacheControl: cacheControl || '31536000', upsert: true });
    evictPath(bucketOf(path), path);
  };

  const removePrefix: AssetStore['removePrefix'] = async (prefix) => {
    // Only a whole publication folder (pub/<22-char key>/) may be swept — never a user lane.
    if (typeof prefix !== 'string' || !/^pub\/[A-Za-z0-9]{22}\/$/.test(prefix)) {
      throw new StudioError('BAD_REQUEST', 'Only a publication folder can be removed.', { status: 400 });
    }
    const bucket = publicBucket;
    const folder = prefix.slice(0, -1);
    let removed = 0;
    for (let round = 0; round < REMOVE_PREFIX_MAX_ROUNDS; round += 1) {
      const { data, error } = await withTimeout(
        admin().storage.from(bucket).list(folder, { limit: REMOVE_BATCH, offset: 0, sortBy: { column: 'name', order: 'asc' } }),
        STORAGE_OP_TIMEOUT_MS,
        'Storage list'
      );
      if (error) throw new StudioError('INTERNAL', "The published copies couldn't be listed right now.", { status: 503, retryable: true, cause: error });
      const names = (data || []).filter((f) => f && typeof f.name === 'string' && f.id !== null).map((f) => `${prefix}${f.name}`);
      const safe = names.filter(isSafeStoragePath);
      if (!safe.length) break;
      const { error: rmError } = await withTimeout(admin().storage.from(bucket).remove(safe), STORAGE_OP_TIMEOUT_MS, 'Storage remove');
      if (rmError) throw new StudioError('INTERNAL', "The published copies couldn't be removed right now.", { status: 503, retryable: true, cause: rmError });
      safe.forEach((p) => evictPath(bucket, p));
      removed += safe.length;
      if (safe.length < REMOVE_BATCH) break;
    }
    return removed;
  };

  return {
    ops,
    saveGenerated,
    saveUpload,
    loadDataUrl,
    signUrls,
    outlineRegion: outlineRegionDataUrl,
    encodeUploadBuffer,
    saveRef,
    previewDataUrl,
    measureRef: measureRefImage,
    dHash: dHashImage,
    cropRef,
    fitToAspect,
    ensureVariants,
    quarantine,
    restoreQuarantined,
    remove,
    copyObject,
    putObject,
    removePrefix
  };
}

/** The v5 AssetStore methods (contract §12.5) — kept for partial test doubles that want them inert. */
type V5AssetMethods = Pick<
  AssetStore,
  | 'encodeUploadBuffer'
  | 'saveRef'
  | 'previewDataUrl'
  | 'measureRef'
  | 'dHash'
  | 'cropRef'
  | 'fitToAspect'
  | 'ensureVariants'
  | 'quarantine'
  | 'remove'
  | 'copyObject'
  | 'putObject'
  | 'removePrefix'
>;

/** Inert v5 methods (each throws NOT_AVAILABLE 501) for hand-written partial AssetStore doubles. The real stores implement them all. */
export function notAvailableAssetMethods(): V5AssetMethods {
  const na = (what: string) => async (): Promise<never> => {
    throw new StudioError('NOT_AVAILABLE', `${what} isn't available.`, { status: 501 });
  };
  return {
    encodeUploadBuffer: na('Uploading reference photos'),
    saveRef: na('Saving reference photos'),
    previewDataUrl: na('Image previews'),
    measureRef: na('Measuring reference photos'),
    dHash: na('Image fingerprints'),
    cropRef: na('Cropping reference photos'),
    fitToAspect: na('Fitting an image to its page shape'),
    ensureVariants: na('Image size variants'),
    quarantine: na('Quarantining images'),
    remove: na('Removing stored images'),
    copyObject: na('Copying stored images'),
    putObject: na('Writing stored images'),
    removePrefix: na('Removing stored images')
  };
}

// ── In-memory store (tests, local tooling) ───────────────────────────────────

export interface MemoryAssetStore extends AssetStore {
  /** path → data URL of everything stored or seeded (both buckets: the path decides the bucket). */
  readonly files: Map<string, string>;
  /** Every outlineRegion call, in order. */
  readonly outlines: { dataUrl: string; box: { x: number; y: number; w: number; h: number } }[];
  /** Every quarantine call, in order. */
  readonly quarantined: { path: string; reason: string; quarantinePath: string }[];
  /** Every restoreQuarantined call that moved an object back, in order. */
  readonly restored: { quarantinePath: string; originalPath: string }[];
  /** Every signUrls TTL actually used per path (private lanes ≤ 300 s). */
  readonly signedTtl: Record<string, number>;
  /** Seed an existing asset (e.g. a previous render) under a path. */
  put(path: string, dataUrl: string): void;
}

export function createMemoryAssetStore(): MemoryAssetStore {
  const files = new Map<string, string>();
  const outlines: MemoryAssetStore['outlines'] = [];
  const quarantined: MemoryAssetStore['quarantined'] = [];
  const restored: MemoryAssetStore['restored'] = [];
  const signedTtl: Record<string, number> = {};
  let counter = 0;

  const nextPath = (userId: string, projectId: string) => {
    counter += 1;
    return `u/${sanitizeSegment(userId || 'anon')}/p/${sanitizeSegment(projectId || 'none')}/img/mem-${counter}.webp`;
  };
  const bytesOf = (path: string): Buffer => {
    if (!isSafeStoragePath(path)) throw new StudioError('BAD_REQUEST', 'Invalid image path.', { status: 400 });
    const hit = files.get(path);
    if (!hit) throw new StudioError('NOT_FOUND', 'A reference image is missing from storage.', { status: 404 });
    return decodeImageDataUrl(hit).buffer;
  };
  const storeBuffer = async (path: string, buffer: Buffer, width?: number): Promise<AssetVariant[]> => {
    files.set(path, toDataUrl('image/webp', buffer));
    if (!canHaveVariants(path)) return [];
    try {
      const made = await variantBuffers(buffer, width);
      return made.map((v) => {
        const vPath = variantPathFor(path, v.width);
        files.set(vPath, toDataUrl('image/webp', v.buffer));
        return { path: vPath, w: v.w, h: v.h };
      });
    } catch {
      return [];
    }
  };

  const store: MemoryAssetStore = {
    files,
    outlines,
    quarantined,
    restored,
    signedTtl,
    put(path, dataUrl) {
      files.set(path, dataUrl);
    },
    async saveGenerated({ userId, projectId, dataUrl, model }) {
      decodeImageDataUrl(dataUrl);
      const path = nextPath(userId, projectId);
      files.set(path, dataUrl);
      return { path, source: 'generated', at: Date.now(), ...(model ? { model } : {}) };
    },
    async saveUpload({ userId, projectId, dataUrl }) {
      const { mimeType, buffer } = decodeImageDataUrl(dataUrl);
      if (!LEGACY_UPLOAD_MIME.has(mimeType)) throw new StudioError('BAD_REQUEST', TYPE_MESSAGE, { status: 415 });
      if (buffer.byteLength > MAX_UPLOAD_BYTES) {
        throw new StudioError('BAD_REQUEST', 'That image is larger than 10 MB. Please upload a smaller one.', { status: 413 });
      }
      const path = nextPath(userId, projectId);
      files.set(path, dataUrl);
      return { path, source: 'upload', at: Date.now() };
    },
    async loadDataUrl(path) {
      const hit = files.get(path);
      if (!hit) throw new StudioError('NOT_FOUND', 'A reference image is missing from storage.', { status: 404 });
      return hit;
    },
    async signUrls(paths, opts) {
      // Every well-formed path "signs" (docs in tests often reference unseeded assets).
      const out: Record<string, string> = {};
      const requested = clampInt(opts?.ttlSec, 30, MAX_SIGN_TTL_SECONDS, SIGNED_URL_TTL_SECONDS);
      for (const path of paths || []) {
        if (!isSafeStoragePath(path)) continue;
        const ttl = isPrivatePath(path) ? Math.min(requested, PRIVATE_SIGNED_URL_TTL_SECONDS) : requested;
        signedTtl[path] = ttl;
        out[path] = `mem://${path}`;
      }
      return out;
    },
    async outlineRegion(dataUrl, box) {
      outlines.push({ dataUrl, box });
      return dataUrl;
    },
    encodeUploadBuffer,
    async saveRef({ userId, projectId, encoded }) {
      if (!userId) throw new StudioError('FORBIDDEN', 'Sign in to save images.', { status: 401 });
      counter += 1;
      const path = buildRefPath(userId, projectId, `mem-ref-${counter}`);
      const variants = await storeBuffer(path, encoded.buffer, encoded.w);
      return { path, source: 'upload', at: Date.now(), w: encoded.w, h: encoded.h, ...(variants.length ? { variants } : {}) };
    },
    async previewDataUrl(pathOrBuffer, edge) {
      return previewImage(Buffer.isBuffer(pathOrBuffer) ? pathOrBuffer : bytesOf(pathOrBuffer), edge ?? PREVIEW_EDGE);
    },
    measureRef: measureRefImage,
    dHash: dHashImage,
    async cropRef({ userId, projectId, path, box, aspect }) {
      assertDerivableSource(path, userId);
      const { encoded, crop, srcW, srcH } = await cropImage(bytesOf(path), { box, aspect });
      counter += 1;
      const out = buildRefPath(userId, projectId, `mem-crop-${counter}`);
      const variants = await storeBuffer(out, encoded.buffer, encoded.w);
      return {
        path: out,
        source: 'derived',
        at: Date.now(),
        w: encoded.w,
        h: encoded.h,
        derivedFrom: path,
        crop,
        original: { path, w: srcW, h: srcH },
        ...(variants.length ? { variants } : {})
      };
    },
    async fitToAspect({ userId, projectId, path, aspect, mode }) {
      assertDerivableSource(path, userId);
      const encoded = await deriveFitToAspect(bytesOf(path), aspect, mode);
      counter += 1;
      const out = isPrivatePath(path) ? buildRefPath(userId, projectId, `mem-fit-${counter}`) : nextPath(userId, projectId);
      const variants = await storeBuffer(out, encoded.buffer, encoded.w);
      return { path: out, source: 'derived', at: Date.now(), w: encoded.w, h: encoded.h, derivedFrom: path, ...(variants.length ? { variants } : {}) };
    },
    async ensureVariants(asset) {
      if (!asset?.path || !canHaveVariants(asset.path)) return [];
      if (asset.w && asset.w <= VARIANT_WIDTHS[0]) return [];
      const made = await variantBuffers(bytesOf(asset.path), asset.w || undefined);
      return made.map((v) => {
        const vPath = variantPathFor(asset.path, v.width);
        files.set(vPath, toDataUrl('image/webp', v.buffer));
        return { path: vPath, w: v.w, h: v.h };
      });
    },
    async quarantine(path, reason) {
      if (!isSafeStoragePath(path)) throw new StudioError('BAD_REQUEST', 'Invalid image path.', { status: 400 });
      if (path.startsWith('q/')) return { quarantinePath: path };
      const quarantinePath = quarantinePathFor(path);
      const data = files.get(path);
      if (!data && !files.has(quarantinePath)) throw new StudioError('NOT_FOUND', 'That image is missing from storage.', { status: 404 });
      if (data) files.set(quarantinePath, data);
      files.delete(path);
      for (const w of VARIANT_WIDTHS) files.delete(variantPathFor(path, w));
      quarantined.push({ path, reason, quarantinePath });
      return { quarantinePath };
    },
    async restoreQuarantined(quarantinePath, originalPath) {
      // Same guard and semantics as the Supabase store: q/ source, its own original path, copy then delete, idempotent.
      assertRestorePair(quarantinePath, originalPath);
      const held = files.get(quarantinePath);
      if (!held) {
        if (files.has(originalPath)) return; // an earlier restore already brought it back
        throw new StudioError('NOT_FOUND', HOLD_GONE_MESSAGE, { status: 404 });
      }
      files.set(originalPath, held); // the held bytes win over anything put there meanwhile
      files.delete(quarantinePath);
      restored.push({ quarantinePath, originalPath });
      if (!canHaveVariants(originalPath)) return;
      try {
        for (const v of await variantBuffers(decodeImageDataUrl(held).buffer)) files.set(variantPathFor(originalPath, v.width), toDataUrl('image/webp', v.buffer));
      } catch {
        /* variants are a speed-up: the original size is shown instead */
      }
    },
    async remove(paths) {
      for (const p of paths || []) if (isSafeStoragePath(p) && !p.startsWith('q/')) files.delete(p);
    },
    async copyObject(srcPath, dstPath) {
      if (!isSafeStoragePath(srcPath) || srcPath.startsWith('q/')) throw new StudioError('BAD_REQUEST', 'That image cannot be copied.', { status: 400 });
      if (!isPublicationPath(dstPath) || !isSafeStoragePath(dstPath)) {
        throw new StudioError('BAD_REQUEST', 'Copies can only be written to the publication lane.', { status: 400 });
      }
      const data = files.get(srcPath);
      if (!data) throw new StudioError('NOT_FOUND', 'That image is missing from storage.', { status: 404 });
      if (!files.has(dstPath)) files.set(dstPath, data);
    },
    async putObject(path, buffer, contentType) {
      if (!isSafeStoragePath(path) || !(isPublicationPath(path) || isLibraryPath(path))) {
        throw new StudioError('BAD_REQUEST', 'Objects can only be written to the publication or library lanes.', { status: 400 });
      }
      const type = normalizeUploadMime(contentType);
      if (!PUT_CONTENT_TYPES.has(type) || `image/${sniffImageType(buffer)}` !== type) {
        throw new StudioError('BAD_REQUEST', "The image bytes don't match their type.", { status: 415 });
      }
      files.set(path, toDataUrl(type, buffer));
    },
    async removePrefix(prefix) {
      if (typeof prefix !== 'string' || !/^pub\/[A-Za-z0-9]{22}\/$/.test(prefix)) {
        throw new StudioError('BAD_REQUEST', 'Only a publication folder can be removed.', { status: 400 });
      }
      let n = 0;
      for (const p of [...files.keys()]) {
        if (p.startsWith(prefix)) {
          files.delete(p);
          n += 1;
        }
      }
      return n;
    }
  };
  return store;
}
