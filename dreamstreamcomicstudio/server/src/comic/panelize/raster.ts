// Raster work for one-panel fixes, region edits and flattening (pro plan §4.4 B8).
// Region edits are composited below. The remaining K2b stubs keep today's behaviour:
//   - cropForPanel → null: no `__panel__` reference can be made (a fix_panel job fails before any spend);
//   - pasteIntoCut → null: nothing is pasted (a fix_panel result is never stored as a page);
//   - bakeComposition → null.

import sharp from 'sharp';
import type { Box } from '../../../../shared/comic/doc.js';
import { decodeImageDataUrl, MAX_GENERATED_BYTES, sniffImageType } from '../assets.js';
import { MAX_REGION_PASTE_PIXELS, MAX_SOURCE_EDGE, withSharpSlot } from '../imageMeasure.js';
import { StudioError } from '../types.js';

/** Context kept around a panel's cut when it is cropped for a fix (pro plan §4.4: cut + 4%). */
export const PANEL_CROP_CONTEXT = 0.04;
/** Feather of a region paste-back (pro plan §4.4: 2%). */
export const REGION_FEATHER = 0.02;

export interface PanelCropInput {
  /** The page's current drawing. */
  dataUrl: string;
  /** The panel's cut on that drawing (image-normalized). */
  box: Box;
  context?: number;
}

/** The panel's crop of the drawing (Image 1 of a panel fix), or null. STUB: null. */
export async function cropForPanel(_input: PanelCropInput): Promise<string | null> {
  return null;
}

export interface PasteInput {
  /** The drawing pasted into (the page's current drawing, a copy: the stored one never changes). */
  base: string;
  /** What the model drew. */
  drawn: string;
  /** Where it goes (image-normalized). */
  box: Box;
}

/** The base with `drawn` covering `box` (fix_panel: the cut), or null when it can't be made. STUB: null. */
export async function pasteIntoCut(_input: PasteInput): Promise<string | null> {
  return null;
}

export interface RegionPasteInput {
  /** The page before the edit. */
  base: () => Promise<string>;
  /** The model's full edited page. */
  drawn: string;
  /** The marked region (image-normalized; bounding box for an ellipse). */
  region: Box;
  shape?: 'ellipse';
  feather?: number;
  /** Page-space bounds represented by a bounded model output; absent means the full page. */
  sourceBox?: Box;
  /** Discrete output aspect requested from the model for a bounded crop. */
  sourceAspect?: string;
}

export interface RegionPasteResult {
  /** The image to store as the new version. */
  dataUrl: string;
  /** Pasted into the region. An unavailable composite fails instead of returning the model's whole image. */
  pasted: boolean;
  /** The geometry guard moved a panel edge (IoU < 0.9): stored as a separate version instead. */
  separate?: boolean;
}

const REGION_RASTER_INPUT = { failOn: 'error' as const, limitInputPixels: MAX_REGION_PASTE_PIXELS };
const RASTER_TYPES = new Set(['png', 'jpeg', 'webp', 'avif', 'gif']);

const boundedRaster = (dataUrl: string) => {
  if (typeof dataUrl !== 'string' || dataUrl.length > Math.ceil(MAX_GENERATED_BYTES / 3) * 4 + 256) throw new Error('Oversized raster');
  const { buffer } = decodeImageDataUrl(dataUrl);
  if (buffer.length > MAX_GENERATED_BYTES || !RASTER_TYPES.has(sniffImageType(buffer))) throw new Error('Unsupported raster');
  return sharp(buffer, REGION_RASTER_INPUT);
};

const rasterSize = async (input: ReturnType<typeof sharp>) => {
  const meta = await input.metadata();
  const { width, height } = meta.autoOrient;
  if (!width || !height || width > MAX_SOURCE_EDGE || height > MAX_SOURCE_EDGE || width * height > MAX_REGION_PASTE_PIXELS || (meta.pages ?? 1) !== 1) {
    throw new Error('Unsupported raster dimensions');
  }
  return { width, height };
};

/** A little local context, clipped at the page edge; never a guessed panel boundary. */
export const panelContextBox = (box: Box): Box => {
  const x = Math.max(0, box.x - PANEL_CROP_CONTEXT), y = Math.max(0, box.y - PANEL_CROP_CONTEXT);
  return { x, y, w: Math.min(1, box.x + box.w + PANEL_CROP_CONTEXT) - x, h: Math.min(1, box.y + box.h + PANEL_CROP_CONTEXT) - y };
};

const pixelBox = (box: Box, width: number, height: number) => {
  if (![box.x, box.y, box.w, box.h].every(Number.isFinite) || box.x < 0 || box.y < 0 || box.w <= 0 || box.h <= 0 || box.x + box.w > 1.000001 || box.y + box.h > 1.000001) throw new Error('Invalid crop bounds');
  const left = Math.ceil(box.x * width - 0.5), top = Math.ceil(box.y * height - 0.5);
  const w = Math.ceil(Math.min(1, box.x + box.w) * width - 0.5) - left;
  const h = Math.ceil(Math.min(1, box.y + box.h) * height - 0.5) - top;
  if (w <= 0 || h <= 0) throw new Error('The crop contains no pixels');
  return { left, top, width: w, height: h };
};

