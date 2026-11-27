// Reader preferences and deep links (contract §13.5 keys, §1 URL params): storage is optional and
// validated; the creator's settings are overridden locally; resume is offered only when useful; the
// Page and language URL params round-trip, including when older links specify Guided View.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_READER, PAGE_TURN_STYLES } from '../../../shared/comic/doc';
import { STORED_TURN_STYLES, readReduceMotionPref, readTurnPick } from './readerMotionPref';
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
  turnStyleFor,
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
    writePrefs({ ...DEFAULT_PREFS, turn: 'slide', sound: true, room: 'day' });
    expect(readPrefs()).toMatchObject({ turn: 'slide', sound: true, room: 'day' });
    window.localStorage.setItem(PREFS_KEY, '{"turn":"slide","sound":true,"guidedOverview":"on","balloonPop":true,"wpm":260}');
    expect(readPrefs()).toEqual({ ...DEFAULT_PREFS, turn: 'slide', sound: true });
    window.localStorage.setItem(PREFS_KEY, '{"turn":"spin","wpm":999,"paper":"maybe","sound":"yes","room":"automatic"}');
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
    window.localStorage.setItem(LAYOUT_KEY, 'guided');
    expect(readLayoutPref()).toBe('auto');
  });

  it('viewer prefs override the creator; paper texture is off for webtoons and strips', () => {
    const creator = { ...DEFAULT_READER, turn: 'fade' as const, paperTexture: true };
    expect(effectiveReader(creator, DEFAULT_PREFS, 'comic')).toEqual({ turn: 'fade', paper: true, ambient: true });
    expect(effectiveReader(creator, { ...DEFAULT_PREFS, turn: 'paper', paper: 'off', ambient: 'off' }, 'manga')).toMatchObject({ turn: 'paper', paper: false, ambient: false });
    expect(effectiveReader(creator, DEFAULT_PREFS, 'webtoon').paper).toBe(false);
    expect(effectiveReader(undefined, DEFAULT_PREFS, 'strip')).toMatchObject({ turn: 'flip', paper: false });
  });

  it('the turn style: the reader’s explicit choice, then the creator’s, then the flip', () => {
    const legacy = { ...DEFAULT_READER, turn: 'paper' as const }; // every comic saved before the flip came back
    const chose = (turn: 'flip' | 'paper' | 'slide' | 'fade') => ({ ...DEFAULT_READER, turn, turnChosen: true as const });
    // No choice anywhere: the flip, whatever the comic stored as the old default.
    expect(turnStyleFor(undefined, 'auto')).toBe('flip');
    expect(turnStyleFor(DEFAULT_READER, 'auto')).toBe('flip');
    expect(turnStyleFor(legacy, 'auto')).toBe('flip');
    // The creator's choice.
    expect(turnStyleFor(chose('paper'), 'auto')).toBe('paper');
    expect(turnStyleFor({ ...DEFAULT_READER, turn: 'slide' }, 'auto')).toBe('slide');
    expect(turnStyleFor({ ...DEFAULT_READER, turn: 'fade' }, 'auto')).toBe('fade');
    // The reader's own choice wins over both.
    for (const turn of ['flip', 'paper', 'slide', 'fade'] as const) {
      expect(turnStyleFor(chose('slide'), turn)).toBe(turn);
      expect(effectiveReader(legacy, { ...DEFAULT_PREFS, turn }, 'comic').turn).toBe(turn);
    }
  });

  it('a stored paper without the reader’s mark (#316’s Reading mode switch wrote it) follows the creator, else the flip', () => {
    window.localStorage.setItem(PREFS_KEY, '{"turn":"paper","fancyTurns":"auto","sound":true}');
    const legacy = readPrefs();
    expect(legacy).toEqual({ ...DEFAULT_PREFS, sound: true });
    expect(effectiveReader(DEFAULT_READER, legacy, 'comic').turn).toBe('flip');
    expect(effectiveReader({ ...DEFAULT_READER, turn: 'slide' }, legacy, 'comic').turn).toBe('slide');
    expect(effectiveReader({ ...DEFAULT_READER, turn: 'paper', turnChosen: true }, legacy, 'comic').turn).toBe('paper');
    // Picked in "Page turn style" (marked): the reader's paper wins, and the mark survives a round trip.
    writePrefs({ ...DEFAULT_PREFS, turn: 'paper', turnPicked: true });
    expect(readPrefs()).toEqual({ ...DEFAULT_PREFS, turn: 'paper', turnPicked: true });
    expect(effectiveReader(DEFAULT_READER, readPrefs(), 'comic').turn).toBe('paper');
    // Slide and fade could only ever be picked: kept without the mark. Back to 'auto', the mark goes.
    expect(sanitizePrefs({ turn: 'fade' }).turn).toBe('fade');
    expect(sanitizePrefs({ turn: 'auto', turnPicked: true })).toEqual(DEFAULT_PREFS);
  });

  it('keeps a stored flip preference and maps anything unknown to auto', () => {
    expect(sanitizePrefs({ turn: 'flip' }).turn).toBe('flip');
    expect(sanitizePrefs({ turn: 'curl' }).turn).toBe('auto');
    expect(sanitizePrefs({}).turn).toBe('auto');
  });

  it('the landing sample reads the same pick and Reduce motion on its own (readerMotionPref), by the same rule', () => {
    // The light reader keeps its own copy of the four names: the same list, in the same order.
    expect(STORED_TURN_STYLES).toEqual([...PAGE_TURN_STYLES]);
    expect(readTurnPick()).toBeUndefined();
    expect(readReduceMotionPref()).toBe(false);
    window.localStorage.setItem(PREFS_KEY, '{"turn":"paper","fancyTurns":"auto"}');
    expect(readTurnPick(), 'an unmarked paper was never a pick').toBeUndefined();
    writePrefs({ ...DEFAULT_PREFS, turn: 'paper', turnPicked: true, reduceMotion: true });
    expect(readTurnPick()).toBe('paper');
    expect(readReduceMotionPref()).toBe(true);
    for (const turn of ['flip', 'slide', 'fade'] as const) {
      writePrefs({ ...DEFAULT_PREFS, turn });
      expect(readTurnPick()).toBe(turn);
      expect(readTurnPick()).toBe(readPrefs().turn);
    }
    window.localStorage.setItem(PREFS_KEY, '{"turn":"curl"');
    expect(readTurnPick(), 'junk storage reads as no pick').toBeUndefined();
    expect(readReduceMotionPref()).toBe(false);
  });
});

