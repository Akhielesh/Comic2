// @vitest-environment node
// B7's run order with COMIC_RUN_CHAINS (P5-TRUTH item 8): pages of one scene draw one after another, each from the page
// right before it; scenes still draw side by side. Chains off = today's order (page 1 alone, then everything after it).
import { afterEach, describe, expect, it, vi } from 'vitest';
import { emptyRender, type ComicDoc } from '../../../../shared/comic/doc.js';
import { loadRamayanaCase, pageByN } from '../golden/promptChecks.js';
import { MAX_PARALLEL_IMAGES, runAfter } from '../jobs.js';
import { previousPageFor, scheduleRun, type RunSchedule } from './schedule.js';

const ids = (doc: ComicDoc) => doc.pages.map((p) => p.id);
const id = (doc: ComicDoc, n: number) => pageByN(doc, n).id;

/** The case split into two places: pages 1–5 on the shore, pages 6–10 in Lanka (page 8–10 have no place: they continue Lanka). */
const twoScenes = (): ComicDoc => {
  const doc = loadRamayanaCase();
  doc.places.push({ id: 'pl_02', name: 'Lanka', look: 'Golden city on Trikuta', refs: [], sheet: emptyRender() });
  for (const p of doc.pages) if (p.n >= 6) for (const panel of p.panels) if (panel.placeId) panel.placeId = 'pl_02';
  return doc;
};

describe('scheduleRun with chains (COMIC_RUN_CHAINS)', () => {
  it('the Ramayana case is one scene: page 3 waits for page 2, every page for the one before it', () => {
    const doc = loadRamayanaCase();
    const run = scheduleRun(doc, ids(doc), { chains: true });
    expect(run.after[id(doc, 3)]).toBe(id(doc, 2));
    expect(run.after[id(doc, 1)]).toBeNull();
    for (let n = 2; n <= 10; n += 1) expect(run.after[id(doc, n)], `page ${n}`).toBe(id(doc, n - 1));
    expect(run.order).toEqual(ids(doc));
    expect(run.coverAfter).toBe(id(doc, 1));
    // Inside a chain the next page starts once the page before it is STORED (pro plan §4.2), not after its page check.
    expect(run.settle).toBe('stored');
    // Chains off: today's settle.
    expect(scheduleRun(doc, ids(doc)).settle).toBe('done');
  });

  it('two scenes still run in parallel: the second scene starts after page 1, not after the first scene ends', () => {
    const doc = twoScenes();
    const run = scheduleRun(doc, ids(doc), { chains: true });
    expect(run.after[id(doc, 3)]).toBe(id(doc, 2));
    expect(run.after[id(doc, 5)]).toBe(id(doc, 4));
    // Page 6 opens Lanka: it waits only for the book's first page (which sets the look), never for page 5.
    expect(run.after[id(doc, 6)]).toBe(id(doc, 1));
    expect(run.after[id(doc, 7)]).toBe(id(doc, 6));
    // Pages with no place continue the scene before them.
    expect(run.after[id(doc, 8)]).toBe(id(doc, 7));
  });

  it('a page whose neighbour is not in the run starts at once (its neighbour is already drawn)', () => {
    const doc = loadRamayanaCase();
    const run = scheduleRun(doc, [id(doc, 4), id(doc, 5), id(doc, 7)], { chains: true });
    expect(run.after).toEqual({ [id(doc, 4)]: null, [id(doc, 5)]: id(doc, 4), [id(doc, 7)]: null });
  });

  it('chains off is today: page 1 alone, then every page after it', () => {
    const doc = loadRamayanaCase();
    const run = scheduleRun(doc, ids(doc));
    for (const p of doc.pages.slice(1)) expect(run.after[p.id]).toBe(id(doc, 1));
    expect(scheduleRun(doc, ids(doc), { chains: false })).toEqual(run);
  });

  it('an unknown page id starts at once and keeps its place in the order', () => {
    const doc = loadRamayanaCase();
    const run = scheduleRun(doc, [id(doc, 1), 'pg_gone'], { chains: true });
    expect(run.after['pg_gone']).toBeNull();
    expect(run.order).toEqual([id(doc, 1), 'pg_gone']);
  });
});

