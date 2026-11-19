// @vitest-environment node
// The comics host's link-preview cards (scripts/og-cards.mjs → public/icons): Atlas ink chrome, the
// product's own sample art, the current mark, and files a preview service will take.
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { CARDS, H, INK, MAX_BYTES, W, cardHtml, markSvg } from './og-cards.mjs';

const APP = path.resolve(__dirname, '..');
const hexes = (text: string) => [...text.matchAll(/#[0-9a-fA-F]{6}\b/g)].map((m) => m[0].toLowerCase());
const neutral = (hex: string) => hex.slice(1, 3) === hex.slice(3, 5) && hex.slice(3, 5) === hex.slice(5, 7);

describe('og-cards — the HTML the cards are drawn from', () => {
  it('uses ink and paper only (no hue, no terracotta) and the Atlas chrome fonts', () => {
    for (const [id, card] of Object.entries(CARDS)) {
      const html = cardHtml(card, { inline: false });
      for (const hex of hexes(html)) expect(neutral(hex), `${id}: ${hex}`).toBe(true);
      expect(html, id).not.toMatch(/#(d97757|c2603f|c2643f)/i);
      expect(html).toMatch(/font-family:'Space Grotesk'/);
      expect(html).toMatch(/font-family:'IBM Plex Sans'/);
      for (const [, url] of html.matchAll(/url\((\/fonts\/[^)]+)\)/g)) expect(fs.existsSync(path.join(APP, 'public', url)), url).toBe(true);
    }
    for (const value of Object.values(INK)) if (value.startsWith('#')) expect(neutral(value.toLowerCase()), value).toBe(true);
  });

  it('draws the current Comic Studio mark (components/comicshost/ComicsMark.tsx)', () => {
    const product = fs.readFileSync(path.join(APP, 'components/comicshost/ComicsMark.tsx'), 'utf8');
    const svg = markSvg(56);
    for (const [, d] of product.matchAll(/\bd="([^"]+)"/g)) expect(svg).toContain(`d="${d}"`);
    expect(svg).toContain('x="2" y="2" width="44" height="44" rx="12"');
  });

  it('shows only the product’s own sample comics, never a user’s', () => {
    for (const [id, card] of Object.entries(CARDS)) {
      const art: string[] = [...(card.art || []), ...(card.shelf || []).map((s: { art: string }) => s.art)];
      expect(art.length, id).toBeGreaterThan(0);
      for (const file of art) {
        expect(file, id).toMatch(/^public\/assets\/comic-sample\/[a-z0-9-]+\.webp$/);
        expect(fs.existsSync(path.join(APP, file)), file).toBe(true);
      }
    }
  });
});

describe('og-cards — the committed pictures', () => {
  for (const [id, card] of Object.entries(CARDS)) {
    it(`${card.file}: a ${W}×${H} PNG under ${MAX_BYTES / 1024} KB with ink-only chrome and coloured art`, async () => {
      const file = path.join(APP, 'public/icons', card.file);
      const buf = fs.readFileSync(file);
      expect(buf.byteLength, id).toBeLessThanOrEqual(MAX_BYTES);
      const img = sharp(buf);
      const meta = await img.metadata();
      expect([meta.format, meta.width, meta.height]).toEqual(['png', W, H]);
      const { data, info } = await img.removeAlpha().raw().toBuffer({ resolveWithObject: true });
      const ch = info.channels;
      // The text column (left 600 px): ink on paper, no pixel with a hue.
      let tinted = 0;
      let ink = 0;
      for (let y = 0; y < H; y += 1) {
        for (let x = 0; x < 600; x += 1) {
          const i = (y * W + x) * ch;
          const [r, g, b] = [data[i], data[i + 1], data[i + 2]];
          if (Math.max(r, g, b) - Math.min(r, g, b) > 12) tinted += 1;
          if (Math.max(r, g, b) < 60) ink += 1;
        }
      }
      expect(tinted, `${card.file}: tinted chrome pixels`).toBe(0);
      expect(ink, `${card.file}: the title and mark are drawn`).toBeGreaterThan(5000);
      // The art column carries real colour (a comic, not grey placeholder panels): a fifth of it has a hue.
      let coloured = 0;
      for (let y = 60; y < 560; y += 1) {
        for (let x = 640; x < 1140; x += 1) {
          const i = (y * W + x) * ch;
          if (Math.max(data[i], data[i + 1], data[i + 2]) - Math.min(data[i], data[i + 1], data[i + 2]) > 40) coloured += 1;
        }
      }
      expect(coloured / (500 * 500), `${card.file}: coloured share of the art column`).toBeGreaterThan(0.2);
    });
  }
});
