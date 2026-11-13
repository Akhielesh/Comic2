// @vitest-environment node
// Default scene pairs and optional full scene chains, using the same dependency runner as real renders.
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
    // The next page starts after the predecessor's safety verdict, including in a chain.
    expect(run.settle).toBe('done');
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

  it('the default draws page 1 first, then consecutive pairs without serializing the book', () => {
    const doc = loadRamayanaCase();
    const run = scheduleRun(doc, ids(doc));
    expect(ids(doc).map((pageId) => run.after[pageId])).toEqual([null, ...[1, 2, 1, 4, 1, 6, 1, 8, 1].map((n) => id(doc, n))]);
    expect(scheduleRun(doc, ids(doc), { chains: false })).toEqual(run);
  });

  it('starts a new pair at a recorded scene cut, a changed location, or a gap in requested pages', () => {
    const doc = loadRamayanaCase();
    doc.scenes = [{ id: 'shore', name: 'Shore' }, { id: 'later', name: 'Later at the shore' }];
    pageByN(doc, 1).continuity = { sceneId: 'shore' };
    pageByN(doc, 3).continuity = { sceneId: 'later' };
    pageByN(doc, 2).panels.at(-1)!.placeId = 'pl_01';
    pageByN(doc, 3).panels[0].placeId = 'pl_01';
    pageByN(doc, 8).panels.at(-1)!.placeId = 'pl_01';
    pageByN(doc, 9).panels[0].placeId = 'pl_02';
    const targets = [1, 2, 3, 4, 6, 8, 9, 10].map((n) => id(doc, n));
    const run = scheduleRun(doc, targets);
    expect(targets.map((pageId) => run.after[pageId])).toEqual([null, ...[1, 1, 3, 1, 1, 1, 9].map((n) => id(doc, n))]);
    expect(run.order).toEqual(targets);
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

  it('does not pick an unfinished safety verdict as previous art', () => {
    const doc = loadRamayanaCase();
    pageByN(doc, 2).render.asset!.safety = { pending: true, at: 1 };
    expect(previousPageFor(doc, pageByN(doc, 3), { chains: true })?.n).toBe(1);
    expect(previousPageFor(doc, pageByN(doc, 3))?.n).toBe(1);
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

  it('the 10-page one-scene case: the default pairs match the old parallel wall time in the controlled run', async () => {
    const doc = loadRamayanaCase();
    const pages = ids(doc);
    const schedule = scheduleRun(doc, pages);
    const unpaired = { ...schedule, after: Object.fromEntries(pages.map((page, i) => [page, i ? pages[0] : null])) };
    const paired = await wallSeconds(schedule, schedule.order);
    const old = await wallSeconds(unpaired, pages);
    const chained = await wallSeconds(scheduleRun(doc, ids(doc), { chains: true }), ids(doc));
    expect(old).toBe(4 * (IMAGE_S + CHECK_S));
    expect(paired).toBe(old);
    expect(chained).toBe(10 * (IMAGE_S + CHECK_S));
  });

  it('the 20-page one-scene shape: the default pairs also match the old parallel wall time', async () => {
    const doc = loadRamayanaCase();
    doc.pages = Array.from({ length: 20 }, (_, i) => ({ ...doc.pages[i % doc.pages.length], id: `race_${i + 1}`, n: i + 1 }));
    const pages = ids(doc);
    const schedule = scheduleRun(doc, pages);
    const unpaired = { ...schedule, after: Object.fromEntries(pages.map((page, i) => [page, i ? pages[0] : null])) };
    expect(pages.filter((page, i) => i > 0 && schedule.after[page] === pages[i - 1])).toHaveLength(10);
    expect(await wallSeconds(unpaired, pages)).toBe(240);
    expect(await wallSeconds(schedule, schedule.order)).toBe(240);
  });

  it('two scenes of five pages run side by side: the extra time is about one scene, not the whole book', async () => {
    const doc = twoScenes();
    const chained = await wallSeconds(scheduleRun(doc, ids(doc), { chains: true }), ids(doc));
    // Page 1, then the five-page Lanka chain in parallel with pages 2–5.
    expect(chained).toBe(6 * (IMAGE_S + CHECK_S));
    expect(chained).toBeLessThan(await wallSeconds(scheduleRun(loadRamayanaCase(), ids(doc), { chains: true }), ids(doc)));
  });
});
