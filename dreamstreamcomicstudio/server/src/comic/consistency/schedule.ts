// Run order for "Render all". Scene chains preserve the immediate previous page while independent scenes can run
// in parallel. The paired schedule is retained for explicit off and models with limited reference capacity.
// A dependent page waits for the full predecessor job so pending artwork never becomes a reference.

import { crossesPageScene, runChains, sceneIndex } from '../../../../shared/comic/continuity.js';
import { type ComicDoc, type Page } from '../../../../shared/comic/doc.js';
import { safetyStatusOf, PLATFORM_CEILING } from '../../../../shared/comic/safety.js';

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
 * The first page establishes the look. The paired fallback gives later consecutive pages one dependency per pair.
 * With chains enabled, every consecutive page in a scene waits for its predecessor.
 */
export function scheduleRun(doc: ComicDoc, pageIds: readonly string[], opts: ScheduleOptions = {}): RunSchedule {
  if (opts.chains) {
    const plan = runChains(doc, pageIds);
    const known = new Set(doc.pages.map((p) => p.id));
    const after: Record<string, string | null> = {};
    for (const id of pageIds) after[id] = known.has(id) ? (plan.after[id] ?? null) : null;
    const order = plan.chains.flatMap((c) => c.pageIds);
    for (const id of pageIds) if (!order.includes(id)) order.push(id);
    return { order, after, coverAfter: pageIds[0] ?? null, settle: 'done' };
  }
  const targets = new Set(pageIds);
  const order = doc.pages.filter((page) => targets.has(page.id)).sort((a, b) => a.n - b.n);
  const [first, ...rest] = order;
  const after: Record<string, string | null> = Object.fromEntries(pageIds.map((id) => [id, null]));
  const scenes = sceneIndex(doc);
  let pending: Page | undefined;
  for (const page of rest) {
    if (pending && page.n === pending.n + 1 && !crossesPageScene(scenes, pending, page)) {
      after[page.id] = pending.id;
      pending = undefined;
    } else {
      after[page.id] = first.id;
      pending = page;
    }
  }
  const known = new Set(order.map((page) => page.id));
  return { order: [...order.map((page) => page.id), ...pageIds.filter((id) => !known.has(id))], after, coverAfter: first?.id ?? null, settle: 'done' };
}

const drawnForReference = (p: Page): boolean => {
  if (p.render.status !== 'ready' || !p.render.asset?.path) return false;
  const safety = safetyStatusOf(p.render.asset.safety, PLATFORM_CEILING);
  return safety === 'pass' || safety === 'unchecked';
};

/**
 * The page a page's drawing continues from (PREVIOUS PAGE reference, continuityPath). In a parallel run, the nearest
 * earlier ready page is used. With chains: the nearest ready page before it IN ITS SCENE (normally page n−1, which the run
 * waited for); none at a scene's first page, so another scene's light and place never leak in as "continuity".
 */
export function previousPageFor(doc: ComicDoc, page: Page, opts: { assumeDrawn?: ReadonlySet<string> } & ScheduleOptions = {}): Page | undefined {
  const before = doc.pages.filter((p) => p.n < page.n && p.id !== page.id).sort((a, b) => b.n - a.n);
  if (!opts.chains) return before.find(drawnForReference);
  const scenes = sceneIndex(doc, { derive: true });
  const scene = scenes.byPage[page.id];
  for (const p of before) {
    if (scenes.byPage[p.id] !== scene) return undefined;
    if (drawnForReference(p) || opts.assumeDrawn?.has(p.id)) return p;
  }
  return undefined;
}
