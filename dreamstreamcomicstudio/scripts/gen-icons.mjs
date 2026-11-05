#!/usr/bin/env node
/**
 * Generates every installable-app icon and favicon from the DreamStream studio marks.
 *
 *   npm run gen:icons                 # rewrite every output from the sources
 *   node scripts/gen-icons.mjs --check  # exit 1 if a committed output differs from its source
 *
 * SOURCES (committed, the only inputs; edit these, never the outputs):
 *   public/icons/dreamstream-mark.svg   DreamStream Studio, the house "D" (the apex app)
 *   public/icons/comics-mark.svg        Comic Studio, "Grin" (comics.dreamstreamstudio.ai)
 *   public/icons/stream-mark.svg        Stream Studio, "On air" (stream.dreamstreamstudio.ai, /live)
 * Each is the shipped theme-agnostic mark: a 64-unit tile (rx 16) in currentColor with one weight-7
 * cut (mitred corners, butt ends) and one r 3.6 point through a mask. The generator reads the cut
 * path and the point from the mask and refuses a source built any other way, so a redrawn glyph only
 * needs its source file (and the same numbers in components/brand/studios.ts, which the React marks
 * draw from; tests/config/appIcons.test.ts fails if the two drift).
 *
 * OUTPUTS per studio (prefix `app` for DreamStream, `comics`, `stream`):
 *   <prefix>-192.png, -512.png       manifest purpose "any": ink tile with transparent corners
 *   <prefix>-maskable-512.png        purpose "maskable": full-bleed ink, the glyph where the tile
 *                                    has it, which keeps every stroke inside the 80% safe zone
 *   <prefix>-apple-touch-180.png     iOS home screen: full bleed (iOS rounds the corners itself and
 *                                    shows black behind transparent pixels). DreamStream's keeps its
 *                                    old name, apple-touch-180.png.
 *   <studio>-icon.svg                the same art as SVG, for the comics and Stream manifests (opaque,
 *                                    so the glyph never takes a dark launcher's colour; the apex
 *                                    manifest lists PNGs only, so DreamStream has none)
 *   <studio>-favicon.svg             browser tab: ink tile on light chrome, paper tile on dark
 *                                    (prefers-color-scheme), glyph cut out; Atlas's app/icon.svg
 *   favicon.ico / <studio>-favicon.ico   16, 32 and 48 px, 32-bit BMP entries with an AND mask
 *                                    (every browser and Windows itself read them)
 * plus, for Stream Studio, public/stream-studio.svg (its long-standing favicon / notification
 * address, kept: now the On-air favicon) and stream-badge-96.png (the glyph alone, white on
 * transparent: Android draws notification badges from their alpha).
 *
 * Paper glyph on an ink tile, never a transparent cut, in the raster icons: a cut would show a dark
 * launcher's colour through the glyph. Monochrome like Atlas: ink #0a0a0a, paper #ffffff.
 * Uses sharp (Apache-2.0, already a dependency). Output is deterministic for a given sharp/libvips
 * version; --check compares SVGs byte for byte and rasters pixel by pixel (within 2/255), so a
 * different libvips build does not count as drift.
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const INK = '#0a0a0a';
export const PAPER = '#ffffff';
/** The favicon tile under dark browser chrome (Atlas app/icon.svg). */
export const FAVICON_DARK_TILE = '#fafafa';
export const VIEWBOX = 64;
export const TILE_RADIUS = 16;
export const STROKE = 7;
export const POINT_RADIUS = 3.6;
/** Glyph-only crop of the 64-unit tile for notification badges (every glyph fits inside it). */
const BADGE_VIEWBOX = '8 8 48 48';
export const ICO_SIZES = [16, 32, 48];

