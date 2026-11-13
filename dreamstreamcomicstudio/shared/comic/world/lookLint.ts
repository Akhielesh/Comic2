// A free check of one cast card (PROGRAM5 P5-TRUTH items 1 and 7; research-story ST-1 (b, d), research-continuity
// VC-0 (g)). No model call, nothing stored: it reads the card's look and says where the card contradicts itself or
// holds something a card should not hold.
//
//   - contradiction: the summary names a colour for the skin, hair or eyes that the field itself does not
//     ("Green-skinned …" against Skin "warm tan plastic"): the page check then argues with the drawing.
//   - time: a fixed field says when it changes ("three pale stripes … after Rama's blessing"): every page draws a
//     card's fixed fields, so the change shows before it happens.
//   - mood: the face or eyes hold a passing feeling ("serene calm smile"): a card is drawn on every page, so the
//     feeling would be too, whatever the panel's beat.
//
// The same mood words are what the page compiler leaves out of a card's face, eyes and summary at compile time
// (`withoutMood`, used by server/src/comic/prompts.ts behind COMIC_STORY_FIXES). The stored look is never rewritten:
// it is part of every page's spec hash, so nothing drawn goes out of date.
//
// The studio shows the findings as a free chip on the cast card while CARD_LINT_STAGE lets the viewer see it.

import type { FlagStage } from '../capabilities.js';
import type { Character, CharacterLook } from '../doc.js';

/**
 * Who sees the card check chip in the studio (P5-TRUTH item 7). A code constant, not an env setting: the chip is free and
 * client-only, so turning it off is one commit and a redeploy. 'admins' for the admin week, then 'all'.
 */
export const CARD_LINT_STAGE: FlagStage = 'admins';

/** Whether the card check shows for this viewer at a stage. */
export const cardLintOn = (admin: boolean | null | undefined, stage: FlagStage = CARD_LINT_STAGE): boolean =>
  stage === 'all' || (stage === 'admins' && admin === true);

// ── Mood words ───────────────────────────────────────────────────────────────

/**
 * Nouns that ARE a passing expression. The whole noun phrase goes ("a wide, friendly grin"), back to the nearest
 * comma, "with" or "and".
 */
export const MOOD_NOUNS = ['smile', 'smiles', 'grin', 'grins', 'smirk', 'smirks', 'frown', 'frowns', 'scowl', 'scowls', 'sneer', 'sneers', 'pout', 'pouts', 'expression', 'expressions', 'laugh', 'laughs'] as const;

/** Adjectives that describe a passing feeling, not a look. Only the word goes ("determined printed face" → "printed face"). */
export const MOOD_ADJECTIVES = [
  'serene', 'calm', 'calmly', 'angry', 'furious', 'happy', 'sad', 'cheerful', 'joyful', 'joyous', 'gleeful', 'smiling',
  'grinning', 'frowning', 'scowling', 'laughing', 'determined', 'worried', 'anxious', 'stern', 'focused', 'grumpy',
  'smug', 'tearful', 'scared', 'frightened', 'surprised', 'shocked'
] as const;

const NOUN_SET = new Set<string>(MOOD_NOUNS);
const ADJ_SET = new Set<string>(MOOD_ADJECTIVES);
const ARTICLE = /^(?:a|an|the)$/i;
/** Words a cleaned fragment never ends or starts on. */
const DANGLING = new Set(['a', 'an', 'the', 'and', 'or', 'with', 'of', 'in', 'on', 'at', 'to', 'by', 'that', 'which', 'who']);
/** Words that make a mood word a lasting design trait ("permanent scowl", "always-frowning brow"). */
const LASTING = new Set(['permanent', 'permanently', 'always', 'perpetual', 'perpetually', 'constant', 'habitual', 'eternal', 'forever']);

const tokens = (text: string): string[] => (text.toLowerCase().match(/[\p{L}]+(?:-[\p{L}]+)*/gu) || []).flatMap((w) => [w, ...w.split('-')]);
const bare = (w: string) => w.toLowerCase().replace(/[^\p{L}-]/gu, '');
const partsOf = (w: string): string[] => {
  const b = bare(w);
  return [b, ...b.split('-')];
};
/**
 * Whether the mood word at words[i] is a lasting trait, not a passing feeling: "laugh lines" / "smile lines" (a
 * wrinkle), or a lasting qualifier on it or right before it ("permanent scowl", "always-frowning brow").
 */
const lastingAt = (words: readonly string[], i: number): boolean => {
  if (partsOf(words[i]).some((p) => LASTING.has(p))) return true;
  if (i > 0 && LASTING.has(bare(words[i - 1]))) return true;
  const next = i + 1 < words.length ? bare(words[i + 1]) : '';
  return next === 'line' || next === 'lines';
};
const isMoodNoun = (words: readonly string[], i: number): boolean => NOUN_SET.has(bare(words[i])) && !lastingAt(words, i);
const isMoodAdjective = (words: readonly string[], i: number): boolean => partsOf(words[i]).some((p) => ADJ_SET.has(p)) && !lastingAt(words, i);

