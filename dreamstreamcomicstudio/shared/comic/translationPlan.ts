// Software-first translation work plan (contract §11.4, i18n.md §4.1 / §8.2 / §8.4). Owner: P1-I18N.
//
// Every line a language needs is resolved by the FIRST path that applies; paths 1–7 cost $0:
//   1 up to date       entry.sourceHash === lineSourceHash(line)                → skipped (upToDate)
//   2 human-edited     status 'edited' and the source changed                    → never overwritten (skippedEdited)
//                      (a punctuation-only change still refreshes its hash for free, path 7)
//   3 noTranslate      the source text is copied                                 → freeLines 'no_translate'
//   4 punctuation      "…", "?!", "!!", "42" (full-width for ja/zh, ؟ for ar/ur)  → freeLines 'punctuation'
//   5 glossary-only    "MILO!" → the glossary form + localized punctuation        → freeLines 'glossary_only'
//   6 duplicate        the same lineSourceHash is already translated here        → freeLines 'duplicate'
//                      (a duplicate inside this plan waits for its twin: `deferred`)
//   7 loose match      only case/punctuation/spacing of the source changed       → freeLines 'loose_match'
//   8 everything else  the translator (writer-class model), then the linguist review (always)
//
// The token estimate is deterministic (§8.4); the server turns it into USD with the resolved route's
// price list. Nothing here calls a model, reads the clock for logic, or touches the network.

import type { ComicDoc, EditionTextField, GlossaryTerm, Line, Page, TextTranslation } from './doc.js';
import type { DocOp } from './ops.js';
import { i18nOf, lineSourceHash, looseSourceHash, normalizeSource, textSourceHash } from './i18n.js';
import { languageSpec, sameLanguage, scriptOf } from './languages.js';
import { LETTER_METRICS } from './lettering/style.js';
import { DOC_LIMITS } from './limits.js';
import { estimateWidthForText, graphemes } from './textLayout.js';

export interface TranslationPlan {
  lang: string;
  toTranslate: { pageId: string; lineIds: string[] }[];
  freeLines: { lineId: string; text: string; reason: 'duplicate' | 'punctuation' | 'glossary_only' | 'no_translate' | 'loose_match' }[];
  upToDate: number; skippedEdited: number;
  coverTexts: EditionTextField[];
  calls: number;
  tokens: { input: number; output: number; reviewInput: number; reviewOutput: number };
  /** Lines with the same source as a line in `toTranslate` (copied for free once it is translated). */
  deferred?: { lineId: string; sameAs: string }[];
  /** Current machine translations still waiting for the linguist (a review that did not run). Review tokens only. */
  toReview?: string[];
  /** Linguist calls (≤ REVIEW_CHUNK_LINES lines each). */
  reviewCalls?: number;
}

/** One translator call carries ≤ 40 lines or ≤ 3 pages (whichever comes first), split on page boundaries. */
export const TRANSLATE_CHUNK_LINES = 40;
export const TRANSLATE_CHUNK_PAGES = 3;
/** One linguist call reviews ≤ 60 lines. */
export const REVIEW_CHUNK_LINES = 60;
/** Prefix of the issue note left when the review replaced a translation (its `suggestion` is the original). */
export const AUTO_CORRECTED_NOTE = 'Auto-corrected by review';

const EDITION_FIELDS: readonly EditionTextField[] = ['brief.title', 'brief.logline', 'cover.title', 'cover.tagline'];

const emptyPlan = (lang: string): TranslationPlan => ({
  lang,
  toTranslate: [],
  freeLines: [],
  upToDate: 0,
  skippedEdited: 0,
  coverTexts: [],
  calls: 0,
  tokens: { input: 0, output: 0, reviewInput: 0, reviewOutput: 0 },
  deferred: [],
  toReview: [],
  reviewCalls: 0
});

// ── Small helpers ────────────────────────────────────────────────────────────

const sortedPages = (doc: ComicDoc): Page[] => [...doc.pages].sort((a, b) => a.n - b.n);

/** Every line of the doc with its page (reading order). */
export const linesInOrder = (doc: ComicDoc): { page: Page; line: Line }[] =>
  sortedPages(doc).flatMap((page) => [...page.panels].sort((a, b) => a.n - b.n).flatMap((panel) => panel.lines.map((line) => ({ page, line }))));