/** Every studio the app ships icons for, its source and its outputs (paths relative to ROOT). */
export const ICON_SETS = [
  {
    studio: 'dreamstream',
    name: 'DreamStream Studio',
    source: 'public/icons/dreamstream-mark.svg',
    outputs: [
      { file: 'public/icons/app-192.png', kind: 'tile', size: 192 },
      { file: 'public/icons/app-512.png', kind: 'tile', size: 512 },
      { file: 'public/icons/app-maskable-512.png', kind: 'square', size: 512 },
      { file: 'public/icons/apple-touch-180.png', kind: 'square', size: 180 },
      { file: 'public/icons/dreamstream-favicon.svg', kind: 'favicon-svg' },
      { file: 'public/favicon.ico', kind: 'ico' },
    ],
  },
  {
    studio: 'comic',
    name: 'Comic Studio',
    source: 'public/icons/comics-mark.svg',
    outputs: [
      { file: 'public/icons/comics-192.png', kind: 'tile', size: 192 },
      { file: 'public/icons/comics-512.png', kind: 'tile', size: 512 },
      { file: 'public/icons/comics-maskable-512.png', kind: 'square', size: 512 },
      { file: 'public/icons/comics-apple-touch-180.png', kind: 'square', size: 180 },
      { file: 'public/icons/comics-icon.svg', kind: 'icon-svg' },
      { file: 'public/icons/comics-favicon.svg', kind: 'favicon-svg' },
      { file: 'public/icons/comics-favicon.ico', kind: 'ico' },
    ],
  },
  {
    studio: 'stream',
    name: 'Stream Studio',
    source: 'public/icons/stream-mark.svg',
    outputs: [
      { file: 'public/icons/stream-192.png', kind: 'tile', size: 192 },
      { file: 'public/icons/stream-512.png', kind: 'tile', size: 512 },
      { file: 'public/icons/stream-maskable-512.png', kind: 'square', size: 512 },
      { file: 'public/icons/stream-apple-touch-180.png', kind: 'square', size: 180 },
      { file: 'public/icons/stream-icon.svg', kind: 'icon-svg' },
      { file: 'public/icons/stream-favicon.svg', kind: 'favicon-svg' },
      { file: 'public/icons/stream-favicon.ico', kind: 'ico' },
      { file: 'public/icons/stream-badge-96.png', kind: 'badge', size: 96 },
      { file: 'public/stream-studio.svg', kind: 'favicon-svg' },
    ],
  },
];

// ── Reading a source mark ──────────────────────────────────────────────────────────────────

const attr = (tag, name) => tag.match(new RegExp(`\\s${name}="([^"]*)"`))?.[1];

const WHITE = ['#fff', '#ffffff'];
const BLACK = ['#000', '#000000'];
const isOneOf = (value, allowed) => value !== undefined && allowed.includes(value.toLowerCase());

/**
 * The glyph of a source mark: the cut's path data and the point's centre, read from the mask (the
 * join is always miter: the family has no other). Throws, naming the problem, when the file is not
 * built the family way: the mask keeps a white 64-unit rx 16 rect and cuts a black weight-7 stroke
 * (no fill, mitred corners, butt ends) and a black r 3.6 point, in user space.
 */
