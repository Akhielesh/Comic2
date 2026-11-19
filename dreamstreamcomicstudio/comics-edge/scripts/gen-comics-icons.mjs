#!/usr/bin/env node
/**
 * Generates the Comic Studio (comics.dreamstreamstudio.ai) app icons from its brand mark,
 * public/icons/comics-mark.svg (an ink tile with a turning paper page, ComicsMark.tsx on the Atlas light
 * tokens). The PNGs always take the light drawing (sharp does not apply the mark's dark-scheme block). The
 * SVG itself swaps tile and page under a dark colour scheme wherever a browser draws it: the tab favicon,
 * and any other place that loads the SVG directly.
 * The link-preview cards (comics-og.png, comics-library-og.png) are made by scripts/og-cards.mjs instead.
 * Run from dreamstreamcomicstudio/:
 *
 *   node comics-edge/scripts/gen-comics-icons.mjs
 *
 * Writes into public/icons/ (already excluded from Pages Functions by public/_routes.json):
 *   comics-192.png, comics-512.png   purpose "any"      — the mark as drawn
 *   comics-maskable-512.png          purpose "maskable" — full-bleed tile colour, mark in the 80% safe zone
 *   comics-apple-touch-180.png       iOS home screen    — full bleed (iOS rounds the corners itself)
 *
 * Same approach as scripts/gen-icons.mjs (sharp, Apache-2.0, already a dependency).
 * tests/config/terracottaGuard.test.ts imports renderIcons and checks the committed PNGs against it.
 */
import { realpathSync } from 'node:fs';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const OUT_DIR = path.join(APP_ROOT, 'public', 'icons');
const SRC = path.join(OUT_DIR, 'comics-mark.svg');

// The mark's tile in the light scheme (Atlas --ds-ink): the full-bleed icons fill their corners with it.
export const TILE = '#0a0a0a';

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

/**
 * Every icon this script writes, as [file name in public/icons/, PNG buffer], drawn from the mark's SVG source.
 * @param {Buffer} svg
 * @returns {Promise<Array<[string, Buffer]>>}
 */
export async function renderIcons(svg) {
  return [
    ['comics-192.png', await anyIcon(svg, 192)],
    ['comics-512.png', await anyIcon(svg, 512)],
    ['comics-maskable-512.png', await fullBleedIcon(svg, 512, 0.8)],
    ['comics-apple-touch-180.png', await fullBleedIcon(svg, 180, 1)]
  ];
}

async function main() {
  const svg = await readFile(SRC);
  await mkdir(OUT_DIR, { recursive: true });
  for (const [name, buf] of await renderIcons(svg)) {
    await writeFile(path.join(OUT_DIR, name), buf);
    const { width, height } = await sharp(buf).metadata();
    console.log(`public/icons/${name}  ${width}x${height}  ${buf.length} bytes`);
  }
}

// Writes only when run as a script; importing it (the guard test) only renders.
if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
