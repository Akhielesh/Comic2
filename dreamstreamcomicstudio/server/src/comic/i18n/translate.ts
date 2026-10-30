// Translator calls, validation and repair (i18n.md §8.3 / §8.5 / §8.6). Owner: P1-I18N.
//
// One call per chunk (≤ 40 lines or ≤ 3 pages). Software validates every line before anything is
// committed — ids, script (≥ 60 % of letters in the target script; 40 % code-mixed), not left in the
// source language, glossary forms used, the $0 safety pre-filter — and asks the model ONCE to repair
// the problem lines. Whatever still fails is committed with a visible `major` issue (never dropped
// silently); a line that is missing or unsafe is not committed at all and stays honest "missing".

import type { ComicDoc, EditionTextField, Page, TextTranslation, TranslationRegister } from '../../../../shared/comic/doc.js';
import { i18nOf, lineSourceHash, normalizeSource, textSourceHash } from '../../../../shared/comic/i18n.js';
import { languageSpec, scriptOf, sameLanguage } from '../../../../shared/comic/languages.js';
import type { DocOp } from '../../../../shared/comic/ops.js';
import type { ContentRating } from '../../../../shared/comic/safety.js';
import { DOC_LIMITS } from '../../../../shared/comic/limits.js';
import { hashString } from '../../../../shared/comic/hash.js';
import { graphemes } from '../../../../shared/comic/textLayout.js';
import { editionTextEntry, editionTextSource, glossaryForm, translationBudget } from '../../../../shared/comic/translationPlan.js';
import type { ChatMessage } from '../../ai/providers/types.js';
import { prefilterText } from '../safety/index.js';
import { StudioError, type LlmClient, type LlmResult } from '../types.js';
import { parseJsonText } from '../writer.js';
import { repairMessage, TRANSLATION_SCHEMA, translatorSystemPrompt, translatorUserMessage, type TranslatorItem } from './prompts.js';

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

export interface TranslatorOutput {
  lines: { id: string; text: string; fits: boolean }[];
  glossary: { term: string; form: string }[];
  notes: string;
}

/** Tolerant reader of the translator's JSON (strict schema on the wire; never trust it blindly). */
export function readTranslatorOutput(raw: unknown): TranslatorOutput | undefined {
  if (!isObj(raw)) return undefined;
  const lines = Array.isArray(raw.lines)
    ? raw.lines
        .filter(isObj)
        .filter((l) => typeof l.id === 'string' && typeof l.text === 'string')
        .map((l) => ({ id: l.id as string, text: (l.text as string).slice(0, DOC_LIMITS.translationChars * 2), fits: l.fits !== false }))
    : [];
  const glossary = Array.isArray(raw.glossary)
    ? raw.glossary
        .filter(isObj)
        .filter((g) => typeof g.term === 'string' && typeof g.form === 'string')
        .map((g) => ({ term: normalizeSource(g.term as string).slice(0, 80), form: normalizeSource(g.form as string).slice(0, 80) }))
        .filter((g) => g.term && g.form)
        .slice(0, 60)
    : [];
  return { lines, glossary, notes: typeof raw.notes === 'string' ? raw.notes.slice(0, 1000) : '' };
}

export const outputOf = (result: LlmResult): unknown =>
  result.json !== undefined && result.json !== null && typeof result.json === 'object' ? result.json : parseJsonText(result.text || '');

// ── Validation (§8.6) ────────────────────────────────────────────────────────

/** Share of letters (\p{L}) written in the target script, excluding `keep` terms. 1 when there are < 2 letters. */
export function scriptShare(text: string, lang: string, keep: string[] = []): number {
  let t = text;
  for (const k of keep) if (k) t = t.split(k).join(' ');
  const letters = t.match(/\p{L}/gu) || [];
  if (letters.length < 2) return 1;
  const re = scriptOf(lang).letters;
  const hits = letters.filter((ch) => re.test(ch)).length;
  return hits / letters.length;
}

export type LineProblem = 'missing' | 'empty' | 'script' | 'untranslated' | 'glossary' | 'unsafe';

export interface CheckItem {
  id: string;
  source: string;
  maxChars: number;
  /** Target forms the translation must contain (glossary terms present in the source). */
  forms: string[];
  /** Glossary 'keep' terms (excluded from the script check). */
  keep: string[];
}

