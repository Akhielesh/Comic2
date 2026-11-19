// @vitest-environment node
// The landing's pictures and clip (public/landing): every file the manifest names exists and stays within its cap
// (about 120 KB each), every file in the folder is named by the manifest, each still is twice its display size (sharp
// on 2x screens) and the poster matches the clip, every source is same-origin under /landing/, and each item says in
// words what it shows. The landing's own sources name no other origin for media.
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { LANDING_MEDIA, MEDIA_CAP_BYTES, type LandingSources } from './landingMedia';

const APP = path.resolve(__dirname, '../../..');
const PUBLIC = path.join(APP, 'public');
const fileOf = (src: string) => path.join(PUBLIC, src);
const sourcesOf = (s: LandingSources) => [s.webp, s.webm, s.mp4, s.poster].filter((x): x is string => !!x);

/** A WebP's pixel size from its header (VP8, VP8L or VP8X). */
const webpSize = (buf: Buffer): { w: number; h: number } => {
  expect(buf.toString('ascii', 0, 4)).toBe('RIFF');
  expect(buf.toString('ascii', 8, 12)).toBe('WEBP');
  const chunk = buf.toString('ascii', 12, 16);
  if (chunk === 'VP8X') return { w: 1 + buf.readUIntLE(24, 3), h: 1 + buf.readUIntLE(27, 3) };
  if (chunk === 'VP8L') {
    const b = buf.readUInt32LE(21);
    return { w: (b & 0x3fff) + 1, h: ((b >> 14) & 0x3fff) + 1 };
  }
  return { w: buf.readUInt16LE(26) & 0x3fff, h: buf.readUInt16LE(28) & 0x3fff };
};

describe('landing media', () => {
  const all = LANDING_MEDIA.flatMap((m) => [...sourcesOf(m.light), ...sourcesOf(m.dark), ...(m.phone ? [...sourcesOf(m.phone.light), ...sourcesOf(m.phone.dark)] : [])]);

  it('every source is same-origin under /landing/ and exists, within the cap', () => {
    for (const src of all) {
      expect(src, src).toMatch(/^\/landing\/[a-z0-9-]+\.(webp|webm|mp4)$/);
      expect(existsSync(fileOf(src)), src).toBe(true);
      expect(statSync(fileOf(src)).size, src).toBeLessThanOrEqual(MEDIA_CAP_BYTES);
    }
  });

  it('every file in public/landing is named by the manifest', () => {
    const named = new Set(all.map((src) => path.basename(src)));
    expect(readdirSync(path.join(PUBLIC, 'landing')).filter((f) => !named.has(f))).toEqual([]);
  });

  it('stills come in light and dark at twice their display size; the clip has both formats and a poster its size', () => {
    for (const m of LANDING_MEDIA) {
      if (m.kind === 'still') {
        expect(m.light.webp).not.toBe(m.dark.webp);
        for (const src of [m.light.webp!, m.dark.webp!]) {
          const { w, h } = webpSize(readFileSync(fileOf(src)));
          expect(w, src).toBe(m.width * 2);
          expect(Math.abs(h - m.height * 2), src).toBeLessThanOrEqual(2);
        }
        // Every still has a phone crop: light and dark at three times its display size, narrow enough for a phone
        // column (so the words in it stay at 11 CSS px or more at 320 px).
        expect(m.phone, m.id).toBeTruthy();
        expect(m.phone!.width, m.id).toBeLessThanOrEqual(340);
        expect(m.phone!.light.webp).not.toBe(m.phone!.dark.webp);
        for (const src of [m.phone!.light.webp!, m.phone!.dark.webp!]) {
          const { w, h } = webpSize(readFileSync(fileOf(src)));
          expect(w, src).toBe(m.phone!.width * 3);
          expect(Math.abs(h - m.phone!.height * 3), src).toBeLessThanOrEqual(3);
        }
      } else {
        expect(m.phone).toBeUndefined();
        expect(m.light.webm && m.light.mp4 && m.light.poster).toBeTruthy();
        const { w, h } = webpSize(readFileSync(fileOf(m.light.poster!)));
        expect({ w, h }).toEqual({ w: m.width, h: m.height });
        expect(m.short).toBeTruthy();
      }
    }
  });

  it('each item says in words what it shows (alt) and carries a visible caption', () => {
    const alts = new Set<string>();
    for (const m of LANDING_MEDIA) {
      expect(m.alt.length, m.id).toBeGreaterThan(30);
      expect(m.caption.length, m.id).toBeGreaterThan(10);
      expect(alts.has(m.alt)).toBe(false);
      alts.add(m.alt);
    }
  });

  it('the landing’s sources load media from no other origin', () => {
    const dir = path.join(APP, 'components/comicshost');
    const files = [...readdirSync(dir).map((f) => path.join(dir, f)), ...readdirSync(__dirname).map((f) => path.join(__dirname, f))].filter(
      (f) => /\.tsx?$/.test(f) && !/\.test\.tsx?$/.test(f)
    );
    for (const f of files) {
      const src = readFileSync(f, 'utf8');
      expect(src.match(/\b(?:src|poster)=\{?["'`]https?:/g), f).toBeNull();
    }
  });
});