describe('position, intro', () => {
  it('stores the reading position per comic and offers resume only when useful', () => {
    writePosition('doc1', { key: 'pg_5', at: 1000 });
    expect(readPosition('doc1')).toEqual({ key: 'pg_5', at: 1000 });
    window.localStorage.setItem('comicstudio.reader.pos.doc1', '{"key":"pg_5","at":1000,"panel":2}');
    expect(readPosition('doc1')).toEqual({ key: 'pg_5', at: 1000 });
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
  it('parses page and language, ignoring old Guided View values and rejected aliases', () => {
    expect(parseReaderParams('?view=read&id=x&p=3&lang=te&guided=1&panel=2')).toEqual({ p: 3, lang: 'te' });
    expect(parseReaderParams('p=0')).toEqual({ p: 0 });
    expect(parseReaderParams('?p=-1&lang=<script>&guided=yes&panel=0')).toEqual({});
    expect(parseReaderParams('?page=4&mode=spread')).toEqual({});
    expect(parseReaderParams('?lang=pt-BR')).toEqual({ lang: 'pt-BR' });
  });

  it('writes params back preserving everything else', () => {
    expect(withReaderParams('/c/AbC123?via=x#top', { p: 4, lang: 'hi' })).toBe('/c/AbC123?via=x&p=4&lang=hi#top');
    expect(withReaderParams('/?view=read&id=1&p=4&guided=1&panel=2', { p: 0 })).toBe('/?view=read&id=1&p=0');
    expect(withReaderParams('https://example.com/c/a?p=1&panel=3', { p: 2 })).toBe('https://example.com/c/a?p=2');
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

  it('re-applies the last position onto the entry left after the reader\'s own history entry is popped', () => {
    vi.useFakeTimers();
    window.history.replaceState(null, '', '/c/test?via=s');
    const sync = createUrlSync(300);
    sync.schedule({ p: 5 });
    vi.advanceTimersByTime(300);
    expect(window.location.search).toBe('?via=s&p=5');
    // Closing pops the reader entry: the page underneath still has the old link.
    window.history.replaceState(null, '', '/c/test?via=s&p=1');
    sync.reapply();
    expect(window.location.search).toBe('?via=s&p=5');
    // Nothing scheduled yet: nothing to write.
    const fresh = createUrlSync(300);
    window.history.replaceState(null, '', '/c/test?via=s');
    fresh.reapply();
    expect(window.location.search).toBe('?via=s');
  });
});
