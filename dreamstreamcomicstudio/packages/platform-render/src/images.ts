/**
 * Images for the renderers: `data:` images we already hold, never a path or a URL (plan §9). A host asset id is
 * turned into a `data:` image by the host's own resolver (its own storage, its own auth); the renderer only ever sees
 * bytes. Every `data:` image is checked by the contract's own `s.assetRef()` rule (PNG, JPEG or WebP, magic bytes
 * match the MIME type, at most 5 MB decoded) before a byte of it is used.
 *
 * Pure: base64, the magic-byte sniff and the size readers are written here, so nothing depends on `atob`, `Buffer`
 * or a DOM.
 */
import type { AssetRef } from '../../platform-core/src/contract/schema.js';
import { SCHEMA_LIMITS } from '../../platform-core/src/contract/schema.js';
import { check, s } from '../../platform-core/src/schema/index.js';
import { RenderError } from './errors.js';

export type ImageMime = 'image/png' | 'image/jpeg' | 'image/webp';

/**
 * The host's lookup for `{kind: 'asset', id}` refs: the image as a `data:` URI from the host's own storage, or
 * `null` when it has none. The renderer validates whatever comes back exactly like an inline `data:` image.
 */
export type AssetResolver = (id: string) => string | null | undefined | Promise<string | null | undefined>;

/**
 * Re-encodes an image the output format cannot carry (WebP, in DOCX and PPTX) as PNG or JPEG. In the browser,
 * services/platformExport.ts passes a canvas-based one; without one, a WebP image is refused as `unsupported`.
 */
export type ImageTranscoder = (image: { bytes: Uint8Array; mime: ImageMime }) => Promise<{ bytes: Uint8Array; mime: 'image/png' | 'image/jpeg' }>;

export interface ImageOptions {
  resolveAsset?: AssetResolver;
  transcode?: ImageTranscoder;
}

export interface PreparedImage {
  mime: 'image/png' | 'image/jpeg';
  bytes: Uint8Array;
  /** `data:<mime>;base64,…` of `bytes`. */
  dataUri: string;
  /** Pixel size read from the file header; absent when the header could not be read. */
  width?: number;
  height?: number;
}

// ── base64 ──────────────────────────────────────────────────────────────────────────────────────────────────────

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const B64_INDEX: number[] = (() => {
  const out: number[] = [];
  for (let i = 0; i < 256; i++) out.push(-1);
  for (let i = 0; i < B64.length; i++) out[B64.charCodeAt(i)] = i;
  return out;
})();

/** Standard base64 (padding optional) to bytes; `null` for anything that is not base64. */
export const decodeBase64 = (text: string): Uint8Array | null => {
  let end = text.length;
  while (end > 0 && text.charCodeAt(end - 1) === 61 /* = */) end--;
  if (text.length - end > 2 || end % 4 === 1) return null;
  const out = new Uint8Array(Math.floor((end * 3) / 4));
  let acc = 0;
  let bits = 0;
  let o = 0;
  for (let i = 0; i < end; i++) {
    const c = text.charCodeAt(i);
    const v = c < 256 ? B64_INDEX[c] : -1;
    if (v < 0) return null;
    acc = (acc << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[o++] = (acc >> bits) & 0xff;
    }
  }
  return out;
};

export const encodeBase64 = (bytes: Uint8Array): string => {
  let out = '';
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
    out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63] + B64[(n >> 6) & 63] + B64[n & 63];
  }
  const rest = bytes.length - i;
  if (rest === 1) {
    const n = bytes[i] << 16;
    out += `${B64[(n >> 18) & 63]}${B64[(n >> 12) & 63]}==`;
  } else if (rest === 2) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8);
    out += `${B64[(n >> 18) & 63]}${B64[(n >> 12) & 63]}${B64[(n >> 6) & 63]}=`;
  }
  return out;
};

// ── Sniffing and sizes ──────────────────────────────────────────────────────────────────────────────────────────

