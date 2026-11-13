// Language words and the language-ask detector (AH-3b), in one place.
//
// Three readers use these words: tools.ts GROUP_HINTS.i18n (which feature group a turn's words make relevant, so the
// language tools are kept when the per-turn tool cap trims), tools/i18n.ts (when the language group is offered at all,
// and whether the user asked for a translation), and tools/timeline.ts (the page timeline stands down on a language
// ask). This module imports only the language registry, so tools.ts can read it without an import cycle
// (tools/i18n.ts imports tools.ts).

import { LANGUAGES } from '../../../../shared/comic/languages.js';

const reEscape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** A registry name without its bracketed note: "Chinese (Simplified)" → "chinese", "中文（简体）" → "中文". */
const bareName = (name: string) => name.replace(/\s*[（(].*$/u, '').trim().toLowerCase();
/**
 * Every language of the registry (shared/comic/languages.ts) by its English name and by its own name, plus the
 * everyday names the registry spells differently ("bangla", "mandarin", and हिंदी: most people type Hindi with the
 * anusvara, the registry has हिन्दी). A language added there is recognised here with no second list.
 */
const LANGUAGE_NAMES: readonly string[] = [...new Set([...LANGUAGES.flatMap((l) => [bareName(l.english), bareName(l.endonym)]), 'bangla', 'mandarin', 'हिंदी'])];
/** Names written in Latin letters ("hindi", "español"). Names in other scripts need no list: LANG_SCRIPTS matches them. */
const LATIN_NAMES = LANGUAGE_NAMES.filter((name) => /^[\p{Script=Latin}\s]+$/u.test(name));
/** Any letter of an Indic script, Arabic, kana, Han or Hangul: the user is writing (or naming) another language. */
const LANG_SCRIPTS = String.raw`[ऀ-෿؀-ۿ぀-ヿ一-鿿가-힯]`;
/** Whole words only, for accented names too ("español" yes, "Germanic" no). */
const wholeWord = (alternatives: string) => String.raw`(?<![\p{L}\p{N}_])(?:${alternatives})(?![\p{L}\p{N}_])`;

/** The words that name a language or a language thing: translate, language, every registry name, edition, glossary, subtitles, mother tongue. */
const NAMING_WORDS = String.raw`translat\w*|languages?|${LATIN_NAMES.map(reEscape).join('|')}|editions?|glossary|subtitles?|mother tongue`;

/**
 * GROUP_HINTS.i18n: the turn's words make the language tools relevant, so they are seated before groups whose words do
 * not appear ("make an Indonesian version", "in my mother tongue please" on a comic that already has pages). Bare
 * "versions" is left out here: "use version 2 of page 3" is the timeline's, and seating the language group first on it
 * would only cost the turn tool seats. LANG_WORDS adds it back for offering the group at all.
 */
export const LANGUAGE_HINT_RE = new RegExp(`${wholeWord(NAMING_WORDS)}|${LANG_SCRIPTS}`, 'iu');

/**
 * Words that say a turn is about languages: they open the language group, and they tell a translate the user asked for
 * from one the director offered unasked. "versions" ("add Telugu and Hindi versions") and "mother tongue" count.
 */
export const LANG_WORDS = new RegExp(`${wholeWord(`${NAMING_WORDS}|versions?`)}|${LANG_SCRIPTS}`, 'iu');

/**
 * A language named as what the comic should be in ("in Telugu", "into Hindi", "to Tamil") or as a kind of copy
 * ("Hindi versions", "a Tamil copy", "the Telugu edition"), the word translate, "mother tongue", or a language's own
 * name in its own script. Stricter than LANG_WORDS: "the Chinese dragon" names no language to translate into.
 */
const LANGUAGE_ASK = new RegExp(
  [
    wholeWord(String.raw`translat\w*|mother tongue`),
    wholeWord(String.raw`(?:in|into|to)\s+(?:${LATIN_NAMES.map(reEscape).join('|')})`),
    wholeWord(String.raw`(?:${LATIN_NAMES.map(reEscape).join('|')})\s+(?:versions?|editions?|translations?|cop(?:y|ies)|subtitles?)`),
    LANGUAGE_NAMES.filter((name) => !LATIN_NAMES.includes(name)).map(reEscape).join('|')
  ].join('|'),
  'iu'
);
/**
 * A page, a numbered or earlier take, or the book's shape is what the sentence acts on: the page timeline's turn,
 * whatever else it names ("put page 3 before page 2 in the Hindi version", "make the Hindi edition a square book").
 * The verbs are tools.ts PAGE_ACTION's but two: "copy page 2 into Hindi" is a translation, and "add" counts only as
 * "add a page" ("add Hindi subtitles to every page" is a translation).
 */
const PAGE_OR_TAKE =
  /\b(?:move|swap|switch|put|drag|reorder|insert|delete|remove|duplicate|restore)\b[^.!?\n]{0,40}\bpages?\b|\badd (?:a|one|another|new) page\b|\bversion\s*#?\d|\b(?:previous|earlier|older|old|original|last)\s+(?:versions?|takes?|page)\b|\b(?:square|portrait|landscape)\b|\bbook (?:shape|size)\b/i;

/**
 * The turn asks for the comic in another language ("add Telugu and Hindi versions", "translate the book into Hindi",
 * "switch it to Tamil"), in words that seat the language group first (LANGUAGE_HINT_RE, which is GROUP_HINTS.i18n), and
 * no page or take is what it acts on. The page timeline stands down on such a turn (tools/timeline.ts): the two groups
 * cannot both fit under the per-turn tool cap, and "version", "book", "switch" and "copy" used to hand the turn to the
 * timeline, which left the director with no translate tool and no language rule.
 */
export const isLanguageAsk = (text: string): boolean => LANGUAGE_ASK.test(text) && !PAGE_OR_TAKE.test(text) && LANGUAGE_HINT_RE.test(text);