export function parseMarkSvg(svg, label = 'mark') {
  const fail = (why) => {
    throw new Error(`${label}: ${why} (a source mark is a 64-unit rx 16 currentColor tile with one weight-7 cut and one r 3.6 point in a mask)`);
  };
  const root = svg.match(/<svg\b[^>]*>/)?.[0] ?? fail('no <svg> element');
  if (attr(root, 'viewBox') !== `0 0 ${VIEWBOX} ${VIEWBOX}`) fail(`viewBox must be "0 0 ${VIEWBOX} ${VIEWBOX}"`);
  const maskMatch = svg.match(/(<mask\b[^>]*>)([\s\S]*?)<\/mask>/) ?? fail('no <mask>');
  const [, maskTag, mask] = maskMatch;
  if (attr(maskTag, 'maskUnits') !== 'userSpaceOnUse') fail('the <mask> must use maskUnits="userSpaceOnUse"');
  const keeps = mask.match(/<rect\b[^>]*>/g) ?? [];
  if (keeps.length !== 1) fail(`the mask needs exactly one keep <rect>, found ${keeps.length}`);
  const [keepTag] = keeps;
  if (attr(keepTag, 'width') !== String(VIEWBOX) || attr(keepTag, 'height') !== String(VIEWBOX)) fail(`the mask's keep rect must be ${VIEWBOX} x ${VIEWBOX}`);
  if (attr(keepTag, 'rx') !== String(TILE_RADIUS)) fail(`the mask's keep rect must have rx="${TILE_RADIUS}"`);
  if (!isOneOf(attr(keepTag, 'fill'), WHITE)) fail('the mask\'s keep rect must be white (fill="#fff")');
  const paths = mask.match(/<path\b[^>]*>/g) ?? [];
  const circles = mask.match(/<circle\b[^>]*>/g) ?? [];
  if (paths.length !== 1) fail(`the mask needs exactly one cut <path>, found ${paths.length}`);
  if (circles.length !== 1) fail(`the mask needs exactly one point <circle>, found ${circles.length}`);
  const [cutTag] = paths;
  const [pointTag] = circles;
  if (attr(cutTag, 'stroke-width') !== String(STROKE)) fail(`the cut's stroke-width must be ${STROKE}`);
  if (!isOneOf(attr(cutTag, 'stroke'), BLACK)) fail('the cut must be a black stroke (stroke="#000")');
  if (attr(cutTag, 'fill') !== 'none') fail('the cut is a stroke only (fill="none")');
  if ((attr(cutTag, 'stroke-linejoin') ?? 'miter') !== 'miter') fail('the cut\'s corners must be mitred (stroke-linejoin="miter")');
  if ((attr(cutTag, 'stroke-linecap') ?? 'butt') !== 'butt') fail('the cut\'s ends must be butt (stroke-linecap="butt" or none)');
  if (attr(pointTag, 'r') !== String(POINT_RADIUS)) fail(`the point's r must be ${POINT_RADIUS}`);
  if (!isOneOf(attr(pointTag, 'fill'), BLACK)) fail('the point must be cut in black (fill="#000")');
  const tiles = svg.match(/<rect\b[^>]*>/g) ?? [];
  if (!tiles.some((t) => attr(t, 'fill') === 'currentColor' && attr(t, 'rx') === String(TILE_RADIUS))) {
    fail(`the drawn tile must be a rect with rx="${TILE_RADIUS}" and fill="currentColor"`);
  }
  const cut = attr(cutTag, 'd');
  const cx = Number(attr(pointTag, 'cx'));
  const cy = Number(attr(pointTag, 'cy'));
  if (!cut) fail('the cut <path> has no d');
  if (!Number.isFinite(cx) || !Number.isFinite(cy)) fail('the point <circle> needs numeric cx and cy');
  return { cut, join: 'miter', point: [cx, cy] };
}

// ── Building the art ───────────────────────────────────────────────────────────────────────

const glyph = (mark, colour) =>
  `<path d="${mark.cut}" fill="none" stroke="${colour}" stroke-width="${STROKE}" stroke-linejoin="${mark.join}"/>` +
  `<circle cx="${mark.point[0]}" cy="${mark.point[1]}" r="${POINT_RADIUS}" fill="${colour}"/>`;

/** Raster art: the paper glyph on an ink tile ('tile', transparent corners) or square ('square', full bleed). */
export function rasterArtSvg(mark, size, shape) {
  const tile = shape === 'tile' ? `<rect width="${VIEWBOX}" height="${VIEWBOX}" rx="${TILE_RADIUS}" fill="${INK}"/>` : `<rect width="${VIEWBOX}" height="${VIEWBOX}" fill="${INK}"/>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${VIEWBOX} ${VIEWBOX}" fill="none">${tile}${glyph(mark, PAPER)}</svg>`;
}

/** The glyph alone in white, cropped to the glyph area: a notification badge (read as alpha). */
export function badgeArtSvg(mark, size) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="${BADGE_VIEWBOX}" fill="none">${glyph(mark, PAPER)}</svg>`;
}

/** The manifest SVG icon: the raster art as a file (ink tile, paper glyph, transparent corners). */
export function iconSvg(mark, name) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${VIEWBOX} ${VIEWBOX}" fill="none" role="img" aria-label="${name}">
  <title>${name}</title>
  <!-- Generated by scripts/gen-icons.mjs from its studio's *-mark.svg. Do not edit: edit the source and re-run npm run gen:icons. -->
  <rect width="${VIEWBOX}" height="${VIEWBOX}" rx="${TILE_RADIUS}" fill="${INK}"/>
  <path d="${mark.cut}" fill="none" stroke="${PAPER}" stroke-width="${STROKE}" stroke-linejoin="${mark.join}"/>
  <circle cx="${mark.point[0]}" cy="${mark.point[1]}" r="${POINT_RADIUS}" fill="${PAPER}"/>
</svg>
`;
}

