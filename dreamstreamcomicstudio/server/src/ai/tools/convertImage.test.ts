import { describe, it, expect } from 'vitest';
import sharp from 'sharp';
import { convertImageTool } from './convertImage.js';

const run = (args: Record<string, unknown>) => convertImageTool.execute(args, new AbortController().signal);

const pngDataUri = async (w = 16, h = 16): Promise<string> => {
  const buf = await sharp({ create: { width: w, height: h, channels: 3, background: { r: 200, g: 30, b: 30 } } }).png().toBuffer();
  return `data:image/png;base64,${buf.toString('base64')}`;
};
const decode = (dataUri: string): Buffer => Buffer.from(dataUri.split(',')[1], 'base64');

describe('convert_image tool', () => {
  it('converts a PNG data URI to a real JPEG', async () => {
    const res = await run({ image: await pngDataUri(), to: 'jpeg' });
    expect(res.images?.[0].url).toMatch(/^data:image\/jpeg;base64,/);
    const meta = await sharp(decode(res.images![0].url)).metadata();
    expect(meta.format).toBe('jpeg');
  });

  it('converts to webp', async () => {
    const res = await run({ image: await pngDataUri(), to: 'webp' });
    const meta = await sharp(decode(res.images![0].url)).metadata();
    expect(meta.format).toBe('webp');
  });

  it('resizes without upscaling', async () => {
    const res = await run({ image: await pngDataUri(100, 100), to: 'png', width: 20 });
    const meta = await sharp(decode(res.images![0].url)).metadata();
    expect(meta.width).toBe(20);
  });

  it('rejects input that is neither an https URL nor a data URI', async () => {
    const res = await run({ image: 'just some text' });
    expect(res.images).toBeUndefined();
    expect(res.content).toMatch(/url|data:image/i);
  });

  it('blocks private/loopback URLs (SSRF guard)', async () => {
    const res = await run({ image: 'https://127.0.0.1/x.png' });
    expect(res.images).toBeUndefined();
    expect(res.content).toMatch(/couldn't load/i);
  });

  it('errors gracefully on non-image bytes', async () => {
    const res = await run({ image: `data:image/png;base64,${Buffer.from('not an image').toString('base64')}` });
    expect(res.images).toBeUndefined();
    expect(res.notice?.level).toBe('error');
  });
});
