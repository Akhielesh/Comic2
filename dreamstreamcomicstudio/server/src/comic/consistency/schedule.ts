// Run order for "Render all" (pro plan §4.2 B7). STUB with fixed export names (K2b): B7 replaces the bodies in place
// and owns this file from the moment K2b merges (pro plan §10 stub rule). The stub is TODAY's order:
//   sheets first → page 1 alone → every other page and the cover once page 1's job is done;
// and previousPageFor is today's continuity anchor, nearestReadyBefore.
//
// Seam: jobs.ts RenderRun.pages draws the anchors the quote listed first, then starts each page when its `after`
// predecessor has settled — `settle: 'done'` waits for the whole job (image, check, safety verdict), `'stored'` only
// for the predecessor's image to be stored (or its job to fail). No timers: the engine chains promises only.

//
// P5-TRUTH item 8 (COMIC_RUN_CHAINS, B7's first real body): with `chains` on, pages of one scene draw one after another
// and each continues from the page right before it; different scenes still draw side by side. Scenes are the ledger's
// (page.continuity.sceneId), else derived from places (continuity.ts deriveScenes): a page with no place continues the
// scene before it, so the Ramayana case's inland page 3 still follows page 2. The book's first page is drawn alone first
// (it sets the look), as today. Off (the default): today's order and anchor, unchanged.
// Wall time (measured in schedule.test.ts with the runner's 3 slots, 25 s a page, 5 s check): the 10-page one-scene
// case goes from about 120 s to about 255 s (+135 s); a book split into scenes pays only for its longest scene.

import { runChains, sceneIndex } from '../../../../shared/comic/continuity.js';
import { type ComicDoc, type Page } from '../../../../shared/comic/doc.js';
import { canServeToOwner } from '../../../../shared/comic/safety.js';
import { nearestReadyBefore } from '../../../../shared/comic/sendable.js';

/** The run options the job runner passes (read once per request from p5Flags). */
export interface ScheduleOptions {
  /** COMIC_RUN_CHAINS for this user: scene chains and the real previous page. */
  chains?: boolean;
}

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

/**
 * The run's order and dependencies. Today (chains off): page 1 alone, then the rest and the cover after it. With chains:
 * each page waits for the page right before it when both are in this run and in one scene; each scene's first page
 * waits for the book's first page (when it is in the run); the cover still waits for the first page of the run.
 */
export function scheduleRun(doc: ComicDoc, pageIds: readonly string[], opts: ScheduleOptions = {}): RunSchedule {
  if (opts.chains) {
    const plan = runChains(doc, pageIds);
    const known = new Set(doc.pages.map((p) => p.id));
    const after: Record<string, string | null> = {};
    for (const id of pageIds) after[id] = known.has(id) ? (plan.after[id] ?? null) : null;
    const order = plan.chains.flatMap((c) => c.pageIds);
    for (const id of pageIds) if (!order.includes(id)) order.push(id);
    // Inside a chain a page starts once the page before it is stored (pro plan §4.2), not after its page check: the
    // check of page k runs while page k+1 draws. The stored page is 'ready' with its asset (safety verdict pending,
    // which previousPageFor accepts as canServeToOwner does), so page k+1 is drawn from it.
    return { order, after, coverAfter: pageIds[0] ?? null, settle: 'stored' };
  }
  const [first, ...rest] = pageIds;
  const after: Record<string, string | null> = {};
  if (first) after[first] = null;
  for (const id of rest) after[id] = first ?? null;
  return { order: [...pageIds], after, coverAfter: first ?? null, settle: 'done' };
}

const drawnForReference = (p: Page): boolean => p.render.status === 'ready' && !!p.render.asset?.path && canServeToOwner(p.render.asset);

/**
 * The page a page's drawing continues from (PREVIOUS PAGE reference, continuityPath). Today: nearestReadyBefore (any
 * earlier drawn page). With chains: the nearest drawn page before it IN ITS SCENE (normally page n−1, which the run
 * waited for); none at a scene's first page, so another scene's light and place never leak in as "continuity".
 */
export function previousPageFor(doc: ComicDoc, page: Page, opts: { assumeDrawn?: ReadonlySet<string> } & ScheduleOptions = {}): Page | undefined {
  if (!opts.chains) return nearestReadyBefore(doc, page);
  const scenes = sceneIndex(doc, { derive: true });
  const scene = scenes.byPage[page.id];
  const before = doc.pages.filter((p) => p.n < page.n && p.id !== page.id).sort((a, b) => b.n - a.n);
  for (const p of before) {
    if (scenes.byPage[p.id] !== scene) return undefined;
    if (drawnForReference(p) || opts.assumeDrawn?.has(p.id)) return p;
  }
  return undefined;
}
