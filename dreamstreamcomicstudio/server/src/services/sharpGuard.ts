// Image-input guard for the whole backend process (platform plan §9 "Existing holes fixed first", W1.10).
//
// Two layers, both local and $0:
//  1. `sniffImageType` names an image by its first bytes, never by a declared Content-Type, data-URI
//     subtype or file name. `checkImageBytes` then admits only an allowlist (JPEG, PNG, WebP and GIF for
//     the chat `convert_image` tool), so SVG, HTML, HEIC, AVIF, TIFF and anything unknown never reach sharp
//     from that tool.
//  2. `installSharpGuard` blocks libvips' risky loaders for the whole process with `sharp.block`
//     (sharp >= 0.32.4; this repo pins 0.35.5): TIFF, ImageMagick 6 and 7, PDF, JPEG 2000, FITS, OpenSlide
//     and the libvips Matrix text format. Blocking an abstract loader class blocks its File, Buffer and
//     Source subclasses. libvips ignores a name its build doesn't contain, so the list also covers a
//     global libvips with more loaders than sharp's prebuilt one (which ships only TIFF and Matrix of these).
//
// Left open on purpose: JPEG, PNG, WebP, GIF, HEIF/AVIF (comic uploads accept AVIF), SVG (the server's own
// composites: the Mark-up outline in comic/assets.ts, Model Lab fixtures, OG cards), raw pixels, created
// canvases and Pango text. Untrusted SVG never reaches sharp: every upload path sniffs it out first.
//
// server/src/index.ts imports this module once at boot, before any route module; importing it installs
// the guard (idempotent). libvips' loader lookup skips blocked loaders, so a blocked format surfaces from
// sharp as "Input buffer contains unsupported image format" (or "Input file …"), not as the word "blocked".

import sharp from 'sharp';

// ── Layer 2: process-wide loader block ───────────────────────────────────────

/**
 * libvips low-level loader operation names (the GType names sharp's api-utility docs ask for; its own
 * example is `VipsForeignLoadTiff`). Abstract base classes, so each covers File, Buffer and Source.
 */
export const SHARP_BLOCKED_LOADERS: readonly string[] = Object.freeze([
  'VipsForeignLoadTiff',
  'VipsForeignLoadMagick',
  'VipsForeignLoadMagick7',
  'VipsForeignLoadPdf',
  'VipsForeignLoadJp2k',
  'VipsForeignLoadFits',
  'VipsForeignLoadOpenslide',
  'VipsForeignLoadMatrix'
]);

export interface SharpGuardStatus {
  /** True once `sharp.block` accepted the list. */
  installed: boolean;
  /** The operation names handed to `sharp.block` (empty when it is unavailable). */
  blocked: readonly string[];
  /** Why the guard is not installed (no `sharp.block` in this build, or it threw). */
  reason?: string;
}

/** The slice of sharp the guard needs (injectable for tests). */
type SharpBlockApi = { block?: (options: { operation: string[] }) => void };

let status: SharpGuardStatus = { installed: false, blocked: [] };

/**
 * Block the risky libvips loaders for this process. Safe to call more than once. Never throws: a
 * build without `sharp.block` is reported in the returned status, and `convert_image` still refuses
 * every non-allowlisted type by its bytes.
 */
export function installSharpGuard(lib: SharpBlockApi = sharp as unknown as SharpBlockApi): SharpGuardStatus {
  if (typeof lib.block !== 'function') {
    status = { installed: false, blocked: [], reason: 'sharp.block is not available in this sharp build' };
    return status;
  }
  try {
    lib.block({ operation: [...SHARP_BLOCKED_LOADERS] });
    status = { installed: true, blocked: SHARP_BLOCKED_LOADERS };
  } catch (err) {
    status = { installed: false, blocked: [], reason: `sharp.block failed: ${err instanceof Error ? err.message : String(err)}` };
  }
  return status;
}

/** What the last `installSharpGuard` call did (the boot import makes the first one). */
export const sharpGuardStatus = (): SharpGuardStatus => status;

// ── Layer 1: magic-byte sniff and allowlist ──────────────────────────────────

/** Same union and semantics as comic/assets.ts `SniffedImageType` (drop-in; a parity test pins it). */
export type SniffedImageType = 'png' | 'jpeg' | 'gif' | 'webp' | 'avif' | 'heic' | 'svg' | 'html' | 'unknown';

const AVIF_BRANDS = new Set(['avif', 'avis']);
const HEIC_BRANDS = new Set(['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'hevm', 'hevs', 'mif1', 'msf1', 'mif2']);
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * Identify an image by its first bytes, never by the declared type or name. ISO-BMFF files are AVIF
 * only when an `avif`/`avis` brand is present; any other HEIF brand is HEIC. Text starting with `<` is
 * markup (SVG or HTML). TIFF, PDF, JPEG 2000 and everything else is `unknown`.
 */
export function sniffImageType(buf: Buffer): SniffedImageType {
  if (!Buffer.isBuffer(buf) || buf.byteLength < 4) return 'unknown';
  if (buf.byteLength >= 8 && buf.subarray(0, 8).equals(PNG_SIGNATURE)) return 'png';
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

/** What `convert_image` accepts as input, by bytes. Names match sharp's `metadata().format`. */
export const CONVERT_IMAGE_TYPES = ['jpeg', 'png', 'webp', 'gif'] as const;
export type AllowedImageType = (typeof CONVERT_IMAGE_TYPES)[number];

export type ImageBytesCheck =
  | { ok: true; type: AllowedImageType; reason?: undefined }
  | { ok: false; type: SniffedImageType; reason: string };

const LABEL: Record<AllowedImageType, string> = { jpeg: 'JPG', png: 'PNG', webp: 'WebP', gif: 'GIF' };

/** "a JPG, PNG, WebP or GIF image" for the given allowlist. */
export const allowedImageWords = (allowed: readonly AllowedImageType[] = CONVERT_IMAGE_TYPES): string => {
  const names = allowed.map((t) => LABEL[t]);
  if (names.length <= 1) return `a ${names[0] ?? 'supported'} image`;
  return `a ${names.slice(0, -1).join(', ')} or ${names[names.length - 1]} image`;
};

/**
 * Sniff `buf` and admit it only when its bytes are one of `allowed`. The refusal `reason` is a plain
 * sentence for the user (no trailing period).
 */
export function checkImageBytes(buf: Buffer, allowed: readonly AllowedImageType[] = CONVERT_IMAGE_TYPES): ImageBytesCheck {
  const type = sniffImageType(buf);
  if ((allowed as readonly string[]).includes(type)) return { ok: true, type: type as AllowedImageType };
  const use = `Use ${allowedImageWords(allowed)}`;
  switch (type) {
    case 'svg':
    case 'html':
      return { ok: false, type, reason: `SVG and HTML files can't be used as images here. ${use}` };
    case 'heic':
      return {
        ok: false,
        type,
        reason: `HEIC photos aren't supported here. Export the photo as JPEG (on iPhone: Settings › Camera › Formats › Most Compatible), or use ${allowedImageWords(allowed)}`
      };
    case 'unknown':
      return { ok: false, type, reason: `its contents aren't ${allowedImageWords(allowed)} (the type is read from the bytes, not from the name or the declared type)` };
    default:
      return { ok: false, type, reason: `${type.toUpperCase()} images can't be used here. ${use}` };
  }
}

// Installed on import: server/src/index.ts imports this module once at boot.
installSharpGuard();
