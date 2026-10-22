#!/usr/bin/env node
/**
 * Generates the Comic Studio (comics.dreamstreamstudio.ai) app icons and link-preview image from
 * its brand mark, public/icons/comics-mark.svg (the DreamStream tile with a comic page and a speech
 * balloon). Run from dreamstreamcomicstudio/:
 *
 *   node comics-edge/scripts/gen-comics-icons.mjs
 *
 * Writes into public/icons/ (already excluded from Pages Functions by public/_routes.json):
 *   comics-192.png, comics-512.png   purpose "any"      — the mark as drawn
 *   comics-maskable-512.png          purpose "maskable" — full-bleed tile colour, mark in the 80% safe zone
 *   comics-apple-touch-180.png       iOS home screen    — full bleed (iOS rounds the corners itself)
 *   comics-og.png                    1200×630 Open Graph / Twitter card for the comics host
 *
 * Same approach as scripts/gen-icons.mjs (sharp, Apache-2.0, already a dependency). The OG card's
 * text uses the Inter font when installed (falls back to the system sans-serif).
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const OUT_DIR = path.join(APP_ROOT, 'public', 'icons');
const SRC = path.join(OUT_DIR, 'comics-mark.svg');

const TILE = '#c2603f';
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

const anyIcon = async (svg, size) => sharp(await renderMark(svg, size)).png({ compressionLevel: 9 }).toBuffer();

async function fullBleedIcon(svg, size, scale) {
  const inner = Math.round(size * scale);
  const mark = await renderMark(svg, inner);
  const offset = Math.round((size - inner) / 2);
  return sharp({ create: { width: size, height: size, channels: 4, background: TILE } })
    .composite([{ input: mark, left: offset, top: offset }])
    .flatten({ background: TILE })
    .png({ compressionLevel: 9 })
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
  const svg = await readFile(SRC);
  await mkdir(OUT_DIR, { recursive: true });
  const jobs = [
    ['comics-192.png', () => anyIcon(svg, 192)],
    ['comics-512.png', () => anyIcon(svg, 512)],
    ['comics-maskable-512.png', () => fullBleedIcon(svg, 512, 0.8)],
    ['comics-apple-touch-180.png', () => fullBleedIcon(svg, 180, 1)],
    ['comics-og.png', () => ogImage(svg)]
  ];
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
