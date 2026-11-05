// @vitest-environment node
/**
 * The studio marks as installable-app icons and favicons (docs/design, "brand marks").
 *
 * Every icon a manifest, a page head, the comics host's edge branding or the code points at must
 * exist, be the format its MIME type says (read from the file's own bytes, not its name) and have
 * the pixel size it declares; /favicon.ico must be a real ICO (it used to be missing, so the SPA
 * fallback answered 200 text/html); maskable art must keep the glyph inside the 80% safe zone; and
 * every committed output must be exactly what scripts/gen-icons.mjs makes from the source marks,
 * whose geometry must equal what the React marks draw.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { BRAND } from '../../comics-edge/src/brand';
import { STUDIO_MARKS } from '../../components/brand/studios';
import { ICON_SETS, ICO_SIZES, buildAll, compareOutput, decodeIco, parseMarkSvg } from '../../scripts/gen-icons.mjs';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const PUBLIC = path.join(ROOT, 'public');
const read = (rel: string) => readFileSync(path.join(ROOT, rel), 'utf8');
const publicFile = (src: string) => path.join(PUBLIC, src.replace(/^\//, ''));

type Format = 'png' | 'ico' | 'svg' | 'unknown';
const MIME: Record<Exclude<Format, 'unknown'>, string[]> = {
  png: ['image/png'],
  svg: ['image/svg+xml'],
  ico: ['image/x-icon', 'image/vnd.microsoft.icon'],
};

/** The file's real format, from its first bytes. */
function formatOf(buf: Buffer): Format {
  if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (buf.length >= 6 && buf.readUInt16LE(0) === 0 && buf.readUInt16LE(2) === 1) return 'ico';
  const head = buf.subarray(0, 512).toString('utf8').trimStart();
  if (/^(<\?xml[^>]*>\s*)?<svg\b/.test(head)) return 'svg';
  return 'unknown';
}

/** PNG width and height from the IHDR chunk. */
function pngSize(buf: Buffer): [number, number] {
  expect(buf.subarray(12, 16).toString('latin1')).toBe('IHDR');
  return [buf.readUInt32BE(16), buf.readUInt32BE(20)];
}

/** The sizes an ICO directory lists, after checking every entry is a well-formed 32-bit BMP inside the file. */
function icoSizes(buf: Buffer): string[] {
  const count = buf.readUInt16LE(4);
  expect(count).toBeGreaterThan(0);
  let expectedOffset = 6 + 16 * count;
  const sizes: string[] = [];
  for (let i = 0; i < count; i++) {
    const at = 6 + 16 * i;
    const w = buf.readUInt8(at) || 256;
    const h = buf.readUInt8(at + 1) || 256;
    expect(buf.readUInt16LE(at + 4), 'planes').toBe(1);
    expect(buf.readUInt16LE(at + 6), 'bit count').toBe(32);
    const bytes = buf.readUInt32LE(at + 8);
    const offset = buf.readUInt32LE(at + 12);
    expect(offset, 'images are packed in order').toBe(expectedOffset);
    expect(offset + bytes).toBeLessThanOrEqual(buf.length);
    const dib = buf.subarray(offset, offset + bytes);
    expect(dib.readUInt32LE(0), 'BITMAPINFOHEADER').toBe(40);
    expect(dib.readInt32LE(4)).toBe(w);
    expect(dib.readInt32LE(8), 'XOR image plus AND mask').toBe(h * 2);
    expect(dib.readUInt16LE(14)).toBe(32);
    expect(dib.readUInt32LE(16), 'BI_RGB').toBe(0);
    expect(bytes).toBe(40 + w * h * 4 + Math.ceil(w / 32) * 4 * h);
    expectedOffset += bytes;
    sizes.push(`${w}x${h}`);
  }
  expect(expectedOffset, 'no trailing bytes').toBe(buf.length);
  return sizes;
}

