import type { ComicPanel } from '../types';

export const REVIEW_GROUP_SIZE = 32;
const SAMPLE_EDGE = 24;
const PREVIEW_EDGE = 420;
const MAX_BYTES = 6 * 1024 * 1024;
const WINDOW_BYTES = 32 * 1024 * 1024;
const MAX_PIXELS = 16_800_000;
const TIMEOUT_MS = 6500;

export interface PanelThumbnail {
  url: string;
  aspect: number;
  pixels: Uint8ClampedArray;
}
export interface SimilarPair { left: number; right: number; distance: number }

type ReviewPanel = Pick<ComicPanel, 'imageId' | 'imageUrl'>;
type ResolveImage = (id: string) => Promise<string | undefined>;

/** Compare corresponding pixels rather than average colours. Flat frames have too little scene detail to compare. */
export function similarPanelPairs(thumbnails: readonly (PanelThumbnail | null)[]): SimilarPair[] {
  const usable = thumbnails.map(thumb => {
    if (!thumb) return false;
    let min = 255;
    let max = 0;
    for (let i = 0; i < thumb.pixels.length; i += 4) {
      const light = (thumb.pixels[i] + thumb.pixels[i + 1] + thumb.pixels[i + 2]) / 3;
      min = Math.min(min, light);
      max = Math.max(max, light);
    }
    return max - min >= 24;
  });
  const pairs: SimilarPair[] = [];
  for (let right = 1; right < thumbnails.length; right++) {
    const b = thumbnails[right];
    if (!b || !usable[right]) continue;
    for (let left = 0; left < right; left++) {
      const a = thumbnails[left];
      if (!a || !usable[left] || Math.abs(Math.log(a.aspect / b.aspect)) > .06 || a.pixels.length !== b.pixels.length) continue;
      let diff = 0;
      for (let i = 0; i < a.pixels.length; i += 4) {
        diff += Math.abs(a.pixels[i] - b.pixels[i]) + Math.abs(a.pixels[i + 1] - b.pixels[i + 1]) + Math.abs(a.pixels[i + 2] - b.pixels[i + 2]);
      }
      const distance = diff / (a.pixels.length / 4 * 3);
      if (distance <= 9) pairs.push({ left, right, distance });
    }
  }
  return pairs.sort((a, b) => a.distance - b.distance || (a.right - a.left) - (b.right - b.left));
}

interface ByteBudget { remaining: number }

/** Older storage objects sometimes carry a generic MIME type. Only decode recognized raster bytes. */
async function rasterType(blob: Blob): Promise<string | undefined> {
  const bytes = new Uint8Array(await blob.slice(0, 32).arrayBuffer());
  const starts = (...values: number[]) => values.every((value, i) => bytes[i] === value);
  const text = String.fromCharCode(...bytes);
  if (starts(137, 80, 78, 71, 13, 10, 26, 10)) return 'image/png';
  if (starts(255, 216, 255)) return 'image/jpeg';
  if (text.startsWith('RIFF') && text.slice(8, 12) === 'WEBP') return 'image/webp';
  if (/^GIF8[79]a/.test(text)) return 'image/gif';
  if (text.slice(4, 8) === 'ftyp' && /avif|avis/.test(text.slice(8))) return 'image/avif';
  return undefined;
}

async function readRaster(source: string, signal: AbortSignal, budget: ByteBudget): Promise<Blob> {
  if (!budget.remaining) throw Error('Group size limit');
  if (source.length > MAX_BYTES * 1.4 || !/^(https?:|blob:|data:image\/|\/(?!\/))/i.test(source)) throw Error('Unsupported image');
  const response = await fetch(source, { signal, referrerPolicy: 'no-referrer', credentials: 'same-origin' });
  const type = response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() ?? '';
  const generic = !type || type === 'application/octet-stream';
  if (!response.ok || !response.body || Number(response.headers.get('content-length')) > Math.min(MAX_BYTES, budget.remaining) || (!generic && !/^image\/(png|jpe?g|webp|gif|avif)$/.test(type))) {
    await response.body?.cancel();
    throw Error('Image unavailable');
  }
  const reader = response.body.getReader();
  const chunks: ArrayBuffer[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BYTES || value.byteLength > budget.remaining) {
        await reader.cancel();
        throw Error('Image too large');
      }
      budget.remaining -= value.byteLength;
      chunks.push(new Uint8Array(value).buffer);
    }
  } finally { reader.releaseLock(); }
  const blob = new Blob(chunks, { type });
  if (!generic) return blob;
  const mime = await rasterType(blob);
  if (!mime) throw Error('Unsupported image');
  return blob.slice(0, blob.size, mime);
}