/** Every mood word in a text, in order, without repeats ([] when none). Lasting traits ("laugh lines") are not moods. */
export const moodWordsIn = (text?: string): string[] => {
  const out: string[] = [];
  const words = (text || '').split(/\s+/).filter(Boolean);
  words.forEach((w, i) => {
    if (lastingAt(words, i)) return;
    for (const p of partsOf(w)) if ((NOUN_SET.has(p) || ADJ_SET.has(p)) && !out.includes(p)) out.push(p);
  });
  return out;
};

const tidy = (text: string): string => {
  let t = text.replace(/\s+/g, ' ').replace(/\s+([,;])/g, '$1').replace(/([,;])(?:\s*[,;])+/g, '$1').trim();
  for (let changed = true; changed; ) {
    changed = false;
    const words = t.split(' ').filter(Boolean);
    const last = words[words.length - 1]?.toLowerCase().replace(/[^\p{L}]/gu, '');
    const first = words[0]?.toLowerCase().replace(/[^\p{L}]/gu, '');
    if (words.length && (last === '' || DANGLING.has(last!))) {
      words.pop();
      changed = true;
    }
    if (words.length && first && (first === 'and' || first === 'or' || first === 'with')) {
      words.shift();
      changed = true;
    }
    t = words.join(' ').replace(/^[\s,;:]+|[\s,;:]+$/g, '');
  }
  return t;
};

/** One comma-free clause without its mood words: nouns take their modifiers back to "with"/"and"; adjectives go alone. */
const clauseWithoutMood = (clause: string): { text: string; cutNoun: boolean } => {
  let words = clause.split(/\s+/).filter(Boolean);
  let cutNoun = false;
  for (let i = words.length - 1; i >= 0; i -= 1) {
    if (!isMoodNoun(words, i)) continue;
    // Back to the nearest "with", "and", "or", or a relative word ("kind eyes that never smile" keeps "kind eyes").
    let start = i;
    while (start > 0 && !/^(?:with|and|or|that|which|who)$/i.test(bare(words[start - 1]))) start -= 1;
    words = [...words.slice(0, start), ...words.slice(i + 1)];
    cutNoun = true;
    i = Math.min(i, words.length);
  }
  words = words.filter((_w, i, all) => !isMoodAdjective(all, i));
  return { text: words.join(' '), cutNoun };
};

/**
 * A look field without its mood words, for the image prompt only: "serene calm smile" → "", "monkey face with a
 * wide, friendly grin" → "monkey face", "determined printed face with firm brows" → "printed face with firm brows",
 * "kind eyes, warm smile" → "kind eyes". A text with no mood word comes back unchanged (byte for byte).
 */
export const withoutMood = (text?: string): string => {
  const raw = typeof text === 'string' ? text : '';
  if (!moodWordsIn(raw).length) return raw;
  const out: string[] = [];
  for (const clause of raw.split(/\s*([,;])\s*/)) {
    if (clause === ',' || clause === ';') {
      out.push(clause);
      continue;
    }
    const { text: kept, cutNoun } = clauseWithoutMood(clause);
    // "a wide, friendly grin": the comma split the noun phrase; the bare "a wide" before it is the same phrase.
    if (cutNoun && !kept.trim() && out.length >= 2) {
      const prev = out[out.length - 2];
      const m = /^(.*?\b(?:with|and)\s+)?((?:a|an|the)\s+[\p{L}-]+(?:\s+[\p{L}-]+)?)$/iu.exec(prev);
      if (m && ARTICLE.test(m[2].split(/\s+/)[0])) out[out.length - 2] = m[1] || '';
    }
    out.push(kept);
  }
  const joined = out.join('').replace(/([,;])(?=\S)/g, '$1 ');
  return tidy(joined);
};

// ── The lint ─────────────────────────────────────────────────────────────────

export type LookLintRule = 'contradiction' | 'time' | 'mood';

export interface LookFinding {
  rule: LookLintRule;
  /** The card field the finding is about. */
  field: keyof CharacterLook;
  /** The words that triggered it ("green", "tan"; "after"; "smile"). */
  words: string[];
  /** One plain sentence for the card. */
  text: string;
}

const FIELD_WORDS: Partial<Record<keyof CharacterLook, string>> = {
  summary: 'Summary',
  face: 'Face',
  hair: 'Hair',
  eyes: 'Eyes',
  skin: 'Skin',
  build: 'Build',
  outfit: 'Outfit',
  palette: 'Colors',
  props: 'Props',
  markings: 'Markings',
  marks: 'Distinguishing marks'
};

const COLOUR_WORDS = new Set([
  'red', 'crimson', 'scarlet', 'vermilion', 'maroon', 'pink', 'rose', 'orange', 'saffron', 'yellow', 'gold', 'golden',
  'green', 'emerald', 'olive', 'lime', 'blue', 'azure', 'navy', 'cobalt', 'teal', 'turquoise', 'cyan', 'aqua', 'purple',
  'violet', 'indigo', 'lavender', 'brown', 'tan', 'beige', 'cream', 'white', 'black', 'grey', 'gray', 'silver', 'bronze',
  'copper', 'russet', 'ivory', 'peach', 'amber', 'auburn', 'blond', 'blonde', 'ginger', 'pale', 'dark', 'fair', 'olive'
]);
/** Shades that never contradict a hue ("pale", "dark" and "fair" qualify, they do not name a colour). */
const SHADE_ONLY = new Set(['pale', 'dark', 'fair']);

