// Language + script registry for true multi-language comics (contract §9.4).
// Dependency-free (types only from lettering/style.ts). Per-script Noto fonts (owner decision).

import type { FontId } from './lettering/style.js';

export type ScriptId = 'Latn' | 'Deva' | 'Telu' | 'Taml' | 'Knda' | 'Mlym' | 'Beng' | 'Gujr' | 'Guru' | 'Arab' | 'Aran' | 'Jpan' | 'Kore' | 'Hans';
export interface ScriptSpec {
  id: ScriptId;
  letters: RegExp; // /\p{Script=Telugu}/u … (translation script check ≥ 60 %)
  dir: 'ltr' | 'rtl';
  caseless: boolean;
  spaced: boolean; // false: Jpan, Hans → Intl.Segmenter word units + kinsoku
  widthFactor: number; // grapheme advance vs the Latin calibration (charW)
  lineHeight: number; // replaces LETTERING.lineHeight 1.3 for this script
  fontScale: number;
  sfxGlyphEm: number;
  allowItalic: boolean; // Latn only
  allowLetterSpacing: boolean; // Latn, Kore, Jpan, Hans
  viramas?: string; // fallback segmenter cluster merge
}
export interface LanguageSpec {
  code: string; // stored BCP-47 tag ('hi', 'zh-Hans')
  english: string;
  endonym: string;
  script: ScriptId;
  /** Font roles from the shared font registry. Non-Latin roles are the per-script Noto family. */
  fonts: { dialogue: FontId; sfx: FontId; legible: FontId };
  typography: string; // translator prompt hints (danda, « », ¡¿, 「」 …)
  tokenFactor: number; // output-token inflation vs English (estimate; EMA-calibrated server-side)
  group: 'india' | 'world';
}

const script = (
  id: ScriptId,
  letters: RegExp,
  o: Partial<Omit<ScriptSpec, 'id' | 'letters'>> = {}
): ScriptSpec => ({
  id,
  letters,
  dir: 'ltr',
  caseless: true,
  spaced: true,
  widthFactor: 1,
  lineHeight: 1.3,
  fontScale: 1,
  sfxGlyphEm: 0.62,
  allowItalic: false,
  allowLetterSpacing: false,
  ...o
});

export const SCRIPTS: Readonly<Record<ScriptId, ScriptSpec>> = {
  Latn: script('Latn', /\p{Script=Latin}/u, { caseless: false, sfxGlyphEm: 0.5, allowItalic: true, allowLetterSpacing: true }),
  Deva: script('Deva', /\p{Script=Devanagari}/u, { widthFactor: 1.15, lineHeight: 1.6, viramas: '्' }),
  Telu: script('Telu', /\p{Script=Telugu}/u, { widthFactor: 1.3, lineHeight: 1.7, viramas: '్' }),
  Taml: script('Taml', /\p{Script=Tamil}/u, { widthFactor: 1.35, lineHeight: 1.55, viramas: '்' }),
  Knda: script('Knda', /\p{Script=Kannada}/u, { widthFactor: 1.3, lineHeight: 1.7, viramas: '್' }),
  Mlym: script('Mlym', /\p{Script=Malayalam}/u, { widthFactor: 1.35, lineHeight: 1.6, viramas: '്' }),
  Beng: script('Beng', /\p{Script=Bengali}/u, { widthFactor: 1.15, lineHeight: 1.6, viramas: '্' }),
  Gujr: script('Gujr', /\p{Script=Gujarati}/u, { widthFactor: 1.1, lineHeight: 1.55, viramas: '્' }),
  Guru: script('Guru', /\p{Script=Gurmukhi}/u, { widthFactor: 1.1, lineHeight: 1.6, viramas: '੍' }),
  Arab: script('Arab', /\p{Script=Arabic}/u, { dir: 'rtl', widthFactor: 0.95, lineHeight: 1.65 }),
  Aran: script('Aran', /\p{Script=Arabic}/u, { dir: 'rtl', widthFactor: 1, lineHeight: 2.1, fontScale: 0.95 }),
  Jpan: script('Jpan', /[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}]/u, {
    spaced: false, widthFactor: 1.85, lineHeight: 1.4, sfxGlyphEm: 0.95, allowLetterSpacing: true
  }),
  Kore: script('Kore', /\p{Script=Hangul}/u, { widthFactor: 1.75, lineHeight: 1.4, sfxGlyphEm: 0.9, allowLetterSpacing: true }),
  Hans: script('Hans', /\p{Script=Han}/u, { spaced: false, widthFactor: 1.85, lineHeight: 1.4, sfxGlyphEm: 0.95, allowLetterSpacing: true })
};

