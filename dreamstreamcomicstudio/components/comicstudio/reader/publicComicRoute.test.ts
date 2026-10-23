import { describe, expect, it } from 'vitest';
import { isPublicComicPath, parsePublicComicPath, readerStartFromSearch } from './publicComicRoute';

const SLUG = 'AbCdEfGhIjKlMnOpQ';

describe('parsePublicComicPath', () => {
  it('reads the slug, the title tail and the embed route', () => {
    expect(parsePublicComicPath(`/c/${SLUG}`)).toEqual({ slug: SLUG, embed: false });
    expect(parsePublicComicPath(`/c/${SLUG}/`)).toEqual({ slug: SLUG, embed: false });
    expect(parsePublicComicPath(`/c/${SLUG}/the-saffron-thief`)).toEqual({ slug: SLUG, embed: false });
    expect(parsePublicComicPath(`/c/${SLUG}/embed`)).toEqual({ slug: SLUG, embed: true });
  });

  it('turns a malformed /c/ path into the same dead link (empty slug), never another view', () => {
    expect(parsePublicComicPath('/c/short')).toEqual({ slug: '', embed: false });
    expect(parsePublicComicPath(`/c/${SLUG}x`)).toEqual({ slug: '', embed: false });
    expect(parsePublicComicPath(`/c/${SLUG}/Bad Tail`)).toEqual({ slug: '', embed: false });
    expect(parsePublicComicPath(`/c/${SLUG}/a/b`)).toEqual({ slug: '', embed: false });
    expect(parsePublicComicPath('/c/<script>')).toEqual({ slug: '', embed: false });
    expect(parsePublicComicPath('/c')).toEqual({ slug: '', embed: false });
  });

  it('ignores every other path', () => {
    expect(parsePublicComicPath('/')).toBeNull();
    expect(parsePublicComicPath('/comics')).toBeNull();
    expect(parsePublicComicPath('/share/abc')).toBeNull();
    expect(parsePublicComicPath(undefined)).toBeNull();
    expect(isPublicComicPath('/cart')).toBe(false);
    expect(isPublicComicPath(`/c/${SLUG}`)).toBe(true);
  });
});

describe('readerStartFromSearch', () => {
  it('reads ?p= (0 = cover), ?guided=1 and ?panel= and clamps the page', () => {
    expect(readerStartFromSearch('?p=3')).toEqual({ page: 3 });
    expect(readerStartFromSearch('?p=0')).toEqual({ page: 0 });
    expect(readerStartFromSearch('?p=9999')).toEqual({ page: 500 });
    expect(readerStartFromSearch('?p=2&guided=1&panel=4')).toEqual({ page: 2, guided: true, panel: 4 });
    expect(readerStartFromSearch('?panel=4')).toEqual({});
  });

  it('ignores junk', () => {
    expect(readerStartFromSearch('?p=-1&guided=yes&panel=0')).toEqual({});
    expect(readerStartFromSearch('?p=1e3')).toEqual({});
    expect(readerStartFromSearch('')).toEqual({});
    expect(readerStartFromSearch(null)).toEqual({});
  });
});
