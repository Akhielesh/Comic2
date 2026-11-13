// @vitest-environment node
import sharp from 'sharp';
import { describe, expect, it, vi } from 'vitest';
import { decodeImageDataUrl } from '../assets.js';
import { cropPanelContext, panelContextBox, pasteRegion } from './raster.js';

const ORIGINAL = [27, 83, 149, 255];
const EDITED = [197, 107, 44, 255];
const dataUrl = (buffer: Buffer) => `data:image/png;base64,${buffer.toString('base64')}`;
const solid = async (color: number[], width = 100, height = 100) => dataUrl(await sharp({
  create: { width, height, channels: 4, background: { r: color[0], g: color[1], b: color[2], alpha: color[3] / 255 } }
}).png().toBuffer());
const read = async (url: string) => {
  const { data, info } = await sharp(decodeImageDataUrl(url).buffer).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const pixel = (x: number, y: number) => [...data.subarray((y * info.width + x) * 4, (y * info.width + x) * 4 + 4)];
  return { ...info, pixel };
};

describe('pasteRegion', () => {
  it('takes matching normalized pixels from the full edited page, at the base dimensions, without touching the rest', async () => {
    const width = 200, height = 200;
    const input = Buffer.alloc(width * height * 3);
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const i = (y * width + x) * 3;
        input[i] = x;
        input[i + 1] = y;
        input[i + 2] = 220;
      }
    }
    const drawn = dataUrl(await sharp(input, { raw: { width, height, channels: 3 } }).png().toBuffer());
    const base = await solid(ORIGINAL);
    const result = await pasteRegion({ base: async () => base, drawn, region: { x: 0.2, y: 0.3, w: 0.4, h: 0.4 }, feather: 0 });
    const out = await read(result.dataUrl);
    expect(result.pasted).toBe(true);
    expect([out.width, out.height]).toEqual([100, 100]);
    const center = out.pixel(35, 45);
    expect(Math.abs(center[0] - 70)).toBeLessThan(3);
    expect(Math.abs(center[1] - 90)).toBeLessThan(3);
    expect(center[2]).toBe(220);
    for (let y = 0; y < out.height; y += 1) {
      for (let x = 0; x < out.width; x += 1) {
        if (x >= 20 && x < 60 && y >= 30 && y < 70) continue;
        if (out.pixel(x, y).some((channel, i) => channel !== ORIGINAL[i])) throw new Error(`Outside pixel changed at ${x},${y}`);
      }
    }
  });

  it('keeps pixels outside the ellipse, including box corners, and feathers only toward the center', async () => {
    const base = await solid(ORIGINAL, 100, 200);
    const drawn = await solid(EDITED, 100, 200);
    const result = await pasteRegion({ base: async () => base, drawn, region: { x: 0.2, y: 0.2, w: 0.6, h: 0.3 }, shape: 'ellipse', feather: 0.05 });
    const { pixel } = await read(result.dataUrl);
    expect(pixel(50, 70)).toEqual(EDITED);
    expect(pixel(20, 40)).toEqual(ORIGINAL);
    expect(pixel(79, 99)).toEqual(ORIGINAL);
    expect(pixel(19, 70)).toEqual(ORIGINAL);
    expect(pixel(50, 39)).toEqual(ORIGINAL);
    expect(pixel(50, 41)[0]).toBeGreaterThan(ORIGINAL[0]);
    expect(pixel(50, 41)[0]).toBeLessThan(EDITED[0]);
  });

  it('rejects an invalid mark before reading storage and never returns an unscoped or unreadable result', async () => {
    const original = await solid(ORIGINAL);
    const base = vi.fn(async () => original);
    const region = { x: 0.2, y: 0.2, w: 0.6, h: 0.6 };
    const assertFailure = (input: Parameters<typeof pasteRegion>[0]) => expect(pasteRegion(input)).rejects.toMatchObject({ code: 'NO_IMAGE', userMessage: expect.stringContaining('original page is unchanged') });
    await assertFailure({ base, drawn: original, region: { ...region, w: 0.9 } });
    expect(base).not.toHaveBeenCalled();
    await assertFailure({ base, drawn: 'data:image/png;base64,PHN2Zz4=', region });
    await assertFailure({ base, drawn: await solid(EDITED, 200, 100), region });
    await assertFailure({ base: async () => { throw new Error('Storage timed out'); }, drawn: original, region });
  });
});


describe('bounded panel crop', () => {
  it('crops nearby context and pastes only the selected panel, including fractional edges', async () => {
    const base = await solid(ORIGINAL, 100, 100);
    const panel = { x: 0.205, y: 0.305, w: 0.4, h: 0.3 };
    const sourceBox = panelContextBox(panel);
    const crop = await read(await cropPanelContext(base, sourceBox));
    expect([crop.width, crop.height]).toEqual([48, 38]);
    const drawn = await solid(EDITED, 48, 38);
    const out = await read((await pasteRegion({ base: async () => base, drawn, region: panel, sourceBox, feather: 0 })).dataUrl);
    for (let y = 0; y < 100; y += 1) for (let x = 0; x < 100; x += 1) {
      const inside = x >= 20 && x < 60 && y >= 30 && y < 60;
      expect(out.pixel(x, y)).toEqual(inside ? EDITED : ORIGINAL);
    }
  });

  it('maps the requested model aspect to the crop but rejects a different response aspect', async () => {
    const base = await solid(ORIGINAL);
    const region = { x: 0.3, y: 0.3, w: 0.3, h: 0.2 };
    const sourceBox = panelContextBox(region);
    const out = await pasteRegion({ base: async () => base, drawn: await solid(EDITED, 60, 40), region, sourceBox, sourceAspect: '3:2', feather: 0 });
    expect((await read(out.dataUrl)).pixel(40, 40)).toEqual(EDITED);
    await expect(pasteRegion({ base: async () => base, drawn: await solid(EDITED, 40, 80), region, sourceBox, sourceAspect: '3:2' })).rejects.toMatchObject({ code: 'NO_IMAGE' });
  });
});