/** The tab favicon: ink tile on light browser chrome, paper tile on dark, glyph cut out (Atlas app/icon.svg). */
export function faviconSvg(mark, studio) {
  const id = `ds-${studio}-favicon`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${VIEWBOX} ${VIEWBOX}" fill="none">
  <!-- Generated by scripts/gen-icons.mjs from its studio's *-mark.svg. Do not edit: edit the source and re-run npm run gen:icons. -->
  <style>
    .tile { fill: ${INK}; }
    @media (prefers-color-scheme: dark) { .tile { fill: ${FAVICON_DARK_TILE}; } }
  </style>
  <defs>
    <mask id="${id}" maskUnits="userSpaceOnUse" x="0" y="0" width="${VIEWBOX}" height="${VIEWBOX}">
      <rect width="${VIEWBOX}" height="${VIEWBOX}" rx="${TILE_RADIUS}" fill="#fff"/>
      <path d="${mark.cut}" fill="none" stroke="#000" stroke-width="${STROKE}" stroke-linejoin="${mark.join}"/>
      <circle cx="${mark.point[0]}" cy="${mark.point[1]}" r="${POINT_RADIUS}" fill="#000"/>
    </mask>
  </defs>
  <rect class="tile" width="${VIEWBOX}" height="${VIEWBOX}" rx="${TILE_RADIUS}" mask="url(#${id})"/>
</svg>
`;
}

// ── Rasterising and encoding ───────────────────────────────────────────────────────────────

const png = (svg) => sharp(Buffer.from(svg)).png({ compressionLevel: 9 }).toBuffer();

async function rgba(svg) {
  const { data, info } = await sharp(Buffer.from(svg)).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { width: info.width, height: info.height, data };
}

/**
 * A Windows icon file holding each image as a 32-bit BMP (BITMAPINFOHEADER, straight alpha, rows
 * bottom-up, then the 1-bit AND mask, 1 = transparent). BMP rather than embedded PNG so every reader
 * takes it, Windows' own shell included.
 */
export function encodeIco(images) {
  const dirSize = 6 + 16 * images.length;
  const bodies = images.map(({ width, height, data }) => {
    if (width > 256 || height > 256) throw new Error(`ICO images are at most 256 px, got ${width}x${height}`);
    const maskStride = Math.ceil(width / 32) * 4;
    const pixels = Buffer.alloc(width * height * 4);
    const mask = Buffer.alloc(maskStride * height);
    for (let y = 0; y < height; y++) {
      const row = height - 1 - y; // BMP rows run bottom-up
      for (let x = 0; x < width; x++) {
        const src = (y * width + x) * 4;
        const dst = (row * width + x) * 4;
        pixels[dst] = data[src + 2];
        pixels[dst + 1] = data[src + 1];
        pixels[dst + 2] = data[src];
        pixels[dst + 3] = data[src + 3];
        if (data[src + 3] === 0) mask[row * maskStride + (x >> 3)] |= 0x80 >> (x & 7);
      }
    }
    const header = Buffer.alloc(40);
    header.writeUInt32LE(40, 0); // biSize
    header.writeInt32LE(width, 4);
    header.writeInt32LE(height * 2, 8); // the XOR image plus the AND mask
    header.writeUInt16LE(1, 12); // planes
    header.writeUInt16LE(32, 14); // bits per pixel
    header.writeUInt32LE(0, 16); // BI_RGB
    header.writeUInt32LE(pixels.length + mask.length, 20);
    return Buffer.concat([header, pixels, mask]);
  });
  const dir = Buffer.alloc(dirSize);
  dir.writeUInt16LE(0, 0); // reserved
  dir.writeUInt16LE(1, 2); // type: icon
  dir.writeUInt16LE(images.length, 4);
  let offset = dirSize;
  images.forEach(({ width, height }, i) => {
    const at = 6 + 16 * i;
    dir.writeUInt8(width === 256 ? 0 : width, at);
    dir.writeUInt8(height === 256 ? 0 : height, at + 1);
    dir.writeUInt8(0, at + 2); // no palette
    dir.writeUInt8(0, at + 3);
    dir.writeUInt16LE(1, at + 4); // planes
    dir.writeUInt16LE(32, at + 6); // bits per pixel
    dir.writeUInt32LE(bodies[i].length, at + 8);
    dir.writeUInt32LE(offset, at + 12);
    offset += bodies[i].length;
  });
  return Buffer.concat([dir, ...bodies]);
}

/** Reads the 32-bit BMP images of an ICO back into top-down RGBA (for --check and the tests). */
export function decodeIco(buf) {
  if (buf.readUInt16LE(0) !== 0 || buf.readUInt16LE(2) !== 1) throw new Error('not an ICO file');
  const count = buf.readUInt16LE(4);
  const images = [];
  for (let i = 0; i < count; i++) {
    const at = 6 + 16 * i;
    const width = buf.readUInt8(at) || 256;
    const height = buf.readUInt8(at + 1) || 256;
    const size = buf.readUInt32LE(at + 8);
    const offset = buf.readUInt32LE(at + 12);
    const body = buf.subarray(offset, offset + size);
    if (body.readUInt32LE(0) !== 40 || body.readUInt16LE(14) !== 32) throw new Error(`ICO image ${i} is not a 32-bit BMP`);
    const data = Buffer.alloc(width * height * 4);
    for (let y = 0; y < height; y++) {
      const row = height - 1 - y;
      for (let x = 0; x < width; x++) {
        const src = 40 + (row * width + x) * 4;
        const dst = (y * width + x) * 4;
        data[dst] = body[src + 2];
        data[dst + 1] = body[src + 1];
        data[dst + 2] = body[src];
        data[dst + 3] = body[src + 3];
      }
    }
    images.push({ width, height, data });
  }
  return images;
}

/** Renders one output of a studio. */
export async function renderOutput(output, mark, set) {
  switch (output.kind) {
    case 'tile':
    case 'square':
      return png(rasterArtSvg(mark, output.size, output.kind));
    case 'badge':
      return png(badgeArtSvg(mark, output.size));
    case 'icon-svg':
      return Buffer.from(iconSvg(mark, set.name));
    case 'favicon-svg':
      return Buffer.from(faviconSvg(mark, set.studio));
    case 'ico':
      return encodeIco(await Promise.all(ICO_SIZES.map((s) => rgba(rasterArtSvg(mark, s, 'tile')))));
    default:
      throw new Error(`unknown output kind ${output.kind}`);
  }
}

/** Reads every source and renders every output: [{ file, kind, buffer }]. Writes nothing. */
export async function buildAll(root = ROOT) {
  const out = [];
  for (const set of ICON_SETS) {
    const mark = parseMarkSvg(await readFile(path.join(root, set.source), 'utf8'), set.source);
    for (const output of set.outputs) out.push({ ...output, studio: set.studio, buffer: await renderOutput(output, mark, set) });
  }
  return out;
}

// ── Comparing (for --check and the tests) ──────────────────────────────────────────────────

async function pixels(buffer, kind) {
  if (kind === 'ico') return decodeIco(buffer);
  const { data, info } = await sharp(buffer).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return [{ width: info.width, height: info.height, data }];
}

/** Why a committed output differs from a freshly rendered one, or null when it matches. */
export async function compareOutput(output, committed, tolerance = 2) {
  if (output.kind === 'icon-svg' || output.kind === 'favicon-svg') {
    return committed.equals(output.buffer) ? null : 'differs from what its source generates';
  }
  let a;
  let b;
  try {
    [a, b] = await Promise.all([pixels(output.buffer, output.kind), pixels(committed, output.kind)]);
  } catch (err) {
    return `cannot be read (${err.message})`;
  }
  if (a.length !== b.length) return `has ${b.length} images, expected ${a.length}`;
  for (let i = 0; i < a.length; i++) {
    if (a[i].width !== b[i].width || a[i].height !== b[i].height) return `image ${i} is ${b[i].width}x${b[i].height}, expected ${a[i].width}x${a[i].height}`;
    for (let p = 0; p < a[i].data.length; p++) {
      if (Math.abs(a[i].data[p] - b[i].data[p]) > tolerance) return `image ${i} differs at byte ${p}`;
    }
  }
  return null;
}

async function main() {
  const check = process.argv.includes('--check');
  const outputs = await buildAll();
  const problems = [];
  for (const output of outputs) {
    const file = path.join(ROOT, output.file);
    if (check) {
      let committed;
      try {
        committed = await readFile(file);
      } catch {
        problems.push(`${output.file}: missing`);
        continue;
      }
      const why = await compareOutput(output, committed);
      if (why) problems.push(`${output.file}: ${why}`);
      continue;
    }
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, output.buffer);
    console.log(`${output.file.padEnd(40)} ${String(output.size ? `${output.size}px` : output.kind).padEnd(12)} ${output.buffer.length} B`);
  }
  if (check) {
    if (problems.length) {
      console.error(`Icons out of date (run npm run gen:icons):\n  ${problems.join('\n  ')}`);
      process.exit(1);
    }
    console.log(`All ${outputs.length} icon outputs match their sources.`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
