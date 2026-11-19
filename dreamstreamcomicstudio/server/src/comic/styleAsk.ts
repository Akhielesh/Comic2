// An ask to SEE drawn looks of this comic (stylepick SC-0): "generate 3 of the best style options", "egernate 3
// styles", "show me some looks", "6 looks". The Director answers it with propose_styles (priced, waits for Approve);
// a WHICH-look question ("which style suits this?") and an ask to browse the free presets ("show me the free styles")
// still get the free presets. Pure and deterministic ($0).
//
// A match needs a look noun (looks, styles, styling, common transpositions such as "styels") AND either a count near
// it (digits, two..ten, "a couple" = 2, "a few" / "several" = 3, "some" = 3 next to a see/draw verb) or a see/draw
// verb (typos such as "genrate" / "egernate" included) with a plural or compound noun ("looks", "style options").
// Never: a which/what question without a count or a drawing verb; a negated ask (a negation up to 3 words before the
// verb or the noun, within one comma-separated part: "don't draw styles yet", but "draw 4 styles, no need to be
// fancy" is an ask); a noun qualified by lettering words ("the balloon styles"; "without text" is not one) or by
// browse words ("the free styles", "the styles in the library"); looks already there ("the 3 looks", "those two looks", "I picked 2 styles",
// "show me your looks"; a drawing verb still makes it an ask: "generate the 5 best styles"); or "look"/"style" used as
// a verb ("make her look older", "style it like noir"). Kept in its own module so intents.ts stays untouched.

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
/** A look noun this close to a browse word is about the free presets ("the free styles", "styles in the library"). */
const BROWSE_RE = /^(?:presets?|free|library|curated|available|existing|catalog|catalogue)$/;
const BROWSE_SPAN = 3;
/** How far before the noun a count may sit ("generate 3 of the best style options"). */
const COUNT_SPAN = 5;

