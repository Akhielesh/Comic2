// Linguist review — "true translation" (i18n.md §8.7, owner amendment: the review ALWAYS runs). Owner: P1-I18N.
//
// One call per ≤ 60 lines. Each line gets a literal gloss in the SOURCE language (the author who
// cannot read Telugu sees what the Telugu says), a verdict and, for problems, a suggestion:
//   ok                      → status 'reviewed' (+ gloss), issue cleared
//   minor                   → status 'reviewed', issue {minor, note, suggestion} (one-tap "Use suggestion")
//   major + valid suggestion→ the suggestion is applied (status 'reviewed'); the issue keeps the ORIGINAL
//                             as its suggestion ("Auto-corrected by review: …") so the author can revert
//   major, no suggestion    → status stays 'machine' with a major issue (blocks publishing until handled)
//   no verdict              → unchanged ('machine', i.e. "waiting for review"; the next run reviews it)

import type { ComicDoc, EditionTextField, TextTranslation, TranslationRegister } from '../../../../shared/comic/doc.js';
import { i18nOf, lineSourceHash, normalizeSource, textSourceHash } from '../../../../shared/comic/i18n.js';
import type { DocOp } from '../../../../shared/comic/ops.js';
import type { ContentRating } from '../../../../shared/comic/safety.js';
import { DOC_LIMITS } from '../../../../shared/comic/limits.js';
import { AUTO_CORRECTED_NOTE, editionTextEntry, editionTextSource, linesInOrder, REVIEW_CHUNK_LINES } from '../../../../shared/comic/translationPlan.js';
import { StudioError, type LlmClient } from '../types.js';
import { checkLine, glossaryNeeds, isSoftwareIssue, outputOf } from './translate.js';
import { linguistSystemPrompt, linguistUserMessage, REVIEW_SCHEMA, type ReviewItem, type ReviewVerdict } from './prompts.js';

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const EDITION_FIELDS: readonly EditionTextField[] = ['brief.title', 'brief.logline', 'cover.title', 'cover.tagline'];

/** Tolerant reader of the linguist's JSON. */
export function readReview(raw: unknown): ReviewVerdict[] {
  if (!isObj(raw) || !Array.isArray(raw.lines)) return [];
  return raw.lines.filter(isObj).flatMap((l): ReviewVerdict[] => {
    if (typeof l.id !== 'string') return [];
    const verdict = l.verdict === 'fix' ? 'fix' : l.verdict === 'ok' ? 'ok' : undefined;
    if (!verdict) return [];
    const severity = l.severity === 'major' ? 'major' : l.severity === 'minor' ? 'minor' : 'none';
    const s = (v: unknown, n: number) => (typeof v === 'string' ? normalizeSource(v).slice(0, n) : '');
    return [{ id: l.id, verdict, severity: verdict === 'ok' ? 'none' : severity === 'none' ? 'minor' : severity, gloss: s(l.gloss, 300), issue: s(l.issue, 300), suggestion: s(l.suggestion, DOC_LIMITS.translationChars) }];
  });
}

/** What the linguist reads: the lines (and cover/brief texts) of an edition, current translations only. */
export function reviewItems(doc: ComicDoc, lang: string, ids: readonly string[]): ReviewItem[] {
  const edition = i18nOf(doc).editions[lang];
  if (!edition) return [];
  const want = new Set(ids);
  const items: ReviewItem[] = [];
  for (const { line } of linesInOrder(doc)) {
    if (!want.has(line.id)) continue;
    const t = edition.lines[line.id];
    if (!t || t.sourceHash !== lineSourceHash(line)) continue;
    const speaker = line.speakerId ? doc.cast.find((c) => c.id === line.speakerId)?.name : undefined;
    items.push({ id: line.id, kind: line.kind, ...(speaker ? { speaker } : {}), source: normalizeSource(line.text), text: t.text });
  }
  for (const field of EDITION_FIELDS) {
    if (!want.has(field)) continue;
    const t = editionTextEntry(doc, lang, field);
    const source = editionTextSource(doc, field);
    if (!t || !source || t.sourceHash !== textSourceHash(source)) continue;
    items.push({ id: field, kind: field.split('.')[1], source, text: t.text });
  }
  return items;
}

export interface ReviewRun {
  verdicts: Map<string, ReviewVerdict>;
  calls: number;
  /** Batches that failed (their lines stay 'machine' = waiting for review). */
  failedBatches: number;
  error?: StudioError;
}

