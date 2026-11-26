// The free "Use the layout that fits" fix for a page whose words do not fit its panels (the K1 contract; the server's
// jobs.ts heldBackLayoutFixOps is the same rule with the prompt's own layout check on top). Shared by the breakdown card
// and the Pages header, so both offer exactly the same fix.

import type { ComicDoc, Page } from './doc.js';
import { applyOps, layoutFixOps, type DocOp } from './ops.js';
import { checkPagePlan } from './pagePlanCheck.js';

/**
 * The shared `layoutFixOps` — the blueprint PLUS panel sizes that agree with it; a bare `page.layout` patch would leave
 * a 'wide' panel in a shared row and the prompt would draw the old, overfull layout. Null (no fix to offer) when it
 * gives no ops, or when the page is still overfull once they are applied.
 */
export const layoutFitFix = (doc: ComicDoc, page: Page, layout: string | undefined): DocOp[] | null => {
  if (!layout) return null;
  const ops = layoutFixOps(doc, page, layout);
  if (!ops.length) return null;
  const fitted = applyOps(doc, ops);
  const after = fitted.pages.find((p) => p.id === page.id);
  if (!after) return null;
  return checkPagePlan(fitted, after, { fixLayout: false }).state === 'overfull' ? null : ops;
};