const GENERATE_RE = /^(?:re)?(?:generate|genrate|generte|genarate|gnerate|egernate|geneate|genreate|generat)$/;
/** Verbs that ask for pictures to be made. A which/what question needs one of these (or a count) to be an ask. */
const DRAW_VERB_RE = /^(?:draw|drawing|make|create|render|paint|illustrate|sketch)$/;
/** Softer see verbs: an ask only with a plural or compound noun and no which/what. */
const SEE_VERB_RE = /^(?:show|see|try|explore)$/;
const WH_RE = /^(?:which|what|whats|what's)$/;
/** How far before a verb or the noun a negation reaches ("don't draw", "do not ever make", "no need to draw"). */
const NEGATION_SPAN = 3;

/** "look"/"looks" after one of these is a verb ("make her look older", "it looks great"). */
const LOOK_SUBJECT_RE = /^(?:it|he|she|they|him|her|them|i|you|we|this|that|to|does|do|doesn't|don't|dont|did|didn't|would|should|could|will|can|can't|cant|might|must|everything|everyone)$/;
/** …or before one of these ("looks like", "look better", "looks good"). */
const LOOK_FOLLOW_RE = /^(?:like|at|into|more|less|better|worse|good|great|nice|fine|ok|okay|bad|right|wrong|off|older|younger|bigger|smaller|similar|same|as|amazing|awesome|cool|weird|strange|odd|cute|scary|real|realistic|perfect|beautiful|lovely|darker|lighter|brighter)$/;
/** "style it like noir": "style" before an object pronoun is a verb. */
const STYLE_OBJECT_RE = /^(?:it|them|him|her|this|that|me|us)$/;
/** A digit after one of these is not a count of looks ("page 2", "panel 3"). */
const NOT_A_COUNT_BEFORE_RE = /^(?:page|pages|panel|panels|chapter|issue|part|p|no|number|#)$/;
/** A number after one of these points at looks already there ("the 3 looks", "those two looks", "I picked 2 styles"). */
const REFERS_BEFORE_RE = /^(?:the|those|these|your|my|our|both|all|picked|chose|chosen|liked|loved|kept|locked|drew|drawn|made|generated|tried)$/;
/** "one of 3 styles", "which of 3 looks": a number after "of" in a pick-one phrase points at looks already there. */
const PICK_OF_RE = /^(?:one|any|none|which|each|either|neither|most)$/;
/** A determiner this close before the noun points at looks already there ("show me your looks", "mix the styles"). */
const DETERMINER_RE = /^(?:the|those|these|your|my|our|both|all)$/;
const DETERMINER_SPAN = 2;

const NUMBER_WORDS: Readonly<Record<string, number>> = { two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };

type Count = { n: number; weak: boolean };
/** One sentence: its words, and for each word whether it sits in a negated comma-separated part. */
type Clause = { words: string[]; off: boolean[] };

const words = (text: string): string[] =>
  text
    .split(/[^a-z0-9'#]+/)
    .map((w) => w.replace(/^'+|'+$/g, ''))
    .filter(Boolean);

const isDrawVerb = (ws: string[], k: number): boolean =>
  GENERATE_RE.test(ws[k]) || DRAW_VERB_RE.test(ws[k]) || (ws[k] === 'give' && /^(?:me|us)$/.test(ws[k + 1] ?? ''));

/** A negation word ends at k: don't, never, stop, "do not", "not yet", "no need to". */
const negationAt = (ws: string[], k: number): boolean => {
  const w = ws[k];
  if (/^(?:don't|dont|never|stop)$/.test(w)) return true;
  if (w === 'not') return ws[k - 1] === 'do' || ws[k + 1] === 'yet';
  return w === 'to' && ws[k - 1] === 'need' && ws[k - 2] === 'no';
};

/** A part is negated when a negation sits up to NEGATION_SPAN words before one of its verbs or look nouns. */
const negatedPart = (ws: string[]): boolean =>
  ws.some((w, t) => {
    if (!(NOUN_RE.test(w) || isDrawVerb(ws, t) || SEE_VERB_RE.test(w))) return false;
    for (let k = Math.max(0, t - NEGATION_SPAN); k < t; k += 1) if (negationAt(ws, k)) return true;
    return false;
  });

const clauses = (text: string): Clause[] =>
  text
    .toLowerCase()
    .replace(/[’‘]/g, "'")
    .split(/[.!?;\n]+/)
    .map((sentence) => {
      const out: Clause = { words: [], off: [] };
      for (const part of sentence.split(',')) {
        const ws = words(part);
        const off = negatedPart(ws);
        for (const w of ws) {
          out.words.push(w);
          out.off.push(off);
        }
      }
      return out;
    })
    .filter((c) => c.words.length > 0);

/**
 * The count before the noun at i, or null. A number that points at looks already there ("the 3 looks") is no count
 * unless the sentence asks to draw (a drawing verb and no which/what: "generate the 5 best styles").
 */
const countBefore = (ws: string[], i: number, drawAsk: boolean): Count | null => {
  for (let j = i - 1; j >= Math.max(0, i - COUNT_SPAN); j -= 1) {
    const w = ws[j];
    const prev = ws[j - 1] ?? '';
    const n = /^\d{1,2}$/.test(w) ? (NOT_A_COUNT_BEFORE_RE.test(prev) ? 0 : Number(w)) : NUMBER_WORDS[w] || 0;
    if (n) {
      const refers = REFERS_BEFORE_RE.test(prev) || (prev === 'of' && PICK_OF_RE.test(ws[j - 2] ?? ''));
      return refers && !drawAsk ? null : { n, weak: false };
    }
    if (w === 'couple' && prev === 'a') return { n: 2, weak: false };
    if (w === 'few' && prev === 'a') return { n: 3, weak: false };
    if (w === 'several') return { n: 3, weak: false };
    if (w === 'some') return { n: DEFAULT_LOOKS, weak: true };
  }
  return null;
};

const usedAsVerb = (ws: string[], i: number): boolean => {
  const w = ws[i];
  const prev = ws[i - 1] ?? '';
  const next = ws[i + 1] ?? '';
  if (/^looks?$/.test(w)) return LOOK_SUBJECT_RE.test(prev) || LOOK_FOLLOW_RE.test(next);
  if (/^styles?$/.test(w)) return STYLE_OBJECT_RE.test(next);
  return false;
};

const near = (ws: string[], i: number, span: number, test: (w: string, j: number) => boolean): boolean => {
  for (let j = Math.max(0, i - span); j <= Math.min(ws.length - 1, i + span); j += 1) {
    if (j !== i && test(ws[j], j)) return true;
  }
  return false;
};

/** A lettering word right after "without" / "no" leaves the look alone ("3 looks without text", "no speech bubbles"). */
const qualified = (ws: string[], i: number): boolean =>
  near(ws, i, QUALIFIER_SPAN, (w, j) => QUALIFIER_RE.test(w) && !/^(?:without|no)$/.test(ws[j - 1] ?? '') && !/^(?:without|no)$/.test(ws[j - 2] ?? ''));

/** "the free styles", "the available looks", "styles in the library", "the looks you have" ("feel free to" is not). */
const browsing = (ws: string[], i: number): boolean =>
  near(ws, i, BROWSE_SPAN, (w, j) => (BROWSE_RE.test(w) && !(w === 'free' && ws[j + 1] === 'to')) || (j > i && w === 'you' && ws[j + 1] === 'have'));

const determined = (ws: string[], i: number): boolean => {
  for (let j = Math.max(0, i - DETERMINER_SPAN); j < i; j += 1) if (DETERMINER_RE.test(ws[j])) return true;
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
  const live = (c: Clause, test: (k: number) => boolean) => c.words.some((_, k) => !c.off[k] && test(k));
  const drawVerb = parts.some((c) => live(c, (k) => isDrawVerb(c.words, k)));
  const seeVerb = parts.some((c) => live(c, (k) => SEE_VERB_RE.test(c.words[k])));
  for (const c of parts) {
    const ws = c.words;
    const wh = ws.some((w) => WH_RE.test(w));
    const drawAsk = !wh && live(c, (k) => isDrawVerb(ws, k));
    for (let i = 0; i < ws.length; i += 1) {
      if (c.off[i] || !NOUN_RE.test(ws[i]) || qualified(ws, i) || browsing(ws, i)) continue;
      const count = countBefore(ws, i, drawAsk);
      if (!count && usedAsVerb(ws, i)) continue;
      if (count && !count.weak) return result(count.n);
      // "some" or no count: a verb has to ask for pictures, and looks already there need a drawing verb.
      if (wh || determined(ws, i) ? !drawVerb : !(drawVerb || seeVerb)) continue;
      if (count?.weak) return result(count.n);
      if (PLURAL_RE.test(ws[i]) || COMPOUND_RE.test(ws[i + 1] ?? '')) return result(DEFAULT_LOOKS);
    }
  }
  return null;
}

/** The tool result that sends an ask to see drawn looks to propose_styles (the free preset tools refuse with it). */
export const drawnLooksRedirect = (ask: StyleLooksAsk): string =>
  `The user asked to see drawn looks. Call propose_styles with count ${ask.count} (and presetIds or directions only for looks they named). It shows the price and waits for their Approve.`;