describe('previousPageFor with chains', () => {
  it('is page n−1 of the same scene (today it was the nearest drawn page, whatever the scene)', () => {
    const doc = loadRamayanaCase();
    expect(previousPageFor(doc, pageByN(doc, 3), { chains: true })?.n).toBe(2);
    expect(previousPageFor(doc, pageByN(doc, 1), { chains: true })).toBeUndefined();
  });

  it("is none at a scene's first page, and skips an undrawn neighbour only inside its scene", () => {
    const doc = twoScenes();
    expect(previousPageFor(doc, pageByN(doc, 6), { chains: true })).toBeUndefined();
    expect(previousPageFor(doc, pageByN(doc, 6))?.n).toBe(5);
    pageByN(doc, 7).render = { ...emptyRender(), status: 'failed' };
    expect(previousPageFor(doc, pageByN(doc, 8), { chains: true })?.n).toBe(6);
    // assumeDrawn (a run in progress) counts a page the run will have drawn.
    expect(previousPageFor(doc, pageByN(doc, 8), { chains: true, assumeDrawn: new Set([id(doc, 7)]) })?.n).toBe(7);
  });
});

/**
 * Wall time of a run, measured with fake timers on the real engine (runAfter) and a slot pool the size of the job
 * runner's (MAX_PARALLEL_IMAGES; a page holds its slot for its whole job, image and page check, as RenderRun.runJob
 * does). IMAGE_S is the case's page time (research-case §10: about 25 s a page); CHECK_S is a stand-in for the page
 * check and safety verdict after the image is stored.
 */
const IMAGE_S = 25;
const CHECK_S = 5;
const wallSeconds = async (schedule: RunSchedule, pageIds: readonly string[]): Promise<number> => {
  vi.useFakeTimers();
  let free = MAX_PARALLEL_IMAGES;
  const waiting: (() => void)[] = [];
  const acquire = async () => {
    if (free > 0) free -= 1;
    else await new Promise<void>((r) => waiting.push(r));
  };
  const release = () => {
    const next = waiting.shift();
    if (next) next();
    else free += 1;
  };
  const sleep = (s: number) => new Promise<void>((r) => setTimeout(r, s * 1000));
  const start = Date.now();
  const done = runAfter(
    pageIds.map((pid) => ({ id: pid, after: schedule.after[pid] })),
    async (_item, landed) => {
      await acquire();
      try {
        await sleep(IMAGE_S);
        landed();
        await sleep(CHECK_S);
      } finally {
        release();
      }
    },
    schedule.settle
  );
  await vi.runAllTimersAsync();
  await done;
  return (Date.now() - start) / 1000;
};

describe('scene chains: the wall time they cost (measured, not estimated)', () => {
  afterEach(() => vi.useRealTimers());

  it('the 10-page one-scene case: today about 120 s; with chains about 255 s, so about +135 s, not +40 s', async () => {
    const doc = loadRamayanaCase();
    const today = await wallSeconds(scheduleRun(doc, ids(doc)), ids(doc));
    const chained = await wallSeconds(scheduleRun(doc, ids(doc), { chains: true }), ids(doc));
    // Today: page 1 alone (image + check), then 9 pages three at a time.
    expect(today).toBe(4 * (IMAGE_S + CHECK_S));
    // Chains: each page starts when the one before it is stored, so only the last page's check is not overlapped.
    expect(chained).toBe(10 * IMAGE_S + CHECK_S);
    expect(chained - today).toBe(135);
  });

  it('two scenes of five pages run side by side: the extra time is about one scene, not the whole book', async () => {
    const doc = twoScenes();
    const chained = await wallSeconds(scheduleRun(doc, ids(doc), { chains: true }), ids(doc));
    // Page 1, then pages 2-5 and 6-10 as two chains in parallel: the Lanka chain (5 pages after page 1) is the longest,
    // 155 s with free slots; two chains each overlapping a check with the next image want 4 of the 3 slots, so 160 s.
    expect(chained).toBe(IMAGE_S + 5 * IMAGE_S + CHECK_S + CHECK_S);
    expect(chained).toBeLessThan(await wallSeconds(scheduleRun(loadRamayanaCase(), ids(doc), { chains: true }), ids(doc)));
  });
});
