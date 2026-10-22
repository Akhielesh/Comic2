// Asset storage for Comic Studio (v4): generated renders, user uploads, reference
// loading for image jobs, signed display URLs and Mark-up region outlines.
//
// Rules learned the hard way:
//  - generated images are stored exactly as the model drew them — NO cropping (the old
//    studio center-cropped panels up to 47%),
//  - every stored object gets an image_assets row so the retention job can see it, but a
//    bookkeeping failure never throws away a render the user already paid for,
//  - paths are immutable (uuid names, upsert:false), so reference data URLs and signed
//    URLs are safely cached in-process (bounded) — page N+1 reuses page N without a
//    round-trip to Storage.

import crypto from 'crypto';
import sharp from 'sharp';
import type { SupabaseClient } from '@supabase/supabase-js';
import { STORAGE_BUCKET } from '../config.js';
import { getSupabaseAdmin } from '../services/supabase.js';
import { logger } from '../lib/logger.js';
import type { AssetRef } from '../../../shared/comic/doc.js';
import { StudioError, type AssetStore } from './types.js';

/**
 * Decode limits for every image this module opens. sharp's default pixel cap (~268 MP)
 * lets a tiny, highly-compressible upload expand to gigabytes and take down the single
 * 1 GiB backend; 50 MP comfortably covers 4K renders (≈16 MP) and phone photos.
 */
const MAX_INPUT_PIXELS = 50_000_000;
const MAX_UPLOAD_SOURCE_EDGE = 12_000;
const SHARP_INPUT = { failOn: 'none' as const, limitInputPixels: MAX_INPUT_PIXELS };

// ── Limits ───────────────────────────────────────────────────────────────────

export const WEBP_QUALITY = 90;
export const WEBP_EFFORT = 4;
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
export const MAX_UPLOAD_EDGE = 2048;
/** Generated renders can be large (4K pages); refuse absurd payloads before decoding. */
const MAX_GENERATED_BYTES = 40 * 1024 * 1024;
export const SIGNED_URL_TTL_SECONDS = 3600;
const SIGN_TIMEOUT_MS = 12_000;
const SIGN_BATCH = 100;
/** Re-sign when less than this much validity remains (clients may hold URLs a while). */
const SIGNED_URL_MIN_REMAINING_MS = 10 * 60_000;
const SIGNED_URL_CACHE_MAX = 4000;
const DOWNLOAD_TIMEOUT_MS = 30_000;
const UPLOAD_TIMEOUT_MS = 45_000;
export const DATA_URL_CACHE_MAX_ENTRIES = 48;
export const DATA_URL_CACHE_MAX_BYTES = 96 * 1024 * 1024;
const STORAGE_PATH_MAX_LENGTH = 512;

const UPLOAD_MIME = new Set(['image/png', 'image/jpeg', 'image/jpg', 'image/pjpeg', 'image/webp', 'image/gif']);
const UPLOAD_FORMATS = new Set(['png', 'jpeg', 'jpg', 'webp', 'gif']);

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
};

// ── Shared caches (module-level: stores are created per request) ─────────────

const dataUrlCache = new DataUrlLru();
const dataUrlInflight = new Map<string, Promise<string>>();
const signedUrlCache = new Map<string, { url: string; expiresAt: number }>();