/** The source text of a cover/brief edition field ('' when empty). */
export const editionTextSource = (doc: ComicDoc, field: EditionTextField): string => {
  switch (field) {
    case 'brief.title':
      return normalizeSource(doc.brief?.title || '');
    case 'brief.logline':
      return normalizeSource(doc.brief?.logline || '');
    case 'cover.title':
      return normalizeSource(doc.cover?.title || '');
    case 'cover.tagline':
      return normalizeSource(doc.cover?.tagline || '');
    default:
      return '';
  }
};

/** The stored translation of a cover/brief field. */
export const editionTextEntry = (doc: ComicDoc, lang: string, field: EditionTextField): TextTranslation | undefined => {
  const e = i18nOf(doc).editions[lang];
  if (!e) return undefined;
  const [group, key] = field.split('.') as ['cover' | 'brief', string];
  return (e[group] as Record<string, TextTranslation> | undefined)?.[key];
};

const PUNCT_ONLY = /^[\p{P}\p{S}\p{N}\s]+$/u;
const LETTERS = /[\p{L}\p{M}\p{N}]/u;
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const isCjk = (lang: string) => {
  const s = scriptOf(lang).id;
  return s === 'Jpan' || s === 'Hans';
};
const isArabicScript = (lang: string) => {
  const s = scriptOf(lang).id;
  return s === 'Arab' || s === 'Aran';
};

/** Localize ASCII punctuation for a target language (full-width for ja/zh, ؟ ، for ar/ur). Letters are untouched. */
export const localizePunctuation = (text: string, lang: string): string => {
  let t = text.replace(/\.\.\./g, '…');
  if (isCjk(lang)) {
    const comma = scriptOf(lang).id === 'Jpan' ? '、' : '，';
    t = t.replace(/\?/g, '？').replace(/!/g, '！').replace(/,/g, comma).replace(/:/g, '：').replace(/;/g, '；');
  } else if (isArabicScript(lang)) {
    t = t.replace(/\?/g, '؟').replace(/,/g, '،');
  }
  return t;
};

const QUESTION = /[?？؟]$/u;
const EXCLAIM = /[!！]$/u;
const trailingMark = (text: string): '?' | '!' | '' => (QUESTION.test(text.trim()) ? '?' : EXCLAIM.test(text.trim()) ? '!' : '');

/** Make a translation end like its source (question ↔ exclamation) — the loose carry-over (§8.2 #7). */
export const carryTrailingMark = (translation: string, oldSource: string, newSource: string, lang: string): string => {
  const before = trailingMark(oldSource);
  const after = trailingMark(newSource);
  if (before === after) return translation;
  const base = translation.replace(/[\s?？؟!！.。।۔]+$/u, '');
  if (!after) return translation.replace(/[\s?？؟!！]+$/u, '') || translation;
  return `${base}${localizePunctuation(after, lang)}`;
};

const TRAILS = ['', '.', '!', '?', '!!', '?!', '!?', '??', '!!!', '...', '…', '?!?', '. . .'];
const caseVariants = (core: string): string[] => {
  const lower = core.toLowerCase();
  const upper = core.toUpperCase();
  const sentence = lower ? `${lower.charAt(0).toUpperCase()}${lower.slice(1)}` : lower;
  return [...new Set([core, lower, upper, sentence])];
};

/**
 * The old source text a stored hash was made from, when it differs from the current line only in case,
 * spacing or trailing punctuation (bounded search: ≤ 52 hashes). Undefined otherwise.
 */
export const looseOldSource = (line: Line, storedHash: string): string | undefined => {
  const text = normalizeSource(line.text);
  if (!text || !storedHash) return undefined;
  const core = text.replace(/[\s\p{P}\p{S}]+$/u, '');
  if (!core) return undefined;
  const loose = looseSourceHash(text);
  for (const c of caseVariants(core)) {
    for (const trail of TRAILS) {
      const candidate = `${c}${trail}`;
      if (candidate === text) continue;
      if (looseSourceHash(candidate) !== loose) continue;
      if (lineSourceHash({ ...line, text: candidate }) === storedHash) return candidate;
    }
  }
  return undefined;
};

