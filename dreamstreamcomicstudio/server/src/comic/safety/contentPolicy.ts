// PG-13 content policy: the free pre-filter, the decision mapping, the director's policy
// block and the warm redirect copy (safety.md §3.1, §3.5, §6.1). Owner: P1-SAFETY.
//
// Everything here is pure, synchronous and $0. It never logs, stores or echoes the text it
// screens — callers record categories and a one-way hash only.

import crypto from 'node:crypto';
import { RegExpMatcher, englishDataset, englishRecommendedTransformers } from 'obscenity';
import {
  ALWAYS_RULE,
  HARD_BLOCK,
  PLATFORM_CEILING,
  RATING_LABEL,
  RATING_RULES,
  ZERO_TOLERANCE,
  isContentRating,
  ratingRank,
  type AssessedRating,
  type ContentRating,
  type SafetyCategory
} from '../../../../shared/comic/safety.js';
import {
  ALLOW_PHRASES,
  DANGEROUS_INSTRUCTIONS,
  FIRST_PERSON_CRISIS,
  IP_NAMES,
  LEXICON,
  MINOR_AGE,
  MINOR_NATIVE,
  MINOR_TERMS,
  OBSCENITY_RULES,
  REAL_PEOPLE,
  SELF_HARM_INSTRUCTIONS,
  type LexTier
} from './lexicon.js';

// ── Normalization ────────────────────────────────────────────────────────────

const ZERO_WIDTH = /[​-‍⁠﻿­]/g;
const LEET: Record<string, string> = { '0': 'o', '1': 'i', '3': 'e', '4': 'a', '5': 's', '7': 't', '8': 'b', '@': 'a', '$': 's', '!': 'i', '|': 'i' };

