// Library image post-processing (assets.md §3.3 F, §4.5): $0 sharp work. Re-encodes a generated
// image to WebP (≤ 2048 px long edge) with @640 and @320 thumbnails, and turns texture seeds
// into seamless tiles (centre crop → mirror tile → half-offset crossfade).

import sharp from 'sharp';
import { decodeImageDataUrl } from '../assets.js';
import { SHARP_INPUT, withSharpSlot } from '../imageMeasure.js';
import { StudioError } from '../types.js';

export const LIBRARY_FULL_EDGE = 2048;
export const LIBRARY_THUMB_WIDTHS = [640, 320] as const;
export const LIBRARY_WEBP_QUALITY = 90;
export const LIBRARY_THUMB_QUALITY = 82;
/** Seamless tile edge (assets.md: 1024²). */
export const TEXTURE_TILE = 1024;

export interface EncodedLibraryImage {
  full: Buffer;
  w: number;
  h: number;
  bytes: number;
  thumbs: { 640: Buffer; 320: Buffer };
}

/**
 * Make a texture tile seamless: centre-crop a square, mirror it into a 2×2 tile (edges match by
 * construction), then blend in a half-offset copy so the mirror axes don't read as a pattern.
 */
export async function makeSeamless(input: Buffer, edge = TEXTURE_TILE): Promise<Buffer> {
  return withSharpSlot(async () => {
    const meta = await sharp(input, SHARP_INPUT).metadata();
    const w = meta.width || 0;
    const h = meta.height || 0;
    if (!w || !h) throw new StudioError('BAD_REQUEST', "The texture isn't a readable image.", { status: 400 });
    const side = Math.max(16, Math.round(Math.min(w, h) * 0.75));
    const half = Math.round(edge / 2);
    const quadrant = await sharp(input, SHARP_INPUT)
      .extract({ left: Math.floor((w - side) / 2), top: Math.floor((h - side) / 2), width: side, height: side })
      .resize(half, half, { fit: 'fill' })
      .removeAlpha()
      .toBuffer();
    const flipH = await sharp(quadrant).flop().toBuffer();
    const flipV = await sharp(quadrant).flip().toBuffer();
    const flipHV = await sharp(quadrant).flip().flop().toBuffer();
    const tile = await sharp({ create: { width: half * 2, height: half * 2, channels: 3, background: '#ffffff' } })
      .composite([
        { input: quadrant, left: 0, top: 0 },
        { input: flipH, left: half, top: 0 },
        { input: flipV, left: 0, top: half },
        { input: flipHV, left: half, top: half }
      ])
      .png()
      .toBuffer();
    // A half-offset copy (still seamless: offsets of a periodic tile stay periodic) at 50 % breaks
    // the obvious mirror symmetry around the centre lines.
    const offset = await sharp({ create: { width: half * 2, height: half * 2, channels: 3, background: '#ffffff' } })
      .composite([
        { input: flipHV, left: 0, top: 0 },
        { input: flipV, left: half, top: 0 },
        { input: flipH, left: 0, top: half },
        { input: quadrant, left: half, top: half }
      ])
      .ensureAlpha(0.5)
      .png()
      .toBuffer();
    return sharp(tile).composite([{ input: offset, blend: 'over' }]).removeAlpha().png().toBuffer();
  });
}

/** Re-encode a generated data URL for the library (+ thumbnails); texture seeds become seamless first. */
export async function encodeLibraryImage(dataUrl: string, opts: { seamless?: boolean } = {}): Promise<EncodedLibraryImage> {
  const decoded = decodeImageDataUrl(dataUrl);
  const source = opts.seamless ? await makeSeamless(decoded.buffer) : decoded.buffer;
  return withSharpSlot(async () => {
    const full = await sharp(source, SHARP_INPUT)
      .rotate()
      .resize(LIBRARY_FULL_EDGE, LIBRARY_FULL_EDGE, { fit: 'inside', withoutEnlargement: true })
      .webp({ quality: LIBRARY_WEBP_QUALITY, effort: 4 })
      .toBuffer({ resolveWithObject: true });
    const thumb = (width: number) =>
      sharp(full.data).resize({ width, withoutEnlargement: true }).webp({ quality: LIBRARY_THUMB_QUALITY, effort: 4 }).toBuffer();
    const [t640, t320] = await Promise.all([thumb(640), thumb(320)]);
    return { full: full.data, w: full.info.width, h: full.info.height, bytes: full.data.byteLength, thumbs: { 640: t640, 320: t320 } };
  });
}

/** data: URL of a WebP buffer (the vision pass reads the 640 thumbnail). */
export const webpDataUrl = (buf: Buffer): string => `data:image/webp;base64,${buf.toString('base64')}`;