/** Review the given ids in ≤ REVIEW_CHUNK_LINES batches. Cancel/billing errors stop the rest; others skip a batch. */
export async function reviewTranslations(llm: LlmClient, doc: ComicDoc, lang: string, ids: readonly string[], signal?: AbortSignal, onBatch?: (i: number, n: number) => void): Promise<ReviewRun> {
  const items = reviewItems(doc, lang, ids);
  const run: ReviewRun = { verdicts: new Map(), calls: 0, failedBatches: 0 };
  const batches: ReviewItem[][] = [];
  for (let i = 0; i < items.length; i += REVIEW_CHUNK_LINES) batches.push(items.slice(i, i + REVIEW_CHUNK_LINES));
  for (const [i, batch] of batches.entries()) {
    if (signal?.aborted) {
      run.error = new StudioError('CANCELLED', 'Cancelled.', { status: 499 });
      break;
    }
    onBatch?.(i, batches.length);
    try {
      const res = await llm.complete({
        role: 'linguist',
        messages: [
          { role: 'system', content: linguistSystemPrompt(doc, lang) },
          { role: 'user', content: linguistUserMessage(doc, lang, batch) }
        ],
        jsonSchema: { name: 'comic_translation_review', schema: REVIEW_SCHEMA, strict: true }
        // `signal` is checked BETWEEN batches only: a started review call is paid for, so it finishes and is kept.
      });
      run.calls += 1;
      const wanted = new Set(batch.map((b) => b.id));
      for (const v of readReview(outputOf(res))) if (wanted.has(v.id)) run.verdicts.set(v.id, v);
    } catch (err) {
      run.failedBatches += 1;
      if (err instanceof StudioError && (err.code === 'CANCELLED' || err.code === 'BILLING_DENIED')) {
        run.error = err;
        break;
      }
      run.error = err instanceof StudioError ? err : new StudioError('PROVIDER_ERROR', 'The translation reviewer did not answer.', { status: 502 });
    }
  }
  return run;
}

export interface ReviewOutcome {
  ops: DocOp[];
  reviewed: number;
  flagged: number;
  autoFixed: number;
}

/** Turn verdicts into ops (`translations` for lines, `edition_text` for cover/brief texts). */
export function applyReview(doc: ComicDoc, lang: string, verdicts: Map<string, ReviewVerdict>, rating: ContentRating, now: number): ReviewOutcome {
  const out: ReviewOutcome = { ops: [], reviewed: 0, flagged: 0, autoFixed: 0 };
  const edition = i18nOf(doc).editions[lang];
  if (!edition || !verdicts.size) return out;
  const register: TranslationRegister = edition.register ?? 'everyday';
  const sourceLang = doc.format.language;
  const decide = (cur: TextTranslation, source: string, v: ReviewVerdict): TextTranslation => {
    const next: TextTranslation = { ...cur, at: now };
    delete next.issue;
    if (v.gloss) next.gloss = v.gloss;
    if (v.verdict === 'ok') {
      if (isSoftwareIssue(cur.issue)) {
        // Software found an objective problem (wrong script, missing glossary name, content check):
        // a reviewer's "ok" does not clear it — the author decides.
        next.status = 'machine';
        next.issue = cur.issue;
        out.flagged += 1;
        return next;
      }
      next.status = 'reviewed';
      out.reviewed += 1;
      return next;
    }
    const g = glossaryNeeds(doc, lang, source);
    const suggestion = v.suggestion && v.suggestion !== cur.text ? v.suggestion : '';
    const usable = !!suggestion && !checkLine(lang, register, { id: 'x', source, maxChars: 9999, forms: g.forms, keep: g.keep }, suggestion, rating, sourceLang).problem;
    if (v.severity === 'major') {
      if (usable) {
        next.text = suggestion;
        next.status = 'reviewed';
        next.issue = { severity: 'minor', note: `${AUTO_CORRECTED_NOTE}: ${v.issue || 'the meaning was off'}`.slice(0, 300), suggestion: cur.text };
        out.autoFixed += 1;
        out.reviewed += 1;
        return next;
      }
      next.status = 'machine';
      next.issue = { severity: 'major', note: v.issue || 'The reviewer found a problem with this line.' };
      out.flagged += 1;
      return next;
    }
    next.status = 'reviewed';
    next.issue = { severity: 'minor', note: v.issue || 'Could read more naturally.', ...(usable ? { suggestion } : {}) };
    out.reviewed += 1;
    out.flagged += 1;
    return next;
  };
  const lines: Record<string, TextTranslation> = {};
  for (const { line } of linesInOrder(doc)) {
    const v = verdicts.get(line.id);
    const cur = edition.lines[line.id];
    if (!v || !cur || cur.sourceHash !== lineSourceHash(line)) continue;
    lines[line.id] = decide(cur, normalizeSource(line.text), v);
  }
  if (Object.keys(lines).length) out.ops.push({ op: 'translations', lang, lines });
  for (const field of EDITION_FIELDS) {
    const v = verdicts.get(field);
    const cur = editionTextEntry(doc, lang, field);
    const source = editionTextSource(doc, field);
    if (!v || !cur || !source || cur.sourceHash !== textSourceHash(source)) continue;
    out.ops.push({ op: 'edition_text', lang, field, value: decide(cur, source, v) });
  }
  return out;
}
