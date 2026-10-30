// @vitest-environment node
// derive.ts (contract §12.8): the FREE fix for "4:5 page rendered 1:1" — pad with the edge
// colour (never upscaling the long edge) or crop at most 8 %.
import { describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { MAX_FIT_CROP, cropFraction, fitToAspect, planFit } from './derive.js';

const solid = (w: number, h: number, background = '#ffffff') => sharp({ create: { width: w, height: h, channels: 3, background } }).png().toBuffer();

const pixel = async (buf: Buffer, x: number, y: number) => {
  const { data, info } = await sharp(buf).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const i = (y * info.width + x) * info.channels;
  return [data[i], data[i + 1], data[i + 2]];
};

describe('planFit (pure geometry)', () => {
  it('2048² → 4:5 pad gives 1638×2048 (long edge kept, never enlarged)', () => {
    expect(planFit(2048, 2048, '4:5', 'pad')).toEqual({ mode: 'pad', w: 1638, h: 2048, cut: 0 });
    expect(planFit(1000, 2000, '4:5', 'pad')).toMatchObject({ mode: 'pad', w: 1600, h: 2000 });
    expect(planFit(1024, 1024, '16:9', 'pad')).toMatchObject({ mode: 'pad', w: 1024, h: 576 });
  });

  it('auto crops small differences (≤ 8 %) and pads big ones', () => {
    const near = planFit(1000, 1060, '1:1', 'auto');
    expect(near).toMatchObject({ mode: 'crop', w: 1000, h: 1000, extract: { left: 0, top: 30, width: 1000, height: 1000 } });
    expect(near.cut).toBeCloseTo(1 - 1000 / 1060, 6);
    expect(planFit(2048, 2048, '4:5', 'auto').mode).toBe('pad'); // a 20 % cut is never automatic
  });

  it('refuses an explicit crop over 8 % and does nothing for a matching shape', () => {
    expect(() => planFit(2048, 2048, '4:5', 'crop')).toThrow(/20%/);
    expect(planFit(1638, 2048, '4:5', 'pad')).toEqual({ mode: 'none', w: 1638, h: 2048, cut: 0 });
    expect(cropFraction(2048, 2048, '4:5')).toBeCloseTo(0.2, 6);
    expect(cropFraction(1600, 2000, '4:5')).toBe(0);
    expect(MAX_FIT_CROP).toBe(0.08);
  });
});

describe('fitToAspect (sharp)', () => {
  it('2048² → 4:5 pad gives a 1638×2048 WebP', async () => {
    const out = await fitToAspect(await solid(2048, 2048, '#f4f1ea'), '4:5', 'pad');
    expect(out).toMatchObject({ mime: 'image/webp', w: 1638, h: 2048 });
    expect(out.bytes).toBe(out.buffer.byteLength);
    const meta = await sharp(out.buffer).metadata();
    expect([meta.format, meta.width, meta.height]).toEqual(['webp', 1638, 2048]);
  });

  it('pads with the image’s own edge colour, keeping the whole picture', async () => {
    // 400² with a dark-blue frame (40 px) around a white centre → 4:5 adds top/bottom bars.
    const frame = await sharp({ create: { width: 400, height: 400, channels: 3, background: '#102040' } })
      .composite([{ input: await solid(320, 320, '#ffffff'), left: 40, top: 40 }])
      .png()
      .toBuffer();
    const out = await fitToAspect(frame, '4:5', 'pad');
    expect([out.w, out.h]).toEqual([320, 400]);
    const [r, g, b] = await pixel(out.buffer, 160, 10); // inside the top bar
    expect(Math.abs(r - 0x10)).toBeLessThan(8);
    expect(Math.abs(g - 0x20)).toBeLessThan(8);
    expect(Math.abs(b - 0x40)).toBeLessThan(8);
    const centre = await pixel(out.buffer, 160, 200);
    expect(centre.every((c) => c > 240)).toBe(true); // the picture itself is intact
  });

  it('crops a near-match centrally and refuses big crops', async () => {
    const out = await fitToAspect(await solid(1000, 1060), '1:1', 'auto');
    expect([out.w, out.h]).toEqual([1000, 1000]);
    await expect(fitToAspect(await solid(2048, 2048), '4:5', 'crop')).rejects.toMatchObject({ code: 'BAD_REQUEST', status: 400 });
  });

  it('rejects unreadable input and unknown modes', async () => {
    await expect(fitToAspect(Buffer.from('x'), '4:5', 'pad')).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect(fitToAspect(await solid(10, 10), '4:5', 'stretch' as never)).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });
});