/** Test hook. */
export const __resetAssetCachesForTests = (): void => {
  dataUrlCache.clear();
  dataUrlInflight.clear();
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

// ── Supabase store ───────────────────────────────────────────────────────────

export interface SupabaseAssetStoreOptions {
  bucket?: string;
  /** Admin client factory (tests inject a fake). */
  admin?: () => SupabaseClient;
}

type EncodedImage = { data: Buffer; width?: number; height?: number };

export function createSupabaseAssetStore(opts: SupabaseAssetStoreOptions = {}): AssetStore {
  const bucket = opts.bucket || STORAGE_BUCKET;
  const admin = opts.admin || getSupabaseAdmin;
  const cacheKey = (path: string) => `${bucket}:${path}`;

  const uploadOnce = async (path: string, data: Buffer) => {
    const { error } = await withTimeout(
      admin().storage.from(bucket).upload(path, data, { contentType: 'image/webp', cacheControl: '31536000', upsert: false }),
      UPLOAD_TIMEOUT_MS,
      'Storage upload'
    );
    if (error) throw error;
  };

  /** Upload with one retry; a hiccup must not cost the user a paid render. */
  const upload = async (path: string, data: Buffer) => {
    try {
      await uploadOnce(path, data);
    } catch (first) {
      logger.warn('comic_asset_upload_retry', { path, message: (first as Error)?.message });
      try {
        await uploadOnce(path, data);
      } catch (err) {
        // The first attempt may have landed after all (timeout racing a slow success).
        if (/already exists|duplicate/i.test(String((err as Error)?.message || ''))) return;
        logger.error('comic_asset_upload_failed', { path, message: (err as Error)?.message });
        throw new StudioError('INTERNAL', "The image was created but couldn't be saved. Please try again.", {
          status: 503,
          retryable: true,
          cause: err
        });
      }
    }
  };

  /** image_assets row so the retention job tracks the object; failures are logged, never thrown. */
  const registerAsset = async (args: {
    id: string;
    userId: string;
    projectId: string;
    path: string;
    bytes: number;
    width?: number;
    height?: number;
    source: string;
  }) => {
    const row = {
      id: args.id,
      user_id: args.userId,
      project_id: isUuid(args.projectId) ? args.projectId : null,
      bucket,
      path: args.path,
      mime_type: 'image/webp',
      bytes: args.bytes,
      width: args.width || null,
      height: args.height || null,
      source: args.source,
      created_at: new Date().toISOString(),
      last_referenced_at: new Date().toISOString(),
      expires_at: null,
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
          logger.error('comic_asset_register_failed', { path: args.path, message: (err as Error)?.message });
        }
      }
    }
  };

  const store = async (args: {
    userId: string;
    projectId: string;
    encoded: EncodedImage;
    source: 'generated' | 'upload';
    registrySource: string;
    model?: string;
  }): Promise<AssetRef> => {
    if (!args.userId) throw new StudioError('FORBIDDEN', 'Sign in to save images.', { status: 401 });
    const id = crypto.randomUUID();
    const path = buildAssetPath(args.userId, args.projectId, id);
    await upload(path, args.encoded.data);
    await registerAsset({
      id,
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
    return ref;
  };

  const saveGenerated: AssetStore['saveGenerated'] = async ({ userId, projectId, dataUrl, model }) => {
    const { buffer } = decodeImageDataUrl(dataUrl);
    if (buffer.byteLength > MAX_GENERATED_BYTES) {
      throw new StudioError('NO_IMAGE', 'The image model returned an oversized image. Please try again.', { status: 502, retryable: true });
    }
    let encoded: EncodedImage;
    try {
      const { data, info } = await sharp(buffer, SHARP_INPUT)
        .webp({ quality: WEBP_QUALITY, effort: WEBP_EFFORT })
        .toBuffer({ resolveWithObject: true });
      encoded = { data, width: info.width, height: info.height };
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

  const download = async (path: string): Promise<string> => {
    const controller = new AbortController();
    try {
      const { data, error } = await withTimeout(
        admin().storage.from(bucket).download(path, undefined, { signal: controller.signal }),
        DOWNLOAD_TIMEOUT_MS,
        'Storage download'
      );
      if (error || !data) throw error || new Error('Empty download');
      const buffer = Buffer.from(await (data as Blob).arrayBuffer());
      if (!buffer.byteLength) throw new Error('Empty download');
      const type = typeof (data as Blob).type === 'string' && (data as Blob).type.startsWith('image/') ? (data as Blob).type : mimeFromPath(path);
      return toDataUrl(type, buffer);
    } catch (err) {
      controller.abort();
      const status = Number((err as { status?: unknown; statusCode?: unknown })?.statusCode ?? (err as { status?: unknown })?.status);
      const message = String((err as Error)?.message || '');
      if (status === 400 || status === 404 || /not.?found|does not exist|object not found/i.test(message)) {
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

  const loadDataUrl: AssetStore['loadDataUrl'] = async (path) => {
    if (!isSafeStoragePath(path)) throw new StudioError('BAD_REQUEST', 'Invalid image path.', { status: 400 });
    const key = cacheKey(path);
    const cached = dataUrlCache.get(key);
    if (cached) return cached;
    const pending = dataUrlInflight.get(key);
    if (pending) return pending;
    const work = (async () => {
      try {
        const dataUrl = await download(path);
        dataUrlCache.set(key, dataUrl);
        return dataUrl;
      } finally {
        dataUrlInflight.delete(key);
      }
    })();
    dataUrlInflight.set(key, work);
    return work;
  };

  const signUrls: AssetStore['signUrls'] = async (paths) => {
    const out: Record<string, string> = {};
    const now = Date.now();
    const todo: string[] = [];
    for (const path of Array.from(new Set(paths || []))) {
      if (!isSafeStoragePath(path)) continue;
      const hit = signedUrlCache.get(cacheKey(path));
      if (hit && hit.expiresAt - now > SIGNED_URL_MIN_REMAINING_MS) out[path] = hit.url;
      else todo.push(path);
    }
    for (let i = 0; i < todo.length; i += SIGN_BATCH) {
      const chunk = todo.slice(i, i + SIGN_BATCH);
      const signedAt = Date.now();
      try {
        const { data, error } = await withTimeout(
          admin().storage.from(bucket).createSignedUrls(chunk, SIGNED_URL_TTL_SECONDS),
          SIGN_TIMEOUT_MS,
          'Storage sign'
        );
        if (error) throw error;
        for (const entry of data || []) {
          if (!entry || entry.error || !entry.signedUrl || !entry.path) continue;
          out[entry.path] = entry.signedUrl;
          cacheSignedUrl(cacheKey(entry.path), entry.signedUrl, signedAt + SIGNED_URL_TTL_SECONDS * 1000);
        }
      } catch (err) {
        // Missing/failed paths are omitted (the client shows a placeholder and can re-ask).
        logger.warn('comic_asset_sign_failed', { count: chunk.length, message: (err as Error)?.message });
      }
    }
    return out;
  };

  return {
    saveGenerated,
    saveUpload,
    loadDataUrl,
    signUrls,
    outlineRegion: outlineRegionDataUrl
  };
}

/** Validate + normalize a user upload: real image content, ≤10 MB, long edge ≤2048, upright, WebP. */
export const encodeUpload = async (dataUrl: string): Promise<EncodedImage> => {
  const { mimeType, buffer } = decodeImageDataUrl(dataUrl);
  if (!UPLOAD_MIME.has(mimeType)) {
    throw new StudioError('BAD_REQUEST', 'Upload a PNG, JPEG, WebP or GIF image.', { status: 400 });
  }
  if (buffer.byteLength > MAX_UPLOAD_BYTES) {
    throw new StudioError('BAD_REQUEST', 'That image is larger than 10 MB. Please upload a smaller one.', { status: 413 });
  }
  let format: string | undefined;
  try {
    const meta = await sharp(buffer, SHARP_INPUT).metadata();
    format = meta.format;
    const w = meta.width || 0;
    const h = meta.height || 0;
    if (w * h > MAX_INPUT_PIXELS || w > MAX_UPLOAD_SOURCE_EDGE || h > MAX_UPLOAD_SOURCE_EDGE) {
      throw new StudioError('BAD_REQUEST', 'That image is too large in pixels. Please upload one under 50 megapixels.', { status: 413 });
    }
  } catch (err) {
    if (err instanceof StudioError) throw err;
    if (/pixel limit/i.test(String((err as Error)?.message))) {
      throw new StudioError('BAD_REQUEST', 'That image is too large in pixels. Please upload one under 50 megapixels.', { status: 413, cause: err });
    }
    throw new StudioError('BAD_REQUEST', "That file isn't a readable image.", { status: 400, cause: err });
  }
  if (!format || !UPLOAD_FORMATS.has(format)) {
    throw new StudioError('BAD_REQUEST', 'Upload a PNG, JPEG, WebP or GIF image.', { status: 400 });
  }
  try {
    const { data, info } = await sharp(buffer, SHARP_INPUT)
      .rotate() // honour EXIF orientation (phone photos)
      .resize({ width: MAX_UPLOAD_EDGE, height: MAX_UPLOAD_EDGE, fit: 'inside', withoutEnlargement: true })
      .webp({ quality: WEBP_QUALITY, effort: WEBP_EFFORT })
      .toBuffer({ resolveWithObject: true });
    return { data, width: info.width, height: info.height };
  } catch (err) {
    throw new StudioError('BAD_REQUEST', "That image couldn't be processed. Try a different file.", { status: 400, cause: err });
  }
};

// ── In-memory store (tests, local tooling) ───────────────────────────────────

export interface MemoryAssetStore extends AssetStore {
  /** path → data URL of everything stored or seeded. */
  readonly files: Map<string, string>;
  /** Every outlineRegion call, in order. */
  readonly outlines: { dataUrl: string; box: { x: number; y: number; w: number; h: number } }[];
  /** Seed an existing asset (e.g. a previous render) under a path. */
  put(path: string, dataUrl: string): void;
}

export function createMemoryAssetStore(): MemoryAssetStore {
  const files = new Map<string, string>();
  const outlines: MemoryAssetStore['outlines'] = [];
  let counter = 0;

  const nextPath = (userId: string, projectId: string) => {
    counter += 1;
    return `u/${sanitizeSegment(userId || 'anon')}/p/${sanitizeSegment(projectId || 'none')}/img/mem-${counter}.webp`;
  };

  return {
    files,
    outlines,
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
      if (!UPLOAD_MIME.has(mimeType)) throw new StudioError('BAD_REQUEST', 'Upload a PNG, JPEG, WebP or GIF image.', { status: 400 });
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
    async signUrls(paths) {
      // Every well-formed path "signs" (docs in tests often reference unseeded assets).
      const out: Record<string, string> = {};
      for (const path of paths || []) if (isSafeStoragePath(path)) out[path] = `mem://${path}`;
      return out;
    },
    async outlineRegion(dataUrl, box) {
      outlines.push({ dataUrl, box });
      return dataUrl;
    }
  };
}