/** The MIME type the bytes really are (PNG, JPEG or WebP), else `null`. */
export const sniffImage = (b: Uint8Array): ImageMime | null => {
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a) return 'image/png';
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length >= 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return 'image/webp';
  return null;
};

const u16be = (b: Uint8Array, i: number): number => (b[i] << 8) | b[i + 1];
const u32be = (b: Uint8Array, i: number): number => ((b[i] << 24) >>> 0) + (b[i + 1] << 16) + (b[i + 2] << 8) + b[i + 3];
const u16le = (b: Uint8Array, i: number): number => b[i] | (b[i + 1] << 8);
const u24le = (b: Uint8Array, i: number): number => b[i] | (b[i + 1] << 8) | (b[i + 2] << 16);

/** Width and height from the file header (PNG IHDR, JPEG SOFn, WebP VP8/VP8L/VP8X), else `null`. Never throws. */
export const imageSize = (b: Uint8Array, mime: ImageMime): { width: number; height: number } | null => {
  let w = 0;
  let h = 0;
  if (mime === 'image/png') {
    if (b.length < 24) return null;
    w = u32be(b, 16);
    h = u32be(b, 20);
  } else if (mime === 'image/jpeg') {
    let i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) return null;
      const marker = b[i + 1];
      if (marker === 0xff) {
        i++;
        continue;
      }
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
        i += 2;
        continue;
      }
      if (marker === 0xd9 || marker === 0xda) return null;
      const len = u16be(b, i + 2);
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        h = u16be(b, i + 5);
        w = u16be(b, i + 7);
        break;
      }
      if (len < 2) return null;
      i += 2 + len;
    }
  } else {
    if (b.length < 30) return null;
    const chunk = String.fromCharCode(b[12], b[13], b[14], b[15]);
    if (chunk === 'VP8 ') {
      w = u16le(b, 26) & 0x3fff;
      h = u16le(b, 28) & 0x3fff;
    } else if (chunk === 'VP8L') {
      const bits = b[21] | (b[22] << 8) | (b[23] << 16) | (b[24] << 24);
      w = (bits & 0x3fff) + 1;
      h = ((bits >> 14) & 0x3fff) + 1;
    } else if (chunk === 'VP8X') {
      w = u24le(b, 24) + 1;
      h = u24le(b, 27) + 1;
    }
  }
  return w > 0 && h > 0 && w <= 100000 && h <= 100000 ? { width: w, height: h } : null;
};

/**
 * A re-encoded image may be bigger than the WebP it came from (PNG is lossless): up to 4 × the 5 MB input cap, so a
 * transcoder cannot balloon a file without bound.
 */
export const TRANSCODED_MAX_BYTES = 4 * SCHEMA_LIMITS.assetDataMaxBytes;

/**
 * The most a WebP image may declare before it is decoded for transcoding (plan §9's normalize limits): 12,000 px on a
 * side and 50 megapixels. A few kilobytes of WebP can declare 16,383 × 16,383 px, about 1 GiB of pixels on a canvas,
 * which would crash a phone's tab long before any byte cap applied.
 */
export const IMAGE_MAX_SIDE = 12000;
export const IMAGE_MAX_PIXELS = 50000000;

// ── Preparing one image ─────────────────────────────────────────────────────────────────────────────────────────

const DATA_REF = s.assetRef();

/** Checks a `data:` URI with the contract's rule and decodes it, or throws `RenderError`. */
export const readDataImage = (dataUri: unknown, where: string): { mime: ImageMime; bytes: Uint8Array } => {
  if (typeof dataUri !== 'string' || dataUri.lastIndexOf('data:', 0) !== 0) {
    throw new RenderError('blocked', `${where}: only data: images we already hold are used; paths and URLs are never read`);
  }
  const r = check(DATA_REF, { kind: 'data', dataUri });
  if (r.ok === false) {
    const codes = r.errors.map((e) => e.code);
    if (codes.indexOf('asset-too-large') !== -1) {
      throw new RenderError('too-large', `${where}: the image is over ${SCHEMA_LIMITS.assetDataMaxBytes / 1000000} MB`);
    }
    if (!/^data:image\/(png|jpeg|webp);base64,/.test(dataUri)) {
      throw new RenderError('blocked', `${where}: only PNG, JPEG or WebP data: images are used`);
    }
    throw new RenderError('invalid', `${where}: the image is not a valid PNG, JPEG or WebP data: image`);
  }
  const comma = dataUri.indexOf(',');
  const bytes = decodeBase64(dataUri.slice(comma + 1));
  const mime = bytes ? sniffImage(bytes) : null;
  if (!bytes || !mime) throw new RenderError('invalid', `${where}: the image is not a valid PNG, JPEG or WebP data: image`);
  return { mime, bytes };
};