async function decodeThumbnail(blob: Blob, signal: AbortSignal): Promise<PanelThumbnail> {
  const src = URL.createObjectURL(blob);
  const image = new Image();
  image.decoding = 'async';
  try {
    await new Promise<void>((resolve, reject) => {
      const abort = () => { image.removeAttribute('src'); reject(Error('Stopped')); };
      if (signal.aborted) { abort(); return; }
      signal.addEventListener('abort', abort, { once: true });
      image.onload = () => { signal.removeEventListener('abort', abort); resolve(); };
      image.onerror = () => { signal.removeEventListener('abort', abort); reject(Error('Invalid image')); };
      image.src = src;
    });
    const { naturalWidth: w, naturalHeight: h } = image;
    if (signal.aborted || !w || !h || w * h > MAX_PIXELS) throw Error('Invalid dimensions');
    const thumb = document.createElement('canvas');
    const scale = Math.min(1, PREVIEW_EDGE / Math.max(w, h));
    thumb.width = Math.max(1, Math.round(w * scale));
    thumb.height = Math.max(1, Math.round(h * scale));
    const ctx = thumb.getContext('2d');
    if (!ctx) throw Error('Canvas unavailable');
    ctx.fillStyle = 'white';
    ctx.fillRect(0, 0, thumb.width, thumb.height);
    ctx.drawImage(image, 0, 0, thumb.width, thumb.height);
    const sample = document.createElement('canvas');
    sample.width = sample.height = SAMPLE_EDGE;
    const pixels = sample.getContext('2d', { willReadFrequently: true });
    if (!pixels) throw Error('Canvas unavailable');
    pixels.drawImage(thumb, 0, 0, SAMPLE_EDGE, SAMPLE_EDGE);
    return { url: thumb.toDataURL('image/webp', .76), aspect: w / h, pixels: pixels.getImageData(0, 0, SAMPLE_EDGE, SAMPLE_EDGE).data };
  } finally { URL.revokeObjectURL(src); }
}

async function readPanel(panel: ReviewPanel, resolveImage: ResolveImage, signal: AbortSignal, budget: ByteBudget): Promise<PanelThumbnail | null> {
  if (signal.aborted || !budget.remaining || (!panel.imageUrl && !panel.imageId)) return null;
  const controller = new AbortController();
  const stop = () => controller.abort();
  signal.addEventListener('abort', stop, { once: true });
  const timer = setTimeout(stop, TIMEOUT_MS);
  const load = async () => {
    let blob: Blob | undefined;
    if (panel.imageUrl) {
      try { blob = await readRaster(panel.imageUrl, controller.signal, budget); } catch { /* An ID can refresh an expired URL. */ }
    }
    if (!blob && panel.imageId && !controller.signal.aborted) {
      const url = await resolveImage(panel.imageId);
      if (url && url !== panel.imageUrl && !controller.signal.aborted) blob = await readRaster(url, controller.signal, budget);
    }
    return blob && !controller.signal.aborted ? decodeThumbnail(blob, controller.signal) : null;
  };
  try {
    const stopped = new Promise<null>(resolve => controller.signal.addEventListener('abort', () => resolve(null), { once: true }));
    return await Promise.race([load(), stopped]);
  } catch { return null; }
  finally { clearTimeout(timer); signal.removeEventListener('abort', stop); controller.abort(); }
}

/** A window overlaps its predecessor by one panel so every adjacent turn is reachable. */
export function reviewWindow(panels: readonly ComicPanel[], group: number) {
  const first = Math.max(0, group * REVIEW_GROUP_SIZE - (group > 0 ? 1 : 0));
  return { first, panels: panels.slice(first, (group + 1) * REVIEW_GROUP_SIZE) };
}

export async function scanPanelWindow(panels: readonly ReviewPanel[], resolveImage: ResolveImage, signal: AbortSignal, onImage: (index: number, thumb: PanelThumbnail | null) => void): Promise<void> {
  let next = 0;
  const budget = { remaining: WINDOW_BYTES };
  // The shared owner-scoped signer handles its own retries. A slow signer must not
  // create more outstanding requests when its panel preview reaches its deadline.
  let signing = 0;
  const resolveBounded: ResolveImage = async id => {
    if (signing >= 2 || signal.aborted) return undefined;
    signing++;
    try { return await resolveImage(id); } finally { signing--; }
  };
  const count = Math.min(REVIEW_GROUP_SIZE + 1, panels.length);
  const work = async () => {
    while (!signal.aborted && next < count) {
      const index = next++;
      const thumb = await readPanel(panels[index], resolveBounded, signal, budget);
      if (!signal.aborted) onImage(index, thumb);
    }
  };
  await Promise.all([work(), work()]);
}