const LATIN_FONTS = { dialogue: 'comic-neue', sfx: 'bangers', legible: 'atkinson' } as const;
const one = (f: FontId) => ({ dialogue: f, sfx: f, legible: f });
const LATIN_TYPO = 'Keep the source punctuation style natural for the language; never add spaces inside words.';

/** The 20 supported languages, in priority order. */
export const LANGUAGES: readonly LanguageSpec[] = [
  { code: 'en', english: 'English', endonym: 'English', script: 'Latn', fonts: { ...LATIN_FONTS }, typography: 'Straight or curly quotes are fine; use an ellipsis (…) for trailing speech.', tokenFactor: 1, group: 'world' },
  { code: 'hi', english: 'Hindi', endonym: 'हिन्दी', script: 'Deva', fonts: one('noto-sans-devanagari'), typography: 'End sentences with the danda (।), not a full stop. Use everyday spoken Hindi, not Sanskritised formal register.', tokenFactor: 2.2, group: 'india' },
  { code: 'te', english: 'Telugu', endonym: 'తెలుగు', script: 'Telu', fonts: one('noto-sans-telugu'), typography: 'Use natural spoken Telugu; full stops are fine. Never split a conjunct across a line.', tokenFactor: 3.2, group: 'india' },
  { code: 'ta', english: 'Tamil', endonym: 'தமிழ்', script: 'Taml', fonts: one('noto-sans-tamil'), typography: 'Use natural spoken Tamil; avoid archaic literary forms.', tokenFactor: 3.5, group: 'india' },
  { code: 'kn', english: 'Kannada', endonym: 'ಕನ್ನಡ', script: 'Knda', fonts: one('noto-sans-kannada'), typography: 'Use natural spoken Kannada.', tokenFactor: 3.2, group: 'india' },
  { code: 'ml', english: 'Malayalam', endonym: 'മലയാളം', script: 'Mlym', fonts: one('noto-sans-malayalam'), typography: 'Use natural spoken Malayalam with chillu letters where standard.', tokenFactor: 3.5, group: 'india' },
  { code: 'mr', english: 'Marathi', endonym: 'मराठी', script: 'Deva', fonts: one('noto-sans-devanagari'), typography: 'Use natural spoken Marathi; full stops are standard.', tokenFactor: 2.4, group: 'india' },
  { code: 'bn', english: 'Bengali', endonym: 'বাংলা', script: 'Beng', fonts: one('noto-sans-bengali'), typography: 'End sentences with the dari (।).', tokenFactor: 2.6, group: 'india' },
  { code: 'gu', english: 'Gujarati', endonym: 'ગુજરાતી', script: 'Gujr', fonts: one('noto-sans-gujarati'), typography: 'Use natural spoken Gujarati; full stops are standard.', tokenFactor: 2.8, group: 'india' },
  { code: 'pa', english: 'Punjabi', endonym: 'ਪੰਜਾਬੀ', script: 'Guru', fonts: one('noto-sans-gurmukhi'), typography: 'Gurmukhi script; end sentences with the danda (।).', tokenFactor: 2.8, group: 'india' },
  { code: 'ur', english: 'Urdu', endonym: 'اردو', script: 'Aran', fonts: { dialogue: 'noto-nastaliq-urdu', sfx: 'noto-nastaliq-urdu', legible: 'noto-naskh-arabic' }, typography: 'Right-to-left. Use the Urdu full stop (۔) and Arabic comma (،).', tokenFactor: 1.8, group: 'india' },
  { code: 'es', english: 'Spanish', endonym: 'Español', script: 'Latn', fonts: { ...LATIN_FONTS }, typography: 'Open questions and exclamations with ¿ and ¡.', tokenFactor: 1.3, group: 'world' },
  { code: 'fr', english: 'French', endonym: 'Français', script: 'Latn', fonts: { ...LATIN_FONTS }, typography: 'Use « » quotes with a narrow no-break space (U+202F) before ? ! : ;', tokenFactor: 1.3, group: 'world' },
  { code: 'pt', english: 'Portuguese', endonym: 'Português', script: 'Latn', fonts: { ...LATIN_FONTS }, typography: LATIN_TYPO, tokenFactor: 1.3, group: 'world' },
  { code: 'de', english: 'German', endonym: 'Deutsch', script: 'Latn', fonts: { ...LATIN_FONTS }, typography: 'Use „ “ quotes; keep compounds short enough for a balloon.', tokenFactor: 1.35, group: 'world' },
  { code: 'id', english: 'Indonesian', endonym: 'Bahasa Indonesia', script: 'Latn', fonts: { ...LATIN_FONTS }, typography: LATIN_TYPO, tokenFactor: 1.3, group: 'world' },
  { code: 'ja', english: 'Japanese', endonym: '日本語', script: 'Jpan', fonts: one('noto-sans-jp'), typography: 'Use 「」 for quotes and 。、 punctuation; no spaces between words.', tokenFactor: 1.6, group: 'world' },
  { code: 'ko', english: 'Korean', endonym: '한국어', script: 'Kore', fonts: one('noto-sans-kr'), typography: 'Use natural spoken Korean with standard spacing.', tokenFactor: 1.7, group: 'world' },
  { code: 'zh-Hans', english: 'Chinese (Simplified)', endonym: '中文（简体）', script: 'Hans', fonts: one('noto-sans-sc'), typography: 'Use full-width punctuation （，。！？“”）; no spaces between words.', tokenFactor: 1.3, group: 'world' },
  { code: 'ar', english: 'Arabic', endonym: 'العربية', script: 'Arab', fonts: one('noto-naskh-arabic'), typography: 'Right-to-left. Use the Arabic comma (،) and question mark (؟).', tokenFactor: 1.8, group: 'world' }
];

