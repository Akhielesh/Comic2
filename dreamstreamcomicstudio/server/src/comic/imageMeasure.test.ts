// @vitest-environment node
// imageMeasure.ts (contract §12.8, assets.md §4.2): deterministic, $0 measurement, plus the
// 3-slot sharp gate every image pipeline shares (1 GiB container).
import { describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { SHARP_SLOTS, __resetSharpSlotPeakForTests, measureImage, medianCutPalette, sharpSlotStats, withSharpSlot } from './imageMeasure.js';

const solid = (w: number, h: number, background = '#ffffff') => sharp({ create: { width: w, height: h, channels: 3, background } }).png().toBuffer();

describe('measureImage', () => {
  it('a uniform image is blank with one palette colour', async () => {
    const m = await measureImage(await solid(300, 200, '#ffffff'));
    expect(m).toMatchObject({ w: 300, h: 200, aspectWanted: '3:2', aspectOk: true, blank: true, palette: ['#ffffff'] });
    expect(m.meanLuma).toBeCloseTo(1, 3);
    expect(m.lumaStdev).toBeLessThan(0.001);
  });

  it('a two-tone image is not blank; palette is by share', async () => {
    const img = await sharp({ create: { width: 400, height: 400, channels: 3, background: '#000000' } })
      .composite([{ input: await solid(400, 100, '#ffffff'), left: 0, top: 0 }])
      .png()
      .toBuffer();
    const m = await measureImage(img, '1:1');
    expect(m.blank).toBe(false);
    expect(m.palette.slice(0, 2)).toEqual(['#000000', '#ffffff']);
    expect(m.meanLuma).toBeCloseTo(0.25, 1);
    expect(m.lumaStdev).toBeGreaterThan(0.4);
  });

  it('checks the aspect against the wanted shape (|log| error, 4 % tolerance)', async () => {
    const page = await solid(1000, 1250);
    expect(await measureImage(page, '4:5')).toMatchObject({ aspectOk: true, aspectError: 0 });
    const wrong = await measureImage(page, '1:1');
    expect(wrong.aspectOk).toBe(false);
    expect(wrong.aspectError).toBeCloseTo(Math.log(1.25), 3);
  });

  it('texture tiles report the edge seam and are never "blank"', async () => {
    const flat = await measureImage(await solid(256, 256, '#888888'), '1:1', { texture: true });
    expect(flat).toMatchObject({ blank: false, edgeSeamDelta: 0 });
    const ramp = Buffer.alloc(256 * 256 * 3);
    for (let y = 0; y < 256; y += 1) for (let x = 0; x < 256; x += 1) ramp.fill(x, (y * 256 + x) * 3, (y * 256 + x) * 3 + 3);
    const seam = await measureImage(await sharp(ramp, { raw: { width: 256, height: 256, channels: 3 } }).png().toBuffer(), '1:1', { texture: true });
    expect(seam.edgeSeamDelta!).toBeGreaterThan(0.4);
    expect((await measureImage(await solid(64, 64))).edgeSeamDelta).toBeUndefined();
  });

  it('rejects unreadable input with 400', async () => {
    await expect(measureImage(Buffer.from('not an image'))).rejects.toMatchObject({ status: 400 });
    await expect(measureImage(Buffer.alloc(0))).rejects.toMatchObject({ status: 400 });
  });
});

describe('medianCutPalette', () => {
  it('is deterministic and ordered by share', () => {
    const rgb = new Uint8Array([...Array(6).fill([255, 0, 0]).flat(), ...Array(3).fill([0, 0, 255]).flat(), 0, 255, 0]);
    expect(medianCutPalette(rgb)).toEqual(medianCutPalette(rgb));
    expect(medianCutPalette(rgb)[0]).toBe('#ff0000');
    expect(medianCutPalette(rgb)).toEqual(expect.arrayContaining(['#ff0000', '#0000ff', '#00ff00']));
    expect(medianCutPalette(new Uint8Array(0))).toEqual([]);
  });
});

describe('withSharpSlot (3-slot gate)', () => {
  it('never runs more than 3 pipelines at once, FIFO, and frees slots on failure', async () => {
    __resetSharpSlotPeakForTests();
    const order: number[] = [];
    let live = 0;
    let maxLive = 0;
    const releases: (() => void)[] = [];
    const tasks = Array.from({ length: 8 }, (_, i) =>
      withSharpSlot(async () => {
        live += 1;
        maxLive = Math.max(maxLive, live);
        order.push(i);
        await new Promise<void>((resolve) => releases.push(resolve));
        live -= 1;
        if (i === 1) throw new Error('boom');
        return i;
      })
    );
    tasks.forEach((t) => t.catch(() => undefined)); // the failure is asserted below
    const drain = async () => {
      while (releases.length || sharpSlotStats().active) {
        await new Promise((r) => setTimeout(r, 0));
        releases.shift()?.();
      }
    };
    await drain();
    const results = await Promise.allSettled(tasks);
    expect(maxLive).toBe(SHARP_SLOTS);
    expect(order).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(results[1].status).toBe('rejected');
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(7);
    expect(sharpSlotStats()).toMatchObject({ active: 0, queued: 0 });
    expect(sharpSlotStats().peak).toBeLessThanOrEqual(SHARP_SLOTS);
  });

  it('bounds real sharp work too', async () => {
    __resetSharpSlotPeakForTests();
    const img = await solid(600, 600, '#336699');
    await Promise.all(Array.from({ length: 9 }, () => measureImage(img)));
    expect(sharpSlotStats().peak).toBeLessThanOrEqual(SHARP_SLOTS);
  });
});