/** The glossary term a whole line consists of ("MILO!" → Milo), if any. */
const glossaryOnlyTerm = (doc: ComicDoc, text: string): GlossaryTerm | undefined => {
  const core = text.replace(/[\s\p{P}\p{S}]+/gu, ' ').trim().toLowerCase();
  if (!core || !LETTERS.test(core)) return undefined;
  return i18nOf(doc).glossary.find((t) => t.term.replace(/[\s\p{P}\p{S}]+/gu, ' ').trim().toLowerCase() === core);
};

/** The glossary form of a term for a language ('keep' ⇒ the term itself). */
export const glossaryForm = (term: GlossaryTerm, lang: string): string | undefined =>
  term.policy === 'keep' ? term.term : term.forms[lang] || undefined;

// ── Token estimate (§8.4) ────────────────────────────────────────────────────

/** Source tokens of one text: ceil(graphemes / 4), × the source language's tokenFactor for non-Latin sources. */
export const sourceTokens = (text: string, sourceLang: string): number => {
  const n = graphemes(normalizeSource(text), sourceLang).length;
  if (!n) return 0;
  const spec = languageSpec(sourceLang);
  const factor = spec && spec.script !== 'Latn' ? spec.tokenFactor : 1;
  return Math.ceil((n / 4) * factor);
};

const round = (n: number) => Math.round(n);

/** Chunk the page groups of a plan: ≤ TRANSLATE_CHUNK_LINES lines or ≤ TRANSLATE_CHUNK_PAGES pages per call. */
export const chunkTranslation = (toTranslate: TranslationPlan['toTranslate']): { pageId: string; lineIds: string[] }[][] => {
  const chunks: { pageId: string; lineIds: string[] }[][] = [];
  let current: { pageId: string; lineIds: string[] }[] = [];
  let lines = 0;
  const flush = () => {
    if (current.length) chunks.push(current);
    current = [];
    lines = 0;
  };
  for (const group of toTranslate) {
    let ids = group.lineIds.slice();
    while (ids.length) {
      if (current.length >= TRANSLATE_CHUNK_PAGES || lines >= TRANSLATE_CHUNK_LINES) flush();
      // Keep a page whole when it fits in a fresh chunk; split only pages longer than one chunk.
      if (lines > 0 && lines + ids.length > TRANSLATE_CHUNK_LINES && ids.length <= TRANSLATE_CHUNK_LINES) flush();
      const room = TRANSLATE_CHUNK_LINES - lines;
      const take = ids.slice(0, room);
      ids = ids.slice(room);
      current.push({ pageId: group.pageId, lineIds: take });
      lines += take.length;
    }
  }
  flush();
  return chunks;
};

interface TokenInput {
  doc: ComicDoc;
  lang: string;
  /** Source texts per translator chunk (cover texts ride in the first chunk). */
  chunks: string[][];
  /** Every text the linguist reviews. */
  review: string[];
}

/**
 * Expected share of translator chunks that need their one repair round (i18n.md §8.6) — an estimate, like
 * tokenFactor. A repair is a second call that re-sends the conversation (system + user + the first answer)
 * with the problems, and answers only the failing lines, so its expected cost is folded into every chunk.
 * The server's per-language calibration (§8.4) then corrects the whole quote with what finished runs billed.
 */
export const REPAIR_SHARE = 0.3;
/** A repair answers only the failing lines: about this share of the chunk's first answer. */
const REPAIR_OUTPUT_SHARE = 0.15;

/**
 * Deterministic token estimate (i18n.md §8.4), including each chunk's expected repair round. Monotonic in
 * lines and in the target's tokenFactor.
 */
