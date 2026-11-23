// @vitest-environment node
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { expect, it } from 'vitest';
import { ORIGINAL_KEYS, collectionEdition, originalStoryPages } from '../../../../shared/comic/originals.js';
import { originalMetadata, sha256 } from './book.js';

const bundled = join(dirname(fileURLToPath(import.meta.url)), '../../../assets/originals');

it('ships one distinct cover and every individually described illustrated page for each registered edition', async () => {
  const hashes = new Map<string, string>();
  for (const key of ORIGINAL_KEYS) {
    const directory = join(bundled, key);
    const count = originalStoryPages(key);
    const metadata = originalMetadata(key, JSON.parse(await readFile(join(directory, 'book.json'), 'utf8')));
    const names = ['cover.webp', ...Array.from({ length: count }, (_, i) => 'p' + String(i + 1).padStart(2, '0') + '.webp')];
    expect(new Set(await readdir(directory)), key).toEqual(new Set(['book.json', ...names]));
    expect(new Set(metadata.pages.map((p) => p.alt)).size, key + ' descriptions').toBe(count);
    expect(new Set(metadata.pages.map((p) => p.transcript)).size, key + ' transcripts').toBe(count);
    const edition = collectionEdition(key);
    for (const file of names) {
      const bytes = await readFile(join(directory, file));
      const path = key + '/' + file;
      const digest = sha256(bytes);
      expect(hashes.get(digest), path + ' repeats another illustration').toBeUndefined();
      hashes.set(digest, path);
      if (edition) {
        const image = await sharp(bytes).metadata();
        expect(image.format, path).toBe('webp');
        expect(image.width!, path).toBeGreaterThanOrEqual(480);
        expect(image.height!, path).toBeGreaterThanOrEqual(480);
        expect(image.width === image.height, path).toBe(false);
        expect(image.width! > image.height!, path).toBe(edition.orientation === 'landscape');
      }
    }
  }
}, 30_000);
