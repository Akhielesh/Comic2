import { describe, it, expect } from 'vitest';
import { decodeArticleToken, isGoogleNewsUrl, parseBatchexecuteUrl } from './googleNews.js';

const makeToken = (payload: string): string =>
  Buffer.from(`\x08\x13\x22${String.fromCharCode(payload.length)}${payload}\xd2\x01\x00`, 'latin1').toString('base64url');

describe('isGoogleNewsUrl', () => {
  it('matches rss article redirects only', () => {
    expect(isGoogleNewsUrl('https://news.google.com/rss/articles/CBMiAbc?oc=5')).toBe(true);
    expect(isGoogleNewsUrl('https://news.google.com/articles/CBMiAbc')).toBe(true);
    expect(isGoogleNewsUrl('https://news.google.com/home')).toBe(false);
    expect(isGoogleNewsUrl('https://example.com/articles/x')).toBe(false);
    expect(isGoogleNewsUrl('not a url')).toBe(false);
  });
});

describe('decodeArticleToken', () => {
  it('decodes an old-format token to its embedded URL', () => {
    const url = 'https://www.example.com/story/abc-123';
    expect(decodeArticleToken(makeToken(url))).toEqual({ url });
  });

  it('decodes a two-byte length prefix (urls ≥ 128 chars)', () => {
    const url = `https://www.example.com/${'a'.repeat(140)}`;
    const len = url.length;
    const bin = `\x08\x13\x22${String.fromCharCode((len & 0x7f) | 0x80)}${String.fromCharCode(len >> 7)}${url}\xd2\x01\x00`;
    expect(decodeArticleToken(Buffer.from(bin, 'latin1').toString('base64url'))).toEqual({ url });
  });

  it('surfaces new-format handles for the network step', () => {
    expect(decodeArticleToken(makeToken('AU_yqLPdeadbeef'))).toEqual({ handle: 'AU_yqLPdeadbeef' });
  });

  it('returns null on garbage', () => {
    expect(decodeArticleToken('!!!not-base64!!!')).toBeNull();
    expect(decodeArticleToken('')).toBeNull();
  });
});

describe('parseBatchexecuteUrl', () => {
  it('extracts the garturlres URL from the anti-JSON envelope', () => {
    const body = `)]}'\n\n[["wrb.fr","Fbv4je","[\\"garturlres\\",\\"https://www.publisher.com/story?id\\u003d1\\u0026x\\u003d2\\",1]",null,"generic"]]`;
    expect(parseBatchexecuteUrl(body)).toBe('https://www.publisher.com/story?id=1&x=2');
  });

  it('returns null when no URL is present', () => {
    expect(parseBatchexecuteUrl(')]}\'\n\n[["er"]]')).toBeNull();
  });
});
