// An ask to SEE drawn looks of this comic (stylepick SC-0): "generate 3 of the best style options", "egernate 3
// styles", "show me some looks", "6 looks". The Director answers it with propose_styles (priced, waits for Approve);
// a WHICH-look question ("which style suits this?") still gets the free presets. Pure and deterministic ($0).
//
// A match needs a look noun (looks, styles, styling, common transpositions such as "styels") AND either a count near
// it (digits, two..ten, "a couple" = 2, "a few" / "several" = 3, "some" = 3 next to a see/draw verb) or a see/draw
// verb (typos such as "genrate" / "egernate" included) with a plural or compound noun ("looks", "style options").
// Never: a which/what question without a count or a drawing verb, a negated ask ("don't draw styles yet"), a noun
// qualified by lettering words ("the balloon styles", "lettering style"), or "look"/"style" used as a verb ("make her
// look older", "style it like noir"). Kept in its own module so intents.ts stays untouched (stylepick §5).

export interface StyleLooksAsk {
  /** Looks to draw, 2–6. */
  count: number;
  /** The ask named a number outside 2–6 (the tool result says so). */
  clamped: boolean;
}

export const MIN_LOOKS = 2;
export const MAX_LOOKS = 6;
export const DEFAULT_LOOKS = 3;

/** Longer text is cut before matching (the noun scan is linear, this keeps it cheap on a pasted script). */
const MAX_CHARS = 2000;

const NOUN_RE = /^(?:looks?|styles?|styling|styels?|stlyes?|syles?|artstyles?)$/;
const PLURAL_RE = /^(?:looks|styles|styels|stlyes|syles|artstyles)$/;
/** "style options", "look ideas", "style boards": a compound noun reads as a set of looks even when singular. */
const COMPOUND_RE = /^(?:options?|directions?|boards?|tests?|ideas?|choices?|variations?)$/;
/** A look noun this close to a lettering word is about lettering ("the balloon styles", "lettering style"). */
const QUALIFIER_RE = /^(?:lettering|letters?|balloons?|bubbles?|fonts?|captions?|sfx|texts?|speech)$/;
const QUALIFIER_SPAN = 3;
/** How far before the noun a count may sit ("generate 3 of the best style options"). */
const COUNT_SPAN = 5;

const GENERATE_RE = /^(?:re)?(?:generate|genrate|generte|genarate|gnerate|egernate|geneate|genreate|generat)$/;
/** Verbs that ask for pictures to be made. A which/what question needs one of these (or a count) to be an ask. */
const DRAW_VERB_RE = /^(?:draw|drawing|make|create|render|paint|illustrate|sketch)$/;
/** Softer see verbs: an ask only with a plural or compound noun and no which/what. */
const SEE_VERB_RE = /^(?:show|see|try|explore)$/;
const WH_RE = /^(?:which|what|whats|what's)$/;
const NEGATION_RE = /\b(?:don'?t|do not|never|no need to|not yet|stop|without)\b/;

/** "look"/"looks" after one of these is a verb ("make her look older", "it looks great"). */
const LOOK_SUBJECT_RE = /^(?:it|he|she|they|him|her|them|i|you|we|this|that|to|does|do|doesn't|don't|dont|did|didn't|would|should|could|will|can|can't|cant|might|must|everything|everyone)$/;
/** …or before one of these ("looks like", "look better", "looks good"). */
const LOOK_FOLLOW_RE = /^(?:like|at|into|more|less|better|worse|good|great|nice|fine|ok|okay|bad|right|wrong|off|older|younger|bigger|smaller|similar|same|as|amazing|awesome|cool|weird|strange|odd|cute|scary|real|realistic|perfect|beautiful|lovely|darker|lighter|brighter)$/;
/** "style it like noir": "style" before an object pronoun is a verb. */
const STYLE_OBJECT_RE = /^(?:it|them|him|her|this|that|me|us)$/;
/** A digit after one of these is not a count of looks ("page 2", "panel 3"). */
const NOT_A_COUNT_BEFORE_RE = /^(?:page|pages|panel|panels|chapter|issue|part|p|no|number|#)$/;

const NUMBER_WORDS: Readonly<Record<string, number>> = { two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };

type Count = { n: number; weak: boolean };

const clauses = (text: string): string[][] =>
  text
    .toLowerCase()
    .replace(/[’‘]/g, "'")
    .split(/[.!?;\n]+/)
    .map((c) =>
      c
        .split(/[^a-z0-9'#]+/)
        .map((w) => w.replace(/^'+|'+$/g, ''))
        .filter(Boolean)
    )
    .filter((c) => c.length > 0);

const countBefore = (words: string[], i: number): Count | null => {
  for (let j = i - 1; j >= Math.max(0, i - COUNT_SPAN); j -= 1) {
    const w = words[j];
    const prev = words[j - 1] ?? '';
    if (/^\d{1,2}$/.test(w) && !NOT_A_COUNT_BEFORE_RE.test(prev)) return { n: Number(w), weak: false };
    if (NUMBER_WORDS[w]) return { n: NUMBER_WORDS[w], weak: false };
    if (w === 'couple' && prev === 'a') return { n: 2, weak: false };
    if (w === 'few' && prev === 'a') return { n: 3, weak: false };
    if (w === 'several') return { n: 3, weak: false };
    if (w === 'some') return { n: DEFAULT_LOOKS, weak: true };
  }
  return null;
};

const usedAsVerb = (words: string[], i: number): boolean => {
  const w = words[i];
  const prev = words[i - 1] ?? '';
  const next = words[i + 1] ?? '';
  if (/^looks?$/.test(w)) return LOOK_SUBJECT_RE.test(prev) || LOOK_FOLLOW_RE.test(next);
  if (/^styles?$/.test(w)) return STYLE_OBJECT_RE.test(next);
  return false;
};

const qualified = (words: string[], i: number): boolean => {
  for (let j = Math.max(0, i - QUALIFIER_SPAN); j <= Math.min(words.length - 1, i + QUALIFIER_SPAN); j += 1) {
    if (j !== i && QUALIFIER_RE.test(words[j])) return true;
  }
  return false;
};

const result = (n: number): StyleLooksAsk => {
  const count = Math.min(MAX_LOOKS, Math.max(MIN_LOOKS, n));
  return { count, clamped: count !== n };
};

/** The ask to see N drawn looks in this text, or null. */
export function styleLooksAsk(text: string): StyleLooksAsk | null {
  if (typeof text !== 'string' || !text.trim()) return null;
  const parts = clauses(text.slice(0, MAX_CHARS));
  const all = parts.flat();
  const drawVerb = all.some((w, k) => GENERATE_RE.test(w) || DRAW_VERB_RE.test(w) || (w === 'give' && /^(?:me|us)$/.test(all[k + 1] ?? '')));
  const seeVerb = all.some((w) => SEE_VERB_RE.test(w));
  for (const words of parts) {
    if (NEGATION_RE.test(words.join(' '))) continue;
    const wh = words.some((w) => WH_RE.test(w));
    for (let i = 0; i < words.length; i += 1) {
      if (!NOUN_RE.test(words[i]) || qualified(words, i)) continue;
      const count = countBefore(words, i);
      if (!count && usedAsVerb(words, i)) continue;
      if (count && !count.weak) return result(count.n);
      // "some" or no count: a verb has to ask for pictures.
      if (wh ? !drawVerb : !(drawVerb || seeVerb)) continue;
      if (count?.weak) return result(count.n);
      if (PLURAL_RE.test(words[i]) || COMPOUND_RE.test(words[i + 1] ?? '')) return result(DEFAULT_LOOKS);
    }
  }
  return null;
}
