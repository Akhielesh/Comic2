// Dialogue understanding: a sentence → DialogueIntent[] (agent-editor plan §3 B2 grammar.ts). Deterministic, English-first,
// pure and free. It serves (a) the free fast path (only when `confident`) and (b) the test oracle. Other languages and
// messy wording go through the director, which fills the same structure as dialogue_edit arguments (intentFromArgs).
//
// Steps: quotes and ALL-CAPS words are set aside (they are words to place, never instructions); fillers go ("um",
// "like", "so", "can you"); run-ons split on "and / then / also" only where an action verb follows (so "between Mira and
// Leo" stays whole); each clause is matched by one extractor, most specific first. A later clause's "it" means the line
// the earlier clause named, and "her" the speaker it named.
//
// Kind words (G12: the KIND of a line, not its look): speech (speech bubble, talking), thought (think, wonder, thought
// bubble), whisper (murmur, quietly, softly), shout (yell, scream, cry out, loud), caption (narration, narrator, caption
// box, voice-over), sfx (sound effect, sfx, onomatopoeia, BOOM-like all-caps). Look words restyle instead: robot or
// radio voice → shape `electronic`; telepathy or dream → shape `wavy`.

import { POS9, type LineKind, type Pos9 } from '../doc.js';
import { FONT_REGISTRY } from '../lettering/fonts.js';
import { BUBBLE_SHAPES, FONT_IDS, LINE_KINDS, NAMED_COLORS, normalizeColor, TAIL_STYLES, type BubbleShape, type FontId, type LetterStylePatch, type TailStyle } from '../lettering/style.js';
import type { AddExtras, ReorderExtras, RestyleExtras } from './compile.js';
import type { PluralLineRef } from './resolve.js';
import { DIALOGUE_ACTS, type DialogueAct, type DialogueIntent, type GrammarResult, type LineRef, type Placement } from './types.js';

// ── Vocabulary ───────────────────────────────────────────────────────────────

const ORDINALS: Readonly<Record<string, number>> = {
  first: 1, '1st': 1, one: 1, second: 2, '2nd': 2, two: 2, third: 3, '3rd': 3, three: 3, fourth: 4, '4th': 4, four: 4,
  fifth: 5, '5th': 5, five: 5, sixth: 6, '6th': 6, six: 6, seventh: 7, '7th': 7, seven: 7, eighth: 8, '8th': 8, eight: 8, ninth: 9, '9th': 9, nine: 9
};
const ORD_RE = 'first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|1st|2nd|3rd|4th|5th|6th|7th|8th|9th|last';

/** Kind words, most specific first (each pattern names the kind it means). */
const KIND_TERMS: readonly [string, LineKind][] = [
  ['thought (?:bubble|balloon|cloud)s?', 'thought'],
  ['speech (?:bubble|balloon)s?', 'speech'],
  ['(?:caption|narration|narrator) box(?:es)?', 'caption'],
  ['sound effects?', 'sfx'],
  ['voice[- ]?overs?', 'caption'],
  ['normal speech', 'speech'],
  ['thoughts?', 'thought'],
  ['thinking', 'thought'],
  ['thinks?', 'thought'],
  ['wonder(?:s|ing)?', 'thought'],
  ['whisper(?:s|ed|ing)?', 'whisper'],
  ['murmur(?:s|ed|ing)?', 'whisper'],
  ['quietly', 'whisper'],
  ['softly', 'whisper'],
  ['shout(?:s|ed|ing)?', 'shout'],
  ['yell(?:s|ed|ing)?', 'shout'],
  ['scream(?:s|ed|ing)?', 'shout'],
  ['cr(?:y|ies) out', 'shout'],
  ['loud(?:er|ly)?', 'shout'],
  ['captions?', 'caption'],
  ['narrations?', 'caption'],
  ['narrator', 'caption'],
  ['sfx', 'sfx'],
  ['onomatopoeias?', 'sfx'],
  ['speech', 'speech'],
  ['talking', 'speech'],
  ['dialogue', 'speech']
];
const KIND_ALT = KIND_TERMS.map(([t]) => t).join('|');
const KIND_TERM_RE = new RegExp(`\\b(?:${KIND_ALT})\\b`);
const kindOfTerm = (term: string): LineKind | undefined => KIND_TERMS.find(([t]) => new RegExp(`^(?:${t})$`).test(term.trim()))?.[1];
const isPluralTerm = (term: string): boolean => /(?:s|es)$/.test(term.trim()) && !/^(?:speech|sfx|thinks|wonders|cries out|whispers|shouts|yells|screams|murmurs)$/.test(term.trim()) && !/ess$/.test(term);

/** Nouns that make a phrase about lettering ("the line", "these bubbles", "the voice"). */
const LINE_NOUN_RE = /\b(lines?|bubbles?|balloons?|dialogue|words|text|voice|boxe?s?|speech)\b/;
const DEIXIS_RE = /\b(this|that|it|these|those|them|both|the selected (?:ones?|lines?|bubbles?|balloons?))\b/;
const PLURAL_DEIXIS_RE = /\b(these|those|them|both|the selected (?:ones|lines|bubbles|balloons))\b/;
const STOP_NAMES = new Set([
  'it', 'this', 'that', 'these', 'those', 'them', 'they', 'the', 'a', 'an', 'all', 'every', 'each', 'both', 'line', 'lines', 'bubble', 'bubbles',
  'balloon', 'balloons', 'text', 'words', 'caption', 'page', 'panel', 'one', 'top', 'bottom', 'left', 'right', 'middle', 'center', 'centre', 'here',
  'there', 'me', 'us', 'you', 'we', 'i', 'off', 'make', 'move', 'put', 'have', 'let', 'and', 'then', 'also', 'not', 'no', 'its', 'tail', 'voice',
  'someone', 'somebody', 'nobody', 'everyone', 'everybody', 'speaker', 'what', 'who'
]);
const VERBS =
  'make|move|put|place|position|turn|change|convert|swap|switch|flip|exchange|delete|remove|erase|drop|add|insert|give|hand|assign|point|aim|bring|send|push|lock|unlock|pin|join|link|connect|unlink|disconnect|separate|use|set|shift|nudge|bump|drag|slide|tidy|bold|italicize|reword|rewrite|replace|have|raise|lower|get rid of';
const MOVE_VERBS_RE = /\b(?:move|put|place|position|shift|push|nudge|bump|drag|stick|set|slide|raise|lower|bring|take)\b/g;

const COLOR_ALIASES: Readonly<Record<string, string>> = { gray: 'grey', 'light blue': 'sky blue', 'dark blue': 'navy', 'dark red': 'crimson', 'light green': 'leaf green', 'dark purple': 'deep purple', 'light pink': 'pink' };
const COLOR_NAMES = [...NAMED_COLORS.map(([n]) => n), ...Object.keys(COLOR_ALIASES)].sort((a, b) => b.length - a.length);
const COLOR_RE = new RegExp(`(?:^|[^\\p{L}-])(${COLOR_NAMES.map((n) => n.replace(/[-\s]/g, '[- ]?')).join('|')}|#[0-9a-f]{3,8})(?![\\p{L}])`, 'u');

/** Plain font words (the director's FONT_ALIASES, server tools/lettering.ts) plus every registry label and id. */
const FONT_WORDS: Readonly<Record<string, FontId>> = {
  comic: 'comic-neue', classic: 'comic-neue', default: 'comic-neue', normal: 'comic-neue',
  kids: 'andika', 'kids readable': 'andika', storybook: 'andika', friendly: 'andika',
  readable: 'atkinson', legible: 'atkinson', 'easy to read': 'atkinson', accessible: 'atkinson',
  handwritten: 'patrick-hand', 'hand written': 'patrick-hand', 'hand-written': 'patrick-hand', handwriting: 'patrick-hand', indie: 'patrick-hand',
  marker: 'permanent-marker', sharpie: 'permanent-marker',
  typewriter: 'special-elite', noir: 'special-elite', detective: 'special-elite',
  retro: 'ultra', pulp: 'ultra', 'golden age': 'ultra', serif: 'ultra',
  manga: 'shantell-sans', webtoon: 'shantell-sans', modern: 'shantell-sans',
  impact: 'bangers', action: 'bangers', superhero: 'bangers',
  cartoon: 'luckiest-guy', bubbly: 'luckiest-guy', playful: 'luckiest-guy',
  plain: 'noto-sans', sans: 'noto-sans'
};
const fontWordMap = (): Map<string, FontId> => {
  const m = new Map<string, FontId>(Object.entries(FONT_WORDS));
  for (const id of FONT_IDS) {
    m.set(id.replace(/-/g, ' '), id);
    const label = FONT_REGISTRY[id]?.label;
    if (label) m.set(label.toLowerCase(), id);
  }
  return m;
};
const FONT_MAP = fontWordMap();

/**
 * A font from plain words ("handwritten", "Bangers", "typewriter"), or the three nearest fonts by spelling when the
 * name is unknown (the "Font name unknown: chips with 3 nearest" answer).
 */
export function fontFromWords(words: string): { font?: FontId; nearest: FontId[] } {
  const key = (words || '').toLowerCase().replace(/\bfont\b|\btypeface\b/g, '').replace(/[_]/g, ' ').replace(/\s+/g, ' ').trim();
  const hit = FONT_MAP.get(key) ?? FONT_MAP.get(key.replace(/-/g, ' '));
  if (hit) return { font: hit, nearest: [hit] };
  const dist = (a: string, b: string): number => {
    const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)] as number[]);
    for (let j = 1; j <= b.length; j++) dp[0][j] = j;
    for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    return dp[a.length][b.length];
  };
  const ranked = [...FONT_MAP.entries()].map(([w, id]) => ({ id, d: dist(key, w) })).sort((a, b) => a.d - b.d);
  const nearest: FontId[] = [];
  for (const r of ranked) if (!nearest.includes(r.id) && nearest.length < 3) nearest.push(r.id);
  return { nearest };
}

// ── Preparing the sentence ───────────────────────────────────────────────────

interface Prepared {
  quotes: string[];
  /** ALL-CAPS words as typed (BOOM, POW), by lower case. */
  caps: Map<string, string>;
}

const CAPS_STOP = new Set(['I', 'OK', 'SFX', 'AI', 'TV', 'UI', 'ID', 'PG', 'US', 'UK', 'P', 'A']);
const Q_RE = /«q(\d+)»/;
const Q_RE_G = /«q(\d+)»/g;