/** Checks one reference: the file exists, is what its type says, and has every size it declares. */
function checkIcon(where: string, src: string, opts: { type?: string | null; sizes?: string | null }) {
  const label = `${where}: ${src}`;
  expect(src.startsWith('/'), `${label} is a same-origin absolute path`).toBe(true);
  const file = publicFile(src.split(/[?#]/)[0]);
  expect(existsSync(file), `${label} exists in public/`).toBe(true);
  const buf = readFileSync(file);
  const format = formatOf(buf);
  expect(format, `${label} is an image`).not.toBe('unknown');
  if (opts.type) expect(MIME[format as Exclude<Format, 'unknown'>], `${label} is really ${opts.type}`).toContain(opts.type);
  const declared = (opts.sizes ?? '').split(/\s+/).filter(Boolean);
  if (format === 'png') {
    const [w, h] = pngSize(buf);
    for (const s of declared) expect(`${w}x${h}`, label).toBe(s);
  } else if (format === 'ico') {
    const sizes = icoSizes(buf);
    for (const s of declared) expect(sizes, label).toContain(s);
  } else {
    for (const s of declared) expect(s, `${label}: an SVG is sizes "any"`).toBe('any');
    expect(buf.toString('utf8'), `${label} is square`).toMatch(/viewBox="0 0 (\d+(?:\.\d+)?) \1"/);
  }
  return { buf, format };
}

type ManifestIcon = { src: string; sizes?: string; type?: string; purpose?: string };
type Manifest = { icons: ManifestIcon[]; shortcuts?: { icons?: ManifestIcon[] }[]; background_color: string; theme_color: string };
const MANIFESTS = ['app', 'comics', 'stream', 'live'].map((n) => `public/${n}.webmanifest`);
const manifest = (rel: string) => JSON.parse(read(rel)) as Manifest;
const headLinks = (rel: string) =>
  [...new JSDOM(read(rel)).window.document.head.querySelectorAll('link')].map((l) => ({
    rel: l.getAttribute('rel') ?? '',
    href: l.getAttribute('href') ?? '',
    type: l.getAttribute('type'),
    sizes: l.getAttribute('sizes'),
  }));

async function rgba(file: string) {
  const { data, info } = await sharp(file).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { data, w: info.width, h: info.height, at: (x: number, y: number) => data.subarray((y * info.width + x) * 4, (y * info.width + x) * 4 + 4) };
}

describe('every icon a manifest lists', () => {
  it.each(MANIFESTS)('%s: icons and shortcut icons exist at their declared size and type', (rel) => {
    const m = manifest(rel);
    const all = [...m.icons, ...(m.shortcuts ?? []).flatMap((s) => s.icons ?? [])];
    expect(all.length).toBeGreaterThan(0);
    for (const icon of all) checkIcon(rel, icon.src, { type: icon.type, sizes: icon.sizes });
  });

  it.each(MANIFESTS)('%s: installable on Android and desktop (PNG 192 and 512 any, PNG 512 maskable)', (rel) => {
    const icons = manifest(rel).icons;
    const has = (sizes: string, purpose: string) =>
      icons.some((i) => i.type === 'image/png' && i.sizes === sizes && (i.purpose ?? 'any').split(/\s+/).includes(purpose));
    expect(has('192x192', 'any')).toBe(true);
    expect(has('512x512', 'any')).toBe(true);
    expect(has('512x512', 'maskable')).toBe(true);
  });

  it('Stream Studio installs with its On-air icons, white like the Atlas skin', () => {
    for (const rel of ['public/stream.webmanifest', 'public/live.webmanifest']) {
      const m = manifest(rel);
      expect(m.background_color, rel).toBe('#ffffff');
      expect(m.theme_color, rel).toBe('#ffffff');
      expect(m.icons.map((i) => i.src)).toEqual([
        '/icons/stream-192.png',
        '/icons/stream-512.png',
        '/icons/stream-maskable-512.png',
        '/icons/stream-icon.svg',
      ]);
    }
  });

  it('a manifest SVG icon is opaque art (a transparent cut would take a dark launcher colour)', () => {
    for (const rel of MANIFESTS) {
      for (const icon of manifest(rel).icons.filter((i) => i.type === 'image/svg+xml')) {
        const svg = readFileSync(publicFile(icon.src), 'utf8');
        expect(svg, icon.src).not.toContain('<mask');
        expect(svg, icon.src).not.toContain('currentColor');
        expect(svg, icon.src).toMatch(/<rect [^>]*fill="#0a0a0a"/);
      }
    }
  });
});

describe('page heads', () => {
  it('index.html links an SVG favicon and the multi-size /favicon.ico, both real', () => {
    const links = headLinks('index.html');
    const icons = links.filter((l) => l.rel.split(/\s+/).includes('icon'));
    expect(icons.map((l) => l.href).sort()).toEqual(['/favicon.ico', '/icons/dreamstream-favicon.svg']);
    expect(icons.find((l) => l.href.endsWith('.svg'))!.type).toBe('image/svg+xml');
    for (const l of [...icons, ...links.filter((x) => x.rel === 'apple-touch-icon')]) checkIcon('index.html', l.href, l);
    const touch = links.find((l) => l.rel === 'apple-touch-icon')!;
    expect(pngSize(readFileSync(publicFile(touch.href)))).toEqual([180, 180]);
    for (const l of links.filter((x) => x.rel === 'manifest')) expect(existsSync(publicFile(l.href)), l.href).toBe(true);
  });

  it('live.html: every icon and manifest it links exists and is what it declares', () => {
    for (const l of headLinks('live.html')) {
      if (l.rel === 'manifest') expect(existsSync(publicFile(l.href)), l.href).toBe(true);
      else if (/\b(icon|apple-touch-icon)\b/.test(l.rel)) checkIcon('live.html', l.href, l);
    }
  });

  it('the comics host rebrands to icons that exist (comics-edge/src/brand.ts)', () => {
    checkIcon('BRAND.appleTouchIcon', BRAND.appleTouchIcon, { type: 'image/png', sizes: '180x180' });
    checkIcon('BRAND.icon', BRAND.icon, { type: 'image/svg+xml' });
    checkIcon('BRAND.iconIco', BRAND.iconIco, { sizes: '16x16 32x32 48x48' });
    checkIcon('BRAND.ogImage', BRAND.ogImage, { type: 'image/png', sizes: `${BRAND.ogImageWidth}x${BRAND.ogImageHeight}` });
    expect(existsSync(publicFile(BRAND.manifest))).toBe(true);
  });

  it('static icon paths stay outside Pages Functions and cache like the other icons', () => {
    const routes = JSON.parse(read('public/_routes.json')) as { exclude: string[] };
    expect(routes.exclude).toEqual(expect.arrayContaining(['/favicon.ico', '/icons/*', '/stream-studio.svg']));
    expect(read('public/_headers')).toMatch(/^\/favicon\.ico\n\s+Cache-Control: public, max-age=86400/m);
  });
});

const SCANNED = ['live', 'components', 'services', 'functions', 'comics-edge/src', 'public/live-sw.js', 'App.tsx', 'index.tsx'];
const SOURCE = /\.(tsx?|jsx?|mjs)$/;
const files = (rel: string): string[] => {
  const full = path.join(ROOT, rel);
  if (!existsSync(full)) return [];
  if (!statSync(full).isDirectory()) return [rel];
  return readdirSync(full).flatMap((e) => (e === 'node_modules' || e.startsWith('.') ? [] : files(path.join(rel, e))));
};

/** Every literal /icons/…, /favicon.ico or /stream-studio.svg in the app code, with the file naming it. */
function codeRefs(): Map<string, string> {
  const refs = new Map<string, string>();
  for (const rel of SCANNED.flatMap(files).filter((f) => SOURCE.test(f) && !/\.test\.|\.unit\.test\./.test(f))) {
    for (const m of read(rel).matchAll(/['"`](\/(?:icons\/[\w.-]+|favicon\.ico|stream-studio\.svg))['"`]/g)) refs.set(m[1], rel);
  }
  return refs;
}

/**
 * Generated for Stream Studio, wired by step 2a, which owns the files that name them: live.html (the
 * ICO and SVG favicons, the PNG touch icon iOS needs) and public/live-sw.js + live/monitor/push.ts (the
 * PNG notification icon and badge). docs/design/brand-marks.md lists them as "not wired yet".
 */
const STAGED_FOR_STREAM = new Set([
  '/icons/stream-favicon.ico',
  '/icons/stream-favicon.svg',
  '/icons/stream-apple-touch-180.png',
  '/icons/stream-badge-96.png',
]);

/**
 * Generated at a long-standing address that must keep answering after nothing current names it.
 * /stream-studio.svg: step 2a moves live.html, public/live-sw.js and live/monitor/push.ts to the
 * files above, but installs, bookmarks and notifications made before that still ask for it, so it
 * stays a generator output (the On-air favicon) and stays a static file (public/_routes.json).
 */
const KEPT_FOR_OLD_LINKS = new Set(['/stream-studio.svg']);

const GENERATED = ICON_SETS.flatMap((s) => s.outputs.map((o) => `/${o.file.replace(/^public\//, '')}`));

describe('icon paths named in code', () => {
  it('every literal /icons/…, /favicon.ico or /stream-studio.svg in the app code exists', () => {
    const refs = codeRefs();
    expect(refs.size).toBeGreaterThan(3);
    for (const [src, from] of refs) expect(existsSync(publicFile(src)), `${src} (named in ${from})`).toBe(true);
  });

  it('every generated icon is used: by a manifest, a page head, the comics edge or app code (or staged for Stream Studio, or kept for old links)', () => {
    const used = new Set<string>([
      ...MANIFESTS.flatMap((rel) => {
        const m = manifest(rel);
        return [...m.icons, ...(m.shortcuts ?? []).flatMap((s) => s.icons ?? [])].map((i) => i.src);
      }),
      ...['index.html', 'live.html'].flatMap((rel) => headLinks(rel).map((l) => l.href)),
      BRAND.appleTouchIcon,
      BRAND.icon,
      BRAND.iconIco,
      ...codeRefs().keys(),
    ]);
    const exempt = (src: string) => STAGED_FOR_STREAM.has(src) || KEPT_FOR_OLD_LINKS.has(src);
    expect(GENERATED.filter((src) => !used.has(src) && !exempt(src))).toEqual([]);
    for (const src of STAGED_FOR_STREAM) expect(GENERATED, src).toContain(src);
  });

  it('a path kept for old links is still generated and still served as a static file', () => {
    const routes = JSON.parse(read('public/_routes.json')) as { exclude: string[] };
    for (const src of KEPT_FOR_OLD_LINKS) {
      expect(GENERATED, `${src} is a scripts/gen-icons.mjs output`).toContain(src);
      expect(routes.exclude, `${src} stays outside Pages Functions`).toContain(src);
    }
  });
});

describe('the art', () => {
  const ICO_FILES = ICON_SETS.flatMap((s) => s.outputs.filter((o) => o.kind === 'ico').map((o) => o.file));

  it.each(ICO_FILES)('%s is a real 16/32/48 ICO, not the SPA fallback', (rel) => {
    const buf = readFileSync(path.join(ROOT, rel));
    expect(formatOf(buf)).toBe('ico');
    expect(icoSizes(buf)).toEqual(ICO_SIZES.map((s) => `${s}x${s}`));
    for (const img of decodeIco(buf)) {
      const alpha = (x: number, y: number) => img.data[(y * img.width + x) * 4 + 3];
      expect(alpha(0, 0), 'rounded tile: clear corner').toBe(0);
      const mid = Math.floor(img.width / 2);
      expect(alpha(mid, 1), 'opaque tile edge').toBe(255);
    }
  });

  const maskables = ICON_SETS.flatMap((s) => s.outputs.filter((o) => o.kind === 'square' && o.size === 512).map((o) => o.file));
  // One expect per check, not per pixel: 262k expect() calls per 512px icon took ~3s alone and
  // timed out at vitest's 5s default when the whole suite runs in parallel.
  it.each(maskables)('%s keeps the glyph inside the maskable safe zone (a 40 percent radius) on full-bleed ink', async (rel) => {
    const img = await rgba(path.join(ROOT, rel));
    const c = img.w / 2;
    let glyph = 0;
    let farthest = 0;
    let seeThrough = 0;
    for (let y = 0; y < img.h; y++) {
      for (let x = 0; x < img.w; x++) {
        const i = (y * img.w + x) * 4;
        const r = img.data[i];
        const g = img.data[i + 1];
        const b = img.data[i + 2];
        if (img.data[i + 3] !== 255) seeThrough++;
        if (r + g + b > 3 * 128) {
          glyph++;
          farthest = Math.max(farthest, Math.hypot(x + 0.5 - c, y + 0.5 - c));
        }
      }
    }
    expect(seeThrough, 'full bleed: every pixel opaque').toBe(0);
    expect(glyph, 'the glyph is drawn').toBeGreaterThan(img.w * img.h * 0.05);
    expect(farthest / img.w, 'inside the 80% safe-zone circle').toBeLessThanOrEqual(0.4);
    expect(farthest / img.w, 'not shrunk into a dot').toBeGreaterThan(0.3);
  });

  const touches = ICON_SETS.flatMap((s) => s.outputs.filter((o) => o.kind === 'square' && o.size === 180).map((o) => o.file));
  it.each(touches)('%s is full bleed (iOS shows black behind transparency)', async (rel) => {
    const img = await rgba(path.join(ROOT, rel));
    expect([img.w, img.h]).toEqual([180, 180]);
    let seeThrough = 0;
    for (let i = 3; i < img.data.length; i += 4) if (img.data[i] !== 255) seeThrough++;
    expect(seeThrough, 'every pixel opaque').toBe(0);
  });

  const tiles = ICON_SETS.flatMap((s) => s.outputs.filter((o) => o.kind === 'tile').map((o) => o.file));
  it.each(tiles)('%s is the rounded ink tile: clear corners, opaque body, paper glyph', async (rel) => {
    const img = await rgba(path.join(ROOT, rel));
    expect(img.at(0, 0)[3]).toBe(0);
    expect(img.at(img.w - 1, img.h - 1)[3]).toBe(0);
    expect([...img.at(Math.floor(img.w / 2), 2)]).toEqual([10, 10, 10, 255]);
  });

  it('the Stream badge is the glyph alone, white on transparent (Android reads its alpha)', async () => {
    const img = await rgba(path.join(ROOT, 'public/icons/stream-badge-96.png'));
    let opaque = 0;
    for (let i = 0; i < img.data.length; i += 4) {
      if (img.data[i + 3] > 0) {
        opaque++;
        expect([img.data[i], img.data[i + 1], img.data[i + 2]]).toEqual([255, 255, 255]);
      }
    }
    expect(opaque / (img.w * img.h)).toBeGreaterThan(0.1);
    expect(opaque / (img.w * img.h)).toBeLessThan(0.6);
  });

  it('favicons follow the browser chrome: ink tile on light, paper tile on dark, glyph cut out', () => {
    const favicons = ICON_SETS.flatMap((s) => s.outputs.filter((o) => o.kind === 'favicon-svg').map((o) => o.file));
    expect(favicons).toContain('public/stream-studio.svg');
    for (const rel of favicons) {
      const svg = read(rel);
      expect(svg, rel).toMatch(/\.tile \{ fill: #0a0a0a; \}/);
      expect(svg, rel).toMatch(/@media \(prefers-color-scheme: dark\) \{ \.tile \{ fill: #fafafa; \} \}/);
      expect(svg, rel).toMatch(/<mask id="ds-[a-z]+-favicon"/);
    }
  });

  it('no shipped SVG can run script or load anything (same-origin SVG is a document)', () => {
    const svgs = ['public/stream-studio.svg', ...readdirSync(path.join(PUBLIC, 'icons')).filter((f) => f.endsWith('.svg')).map((f) => `public/icons/${f}`)];
    for (const rel of svgs) {
      const svg = read(rel);
      expect(svg, rel).not.toMatch(/<script|<foreignObject|\son\w+\s*=|javascript:|(?:xlink:)?href="(?!#)|@import|url\((?!#)/i);
    }
  });
});

describe('sources, React marks and generated outputs agree', () => {
  it.each(ICON_SETS)('$source has the geometry StudioMark draws for $studio', (set) => {
    const mark = parseMarkSvg(read(set.source), set.source);
    const spec = STUDIO_MARKS[set.studio as keyof typeof STUDIO_MARKS];
    expect(mark.cut).toBe(spec.cut);
    expect(mark.point).toEqual([...spec.point]);
    expect(mark.join).toBe('miter');
    expect(read(set.source)).toContain(`aria-label="${spec.name}"`);
  });

  it('rejects a source that is not built the family way', () => {
    const good = read('public/icons/stream-mark.svg');
    expect(() => parseMarkSvg(good.replace('stroke-width="7"', 'stroke-width="6"'), 'x')).toThrow(/stroke-width must be 7/);
    expect(() => parseMarkSvg(good.replace('r="3.6"', 'r="4"'), 'x')).toThrow(/r must be 3.6/);
    expect(() => parseMarkSvg(good.replace('viewBox="0 0 64 64"', 'viewBox="0 0 48 48"'), 'x')).toThrow(/viewBox/);
    expect(() => parseMarkSvg(good.replace('fill="currentColor"', 'fill="#000"'), 'x')).toThrow(/currentColor/);
    // The mask itself: what it keeps and how the cut is drawn (the outputs are always mitred, butt-ended).
    expect(() => parseMarkSvg(good.replace('stroke-linejoin="miter"', 'stroke-linejoin="round"'), 'x')).toThrow(/mitred/);
    expect(() => parseMarkSvg(good.replace('stroke-width="7"', 'stroke-width="7" stroke-linecap="round"'), 'x')).toThrow(/butt/);
    expect(() => parseMarkSvg(good.replace('rx="16" fill="#fff"', 'rx="4" fill="#fff"'), 'x')).toThrow(/keep rect must have rx="16"/);
    expect(() => parseMarkSvg(good.replace('stroke="#000"', 'stroke="#fff"'), 'x')).toThrow(/black stroke/);
    expect(() => parseMarkSvg(good.replace('r="3.6" fill="#000"', 'r="3.6" fill="#fff"'), 'x')).toThrow(/point must be cut in black/);
    expect(() => parseMarkSvg(good.replace('maskUnits="userSpaceOnUse"', 'maskUnits="objectBoundingBox"'), 'x')).toThrow(/userSpaceOnUse/);
    for (const variant of [good, good.replace(' stroke-linejoin="miter"', '')]) expect(parseMarkSvg(variant, 'x').join).toBe('miter');
  });

  it('every committed icon is exactly what npm run gen:icons makes from the sources', async () => {
    const outputs = await buildAll(ROOT);
    expect(outputs).toHaveLength(ICON_SETS.reduce((n, s) => n + s.outputs.length, 0));
    const stale: string[] = [];
    for (const output of outputs) {
      const file = path.join(ROOT, output.file);
      const why = existsSync(file) ? await compareOutput(output, readFileSync(file)) : 'missing';
      if (why) stale.push(`${output.file}: ${why}`);
    }
    expect(stale, 'run npm run gen:icons').toEqual([]);
  }, 30_000);
});
