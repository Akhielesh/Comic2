import { describe, expect, it } from 'vitest';
import { LANGUAGES, SCRIPTS } from '../../../shared/comic/languages';
import { READER_STRINGS, readerString, readerStrings, type ReaderStringKey } from './readerStrings';

const KEYS = Object.keys(READER_STRINGS.en) as ReaderStringKey[];
const placeholders = (s: string) => (s.match(/\{\w+\}/g) || []).sort();

// Completeness, interpolation and fallback are covered in readerLanguage.test.ts; these guard quality.
describe('readerStrings quality', () => {
  it('keeps exactly the same {placeholders} as English for every key in every language', () => {
    for (const l of LANGUAGES) {
      for (const k of KEYS) expect(placeholders(readerStrings(l.code)[k]), `${l.code}.${k}`).toEqual(placeholders(READER_STRINGS.en[k]!));
    }
  });

  it('non-Latin tables are written in their own script (no English left behind)', () => {
    for (const l of LANGUAGES.filter((x) => x.script !== 'Latn')) {
      const letters = KEYS.map((k) => readerStrings(l.code)[k]).join(' ').match(/\p{L}/gu) || [];
      const own = letters.filter((ch) => SCRIPTS[l.script].letters.test(ch)).length;
      expect(own / letters.length, l.code).toBeGreaterThan(0.8);
    }
  });

  it('region tags resolve to the table; a missing variable stays visible instead of "undefined"', () => {
    expect(readerString('te-IN', 'language')).toBe(readerString('te', 'language'));
    expect(readerString('te', 'language')).not.toBe('Language');
    expect(readerString('en', 'pageOf', { n: 3 })).toBe('Page 3 of {total}');
  });
});
