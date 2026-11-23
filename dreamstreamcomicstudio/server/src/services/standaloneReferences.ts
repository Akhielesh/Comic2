import sharp, { type OverlayOptions } from 'sharp';
import { MAX_INPUT_PIXELS, MAX_SOURCE_EDGE, withSharpSlot } from '../comic/imageMeasure.js';
import { MAX_IMAGE_REFS, MAX_REF_BYTES } from '../../../shared/standaloneImage.js';
import { MAX_INLINE_ATTACHMENT_CHARS } from '../../../shared/attachmentLimits.js';

const MODEL_SLOTS = 3;
const TILE = 576;
const LABEL = 36;
const PAPER = '#f6f5ef';
const INPUT = { limitInputPixels: MAX_INPUT_PIXELS, failOn: 'error' as const };

export async function prepareStandaloneReferences(refs: unknown, signal?: AbortSignal, nativeSlots = MODEL_SLOTS): Promise<string[]> {
  const stage = <T>(work: () => Promise<T>): Promise<T> => {
    signal?.throwIfAborted();
    return withSharpSlot(() => { signal?.throwIfAborted(); return work(); });
  };
  if (!Array.isArray(refs) || refs.length > MAX_IMAGE_REFS) throw new Error('count');
  let total = 0;
  const images: Buffer[] = [];
  for (const ref of refs) {
    if (typeof ref !== 'string' || ref.length > 4 * Math.ceil(MAX_REF_BYTES / 3) + 32 ||
        (total += ref.length) > MAX_INLINE_ATTACHMENT_CHARS) throw new Error('size');
    const parts = /^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/]+={0,2})$/.exec(ref);
    if (!parts || parts[2].length % 4 !== 0) throw new Error('format');
    const bytes = Buffer.from(parts[2], 'base64');
    if (!bytes.length || bytes.length > MAX_REF_BYTES) throw new Error('size');
    await stage(async () => {
      const metadata = await sharp(bytes, INPUT).metadata();
      if (metadata.format !== parts[1] || !metadata.width || !metadata.height || metadata.width > MAX_SOURCE_EDGE || metadata.height > MAX_SOURCE_EDGE) throw new Error('format');
      if (refs.length <= nativeSlots) await sharp(bytes, INPUT).resize(1, 1).raw().toBuffer();
    });
    images.push(bytes);
  }
  if (refs.length <= nativeSlots) return refs;
  const sheets: string[] = [];
  // Divide the pictures evenly over the available slots (10 becomes 4, 3, 3).
  for (let start = 0; start < images.length;) {
    const count = Math.ceil((images.length - start) / (MODEL_SLOTS - sheets.length));
    const cols = Math.min(count, 2);
    const rows = Math.ceil(count / cols);
    const layers: OverlayOptions[] = [];
    for (let i = 0; i < count; i++) {
      const left = (i % cols) * TILE;
      const top = Math.floor(i / cols) * (TILE + LABEL);
      const image = await stage(() => sharp(images[start + i], INPUT).rotate().resize(TILE, TILE, { fit: 'contain', background: PAPER }).flatten({ background: PAPER }).jpeg({ quality: 86 }).toBuffer());
      layers.push({ input: image, left, top });
      const label = Buffer.from(`<svg width="${TILE}" height="${LABEL}" xmlns="http://www.w3.org/2000/svg"><text x="12" y="26" font-family="sans-serif" font-size="22" fill="#171717">Reference ${start + i + 1}</text></svg>`);
      layers.push({ input: label, left, top: top + TILE });
    }
    const sheet = await stage(() => sharp({ create: { width: cols * TILE, height: rows * (TILE + LABEL), channels: 3, background: PAPER } }).composite(layers).jpeg({ quality: 87 }).toBuffer());
    sheets.push('data:image/jpeg;base64,' + sheet.toString('base64'));
    start += count;
  }
  return sheets;
}
