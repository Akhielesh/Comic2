// Translation problems (STU-T0): one pure, free list of what is wrong with a language, where, and what fixes it.
// The Languages tab, the review screen, the chat's completion message and a refused publish all read this one list,
// so they always agree. Nothing here calls a model, reads the clock or touches the network.
//
// The classifier itself (`translationProblems`, `lineRefOf`, `whereText`) lives in i18n.ts next to editionReadiness,
// which is derived from it: i18n.ts must not import this module at run time (shared/comic keeps no import cycles), so
// this module re-exports it and adds what only the fixes need (`fixPlanFor`, the stage flag). Import from here.

import type { EditionTextField, LineKind, TranslationFailure } from './doc.js';
import { DOC_LIMITS } from './limits.js';

export { CONTENT_CHECK_NOTES, lineRefOf, translationProblems, whereText } from './i18n.js';

/**
 * Where a translatable text sits. `page` = page.n, `panel` = panel.n, `line` = 1-based index in `panel.lines` (the
 * order the review lists them in, which is not the visual reading order of balloons). A title (cover/brief text) has
 * `field`, `lineId` = the field name, `pageId` '' and page/panel/line 0.
 */
export interface LineRef {
  lineId: string;
  pageId: string;
  page: number;
  panel: number;
  line: number;
  kind: LineKind;
  speakerId?: string;
  field?: EditionTextField;
}

/**
 * missing          no translation yet                          stale         the source changed since translating
 * stale_edited     the author's own words; the source changed  waiting       a machine translation no reviewer judged
 * review_failed    as waiting, but its review call failed      flagged       the review (or software) found a MAJOR issue
 * refused          the content check refused every wording     timed_out     the translator ran out of time on it
 * provider_failed  the provider failed or answered nothing     note          a minor note (never blocks publishing)
 */
export type ProblemKind = 'missing' | 'stale' | 'stale_edited' | 'waiting' | 'review_failed' | 'flagged' | 'refused' | 'timed_out' | 'provider_failed' | 'note';

/**
 * translate      a normal (paid) translation of the line          finish_review  a (paid) review only
 * redo           translate again with the reviewer's note           smaller_parts  translate again in smaller calls
 * creator        only the creator can settle it (write it, keep the original words, ask the Director, Looks right)
 * null           nothing to do (a minor note)
 */
export type FixKind = 'translate' | 'finish_review' | 'redo' | 'smaller_parts' | 'creator' | null;

export interface TranslationProblem {
  lang: string;
  kind: ProblemKind;
  ref: LineRef;
  /** Blocks publishing this language. Titles never do (as today: the reader falls back to the source title). */
  blocking: boolean;
  fix: FixKind;
  /** The stored review note, for `flagged` and `note` only. Never the translation text. */
  note?: string;
  /** For refused / timed_out / provider_failed / review_failed: the stored failure reason ('empty' and 'provider'
   *  both read as provider_failed). */
  reason?: TranslationFailure['reason'];
}

/** Rollout switch for the self-fixing translation work (STU-T1 run round, STU-T2 button): one word turns it off. */
export type I18nFixStage = 'off' | 'admins' | 'all';
export const I18N_FIX_STAGE: I18nFixStage = 'all';

/** The fields a `translate` action needs for "Fix automatically" (spread into `{ type: 'translate', languages: [lang] }`). */
export interface FixPlan {
  /** Line ids (or title fields) to translate again although current: flagged lines the review gave no usable fix for. */
  redo: string[];
  /** The scope: only these lines and titles are planned. Absent = the whole language, which then does the same work. */
  lineIds?: string[];
  /** Translate in parts of 10 lines (after a time-out). */
  chunkLines?: 10;
}

const MACHINE_FIXES: ReadonlySet<FixKind> = new Set<FixKind>(['translate', 'finish_review', 'redo', 'smaller_parts']);

/**
 * The one action behind "Fix automatically" for ONE language (the first problem's; others are ignored), or null when
 * nothing blocking is left that the machine can fix (only creator choices, notes or titles).
 *
 * Scope: when a refused line is in the language, `lineIds` names the fixable lines and titles (≤ 200, reading order,
 * titles first) so the refused line is never retried blindly. Otherwise the scope is left out: the whole-language plan
 * already does exactly that work (missing, stale and waiting lines, titles, plus `redo`) and the action stays small.
 * `redo` (≤ 200) never holds the author's own words or a content-check flag (those are `creator`).
 */
export function fixPlanFor(problems: readonly TranslationProblem[]): FixPlan | null {
  if (!problems.length) return null;
  const lang = problems[0].lang;
  const mine = problems.filter((p) => p.lang === lang);
  const fixable = mine.filter((p) => MACHINE_FIXES.has(p.fix));
  if (!fixable.some((p) => p.blocking)) return null;
  const cap = DOC_LIMITS.translateLineIds;
  const plan: FixPlan = { redo: fixable.filter((p) => p.fix === 'redo').map((p) => p.ref.lineId).slice(0, cap) };
  if (mine.some((p) => p.kind === 'refused')) {
    const scope = fixable.map((p) => p.ref.lineId).slice(0, cap);
    const inScope = new Set(scope);
    plan.lineIds = scope;
    plan.redo = plan.redo.filter((id) => inScope.has(id));
  }
  if (fixable.some((p) => p.fix === 'smaller_parts')) plan.chunkLines = 10;
  return plan;
}
