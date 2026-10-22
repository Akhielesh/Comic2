import { describe, expect, it } from 'vitest';
import { LANGUAGES, SCRIPTS, dirOf, languageSpec, lineLengthRule, matchLanguage, sameLanguage, scriptOf } from './languages';
import { FONT_IDS } from './lettering/style';

describe('language registry', () => {
  it('has 20 languages with unique codes and registry fonts', () => {
    expect(LANGUAGES).toHaveLength(20);
    expect(new Set(LANGUAGES.map((l) => l.code)).size).toBe(20);
    for (const l of LANGUAGES) {
      for (const f of Object.values(l.fonts)) expect(FONT_IDS).toContain(f);
      expect(SCRIPTS[l.script]).toBeDefined();
    }
  });

  it('per-script Noto fonts (owner decision)', () => {
    expect(languageSpec('te')!.fonts).toEqual({ dialogue: 'noto-sans-telugu', sfx: 'noto-sans-telugu', legible: 'noto-sans-telugu' });
    expect(languageSpec('hi')!.fonts.dialogue).toBe('noto-sans-devanagari');
    expect(languageSpec('ur')!.fonts).toEqual({ dialogue: 'noto-nastaliq-urdu', sfx: 'noto-nastaliq-urdu', legible: 'noto-naskh-arabic' });
    expect(languageSpec('es')!.fonts).toEqual({ dialogue: 'comic-neue', sfx: 'bangers', legible: 'atkinson' });
  });

  it('resolves tags', () => {
    expect(languageSpec('te-IN')?.code).toBe('te');
    expect(languageSpec('zh-CN')?.code).toBe('zh-Hans');
    expect(languageSpec('zh_SG')?.code).toBe('zh-Hans');
    expect(languageSpec('zh-TW')).toBeUndefined();
    expect(languageSpec('xx')).toBeUndefined();
    expect(scriptOf('ja').spaced).toBe(false);
    expect(scriptOf('nope').id).toBe('Latn');
    expect(dirOf('ar')).toBe('rtl');
    expect(dirOf('ur-PK')).toBe('rtl');
    expect(sameLanguage('en-US', 'en')).toBe(true);
    expect(sameLanguage('zh', 'zh-Hans')).toBe(true);
    expect(sameLanguage(undefined, undefined)).toBe(false);
    expect(matchLanguage(['fr-CA', 'te-IN', 'en'], ['en', 'te'])).toBe('te');
    expect(matchLanguage(['de'], ['en'])).toBeUndefined();
    expect(SCRIPTS.Telu.letters.test('తెలుగు')).toBe(true);
    expect(SCRIPTS.Latn.allowItalic).toBe(true);
    expect(SCRIPTS.Deva.allowLetterSpacing).toBe(false);
  });

  it('line length rules', () => {
    expect(lineLengthRule('en', false)).toEqual({ unit: 'words', perLine: 25, perPage: 210 });
    expect(lineLengthRule('hi', true)).toEqual({ unit: 'words', perLine: 18, perPage: 210 });
    expect(lineLengthRule('te', false)).toEqual({ unit: 'words', perLine: 18, perPage: 160 });
    expect(lineLengthRule('ja', false)).toEqual({ unit: 'chars', perLine: 40, perPage: 330 });
    expect(lineLengthRule('zh-Hans', false)).toEqual({ unit: 'chars', perLine: 30, perPage: 330 });
    expect(lineLengthRule('ko', false).perLine).toBe(20);
  });
});
