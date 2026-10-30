// @vitest-environment node
import { afterEach, describe, it, expect, vi } from 'vitest';
import sharp, { type Metadata } from 'sharp';

vi.mock('./mcpClient.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./mcpClient.js')>();
  return { ...actual, assertSafePublicUrl: vi.fn(actual.assertSafePublicUrl) };
});

import { assertSafePublicUrl } from './mcpClient.js';
import { convertImageTool } from './convertImage.js';

const run = (args: Record<string, unknown>) => convertImageTool.execute(args, new AbortController().signal);

const canvas = (w = 16, h = 16) => sharp({ create: { width: w, height: h, channels: 3, background: { r: 200, g: 30, b: 30 } } });
const dataUri = (subtype: string, buf: Buffer) => `data:image/${subtype};base64,${buf.toString('base64')}`;
const pngDataUri = async (w = 16, h = 16): Promise<string> => dataUri('png', await canvas(w, h).png().toBuffer());
const decode = (uri: string): Buffer => Buffer.from(uri.split(',')[1], 'base64');
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><rect width="16" height="16" fill="red"/></svg>');

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

/** The refusal the byte allowlist gives (before sharp sees the input). */
const expectRefused = (res: Awaited<ReturnType<typeof run>>, why: RegExp) => {
  expect(res.images).toBeUndefined();
  expect(res.notice).toEqual({ level: 'error', message: 'Image type not allowed', fix: 'Use a JPG, PNG, WebP or GIF image.' });
  expect(res.content).toMatch(/^Couldn't convert the image: /);
  expect(res.content).toMatch(why);
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('convert_image tool', () => {
  it('converts a PNG data URI to a real JPEG', async () => {
    const res = await run({ image: await pngDataUri(), to: 'jpeg' });
    expect(res.images?.[0].url).toMatch(/^data:image\/jpeg;base64,/);
    const meta = await sharp(decode(res.images![0].url)).metadata();
    expect(meta.format).toBe('jpeg');
  });

  it('converts to webp', async () => {
    const res = await run({ image: await pngDataUri(), to: 'webp' });
    const meta = await sharp(decode(res.images![0].url)).metadata();
    expect(meta.format).toBe('webp');
  });

  it('resizes without upscaling', async () => {
    const res = await run({ image: await pngDataUri(100, 100), to: 'png', width: 20 });
    const meta = await sharp(decode(res.images![0].url)).metadata();
    expect(meta.width).toBe(20);
  });

  it('rejects input that is neither an https URL nor a data URI', async () => {
    const res = await run({ image: 'just some text' });
    expect(res.images).toBeUndefined();
    expect(res.content).toMatch(/url|data:image/i);
  });

  it('blocks private/loopback URLs (SSRF guard)', async () => {
    const res = await run({ image: 'https://127.0.0.1/x.png' });
    expect(res.images).toBeUndefined();
    expect(res.content).toMatch(/couldn't load/i);
  });

  it('errors gracefully on non-image bytes', async () => {
    const res = await run({ image: `data:image/png;base64,${Buffer.from('not an image').toString('base64')}` });
    expect(res.images).toBeUndefined();
    expect(res.notice?.level).toBe('error');
  });
});

describe('convert_image: inputs are admitted by their bytes (JPEG, PNG, WebP, GIF only)', () => {
  it('the 4 allowed formats convert', async () => {
    for (const [fmt, buf] of [
      ['jpeg', await canvas(40, 30).jpeg().toBuffer()],
      ['png', await canvas(40, 30).png().toBuffer()],
      ['webp', await canvas(40, 30).webp().toBuffer()],
      ['gif', await canvas(40, 30).gif().toBuffer()]
    ] as const) {
      const res = await run({ image: dataUri(fmt, buf), to: fmt === 'png' ? 'webp' : 'png' });
      expect(res.notice, fmt).toBeUndefined();
      expect(res.images, fmt).toHaveLength(1);
      const meta = await sharp(decode(res.images![0].url)).metadata();
      expect([meta.format, meta.width, meta.height], fmt).toEqual([fmt === 'png' ? 'webp' : 'png', 40, 30]);
    }
  });

  it('SVG data URIs are refused, whatever subtype they declare', async () => {
    expectRefused(await run({ image: dataUri('svg+xml', SVG) }), /SVG and HTML files can't be used as images here/);
    expectRefused(await run({ image: dataUri('png', SVG) }), /SVG/);
    expectRefused(await run({ image: dataUri('png', Buffer.from('<!doctype html><svg onload="x()"></svg>')) }), /SVG and HTML/);
  });

  it('a PNG header on a TIFF body is refused', async () => {
    const tiff = await canvas().tiff().toBuffer();
    // A `data:image/png` header over TIFF bytes: the declared type is ignored and TIFF is not allowed.
    expectRefused(await run({ image: dataUri('png', tiff), to: 'png' }), /contents aren't a JPG, PNG, WebP or GIF image/);
    // The PNG signature in front of a TIFF body sniffs as PNG but never decodes into an image.
    const polyglot = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), tiff]);
    const res = await run({ image: dataUri('png', polyglot), to: 'png' });
    expect(res.images).toBeUndefined();
    expect(res.notice?.level).toBe('error');
  });

  it('HEIC is refused (a real, decodable HEIF file branded heic), and so is AVIF input', async () => {
    const heic = await heicBytes();
    expect((await sharp(heic).metadata()).format).toBe('heif'); // sharp alone would decode it
    expectRefused(await run({ image: dataUri('heic', heic), to: 'png' }), /HEIC photos aren't supported here/);
    expectRefused(await run({ image: dataUri('png', heic), to: 'png' }), /HEIC/);
    expectRefused(await run({ image: dataUri('avif', await canvas().avif().toBuffer()), to: 'png' }), /AVIF images can't be used here/);
  });

  it('the declared subtype never decides: JPEG bytes under a png header convert as the JPEG they are', async () => {
    const res = await run({ image: dataUri('png', await canvas(20, 10).jpeg().toBuffer()), to: 'webp' });
    expect(res.notice).toBeUndefined();
    expect((await sharp(decode(res.images![0].url)).metadata()).format).toBe('webp');
  });

  it('bytes fetched from an https URL are sniffed the same way (SVG refused, PNG converts)', async () => {
    vi.mocked(assertSafePublicUrl).mockResolvedValue(undefined);
    const fetchMock = vi.fn(async (url: string) => {
      const body = url.endsWith('.svg') ? SVG : await canvas(12, 12).png().toBuffer();
      return new Response(new Uint8Array(body), { status: 200, headers: { 'content-type': 'image/png' } });
    });
    vi.stubGlobal('fetch', fetchMock);
    expectRefused(await run({ image: 'https://images.example.com/logo.svg', to: 'png' }), /SVG/);
    const ok = await run({ image: 'https://images.example.com/photo.png', to: 'jpeg' });
    expect(ok.images).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('sharp must decode the bytes as the format they were sniffed as', async () => {
    const proto = (sharp as unknown as { prototype: { metadata: (...a: unknown[]) => Promise<Metadata> } }).prototype;
    vi.spyOn(proto, 'metadata').mockResolvedValueOnce({ format: 'tiff' } as Metadata);
    expectRefused(await run({ image: await pngDataUri(), to: 'jpeg' }), /start like PNG but don't decode as one/);
  });
});
