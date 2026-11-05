// Derived images (contract §12.8; fixes "4:5 page rendered 1:1" with a FREE fit). Owned by
// P1-STORAGE.
//
// fitToAspect reshapes an image to a page aspect without any model call:
//  - pad:  the whole picture is kept and the missing strip is filled with the image's own
//          EDGE colour (the mean of the two edges that meet the padding), so a white gutter stays
//          white and a night sky stays dark. The result keeps the source's long edge (never
//          upscaled): 2048×2048 → 4:5 is 1638×2048.
//  - crop: a centred cut, allowed only when it removes ≤ 8 % of the picture.
//  - auto: crop when the cut is ≤ 8 %, else pad.
// AssetStore.fitToAspect (assets.ts) stores the result as a NEW asset with source 'derived'.

import sharp from 'sharp';
import type { AspectRatio } from '../../../shared/comic/doc.js';
import { aspectRatioOf } from '../../../shared/comic/models.js';
import { SHARP_INPUT, withSharpSlot } from './imageMeasure.js';
import { StudioError, type EncodedImage } from './types.js';

/** Largest share of the picture a crop may remove (8 %). */
export const MAX_FIT_CROP = 0.08;
export const DERIVE_WEBP_QUALITY = 90;

export type FitMode = 'pad' | 'crop' | 'auto';

/** Fraction of the picture a centred crop to `aspect` removes (0 when the shape already matches). */
export const cropFraction = (w: number, h: number, aspect: AspectRatio): number => {
  if (!(w > 0) || !(h > 0)) return 0;
  const r = aspectRatioOf(aspect);
  const a = w / h;
  if (Math.abs(a - r) < 1e-9) return 0;
  return a > r ? 1 - (h * r) / w : 1 - w / r / h;
};

export interface FitPlan {
  mode: 'pad' | 'crop' | 'none';
  /** Output size. */
  w: number;
  h: number;
  /** crop: the extract rectangle in source pixels. */
  extract?: { left: number; top: number; width: number; height: number };
  /** Fraction of the picture removed (crop) — 0 for pad/none. */
  cut: number;
}

/**
 * Pure geometry for a fit (no I/O). Throws BAD_REQUEST when an explicit crop would cut more than
 * MAX_FIT_CROP of the picture (the caller offers padding or a redraw instead).
 */
export function planFit(w: number, h: number, aspect: AspectRatio, mode: FitMode): FitPlan {
  if (!(w > 0) || !(h > 0)) throw new StudioError('BAD_REQUEST', "That image has no readable size.", { status: 400 });
  const r = aspectRatioOf(aspect);
  const cut = cropFraction(w, h, aspect);
  // Already the requested shape to the pixel: nothing to cut or add.
  const cropW = Math.min(w, Math.round(h * r));
  const cropH = Math.min(h, Math.round(w / r));
  if (cut === 0 || (cropW === w && cropH === h)) return { mode: 'none', w, h, cut: 0 };
  const useCrop = mode === 'crop' || (mode === 'auto' && cut <= MAX_FIT_CROP);
  if (useCrop) {
    if (cut > MAX_FIT_CROP + 1e-9) {
      throw new StudioError(
        'BAD_REQUEST',
        `Cropping to ${aspect} would cut ${Math.round(cut * 100)}% of the picture — pad the edges instead, or redraw it at ${aspect}.`,
        { status: 400 }
      );
    }
    const width = w / h > r ? cropW : w;
    const height = w / h > r ? h : cropH;
    return {
      mode: 'crop',
      w: width,
      h: height,
      extract: { left: Math.floor((w - width) / 2), top: Math.floor((h - height) / 2), width, height },
      cut
    };
  }
  // Pad: keep the source's long edge, shape the canvas to the aspect, never upscale.
  const long = Math.max(w, h);
  const outW = r <= 1 ? Math.max(1, Math.round(long * r)) : long;
  const outH = r <= 1 ? long : Math.max(1, Math.round(long / r));
  return { mode: 'pad', w: outW, h: outH, cut: 0 };
}

/** Mean colour of the edges that will meet the padding (left+right for side bars, top+bottom otherwise). */
async function edgeColour(buffer: Buffer, sideBars: boolean): Promise<{ r: number; g: number; b: number }> {
  const S = 32;
  const { data } = await sharp(buffer, SHARP_INPUT)
    .flatten({ background: '#ffffff' })
    .resize(S, S, { fit: 'fill' })
    .removeAlpha()
    .toColourspace('srgb')
    .raw()
    .toBuffer({ resolveWithObject: true });
  let r = 0;
  let g = 0;
  let b = 0;
  let n = 0;
  const add = (x: number, y: number) => {
    const i = (y * S + x) * 3;
    r += data[i];
    g += data[i + 1];
    b += data[i + 2];
    n += 1;
  };
  for (let i = 0; i < S; i += 1) {
    if (sideBars) {
      add(0, i);
      add(S - 1, i);
    } else {
      add(i, 0);
      add(i, S - 1);
    }
  }
  return { r: Math.round(r / n), g: Math.round(g / n), b: Math.round(b / n) };
}

/** Reshape an image to `aspect` (pad with the edge colour, or crop ≤ 8 %). Returns WebP. */
export async function fitToAspect(buffer: Buffer, aspect: AspectRatio, mode: FitMode): Promise<EncodedImage> {
  if (!Buffer.isBuffer(buffer) || !buffer.byteLength) throw new StudioError('BAD_REQUEST', "That image is empty.", { status: 400 });
  if (mode !== 'pad' && mode !== 'crop' && mode !== 'auto') throw new StudioError('BAD_REQUEST', 'Unknown fit mode.', { status: 400 });
  return withSharpSlot(async () => {
    let w = 0;
    let h = 0;
    try {
      const meta = await sharp(buffer, SHARP_INPUT).metadata();
      w = meta.width || 0;
      h = meta.height || 0;
    } catch (err) {
      throw new StudioError('BAD_REQUEST', "That image couldn't be read.", { status: 400, cause: err });
    }
    const plan = planFit(w, h, aspect, mode);
    try {
      let pipeline = sharp(buffer, SHARP_INPUT);
      if (plan.mode === 'crop' && plan.extract) {
        pipeline = pipeline.extract(plan.extract);
      } else if (plan.mode === 'pad') {
        const bg = await edgeColour(buffer, w / h > plan.w / plan.h ? false : true);
        pipeline = pipeline
          .flatten({ background: bg })
          .resize(plan.w, plan.h, { fit: 'contain', position: 'centre', background: { ...bg, alpha: 1 } });
      }
      const { data, info } = await pipeline.webp({ quality: DERIVE_WEBP_QUALITY, effort: 4 }).toBuffer({ resolveWithObject: true });
      return { buffer: data, mime: 'image/webp', w: info.width, h: info.height, bytes: data.byteLength };
    } catch (err) {
      if (err instanceof StudioError) throw err;
      throw new StudioError('INTERNAL', "The image couldn't be reshaped right now. Please try again.", { status: 500, retryable: true, cause: err });
    }
  });
}