/** Names of one colour family ("gold" and "golden", "blue" and "navy"): two of them never contradict each other. */
const COLOUR_FAMILIES: Record<string, string> = {
  crimson: 'red', scarlet: 'red', vermilion: 'red', maroon: 'red',
  gold: 'yellow', golden: 'yellow', blond: 'yellow', blonde: 'yellow', amber: 'yellow',
  saffron: 'orange', ginger: 'orange', peach: 'orange',
  emerald: 'green', olive: 'green', lime: 'green',
  azure: 'blue', navy: 'blue', cobalt: 'blue', indigo: 'blue',
  teal: 'cyan', turquoise: 'cyan', aqua: 'cyan',
  violet: 'purple', lavender: 'purple',
  tan: 'brown', beige: 'brown', russet: 'brown', bronze: 'brown', copper: 'brown', auburn: 'brown',
  gray: 'grey', silver: 'grey',
  cream: 'white', ivory: 'white',
  rose: 'pink'
};
const familyOf = (w: string): string => COLOUR_FAMILIES[w] ?? w;

const coloursIn = (text: string): string[] => [...new Set(tokens(text).filter((w) => COLOUR_WORDS.has(w) && !SHADE_ONLY.has(w)))];

/** How the summary names a colour for a field: "green-skinned", "green skin", "red-haired", "blue eyes". */
const SUMMARY_PATTERNS: { field: 'skin' | 'hair' | 'eyes'; re: RegExp }[] = [
  { field: 'skin', re: /([\p{L}-]+)[- ]skinned\b|([\p{L}-]+)\s+skin\b/giu },
  { field: 'hair', re: /([\p{L}-]+)[- ]haired\b|([\p{L}-]+)\s+(?:hair|fur)\b/giu },
  { field: 'eyes', re: /([\p{L}-]+)[- ]eyed\b|([\p{L}-]+)\s+eyes\b/giu }
];

/** Words that say a fixed field changes over the story. */
// "when", "once" and "before" are left out: they are ordinary words in a fixed field ("a sari that flutters when she runs").
const TIME_WORDS = /\b(after|until|later|eventually|becomes?|turns? into|grows?|at first|by the end)\b/gi;
/** Fields a card draws on every page (the summary is checked for colours, not time: it often tells a backstory). */
const FIXED_FIELDS: (keyof CharacterLook)[] = ['markings', 'marks', 'face', 'eyes', 'hair', 'skin', 'build', 'outfit', 'palette', 'props'];
const MOOD_FIELDS: (keyof CharacterLook)[] = ['face', 'eyes'];

const quoteList = (words: string[]): string => words.map((w) => `"${w}"`).join(', ');

/**
 * The card's findings, in field order: contradictions first, then time words, then moods. [] for a clean card.
 * Pure and free; never throws on a partial look.
 */
export const lintLook = (c: Pick<Character, 'name' | 'look'>): LookFinding[] => {
  const look: Partial<CharacterLook> = c.look || {};
  const text = (k: keyof CharacterLook): string => (typeof look[k] === 'string' ? (look[k] as string) : '');
  const out: LookFinding[] = [];

  const summary = text('summary');
  for (const { field, re } of SUMMARY_PATTERNS) {
    const own = coloursIn(text(field));
    if (!own.length) continue;
    const said: string[] = [];
    for (const m of summary.matchAll(re)) for (const w of coloursIn(m[1] || m[2] || '')) if (!said.includes(w)) said.push(w);
    const ownFamilies = new Set(own.map(familyOf));
    if (!said.length || said.some((w) => ownFamilies.has(familyOf(w)))) continue;
    out.push({
      rule: 'contradiction',
      field,
      words: [...said, ...own],
      text: `Summary says ${said.join(' and ')}, ${FIELD_WORDS[field]!.toLowerCase()} says ${text(field).trim()}: pick one, so every page draws the same ${c.name || 'character'}.`
    });
  }

  for (const field of FIXED_FIELDS) {
    const value = text(field);
    const words = [...new Set([...value.matchAll(TIME_WORDS)].map((m) => m[1].toLowerCase()))];
    if (!words.length) continue;
    out.push({
      rule: 'time',
      field,
      words,
      text: `${FIELD_WORDS[field]} says ${quoteList(words)}: this sounds like a change over time. A card is drawn on every page, so keep it to how they always look and put the change on the page where it happens.`
    });
  }

  for (const field of MOOD_FIELDS) {
    const words = moodWordsIn(text(field));
    if (!words.length) continue;
    out.push({
      rule: 'mood',
      field,
      words,
      text: `${FIELD_WORDS[field]} holds a mood (${quoteList(words)}). A card is drawn on every page, so the mood would be too: keep it to what never changes; each panel's feeling comes from the plan.`
    });
  }
  return out;
};
