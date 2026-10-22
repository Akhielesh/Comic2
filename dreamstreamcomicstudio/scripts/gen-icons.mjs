#!/usr/bin/env node
/**
 * Generates the installable-app (PWA) icons from the DreamStream brand mark.
 *
 *   npm run gen:icons                       # from public/stream-studio.svg
 *   node scripts/gen-icons.mjs path/to/mark.svg [--bg=#c2603f]
 *
 * Writes into public/icons/:
 *   app-192.png            purpose "any"      — the mark as drawn (rounded tile, clear corners)
 *   app-512.png            purpose "any"
 *   app-maskable-512.png   purpose "maskable" — full-bleed background, mark scaled into the
 *                                               80% safe zone so any launcher mask keeps it whole
 *   apple-touch-180.png    iOS home screen    — full-bleed (iOS rounds the corners itself and
 *                                               shows black behind transparent pixels)
 *
 * The icon art is an owner input: replace public/stream-studio.svg (or pass another SVG) and
 * re-run. The full-bleed background defaults to the mark's first <rect> fill so the tile's
 * rounded corners disappear into it; override with --bg. Uses sharp (already a dependency,
 * Apache-2.0); output is deterministic for a given sharp/libvips version.
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = path.join(ROOT, 'public', 'icons');

const args = process.argv.slice(2);
const srcArg = args.find((a) => !a.startsWith('--'));
const bgArg = args.find((a) => a.startsWith('--bg='))?.slice('--bg='.length);
const SRC = path.resolve(ROOT, srcArg ?? 'public/stream-studio.svg');

/** Fill of the first <rect> in the mark (the tile), else the house accent. */
export function tileColorOf(svg) {
  const rect = svg.match(/<rect\b[^>]*\bfill\s*=\s*["'](#[0-9a-fA-F]{3,8})["']/);
  return rect ? rect[1] : '#D97757';
}

/** Rasterises the SVG so its longest side is `px` pixels (sharp density is DPI; SVG user unit = 1/96in at 96dpi). */
async function renderMark(svg, px) {
  const meta = await sharp(svg).metadata();
  const longest = Math.max(meta.width || 48, meta.height || 48);
  const density = Math.max(1, Math.min(2400, Math.ceil((72 * px) / longest) * 2));
  return sharp(svg, { density })
    .resize(px, px, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toBuffer();
}

/** The mark alone, at `size`, on a transparent canvas. */
async function anyIcon(svg, size) {
  return sharp(await renderMark(svg, size)).png({ compressionLevel: 9 }).toBuffer();
}

/** The mark scaled to `scale` of the canvas, centred on a full-bleed `bg` square. */
async function fullBleedIcon(svg, size, scale, bg) {
  const inner = Math.round(size * scale);
  const mark = await renderMark(svg, inner);
  const offset = Math.round((size - inner) / 2);
  return sharp({ create: { width: size, height: size, channels: 4, background: bg } })
    .composite([{ input: mark, left: offset, top: offset }])
    .flatten({ background: bg })
    .png({ compressionLevel: 9 })
    .toBuffer();
}

async function main() {
  const svg = await readFile(SRC);
  const bg = bgArg ?? tileColorOf(svg.toString('utf8'));
  await mkdir(OUT_DIR, { recursive: true });

  const jobs = [
    ['app-192.png', () => anyIcon(svg, 192)],
    ['app-512.png', () => anyIcon(svg, 512)],
    // Maskable: the safe zone is the centred circle of radius 40% (W3C). The mark's glyph
    // spans ~80% of its own tile, so 0.8 keeps every stroke inside that circle.
    ['app-maskable-512.png', () => fullBleedIcon(svg, 512, 0.8, bg)],
    // iOS masks with a rounded square; the glyph can sit almost edge to edge.
    ['apple-touch-180.png', () => fullBleedIcon(svg, 180, 1, bg)],
  ];

  for (const [name, make] of jobs) {
    const buf = await make();
    const out = path.join(OUT_DIR, name);
    await writeFile(out, buf);
    const meta = await sharp(out).metadata();
    console.log(`${path.relative(ROOT, out)}  ${meta.width}x${meta.height}  ${buf.length} B`);
  }
  console.log(`source: ${path.relative(ROOT, SRC)}  background: ${bg}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
