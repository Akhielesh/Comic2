// Deterministic image measurement, $0 (contract §12.8, assets.md §4.2). Wave-0 stub by P0-B;
// owned in wave 1 by P1-STORAGE (also used by the library pipeline), which replaces
// measureImage IN PLACE.
//
// Stub behaviour: sharp METADATA only — real size, bytes and aspect check; the pixel
// statistics (luma, palette, blank, seams) are neutral placeholders until wave 1, so the
// stub never claims an image is blank.

import sharp from 'sharp';
import { aspectFromSize, aspectRatioOf } from '../../../shared/comic/models.js';
import type { AspectRatio } from '../../../shared/comic/doc.js';
import { StudioError } from './types.js';

export interface ImageMeasure {
  w: number;
  h: number;
  bytes: number;
  aspectWanted: AspectRatio;
  aspectActual: number;
  /** |log(actual / wanted)| */
  aspectError: number;
  /** aspectError < 0.04 (≈ 4 %). */
  aspectOk: boolean;
  /** 0..1 */
  meanLuma: number;
  /** Blank / near-uniform detection. */
  lumaStdev: number;
  /** lumaStdev < 0.02 (except texture seeds). */
  blank: boolean;
  /** 5 hex colours by share (median cut on a 64×64 downscale). */
  palette: string[];
  /** Texture tiles only. */
  edgeSeamDelta?: number;
}

/** Aspect error under which an image counts as the requested shape. */
export const ASPECT_OK_ERROR = 0.04;

export async function measureImage(buffer: Buffer, want?: AspectRatio, _opts?: { texture?: boolean }): Promise<ImageMeasure> {
  let w = 0;
  let h = 0;
  try {
    const meta = await sharp(buffer, { failOn: 'none', limitInputPixels: 50_000_000 }).metadata();
    w = meta.width || 0;
    h = meta.height || 0;
  } catch (err) {
    throw new StudioError('BAD_REQUEST', "That file isn't a readable image.", { status: 400, cause: err });
  }
  if (!w || !h) throw new StudioError('BAD_REQUEST', "That file isn't a readable image.", { status: 400 });
  const aspectWanted = want ?? aspectFromSize(w, h);
  const aspectActual = w / h;
  const aspectError = Math.abs(Math.log(aspectActual / aspectRatioOf(aspectWanted)));
  return {
    w,
    h,
    bytes: buffer.byteLength,
    aspectWanted,
    aspectActual,
    aspectError,
    aspectOk: aspectError < ASPECT_OK_ERROR,
    meanLuma: 0.5,
    lumaStdev: 1,
    blank: false,
    palette: []
  };
}