export const estimateTranslationTokens = ({ doc, lang, chunks, review }: TokenInput): TranslationPlan['tokens'] & { reviewCalls: number } => {
  const tf = languageSpec(lang)?.tokenFactor ?? 1.5;
  const source = doc.format.language;
  const fixed = 1450 + 120 + 45 * doc.cast.length + 10 * i18nOf(doc).glossary.length + 60 * doc.pages.length;
  let input = 0;
  let output = 0;
  for (const chunk of chunks) {
    if (!chunk.length) continue;
    let chunkInput = fixed;
    let out = 80;
    for (const text of chunk) {
      const t = sourceTokens(text, source);
      chunkInput += t + 22;
      out += t * tf + 16;
    }
    const chunkOutput = out * 1.15; // bounded reasoning effort
    input += chunkInput + REPAIR_SHARE * (chunkInput + chunkOutput);
    output += chunkOutput * (1 + REPAIR_SHARE * REPAIR_OUTPUT_SHARE);
  }
  const reviewCalls = review.length ? Math.ceil(review.length / REVIEW_CHUNK_LINES) : 0;
  let reviewInput = 900 * reviewCalls;
  let reviewOutput = 0;
  for (const text of review) {
    const t = sourceTokens(text, source);
    reviewInput += t + t * tf + 30;
    reviewOutput += 24 + t * tf * 0.4;
  }
  return { input: round(input), output: round(output), reviewInput: round(reviewInput), reviewOutput: round(reviewOutput), reviewCalls };
};

/** Rank of a stored translation as a duplicate source (lower is better). */
const twinRank = (e: TextTranslation): number => (e.issue?.severity === 'major' ? 4 : 0) + (e.issue ? 1 : 0) + (e.status === 'machine' ? 2 : 0);

/** The best CURRENT translation per source hash in an edition (what a duplicate line copies, path 6). */
export const bestTwins = (doc: ComicDoc, lang: string): Map<string, TextTranslation> => {
  const entries = i18nOf(doc).editions[lang]?.lines ?? {};
  const out = new Map<string, TextTranslation>();
  for (const { line } of linesInOrder(doc)) {
    const e = entries[line.id];
    if (!e) continue;
    const h = lineSourceHash(line);
    if (e.sourceHash !== h) continue;
    const prev = out.get(h);
    if (!prev || twinRank(e) < twinRank(prev)) out.set(h, e);
  }
  return out;
};

// ── The plan ─────────────────────────────────────────────────────────────────

