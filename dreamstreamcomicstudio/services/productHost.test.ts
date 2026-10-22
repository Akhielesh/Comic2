import { describe, expect, it } from 'vitest';
import { COMICS_ORIGIN, comicShareUrl, comicsUrl, isComicsHost, mainAppUrl } from './productHost';

describe('productHost', () => {
  it('recognises the comics host and its alias, case-insensitively', () => {
    expect(isComicsHost('comics.dreamstreamstudio.ai')).toBe(true);
    expect(isComicsHost('COMICS.dreamstreamstudio.ai.')).toBe(true);
    expect(isComicsHost('comic.dreamstreamstudio.ai')).toBe(true);
  });

  it('rejects the apex, other products and look-alikes', () => {
    for (const host of [
      'dreamstreamstudio.ai',
      'atlas.dreamstreamstudio.ai',
      'comic2.pages.dev',
      'localhost',
      'comics.dreamstreamstudio.ai.evil.com',
      'evilcomics.dreamstreamstudio.ai',
      ''
    ]) expect(isComicsHost(host)).toBe(false);
  });

  it('builds absolute URLs on each origin', () => {
    expect(comicsUrl()).toBe(`${COMICS_ORIGIN}/`);
    expect(comicsUrl('?view=studio&id=1')).toBe(`${COMICS_ORIGIN}/?view=studio&id=1`);
    expect(mainAppUrl('/account')).toBe('https://dreamstreamstudio.ai/account');
  });

  it('builds share links on the comics host and encodes the slug', () => {
    expect(comicShareUrl('aB3dE5fG7hJ9kL1mN')).toBe('https://comics.dreamstreamstudio.ai/c/aB3dE5fG7hJ9kL1mN');
    expect(comicShareUrl('a/../b')).toBe('https://comics.dreamstreamstudio.ai/c/a%2F..%2Fb');
  });
});