const BY_CODE: ReadonlyMap<string, LanguageSpec> = new Map(LANGUAGES.map((l) => [l.code.toLowerCase(), l]));

/** Canonical registry key for a tag ('te-IN' → 'te', 'zh-CN' → 'zh-hans', 'zh-TW' → 'zh-hant'). */
const canonicalKey = (tag?: string): string | undefined => {
  if (typeof tag !== 'string') return undefined;
  const parts = tag.trim().replace(/_/g, '-').toLowerCase().split('-').filter(Boolean);
  if (!parts.length) return undefined;
  const [base, ...rest] = parts;
  if (base === 'zh' || base === 'cmn') {
    if (rest.includes('hant') || rest.some((p) => p === 'tw' || p === 'hk' || p === 'mo')) return 'zh-hant';
    return 'zh-hans';
  }
  if (base === 'pa' && rest.includes('arab')) return 'pa-arab';
  return base;
};

export const languageSpec = (tag?: string): LanguageSpec | undefined => {
  const key = canonicalKey(tag);
  return key ? BY_CODE.get(key) : undefined;
};
export const scriptOf = (tag?: string): ScriptSpec => SCRIPTS[languageSpec(tag)?.script ?? 'Latn'];
export const dirOf = (tag?: string): 'ltr' | 'rtl' => scriptOf(tag).dir;
export const sameLanguage = (a?: string, b?: string): boolean => {
  const ka = canonicalKey(a);
  const kb = canonicalKey(b);
  return !!ka && ka === kb;
};
/** Best available language for a preference list (navigator.languages): exact language first, in order. */
export const matchLanguage = (prefs: readonly string[], available: readonly string[]): string | undefined => {
  for (const pref of prefs) {
    const hit = available.find((a) => sameLanguage(a, pref));
    if (hit) return hit;
  }
  return undefined;
};

const DRAVIDIAN: ReadonlySet<ScriptId> = new Set(['Telu', 'Taml', 'Knda', 'Mlym']);

/** Writer/edit length rule: Latin + Indo-Aryan ≤ 25 words (18 in_art); Telu/Taml/Knda/Mlym ≤ 18 words;
 *  Jpan ≤ 40 chars; Hans ≤ 30 chars; Kore ≤ 20 words; page budget 210 words / 330 CJK chars / 160 Dravidian words. */
export const lineLengthRule = (lang: string, inArt: boolean): { unit: 'words' | 'chars'; perLine: number; perPage: number } => {
  const s = scriptOf(lang).id;
  if (s === 'Jpan') return { unit: 'chars', perLine: 40, perPage: 330 };
  if (s === 'Hans') return { unit: 'chars', perLine: 30, perPage: 330 };
  if (s === 'Kore') return { unit: 'words', perLine: 20, perPage: 210 };
  if (DRAVIDIAN.has(s)) return { unit: 'words', perLine: 18, perPage: 160 };
  return { unit: 'words', perLine: inArt ? 18 : 25, perPage: 210 };
};