/** Software-first plan (i18n.md §8.2 paths 1–7 are $0); deterministic token estimate (§8.4). */
export function planTranslation(doc: ComicDoc, lang: string, opts?: { pageIds?: string[]; force?: boolean; overwriteEdits?: boolean }): TranslationPlan {
  const spec = languageSpec(lang);
  if (!spec || spec.code !== lang || sameLanguage(lang, doc.format.language)) return emptyPlan(lang);
  const plan = emptyPlan(lang);
  const force = opts?.force === true;
  const overwrite = opts?.overwriteEdits === true;
  const scope = opts?.pageIds?.length ? new Set(opts.pageIds) : null;
  const edition = i18nOf(doc).editions[lang];
  const entries = edition?.lines ?? {};

  // Current translations in this edition by source hash (duplicates, path 6).
  const byHash = force ? new Map<string, TextTranslation>() : bestTwins(doc, lang);
  // First line of each source hash queued for the translator in THIS plan (in-plan duplicates wait).
  const queued = new Map<string, string>();
  const groups = new Map<string, string[]>();
  const pageOrder: string[] = [];
  const queue = (pageId: string, lineId: string) => {
    if (!groups.has(pageId)) {
      groups.set(pageId, []);
      pageOrder.push(pageId);
    }
    groups.get(pageId)!.push(lineId);
  };

  for (const { page, line } of linesInOrder(doc)) {
    if (scope && !scope.has(page.id)) continue;
    const text = normalizeSource(line.text);
    if (!text) continue;
    const hash = lineSourceHash(line);
    const entry = entries[line.id];
    const current = !!entry && entry.sourceHash === hash;
    // 1 · up to date
    if (current && !force) {
      plan.upToDate += 1;
      // The same rule as editionProgress.unreviewed: a line flagged MAJOR was judged and waits for the author.
      if (entry.status === 'machine' && entry.issue?.severity !== 'major') plan.toReview!.push(line.id);
      continue;
    }
    // 7 (edited) · a punctuation-only source change keeps the author's text, refreshing only its hash.
    if (entry && !current && entry.status === 'edited' && !overwrite) {
      if (looseOldSource(line, entry.sourceHash) !== undefined) plan.freeLines.push({ lineId: line.id, text: entry.text, reason: 'loose_match' });
      else plan.skippedEdited += 1;
      continue;
    }
    // 2 · human-edited (forced re-translation without overwriteEdits)
    if (entry && entry.status === 'edited' && !overwrite) {
      plan.skippedEdited += 1;
      continue;
    }
    // 3 · noTranslate
    if (line.noTranslate) {
      plan.freeLines.push({ lineId: line.id, text: line.text, reason: 'no_translate' });
      continue;
    }
    // 4 · punctuation / numbers only
    if (PUNCT_ONLY.test(text)) {
      plan.freeLines.push({ lineId: line.id, text: localizePunctuation(text, lang), reason: 'punctuation' });
      continue;
    }
    // 5 · glossary-only line ("MILO!")
    const term = glossaryOnlyTerm(doc, text);
    const form = term && glossaryForm(term, lang);
    if (term && form) {
      const replaced = text.replace(new RegExp(escapeRe(term.term), 'iu'), form);
      plan.freeLines.push({ lineId: line.id, text: localizePunctuation(replaced === text ? form : replaced, lang), reason: 'glossary_only' });
      continue;
    }
    // 6 · duplicate already translated in this edition
    const twin = byHash.get(hash);
    if (twin) {
      plan.freeLines.push({ lineId: line.id, text: twin.text, reason: 'duplicate' });
      continue;
    }
    // 7 · loose match (only case / punctuation / spacing changed)
    if (entry && !current && !force) {
      const old = looseOldSource(line, entry.sourceHash);
      if (old !== undefined) {
        plan.freeLines.push({ lineId: line.id, text: carryTrailingMark(entry.text, old, text, lang), reason: 'loose_match' });
        continue;
      }
    }
    // in-plan duplicate: copied for free after its twin is translated
    const first = queued.get(hash);
    if (first) {
      plan.deferred!.push({ lineId: line.id, sameAs: first });
      continue;
    }
    queued.set(hash, line.id);
    // 8 · the translator
    queue(page.id, line.id);
  }
  plan.toTranslate = pageOrder.map((pageId) => ({ pageId, lineIds: groups.get(pageId)! }));

  // Cover and brief texts (whole-comic runs only).
  if (!scope) {
    const seen = new Set<string>();
    for (const field of EDITION_FIELDS) {
      const source = editionTextSource(doc, field);
      if (!source) continue;
      const entry = editionTextEntry(doc, lang, field);
      const current = !!entry && entry.sourceHash === textSourceHash(source);
      if (current && !force) continue;
      if (entry?.status === 'edited' && !overwrite) continue;
      // cover.title usually repeats brief.title: one translation serves both (the run copies it).
      const key = source.toLowerCase();
      if (seen.has(key) && field.startsWith('cover.')) {
        plan.coverTexts.push(field);
        continue;
      }
      seen.add(key);
      plan.coverTexts.push(field);
    }
  }

  // Token estimate.
  const lineById = new Map(linesInOrder(doc).map(({ line }) => [line.id, line] as const));
  const chunkTexts = chunkTranslation(plan.toTranslate).map((chunk) => chunk.flatMap((g) => g.lineIds.map((id) => lineById.get(id)?.text || '')));
  const coverSources = [...new Set(plan.coverTexts.map((f) => editionTextSource(doc, f)))];
  if (coverSources.length) {
    if (chunkTexts.length) chunkTexts[0] = [...chunkTexts[0], ...coverSources];
    else chunkTexts.push(coverSources);
  }
  const reviewTexts = [...chunkTexts.flat(), ...plan.toReview!.map((id) => lineById.get(id)?.text || '')];
  const tokens = estimateTranslationTokens({ doc, lang, chunks: chunkTexts, review: reviewTexts });
  plan.calls = chunkTexts.filter((c) => c.length).length;
  plan.reviewCalls = tokens.reviewCalls;
  plan.tokens = { input: tokens.input, output: tokens.output, reviewInput: tokens.reviewInput, reviewOutput: tokens.reviewOutput };
  return plan;
}

/** Nothing for the translator or the linguist (only free work, or nothing at all). */
export const planIsFree = (plan: TranslationPlan): boolean => plan.calls === 0 && !(plan.toReview?.length);
/** Lines the translator will write (excluding in-plan duplicates). */
export const planLineCount = (plan: TranslationPlan): number => plan.toTranslate.reduce((n, g) => n + g.lineIds.length, 0);

