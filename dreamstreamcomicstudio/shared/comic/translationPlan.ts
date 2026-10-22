// Software-first translation work plan (contract §11.4). WAVE-0 STUB: an empty plan.
// P1-I18N fills the $0 paths (duplicates, punctuation, glossary-only, noTranslate, loose matches)
// and the deterministic token estimate.

import type { ComicDoc, EditionTextField, Line, Page } from './doc.js';
import type { DocOp } from './ops.js';
import { graphemes } from './textLayout.js';

export interface TranslationPlan {
  lang: string;
  toTranslate: { pageId: string; lineIds: string[] }[];
  freeLines: { lineId: string; text: string; reason: 'duplicate' | 'punctuation' | 'glossary_only' | 'no_translate' | 'loose_match' }[];
  upToDate: number; skippedEdited: number;
  coverTexts: EditionTextField[];
  calls: number;
  tokens: { input: number; output: number; reviewInput: number; reviewOutput: number };
}

export function planTranslation(_doc: ComicDoc, lang: string, _opts?: { pageIds?: string[]; force?: boolean; overwriteEdits?: boolean }): TranslationPlan {
  return {
    lang,
    toTranslate: [],
    freeLines: [],
    upToDate: 0,
    skippedEdited: 0,
    coverTexts: [],
    calls: 0,
    tokens: { input: 0, output: 0, reviewInput: 0, reviewOutput: 0 }
  };
}

/** Ops for the free paths (copy/duplicate/loose carry-over) — committed before any LLM call. */
export function freeTranslationOps(_doc: ComicDoc, _plan: TranslationPlan): DocOp[] {
  return [];
}

/** Grapheme maxChars hint (stub: source length × 1.3, minimum 6). */
export function translationBudget(_doc: ComicDoc, _page: Page, line: Line, _lang: string): number {
  const n = graphemes(line.text || '').length;
  return line.kind === 'sfx' ? Math.max(4, Math.ceil(n * 1.3)) : Math.max(6, Math.ceil(n * 1.3));
}

/** Idempotent glossary seed from cast/places/title (stub: nothing). */
export function syncGlossaryOps(_doc: ComicDoc): DocOp[] {
  return [];
}

/** Whole-token rename of a target form across an edition, $0 (stub: nothing). */
export function glossaryRenameOps(_doc: ComicDoc, _lang: string, _termId: string, _from: string, _to: string): DocOp[] {
  return [];
}
