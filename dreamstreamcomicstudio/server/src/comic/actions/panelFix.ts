// One-panel fixes (fix_panel; pro plan §4.4 B8). STUB with fixed export names (K2b): B8 replaces the bodies in place and
// owns this file from the moment K2b merges (pro plan §10 stub rule).
//
// fix_panel is a SPEND that runs on the core spend pipeline in jobs.ts (startSpend: validation, the lock, keys, plan
// access, the quote, the gate — a stale chip quote re-gates, budgets hold, BYOK is flagged; then the money-safe
// preflight, the reservation and RenderRun.panelFix). jobs.ts calls the hooks below at each step:
//   fixPanelProblem   before anything (null = go; a sentence = blocked, nothing spent)
//   fixPanelJobs      what the quote prices ('panel' jobs: the locked model one tier down + one check run)
//   compileFixPanel   the image job (B5's compilePanelFix: Image 1 `__panel__` crop, Image 2 `__page__`, then sheets)
//   finishFixPanel    the model's panel → the page raster to store (raster.pasteIntoCut into a COPY of the page)
//   fixPanelMeta      the new version's meta (the same cuts, updated parts, origin 'edit', parentPath)
// The stub blocks every fix_panel at fixPanelProblem: nothing is quoted as runnable, nothing is drawn or charged.

import type { ComicDoc, VersionMeta } from '../../../../shared/comic/doc.js';
import type { ImageJobKind } from '../../../../shared/comic/models.js';
import type { ContentRating } from '../../../../shared/comic/safety.js';
import type { ActionHandler } from '../extensions.js';
import { notAvailableError } from '../extensions.js';
import type { FixPanelAction } from '../jobs.js';
import type { CompiledImageJob } from '../types.js';

export const FIX_PANEL_NOT_AVAILABLE = "Fixing a single panel isn't available yet. Nothing was drawn or charged.";

/** fix_panel is a core spend (jobs.ts), so no registry handler: the registry list stays empty. */
export const PANEL_FIX_ACTIONS: ActionHandler[] = [];

/** Why this fix can't run now (a sentence for the user), or null. STUB: not available. */
export function fixPanelProblem(_doc: ComicDoc, _action: FixPanelAction): string | null {
  return FIX_PANEL_NOT_AVAILABLE;
}

/** The image jobs the quote prices. One panel drawn on the locked model at the page tier one step down, plus one check. */
export function fixPanelJobs(_doc: ComicDoc, _action: FixPanelAction): { kind: ImageJobKind; count: number; label: string }[] {
  return [{ kind: 'panel', count: 1, label: 'panel fix' }];
}

export interface FixPanelCompileOptions {
  safe?: boolean;
  rating?: ContentRating;
}

/** The compiled image job for this fix. STUB: never reached (fixPanelProblem blocks); throws NOT_AVAILABLE. */
export function compileFixPanel(_doc: ComicDoc, _action: FixPanelAction, _opts: FixPanelCompileOptions): CompiledImageJob {
  throw notAvailableError(FIX_PANEL_NOT_AVAILABLE, 501);
}

export interface FixPanelFinishInput {
  doc: ComicDoc;
  action: FixPanelAction;
  /** What the model drew (the panel). */
  drawn: string;
  /** The page's drawing the fix started from (loaded on demand). */
  base: () => Promise<string>;
}

/** The page raster to store as the new version, or null when it can't be made (the job then fails honestly). STUB: null. */
export async function finishFixPanel(_input: FixPanelFinishInput): Promise<string | null> {
  return null;
}

/** The new version's extra meta (cuts copied from the parent, parts updated, origin 'edit', parentPath). STUB: none. */
export function fixPanelMeta(_doc: ComicDoc, _action: FixPanelAction): Partial<VersionMeta> {
  return {};
}