/** Ops for the free paths (copy/duplicate/loose carry-over) — committed before any LLM call. */
export function freeTranslationOps(doc: ComicDoc, plan: TranslationPlan, now = Date.now()): DocOp[] {
  if (!plan.freeLines.length) return [];
  const lang = plan.lang;
  const edition = i18nOf(doc).editions[lang];
  const lineById = new Map(linesInOrder(doc).map(({ line }) => [line.id, line] as const));
  const ops: DocOp[] = [];
  if (!edition) {
    if (Object.keys(i18nOf(doc).editions).length >= DOC_LIMITS.editions) return [];
    ops.push({ op: 'edition', lang, patch: {} });
  }
  const twins = bestTwins(doc, lang);
  const lines: Record<string, TextTranslation> = {};
  for (const f of plan.freeLines) {
    const line = lineById.get(f.lineId);
    if (!line || typeof f.text !== 'string' || !f.text) continue;
    const sourceHash = lineSourceHash(line);
    const prev = edition?.lines[f.lineId];
    if (f.reason === 'loose_match' && prev) {
      lines[f.lineId] = { ...prev, text: f.text, sourceHash, at: now };
      continue;
    }
    if (f.reason === 'duplicate') {
      const twin = twins.get(sourceHash);
      const t: TextTranslation = { text: f.text, status: twin && twin.status !== 'machine' ? 'reviewed' : 'machine', sourceHash, at: now };
      if (twin?.gloss) t.gloss = twin.gloss;
      if (twin?.model) t.model = twin.model;
      // A flagged twin passes its flag on: the copy is exactly as (un)reviewed as the original.
      if (twin?.issue) t.issue = { ...twin.issue };
      lines[f.lineId] = t;
      continue;
    }
    // no_translate / punctuation / glossary_only: deterministic software copies, nothing left to review.
    lines[f.lineId] = { text: f.text, status: 'reviewed', sourceHash, at: now };
  }
  if (!Object.keys(lines).length) return [];
  ops.push({ op: 'translations', lang, lines });
  return ops;
}

// ── Length budget (§4.1) ─────────────────────────────────────────────────────

const PAD_W = 2 * LETTER_METRICS.padX;

/** Grapheme maxChars hint for the translator (§4.1): the balloon may grow ≤ 25 % wider and ~30 % taller. */
export function translationBudget(doc: ComicDoc, page: Page, line: Line, lang: string): number {
  const sourceLang = doc.format.language;
  const n = graphemes(normalizeSource(line.text || ''), sourceLang).length;
  if (line.kind === 'sfx') return Math.max(4, Math.ceil(n * 1.3));
  const balloon = page.balloons.find((b) => b.lineId === line.id);
  const w = balloon && balloon.w > 0 ? balloon.w : estimateWidthForText(line.text || '', sourceLang);
  const x = balloon ? Math.max(0, Math.min(1, balloon.x)) : 0;
  const pinned = !!balloon?.pinned;
  const wEff = pinned ? w : Math.min(Math.max(w, 1 - x), Math.max(w * 1.25, w + 0.04));
  const src = scriptOf(sourceLang);
  const tgt = scriptOf(lang);
  const perLineSrc = Math.max(1, Math.floor((w - PAD_W) / (LETTER_METRICS.charW * src.widthFactor)));
  const perLineTgt = Math.max(1, Math.floor((wEff - PAD_W) / (LETTER_METRICS.charW * tgt.widthFactor)));
  const srcLines = Math.max(1, Math.ceil(n / perLineSrc));
  const lines = Math.max(srcLines, Math.ceil(srcLines * (pinned ? 1 : 1.3)));
  return Math.max(6, perLineTgt * lines);
}

// ── Glossary ─────────────────────────────────────────────────────────────────

const GLOSSARY_TERM_CHARS = 80;
const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n) : s);
/** Glossary ids are derived from what they name, so seeding is idempotent. */
export const glossaryIdFor = (kind: 'character' | 'place' | 'title', refId?: string): string =>
  kind === 'title' ? 'gl_title' : `gl_${kind === 'character' ? 'c' : 'p'}_${String(refId || '').slice(0, 60)}`;

