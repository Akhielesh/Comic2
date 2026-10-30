// refs.md §9 client: prepareImageFile — sha256 of the ORIGINAL bytes, downscale ≤ 2048, never larger
// than the original, a 15 MB phone JPEG is accepted (regression: the composer rejected > 10 MB BEFORE
// shrinking), > 40 MB / SVG / too-small refused with friendly copy, HEIC decode failure is honest.
import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { REF_LIMITS } from '../../../shared/comic/refs';
import { HEIC_HELP, ftypKind, isHeicFile } from './heic';
import { ACCEPT_ATTR, PrepareError, fitEdge, prepareImageFile, quickReject, sha256Hex16, type DecodedImage, type PrepareDeps } from './downscale';

const JPEG_HEAD = [0xff, 0xd8, 0xff, 0xe0];
const bytesOf = (size: number, head: number[] = JPEG_HEAD): Uint8Array => {
  const bytes = new Uint8Array(size);
  bytes.set(head.slice(0, size));
  for (let i = head.length; i < Math.min(size, 4096); i += 1) bytes[i] = (i * 31) & 0xff;
  return bytes;
};
const fileOf = (size: number, name: string, type: string, head: number[] = JPEG_HEAD): File => new File([bytesOf(size, head)], name, { type });
const decoded = (width: number, height: number): DecodedImage => ({ width, height, source: {} as CanvasImageSource, close: vi.fn() });
const deps = (w: number, h: number, outBytes = 400_000): PrepareDeps & { encode: ReturnType<typeof vi.fn> } => ({
  decode: vi.fn(async () => decoded(w, h)),
  encode: vi.fn(async (_img, tw: number, th: number, type: string) => new Blob([new Uint8Array(outBytes)], { type })),
  digest: async (b: ArrayBuffer) => {
    const h2 = createHash('sha256').update(Buffer.from(b)).digest();
    return h2.buffer.slice(h2.byteOffset, h2.byteOffset + h2.byteLength);
  }
});

describe('prepareImageFile', () => {
  it('a 15 MB 48 MP phone JPEG is accepted and shrunk to ≤ 2048 WebP, hashed from the ORIGINAL bytes', async () => {
    const file = fileOf(15 * 1024 * 1024, 'IMG_2041.JPG', 'image/jpeg');
    const d = deps(8000, 6000);
    const out = await prepareImageFile(file, d);
    expect(out).toMatchObject({ w: 2048, h: 1536, mimeType: 'image/webp', name: 'IMG_2041.JPG', sourceBytes: file.size });
    expect(d.encode).toHaveBeenCalledWith(expect.anything(), 2048, 1536, 'image/webp', 0.9);
    const want = createHash('sha256').update(bytesOf(15 * 1024 * 1024)).digest('hex').slice(0, 16);
    expect(out.hash).toBe(want);
    expect(out.bytes).toBeLessThanOrEqual(REF_LIMITS.maxUploadBytes);
  });

  it('never larger than the original: a small, right-sized image is sent as is', async () => {
    const small = fileOf(200_000, 'tiny.png', 'image/png', [0x89, 0x50, 0x4e, 0x47]);
    const d = deps(800, 600);
    const out = await prepareImageFile(small, d);
    expect(out.blob).toBe(small);
    expect(d.encode).not.toHaveBeenCalled();
    // Bigger than the send-as-is threshold but the re-encode came out larger: keep the original.
    const mid = fileOf(2_000_000, 'mid.webp', 'image/webp', [0x52, 0x49, 0x46, 0x46]);
    const out2 = await prepareImageFile(mid, deps(1600, 1200, 3_000_000));
    expect(out2.blob).toBe(mid);
  });

  it('falls back to JPEG when the browser cannot encode WebP', async () => {
    const d = deps(4000, 3000);
    d.encode.mockImplementationOnce(async () => null);
    const out = await prepareImageFile(fileOf(5_000_000, 'a.jpg', 'image/jpeg'), d);
    expect(out.mimeType).toBe('image/jpeg');
  });

  it('refuses honestly: over 40 MB, SVG/HTML, empty, too small, undecodable', async () => {
    const big = fileOf(REF_LIMITS.maxSourceBytes + 1, 'huge.jpg', 'image/jpeg');
    await expect(prepareImageFile(big, deps(9000, 9000))).rejects.toMatchObject({ code: 'too_big', message: 'That photo is over 40 MB — choose a smaller one.' });
    await expect(prepareImageFile(new File(['<svg/>'], 'x.svg', { type: 'image/svg+xml' }), deps(10, 10))).rejects.toMatchObject({ code: 'type' });
    await expect(prepareImageFile(new File(['<html>'], 'x.html', { type: 'text/html' }), deps(10, 10))).rejects.toMatchObject({ code: 'type' });
    await expect(prepareImageFile(new File([], 'empty.jpg', { type: 'image/jpeg' }), deps(10, 10))).rejects.toMatchObject({ code: 'empty' });
    await expect(prepareImageFile(fileOf(5000, 'icon.png', 'image/png'), deps(100, 64))).rejects.toMatchObject({ code: 'too_small', message: expect.stringMatching(/under 128 px/) });
    const broken: PrepareDeps = { ...deps(10, 10), decode: async () => Promise.reject(new Error('nope')) };
    await expect(prepareImageFile(fileOf(5000, 'a.jpg', 'image/jpeg'), broken)).rejects.toMatchObject({ code: 'decode' });
  });

  it('GIF and AVIF are accepted (first frame / decoded by the browser)', async () => {
    await expect(prepareImageFile(fileOf(3_000_000, 'cat.gif', 'image/gif', [0x47, 0x49, 0x46, 0x38]), deps(500, 400))).resolves.toMatchObject({ w: 500, h: 400 });
    await expect(prepareImageFile(fileOf(3_000_000, 'cat.avif', 'image/avif'), deps(3000, 2000))).resolves.toMatchObject({ w: 2048, h: 1365 });
    expect(ACCEPT_ATTR.split(',')).toEqual(['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/avif']);
    expect(ACCEPT_ATTR).not.toMatch(/heic/);
  });
});

