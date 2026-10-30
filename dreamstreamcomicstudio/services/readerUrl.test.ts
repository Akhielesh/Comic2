import { beforeEach, describe, expect, it } from 'vitest';
import { clearReaderUrlParams, readerDeepLinkId, setReaderUrlParams } from './readerUrl';

describe('reader URL entries', () => {
  beforeEach(() => window.history.replaceState({}, '', '/'));

  it('opening a comic adds one ?view=read entry; a cold shared link is rewritten, never duplicated', () => {
    const before = window.history.length;
    setReaderUrlParams('p1');
    expect(window.location.search).toBe('?view=read&id=p1');
    expect(window.history.length).toBe(before + 1);
    // The same comic's link again (a cold shared link): rewrite, no second entry.
    setReaderUrlParams('p1');
    expect(window.history.length).toBe(before + 1);
    // Another comic: its own entry.
    setReaderUrlParams('p2');
    expect(window.history.length).toBe(before + 2);
  });

  it('closing rewrites the reader entry, so the next Back never lands on a stale ?view=read URL', () => {
    setReaderUrlParams('p1');
    const withReader = window.history.length;
    clearReaderUrlParams({ replace: true });
    expect(window.location.search).toBe('');
    expect(window.history.length).toBe(withReader);
  });

  it('without replace, clearing still pushes (navigation away from the reader keeps its old behaviour)', () => {
    setReaderUrlParams('p1');
    const withReader = window.history.length;
    clearReaderUrlParams();
    expect(window.history.length).toBe(withReader + 1);
  });

  it('drops the board param when opening the reader', () => {
    window.history.replaceState({}, '', '/?board=1');
    setReaderUrlParams('p1');
    expect(new URLSearchParams(window.location.search).has('board')).toBe(false);
  });
});

describe('readerDeepLinkId', () => {
  it('names the comic of a shared reader link and nothing else', () => {
    expect(readerDeepLinkId('?view=read&id=abc')).toBe('abc');
    expect(readerDeepLinkId('?id=abc&view=read&lang=te')).toBe('abc');
    expect(readerDeepLinkId('?view=read')).toBeNull();
    expect(readerDeepLinkId('?view=gallery&id=abc')).toBeNull();
    expect(readerDeepLinkId('')).toBeNull();
  });
});