export interface CheckResult {
  problem?: LineProblem;
  message?: string;
  tooLong: boolean;
  /** The safety pre-filter is unsure at this rating (committed with a major issue for the author). */
  ambiguous: boolean;
}

/** Validate one translated line (software, before commit). */
export function checkLine(lang: string, register: TranslationRegister, item: CheckItem, text: string | undefined, rating: ContentRating, sourceLang: string): CheckResult {
  const out: CheckResult = { tooLong: false, ambiguous: false };
  if (text === undefined) return { ...out, problem: 'missing', message: `line ${item.id} is missing` };
  const t = normalizeSource(text);
  if (!t) return { ...out, problem: 'empty', message: `line ${item.id} is empty` };
  const target = scriptOf(lang);
  const threshold = register === 'code_mixed' ? 0.4 : 0.6;
  if (scriptShare(t, lang, item.keep) < threshold) {
    return { ...out, problem: 'script', message: `line ${item.id} is not written in ${languageSpec(lang)?.english || lang} (${target.id} script)` };
  }
  const sameScript = scriptOf(sourceLang).id === target.id;
  const lettersIn = /[\p{L}]/u.test(t);
  if (!sameScript && lettersIn && t.toLowerCase() === normalizeSource(item.source).toLowerCase()) {
    return { ...out, problem: 'untranslated', message: `line ${item.id} is still in the source language` };
  }
  const missing = item.forms.filter((f) => f && !t.includes(f));
  if (missing.length) return { ...out, problem: 'glossary', message: `line ${item.id} must use the glossary form ${missing.map((f) => `"${f}"`).join(', ')}` };
  const safety = prefilterText(t, rating);
  if (safety.decision === 'block') return { ...out, problem: 'unsafe', message: `line ${item.id} uses wording that doesn't fit this comic's ${rating} rating — say it more gently` };
  out.ambiguous = safety.decision === 'ambiguous';
  out.tooLong = graphemes(t, lang).length > item.maxChars * 1.2;
  return out;
}

const PROBLEM_NOTES: Record<LineProblem, string> = {
  missing: 'The translator did not return this line.',
  empty: 'The translator returned an empty line.',
  script: 'This line is not fully in the target script — please check it.',
  untranslated: 'This line was left in the source language.',
  glossary: "This line doesn't use the glossary name — please check it.",
  unsafe: "The translation didn't pass the content check."
};

const SOFTWARE_NOTES: ReadonlySet<string> = new Set([...Object.values(PROBLEM_NOTES), 'The content check is unsure about this wording — please read it before publishing.']);
/** An issue software found (script, glossary, untranslated, content check): a reviewer's "ok" never clears it. */
export const isSoftwareIssue = (issue?: TextTranslation['issue']): boolean => !!issue && issue.severity === 'major' && SOFTWARE_NOTES.has(issue.note);

// ── One chunk ────────────────────────────────────────────────────────────────

export interface ChunkRequest {
  doc: ComicDoc;
  lang: string;
  pages: { page: Page; lineIds: Set<string> }[];
  /** Cover/brief texts (ids are EditionTextField names). */
  extras: TranslatorItem[];
  rating: ContentRating;
  signal?: AbortSignal;
}

export interface ChunkLineResult {
  text: string;
  /** Committed with an open issue for the author. */
  issue?: TextTranslation['issue'];
  tooLong: boolean;
  /** The doc's source hash of the line at request time. */
  sourceHash: string;
}