/** Non-person cast and "The Baby"-style names are translated as words; people's names are transliterated. */
const castPolicy = (name: string, kind: string | undefined): GlossaryTerm['policy'] =>
  (kind && kind !== 'person') || /^(the|a|an|mr|mrs|ms|miss|dr|uncle|aunt|grandma|grandpa|mom|mum|dad|papa|mama|baby)\b/i.test(name.trim()) ? 'translate' : 'transliterate';

/** Idempotent glossary seed from cast/places/title: ops for new or renamed terms only. */
export function syncGlossaryOps(doc: ComicDoc): DocOp[] {
  const glossary = i18nOf(doc).glossary;
  const byId = new Map(glossary.map((t) => [t.id, t] as const));
  const ops: DocOp[] = [];
  let count = glossary.length;
  const want: { id: string; term: string; kind: GlossaryTerm['kind']; refId?: string; policy: GlossaryTerm['policy'] }[] = [];
  for (const c of doc.cast) {
    const name = clip(normalizeSource(c.name || ''), GLOSSARY_TERM_CHARS);
    if (name) want.push({ id: glossaryIdFor('character', c.id), term: name, kind: 'character', refId: c.id, policy: castPolicy(name, c.kind) });
  }
  for (const p of doc.places) {
    const name = clip(normalizeSource(p.name || ''), GLOSSARY_TERM_CHARS);
    if (name) want.push({ id: glossaryIdFor('place', p.id), term: name, kind: 'place', refId: p.id, policy: 'translate' });
  }
  const title = clip(normalizeSource(doc.brief?.title || ''), GLOSSARY_TERM_CHARS);
  if (title) want.push({ id: glossaryIdFor('title'), term: title, kind: 'title', policy: 'translate' });
  for (const w of want) {
    const cur = byId.get(w.id);
    if (!cur) {
      if (count >= DOC_LIMITS.glossaryTerms) continue;
      count += 1;
      ops.push({ op: 'glossary_term', id: w.id, patch: { term: w.term, kind: w.kind, policy: w.policy, ...(w.refId ? { refId: w.refId } : {}) } });
      continue;
    }
    if (cur.term !== w.term) {
      // Renamed in the source: the old target forms name someone else now.
      const cleared = Object.fromEntries(Object.keys(cur.forms).map((k) => [k, null])) as unknown as Record<string, string>;
      ops.push({ op: 'glossary_term', id: w.id, patch: { term: w.term, ...(Object.keys(cleared).length ? { forms: cleared } : {}) } });
    }
  }
  return ops;
}

/** Whole-token replace (never inside a longer word). */
export const replaceWholeToken = (text: string, from: string, to: string): string => {
  if (!from || !text.includes(from)) return text;
  const re = new RegExp(`(?<![\\p{L}\\p{M}\\p{N}])${escapeRe(from)}(?![\\p{L}\\p{M}\\p{N}])`, 'gu');
  return text.replace(re, to);
};

/** Whole-token rename of a target form across an edition, $0 (lines + cover/brief texts + the term's form). */
export function glossaryRenameOps(doc: ComicDoc, lang: string, termId: string, from: string, to: string): DocOp[] {
  const i18n = i18nOf(doc);
  const edition = i18n.editions[lang];
  const ops: DocOp[] = [];
  const src = typeof from === 'string' ? from.trim() : '';
  const dst = typeof to === 'string' ? clip(to.trim(), GLOSSARY_TERM_CHARS) : '';
  const term = i18n.glossary.find((t) => t.id === termId);
  if (term && dst && term.forms[lang] !== dst) ops.push({ op: 'glossary_term', id: termId, patch: { forms: { [lang]: dst } } });
  if (!edition || !src || !dst || src === dst) return ops;
  for (const [lineId, t] of Object.entries(edition.lines)) {
    const next = replaceWholeToken(t.text, src, dst);
    if (next !== t.text) ops.push({ op: 'translation', lang, lineId, patch: { text: next } });
  }
  for (const field of EDITION_FIELDS) {
    const t = editionTextEntry(doc, lang, field);
    if (!t) continue;
    const next = replaceWholeToken(t.text, src, dst);
    if (next !== t.text) ops.push({ op: 'edition_text', lang, field, value: { ...t, text: next } });
  }
  return ops;
}
