// Run order for "Render all" (pro plan §4.2 B7). STUB with fixed export names (K2b): B7 replaces the bodies in place
// and owns this file from the moment K2b merges (pro plan §10 stub rule). The stub is TODAY's order:
//   sheets first → page 1 alone → every other page and the cover once page 1's job is done;
// and previousPageFor is today's continuity anchor, nearestReadyBefore.
//
// Seam: jobs.ts RenderRun.pages draws the anchors the quote listed first, then starts each page when its `after`
// predecessor has settled — `settle: 'done'` waits for the whole job (image, check, safety verdict), `'stored'` only
// for the predecessor's image to be stored (or its job to fail). No timers: the engine chains promises only.

import { type ComicDoc, type Page } from '../../../../shared/comic/doc.js';
import { nearestReadyBefore } from '../../../../shared/comic/sendable.js';

export interface RunSchedule {
  /** Page ids in the order the run starts them. */
  order: string[];
  /** Per page: the page it waits for (null = starts at once, after the sheets). Unknown ids or a cycle start at once. */
  after: Record<string, string | null>;
  /** What the cover waits for (null = at once, after the sheets). */
  coverAfter: string | null;
  /** When a predecessor counts as landed: its image stored ('stored') or its whole job settled ('done'). */
  settle: 'stored' | 'done';
}

/** Whether "Render all" draws missing consistency anchors first (then render_pages quotes them). STUB: false. */
export const runDrawsAnchors = (): boolean => false;

/** The run's order and dependencies. STUB: today's order (page 1 alone, then the rest and the cover after it). */
export function scheduleRun(_doc: ComicDoc, pageIds: readonly string[]): RunSchedule {
  const [first, ...rest] = pageIds;
  const after: Record<string, string | null> = {};
  if (first) after[first] = null;
  for (const id of rest) after[id] = first ?? null;
  return { order: [...pageIds], after, coverAfter: first ?? null, settle: 'done' };
}

/** The page a page's drawing continues from (PREVIOUS PAGE reference, continuityPath). STUB: nearestReadyBefore. */
export function previousPageFor(doc: ComicDoc, page: Page, _opts: { assumeDrawn?: ReadonlySet<string> } = {}): Page | undefined {
  return nearestReadyBefore(doc, page);
}
