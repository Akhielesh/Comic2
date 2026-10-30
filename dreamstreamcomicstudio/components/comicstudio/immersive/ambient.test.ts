// Ambient room colour (reader.md §6.2 tests): a white page with a red blob → red; pure grey → neutral;
// never white or black; averaging a spread; the background and theme colour fall back to the plain room.
import { describe, expect, it } from 'vitest';
import { averagePalette, extractPalette, NEUTRAL_RGB, roomBackground, themeColorFor } from './ambient';

const canvas = (w: number, h: number, paint: (x: number, y: number) => [number, number, number, number?]) => {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y += 1)
    for (let x = 0; x < w; x += 1) {
      const [r, g, b, a = 255] = paint(x, y);
      const o = (y * w + x) * 4;
      data[o] = r;
      data[o + 1] = g;
      data[o + 2] = b;
      data[o + 3] = a;
    }
  return data;
};

describe('extractPalette', () => {
  it('a white page with a red blob → a red dominant', () => {
    const data = canvas(32, 32, (x, y) => ((x - 16) ** 2 + (y - 16) ** 2 < 60 ? [220, 30, 40] : [255, 255, 255]));
    const p = extractPalette(data, 32, 32);
    expect(p.neutral).toBe(false);
    expect(p.dominant.r).toBeGreaterThan(p.dominant.g + 60);
    expect(p.dominant.r).toBeGreaterThan(p.dominant.b + 60);
    expect(p.lum).toBeGreaterThan(0.7);
  });

  it('pure grey (and ink on paper) stays neutral', () => {
    expect(extractPalette(canvas(32, 32, () => [128, 128, 128]), 32, 32)).toMatchObject({ neutral: true, dominant: NEUTRAL_RGB });
    const lineArt = canvas(32, 32, (x) => (x % 4 === 0 ? [0, 0, 0] : [255, 255, 255]));
    expect(extractPalette(lineArt, 32, 32).neutral).toBe(true);
  });

  it('never returns pure white or black, even for a saturated near-black page', () => {
    const p = extractPalette(canvas(32, 32, (x) => (x < 16 ? [40, 0, 0] : [0, 0, 60])), 32, 32);
    for (const c of [p.dominant, p.accent]) {
      const max = Math.max(c.r, c.g, c.b);
      expect(max).toBeGreaterThan(40);
      expect(Math.min(c.r, c.g, c.b)).toBeLessThan(230);
    }
  });

  it('finds an accent at least 60° of hue away', () => {
    const p = extractPalette(canvas(32, 32, (x) => (x < 22 ? [30, 90, 220] : [240, 160, 30])), 32, 32);
    expect(p.dominant.b).toBeGreaterThan(p.dominant.r);
    expect(p.accent.r).toBeGreaterThan(p.accent.b);
  });

  it('ignores transparent pixels', () => {
    expect(extractPalette(canvas(8, 8, () => [255, 0, 0, 0]), 8, 8).neutral).toBe(true);
  });
});

describe('room', () => {
  it('averages a spread (colourful pages win over neutral ones)', () => {
    const red = extractPalette(canvas(8, 8, () => [220, 30, 30]), 8, 8);
    const grey = extractPalette(canvas(8, 8, () => [128, 128, 128]), 8, 8);
    const avg = averagePalette([red, grey, null])!;
    expect(avg.neutral).toBe(false);
    expect(avg.dominant).toEqual(red.dominant);
    expect(averagePalette([null, undefined])).toBeNull();
  });

  it('background layers and theme colour fall back to the plain room', () => {
    expect(roomBackground(null)).toContain('var(--ds-reader-room)');
    const red = extractPalette(canvas(8, 8, () => [220, 30, 30]), 8, 8);
    expect(roomBackground(red)).toMatch(/radial-gradient\(120% 90% at 50% 42%, rgba\(\d+,\d+,\d+,0\.26\)/);
    expect(themeColorFor(null)).toBe('#0e0d0c');
    expect(themeColorFor(red)).toMatch(/^#[0-9a-f]{6}$/);
  });
});
