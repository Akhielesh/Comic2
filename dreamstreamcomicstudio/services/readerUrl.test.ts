import { beforeEach, describe, expect, it } from 'vitest';
import { clearReaderUrlParams, setReaderUrlParams } from './readerUrl';

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
