// Reader preferences and deep links (contract §13.5 keys, §1 URL params): storage is optional and
// validated; the creator's settings are overridden locally; resume is offered only when useful; the
// URL params p / lang / guided / panel round-trip and preserve everything else.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_READER } from '../../../shared/comic/doc';
import {
  DEFAULT_PREFS,
  effectiveReader,
  introPlayed,
  LAYOUT_KEY,
  markIntroPlayed,
  PREFS_KEY,
  readLayoutPref,
  readPosition,
  readPrefs,
  sanitizePrefs,
  shouldOfferResume,
  writeLayoutPref,
  writePosition,
  writePrefs
} from './readerPrefs';
import { createUrlSync, parseReaderParams, withReaderParams } from './readerUrl';

afterEach(() => {
  window.localStorage.clear();
  window.sessionStorage.clear();
  vi.useRealTimers();
});

describe('prefs', () => {
  it('defaults, round-trip, and validation of stored junk', () => {
    expect(readPrefs()).toEqual(DEFAULT_PREFS);
    writePrefs({ ...DEFAULT_PREFS, turn: 'slide', sound: true, wpm: 260 });
    expect(readPrefs()).toMatchObject({ turn: 'slide', sound: true, wpm: 260 });
    window.localStorage.setItem(PREFS_KEY, '{"turn":"spin","wpm":999,"paper":"maybe","sound":"yes"}');
    expect(readPrefs()).toEqual(DEFAULT_PREFS);
    window.localStorage.setItem(PREFS_KEY, 'not json');
    expect(readPrefs()).toEqual(DEFAULT_PREFS);
    expect(sanitizePrefs(null)).toEqual(DEFAULT_PREFS);
  });

  it('survives blocked storage', () => {
    const spy = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    expect(readPrefs()).toEqual(DEFAULT_PREFS);
    expect(readLayoutPref()).toBe('auto');
    spy.mockRestore();
    const set = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('quota');
    });
    expect(() => writePrefs(DEFAULT_PREFS)).not.toThrow();
    set.mockRestore();
  });

  it('the layout choice shares the inline reader key ("page" = single)', () => {
    writeLayoutPref('single');
    expect(window.localStorage.getItem(LAYOUT_KEY)).toBe('page');
    expect(readLayoutPref()).toBe('single');
    writeLayoutPref('auto');
    expect(window.localStorage.getItem(LAYOUT_KEY)).toBeNull();
  });

  it('viewer prefs override the creator; paper texture is off for webtoons and strips', () => {
    const creator = { ...DEFAULT_READER, turn: 'fade' as const, paperTexture: true };
    expect(effectiveReader(creator, DEFAULT_PREFS, 'comic')).toEqual({ turn: 'fade', paper: true, ambient: true, guidedOverview: true });
    expect(effectiveReader(creator, { ...DEFAULT_PREFS, turn: 'paper', paper: 'off', ambient: 'off' }, 'manga')).toMatchObject({ turn: 'paper', paper: false, ambient: false });
    expect(effectiveReader(creator, DEFAULT_PREFS, 'webtoon').paper).toBe(false);
    expect(effectiveReader(undefined, DEFAULT_PREFS, 'strip')).toMatchObject({ turn: 'paper', paper: false });
  });
});

describe('position, intro', () => {
  it('stores the reading position per comic and offers resume only when useful', () => {
    writePosition('doc1', { key: 'pg_5', at: 1000, panel: 2 });
    expect(readPosition('doc1')).toEqual({ key: 'pg_5', at: 1000, panel: 2 });
    expect(readPosition('other')).toBeNull();
    const pos = readPosition('doc1');
    expect(shouldOfferResume(pos, 4, 2000)).toBe(true);
    expect(shouldOfferResume(pos, 1, 2000)).toBe(false); // not far enough in
    expect(shouldOfferResume(pos, 4, 1000 + 31 * 24 * 3600 * 1000)).toBe(false); // too old
    window.localStorage.setItem('comicstudio.reader.pos.bad', '{"key":5}');
    expect(readPosition('bad')).toBeNull();
  });

  it('the cover intro plays once per session per comic', () => {
    expect(introPlayed('doc1')).toBe(false);
    markIntroPlayed('doc1');
    expect(introPlayed('doc1')).toBe(true);
    expect(introPlayed('doc2')).toBe(false);
  });
});

describe('reader URL params', () => {
  it('parses p / lang / guided / panel and ignores junk and rejected aliases', () => {
    expect(parseReaderParams('?view=read&id=x&p=3&lang=te&guided=1&panel=2')).toEqual({ p: 3, lang: 'te', guided: true, panel: 2 });
    expect(parseReaderParams('p=0')).toEqual({ p: 0 });
    expect(parseReaderParams('?p=-1&lang=<script>&guided=yes&panel=0')).toEqual({});
    expect(parseReaderParams('?page=4&mode=spread')).toEqual({});
    expect(parseReaderParams('?lang=pt-BR')).toEqual({ lang: 'pt-BR' });
  });

  it('writes params back preserving everything else', () => {
    expect(withReaderParams('/c/AbC123?via=x#top', { p: 4, lang: 'hi' })).toBe('/c/AbC123?via=x&p=4&lang=hi#top');
    expect(withReaderParams('/?view=read&id=1&p=4&guided=1&panel=2', { p: 0 })).toBe('/?view=read&id=1&p=0');
    expect(withReaderParams('https://example.com/c/a?p=1', { p: 2, guided: true, panel: 3 })).toBe('https://example.com/c/a?p=2&guided=1&panel=3');
    // A panel without guided is meaningless and dropped.
    expect(withReaderParams('/c/a', { p: 2, panel: 3 })).toBe('/c/a?p=2');
  });

  it('debounces replaceState and never pushes history', () => {
    vi.useFakeTimers();
    window.history.replaceState(null, '', '/c/test?via=s');
    const replace = vi.spyOn(window.history, 'replaceState');
    const push = vi.spyOn(window.history, 'pushState');
    const sync = createUrlSync(300);
    sync.schedule({ p: 1 });
    sync.schedule({ p: 2, lang: 'te' });
    expect(replace).not.toHaveBeenCalled();
    vi.advanceTimersByTime(300);
    expect(replace).toHaveBeenCalledTimes(1);
    expect(window.location.search).toBe('?via=s&p=2&lang=te');
    expect(push).not.toHaveBeenCalled();
    replace.mockRestore();
    push.mockRestore();
  });
});
