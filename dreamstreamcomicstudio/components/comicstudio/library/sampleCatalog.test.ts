// @vitest-environment node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { FEATURED_SAMPLES, SAMPLE_COMICS, findSample } from './sampleCatalog';
const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

describe('Public sample editions', () => {
  it('only resolves explicit published sample IDs', () => {
    expect(findSample('../private-project')).toBeUndefined();
    expect(findSample('constructor')).toBeUndefined();
    expect(findSample(null)).toBeUndefined();
    expect(new Set(SAMPLE_COMICS.map(comic => comic.id)).size).toBe(SAMPLE_COMICS.length);
  });
  it.each(FEATURED_SAMPLES)('$title ships a full page with truthful dimensions and responsive artwork', async comic => {
    expect(comic.pages).toHaveLength(1);
    expect(comic.pages[0].transcript).toHaveLength(comic.pages[0].panels);
    for (const page of comic.pages) {
      const full = path.join(APP, 'public', page.src);
      expect(fs.statSync(full).size).toBeGreaterThan(10000);
      const info = await sharp(full).metadata();
      expect(info.width).toBe(page.width); expect(info.height).toBe(page.height);
      for (const entry of page.srcSet!.split(', ')) {
        const [src, width] = entry.split(' ');
        const variant = await sharp(path.join(APP, 'public', src)).metadata();
        expect(variant.width).toBe(Number(width.slice(0, -1)));
      }
    }
  });
});
