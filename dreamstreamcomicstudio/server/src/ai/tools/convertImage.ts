import type { ChatTool } from './types.js';
import sharp from 'sharp';
import { assertSafePublicUrl } from './mcpClient.js';

// `convert_image` — deterministic, NON-AI image conversion/resizing via sharp (libvips).
// No AI touches the pixels: the model only picks the operation; sharp does the work.
// Accepts an https image URL (SSRF-guarded) or a data:image/... URI, converts between
// JPEG/PNG/WebP/AVIF and optionally resizes, and returns the result as a data URI.

const MAX_BYTES = 12 * 1024 * 1024;
const MAX_DIM = 4096;
const FORMATS = ['png', 'jpeg', 'webp', 'avif'] as const;
type Fmt = (typeof FORMATS)[number];

async function loadImage(input: string, signal?: AbortSignal): Promise<Buffer> {
  const s = input.trim();
  const m = /^data:image\/[a-z0-9.+-]+;base64,(.+)$/i.exec(s);
  if (m) {
    const buf = Buffer.from(m[1], 'base64');
    if (!buf.length) throw new Error('the data URI contained no image bytes');
    if (buf.length > MAX_BYTES) throw new Error('image is too large (max 12MB)');
    return buf;
  }
  if (/^https:\/\//i.test(s)) {
    await assertSafePublicUrl(s); // SSRF guard: https + public host + rebind-safe
    const resp = await fetch(s, { redirect: 'error', signal });
    if (!resp.ok) throw new Error(`couldn't fetch the image (HTTP ${resp.status})`);
    const ab = await resp.arrayBuffer();
    if (ab.byteLength > MAX_BYTES) throw new Error('image is too large (max 12MB)');
    return Buffer.from(ab);
  }
  throw new Error('provide an https image URL or a data:image/... URI');
}

const clampDim = (v: unknown): number | undefined => {
  if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) return undefined;
  return Math.min(MAX_DIM, Math.round(v));
};

export const convertImageTool: ChatTool = {
  name: 'convert_image',
  description:
    'Convert or resize an image deterministically (no AI) — change format between PNG/JPEG/WebP/AVIF and optionally resize. Provide the image as an https URL or a data:image/... URI. Use for "convert this jpg to png", "make a webp", "resize to 512px", "shrink this image". The converted image is returned and shown to the user.',
  parameters: {
    type: 'object',
    properties: {
      image: { type: 'string', description: 'The source image: an https URL or a data:image/...;base64 URI.' },
      to: { type: 'string', enum: ['png', 'jpeg', 'webp', 'avif'], description: 'Target format (default png).' },
      width: { type: 'number', description: 'Optional target width in px (aspect kept, never upscaled).' },
      height: { type: 'number', description: 'Optional target height in px (aspect kept, never upscaled).' },
      quality: { type: 'number', description: 'Quality 1–100 for lossy formats (jpeg/webp/avif).' }
    },
    required: ['image']
  },
  execute: async (args, signal) => {
    const a = (args ?? {}) as Record<string, unknown>;
    const image = typeof a.image === 'string' ? a.image : '';
    if (!image.trim()) return { content: 'No image was provided to convert.' };
    const to = (FORMATS.includes(a.to as Fmt) ? a.to : 'png') as Fmt;
    const width = clampDim(a.width);
    const height = clampDim(a.height);
    const quality = typeof a.quality === 'number' ? Math.max(1, Math.min(100, Math.round(a.quality))) : undefined;

    let input: Buffer;
    try {
      input = await loadImage(image, signal);
    } catch (err) {
      return { content: `Couldn't load the image: ${(err as Error).message}.`, notice: { level: 'warn', message: 'Image not loaded', fix: 'Pass an https image URL or a data:image/... URI.' } };
    }

    try {
      let pipe = sharp(input, { failOn: 'none' });
      if (width || height) pipe = pipe.resize({ width, height, fit: 'inside', withoutEnlargement: true });
      const out = await pipe.toFormat(to, quality !== undefined ? { quality } : undefined).toBuffer();
      const meta = await sharp(out).metadata();
      const kb = Math.max(1, Math.round(out.length / 1024));
      const dataUri = `data:image/${to};base64,${out.toString('base64')}`;
      return {
        content: `Converted to ${to.toUpperCase()} — ${meta.width ?? '?'}×${meta.height ?? '?'}, ${kb}KB. The image is shown to the user.`,
        images: [{ url: dataUri, title: `converted.${to === 'jpeg' ? 'jpg' : to}` }]
      };
    } catch (err) {
      return { content: `Couldn't convert the image: ${(err as Error).message}. The input may not be a supported image format.`, notice: { level: 'error', message: 'Image conversion failed' } };
    }
  }
};
