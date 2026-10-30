// Consistency actions (pro plan §4.4, §10 B7). STUB with fixed export names (K2b): B7 replaces it in place and owns this
// file from the moment K2b merges (pro plan §10 stub rule).
//
//   rebind_panels  free: "Match the script to the art" (the first producer of the server-only page_panels op)
//   apply_finding  free: off-panel voice, drop from the cast, "Keep it from here"
//   enrich_pages   SPEND (a writer call: directions, continuity and scenes; never story text), quoted and gated
//
// enrich_pages goes through the existing gate (jobs.ts runFeatureAction: estimate → gateDecision → run; a stale chip
// quote re-gates; governed users read usage, never dollars). Its quote lives here (enrichPagesQuote) and jobs.ts
// estimateSpendAction uses the same function, so the chip, the gate and its approval agree. The stub runs nothing: it
// says the action isn't available yet and charges nothing.

import type { ComicDoc } from '../../../../shared/comic/doc.js';
import { PLAN_USD_PER_PAGE, PLATFORM_MARKUP, type SpendEstimate } from '../../../../shared/comic/models.js';
import type { ActionHandler } from '../extensions.js';
import { notAvailableAction } from '../extensions.js';
import { spendIsByok, type EnrichPagesAction } from '../jobs.js';

export const CONSISTENCY_NOT_AVAILABLE = "That isn't available in the studio yet. Nothing was changed or charged.";
/** The text model a writer-priced quote names on its gate card. */
export const ENRICH_MODEL_LABEL = 'Writer';

const round4 = (n: number) => Math.round(n * 10000) / 10000;

/** The pages an enrich_pages action names that are in the comic (unknown ids dropped; none = every page). */
export const enrichTargets = (doc: ComicDoc, action: Pick<EnrichPagesAction, 'pageIds'>): string[] => {
  const ids = Array.isArray(action.pageIds) ? new Set(action.pageIds.filter((id) => typeof id === 'string')) : null;
  return doc.pages.filter((p) => !ids || !ids.size || ids.has(p.id)).map((p) => p.id);
};

/**
 * What adding detail to these pages costs: one writer pass per page at the plan's per-page price (PLAN_USD_PER_PAGE),
 * × the platform markup unless BYOK. A TEXT spend: no image. B6/B7 refine it with the real call's size.
 */
export const enrichPagesQuote = (doc: ComicDoc, action: Pick<EnrichPagesAction, 'pageIds'>, byok: boolean): SpendEstimate => {
  const count = enrichTargets(doc, action).length;
  const usd = round4(PLAN_USD_PER_PAGE * count * (byok ? 1 : PLATFORM_MARKUP));
  return { usd, imageCount: 0, model: ENRICH_MODEL_LABEL, lines: count ? [{ label: 'page details', count, usd }] : [] };
};

/** rebind_panels (free). STUB: not available. */
export const rebindPanelsAction = notAvailableAction('rebind_panels' as never, false, CONSISTENCY_NOT_AVAILABLE) as unknown as ActionHandler;
/** apply_finding (free). STUB: not available. */
export const applyFindingAction = notAvailableAction('apply_finding' as never, false, CONSISTENCY_NOT_AVAILABLE) as unknown as ActionHandler;

/** enrich_pages (spend): quoted and gated like every spend; the stub run is not available (nothing is charged). */
export const enrichPagesAction: ActionHandler = {
  ...(notAvailableAction('enrich_pages' as never, true, CONSISTENCY_NOT_AVAILABLE) as unknown as ActionHandler),
  async estimate(ctx, action) {
    return enrichPagesQuote(ctx.session.doc, action as unknown as EnrichPagesAction, spendIsByok(ctx.keys));
  }
};

export const CONSISTENCY_ACTIONS: ActionHandler[] = [rebindPanelsAction, applyFindingAction, enrichPagesAction];