const prepare = (raw: string): { text: string; prep: Prepared } => {
  let s = (raw || '').normalize('NFC').replace(/[“”„‟«»]/g, '"').replace(/[‘’‚‛`´]/g, "'").replace(/\s+/g, ' ').trim();
  const quotes: string[] = [];
  const put = (q: string): string => {
    quotes.push(q.trim());
    return ` «q${quotes.length - 1}» `;
  };
  s = s.replace(/"([^"]{1,600})"/g, (_, q: string) => put(q));
  s = s.replace(/(^|[\s:(,])'(.+?)'(?=$|[\s.,!?;:)])/g, (_, pre: string, q: string) => `${pre}${put(q)}`);
  // "POW!" and "WHAT?!" are words to place: set aside like quotes, so their "!" never ends a sentence.
  s = s.replace(/(^|[\s(])([A-Z][A-Z]+[!?]+)(?=$|[\s.,;:)])/g, (all, pre: string, word: string) => (CAPS_STOP.has(word.replace(/[!?]+$/, '')) ? all : `${pre}${put(word)}`));
  const caps = new Map<string, string>();
  for (const m of s.matchAll(/(?:^|[\s(])([A-Z][A-Z]+[!?]*)(?=$|[\s.,;:)])/g)) {
    const t = m[1].replace(/[!?]+$/, '');
    if (!CAPS_STOP.has(t)) caps.set(t.toLowerCase(), m[1]);
  }
  let t = s.toLowerCase();
  // Fillers and politeness (never instructions).
  t = t
    .replace(/\b(?:um+|uh+|erm+|hmm+|ahh?)\b,?/g, ' ')
    .replace(/\b(?:you know|i mean|basically|actually|just|please|pls|kindly|alright|hey)\b,?/g, ' ')
    .replace(/(^|[\s,])(?:ok|okay),?(?=\s|$)/g, '$1 ')
    .replace(/\b(?:can|could|would|will) you\b/g, ' ')
    .replace(/\b(?:i want(?: you)? to|i'?d like(?: you)? to|i would like(?: you)? to|let'?s|i need(?: you)? to|we need to|go ahead and|try to)\b/g, ' ')
    .replace(/(^|\band\b|,|\bso\b|\bthen\b)\s+like,?\s+/g, '$1 ')
    .replace(/\blike,\s*/g, ' ')
    .replace(/(^|[\s,])so,?\s+(?=(?:[a-z]+\s)?(?:make|move|put|turn|change|swap|delete|add|give|point|lock|use)\b)/g, '$1 ')
    .replace(/\s+/g, ' ')
    .trim();
  return { text: t, prep: { quotes, caps } };
};

/** Verbs that start a new clause after "and / then" (the dialogue verbs plus the studio's other asks). */
const SPLIT_VERBS = `${VERBS}|draw|redraw|render|create|generate|show|open|go|translate|publish|export|share|undo|write|fix|rename|plan|recolou?r|zoom`;
const SPLIT_RE = new RegExp(
  `\\s*(?:[.;!?]+\\s+|,\\s*(?:and\\s+|then\\s+)?(?=(?:${SPLIT_VERBS})\\b)|\\s(?:and then|and also|and|then|also|plus)\\s+(?=(?:${SPLIT_VERBS})\\b|[a-z]+ (?:says|shouts|whispers|yells|should|speaks|talks)\\b))`
);
const clausesOf = (t: string): string[] =>
  t
    .split(SPLIT_RE)
    .map((c) => c.replace(/^(?:and|then|also|so|now|plus)\b\s*/, '').replace(/[.!?;,\s]+$/, '').trim())
    .filter(Boolean);

// ── Phrases ──────────────────────────────────────────────────────────────────

const cleanName = (raw: string | undefined): string | undefined => {
  if (!raw) return undefined;
  let n = raw.replace(/'s$|'$/, '').replace(/[^\p{L}\p{N}\s'-]/gu, ' ').replace(/\s+/g, ' ').trim();
  // A name ends where a preposition or a verb starts ("Leo in panel 2" → "Leo").
  n = n.replace(/\s+(?:in|on|at|to|of|for|from|with|by|into|saying|says|said|and|or|is|was|should|now|instead|please)\b.*$/, '').replace(/'s$/, '');
  const words = n.split(' ');
  while (words.length > 1 && (STOP_NAMES.has(words[0]) || new RegExp(`^(?:${VERBS})$`).test(words[0])) && words[0] !== 'the') words.shift();
  n = words.join(' ');
  if (!n || STOP_NAMES.has(n) || Q_RE.test(n)) return undefined;
  if (/^(?:page|panel)\b/.test(n) || /\d/.test(n)) return undefined;
  return n;
};

interface RefParse {
  ref: PluralLineRef;
  /** The phrase names a line (a line noun, a kind, a speaker's line, quoted words, an ordinal or a position). */
  anchored: boolean;
  /** this / that / it / these… */
  deixis: boolean;
}

const NAME = "([\\p{L}][\\p{L}'-]*(?: [\\p{L}][\\p{L}'-]*)?)";

/** A target phrase → LineRef ("Mira's second line on page 2", "these", "the caption", "“run”"). */
const parseRef = (phrase: string, prep: Prepared, selected: boolean): RefParse => {
  let s = ` ${phrase} `;
  const ref: PluralLineRef = {};
  let anchored = false;
  let plural = false;
  const q = Q_RE.exec(s);
  if (q) {
    ref.textContains = prep.quotes[Number(q[1])];
    anchored = true;
    s = s.replace(Q_RE_G, ' ');
  }
  // Page and panel.
  let m = /\b(?:on |of |in )?page (\d+)\b/.exec(s);
  if (m) {
    ref.page = Number(m[1]);
    s = s.replace(m[0], ' ');
  } else if ((m = /\b(?:on |in )?(?:this|the current) page\b/.exec(s))) {
    ref.page = 'this';
    s = s.replace(m[0], ' ');
  } else if ((m = new RegExp(`\\b(?:on |of |in )?the (${ORD_RE}) page\\b`).exec(s)) && m[1] !== 'last') {
    ref.page = ORDINALS[m[1]];
    s = s.replace(m[0], ' ');
  }
  if ((m = /\b(?:in |on |of |from )?panel (\d+)\b/.exec(s))) {
    ref.panel = Number(m[1]);
    s = s.replace(m[0], ' ');
  } else if ((m = new RegExp(`\\b(?:in |on |of |from )?the (${ORD_RE}) panel\\b`).exec(s))) {
    ref.panel = m[1] === 'last' ? 'last' : m[1] === 'first' ? 'first' : ORDINALS[m[1]];
    s = s.replace(m[0], ' ');
  } else if ((m = /\b(?:in |on )?(?:this|the current) panel\b/.exec(s))) {
    s = s.replace(m[0], ' ');
  }
  // A speaker's line ("Mira's line", "the robot's last bubble", "her second line").
  const nounAfter = `(?=\\s+(?:(?:${ORD_RE}|other|new|only|two|three)\\s+)?(?:lines?|bubbles?|balloons?|dialogue|words|text|speech|captions?|whispers?|shouts?|thoughts?|ones?))`;
  m = new RegExp(`\\b((?:the |her |his |their )?[\\p{L}][\\p{L}-]*(?: [\\p{L}][\\p{L}-]*)?)'s?\\b${nounAfter}`, 'u').exec(s);
  if (m && cleanName(m[1])) {
    ref.speaker = cleanName(m[1]);
    anchored = true;
    s = s.replace(m[0], ' ');
  } else if ((m = new RegExp(`\\b(her|his|their)\\b${nounAfter}`).exec(s))) {
    ref.speaker = m[1];
    anchored = true;
    s = s.replace(m[0], ' ');
  } else if ((m = new RegExp(`\\b(?:said |spoken |line |lines )?(?:by|from) ${NAME}`, 'u').exec(s)) && cleanName(m[1]) && !/^(?:off|the page|the panel)/.test(m[1])) {
    ref.speaker = cleanName(m[1]);
    anchored = true;
    s = s.replace(m[0], ' ');
  } else if ((m = new RegExp(`\\bwhat ${NAME} (?:says|said|shouts|whispers|thinks)\\b`, 'u').exec(s)) && cleanName(m[1])) {
    ref.speaker = cleanName(m[1]);
    anchored = true;
    s = s.replace(m[0], ' ');
  }
  // Ordinals and "which" before kind nouns ("the last caption", "the top one").
  if ((m = new RegExp(`\\b(${ORD_RE}) (?:one|line|bubble|balloon|caption|whisper|shout|thought|sound effect|speech bubble)s?\\b`).exec(s))) {
    ref.nth = m[1] === 'last' ? 'last' : m[1] === 'first' ? 'first' : ORDINALS[m[1]];
    anchored = true;
  }
  if ((m = /\bthe (top|upper|bottom|lower|left|right|biggest|largest|big|leftmost|rightmost|topmost) (?:one|line|bubble|balloon)\b|\bthe one (?:at|on) the (top|bottom|left|right)\b/.exec(s))) {
    const w = m[1] ?? m[2];
    ref.which = w === 'upper' || w === 'topmost' ? 'top' : w === 'lower' ? 'bottom' : w === 'largest' || w === 'big' ? 'biggest' : w === 'leftmost' ? 'left' : w === 'rightmost' ? 'right' : (w as LineRef['which']);
    anchored = true;
    s = s.replace(m[0], ' ');
  }
  // A kind as the target ("the caption", "all the shouts").
  const kindM = new RegExp(`\\b(${KIND_ALT})\\b`).exec(s);
  if (kindM) {
    const kind = kindOfTerm(kindM[1]);
    if (kind && !/^(?:talking|dialogue|speech|loud|loudly|louder|quietly|softly|thinks?|thinking|wonder\w*)$/.test(kindM[1])) {
      ref.kind = kind;
      anchored = true;
      if (isPluralTerm(kindM[1])) plural = true;
    }
  }
  const deixis = DEIXIS_RE.test(s);
  if (PLURAL_DEIXIS_RE.test(s)) plural = true;
  if (/\b(?:all|every|each|both)\b/.test(s)) plural = true;
  if (/\b(?:lines|bubbles|balloons)\b/.test(s)) plural = true;
  if (LINE_NOUN_RE.test(s)) anchored = true;
  if (deixis && selected) ref.selected = true;
  if (plural) ref.all = true;
  return { ref, anchored, deixis };
};

/** A subject that is just a name ("Mira", "the robot") → a speaker ref; else the phrase as a ref. */
const subjectRef = (subject: string, prep: Prepared, selected: boolean): RefParse | undefined => {
  const parsed = parseRef(subject, prep, selected);
  if (parsed.anchored || parsed.deixis) return parsed;
  const name = cleanName(subject.trim());
  if (name && name.split(' ').length <= 3) return { ref: { speaker: name }, anchored: true, deixis: false };
  return undefined;
};

const hasNarrowing = (r: LineRef): boolean =>
  r.page !== undefined || r.panel !== undefined || !!r.speaker || !!r.kind || !!r.textContains || !!r.lineIds?.length || r.nth !== undefined || r.which !== undefined;

// ── Placement words ──────────────────────────────────────────────────────────

const CELL_OF: Readonly<Record<string, Pos9>> = {
  top: 'top', upper: 'top', bottom: 'bottom', lower: 'bottom', left: 'left', right: 'right', middle: 'center', center: 'center', centre: 'center', centered: 'center', centred: 'center'
};

/** Placement words in a clause → Placement (and the clause without them), plus "in a caption box" as a kind hint. */
const parsePlacement = (clause: string): { place?: Placement; rest: string; kindHint?: LineKind } => {
  let s = ` ${clause} `;
  let kindHint: LineKind | undefined;
  let m = new RegExp(`\\b(?:in|into|as)\\s+(?:a|an)\\s+(${KIND_ALT})(?:\\s+(?:box|bubble|balloon|cloud))?\\b`).exec(s);
  if (m && kindOfTerm(m[1])) {
    kindHint = kindOfTerm(m[1]);
    s = s.replace(m[0], ' ');
  }
  const frameOf = (): 'panel' | 'page' => {
    const f = /\b(?:of|on|at|across|along|in|to)\s+(?:the\s+|this\s+)?(?:whole\s+|entire\s+|full\s+)?page\b(?!\s*\d)/.exec(s);
    if (f) {
      s = s.replace(f[0], ' ');
      return 'page';
    }
    const p = /\b(?:of|in)\s+(?:the|its|this|that|their|her|his)\s+panel\b/.exec(s);
    if (p) s = s.replace(p[0], ' ');
    return 'panel';
  };
  const done = (place: Placement) => ({ place, rest: s.replace(/\s+/g, ' ').trim(), kindHint });

  // Between two characters.
  if ((m = new RegExp(`\\b(?:put |place |move )?(?:it |them )?(?:right |just )?between\\s+(?:(them|the two(?: of them)?|both of them|the pair)|${NAME}\\s+and\\s+${NAME})`, 'u').exec(s))) {
    s = s.replace(m[0], ' ');
    const frame = frameOf();
    const a = cleanName(m[2]);
    const b = cleanName(m[3]);
    return done(m[1] || !a || !b ? { frame, relation: 'between' } : { frame, relation: 'between', near: a, and: b });
  }
  // Next to a character.
  const REL = '(above|over|on top of|below|under|beneath|underneath|next to|beside|near|close to|to the left of|to the right of|left of|right of)';
  m = new RegExp(`\\b(?:right |just )?${REL}\\s+((?:the |her |his )?[\\p{L}][\\p{L}-]*(?: [\\p{L}][\\p{L}-]*)?)(?:'s?)?(?:\\s+(head|face|mouth))?\\b`, 'u').exec(s);
  if (m && !/^(?:the )?(?:page|panel|top|bottom|left|right|middle|center|centre|it|them|this|that|others?|everything|rest)\b/.test(m[2]) && !/^on top of$/.test(m[1])) {
    const name = cleanName(m[2]) ?? (/^(?:her|his|their)\b/.test(m[2]) ? m[2].split(' ')[0] : undefined);
    if (name) {
      s = s.replace(m[0], ' ');
      const r = m[1];
      const relation: Placement['relation'] = /^(?:above|over)$/.test(r) ? 'above' : /^(?:below|under|beneath|underneath)$/.test(r) ? 'below' : /left/.test(r) ? 'left' : /right/.test(r) ? 'right' : 'near';
      return done({ frame: frameOf(), near: name, relation });
    }
  }
  // A full-width bar.
  if ((m = /\b(?:across|along|spanning)\s+(?:the\s+)?(?:whole\s+|full\s+|entire\s+)?(top|bottom)\b|\b(?:full[- ]width|banner|bar|strip)\b(?:\s+\w+){0,3}?\s+(?:at|along|across)\s+the\s+(top|bottom)\b/.exec(s))) {
    s = s.replace(m[0], ' ');
    return done({ frame: frameOf(), edge: (m[1] ?? m[2]) as 'top' | 'bottom' });
  }
  // A corner or side of the frame.
  if ((m = /\b(?:in |to |at |into |on |toward |towards )?(?:the )?(top|upper|bottom|lower)[- ]?(left|right)(?:[- ]hand)?(?: corner| side)?\b/.exec(s))) {
    s = s.replace(m[0], ' ');
    const v = m[1] === 'upper' ? 'top' : m[1] === 'lower' ? 'bottom' : m[1];
    return done({ frame: frameOf(), cell: `${v}-${m[2]}` as Pos9 });
  }
  if ((m = /\b(?:in |to |at |into |on )?(?:the )?(left|right)[- ](top|bottom)(?: corner)?\b/.exec(s))) {
    s = s.replace(m[0], ' ');
    return done({ frame: frameOf(), cell: `${m[2]}-${m[1]}` as Pos9 });
  }
  if ((m = /\bup top\b|\bdown (?:at the )?bottom\b/.exec(s))) {
    s = s.replace(m[0], ' ');
    return done({ frame: frameOf(), cell: m[0].startsWith('up') ? 'top' : 'bottom' });
  }
  // A nudge with an amount ("a bit to the left", "up a lot") before the cells, so "to the left" there is a nudge.
  const AMT = '(?:a\\s+)?(bit|little|touch|tad|smidge|lot|ton|way|much|far|bit more|little more)';
  const amountOf = (w: string | undefined): 'bit' | 'lot' => (w && /^(?:lot|ton|way|much|far)$/.test(w) ? 'lot' : 'bit');
  const dirOf = (w: string): Placement['nudge'] => (/higher|up/.test(w) ? 'up' : /lower|down/.test(w) ? 'down' : /left/.test(w) ? 'left' : 'right');
  if ((m = new RegExp(`\\b${AMT}\\s+(higher|lower|further (?:left|right|up|down)|more to the (?:left|right)|to the (?:left|right)|up|down|left|right)\\b`).exec(s))) {
    s = s.replace(m[0], ' ');
    return done({ frame: 'panel', nudge: dirOf(m[2]), amount: amountOf(m[1]) });
  }
  if ((m = new RegExp(`\\b(higher|lower|up|down|left|right)\\s+${AMT}\\b`).exec(s))) {
    s = s.replace(m[0], ' ');
    return done({ frame: 'panel', nudge: dirOf(m[1]), amount: amountOf(m[2]) });
  }
  if ((m = /\b(?:to|at|in|on|into|onto|toward|towards)\s+the\s+(top|bottom|left|right|middle|center|centre)(?:[- ]hand)?(?:\s+(?:side|edge|half))?\b|\b(centered|centred)\b|\bin the (middle|center|centre)\b/.exec(s))) {
    s = s.replace(m[0], ' ');
    return done({ frame: frameOf(), cell: CELL_OF[m[1] ?? m[2] ?? m[3]] });
  }
  // A nudge.
  if ((m = /\b(higher|lower|further (?:left|right|up|down))\b/.exec(s))) {
    s = s.replace(m[0], ' ');
    return done({ frame: 'panel', nudge: dirOf(m[1]), amount: 'bit' });
  }
  if ((m = /\b(?:move|nudge|shift|push|bump|slide|drag|raise|lower)\b(.*?)\b(up|down|left|right)\b(?!\s+(?:top|corner|side|of))/.exec(s))) {
    s = s.replace(`${m[2]}`, ' ');
    return done({ frame: 'panel', nudge: m[2] as Placement['nudge'], amount: 'bit' });
  }
  return { rest: s.replace(/\s+/g, ' ').trim(), kindHint };
};

// ── Style words ──────────────────────────────────────────────────────────────

const SHAPE_WORDS: readonly [RegExp, BubbleShape][] = [
  [/\b(?:no|without (?:a|the)) (?:bubble|balloon)\b|\bborderless\b/, 'none'],
  [/\bcloud(?:y)?\b/, 'cloud'],
  [/\b(?:burst|spiky|spikey|starburst)\b/, 'burst'],
  [/\bexplosi(?:on|ve)\b/, 'explosion'],
  [/\b(?:jagged|zig-?zag(?:ged)?)\b/, 'jagged'],
  [/\b(?:oval|round|circle|circular)\b/, 'oval'],
  [/\b(?:rectangle|rectangular|square|boxy)\b/, 'rect'],
  [/\bscroll\b/, 'scroll'],
  [/\bribbon\b/, 'ribbon'],
  [/\brounded\b/, 'rounded_rect'],
  [/\bsquircle\b/, 'squircle'],
  [/\bnotched\b/, 'notched']
];

interface StyleParse {
  style: LetterStylePatch;
  scaleBy?: number;
  /** Something about the look was understood. */
  matched: boolean;
  /** "Use a Comic Sans font": a font name the studio does not have. */
  unknownFont?: string;
  rest: string;
}

const parseStyle = (clause: string): StyleParse => {
  let s = ` ${clause} `;
  const style: LetterStylePatch = {};
  let scaleBy: number | undefined;
  let unknownFont: string | undefined;
  const take = (m: RegExpExecArray | null): RegExpExecArray | null => {
    if (m) s = s.replace(m[0], ' ');
    return m;
  };
  let m: RegExpExecArray | null;
  // Looks: a radio or robot voice, telepathy or a dream (G12: look, not kind).
  if (take(/\b(?:sounds?|sounding) like (?:a |an )?(?:radio|robot|walkie[- ]talkie|phone|telephone|computer|machine|tv|television|speaker|intercom)\b|\b(?:radio|robot(?:ic)?|electronic|static|walkie[- ]talkie|phone|computer) voice\b|\bover the (?:radio|phone|intercom)\b/.exec(s))) style.shape = 'electronic';
  else if (take(/\b(?:telepath(?:y|ic)|psychic|dream(?:y|ing)?|in a dream|ghostly|wobbly|wavy)\b/.exec(s))) style.shape = 'wavy';
  if (!style.shape) {
    for (const [re, shape] of SHAPE_WORDS) {
      if ((m = new RegExp(`${re.source}(?:\\s+(?:bubble|balloon|shape|box|style))?`).exec(s))) {
        take(m);
        style.shape = shape;
        break;
      }
    }
  }
  // Colours: "red", "yellow box", "blue border", "white text".
  for (let guard = 0; guard < 3 && (m = COLOR_RE.exec(s)); guard++) {
    const name = m[1].replace(/\s+/g, ' ');
    const hex = normalizeColor(COLOR_ALIASES[name] ?? name);
    s = s.replace(m[1], ' ');
    if (!hex || hex === 'none' || hex === 'auto') continue;
    const near = s.slice(Math.max(0, (m.index ?? 0) - 20), (m.index ?? 0) + 40);
    const after = /^\s*(box|bubble|balloon|background|fill|border|outline|edge|text|letters|words|writing|font)\b/.exec(s.slice(m.index ?? 0));
    const before = /\b(box|bubble|balloon|background|fill|border|outline|edge|text|letters|words|writing|font)\s+(?:in\s+|to\s+)?$/.exec(s.slice(0, m.index ?? 0));
    const what = (after?.[1] ?? before?.[1] ?? (/\b(?:fill|background)\b/.test(near) ? 'fill' : '')).toLowerCase();
    if (/^(?:border|outline|edge)$/.test(what)) style.border = hex;
    else if (/^(?:box|bubble|balloon|background|fill)$/.test(what)) style.fill = hex;
    else style.textColor = hex;
    if (after) s = s.replace(new RegExp(`\\b${after[1]}\\b`), ' ');
  }
  // See-through: "a bit see-through" keeps 70 % of the fill.
  if ((m = take(/\b(?:(a bit|slightly|a little|somewhat|very|mostly|really|half|semi)[\s-]+)?(?:see[- ]through|transparent|translucent)\b/.exec(s)))) {
    const alpha = /^(?:a bit|slightly|a little|somewhat)$/.test(m[1] ?? '') ? 'b3' : /^(?:very|mostly|really)$/.test(m[1] ?? '') ? '66' : '80';
    style.fill = `${(style.fill ?? '#ffffff').slice(0, 7)}${alpha}`;
  }
  if (take(/\b(?:not bold|unbold|regular weight|normal weight|no bold)\b/.exec(s))) style.weight = 400;
  else if (take(/\bbold(?:er)?\b/.exec(s))) style.weight = 700;
  if (take(/\b(?:not italic|no italics?|upright|unitalic)\b/.exec(s))) style.italic = false;
  else if (take(/\b(?:italics?|italici[sz]ed?|slanted)\b/.exec(s))) style.italic = true;
  if (take(/\b(?:all caps|uppercase|upper case|capitals|capital letters|block letters)\b/.exec(s))) style.textCase = 'upper';
  else if (take(/\b(?:lowercase|lower case|small letters)\b/.exec(s))) style.textCase = 'lower';
  else if (take(/\b(?:normal case|as typed|mixed case|sentence case)\b/.exec(s))) style.textCase = 'as_typed';
  else if (take(/\btitle case\b/.exec(s))) style.textCase = 'title';
  if ((m = take(/\b(much|a lot|way|a bit|slightly|a little)?\s*(bigger|larger|smaller|tinier)\b|\b(huge|tiny)\b/.exec(s)))) {
    const bigger = /bigger|larger|huge/.test(m[0]);
    const amount = m[1] ?? '';
    scaleBy = m[3] === 'huge' ? 1.6 : m[3] === 'tiny' ? 0.7 : bigger ? (/^(?:much|a lot|way)$/.test(amount) ? 1.45 : /^(?:a bit|slightly|a little)$/.test(amount) ? 1.1 : 1.2) : /^(?:much|a lot|way)$/.test(amount) ? 0.7 : /^(?:a bit|slightly|a little)$/.test(amount) ? 0.9 : 0.85;
  }
  // Fonts: "a handwritten font", "in Bangers", "typewriter lettering".
  // At most three words name a font ("comic sans ms"), so "Leo's lines in the Patrick Hand font" reads "patrick hand".
  if ((m = /(?:\b(?:use|in|with|to)\s+)?(?:\b(?:a|an|the)\s+)?\b((?:[\p{L}][\p{L}-]*\s+){0,2}[\p{L}][\p{L}-]*)\s+(?:font|typeface|lettering)\b/u.exec(s))) {
    let words = m[1].trim();
    for (let prev = ''; prev !== words; ) {
      prev = words;
      words = words.replace(/^(?:use|in|with|to|a|an|the|make|it|its|their|this|that|for)\s+/, '').trim();
    }
    const f = fontFromWords(words);
    if (f.font) style.font = f.font;
    else if (words && !/^(?:the|a|new|different|another|other|same)$/.test(words)) unknownFont = words;
    take(m);
  } else {
    for (const [w, id] of FONT_MAP) {
      if (w.length < 5 || /^(?:comic|default|normal|classic|action|plain|sans|modern|kids|retro|friendly|serif)$/.test(w)) continue;
      if ((m = new RegExp(`\\b(?:in |use )?${w.replace(/[-\s]/g, '[- ]?')}\\b`).exec(s))) {
        style.font = id;
        take(m);
        break;
      }
    }
  }
  const matched = Object.keys(style).length > 0 || scaleBy !== undefined || !!unknownFont;
  return { style, ...(scaleBy !== undefined ? { scaleBy } : {}), matched, ...(unknownFont ? { unknownFont } : {}), rest: s.replace(/\s+/g, ' ').trim() };
};

// ── Extractors ───────────────────────────────────────────────────────────────

interface Clause {
  intents: DialogueIntent[];
  /** The clause names its line(s) on its own (or the creator has a selection), so the fast path may run it. */
  confident: boolean;
  /** The target the clause names (a later "it" means it). */
  target?: PluralLineRef;
}

type Extractor = (c: string, prep: Prepared, selected: boolean) => Clause | null;

/** A clause that is clearly about dialogue (a kind word, a line noun, a tail, quoted words). */
const dialogueWords = (c: string): boolean => KIND_TERM_RE.test(c) || LINE_NOUN_RE.test(c) || /\btails?\b|«q\d+»/.test(c);

const confidentFor = (r: RefParse, c: string, selected: boolean): boolean => r.anchored || (r.deixis && selected) || (!hasNarrowing(r.ref) && selected) || dialogueWords(c);

/** A ref for a target phrase that may be empty (deixis / the selection); null when it names something else (a page). */
const targetFrom = (phrase: string, prep: Prepared, selected: boolean): RefParse | null => {
  const words = phrase
    .replace(/[^\p{L}\p{N}«»\s']/gu, ' ')
    .replace(/\b(?:the|a|an|of|to|in|on|at|it|its|this|that|these|those|them|one|ones|should|be|is|now|up|down|with|for|and|so|please|again|instead|both|all|every|each|selected)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const r = parseRef(phrase, prep, selected);
  // No other target with balloons selected: the selection (plan §3 B2 resolve step 1), said explicitly.
  if (selected && !hasNarrowing(r.ref) && !r.ref.selected) r.ref.selected = true;
  if (r.anchored || r.deixis) return r;
  if (/\b(?:page|panel|cover|title|picture|image|art|drawing|book|comic|character|cast|style|preset|scene|story|hair|face|outfit|background|sky|logo)\b/.test(words)) return null;
  if (!words) return r;
  return null;
};

const VERB_STRIP = new RegExp(`\\b(?:${VERBS}|should|could|would|needs? to|has to|be|is|are|was|get|got|make it|let it)\\b`, 'g');

const emphasisX: Extractor = (c, prep, selected) => {
  let m = /\b(?:make|put|set|have)\s+(?:the\s+words?\s+)?«q(\d+)»\s+(?:in\s+)?(bold|italics?)\b/.exec(c);
  if (!m) m = /\b(?:make|put|set)\s+the\s+words?\s+(?:«q(\d+)»|([\p{L}']+))\s+(?:in\s+)?(bold|italics?)\b/u.exec(c);
  let word: string | undefined;
  let style: 'bold' | 'italic' = 'bold';
  if (m) {
    word = m[1] !== undefined && /^\d+$/.test(m[1]) ? prep.quotes[Number(m[1])] : m[2];
    style = /^italic/.test(m[m.length - 1]) ? 'italic' : 'bold';
    if (m[0].includes('«q') && !/\bwords?\b/.test(m[0]) && /\s/.test(word ?? '')) return null; // a whole quoted line: a restyle
  } else if ((m = /^(bold|italici[sz]e|embolden|emphasi[sz]e|stress)\s+(?:the\s+words?\s+)?(?:«q(\d+)»|([\p{L}']+))/u.exec(c))) {
    word = m[2] !== undefined ? prep.quotes[Number(m[2])] : m[3];
    if (!word || STOP_NAMES.has(word)) return null;
    style = /^italic/.test(m[1]) ? 'italic' : 'bold';
  } else return null;
  if (!word) return null;
  const target: PluralLineRef = selected ? { selected: true } : { textContains: word };
  return { intents: [{ act: 'emphasis', target, words: [word], style }], confident: true, target };
};

const copyStyleX: Extractor = (c, prep, selected) => {
  const m = new RegExp(`\\b(?:(?:the\\s+)?same\\s+(?:style|look)\\s+as|(?:apply|use|copy|give)\\s+(?:the\\s+)?(?:style|look)\\s+of)\\s+(.+?)\\s+(?:for|on|to)\\s+(?:all|every|each)\\s+(?:the\\s+)?(${KIND_ALT})\\b`).exec(c) ??
    new RegExp(`\\b(?:apply|use|copy|give)\\s+(this|that|its|the selected)\\s+(?:style|look)\\s+(?:to|for|on)\\s+(?:all|every|each)\\s+(?:the\\s+)?(${KIND_ALT})\\b`).exec(c);
  if (!m) return null;
  const kind = kindOfTerm(m[2]);
  if (!kind) return null;
  const from = parseRef(m[1] === 'its' ? 'it' : m[1], prep, selected);
  const target: PluralLineRef = { ...from.ref };
  delete target.all;
  const intent = { act: 'restyle', target, scope: 'kind', style: {}, asKind: kind } as DialogueIntent & RestyleExtras;
  return { intents: [intent], confident: from.anchored || selected, target };
};

const aimTailX: Extractor = (c, prep, selected) => {
  const m =
    /\b(?:point|aim|direct|turn)\b(.*?)\btails?\b(.*?)\b(?:at|to|toward|towards)\s+(.+)$/.exec(c) ??
    /^(.*?)\btails?\b(.*?)\b(?:point|aim|go|goes)(?:s|ing)?\b.*?\b(?:at|to|toward|towards)\s+(.+)$/.exec(c) ??
    /^(.*?)\btails?\s+(?:at|to|toward|towards)\s+(.+)$/.exec(c);
  if (!m) return null;
  const toRaw = (m.length === 4 ? m[3] : m[2]).trim();
  const head = `${m[1]} ${m.length === 4 ? m[2] : ''}`;
  let to: string;
  if (/\bmouth\b/.test(toRaw) && /^(?:her|his|their|the|its|my)?\s*mouth\b/.test(toRaw)) to = 'mouth';
  else {
    const name = cleanName(toRaw.replace(/'s?\s+(?:mouth|head|face)\b.*$/, '').replace(/\s+(?:instead|please|now)$/, ''));
    if (!name) return null;
    to = name;
  }
  const r = targetFrom(head.replace(/\b(?:the|should|of|on|for)\b/g, ' '), prep, selected) ?? { ref: selected ? { selected: true } : {}, anchored: false, deixis: false };
  return { intents: [{ act: 'aim_tail', target: r.ref, to }], confident: true, target: r.ref };
};

const TAIL_OF: readonly [RegExp, TailStyle][] = [
  [/\b(?:lightning|zig-?zag|jagged|electric)\s+tails?\b/, 'lightning'],
  [/\b(?:curved|curvy|bent)\s+tails?\b/, 'curved'],
  [/\bstraight\s+tails?\b/, 'straight'],
  [/\b(?:pointer|pointy|pointed|sharp)\s+tails?\b/, 'pointer'],
  [/\b(?:bubbles?|bubbly|dotted|thought)\s+tails?\b/, 'bubbles'],
  [/\b(?:normal|default|auto(?:matic)?|regular)\s+tails?\b/, 'auto']
];
const tailStyleX: Extractor = (c, prep, selected) => {
  let tail: TailStyle | undefined;
  let m = /\b(?:no|without (?:a|the)|remove (?:the|its)|get rid of (?:the|its)|lose (?:the|its)|take away (?:the|its)|delete (?:the|its)|hide (?:the|its))\s+tails?\b|\btailless\b/.exec(c);
  if (m) tail = 'none';
  else {
    for (const [re, t] of TAIL_OF) {
      if ((m = re.exec(c))) {
        tail = t;
        break;
      }
    }
  }
  if (!tail || !m || !(TAIL_STYLES as readonly string[]).includes(tail)) return null;
  const rest = c.replace(m[0], ' ').replace(VERB_STRIP, ' ');
  const r = targetFrom(rest, prep, selected);
  if (!r) return null;
  return { intents: [{ act: 'tail_style', target: r.ref, tail }], confident: true, target: r.ref };
};

const swapX: Extractor = (c, prep, selected) => {
  const m = /\b(?:swap|switch|flip|exchange|reverse)\b\s*(?:the\s+order\s+of\s+|places\s+of\s+)?(.*?)(?:\s+(?:around|places|over|round))?$/.exec(c);
  if (!m) return null;
  const body = m[1].trim();
  const pair = (a: PluralLineRef, b: PluralLineRef, ok: boolean): Clause => ({ intents: [{ act: 'swap', a, b }], confident: ok, target: a });
  let p: RegExpExecArray | null;
  if ((p = new RegExp(`^${NAME}'s?\\s+and\\s+${NAME}'s?\\s+(?:lines?|bubbles?|balloons?|dialogue)$`, 'u').exec(body))) {
    const a = cleanName(p[1]);
    const b = cleanName(p[2]);
    if (!a || !b) return null;
    return pair({ speaker: a }, { speaker: b }, true);
  }
  if ((p = new RegExp(`^the\\s+(${ORD_RE})\\s+and\\s+(?:the\\s+)?(${ORD_RE})\\s+(?:lines|bubbles|balloons|ones)$`).exec(body))) {
    const n = (w: string) => (w === 'last' ? 'last' : w === 'first' ? 'first' : ORDINALS[w]) as LineRef['nth'];
    return pair({ nth: n(p[1]) }, { nth: n(p[2]) }, true);
  }
  const two = body.split(/\s+(?:and|with)\s+/);
  if (two.length === 2 && two.every((x) => x.trim())) {
    const a = parseRef(two[0], prep, selected);
    const b = parseRef(two[1], prep, selected);
    if (a.anchored && b.anchored && !a.ref.all && !b.ref.all) return pair(a.ref, b.ref, true);
    if (!a.anchored && !a.deixis) return null;
  }
  const r = parseRef(body || 'these', prep, selected);
  if (!(r.deixis || /^(?:(?:the|these|those)\s+)?(?:two|2)?\s*(?:lines|bubbles|balloons|ones)?$/.test(body)) || /\bpages?\b|\bpanels?\b/.test(body)) return null;
  const ref: PluralLineRef = { ...r.ref, all: true, ...(selected ? { selected: true } : {}) };
  return pair(ref, { ...ref }, selected || r.anchored);
};

const reorderX: Extractor = (c, prep, selected) => {
  let m = /^(.+?)\s+(?:speaks|talks|goes|comes|says (?:it|this|that|their line|her line|his line)|should (?:speak|talk|go|come|be)|reads|is read)\s+(first|last)\b(?:\s+in\s+(?:the|this|that|its)\s+panel)?$/.exec(c);
  if (m) {
    const r = subjectRef(m[1], prep, selected);
    if (!r) return null;
    return { intents: [{ act: 'reorder', target: r.ref, to: m[2] as 'first' | 'last' }], confident: true, target: r.ref };
  }
  if ((m = /^(.+?)\s+(?:speaks|talks|goes|comes|should (?:speak|talk|go|come)|reads)\s+(before|after)\s+(.+)$/.exec(c))) {
    const r = subjectRef(m[1], prep, selected);
    const o = subjectRef(m[3], prep, false);
    if (!r || !o) return null;
    const to = m[2] === 'before' ? { before: o.ref } : { after: o.ref };
    return { intents: [{ act: 'reorder', target: r.ref, to }], confident: true, target: r.ref };
  }
  if ((m = /\b(?:put|move|make|have|let)\s+(.+?)\s+(?:go\s+|come\s+|speak\s+|be\s+)?(first|last)\b(?!\s+(?:panel|page))/.exec(c))) {
    const r = subjectRef(m[1], prep, selected);
    if (!r) return null;
    return { intents: [{ act: 'reorder', target: r.ref, to: m[2] as 'first' | 'last' }], confident: true, target: r.ref };
  }
  if ((m = /\b(?:put|move)\s+(.+?)\s+(before|after)\s+(.+)$/.exec(c))) {
    const r = subjectRef(m[1], prep, selected);
    const o = subjectRef(m[3], prep, false);
    if (!r || !o) return null;
    return { intents: [{ act: 'reorder', target: r.ref, to: m[2] === 'before' ? { before: o.ref } : { after: o.ref } }], confident: true, target: r.ref };
  }
  return null;
};

const moveToPanelX: Extractor = (c, prep, selected) => {
  const m = new RegExp(
    `\\b(?:move|put|send|shift|take|bring|drag)\\b\\s+(.+?)\\s+(?:to|into|in|over to|onto)\\s+(?:the\\s+)?(?:panel\\s+(\\d+)|(${ORD_RE.replace('|last', '')})\\s+panel)(?:\\s+(?:on|of)\\s+page\\s+(\\d+))?(\\s+as\\s+an?\\s+off[- ]?(?:panel|screen)\\s+(?:voice|line))?\\s*$`
  ).exec(c);
  if (!m) return null;
  const r = targetFrom(m[1], prep, selected);
  if (!r) return null;
  const panel = m[2] ? Number(m[2]) : ORDINALS[m[3]];
  if (!panel) return null;
  const intents: DialogueIntent[] = [{ act: 'move_to_panel', target: r.ref, panel, ...(m[4] ? { page: Number(m[4]) } : {}) }];
  if (m[5]) intents.push({ act: 'set_speaker', target: r.ref, speaker: 'off_panel' });
  return { intents, confident: confidentFor(r, c, selected), target: r.ref };
};

const zX: Extractor = (c, prep, selected) => {
  let m = /\b(?:bring|move|put|send|pull)\b(.*?)\b(?:to the |in |up )?(front|forward|on top of (?:the )?(?:others|everything|the rest|other balloons))\b/.exec(c);
  let dir: 'front' | 'back' = 'front';
  if (!m) {
    m = /\b(?:send|move|put|push)\b(.*?)\b(?:to the )?(back|backward|behind (?:the )?(?:others|everything|the rest|other balloons)|underneath(?: the others)?)\b/.exec(c);
    dir = 'back';
  }
  if (!m) return null;
  const r = targetFrom(m[1], prep, selected);
  if (!r) return null;
  return { intents: [{ act: 'z', target: r.ref, dir }], confident: confidentFor(r, c, selected), target: r.ref };
};

const lockX: Extractor = (c, prep, selected) => {
  let act: 'lock' | 'unlock' | undefined;
  let rest = c;
  let m: RegExpExecArray | null;
  if ((m = /\bunlock\b(.*)$/.exec(c))) {
    act = 'unlock';
    rest = m[1];
  } else if ((m = /\b(?:lock|pin)\b(.*?)(?:\s+(?:in place|down|there|here))?$/.exec(c))) {
    act = 'lock';
    rest = m[1];
  } else if ((m = /\b(?:don'?t|do not|never|stop)\s+(?:move|moving|touch|touching|shift|shifting)\s+(.+)$/.exec(c))) {
    act = 'lock';
    rest = m[1];
  } else if ((m = /\bkeep\s+(.+?)\s+(?:here|there|in place|where it is|where they are|put)\b/.exec(c))) {
    act = 'lock';
    rest = m[1];
  }
  if (!act) return null;
  const r = targetFrom(rest, prep, selected);
  if (!r) return null;
  return { intents: [{ act, target: r.ref }], confident: confidentFor(r, c, selected), target: r.ref };
};

const linkX: Extractor = (c, prep, selected) => {
  let m = /\b(?:unlink|unjoin|disconnect|separate|unchain|split up|detach)\b(.*)$/.exec(c);
  if (m) {
    const r = targetFrom(m[1], prep, selected);
    if (!r) return null;
    const ref: PluralLineRef = { ...r.ref, ...(r.deixis && !hasNarrowing(r.ref) ? { all: true } : {}) };
    return { intents: [{ act: 'unlink', target: ref }], confident: confidentFor(r, c, selected), target: ref };
  }
  m = /\b(?:join|link|connect|chain|merge)\b(.*)$/.exec(c);
  if (!m) return null;
  const parts = m[1].split(/\s+(?:to|with)\s+/);
  if (parts.length === 2) {
    const a = targetFrom(parts[0], prep, selected);
    const b = subjectRef(parts[1], prep, false);
    if (!a || !b) return null;
    return { intents: [{ act: 'link', target: a.ref, other: b.ref }], confident: true, target: a.ref };
  }
  const both = m[1].split(/\s+and\s+/);
  if (both.length === 2) {
    const a = parseRef(both[0], prep, selected);
    const b = parseRef(both[1], prep, false);
    if (a.anchored && b.anchored) return { intents: [{ act: 'link', target: a.ref, other: b.ref }], confident: true, target: a.ref };
  }
  const r = targetFrom(m[1], prep, selected);
  if (!r) return null;
  const ref: PluralLineRef = { ...r.ref, all: true };
  return { intents: [{ act: 'link', target: ref }], confident: confidentFor(r, c, selected), target: ref };
};

const speakerX: Extractor = (c, prep, selected) => {
  let m: RegExpExecArray | null;
  if ((m = /\boff[- ]?(?:panel|screen|camera)\b/.exec(c)) && !/\bpanel\s+\d/.test(c)) {
    const rest = c.replace(m[0], ' ').replace(/\b(?:comes?|coming|is|should be|make|it'?s|from|an?|voice|speaks?|speaking|talks?|talking|says?)\b/g, (w) => (w === 'voice' ? 'voice' : ' '));
    const r = targetFrom(rest, prep, selected) ?? { ref: selected ? { selected: true } : {}, anchored: false, deixis: false };
    return { intents: [{ act: 'set_speaker', target: r.ref, speaker: 'off_panel' }], confident: true, target: r.ref };
  }
  const NOT = `(?:,?\\s*(?:and\\s+)?not\\s+${NAME})?`;
  const build = (name: string | undefined, notName: string | undefined, targetPhrase?: string): Clause | null => {
    const who = cleanName(name);
    if (!who) return null;
    let ref: PluralLineRef = selected ? { selected: true } : {};
    if (targetPhrase !== undefined) {
      const r = targetFrom(targetPhrase, prep, selected);
      if (!r) return null;
      ref = r.ref;
    } else if (!selected && cleanName(notName)) ref = { speaker: cleanName(notName) };
    return { intents: [{ act: 'set_speaker', target: ref, speaker: who }], confident: true, target: ref };
  };
  if ((m = new RegExp(`\\b(?:that'?s|this is|it'?s|that is|it is)\\s+${NAME}\\s+(?:talking|speaking|saying (?:it|that|this)|who says (?:it|that|this)|thinking|whispering|shouting)\\b${NOT}`, 'u').exec(c))) return build(m[1], m[2]);
  if ((m = new RegExp(`\\b(?:that'?s|this is|it'?s|that is|it is)\\s+${NAME}'s\\s+(?:line|bubble|balloon)\\b${NOT}`, 'u').exec(c))) return build(m[1], m[2]?.replace(/'s$/, ''));
  if ((m = new RegExp(`\\b(?:change|switch|set|make)\\s+the\\s+speaker(?:\\s+of\\s+(.+?))?\\s+to\\s+${NAME}$`, 'u').exec(c))) return build(m[2], undefined, m[1] ?? '');
  if ((m = new RegExp(`\\b(?:give|hand|assign)\\s+(.+?)\\s+to\\s+${NAME}$`, 'u').exec(c))) return build(m[2], undefined, m[1]);
  if ((m = new RegExp(`^${NAME}\\s+(?:should\\s+say|says|said|is saying)\\s+(?:it|that|this)\\b${NOT}`, 'u').exec(c))) return build(m[1], m[2]);
  if ((m = new RegExp(`\\bmake\\s+${NAME}\\s+say\\s+(?:it|this|that)\\b${NOT}`, 'u').exec(c))) return build(m[1], m[2]);
  if ((m = new RegExp(`\\bnot\\s+${NAME},?\\s+(?:it'?s\\s+)?${NAME}\\b`, 'u').exec(c)) && /\b(?:talking|speaking|says?|line)\b/.test(c)) return build(m[2], m[1]);
  return null;
};

/** Page / panel words of an `add` → the panel ref ("in the last panel", "panel 3 on page 2", "this panel"). */
const panelRefOf = (s: string): LineRef => {
  const out: LineRef = {};
  let m = /\bpage (\d+)\b/.exec(s);
  if (m) out.page = Number(m[1]);
  else if (/\b(?:this|the current) page\b/.test(s)) out.page = 'this';
  if ((m = /\bpanel (\d+)\b/.exec(s))) out.panel = Number(m[1]);
  else if ((m = new RegExp(`\\bthe (${ORD_RE}) panel\\b`).exec(s))) out.panel = m[1] === 'last' ? 'last' : m[1] === 'first' ? 'first' : ORDINALS[m[1]];
  return out;
};

const KIND_VERB: Readonly<Record<string, LineKind>> = {
  say: 'speech', says: 'speech', said: 'speech', saying: 'speech', shout: 'shout', shouts: 'shout', shouting: 'shout', yell: 'shout', yells: 'shout', yelling: 'shout', scream: 'shout', screams: 'shout',
  whisper: 'whisper', whispers: 'whisper', whispering: 'whisper', murmur: 'whisper', murmurs: 'whisper', think: 'thought', thinks: 'thought', thinking: 'thought', wonder: 'thought', wonders: 'thought'
};

const addX: Extractor = (c, prep) => {
  let m: RegExpExecArray | null;
  // "the second panel needs a shout"
  if ((m = new RegExp(`^(.+?)\\s+(?:needs?|could use|should have|wants?|is missing)\\s+(?:a|an|another|one more|some)\\s+(${KIND_ALT})\\b(.*)$`).exec(c))) {
    const kind = kindOfTerm(m[2]);
    if (!kind || !/\b(?:panel|page)\b/.test(m[1])) return null;
    const q = Q_RE.exec(m[3]);
    const panel = panelRefOf(m[1]);
    // "needs a" may mean changing an existing line (the compiler asks which, or for new words): AddExtras.orChange.
    const intent = { act: 'add', panel, kind, ...(q ? { text: prep.quotes[Number(q[1])] } : {}), orChange: true } as DialogueIntent & AddExtras;
    return { intents: [intent], confident: false };
  }
  // "Leo says 'wait for me' in the last panel" (a new line, said by a named character).
  if ((m = new RegExp(`^${NAME}\\s+(says|shouts|yells|screams|whispers|murmurs|thinks|wonders)\\s+«q(\\d+)»(.*)$`, 'u').exec(c))) {
    const who = cleanName(m[1]);
    if (!who || /^(?:she|he|they|it)$/.test(who)) return null;
    const place = parsePlacement(m[4]).place;
    return { intents: [{ act: 'add', panel: panelRefOf(m[4]), kind: KIND_VERB[m[2]], speaker: who, text: prep.quotes[Number(m[3])], ...(place ? { place } : {}) }], confident: true };
  }
  if (!(m = /\b(?:add|insert|put in|include|write)\b\s+(.+)$/.exec(c))) return null;
  let body = m[1];
  let text: string | undefined;
  let q = /\b(?:saying|that says|which says|reading|with the words?|with the text|:)\s*«q(\d+)»/.exec(body) ?? Q_RE.exec(body);
  if (q) {
    text = prep.quotes[Number(q[1])];
    body = body.replace(q[0], ' ');
  }
  let kind: LineKind | undefined;
  const k = new RegExp(`\\b(${KIND_ALT})\\b`).exec(body);
  if (k) kind = kindOfTerm(k[1]);
  if (!kind && /\bsounds?\b/.test(body)) kind = 'sfx';
  if (!text) {
    const cap = body.split(/\s+/).map((w) => w.replace(/[!?.,]+$/, '')).find((w) => prep.caps.has(w));
    if (cap) {
      text = prep.caps.get(cap)!;
      kind = kind ?? 'sfx';
    }
  }
  if (!kind && text && /\p{Lu}/u.test(text) && !/\p{Ll}/u.test(text) && text.length <= 24) kind = 'sfx';
  if (!kind && (text || /\b(?:line|bubble|balloon|dialogue)\b/.test(body))) kind = 'speech';
  if (!kind) return null;
  let speaker: string | undefined;
  const s1 = new RegExp(`\\b(?:by|for|from)\\s+${NAME}`, 'u').exec(body);
  if (s1 && cleanName(s1[1]) && !/^(?:the )?(?:page|panel)\b/.test(s1[1])) speaker = cleanName(s1[1]);
  else if ((q = new RegExp(`\\b${NAME}\\s+(?:saying|says|shouting|whispering|thinking)\\b`, 'u').exec(body)) && cleanName(q[1]) && !KIND_TERM_RE.test(q[1])) speaker = cleanName(q[1]);
  else if ((q = new RegExp(`\\b${NAME}'s\\s+(?:${KIND_ALT}|line|bubble|balloon)\\b`, 'u').exec(body)) && cleanName(q[1])) speaker = cleanName(q[1]);
  const place = parsePlacement(body.replace(/\b(?:in|on)\s+(?:the\s+)?(?:\w+\s+)?panel(?:\s+\d+)?\b|\b(?:on|of)\s+page\s+\d+\b/g, ' ')).place;
  return {
    intents: [{ act: 'add', panel: panelRefOf(body), kind, ...(speaker ? { speaker } : {}), ...(text ? { text } : {}), ...(place ? { place } : {}) }],
    confident: !!text
  };
};

const editTextX: Extractor = (c, prep, selected) => {
  if (!Q_RE.test(c)) return null;
  let m: RegExpExecArray | null;
  // "Mira should shout 'Run!'" — a kind change and new words on her line.
  if ((m = new RegExp(`^${NAME}\\s+(?:should|must|needs to|has to|could)\\s+(say|shout|yell|scream|whisper|murmur|think|wonder)\\s+«q(\\d+)»\\s*(.*)$`, 'u').exec(c))) {
    const r = subjectRef(m[1], prep, selected);
    if (!r) return null;
    const ref: PluralLineRef = { ...r.ref, ...parseRef(m[4] ?? '', prep, false).ref };
    delete ref.all;
    const kind = KIND_VERB[m[2]];
    const intents: DialogueIntent[] = [];
    if (kind !== 'speech') intents.push({ act: 'set_kind', target: ref, kind });
    intents.push({ act: 'edit_text', target: ref, text: prep.quotes[Number(m[3])] });
    return { intents, confident: true, target: ref };
  }
  if ((m = /\breplace\s+«q(\d+)»\s+with\s+«q(\d+)»/.exec(c))) {
    const ref: PluralLineRef = { textContains: prep.quotes[Number(m[1])] };
    return { intents: [{ act: 'edit_text', target: ref, text: prep.quotes[Number(m[2])] }], confident: true, target: ref };
  }
  const forms = [
    /\b(?:change|edit|reword|rewrite|turn|correct|fix|update|set)\s+(.*?)\s*(?:to say|so (?:that )?it says|to read|to|into|with)\s+«q(\d+)»/,
    /^(.*?)\s*(?:should|must|needs to|has to)\s+(?:say|read)\s+«q(\d+)»/,
    /\bmake\s+(.*?)\s*say\s+«q(\d+)»/,
    /^(.*?)\s*(?:say|says|read|reads)\s+«q(\d+)»\s+instead\b/,
    /^()«q(\d+)»\s+instead\b/
  ];
  for (const re of forms) {
    if (!(m = re.exec(c))) continue;
    const phrase = m[1].replace(/\b(?:the\s+(?:text|words?)\s+(?:of|in))\b/g, ' ');
    const r = targetFrom(phrase, prep, selected);
    if (!r) return null;
    return { intents: [{ act: 'edit_text', target: r.ref, text: prep.quotes[Number(m[2])] }], confident: confidentFor(r, c, selected) || true, target: r.ref };
  }
  return null;
};

const deleteX: Extractor = (c, prep, selected) => {
  const m = /\b(?:delete|remove|erase|get rid of|drop|cut|lose|scrap|kill|trash)\b\s+(.+)$/.exec(c);
  if (!m) return null;
  if (/\b(?:tails?|borders?|outlines?|colou?rs?|styles?|fonts?|bold|italics?|fill|shadow|links?)\b/.test(m[1])) return null;
  const r = targetFrom(m[1].replace(/\b(?:entirely|completely|altogether)\b/g, ' '), prep, selected);
  if (!r) return null;
  return { intents: [{ act: 'delete', target: r.ref }], confident: confidentFor(r, c, selected), target: r.ref };
};

const moveX: Extractor = (c, prep, selected) => {
  const p = parsePlacement(c);
  if (!p.place) return null;
  const rest = p.rest.replace(MOVE_VERBS_RE, ' ').replace(/\b(?:it'?s|should|go|goes|be|is|sit|sits|live|over|there|here|instead)\b/g, ' ');
  const r = targetFrom(rest, prep, selected);
  if (!r) return null;
  const intents: DialogueIntent[] = [];
  if (p.kindHint) intents.push({ act: 'set_kind', target: r.ref, kind: p.kindHint });
  intents.push({ act: 'move', target: r.ref, place: p.place });
  const confident = confidentFor(r, c, selected) || !!p.place.near || !!p.place.edge;
  return { intents, confident, target: r.ref };
};

const setKindX: Extractor = (c, prep, selected) => {
  let m: RegExpExecArray | null;
  const by = (s: string): { s: string; who?: string } => {
    const b = new RegExp(`\\s+(?:by|from|for)\\s+${NAME}\\s*$`, 'u').exec(s);
    return b && cleanName(b[1]) ? { s: s.slice(0, b.index), who: cleanName(b[1]) } : { s };
  };
  const finish = (targetPhrase: string, term: string, who?: string): Clause | null => {
    const kind = kindOfTerm(term);
    if (!kind) return null;
    // "make Mira whisper": a bare name is the speaker whose line it is.
    const r = targetFrom(targetPhrase, prep, selected) ?? subjectRef(targetPhrase, prep, selected);
    if (!r) return null;
    const ref = { ...r.ref };
    // "all the shouts → whispers": the target's own kind word is the old kind, never the new one.
    const intents: DialogueIntent[] = [];
    if (who) intents.push({ act: 'set_speaker', target: ref, speaker: who });
    intents.push({ act: 'set_kind', target: ref, kind });
    return { intents, confident: confidentFor(r, c, selected) || true, target: ref };
  };
  const tail = by(c);
  const s = tail.s;
  if ((m = new RegExp(`\\b(?:make|turn|change|convert|switch|transform|have)\\s+(.*?)(?:\\s+(?:into|to|in|as))?(?:\\s+(?:a|an|some))?\\s+(${KIND_ALT})(?:\\s+(?:bubble|balloon|box|instead|again))?\\s*$`).exec(` ${s}`))) {
    if (/^(?:sound|sounds)$/.test(m[2])) return null;
    return finish(m[1], m[2], tail.who);
  }
  if ((m = new RegExp(`^(.+?)\\s+(?:is|should be|must be|needs to be|has to be|becomes?|is actually|was)\\s+(?:(?:a|an)\\s+)?(${KIND_ALT})(?:\\s+(?:bubble|balloon|box))?\\s*$`).exec(s))) return finish(m[1], m[2], tail.who);
  if ((m = new RegExp(`^${NAME}\\s+(?:should\\s+)?(whispers?|shouts?|yells?|screams?|thinks?|murmurs?)(?:\\s+(?:it|this|that|instead|here))?\\s*$`, 'u').exec(s))) {
    const kind = KIND_VERB[m[2]];
    const r = /^(?:she|he|they|it)$/.test(m[1]) ? { ref: selected ? { selected: true } : {}, anchored: false, deixis: true } : subjectRef(m[1], prep, selected);
    if (!r || !kind) return null;
    return { intents: [{ act: 'set_kind', target: r.ref, kind }], confident: true, target: r.ref };
  }
  if ((m = /\b(?:say|says|said)\s+(it|this|that)\s+(quietly|softly|loudly)\b/.exec(s))) {
    const r = parseRef(m[1], prep, selected);
    return { intents: [{ act: 'set_kind', target: r.ref, kind: m[2] === 'loudly' ? 'shout' : 'whisper' }], confident: true, target: r.ref };
  }
  return null;
};

/** Mood words that describe a font rather than name one ("a nicer font", "a scary font"): the director picks those. */
const FONT_MOOD_RE =
  /^(?:nice|nicer|better|cool|cooler|good|fun|funny|fancy|fancier|pretty|prettier|cute|cuter|serious|scary|spooky|creepy|thin|thinner|thick|thicker|clean|cleaner|simple|simpler|elegant|cursive|script|happy|sad|angry|loud|quiet|small|big|large|tiny|huge|bigger|smaller|larger|old|older|young|kid|childish|adult|professional|cartoony|cartoonish|messy|neat|neater|curly|blocky|round|rounder|smooth|rough|wild|crazy|weird|unique|special|matching|consistent|whole|entire|my|our|your|their|his|her|same|other|another|different|new|nicest|best|coolest)$/;

/** "comic sans", "papyrus": words that read as a font NAME the studio lacks (asked about with the 3 nearest fonts). */
const fontNameLike = (words: string): boolean => {
  const tokens = words.split(/[\s-]+/).filter(Boolean);
  if (!tokens.length || tokens.length > 3) return false;
  return tokens.every(
    (t) => /^\p{L}{2,}$/u.test(t) && !STOP_NAMES.has(t) && !FONT_MOOD_RE.test(t) && !new RegExp(`^(?:${VERBS})$`).test(t) && !KIND_TERM_RE.test(t) && !LINE_NOUN_RE.test(t)
  );
};

const restyleX: Extractor = (c, prep, selected) => {
  const st = parseStyle(c);
  if (!st.matched || (st.unknownFont && !fontNameLike(st.unknownFont))) return null;
  let rest = st.rest;
  let scope: 'line' | 'kind' | 'speaker' | 'comic' = 'line';
  let ref: PluralLineRef | undefined;
  let m: RegExpExecArray | null;
  if ((m = /\b(?:everything|all (?:the )?(?:text|lettering|bubbles|balloons|lines|dialogue)|every (?:bubble|balloon|line)|the whole comic|the entire comic|all lettering|whole comic)\b/.exec(rest))) {
    scope = 'comic';
    ref = { all: true };
  } else if ((m = new RegExp(`\\bfor\\s+${NAME}(?:'s)?(?:\\s+(?:lines|dialogue|bubbles|balloons|words))?\\s*$`, 'u').exec(rest)) && cleanName(m[1]) && !KIND_TERM_RE.test(m[1])) {
    scope = 'speaker';
    ref = { speaker: cleanName(m[1]), all: true };
    rest = rest.replace(m[0], ' ');
  }
  let anchoredOk = true;
  if (!ref) {
    const r = targetFrom(rest.replace(/\b(?:make|use|set|give|change|turn|colou?r|paint|it a|look|looks|with|style)\b/g, ' '), prep, selected);
    if (!r) return null;
    ref = r.ref;
    anchoredOk = confidentFor(r, c, selected);
    if (ref.speaker && ref.all && !ref.kind && ref.page === undefined && ref.panel === undefined && !ref.selected) scope = 'speaker';
    else if (ref.kind && ref.all && ref.page === undefined && ref.panel === undefined && !ref.speaker && !ref.selected && !ref.textContains) scope = 'kind';
  }
  const intent = {
    act: 'restyle',
    target: ref,
    scope,
    style: st.style,
    ...(st.scaleBy !== undefined ? { scaleBy: st.scaleBy } : {}),
    ...(st.unknownFont ? { unknownFont: st.unknownFont } : {})
  } as DialogueIntent & RestyleExtras;
  return { intents: [intent], confident: anchoredOk || scope !== 'line', target: ref };
};

/** Most specific first: a later extractor never sees a clause an earlier one understood. */
const EXTRACTORS: readonly Extractor[] = [emphasisX, copyStyleX, aimTailX, tailStyleX, swapX, reorderX, moveToPanelX, zX, lockX, linkX, speakerX, addX, editTextX, deleteX, moveX, setKindX, restyleX];

// ── The grammar ──────────────────────────────────────────────────────────────

const PRONOUN_RE = /^(?:her|his|their|she|he|they|him|them)$/;

/** Every LineRef an intent carries, for carrying "it" and "her" across clauses. */
const refsOf = (i: DialogueIntent): LineRef[] => {
  const out: LineRef[] = [];
  if ('target' in i && i.target) out.push(i.target);
  if (i.act === 'swap') out.push(i.a, i.b);
  if (i.act === 'reorder' && typeof i.to === 'object') out.push('before' in i.to ? i.to.before : i.to.after);
  if ((i.act === 'link' || i.act === 'z' || i.act === 'lock' || i.act === 'unlock' || i.act === 'unlink') && i.other) out.push(i.other);
  return out;
};

/**
 * Sentence → intents (B2 grammar.ts): splits run-ons on "and / then / also", drops fillers, maps kind, look, position
 * and ordinal words. `selected`: the creator has balloons selected (deixis resolves to them).
 */
export function parseDialogue(text: string, opts: { selected?: boolean } = {}): GrammarResult {
  const selected = opts.selected === true;
  if (typeof text !== 'string' || !text.trim()) return { intents: [], confident: false };
  const { text: t, prep } = prepare(text.slice(0, 2000));
  const intents: DialogueIntent[] = [];
  const rest: string[] = [];
  let confident = true;
  let prevTarget: PluralLineRef | undefined;
  let lastName: string | undefined;
  for (const clause of clausesOf(t)) {
    let out: Clause | null = null;
    for (const x of EXTRACTORS) {
      out = x(clause, prep, selected);
      if (out && out.intents.length) break;
      out = null;
    }
    if (!out) {
      rest.push(clause.replace(Q_RE_G, (_, n: string) => `"${prep.quotes[Number(n)]}"`));
      confident = false;
      continue;
    }
    // "…and make it a whisper": a bare "it" means the line the sentence already named.
    const bare = (r: LineRef | undefined) => !!r && !hasNarrowing(r);
    if (prevTarget && hasNarrowing(prevTarget) && out.target && bare(out.target)) {
      const carried = { ...prevTarget };
      for (const i of out.intents) {
        if ('target' in i && i.target && bare(i.target)) (i as { target: LineRef }).target = carried;
        if (i.act === 'swap') {
          if (bare(i.a)) i.a = carried;
          if (bare(i.b)) i.b = carried;
        }
      }
      out.target = carried;
    } else if (!out.confident) confident = false;
    // "her": the speaker this sentence already named.
    for (const i of out.intents) {
      for (const r of refsOf(i)) {
        if (r.speaker && PRONOUN_RE.test(r.speaker) && lastName) r.speaker = lastName;
        else if (r.speaker && !PRONOUN_RE.test(r.speaker)) lastName = r.speaker;
      }
      if (i.act === 'set_speaker' && i.speaker !== 'off_panel') lastName = i.speaker;
      if (i.act === 'add' && i.speaker) lastName = i.speaker;
    }
    intents.push(...out.intents);
    if (out.target) prevTarget = out.target;
  }
  const result: GrammarResult = { intents, confident: confident && intents.length > 0 && !rest.length };
  if (rest.length) result.rest = rest.join('; ');
  return result;
}

// ── The director's arguments (dialogue_edit, tool JSON) ─────────────────────

const str = (v: unknown, max = 600): string | undefined => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : undefined);
const int = (v: unknown): number | undefined => (typeof v === 'number' && Number.isInteger(v) ? v : typeof v === 'string' && /^-?\d+$/.test(v.trim()) ? Number(v) : undefined);
const oneOf = <T extends string>(v: unknown, list: readonly T[]): T | undefined => (typeof v === 'string' && (list as readonly string[]).includes(v) ? (v as T) : undefined);
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** dialogue_edit's LINE_REF_SCHEMA object → LineRef (text_contains, line_ids, nth -1 = last; `all` for plurals). */
export const lineRefFromArgs = (raw: unknown): PluralLineRef => {
  if (!isObj(raw)) return {};
  const r: PluralLineRef = {};
  if (raw.selected === true) r.selected = true;
  const page = int(raw.page);
  if (page !== undefined && page > 0) r.page = page;
  else if (raw.page === 'this') r.page = 'this';
  const panel = int(raw.panel);
  if (panel !== undefined && panel > 0) r.panel = panel;
  else if (raw.panel === 'first' || raw.panel === 'last') r.panel = raw.panel;
  const speaker = str(raw.speaker, 80);
  if (speaker) r.speaker = speaker;
  const kind = oneOf(raw.kind, LINE_KINDS);
  if (kind) r.kind = kind;
  const contains = str(raw.text_contains ?? raw.textContains, 120);
  if (contains) r.textContains = contains;
  const ids = raw.line_ids ?? raw.lineIds;
  if (Array.isArray(ids)) {
    const list = ids.filter((x): x is string => typeof x === 'string' && !!x).slice(0, 80);
    if (list.length) r.lineIds = list;
  }
  const nth = int(raw.nth);
  if (nth !== undefined && nth !== 0) r.nth = nth === -1 ? 'last' : nth;
  else if (raw.nth === 'first' || raw.nth === 'last') r.nth = raw.nth;
  const which = oneOf(raw.which, ['top', 'bottom', 'left', 'right', 'biggest'] as const);
  if (which) r.which = which;
  if (raw.all === true) r.all = true;
  return r;
};

const placementFromArgs = (raw: unknown): Placement | undefined => {
  if (!isObj(raw)) return undefined;
  const frame = oneOf(raw.frame, ['panel', 'page'] as const) ?? 'panel';
  const p: Placement = { frame };
  const cell = oneOf(raw.cell, POS9);
  if (cell) p.cell = cell;
  const edge = oneOf(raw.edge, ['top', 'bottom'] as const);
  if (edge) p.edge = edge;
  const near = str(raw.near, 80);
  if (near) p.near = near;
  const relation = oneOf(raw.relation, ['above', 'below', 'left', 'right', 'near', 'between'] as const);
  if (relation) p.relation = relation;
  const and = str(raw.and, 80);
  if (and) p.and = and;
  const nudge = oneOf(raw.nudge, ['up', 'down', 'left', 'right'] as const);
  if (nudge) p.nudge = nudge;
  const amount = oneOf(raw.amount, ['bit', 'lot'] as const);
  if (amount) p.amount = amount;
  return p.cell || p.edge || p.near || p.relation || p.nudge ? p : undefined;
};

/** dialogue_edit's style.size words ("larger", "much smaller") → a factor of each line's own size. */
const SIZE_WORDS: Readonly<Record<string, number>> = {
  larger: 1.2, bigger: 1.2, big: 1.2, large: 1.2, 'a bit larger': 1.1, 'a bit bigger': 1.1, 'slightly larger': 1.1, 'slightly bigger': 1.1,
  'much larger': 1.45, 'much bigger': 1.45, huge: 1.6, smaller: 0.85, small: 0.85, 'a bit smaller': 0.9, 'slightly smaller': 0.9, 'much smaller': 0.7, tiny: 0.7
};

/**
 * The flat style args a model may send, for the parts that need no current style (B-TOOL converts the rest), and a font
 * name the studio does not have (never dropped silently: the compiler asks with the 3 nearest fonts).
 */
const styleFromArgs = (raw: unknown): { style: LetterStylePatch; unknownFont?: string } => {
  if (!isObj(raw)) return { style: {} };
  const out: LetterStylePatch = {};
  let unknownFont: string | undefined;
  if (typeof raw.font === 'string' && raw.font.trim()) {
    const f = fontFromWords(raw.font);
    if (f.font) out.font = f.font;
    else unknownFont = raw.font.trim().slice(0, 40);
  }
  if (typeof raw.bold === 'boolean') out.weight = raw.bold ? 700 : 400;
  if (typeof raw.italic === 'boolean') out.italic = raw.italic;
  for (const [arg, key] of [['text_color', 'textColor'], ['fill_color', 'fill'], ['border_color', 'border']] as const) {
    const c = typeof raw[arg] === 'string' ? normalizeColor(raw[arg]) : undefined;
    if (c && c !== 'auto') out[key] = c;
  }
  const shape = oneOf(raw.shape, BUBBLE_SHAPES);
  if (shape) out.shape = shape;
  const tail = oneOf(raw.tail, TAIL_STYLES);
  if (tail) out.tail = tail;
  return { style: out, ...(unknownFont ? { unknownFont } : {}) };
};

/**
 * dialogue_edit's style.size (the server's STYLE_SCHEMA: "smaller", "larger" or a scale like "1.2") → a factor of each
 * line's own size (`scaleBy`, for words) or an absolute text size (`sizeScale` 0.5–3.5, for a number; "normal" = 1).
 */
const sizeFromArgs = (raw: unknown): { scaleBy?: number; sizeScale?: number } | { error: string } | undefined => {
  if (raw === undefined || raw === null || raw === '') return undefined;
  const abs = (n: number) => ({ sizeScale: Math.round(Math.min(3.5, Math.max(0.5, n)) * 100) / 100 });
  if (typeof raw === 'number' && Number.isFinite(raw) && raw > 0) return abs(raw);
  if (typeof raw === 'string') {
    const key = raw.trim().toLowerCase();
    const word = SIZE_WORDS[key];
    if (word !== undefined) return { scaleBy: word };
    if (/^(?:normal|default|reset|regular)$/.test(key)) return { sizeScale: 1 };
    const n = /^(\d+(?:\.\d+)?)\s*x?$/.exec(key);
    if (n && Number(n[1]) > 0) return abs(Number(n[1]));
  }
  return { error: `Size must be "smaller", "larger" or a scale like 1.2 (got "${String(raw).slice(0, 20)}").` };
};

/**
 * dialogue_edit arguments (the director's structured path: other languages, messy wording) → one DialogueIntent, or
 * the plain reason it cannot be one. `opts.style` is the converted style patch (B-TOOL: styleArgsToPatch); without it the
 * flat args that need no current style (font words, bold, italic, colours, shape, tail) are converted here.
 */
export function intentFromArgs(args: unknown, opts: { style?: LetterStylePatch } = {}): { intent: DialogueIntent } | { error: string } {
  if (!isObj(args)) return { error: 'dialogue_edit needs an object with an action.' };
  const act = oneOf(args.action, DIALOGUE_ACTS) as DialogueAct | undefined;
  if (!act) return { error: `Unknown action. Use one of: ${DIALOGUE_ACTS.join(', ')}.` };
  const target = lineRefFromArgs(args.target);
  const second = isObj(args.second) ? lineRefFromArgs(args.second) : undefined;
  const kind = oneOf(args.kind, LINE_KINDS);
  const text = str(args.text);
  switch (act) {
    case 'set_kind':
      return kind ? { intent: { act, target, kind } } : { error: `set_kind needs kind: ${LINE_KINDS.join(', ')}.` };
    case 'edit_text':
      return text ? { intent: { act, target, text } } : { error: 'edit_text needs text: the new words.' };
    case 'set_speaker': {
      const speaker = str(args.speaker, 80);
      return speaker ? { intent: { act, target, speaker: speaker === 'off_panel' ? 'off_panel' : speaker } } : { error: 'set_speaker needs speaker: a cast name, or "off_panel".' };
    }
    case 'add': {
      if (!kind) return { error: `add needs kind: ${LINE_KINDS.join(', ')}.` };
      const place = placementFromArgs(args.place);
      const speaker = str(args.speaker, 80);
      return { intent: { act, panel: target, kind, ...(speaker ? { speaker } : {}), ...(text ? { text } : {}), ...(place ? { place } : {}) } };
    }
    case 'delete':
      return { intent: { act, target } };
    case 'move': {
      const place = placementFromArgs(args.place);
      return place ? { intent: { act, target, place } } : { error: 'move needs place: a cell, an edge, a character to stand near, or a nudge.' };
    }
    case 'aim_tail': {
      const to = str(args.tail_to, 80);
      return to ? { intent: { act, target, to } } : { error: 'aim_tail needs tail_to: a character, or "mouth".' };
    }
    case 'tail_style': {
      const style = opts.style ?? styleFromArgs(args.style).style;
      const tail = style.tail ?? oneOf(args.tail, TAIL_STYLES);
      return tail ? { intent: { act, target, tail } } : { error: `tail_style needs style.tail: ${TAIL_STYLES.join(', ')}.` };
    }
    case 'reorder': {
      const index = int(args.index);
      if (second) return { intent: { act, target, to: index !== undefined && index > 0 ? { after: second } : { before: second } } };
      if (index === 0) return { intent: { act, target, to: 'first' } };
      if (index === -1) return { intent: { act, target, to: 'last' } };
      // "0-based position in the panel": the compiler places it there (the panel's length is known only with the doc).
      if (index !== undefined && index > 0) return { intent: { act, target, to: 'last', atIndex: index } as DialogueIntent & ReorderExtras };
      return { error: 'reorder needs index (0 = first, -1 = last, or a 0-based position) or second (the line to go before).' };
    }
    case 'swap':
      return second ? { intent: { act, a: target, b: second } } : { intent: { act, a: { ...target, all: true } as PluralLineRef, b: { ...target, all: true } as PluralLineRef } };
    case 'move_to_panel': {
      const panel = int(args.to_panel);
      return panel && panel > 0 ? { intent: { act, target, panel, ...(typeof target.page === 'number' ? { page: target.page } : {}) } } : { error: 'move_to_panel needs to_panel: the panel number.' };
    }
    case 'restyle': {
      const scope = oneOf(args.scope, ['line', 'kind', 'speaker', 'comic'] as const) ?? 'line';
      const flat = styleFromArgs(args.style);
      const style: LetterStylePatch = { ...(opts.style ?? flat.style) };
      // Size always comes from the args: "larger" / "smaller" stay relative to each line's own size (compile.ts scaleBy),
      // a number is an absolute text size. A size B-TOOL already converted against one style is replaced.
      const sized = sizeFromArgs(isObj(args.style) ? args.style.size : undefined);
      if (sized && 'error' in sized) return { error: sized.error };
      const size = sized as { scaleBy?: number; sizeScale?: number } | undefined;
      if (size) delete style.sizeScale;
      if (size?.sizeScale !== undefined) style.sizeScale = size.sizeScale;
      const scaleBy = size?.scaleBy;
      // A font the studio does not have is carried through (the compiler asks with the 3 nearest), never dropped.
      const unknownFont = style.font ? undefined : flat.unknownFont;
      if (!Object.keys(style).length && scaleBy === undefined && !unknownFont) return { error: 'restyle needs style changes (font, colours, shape, bold, italic, size…).' };
      const intent = { act, target, scope, style, ...(scaleBy !== undefined ? { scaleBy } : {}), ...(unknownFont ? { unknownFont } : {}) } as DialogueIntent & RestyleExtras;
      return { intent };
    }
    case 'z': {
      const dir = oneOf(args.dir, ['front', 'back'] as const) ?? 'front';
      return { intent: { act, target, dir } };
    }
    case 'lock':
    case 'unlock':
    case 'unlink':
      return { intent: { act, target } };
    case 'link':
      return { intent: { act, target: second ? target : ({ ...target, all: true } as PluralLineRef), ...(second ? { other: second } : {}) } };
    case 'emphasis': {
      const words = (text ?? '').split(/[,\s]+/).filter(Boolean).slice(0, 8);
      return words.length ? { intent: { act, target, words, style: isObj(args.style) && args.style.italic === true ? 'italic' : 'bold' } } : { error: 'emphasis needs text: the word(s) to emphasise.' };
    }
    default:
      return { error: 'That action is not available.' };
  }
}
