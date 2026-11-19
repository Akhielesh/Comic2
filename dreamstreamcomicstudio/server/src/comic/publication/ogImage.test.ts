// @vitest-environment node
// The per-comic link-preview card's brand mark (ogImage.ts): the Comic Studio mark in ink, in the box
// the old orange bubble tile used, and a file name that changes with it so no old card is reused.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { OG_TEMPLATE_VERSION } from '../../../../shared/comic/publication.js';
import { OG_H, OG_MARK_INK, OG_MARK_PAPER, OG_RENDER_REV, OG_W, markSvg, ogHash, renderOgCard } from './ogImage.js';

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const OLD_ORANGE = /#d97757/i;

describe('OG card mark', () => {
  it('is the Comic Studio mark (components/comicshost/ComicsMark.tsx), same geometry, ink and paper only', () => {
    const product = fs.readFileSync(path.join(APP, 'components/comicshost/ComicsMark.tsx'), 'utf8');
    const svg = markSvg().toString('utf8');
    const paths = [...product.matchAll(/\bd="([^"]+)"/g)].map((m) => m[1]);
    expect(paths.length).toBeGreaterThanOrEqual(3);
    for (const d of paths) expect(svg).toContain(`d="${d}"`);
    expect(product).toContain('x="2" y="2" width="44" height="44" rx="12"');
    expect(svg).toContain('x="2" y="2" width="44" height="44" rx="12"');
    expect(svg).toContain('viewBox="0 0 48 48"');
    // Same box as before: 36 × 36 at the bottom right.
    expect(svg).toContain('width="36" height="36"');
    // No hue anywhere: every colour is one of the two neutral inks.
    const colours = new Set([...svg.matchAll(/#[0-9a-fA-F]{6}\b/g)].map((m) => m[0].toUpperCase()));
    expect([...colours].sort()).toEqual([OG_MARK_INK, OG_MARK_PAPER].map((c) => c.toUpperCase()).sort());
    for (const hex of colours) expect(new Set([hex.slice(1, 3), hex.slice(3, 5), hex.slice(5, 7)]).size).toBe(1);
    expect(svg).not.toMatch(OLD_ORANGE);
  });

  it('a card made with the old orange mark is never reused: the template revision joins the content hash', () => {
    const base = { title: 'The Paper Boat', subtitle: 'A small boat.', kindLabel: 'Comic', pageCount: 2, lang: 'en', showMark: true as const, coverPath: 'pub/x/cover.webp', rating: 'G' as const };
    const parts = [OG_TEMPLATE_VERSION, base.title, base.subtitle, base.kindLabel, base.pageCount, base.lang, '', '', '', base.coverPath, base.rating];
    const sha = (material: unknown[]) => crypto.createHash('sha1').update(JSON.stringify(material)).digest('hex').slice(0, 12);
    // The name stays a 12-hex content hash of the same material, now with the revision appended.
    expect(ogHash(base)).toBe(sha([...parts, OG_RENDER_REV]));
    expect(ogHash(base)).not.toBe(sha(parts));
    expect(ogHash(base)).toMatch(/^[0-9a-f]{12}$/);
  });

  it('renders the ink mark at the bottom right: neutral ink and paper, no orange (layout and size kept)', async () => {
    // A blue cover: its blurred, darkened backdrop is never neutral, so neutral pixels there are the mark's.
    const cover = await sharp({ create: { width: 800, height: 1200, channels: 3, background: '#3355cc' } }).png().toBuffer();
    const out = await renderOgCard({ title: 'The Paper Boat', subtitle: 'A small boat.', kindLabel: 'Comic', pageCount: 2, lang: 'en', coverBuf: cover, fallbackPageBuf: null, showMark: true });
    const meta = await sharp(out.jpeg).metadata();
    expect([meta.format, meta.width, meta.height]).toEqual(['jpeg', OG_W, OG_H]);
    expect(out.jpeg.byteLength).toBeLessThanOrEqual(300 * 1024);

    const box = { left: 760, top: 568, width: 380, height: 50 };
    const { data, info } = await sharp(out.jpeg).extract(box).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    let orange = 0;
    let paperDark = 0;
    let inkLight = 0;
    for (let i = 0; i < info.width * info.height * 3; i += 3) {
      const [r, g, b] = [data[i], data[i + 1], data[i + 2]];
      const spread = Math.max(r, g, b) - Math.min(r, g, b);
      if (r > 150 && r - b > 60 && r - g > 40) orange += 1;
      if (Math.max(r, g, b) < 40 && spread < 14) paperDark += 1;
      if (Math.min(r, g, b) > 225 && spread < 14) inkLight += 1;
    }
    expect(orange).toBe(0);
    // The tile (light ink) and the page cut out of it (dark paper) are both there.
    expect(inkLight).toBeGreaterThan(400);
    expect(paperDark).toBeGreaterThan(150);
  }, 30_000);
});
