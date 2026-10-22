import { describe, expect, it } from 'vitest';
import { ASSET_KEY_RE, SHARE_PATH, SLUG_LENGTH, SLUG_RE, buildShareUrl, isPublicationMirror, parseShareParams } from './publication';

describe('share links', () => {
  it('slugs carry ≥ 96 bits', () => {
    expect(SLUG_LENGTH * Math.log2(62)).toBeGreaterThanOrEqual(96);
    expect(SLUG_RE.test('A1b2C3d4E5f6G7h8J')).toBe(true);
    expect(SLUG_RE.test('A1b2C3d4')).toBe(false); // the rejected 8-char slugs
    expect(SLUG_RE.test('A1b2C3d4E5f6G7h8J/')).toBe(false);
    expect(SLUG_RE.test('A1b2C3d4E5f6G7h8_')).toBe(false);
    expect(ASSET_KEY_RE.test('a'.repeat(22))).toBe(true);
    expect(SHARE_PATH('abc')).toBe('/c/abc');
  });

  it('buildShareUrl drops defaults and invalid params', () => {
    const slug = 'A1b2C3d4E5f6G7h8J';
    expect(buildShareUrl('https://dreamstreamstudio.ai/', slug)).toBe(`https://dreamstreamstudio.ai/c/${slug}`);
    expect(buildShareUrl('https://dreamstreamstudio.ai', slug, { page: 3, lang: 'hi', via: 'whatsapp', guided: true })).toBe(
      `https://dreamstreamstudio.ai/c/${slug}?p=3&lang=hi&guided=1&via=whatsapp`
    );
    expect(buildShareUrl('https://x.ai', slug, { page: 2, lang: 'en' }, { defaultLang: 'en', startPage: 2 })).toBe(`https://x.ai/c/${slug}`);
    expect(buildShareUrl('https://x.ai', slug, { page: 0 })).toBe(`https://x.ai/c/${slug}?p=0`);
    expect(buildShareUrl('https://x.ai', slug, { page: 9999, lang: '<script>', via: 'evil' as never })).toBe(`https://x.ai/c/${slug}?p=500`);
  });

  it('parseShareParams clamps and allow-lists', () => {
    expect(parseShareParams('?p=7&lang=zh-Hans&via=qr&guided=1')).toEqual({ page: 7, lang: 'zh-Hans', via: 'qr', guided: true });
    expect(parseShareParams('p=99999&lang=../../etc&via=spam&guided=yes')).toEqual({ page: 500 });
    expect(parseShareParams(new URLSearchParams('p=-1&page=4&mode=x'))).toEqual({});
    const round = parseShareParams(new URL(buildShareUrl('https://x.ai', 'A1b2C3d4E5f6G7h8J', { page: 0, lang: 'te', guided: true })).search);
    expect(round).toEqual({ page: 0, lang: 'te', guided: true });
  });

  it('isPublicationMirror', () => {
    const ok = { visibility: 'unlisted', status: 'live', publishedRev: 1, publishedAt: 2, languages: ['en'] };
    expect(isPublicationMirror(ok)).toBe(true);
    expect(isPublicationMirror({ ...ok, slug: 'A1b2C3d4E5f6G7h8J' })).toBe(true);
    expect(isPublicationMirror({ ...ok, slug: 'short' })).toBe(false);
    expect(isPublicationMirror({ ...ok, visibility: 'private' })).toBe(false);
    expect(isPublicationMirror({ ...ok, languages: [1] })).toBe(false);
    expect(isPublicationMirror(null)).toBe(false);
  });
});
