// The render gate's plan check (plan §4.1, decision PD-1): before "Render all" spends anything, pages whose
// dialogue cannot fit their panels are HELD BACK — left out of the run and its quote, with free fixes first —
// unless the user picked "Draw anyway" for them (`render_pages.drawOverfull`). Never a refusal.
//
// Pure: no I/O, no clock, no money. The decision itself lives in shared/comic/pagePlanCheck.ts (splitHeldBack),
// so the breakdown card's quote (summarizeBook / quoteRenderPages with `holdBack`) and the server's run agree.
// Wiring (K1): jobs.ts render_pages calls planCheckGate on its targets before the quote and the run.

import type { ComicDoc } from '../../../shared/comic/doc.js';
import { splitHeldBack, type HeldBackPage } from '../../../shared/comic/pagePlanCheck.js';

export type { HeldBackPage } from '../../../shared/comic/pagePlanCheck.js';

export interface PlanGateResult {
  /** Pages to draw, in the order given (held-back pages removed). */
  pageIds: string[];
  /** Overfull pages left out of the run and its quote, each with its sentence and free fixes. */
  heldBack: HeldBackPage[];
  /** One calm line for the gate card when something is held back ("Page 2 isn't drawn yet: …"). */
  notice?: string;
}

const listPages = (ns: number[]): string => {
  const sorted = [...ns].sort((a, b) => a - b);
  if (sorted.length === 1) return `Page ${sorted[0]}`;
  return `Pages ${sorted.slice(0, -1).join(', ')} and ${sorted[sorted.length - 1]}`;
};

/** The gate card's line for held-back pages (no prices: the run's own quote already excludes them). */
export function heldBackNotice(heldBack: HeldBackPage[]): string | undefined {
  if (!heldBack.length) return undefined;
  if (heldBack.length === 1) {
    const h = heldBack[0];
    return `Page ${h.n} isn't drawn yet: ${h.panel ? `panel ${h.panel} has` : 'it has'} more words than it can hold. ${
      h.layoutFix ? 'A layout that fits is ready (free)' : 'Free fixes first'
    }, or draw it anyway.`;
  }
  return `${listPages(heldBack.map((h) => h.n))} aren't drawn yet: each has a panel with more words than it can hold. Free fixes first, or draw them anyway.`;
}

/**
 * Keep only page ids the user may ask to draw anyway: strings naming a page of this doc, de-duplicated, in page
 * order. Anything else (unknown ids, non-strings, a huge array) is dropped.
 */
export function sanitizeDrawOverfull(raw: unknown, doc: Pick<ComicDoc, 'pages'>): string[] {
  if (!Array.isArray(raw)) return [];
  const wanted = new Set(raw.slice(0, 200).filter((v): v is string => typeof v === 'string' && v.length > 0 && v.length <= 64));
  return [...doc.pages].sort((a, b) => a.n - b.n).filter((p) => wanted.has(p.id)).map((p) => p.id);
}

/**
 * Split the pages a run would draw into the ones it draws and the overfull ones it holds back. Pages listed in
 * `drawOverfull` are drawn as planned. Unknown ids pass through (the caller's own target logic drops them).
 */
export function planCheckGate(doc: ComicDoc, pageIds: string[], drawOverfull?: readonly string[]): PlanGateResult {
  const anyway = sanitizeDrawOverfull(drawOverfull ?? [], doc);
  const { draw, heldBack } = splitHeldBack(doc, Array.isArray(pageIds) ? pageIds : [], anyway);
  const notice = heldBackNotice(heldBack);
  return { pageIds: draw, heldBack, ...(notice ? { notice } : {}) };
}
