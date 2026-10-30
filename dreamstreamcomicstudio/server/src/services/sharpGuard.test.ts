// @vitest-environment node
// W1.10: the process-wide sharp guard. Importing the module installs it (server/src/index.ts does that
// at boot), so these tests run with the guard on, as production does.
import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp, { type FormatEnum } from 'sharp';
import {
  SHARP_BLOCKED_LOADERS,
  allowedImageWords,
  checkImageBytes,
  installSharpGuard,
  sharpGuardStatus,
  sniffImageType
} from './sharpGuard.js';
import { outlineRegionDataUrl, sniffImageType as assetsSniffImageType } from '../comic/assets.js';

const here = dirname(fileURLToPath(import.meta.url));
const canvas = (w = 24, h = 16) => sharp({ create: { width: w, height: h, channels: 3, background: { r: 40, g: 120, b: 200 } } });
const tiffBytes = () => canvas().tiff().toBuffer();
/** libvips' loader lookup skips a blocked loader, so sharp reports the input as unsupported. */
const REFUSED = /unsupported image format/i;

/** A real, decodable HEIF file whose ftyp brands say HEIC (sharp writes AV1 HEIF; the brands are relabelled). */
const heicBytes = async (): Promise<Buffer> => {
  const buf = Buffer.from(await canvas().avif().toBuffer());
  const size = buf.readUInt32BE(0);
  for (let i = 8; i + 4 <= size; i += 4) {
    const brand = buf.subarray(i, i + 4).toString('latin1');
    if (brand === 'avif' || brand === 'avis') buf.write('heic', i, 'latin1');
  }
  return buf;
};

