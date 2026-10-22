import { afterEach, describe, expect, it, vi } from 'vitest';
import { lineSourceHash } from '../../../shared/comic/i18n';
import { applyOps } from '../../../shared/comic/ops';
import { makeSampleDoc } from '../conversation/testing/fixtures';
import { nextLanguage, pickReaderLanguage, readerLanguageOptions, readStoredReaderLang, readUrlLang, READER_LANG_KEY, storeReaderLang, syncLangToUrl, translatedPercent, urlWithLang } from './readerLanguage';
import { readerString, readerStrings, READER_STRINGS, type ReaderStringKey } from './readerStrings';
import { LANGUAGES } from '../../../shared/comic/languages';

afterEach(() => {
  vi.restoreAllMocks();
  try {
    localStorage.clear();
  } catch {
    /* ignore */
  }
});

describe('pickReaderLanguage — url > stored > browser > source', () => {
  const base = { source: 'en', published: ['te', 'hi', 'zh-Hans', 'pt'], navigatorLanguages: ['te-IN', 'en-US'] };
  it('?lang= wins when it is the source or a published edition', () => {
    expect(pickReaderLanguage({ ...base, urlLang: 'hi', stored: 'te' })).toEqual({ lang: 'hi', reason: 'url' });
    expect(pickReaderLanguage({ ...base, urlLang: 'en', stored: 'te' })).toEqual({ lang: 'en', reason: 'url' });
  });
  it('an invalid or unpublished ?lang is ignored', () => {
    expect(pickReaderLanguage({ ...base, urlLang: 'ta', stored: 'hi' })).toEqual({ lang: 'hi', reason: 'stored' });
    expect(pickReaderLanguage({ ...base, urlLang: '<script>', stored: null })).toEqual({ lang: 'te', reason: 'browser' });
    expect(pickReaderLanguage({ ...base, urlLang: 'x'.repeat(80) })).toEqual({ lang: 'te', reason: 'browser' });
  });
  it('browser languages map regional tags (te-IN → te, zh-CN → zh-Hans, pt-BR → pt)', () => {
    expect(pickReaderLanguage({ ...base, navigatorLanguages: ['zh-CN'] })).toEqual({ lang: 'zh-Hans', reason: 'browser' });
    expect(pickReaderLanguage({ ...base, navigatorLanguages: ['pt-BR', 'te'] })).toEqual({ lang: 'pt', reason: 'browser' });
    expect(pickReaderLanguage({ ...base, navigatorLanguages: ['zh-TW'], published: ['zh-Hans'] })).toEqual({ lang: 'en', reason: 'source' });
  });
  it('falls back to the source', () => {
    expect(pickReaderLanguage({ source: 'en', published: [], navigatorLanguages: ['fr'] })).toEqual({ lang: 'en', reason: 'source' });
  });
});

describe('storage and URL glue (never throws)', () => {
  it('stores and reads the global preference; a throwing localStorage is handled', () => {
    storeReaderLang('te');
    expect(localStorage.getItem(READER_LANG_KEY)).toBe('te');
    expect(readStoredReaderLang()).toBe('te');
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('SecurityError');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceeded');
    });
    expect(readStoredReaderLang()).toBeNull();
    expect(() => storeReaderLang('hi')).not.toThrow();
  });
  it('reads a validated ?lang and keeps other params when writing it', () => {
    expect(readUrlLang('?view=read&id=p1&lang=te')).toBe('te');
    expect(readUrlLang('?lang=zh-CN')).toBe('zh-Hans');
    expect(readUrlLang('?lang=evil')).toBeNull();
    expect(urlWithLang('https://x.ai/?view=read&id=p1#p3', 'te', 'en')).toBe('https://x.ai/?view=read&id=p1&lang=te#p3');
    expect(urlWithLang('https://x.ai/?view=read&lang=te', 'en', 'en')).toBe('https://x.ai/?view=read');
    const spy = vi.spyOn(window.history, 'replaceState');
    syncLangToUrl('hi', 'en');
    expect(spy).toHaveBeenCalledTimes(1);
    expect(String(spy.mock.calls[0][2])).toContain('lang=hi');
  });
});

describe('reader options', () => {
  it('lists the source first, then publishable editions (drafts only when asked)', () => {
    let doc = makeSampleDoc();
    doc = applyOps(doc, [{ op: 'edition', lang: 'te', patch: {} }, { op: 'edition', lang: 'hi', patch: {} }]);
    const lines = Object.fromEntries(
      doc.pages.flatMap((p) => p.panels.flatMap((pn) => pn.lines)).map((l) => [l.id, { text: 'తెలుగు', status: 'reviewed' as const, sourceHash: lineSourceHash(l), at: 1 }])
    );
    doc = applyOps(doc, [{ op: 'translations', lang: 'te', lines }]);
    expect(readerLanguageOptions(doc).map((o) => o.code)).toEqual(['en', 'te']);
    expect(readerLanguageOptions(doc, { includeDrafts: true }).map((o) => [o.code, o.status])).toEqual([
      ['en', 'ready'],
      ['te', 'ready'],
      ['hi', undefined]
    ]);
    expect(readerLanguageOptions(doc, { published: ['hi'] }).map((o) => o.code)).toEqual(['en', 'hi']);
    expect(readerLanguageOptions(doc)[1]).toMatchObject({ label: 'Telugu', native: 'తెలుగు' });
    expect(translatedPercent(doc, 'te')).toBe(100);
    expect(translatedPercent(doc, 'hi')).toBe(0);
    expect(nextLanguage(readerLanguageOptions(doc), 'te')).toBe('en');
    expect(nextLanguage([{ code: 'en', label: 'English' }], 'en')).toBeUndefined();
  });
});

describe('readerStrings', () => {
  it('every supported language has every key (no gaps), interpolation works, English fallback', () => {
    const keys = Object.keys(READER_STRINGS.en) as ReaderStringKey[];
    expect(keys.length).toBeGreaterThanOrEqual(20);
    for (const l of LANGUAGES) {
      const table = READER_STRINGS[l.code];
      expect(table, l.code).toBeDefined();
      for (const k of keys) expect(table[k], `${l.code}.${k}`).toBeTruthy();
      // placeholders survive translation
      expect(table.pageOf).toContain('{n}');
      expect(table.pageOf).toContain('{total}');
      expect(table.translatedPercent).toContain('{n}');
    }
    expect(readerString('te', 'pageOf', { n: 2, total: 6 })).toBe('పేజీ 2 / 6');
    expect(readerString('zh-CN', 'theEnd')).toBe('完。');
    expect(readerString('xx', 'close')).toBe('Close');
    expect(readerStrings('fr').untranslatedLines).toContain(' :');
  });
});