describe('HEIC, honestly', () => {
  const heicHead = [0, 0, 0, 24, ...Array.from('ftypheic').map((c) => c.charCodeAt(0)), 0, 0, 0, 0, ...Array.from('mif1heic').map((c) => c.charCodeAt(0))];
  const avifHead = [0, 0, 0, 24, ...Array.from('ftypavif').map((c) => c.charCodeAt(0)), 0, 0, 0, 0, ...Array.from('mif1avif').map((c) => c.charCodeAt(0))];

  it('detects HEIC by type, name or bytes (and tells AVIF apart)', async () => {
    expect(ftypKind(new Uint8Array(heicHead))).toBe('heic');
    expect(ftypKind(new Uint8Array(avifHead))).toBe('avif');
    expect(await isHeicFile(fileOf(100, 'IMG_1.HEIC', ''))).toBe(true);
    expect(await isHeicFile(fileOf(100, 'blob', '', heicHead))).toBe(true);
    expect(await isHeicFile(fileOf(100, 'x.avif', '', avifHead))).toBe(false);
  });

  it('a browser that decodes HEIC converts it to WebP; one that cannot says exactly what to do', async () => {
    const heic = fileOf(3_000_000, 'IMG_9.heic', 'image/heic', heicHead);
    await expect(prepareImageFile(heic, deps(4032, 3024))).resolves.toMatchObject({ mimeType: 'image/webp', w: 2048, h: 1536 });
    const cannot: PrepareDeps = { ...deps(1, 1), decode: async () => Promise.reject(new Error('unsupported')) };
    const err = await prepareImageFile(heic, cannot).catch((e) => e);
    expect(err).toBeInstanceOf(PrepareError);
    expect(err).toMatchObject({ code: 'heic', message: HEIC_HELP });
  });
});

describe('helpers', () => {
  it('fitEdge never enlarges', () => {
    expect(fitEdge(800, 600)).toEqual({ w: 800, h: 600 });
    expect(fitEdge(3000, 6000)).toEqual({ w: 1024, h: 2048 });
  });

  it('quickReject pre-checks without decoding', async () => {
    expect(await quickReject(fileOf(10, 'x.svg', 'image/svg+xml'))).toMatch(/JPG, PNG/);
    expect(await quickReject(fileOf(REF_LIMITS.maxSourceBytes + 1, 'big.jpg', 'image/jpeg'))).toMatch(/over 40 MB/);
    expect(await quickReject(fileOf(10, 'ok.jpg', 'image/jpeg'))).toBeNull();
  });

  it('sha256Hex16 degrades to undefined without WebCrypto', async () => {
    expect(await sha256Hex16(new Blob(['x']), async () => Promise.reject(new Error('no crypto')))).toBeUndefined();
  });
});