/** NFKC, lowercase, zero-width removed, LATIN diacritics stripped (Indic vowel signs are kept). */
export const plainForMatch = (text: string): string =>
  (typeof text === 'string' ? text : '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(ZERO_WIDTH, '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .normalize('NFC');

/**
 * The matching form: plainForMatch + leet folded inside words (s3x → sex, @ss → ass),
 * spaced letters joined (s e x → sex) and runs of 3+ letters collapsed to 2 (fuuuck → fuuck).
 */
export const normalizeForMatch = (text: string, opts: { splitArticle?: boolean } = {}): string => {
  const splitArticle = opts.splitArticle !== false;
  let s = plainForMatch(text);
  // Leet only where it touches a letter, so "ages 2-6" and "4:5" survive.
  s = s.replace(/[0134578@$!|]/g, (ch, i: number, all: string) => {
    const prev = all[i - 1] || '';
    const next = all[i + 1] || '';
    return /[a-z]/.test(prev) || /[a-z]/.test(next) ? LEET[ch] || ch : ch;
  });
  s = s.replace(/\b(?:[a-z][\s._*\-]){2,}[a-z]\b/g, (m) => {
    const letters = m.replace(/[\s._*\-]/g, '');
    // "a s e x y" → "a sexy" (keep a leading article apart when the rest is a word of its own).
    return splitArticle && letters.length >= 4 && (letters[0] === 'a' || letters[0] === 'i') ? `${letters[0]} ${letters.slice(1)}` : letters;
  });
  s = s.replace(/([a-z])\1{2,}/g, '$1$1');
  return s;
};

/** One-way content fingerprint for events (sha256 of the normalized text, 16 hex). Never reversible. */
export const contentHash = (text: string): string =>
  crypto.createHash('sha256').update(normalizeForMatch(text || '')).digest('hex').slice(0, 16);

/** Share of letters that are not Latin (0..1). */
export const nonLatinShare = (text: string): number => {
  const letters = (typeof text === 'string' ? text : '').match(/\p{L}/gu) || [];
  if (!letters.length) return 0;
  const latin = letters.filter((c) => /\p{Script=Latin}/u.test(c)).length;
  return 1 - latin / letters.length;
};

// ── Pre-filter ───────────────────────────────────────────────────────────────

export interface PrefilterHit {
  category: SafetyCategory;
  tier: LexTier;
  /** Token index in the scanned string (for the co-occurrence rule). */
  token: number;
  sexual?: boolean;
  /** A dataset word that is often innocent ("sex education"): counts for co-occurrence only as ambiguous. */
  weak?: boolean;
  /** Preceded by a negation ("no …", "without …"): never a block by itself. */
  negated?: boolean;
  nudity?: boolean;
}

export interface PrefilterDetail {
  decision: 'clear' | 'ambiguous' | 'block';
  categories: SafetyCategory[];
  ip: string[];
  /** Severity if blocked: 3 (minors, real person + sexual), 1, or 0 (self-harm: answered with care). */
  severity: 0 | 1 | 3;
  /** First-person crisis wording (the reply adds a caring line). */
  crisis: boolean;
  /** A public figure was named (respectful portrayals are fine). */
  realPerson: boolean;
  /** Hits before rating clearance (internal; never contains text). */
  hits: number;
}

let matcher: RegExpMatcher | null = null;
const obscenity = (): RegExpMatcher => {
  if (!matcher) matcher = new RegExpMatcher({ ...englishDataset.build(), ...englishRecommendedTransformers });
  return matcher;
};

const tokenAt = (s: string, index: number): number => (s.slice(0, Math.max(0, index)).match(/[\p{L}\p{N}]+/gu) || []).length;

/** "no porn, it's for kids" is a parent's instruction, not a request: a negated hit goes to the classifier. */
const NEGATIONS: ReadonlySet<string> = new Set(['no', 'not', 'never', 'without', 'nothing', 'avoid', 'dont', 'don', 'zero', 'nor', 'none', 'nahi', 'nahin', 'mat', 'ban', 'banned', 'skip']);
const negatedAt = (s: string, token: number): boolean => {
  const tokens = s.match(/[\p{L}\p{N}]+/gu) || [];
  for (let i = Math.max(0, token - 3); i < token; i += 1) if (NEGATIONS.has(tokens[i])) return true;
  return false;
};

const eachMatch = (re: RegExp, s: string, fn: (m: RegExpExecArray) => void) => {
  const g = new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`);
  for (let m = g.exec(s); m; m = g.exec(s)) {
    fn(m);
    if (m[0] === '') g.lastIndex += 1;
  }
};

const stripAllowed = (s: string): string => {
  let out = s;
  for (const re of ALLOW_PHRASES) out = out.replace(new RegExp(re.source, 'g'), (m) => ' '.repeat(m.length));
  return out;
};

const scanLexicon = (s: string, hits: PrefilterHit[]) => {
  for (const entry of LEXICON) {
    eachMatch(entry.re, s, (m) => {
      const token = tokenAt(s, m.index);
      hits.push({
        category: entry.category,
        tier: entry.tier,
        token,
        ...(negatedAt(s, token) ? { negated: true } : {}),
        ...(entry.sexualSignal ? { sexual: true } : {}),
        ...(entry.nuditySignal ? { nudity: true } : {}),
        ...(entry.clearAt ? { clearAt: entry.clearAt } : {})
      } as PrefilterHit);
    });
  }
};

const scanObscenity = (s: string, hits: PrefilterHit[]) => {
  let matches: ReturnType<RegExpMatcher['getAllMatches']> = [];
  try {
    matches = obscenity().getAllMatches(s, true);
  } catch {
    return;
  }
  for (const match of matches) {
    let word = '';
    try {
      word = String(englishDataset.getPayloadWithPhraseMetadata(match).phraseMetadata?.originalWord || '');
    } catch {
      word = '';
    }
    const rule = OBSCENITY_RULES[word];
    if (!rule) continue; // homonyms (null) and anything unknown
    const token = tokenAt(s, match.startIndex);
    hits.push({
      category: rule.category,
      tier: rule.tier,
      token,
      ...(negatedAt(s, token) ? { negated: true } : {}),
      ...(rule.sexualSignal ? { sexual: true } : {}),
      ...(rule.sexualSignal && rule.tier === 'ambiguous' ? { weak: true } : {}),
      ...(rule.clearAt ? { clearAt: rule.clearAt } : {})
    } as PrefilterHit);
  }
};

const minorTokens = (plain: string, folded: string): number[] => {
  const out: number[] = [];
  eachMatch(MINOR_TERMS, folded, (m) => out.push(tokenAt(folded, m.index)));
  eachMatch(MINOR_NATIVE, plain, (m) => out.push(tokenAt(plain, m.index)));
  eachMatch(MINOR_AGE, plain, (m) => {
    const age = Number(m[1] ?? m[2] ?? m[3]);
    if (Number.isFinite(age) && age < 18) out.push(tokenAt(plain, m.index));
  });
  return out;
};

const near = (a: number[], b: number[], window = 8) => a.some((x) => b.some((y) => Math.abs(x - y) <= window));

/** Canonical trademark names mentioned (a steer to an original homage, never a block). */
export const findIpNames = (text: string): string[] => {
  const s = normalizeForMatch(text);
  const names: string[] = [];
  for (const entry of IP_NAMES) {
    eachMatch(entry.re, s, () => {
      if (!names.includes(entry.name)) names.push(entry.name);
    });
  }
  return names;
};

/** A one-line homage hint for a trademark name ("a cheeky five-year-old with the same chaos energy"). */
export const homageHint = (name: string): string | undefined => IP_NAMES.find((e) => e.name.toLowerCase() === String(name || '').toLowerCase())?.homage;

/**
 * The detailed pre-filter. `decision`:
 * - `block`: a high-confidence hard-block hit (explicit sexual terms, slurs, any minor term near a
 *   sexual term, real-world harm or self-harm instructions, a public figure + a sexual term).
 * - `ambiguous`: a context-dependent hit the rating doesn't clear by itself (the classifier decides).
 * - `clear`: nothing, or only words the rating allows (horror and action vocabulary never escalates).
 */
export const prefilterDetail = (text: string, rating: ContentRating): PrefilterDetail => {
  const effective: ContentRating = isContentRating(rating) ? rating : PLATFORM_CEILING;
  const raw = typeof text === 'string' ? text.slice(0, 200_000) : '';
  const empty: PrefilterDetail = { decision: 'clear', categories: [], ip: [], severity: 0, crisis: false, realPerson: false, hits: 0 };
  if (!raw.trim()) return empty;

  const plain = stripAllowed(plainForMatch(raw));
  const folded = stripAllowed(normalizeForMatch(raw));
  const hits: PrefilterHit[] = [];
  scanLexicon(folded, hits);
  scanObscenity(folded, hits);
  if (folded !== plain) scanObscenity(plain, hits);
  // "a n a l…" is ambiguous between "a nal" and one spelled-out word: scan the joined reading too.
  const joined = stripAllowed(normalizeForMatch(raw, { splitArticle: false }));
  if (joined !== folded) {
    scanLexicon(joined, hits);
    scanObscenity(joined, hits);
  }

  const ip = findIpNames(raw);
  const crisis = FIRST_PERSON_CRISIS.test(folded);
  const realPersonTokens: number[] = [];
  eachMatch(REAL_PEOPLE, folded, (m) => realPersonTokens.push(tokenAt(folded, m.index)));
  const realPerson = realPersonTokens.length > 0;

  const block = new Set<SafetyCategory>();
  let severity: 0 | 1 | 3 = 0;
  const bump = (n: 0 | 1 | 3) => {
    if (n > severity) severity = n;
  };

  // Zero tolerance: a minor term within 8 tokens of a sexual term.
  const minors = minorTokens(plain, folded);
  const sexualTokens = hits.filter((h) => h.sexual && !h.weak && !h.negated).map((h) => h.token);
  const weakSexualTokens = hits.filter((h) => h.sexual && (h.weak || h.negated)).map((h) => h.token);
  const nudityTokens = hits.filter((h) => h.nudity).map((h) => h.token);
  if (minors.length && sexualTokens.length && near(minors, sexualTokens)) {
    block.add('minor_sexual');
    bump(3);
  }
  // A public figure in a sexual context is severe too.
  if (realPerson && sexualTokens.length && near(realPersonTokens, sexualTokens)) {
    block.add('real_person');
    block.add('sexual');
    bump(3);
  }
  for (const re of DANGEROUS_INSTRUCTIONS) {
    if (re.test(folded)) {
      block.add('dangerous');
      bump(1);
    }
  }
  for (const re of SELF_HARM_INSTRUCTIONS) {
    if (re.test(folded)) block.add('self_harm');
  }
  for (const h of hits) {
    if (h.tier !== 'block' || h.negated) continue;
    block.add(h.category);
    bump(h.category === 'self_harm' ? 0 : 1);
  }
  if (block.size) {
    return { decision: 'block', categories: [...block], ip, severity, crisis, realPerson, hits: hits.length };
  }

  const ambiguous = new Set<SafetyCategory>();
  for (const h of hits) {
    const clearAt = (h as PrefilterHit & { clearAt?: ContentRating }).clearAt;
    if (clearAt && ratingRank(effective) >= ratingRank(clearAt)) continue;
    ambiguous.add(h.category);
  }
  // A minor near nudity words ("the baby splashes naked in the tub") or near an often-innocent
  // dataset word ("sex education for kids") is for the classifier, never a strike by itself.
  if (minors.length && nudityTokens.length && near(minors, nudityTokens)) {
    ambiguous.add('nudity');
    ambiguous.add('minor_sexual');
  }
  if (minors.length && weakSexualTokens.length && near(minors, weakSexualTokens)) {
    ambiguous.add('sexual');
    ambiguous.add('minor_sexual');
  }
  if (realPerson && weakSexualTokens.length && near(realPersonTokens, weakSexualTokens)) {
    ambiguous.add('sexual');
    ambiguous.add('real_person');
  }
  if (ambiguous.size) return { decision: 'ambiguous', categories: [...ambiguous], ip, severity: 0, crisis, realPerson, hits: hits.length };
  return { ...empty, ip, crisis, realPerson, hits: hits.length };
};

/** Severity points for a blocked decision (safety.md §8; self-harm is answered with care, no strike). */
export const severityFor = (categories: SafetyCategory[], extra: { hash?: boolean } = {}): 0 | 1 | 3 => {
  if (extra.hash || categories.includes('minor_sexual')) return 3;
  if (categories.includes('real_person') && categories.includes('sexual')) return 3;
  const counted = categories.filter((c) => HARD_BLOCK.has(c) && c !== 'self_harm');
  return counted.length ? 1 : 0;
};

// ── Text routing (when the classifier runs) ──────────────────────────────────

export const LONG_TEXT_CHARS = 6_000;
export const NON_LATIN_MIN_CHARS = 200;
export const NON_LATIN_SHARE = 0.4;
/** The classifier reads at most this much (60k head; longer: head/middle/tail 20k each). */
export const CLASSIFIER_CHARS = 60_000;

/** Clear text that still needs the classifier: long pastes and long non-Latin text (the lexicon is thin there). */
export const needsClassifier = (text: string, opts: { file?: boolean } = {}): boolean => {
  const t = typeof text === 'string' ? text : '';
  if (opts.file) return t.trim().length > 0;
  if (t.length > LONG_TEXT_CHARS) return true;
  return t.length >= NON_LATIN_MIN_CHARS && nonLatinShare(t) >= NON_LATIN_SHARE;
};

/** What the classifier sees of a long text (never more than ~60k characters). */
export const sampleForClassifier = (text: string): string => {
  const t = typeof text === 'string' ? text : '';
  if (t.length <= CLASSIFIER_CHARS) return t;
  const part = 20_000;
  const mid = Math.floor(t.length / 2 - part / 2);
  return [t.slice(0, part), '\n[…]\n', t.slice(mid, mid + part), '\n[…]\n', t.slice(-part)].join('');
};

// ── Decisions ────────────────────────────────────────────────────────────────

export interface ClassifierVerdict {
  assessed: AssessedRating;
  categories: SafetyCategory[];
  adaptable: boolean;
  /** ≤ 140 chars, neutral words. */
  suggestion: string;
  ip: string[];
  /** Neutral locators only ("chapter 3"), never quoted text. */
  spans: { where: string; category: SafetyCategory }[];
  model?: string;
  costUsd?: number;
}

export interface InputDecision {
  decision: 'allow' | 'adapt' | 'block';
  categories: SafetyCategory[];
  severity: 0 | 1 | 3;
  suggestion?: string;
}

/** decideInput (safety.md §3.1 table): classifier verdict vs the effective rating. */
export const decideInput = (v: ClassifierVerdict, rating: ContentRating): InputDecision => {
  const categories = [...new Set(v.categories)];
  if (categories.some((c) => ZERO_TOLERANCE.has(c))) return { decision: 'block', categories, severity: 3 };
  if (ratingRank(v.assessed) <= ratingRank(rating)) return { decision: 'allow', categories, severity: 0 };
  const hardNoAdapt = categories.some((c) => c === 'sexual' || c === 'dangerous');
  if (v.assessed === 'X' && (!v.adaptable || hardNoAdapt)) {
    return { decision: 'block', categories, severity: severityFor(categories) };
  }
  return { decision: 'adapt', categories, severity: 0, ...(v.suggestion ? { suggestion: v.suggestion } : {}) };
};

const CATEGORY_WORDS: Partial<Record<SafetyCategory, string>> = {
  graphic_gore: 'graphic injury',
  violence: 'violence',
  weapons: 'weapons',
  scary: 'scares',
  language: 'strong language',
  romance: 'romance',
  substances: 'drugs or alcohol',
  nudity: 'nudity',
  sexual: 'sexual content',
  self_harm: 'self-harm',
  hate: 'hateful words',
  harassment: 'harassment',
  real_person: 'real people',
  dangerous: 'real-world harm',
  minor_sexual: 'content involving minors'
};
export const categoryWords = (categories: SafetyCategory[]): string =>
  [...new Set(categories.map((c) => CATEGORY_WORDS[c] || c.replace(/_/g, ' ')))].slice(0, 3).join(', ') || 'the content rules';

/** The safe adaptation per category when no classifier suggestion exists. */
const DEFAULT_ADAPT: Partial<Record<SafetyCategory, string>> = {
  graphic_gore: 'cut away right before the impact — show shadows, reactions and the aftermath, not wounds',
  violence: 'keep the action heroic and bloodless; nobody is shown badly hurt',
  weapons: 'no weapons aimed at anyone — gadgets, freeze rays or clever tricks instead',
  language: 'keep the dialogue clean — comic grawlixes like "@#$%!" carry the anger',
  substances: 'leave out drug and alcohol use',
  nudity: 'keep everyone fully dressed',
  sexual: 'keep it to friendship or a sweet moment — nothing suggestive',
  self_harm: 'focus on getting through the dark moment, with a friend or a turning point',
  hate: 'no slurs — the villain can be nasty through what they do',
  harassment: 'no pile-on — keep it a rivalry',
  real_person: 'make an original character with the same vibe instead of a real person',
  scary: 'keep the scares short and resolve them on the same page',
  minor_sexual: 'keep everyone fully dressed and the moment innocent'
};

/** SAFETY NOTE appended to the user turn on `adapt` (the director writes the one-line change itself). */
export const buildSafetyNote = (args: { rating: ContentRating; categories: SafetyCategory[]; suggestion?: string }): string => {
  const suggestion =
    (args.suggestion || '').replace(/\s+/g, ' ').trim().slice(0, 140) ||
    args.categories.map((c) => DEFAULT_ADAPT[c]).find(Boolean) ||
    'keep it within the rating';
  return (
    `SAFETY NOTE: this request goes beyond ${args.rating} (${categoryWords(args.categories)}). Keep the creative goal; do it as: "${suggestion}". ` +
    'Say what you changed in ONE friendly sentence; offer 2–3 ask_user options that keep the spirit. No lectures.'
  );
};

/** A chat message that only swore at the tool: fine in chat, the comic's dialogue stays clean. */
export const LANGUAGE_NOTE = (rating: ContentRating) =>
  `LANGUAGE NOTE: the user's message has strong language. That's fine in chat — just keep the comic's dialogue within ${rating} (grawlixes like "@#$%!" are the comic way). Don't mention it unless they asked for that dialogue.`;

// ── Dialogue suggestions ─────────────────────────────────────────────────────

const GRAWLIX = ['@', '#', '$', '%', '&', '*', '!'];
const grawlix = (n: number) => Array.from({ length: Math.max(3, Math.min(6, n)) }, (_, i) => GRAWLIX[i % GRAWLIX.length]).join('');

/**
 * The comic way to keep strong language: swear words become grawlixes ("@#$%!"). Returns the
 * rewritten line, or undefined when nothing was replaced. Matching runs on the original text
 * (case kept), so the rest of the line is untouched.
 */
export const grawlixLine = (text: string, rating: ContentRating = 'G'): string | undefined => {
  const src = typeof text === 'string' ? text : '';
  if (!src) return undefined;
  let out = src;
  let changed = false;
  try {
    const matches = obscenity().getAllMatches(src, true);
    for (const m of [...matches].reverse()) {
      const word = String(englishDataset.getPayloadWithPhraseMetadata(m).phraseMetadata?.originalWord || '');
      const rule = OBSCENITY_RULES[word];
      if (!rule || rule.category !== 'language') continue;
      if (rule.clearAt && ratingRank(rating) >= ratingRank(rule.clearAt)) continue;
      // Extend to the whole word so "fucking" becomes one grawlix.
      let start = m.startIndex;
      let end = m.endIndex + 1;
      while (start > 0 && /\p{L}/u.test(out[start - 1])) start -= 1;
      while (end < out.length && /\p{L}/u.test(out[end])) end += 1;
      out = `${out.slice(0, start)}${grawlix(end - start)}${out.slice(end)}`;
      changed = true;
    }
  } catch {
    /* fall through to the lexicon words */
  }
  const mild = ratingRank(rating) >= ratingRank('PG') ? '' : 'damn(?:ed|it)?|dammit|goddamn|hell|crap(?:py)?|';
  const replaced = out.replace(new RegExp(`\\b(${mild}motherf\\w*|wtf|stfu)\\b`, 'gi'), (m) => {
    changed = true;
    return grawlix(m.length);
  });
  return changed ? replaced : undefined;
};

// ── Director prompt (§6.1) ───────────────────────────────────────────────────

export type RatingReason = 'little_kids' | 'kids_audience' | 'account_age' | 'chosen' | 'default';

const REASON_SUFFIX: Partial<Record<RatingReason, string>> = {
  little_kids: ' (little-kids audience)',
  kids_audience: ' (kids audience)',
  account_age: ' (your account)'
};

/** CONTENT RATING block appended to DIRECTOR_SYSTEM_PROMPT by the `safety` tool group. */
export const contentPolicyBlock = (rating: ContentRating, reason?: RatingReason, ceiling: ContentRating = PLATFORM_CEILING): string =>
  [
    `CONTENT RATING — this comic is ${rating}${(reason && REASON_SUFFIX[reason]) || ''}.`,
    RATING_RULES[rating].story,
    'Action, adventure, horror, suspense, monsters, villains and peril are welcome — write them with energy.',
    ALWAYS_RULE,
    'If a request goes past the rating: keep the user\'s creative goal, adapt it to fit, and say what you changed in ONE friendly sentence ("I kept the zombie ambush but cut away right before the bite — spooky, not gory."). Offer 2–3 ask_user options that keep the spirit. No lectures, no policy talk, never an empty reply.',
    'Trademarked characters and brands (Shin-chan, LEGO, Baahubali, Spider-Man, Doraemon…): make an original homage — new name, distinct design, same spirit — and say so once.',
    'Real people: only respectful, everyday portrayals; never sexual, humiliating or harmful.',
    `To change the rating use set_content_rating; it cannot go above ${ceiling}. If a page was flagged and the user thinks it is fine, use request_safety_review; for a tamer take use the redraw tools with safe: true.`
  ].join('\n');

// ── Deterministic redirect copy (§3.5) ───────────────────────────────────────

export interface RedirectCopy {
  text: string;
  options: { label: string; reply: string }[];
}

const SOMETHING_ELSE = { label: 'Something else', reply: "Let's try a different idea for the story." };

export const REDIRECT_COPY: Record<'graphic_gore' | 'self_harm' | 'hate' | 'real_person' | 'sexual' | 'minor_sexual' | 'dangerous' | 'generic' | 'provider', RedirectCopy> = {
  graphic_gore: {
    text: 'I can make that hit hard without the gore — a spooky-but-not-gory page where we see the shadow and the scream, not the wound.',
    options: [
      { label: 'Show the aftermath, not the wound', reply: 'Show the aftermath, not the wound.' },
      { label: 'Cut away on the impact', reply: 'Cut away right on the impact.' },
      SOMETHING_ELSE
    ]
  },
  self_harm: {
    text: "I can't show that, but I can tell a story where they get through the dark moment — with a friend, or a turning point. Want that?",
    options: [
      { label: 'A friend steps in', reply: 'A friend steps in and helps them through it.' },
      { label: 'Skip to the turning point', reply: 'Skip to the turning point where things get better.' },
      SOMETHING_ELSE
    ]
  },
  hate: {
    text: "I'll leave out the slurs and the pile-on — the villain can still be truly nasty through what they do.",
    options: [
      { label: 'Make the villain menacing', reply: 'Make the villain menacing through their actions.' },
      { label: 'Keep it a rivalry', reply: 'Keep it a fierce rivalry.' },
      SOMETHING_ELSE
    ]
  },
  real_person: {
    text: "I'll keep real people out of that — I can make an original character with the same vibe.",
    options: [{ label: 'Create an original look-alike role', reply: 'Create an original character with the same vibe.' }, SOMETHING_ELSE]
  },
  sexual: {
    text: "That one I can't make — DreamStream comics stay PG-13 with no sexual content. Want to keep going with {title}?",
    options: [
      { label: 'Continue the story', reply: "Let's continue the story." },
      { label: 'Plan the next page', reply: "Let's plan the next page." }
    ]
  },
  minor_sexual: { text: "I can't help with that.", options: [] },
  dangerous: {
    text: "I can't give real-world instructions for that. In the story, the hero can still pull it off off-panel.",
    options: [{ label: 'Keep it in the story, off-panel', reply: 'Keep it in the story and have it happen off-panel.' }, SOMETHING_ELSE]
  },
  generic: {
    text: "That one doesn't fit DreamStream's content rules — let's take {title} another way.",
    options: [{ label: 'Continue the story', reply: "Let's continue the story." }, SOMETHING_ELSE]
  },
  provider: {
    text: "That one tripped the AI's filter — I can try a toned-down version that keeps the idea.",
    options: [{ label: 'Try a gentler version', reply: 'Try a gentler version of that.' }, SOMETHING_ELSE]
  }
};

/** A caring line for first-person crisis wording (never a lecture, never a strike). */
export const CRISIS_LINE = "If you're going through something hard yourself, please talk to someone you trust or a local helpline — you matter.";

/** The redirect for a set of blocked categories (most serious first). */
export const redirectFor = (categories: SafetyCategory[]): RedirectCopy => {
  const has = (c: SafetyCategory) => categories.includes(c);
  if (has('minor_sexual')) return REDIRECT_COPY.minor_sexual;
  if (has('real_person') && has('sexual')) return REDIRECT_COPY.sexual;
  if (has('sexual') || has('nudity')) return REDIRECT_COPY.sexual;
  if (has('dangerous')) return REDIRECT_COPY.dangerous;
  if (has('self_harm')) return REDIRECT_COPY.self_harm;
  if (has('hate') || has('harassment')) return REDIRECT_COPY.hate;
  if (has('real_person')) return REDIRECT_COPY.real_person;
  if (has('graphic_gore')) return REDIRECT_COPY.graphic_gore;
  return REDIRECT_COPY.generic;
};

export const fillTitle = (text: string, title?: string): string => {
  const t = (title || '').replace(/[\r\n]+/g, ' ').trim().slice(0, 80);
  return text.replace('{title}', t ? `“${t}”` : 'your comic');
};

// ── Ratings for the UI and the director ──────────────────────────────────────

/** "Kids audience → up to PG" for a reason code. */
export const ceilingReasonText = (reason: RatingReason | undefined, rating: ContentRating): string | undefined => {
  if (reason === 'little_kids') return `Little-kids audience → up to ${rating}`;
  if (reason === 'kids_audience') return `Kids audience → up to ${rating}`;
  if (reason === 'account_age') return `Your account → up to ${rating}`;
  return undefined;
};

export const ratingBlurb = (rating: ContentRating): string => RATING_LABEL[rating].blurb;