describe('sharp guard: process-wide loader block', () => {
  it('importing the module installs the guard: a TIFF sent straight to sharp is refused', async () => {
    expect(sharpGuardStatus()).toEqual({ installed: true, blocked: SHARP_BLOCKED_LOADERS });
    const tiff = await tiffBytes();
    await expect(sharp(tiff).metadata()).rejects.toThrow(REFUSED);
    await expect(sharp(tiff).png().toBuffer()).rejects.toThrow(REFUSED);
    // From a path too (the File loader is a subclass of the blocked base).
    const dir = mkdtempSync(join(tmpdir(), 'sharp-guard-'));
    try {
      const file = join(dir, 'page.tif');
      writeFileSync(file, tiff);
      await expect(sharp(file).metadata()).rejects.toThrow(/unsupported image format/i);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('the block is what refuses it: unguarded, the same TIFF decodes; installSharpGuard() blocks it again', async () => {
    const tiff = await tiffBytes();
    sharp.unblock({ operation: [...SHARP_BLOCKED_LOADERS] });
    try {
      expect((await sharp(tiff).metadata()).format).toBe('tiff');
    } finally {
      expect(installSharpGuard()).toEqual({ installed: true, blocked: SHARP_BLOCKED_LOADERS });
    }
    await expect(sharp(tiff).metadata()).rejects.toThrow(REFUSED);
  });

  it("operation names follow sharp's api-utility docs for block() and libvips' loader class names", () => {
    // sharp's API docs (api-utility) are generated from this JSDoc; read the copy that ships with the installed sharp.
    const req = createRequire(import.meta.url);
    const docs = readFileSync(join(dirname(req.resolve('sharp')), 'index.d.mts'), 'utf8');
    const blockDoc = /\/\*\*((?:(?!\*\/)[\s\S])*?)\*\/\s*export function block\(options: \{ operation: string\[\] \}\): void;/.exec(docs)?.[1] ?? '';
    expect(blockDoc).toMatch(/List of libvips low-level operation names to block/);
    const since = /@since (\d+)\.(\d+)\.(\d+)/.exec(blockDoc);
    expect(since?.slice(1).join('.')).toBe('0.32.4');
    const [maj, min, pat] = sharp.versions.sharp.split('.').map(Number);
    expect(maj > 0 || min > 32 || (min === 32 && pat >= 4)).toBe(true);
    // The docs' own TIFF example name is the one we block, verbatim.
    const tiffExample = /Block all TIFF input[\s\S]*?operation: \['([A-Za-z0-9]+)'\]/.exec(blockDoc)?.[1];
    expect(tiffExample).toBe('VipsForeignLoadTiff');
    expect(SHARP_BLOCKED_LOADERS).toContain(tiffExample);
    // Every entry is an abstract loader base (covers its File/Buffer/Source subclasses), one per risky family.
    for (const name of SHARP_BLOCKED_LOADERS) {
      expect(name).toMatch(/^VipsForeignLoad[A-Z][a-z0-9]+$/);
      expect(name).not.toMatch(/(File|Buffer|Source)$/);
    }
    expect([...SHARP_BLOCKED_LOADERS].sort()).toEqual(
      [
        'VipsForeignLoadFits',
        'VipsForeignLoadJp2k',
        'VipsForeignLoadMagick',
        'VipsForeignLoadMagick7',
        'VipsForeignLoadMatrix',
        'VipsForeignLoadOpenslide',
        'VipsForeignLoadPdf',
        'VipsForeignLoadTiff'
      ].sort()
    );
  });

  it('every guarded format this sharp build can load is refused (samples written by sharp itself)', async () => {
    const guarded: Record<string, string> = {
      tiff: 'VipsForeignLoadTiff',
      magick: 'VipsForeignLoadMagick',
      pdf: 'VipsForeignLoadPdf',
      jp2: 'VipsForeignLoadJp2k',
      fits: 'VipsForeignLoadFits',
      openslide: 'VipsForeignLoadOpenslide'
    };
    const formats = sharp.format as unknown as Record<string, { input: { buffer: boolean; file: boolean }; output: { buffer: boolean } } | undefined>;
    const loadable: string[] = [];
    for (const [key, op] of Object.entries(guarded)) {
      expect(SHARP_BLOCKED_LOADERS).toContain(op);
      const f = formats[key];
      if (!f || !(f.input.buffer || f.input.file)) continue;
      loadable.push(key);
      expect(f.output.buffer, `${key} loads in this sharp build but sharp can't write a sample: add a fixture here`).toBe(true);
      const sample = await canvas().toFormat(key as keyof FormatEnum).toBuffer();
      await expect(sharp(sample).metadata(), key).rejects.toThrow(REFUSED);
    }
    // The prebuilt libvips loads TIFF, so the loop above is never vacuous.
    expect(loadable).toContain('tiff');
  });

  it('never throws at boot: a sharp without block() or a failing block() is reported and logged, not thrown', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      expect(installSharpGuard({})).toEqual({ installed: false, blocked: [], reason: 'sharp.block is not available in this sharp build' });
      expect(warn).toHaveBeenLastCalledWith('[sharpGuard] loader block NOT installed: sharp.block is not available in this sharp build');
      expect(
        installSharpGuard({
          block: () => {
            throw new Error('nope');
          }
        })
      ).toMatchObject({ installed: false, reason: 'sharp.block failed: nope' });
      expect(warn).toHaveBeenLastCalledWith('[sharpGuard] loader block NOT installed: sharp.block failed: nope');
      expect(warn).toHaveBeenCalledTimes(2);
      // libvips ignores names its build lacks (most of the list, with the prebuilt binaries).
      expect(() => sharp.block({ operation: ['VipsForeignLoadNotInThisBuild'] })).not.toThrow();
    } finally {
      expect(installSharpGuard().installed).toBe(true);
      // A working install is silent.
      expect(warn).toHaveBeenCalledTimes(2);
      warn.mockRestore();
    }
  });

  it('a boot whose sharp has no block() says so in the server log (the import itself warns)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.resetModules();
    vi.doMock('sharp', () => ({ default: {} }));
    try {
      const booted = await import('./sharpGuard.js');
      expect(booted.sharpGuardStatus()).toMatchObject({ installed: false, reason: 'sharp.block is not available in this sharp build' });
      expect(warn).toHaveBeenCalledWith('[sharpGuard] loader block NOT installed: sharp.block is not available in this sharp build');
    } finally {
      vi.doUnmock('sharp');
      vi.resetModules();
      warn.mockRestore();
    }
    // The module instance the rest of this file uses (and production's) still has the guard on.
    expect(sharpGuardStatus().installed).toBe(true);
  });

  it("the server's own image paths still work with the guard on: SVG composite (assets.ts Mark-up), SVG render, AVIF, text, raw", async () => {
    // comic/assets.ts outlineRegionDataUrl composites a generated SVG rectangle over the page image.
    const page = await canvas(1000, 500).png().toBuffer();
    const out = await outlineRegionDataUrl(`data:image/png;base64,${page.toString('base64')}`, { x: 0.1, y: 0.1, w: 0.5, h: 0.5 });
    expect(out).toMatch(/^data:image\/webp;base64,/);
    const outBuf = Buffer.from(out.split(',')[1], 'base64');
    const meta = await sharp(outBuf).metadata();
    expect([meta.format, meta.width, meta.height]).toEqual(['webp', 1000, 500]);
    // The stroke really is drawn (6 px at this size): the box's top edge is red, the page outside the box is not.
    const { data, info } = await sharp(outBuf).raw().toBuffer({ resolveWithObject: true });
    const px = (x: number, y: number) => Array.from(data.subarray((y * info.width + x) * info.channels, (y * info.width + x) * info.channels + 3));
    const [r, g, b] = px(300, 50);
    expect(r).toBeGreaterThan(200);
    expect(g).toBeLessThan(60);
    expect(b).toBeLessThan(60);
    expect(px(900, 450)[0]).toBeLessThan(100);

    // Model Lab fixtures and OG cards render SVG and Pango text; comic uploads decode AVIF (HEIF loader).
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10" fill="#0a0"/></svg>');
    expect((await sharp(await sharp(svg).png().toBuffer()).metadata()).format).toBe('png');
    expect((await sharp(await canvas().avif().toBuffer()).metadata()).format).toBe('heif');
    expect((await sharp({ text: { text: 'ok', rgba: true } }).png().toBuffer()).byteLength).toBeGreaterThan(50);
    const raw = await sharp(Buffer.alloc(12, 200), { raw: { width: 2, height: 2, channels: 3 } }).png().toBuffer();
    expect((await sharp(raw).metadata()).width).toBe(2);
  });

  it('server boot imports the guard before any other module of ours (server/src/index.ts)', () => {
    const src = readFileSync(join(here, '..', 'index.ts'), 'utf8');
    const imports = [...src.matchAll(/^import\s+(?:[^'";]+?\s+from\s+)?['"]([^'"]+)['"]/gm)].map((m) => m[1]);
    expect(imports[0]).toBe('dotenv/config');
    expect(imports[1]).toBe('./services/sharpGuard.js');
    expect(imports.filter((p) => p === './services/sharpGuard.js')).toHaveLength(1);
  });
});

describe('sharp guard: magic-byte sniff and allowlist', () => {
  const ftyp = (major: string, ...compat: string[]) => {
    const brands = [major, '\0\0\0\0', ...compat].join('');
    const box = Buffer.concat([Buffer.alloc(4), Buffer.from(`ftyp${brands}`, 'latin1')]);
    box.writeUInt32BE(box.byteLength, 0);
    return Buffer.concat([box, Buffer.alloc(16)]);
  };

  it('names bytes, never the declared type, with the same verdicts as comic/assets.ts', async () => {
    const fixtures: [string, Buffer, string][] = [
      ['png', await canvas().png().toBuffer(), 'png'],
      ['jpeg', await canvas().jpeg().toBuffer(), 'jpeg'],
      ['webp', await canvas().webp().toBuffer(), 'webp'],
      ['gif89a', await canvas().gif().toBuffer(), 'gif'],
      ['gif87a', Buffer.from('GIF87a\x01\x00\x01\x00\x00\x00\x00;', 'latin1'), 'gif'],
      ['avif', await canvas().avif().toBuffer(), 'avif'],
      ['heic (relabelled HEIF)', await heicBytes(), 'heic'],
      ['heic brand only', ftyp('heic', 'mif1'), 'heic'],
      ['ftyp, unknown brand (mp4)', ftyp('isom', 'mp42'), 'unknown'],
      ['svg', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'), 'svg'],
      ['svg after BOM and spaces', Buffer.from('﻿  \n<svg/>'), 'svg'],
      ['xml prolog', Buffer.from('<?xml version="1.0"?><x/>'), 'svg'],
      ['html', Buffer.from('<!doctype html><p>hi</p>'), 'html'],
      ['tiff', await tiffBytes(), 'unknown'],
      ['pdf', Buffer.from('%PDF-1.7\n%âãÏÓ\n1 0 obj<<>>endobj\n%%EOF'), 'unknown'],
      ['jp2', Buffer.from([0, 0, 0, 0x0c, 0x6a, 0x50, 0x20, 0x20, 0x0d, 0x0a, 0x87, 0x0a]), 'unknown'],
      ['PNG signature then a TIFF body', Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), await tiffBytes()]), 'png'],
      ['three bytes', Buffer.from([0xff, 0xd8, 0xff]), 'unknown'],
      ['empty', Buffer.alloc(0), 'unknown'],
      ['text', Buffer.from('just some text'), 'unknown']
    ];
    for (const [name, buf, want] of fixtures) {
      expect(sniffImageType(buf), name).toBe(want);
      expect(assetsSniffImageType(buf), `${name} (assets.ts parity)`).toBe(want);
    }
    expect(sniffImageType('not a buffer' as unknown as Buffer)).toBe('unknown');
  });

  it('agrees with comic/assets.ts on every branch: a seeded sweep of header pieces (drift guard until one sniffer remains)', () => {
    // Deterministic PRNG (mulberry32) so a failure names a reproducible case.
    let seed = 0x5eed1010;
    const rand = () => {
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)];
    const bytes = (n: number) => Buffer.from(Array.from({ length: n }, () => Math.floor(rand() * 256)));
    const NEUTRAL = ['isom', 'mp42', 'crx ', 'jp2 ', 'qt  '];
    const BRANDS = ['avif', 'avis', 'heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'hevm', 'hevs', 'mif1', 'msf1', 'mif2', ...NEUTRAL];
    const ftypBox = () => {
      // Neutral filler, then one brand that may decide: it lands anywhere from byte 16 to past the 256-byte window.
      const filler = Array.from({ length: Math.floor(rand() * 80) }, () => pick(NEUTRAL)).join('');
      const major = rand() < 0.5 ? pick(NEUTRAL) : pick(BRANDS);
      const box = Buffer.concat([Buffer.alloc(4), Buffer.from(`ftyp${major}\0\0\0\0${filler}${pick(BRANDS)}`, 'latin1')]);
      box.writeUInt32BE(pick([0, 8, 12, 16, 20, box.byteLength, box.byteLength, 300, 0xffffffff]), 0); // 0, short, true, oversized
      return box;
    };
    const pieces: (() => Buffer)[] = [
      () => Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      () => Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a]),
      () => Buffer.from([0xff, 0xd8, 0xff]),
      () => Buffer.from([0xff, 0xd8]),
      () => Buffer.from(pick(['GIF87a', 'GIF89a', 'GIF8', 'GIF90a']), 'latin1'),
      () => Buffer.concat([Buffer.from('RIFF', 'latin1'), bytes(4), Buffer.from(pick(['WEBP', 'WAVE', 'WEB']), 'latin1')]),
      ftypBox,
      () => Buffer.from([0xef, 0xbb, 0xbf]),
      () => Buffer.from(' \t\r\n'.repeat(pick([1, 3, 100, 300])), 'latin1'), // up to 1,200 bytes of whitespace
      () => Buffer.from(pick(['<svg', '<SVG width="1">', '<?xml version="1.0"?>', '<!doctype html>', '<html>', '<', '<p>x</p><svg']), 'latin1'),
      () => bytes(Math.floor(rand() * 24))
    ];
    const seen = new Set<string>();
    for (let n = 0; n < 3000; n += 1) {
      const parts = Array.from({ length: 1 + Math.floor(rand() * 4) }, () => pick(pieces)());
      const buf = Buffer.concat([...parts, bytes(Math.floor(rand() * 40))]);
      const ours = sniffImageType(buf);
      expect(ours, `case ${n}: ${buf.subarray(0, 48).toString('hex')}`).toBe(assetsSniffImageType(buf));
      seen.add(ours);
    }
    // The sweep reaches every verdict, so no branch goes unchecked.
    expect([...seen].sort()).toEqual(['avif', 'gif', 'heic', 'html', 'jpeg', 'png', 'svg', 'unknown', 'webp']);
  });

  it('admits only JPEG, PNG, WebP and GIF, and says why anything else is refused', async () => {
    for (const [fmt, buf] of [
      ['jpeg', await canvas().jpeg().toBuffer()],
      ['png', await canvas().png().toBuffer()],
      ['webp', await canvas().webp().toBuffer()],
      ['gif', await canvas().gif().toBuffer()]
    ] as const) {
      expect(checkImageBytes(buf)).toEqual({ ok: true, type: fmt });
    }
    const svg = checkImageBytes(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'));
    expect(svg).toMatchObject({ ok: false, type: 'svg' });
    expect(!svg.ok && svg.reason).toMatch(/SVG and HTML files can't be used as images here\. Use a JPG, PNG, WebP or GIF image$/);
    const heic = checkImageBytes(await heicBytes());
    expect(heic).toMatchObject({ ok: false, type: 'heic' });
    expect(!heic.ok && heic.reason).toMatch(/^HEIC photos aren't supported here/);
    // Exporting fixes this photo; the iPhone setting only changes how new photos are saved.
    expect(!heic.ok && heic.reason).toBe(
      "HEIC photos aren't supported here. Export the photo as JPEG, or on iPhone choose “Most Compatible” in Settings › Camera › Formats for new photos. Use a JPG, PNG, WebP or GIF image"
    );
    expect(checkImageBytes(await canvas().avif().toBuffer())).toMatchObject({ ok: false, type: 'avif', reason: "AVIF images can't be used here. Use a JPG, PNG, WebP or GIF image" });
    expect(checkImageBytes(await tiffBytes())).toMatchObject({ ok: false, type: 'unknown' });
    // A narrower allowlist narrows the verdict and the wording.
    expect(checkImageBytes(await canvas().gif().toBuffer(), ['png', 'jpeg'])).toMatchObject({ ok: false, type: 'gif', reason: "GIF images can't be used here. Use a PNG or JPG image" });
    expect(allowedImageWords(['png'])).toBe('a PNG image');
  });
});