/** One render's image pipeline: resolve, check, transcode, measure; each distinct source is prepared once. */
export const imagePreparer = (opts: ImageOptions): ((ref: AssetRef, where: string) => Promise<PreparedImage>) => {
  const cache = new Map<string, Promise<PreparedImage>>();
  const prepare = async (ref: AssetRef, where: string): Promise<PreparedImage> => {
    let dataUri: unknown;
    if (ref && ref.kind === 'data') dataUri = ref.dataUri;
    else if (ref && ref.kind === 'asset') {
      if (!opts.resolveAsset) throw new RenderError('asset-missing', `${where}: the image ${ref.id} is stored by the app, and no lookup was given`);
      const found = await opts.resolveAsset(ref.id);
      if (found === null || found === undefined) throw new RenderError('asset-missing', `${where}: the image ${ref.id} could not be found`);
      dataUri = found;
    } else throw new RenderError('invalid', `${where}: an image needs a data: image or an asset id`);
    let { mime, bytes } = readDataImage(dataUri, where);
    if (mime === 'image/webp') {
      if (!opts.transcode) throw new RenderError('unsupported', `${where}: WebP images need converting to PNG or JPEG first`);
      // Measure from the header before anything decodes it: refuse what would not fit in memory.
      const declared = imageSize(bytes, mime);
      if (!declared) throw new RenderError('unsupported', `${where}: the WebP image's size could not be read, so it is not converted`);
      if (declared.width > IMAGE_MAX_SIDE || declared.height > IMAGE_MAX_SIDE || declared.width * declared.height > IMAGE_MAX_PIXELS) {
        throw new RenderError(
          'too-large',
          `${where}: the image is ${declared.width.toLocaleString('en-US')} × ${declared.height.toLocaleString('en-US')} px, over the ${IMAGE_MAX_SIDE.toLocaleString('en-US')} px a side or ${IMAGE_MAX_PIXELS / 1000000} megapixels that can be converted`,
        );
      }
      const out = await opts.transcode({ bytes, mime });
      const real = out && out.bytes instanceof Uint8Array ? sniffImage(out.bytes) : null;
      if (!real || real === 'image/webp' || real !== out.mime) throw new RenderError('unsupported', `${where}: the WebP image could not be converted`);
      if (out.bytes.length > TRANSCODED_MAX_BYTES) throw new RenderError('too-large', `${where}: the converted image is over ${TRANSCODED_MAX_BYTES / 1000000} MB`);
      mime = real;
      bytes = out.bytes;
    }
    const size = imageSize(bytes, mime);
    const prepared: PreparedImage = { mime: mime as 'image/png' | 'image/jpeg', bytes, dataUri: `data:${mime};base64,${encodeBase64(bytes)}` };
    if (size) {
      prepared.width = size.width;
      prepared.height = size.height;
    }
    return prepared;
  };
  return (ref, where) => {
    const key = ref && ref.kind === 'asset' ? `a:${ref.id}` : ref && ref.kind === 'data' && typeof ref.dataUri === 'string' ? `d:${ref.dataUri}` : '';
    if (!key) return prepare(ref, where);
    let hit = cache.get(key);
    if (!hit) {
      hit = prepare(ref, where);
      cache.set(key, hit);
    }
    return hit;
  };
};
