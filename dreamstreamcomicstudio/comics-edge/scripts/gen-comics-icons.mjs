#!/usr/bin/env node
/**
 * Generates the Comic Studio (comics.dreamstreamstudio.ai) link-preview card, public/icons/comics-og.png
 * (1200×630 Open Graph / Twitter card). Run from dreamstreamcomicstudio/:
 *
 *   node comics-edge/scripts/gen-comics-icons.mjs
 *
 * The Comic Studio APP ICONS (comics-192/512/maskable-512/apple-touch-180, comics-icon.svg and the
 * favicons) are generated with every other studio's by scripts/gen-icons.mjs (npm run gen:icons)
 * from the "Grin" mark, public/icons/comics-mark.svg. This card still carries the pre-Atlas art (the
 * terracotta comic page and speech balloon, embedded below as LEGACY_OG_MARK so re-running reproduces
 * the committed card): it is redrawn with the Atlas palette when the apex skin lands, together with
 * BRAND.ogImageAlt in comics-edge/src/brand.ts.
 *
 * Uses sharp (Apache-2.0, already a dependency). The card's text uses the Inter font when installed
 * (falls back to the system sans-serif).
 */
import { writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const OUT_DIR = path.join(APP_ROOT, 'public', 'icons');

/** The card's mark: the pre-Atlas Comic Studio tile, kept only until the card is redrawn. */
const LEGACY_OG_MARK = `<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 48 48">
  <rect x="2" y="2" width="44" height="44" rx="12" fill="#c2603f"/>
  <g fill="none" stroke="#fdfbf7" stroke-width="2.6" stroke-linejoin="round" stroke-linecap="round" opacity=".6">
    <rect x="9.5" y="12" width="20" height="25" rx="2.5"/>
    <path d="M9.5 23h20M18.5 23v14"/>
  </g>
  <path d="M26.5 13h8.5a5 5 0 0 1 5 5v4.5a5 5 0 0 1-5 5h-3.4l-4.6 4.2v-4.2h-.5a5 5 0 0 1-5-5V18a5 5 0 0 1 5-5z" fill="#fdfbf7" stroke="#c2603f" stroke-width="2.2" stroke-linejoin="round"/>
  <g fill="#c2603f">
    <circle cx="26.6" cy="20.3" r="1.5"/>
    <circle cx="30.8" cy="20.3" r="1.5"/>
    <circle cx="35" cy="20.3" r="1.5"/>
  </g>
</svg>
`;

const PAPER = '#FAF9F5';
const INK = '#1a1915';
const MUTED = '#6e6a60';
const ACCENT = '#D97757';

async function renderMark(svg, px) {
  const meta = await sharp(svg).metadata();
  const longest = Math.max(meta.width || 48, meta.height || 48);
  const density = Math.max(1, Math.min(2400, Math.ceil((72 * px) / longest) * 2));
  return sharp(svg, { density })
    .resize(px, px, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toBuffer();
}

/** A comic page glyph (panel grid) for the OG card's illustration. */
const pageGlyph = (x, y, w, h, rotate, panels) => {
  const rows = panels
    .map(([px, py, pw, ph]) => `<rect x="${x + px * w + 10}" y="${y + py * h + 10}" width="${pw * w - 20}" height="${ph * h - 20}" rx="6" fill="${INK}" fill-opacity="0.07"/>`)
    .join('');
  return `<g transform="rotate(${rotate} ${x + w / 2} ${y + h / 2})">
    <rect x="${x}" y="${y}" width="${w}" height="${h}" rx="14" fill="#ffffff" stroke="${INK}" stroke-opacity="0.12" stroke-width="2"/>
    ${rows}
  </g>`;
};

async function ogImage(svg) {
  const W = 1200;
  const H = 630;
  const font = `Inter, 'Inter Display', 'DejaVu Sans', Arial, sans-serif`;
  const art = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
    <rect width="${W}" height="${H}" fill="${PAPER}"/>
    ${pageGlyph(760, 120, 250, 360, -8, [[0, 0, 1, 0.42], [0, 0.42, 0.5, 0.58], [0.5, 0.42, 0.5, 0.58]])}
    ${pageGlyph(860, 150, 250, 360, 6, [[0, 0, 0.55, 0.5], [0.55, 0, 0.45, 0.5], [0, 0.5, 1, 0.5]])}
    <g transform="translate(905 205)">
      <path d="M24 0h150a24 24 0 0 1 24 24v58a24 24 0 0 1-24 24h-92l-34 30v-30h-24a24 24 0 0 1-24-24V24A24 24 0 0 1 24 0z" fill="#ffffff" stroke="${ACCENT}" stroke-width="5" stroke-linejoin="round"/>
      <circle cx="62" cy="53" r="8" fill="${ACCENT}"/><circle cx="99" cy="53" r="8" fill="${ACCENT}"/><circle cx="136" cy="53" r="8" fill="${ACCENT}"/>
    </g>
    <text x="96" y="352" font-family="${font}" font-size="92" font-weight="700" fill="${INK}" letter-spacing="-2">Comic Studio</text>
    <text x="100" y="408" font-family="${font}" font-size="34" font-weight="500" fill="${MUTED}">by DreamStream</text>
    <text x="100" y="492" font-family="${font}" font-size="32" font-weight="500" fill="${INK}" fill-opacity="0.82">Talk it through. Get a finished comic.</text>
    <rect x="100" y="532" width="84" height="6" rx="3" fill="${ACCENT}"/>
  </svg>`;
  const mark = await renderMark(svg, 150);
  return sharp(Buffer.from(art))
    .composite([{ input: mark, left: 96, top: 110 }])
    .flatten({ background: PAPER })
    .png({ compressionLevel: 9 })
    .toBuffer();
}

async function main() {
  const svg = Buffer.from(LEGACY_OG_MARK);
  await mkdir(OUT_DIR, { recursive: true });
  const jobs = [['comics-og.png', () => ogImage(svg)]];
  for (const [name, make] of jobs) {
    const buf = await make();
    await writeFile(path.join(OUT_DIR, name), buf);
    const { width, height } = await sharp(buf).metadata();
    console.log(`public/icons/${name}  ${width}x${height}  ${buf.length} bytes`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