/** Exact bounded context sent to the model, using the same pixel rounding as pasteRegion. */
export async function cropPanelContext(dataUrl: string, box: Box): Promise<string> {
  return withSharpSlot(async () => {
    const input = boundedRaster(dataUrl);
    const { width, height } = await rasterSize(input);
    const buffer = await input.autoOrient().extract(pixelBox(box, width, height)).webp({ lossless: true, effort: 1 }).timeout({ seconds: 12 }).toBuffer();
    if (buffer.length > MAX_GENERATED_BYTES) throw new Error('Panel crop exceeds the save size');
    return `data:image/webp;base64,${buffer.toString('base64')}`;
  });
}

/** Paste the edited image's corresponding pixels into a copy of the page, feathering inward only. */
export async function pasteRegion(input: RegionPasteInput): Promise<RegionPasteResult> {
  try {
    const { x, y, w, h } = input.region;
    if (![x, y, w, h].every(Number.isFinite) || x < 0 || y < 0 || w <= 0 || h <= 0 || x + w > 1.000001 || y + h > 1.000001) {
      throw new Error('Invalid edit bounds');
    }
    // Read storage before taking a Sharp slot. Only the bounded decoding/composition holds it.
    const baseUrl = await input.base();
    return await withSharpSlot(async () => {
      const base = boundedRaster(baseUrl);
      const drawn = boundedRaster(input.drawn);
      const { width, height } = await rasterSize(base);
      const edited = await rasterSize(drawn);
      const source = pixelBox(input.sourceBox ?? { x: 0, y: 0, w: 1, h: 1 }, width, height);
      const requested = input.sourceBox && input.sourceAspect?.split(':').map(Number);
      const sourceRatio = requested && requested.length === 2 && requested.every((n) => Number.isFinite(n) && n > 0) ? requested[0] / requested[1] : source.width / source.height;
      if (Math.abs(Math.log((edited.width / edited.height) / sourceRatio)) > 0.05) throw new Error('Edited image has a different shape');

      const x0 = x * width, y0 = y * height;
      const x1 = Math.min(1, x + w) * width, y1 = Math.min(1, y + h) * height;
      // Include only pixels whose centers lie inside the region. The right and bottom edges are exclusive.
      const left = Math.ceil(x0 - 0.5), top = Math.ceil(y0 - 0.5);
      const cropW = Math.ceil(x1 - 0.5) - left, cropH = Math.ceil(y1 - 0.5) - top;
      if (cropW <= 0 || cropH <= 0) throw new Error('The marked region contains no pixels');

      if (left < source.left || top < source.top || left + cropW > source.left + source.width || top + cropH > source.top + source.height) throw new Error('Panel lies outside its context');
      const { data, info } = await drawn.autoOrient().resize(source.width, source.height, { fit: 'fill' })
        .extract({ left: left - source.left, top: top - source.top, width: cropW, height: cropH }).toColourspace('srgb').ensureAlpha().raw()
        .timeout({ seconds: 12 }).toBuffer({ resolveWithObject: true });
      if (info.channels !== 4) throw new Error('Could not decode edited pixels');

      const rx = (x1 - x0) / 2, ry = (y1 - y0) / 2;
      const radius = Math.min(rx, ry);
      const feather = typeof input.feather === 'number' && Number.isFinite(input.feather) ? input.feather : REGION_FEATHER;
      // Cap the feather at half the short radius so even a small mark keeps a fully edited core.
      const featherPx = Math.min(radius / 2, Math.max(0, feather) * Math.min(width, height));
      if (input.shape === 'ellipse' || featherPx > 0) {
        for (let row = 0; row < cropH; row += 1) {
          const py = top + row + 0.5;
          const dy = (py - y0 - ry) / ry;
          const insetY = Math.min(py - y0, y1 - py);
          for (let col = 0; col < cropW; col += 1) {
            const px = left + col + 0.5;
            const edge = input.shape === 'ellipse'
              ? (1 - Math.hypot((px - x0 - rx) / rx, dy)) * radius
              : Math.min(insetY, px - x0, x1 - px);
            const mask = edge <= 0 ? 0 : featherPx ? Math.min(1, edge / featherPx) : 1;
            const alpha = (row * cropW + col) * 4 + 3;
            data[alpha] = Math.round(data[alpha] * mask);
          }
        }
      }

      const composed = await base.autoOrient()
        .composite([{ input: data, raw: { width: cropW, height: cropH, channels: 4 }, left, top }])
        .webp({ lossless: true, effort: 1 }).timeout({ seconds: 12 }).toBuffer();
      if (composed.length > MAX_GENERATED_BYTES) throw new Error('Composited page exceeds the save size');
      return { dataUrl: `data:image/webp;base64,${composed.toString('base64')}`, pasted: true };
    });
  } catch (cause) {
    throw new StudioError('NO_IMAGE', 'The edit couldn’t be placed in the marked area. The original page is unchanged.', { status: 502, retryable: true, cause });
  }
}

/** The page's frames, art and printed overlays baked into one raster (flatten, "Bring my drawn comic"). STUB: null. */
export async function bakeComposition(_input: { dataUrl: string; frames: Box[] }): Promise<string | null> {
  return null;
}