export interface ChunkResult {
  lines: Record<string, ChunkLineResult>;
  extras: Partial<Record<EditionTextField, ChunkLineResult>>;
  glossary: { term: string; form: string }[];
  /** Ids not committed (missing/empty/unsafe after the repair round). */
  failed: string[];
  unsafe: string[];
  model?: string;
  calls: number;
  completionTokens: number;
  repaired: boolean;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Glossary forms required for a source text in a language, and the 'keep' terms. */
export function glossaryNeeds(doc: ComicDoc, lang: string, source: string): { forms: string[]; keep: string[] } {
  const forms: string[] = [];
  const keep: string[] = [];
  for (const term of i18nOf(doc).glossary) {
    if (!term.term) continue;
    const re = new RegExp(`(?<![\\p{L}\\p{M}\\p{N}])${escapeRe(term.term)}(?![\\p{L}\\p{M}\\p{N}])`, 'iu');
    if (!re.test(source)) continue;
    if (term.policy === 'keep') keep.push(term.term);
    // A 'translate' term may inflect in the target; only names we transliterate must appear verbatim.
    else if (term.policy === 'transliterate') {
      const form = glossaryForm(term, lang);
      if (form) forms.push(form);
    }
  }
  return { forms, keep };
}

/**
 * Translate one chunk: one call, software validation, at most one repair round for the problem lines.
 * Throws StudioError on provider/billing/cancel failures (nothing of this chunk is committed then).
 */
export async function translateChunk(llm: LlmClient, req: ChunkRequest): Promise<ChunkResult> {
  const { doc, lang } = req;
  const edition = i18nOf(doc).editions[lang];
  const register = edition?.register ?? 'everyday';
  const sourceLang = doc.format.language;
  const items = new Map<string, CheckItem & { hash: string; extra?: EditionTextField }>();
  const previous: Record<string, string> = {};
  for (const { page, lineIds } of req.pages) {
    for (const panel of page.panels) {
      for (const line of panel.lines) {
        if (!lineIds.has(line.id)) continue;
        const source = normalizeSource(line.text);
        const g = glossaryNeeds(doc, lang, source);
        items.set(line.id, { id: line.id, source, maxChars: translationBudget(doc, page, line, lang), forms: g.forms, keep: g.keep, hash: lineSourceHash(line) });
        const prev = edition?.lines[line.id];
        if (prev?.text) previous[line.id] = prev.text;
      }
    }
  }
  for (const extra of req.extras) {
    const g = glossaryNeeds(doc, lang, extra.text);
    items.set(extra.id, { id: extra.id, source: extra.text, maxChars: extra.maxChars, forms: g.forms, keep: g.keep, hash: textSourceHash(extra.text), extra: extra.id as EditionTextField });
  }

  const messages: ChatMessage[] = [
    { role: 'system', content: translatorSystemPrompt(doc, lang, edition) },
    { role: 'user', content: translatorUserMessage(doc, lang, { pages: req.pages, extras: req.extras, previous }) }
  ];
  const result: ChunkResult = { lines: {}, extras: {}, glossary: [], failed: [], unsafe: [], calls: 0, completionTokens: 0, repaired: false };
  const answers = new Map<string, string>();
  const ask = async (): Promise<TranslatorOutput | undefined> => {
    const res = await llm.complete({
      role: 'translator',
      messages,
      jsonSchema: { name: 'comic_translation', schema: TRANSLATION_SCHEMA, strict: true },
      signal: req.signal
    });
    result.calls += 1;
    result.model = res.model || result.model;
    result.completionTokens += res.completionTokens || 0;
    messages.push({ role: 'assistant', content: (res.text || JSON.stringify(res.json ?? {})).slice(0, 40_000) });
    return readTranslatorOutput(outputOf(res));
  };
  const absorb = (out: TranslatorOutput | undefined, only?: Set<string>) => {
    if (!out) return;
    for (const l of out.lines) if (items.has(l.id) && (!only || only.has(l.id))) answers.set(l.id, l.text);
    result.glossary.push(...out.glossary);
  };

  absorb(await ask());
  const evaluate = () => {
    const checks = new Map<string, CheckResult>();
    for (const [id, item] of items) checks.set(id, checkLine(lang, register, item, answers.get(id), req.rating, sourceLang));
    return checks;
  };
  let checks = evaluate();
  const problems = [...checks.entries()].filter(([, c]) => c.problem);
  if (problems.length) {
    // One repair round lists the problems; only those lines are re-asked.
    messages.push({ role: 'user', content: repairMessage(problems.map(([, c]) => c.message || 'invalid line')) });
    result.repaired = true;
    try {
      absorb(await ask(), new Set(problems.map(([id]) => id)));
    } catch (err) {
      if (err instanceof StudioError && (err.code === 'CANCELLED' || err.code === 'BILLING_DENIED')) throw err;
      // A failed repair still leaves the first answer.
    }
    checks = evaluate();
  }

  for (const [id, item] of items) {
    const check = checks.get(id)!;
    const text = normalizeSource(answers.get(id) || '').slice(0, DOC_LIMITS.translationChars);
    if (check.problem === 'missing' || check.problem === 'empty' || check.problem === 'unsafe') {
      result.failed.push(id);
      if (check.problem === 'unsafe') result.unsafe.push(id);
      continue;
    }
    const entry: ChunkLineResult = { text, tooLong: check.tooLong, sourceHash: item.hash };
    if (check.problem) entry.issue = { severity: 'major', note: PROBLEM_NOTES[check.problem] };
    else if (check.ambiguous) entry.issue = { severity: 'major', note: 'The content check is unsure about this wording — please read it before publishing.' };
    if (item.extra) result.extras[item.extra] = entry;
    else result.lines[id] = entry;
  }
  return result;
}

// ── Ops from a chunk ─────────────────────────────────────────────────────────

/**
 * `translations` + `edition_text` + glossary ops for one chunk (status 'machine' until the linguist reviews).
 * `doc` is the doc at COMMIT time: a line or title the author wrote themselves while the chunk was with the
 * model ('edited') keeps their words — machine text never overwrites an author's edit.
 */
export function chunkOps(doc: ComicDoc, lang: string, chunk: ChunkResult, now: number, model?: string): DocOp[] {
  const ops: DocOp[] = [];
  const edition = i18nOf(doc).editions[lang];
  const lines: Record<string, TextTranslation> = {};
  for (const [id, r] of Object.entries(chunk.lines)) {
    if (edition?.lines[id]?.status === 'edited') continue;
    const t: TextTranslation = { text: r.text, status: 'machine', sourceHash: r.sourceHash, at: now };
    if (r.issue) t.issue = r.issue;
    if (model) t.model = model;
    lines[id] = t;
  }
  if (Object.keys(lines).length) ops.push({ op: 'translations', lang, lines });
  // cover.title usually repeats brief.title: one translation serves both.
  const extras = { ...chunk.extras };
  for (const field of ['cover.title', 'cover.tagline', 'brief.title', 'brief.logline'] as const) {
    if (extras[field]) continue;
    const src = editionTextSource(doc, field);
    const twin = (['brief.title', 'cover.title', 'brief.logline', 'cover.tagline'] as const).find((f) => f !== field && extras[f] && editionTextSource(doc, f).toLowerCase() === src.toLowerCase());
    if (src && twin) extras[field] = { ...extras[twin]!, sourceHash: textSourceHash(src) };
  }
  for (const [field, r] of Object.entries(extras) as [EditionTextField, ChunkLineResult][]) {
    if (!editionTextSource(doc, field)) continue;
    if (editionTextEntry(doc, lang, field)?.status === 'edited') continue;
    const value: TextTranslation = { text: r.text, status: 'machine', sourceHash: r.sourceHash, at: now };
    if (r.issue) value.issue = r.issue;
    if (model) value.model = model;
    ops.push({ op: 'edition_text', lang, field, value });
  }
  ops.push(...glossaryOpsFromModel(doc, lang, chunk.glossary));
  return ops;
}

/**
 * Names the translator coined become glossary forms (so chunk 2 and every later run use them).
 * The author's forms always win: an existing form is never overwritten.
 */
export function glossaryOpsFromModel(doc: ComicDoc, lang: string, coined: { term: string; form: string }[]): DocOp[] {
  const glossary = i18nOf(doc).glossary;
  const ops: DocOp[] = [];
  let count = glossary.length;
  const seen = new Set<string>();
  for (const { term, form } of coined) {
    const key = term.toLowerCase();
    if (!term || !form || seen.has(key) || sameLanguage(lang, doc.format.language)) continue;
    seen.add(key);
    const existing = glossary.find((g) => g.term.toLowerCase() === key);
    if (existing?.policy === 'keep') continue;
    if (scriptShare(form, lang) < 0.6) continue;
    if (existing) {
      if (!existing.forms[lang]) ops.push({ op: 'glossary_term', id: existing.id, patch: { forms: { [lang]: form } } });
      continue;
    }
    if (count >= DOC_LIMITS.glossaryTerms) continue;
    count += 1;
    ops.push({ op: 'glossary_term', id: `gl_t_${hashString(key).slice(0, 12)}`, patch: { term, kind: 'term', policy: 'transliterate', forms: { [lang]: form } } });
  }
  return ops;
}
