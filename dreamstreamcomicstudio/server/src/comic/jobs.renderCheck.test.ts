// @vitest-environment node
// PUB-1: every page the render pipeline draws gets the image-only safety check (S14) right away, side by side with the
// page check, so the stored verdict is already by:'check' and the publish gate spends nothing on that picture. Through
// the real job runner: the page check is a spy on vision.ts, the image check runs on the fake platform LLM
// (installSafetyFakes). Fakes only: no paid call, no network, a synthetic doc.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { emptyRender, type ComicDoc } from '../../../shared/comic/doc.js';
import type { LlmRequest } from './types.js';
import { effectiveRating, type ContentRating, type SafetyVerdict } from '../../../shared/comic/safety.js';
import { logger } from '../lib/logger.js';
import { JOB_TIMINGS, runAction } from './jobs.js';
import { newSession, plannedDoc, testContext, type TestContext } from './orchestrator.fakes.js';
import { cleanAnswer } from './safety/fakes.js';
import { runPublishGate, takePageCheckSlot } from './safety/index.js';
import { CAPS } from './safety/deps.js';
import { installSafetyFakes, resetSafety, type SafetyFakes } from './safety/testkit.js';
import { analyzePageRender } from './vision.js';

vi.mock('./vision.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./vision.js')>();
  return { ...actual, analyzePageRender: vi.fn(actual.analyzePageRender) };
});

let fakes: SafetyFakes;
const TIMINGS = { ...JOB_TIMINGS };
beforeEach(() => {
  JOB_TIMINGS.retryBackoffMs = 0;
  JOB_TIMINGS.saveRetryMs = 0;
  for (const m of ['info', 'warn', 'error'] as const) vi.spyOn(console, m).mockImplementation(() => undefined);
  fakes = installSafetyFakes();
});
afterEach(() => {
  Object.assign(JOB_TIMINGS, TIMINGS);
  resetSafety();
  vi.mocked(analyzePageRender).mockReset();
  vi.restoreAllMocks();
});

const IMAGE_REQ = { role: 'vision', messages: [], jsonSchema: { name: 'comic_safety_image', schema: {} } } as LlmRequest;
/** The fake platform LLM's answer to one image-only check. */
const imageSays = (rating: 'G' | 'PG' | 'PG-13' | 'X', categories: string[] = []) => ({ ...cleanAnswer(IMAGE_REQ), rating, categories });
const imageCalls = () => fakes.llm.calls.filter((c) => c.jsonSchema?.name === 'comic_safety_image');
/** The page check's (QC) answer, with the safety block it folded in (absent ⇒ none). */
const pageCheck = (safety?: SafetyVerdict) => ({ qc: { score: 0.9, issues: [], checkedAt: 1 }, balloons: [], model: 'fake-qc', ...(safety ? { safety } : {}) }) as never;
const deferred = <T>() => {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
};

const GOOD = 'u/user-1/p/proj-1/img/good.webp';
/** One planned page, sheets drawn; optionally a previous drawing that passed and the comic's chosen rating. */
const onePageDoc = (opts: { previous?: boolean; rating?: ContentRating } = {}): ComicDoc => {
  const doc = plannedDoc();
  if (opts.rating) doc.settings = { ...doc.settings, rating: opts.rating };
  doc.pages = doc.pages.slice(0, 1);
  doc.format.pageCount = 1;
  doc.cast.forEach((c) => (c.sheet = { ...emptyRender(), status: 'ready', asset: { path: `${c.id}.webp`, source: 'generated', at: 1, w: 1536, h: 1024 } }));
  if (opts.previous) {
    doc.pages[0].render = { ...emptyRender(), status: 'ready', asset: { path: GOOD, source: 'generated', at: 1, w: 1024, h: 1536, safety: { assessed: 'G', by: 'check', at: 1 } } };
  }
  return doc;
};
const drawPage = async (doc: ComicDoc = onePageDoc()): Promise<{ ctx: TestContext; path: string }> => {
  const ctx = testContext(newSession(doc));
  await runAction(ctx, { type: 'render_pages', pageIds: ['pg_1'], force: true }, { confirmed: true });
  await ctx.settled();
  const drawn = ctx.session.doc.pages[0].render.history.find((v) => v.path !== GOOD)?.path ?? ctx.session.doc.pages[0].render.asset!.path;
  return { ctx, path: drawn };
};
const storedVerdict = (ctx: TestContext, path: string): SafetyVerdict | undefined => {
  const r = ctx.session.doc.pages[0].render;
  return [r.asset, ...r.history].find((a) => a?.path === path)?.safety;
};
const publishedPaths = (ctx: TestContext) => ctx.events.flatMap((e) => (e.type === 'urls' ? Object.keys(e.urls) : []));
const noticeTexts = (ctx: TestContext) =>
  ctx.session.doc.conversation.flatMap((m) => (m.cards || []).flatMap((c) => (c.type === 'notice' ? [c.text] : [])));
const renderEvents = () => fakes.store.events.filter((e) => e.surface === 'render').map((e) => ({ layer: e.layer, decision: e.decision, assessed: e.assessed }));

describe('render-time image check (PUB-1)', () => {
  it('a page the page check passes at PG-13 and the image check rates PG is stored PG-13 by:check (never looser than either)', async () => {
    vi.mocked(analyzePageRender).mockResolvedValue(pageCheck({ assessed: 'PG-13', categories: ['violence'], by: 'qc', at: 2 }));
    fakes.llm.script.vision = [imageSays('PG', ['scary'])];
    const { ctx, path } = await drawPage();
    expect(imageCalls()).toHaveLength(1);
    expect(storedVerdict(ctx, path)).toMatchObject({ assessed: 'PG-13', by: 'check', categories: ['violence', 'scary'] });
    expect(publishedPaths(ctx)).toContain(path);
  });

  // The image check is the stricter side: a wiring slip that stored the page check's answer as by:'check' would let a
  // picture the image check rated over the comic (or X) be vouched for at $0, and the gate would clear it unseen.
  it('the page check says G and the image check PG-13 on a PG comic: stored PG-13 by:check, the over-rating notice, and the gate holds it with no image call', async () => {
    const doc = onePageDoc({ rating: 'PG' });
    expect(effectiveRating(doc).rating).toBe('PG');
    vi.mocked(analyzePageRender).mockResolvedValue(pageCheck({ assessed: 'G', by: 'qc', at: 2 }));
    fakes.llm.script.vision = [imageSays('PG-13', ['violence'])];
    const { ctx, path } = await drawPage(doc);
    expect(storedVerdict(ctx, path)).toMatchObject({ assessed: 'PG-13', by: 'check', categories: ['violence'] });
    expect(noticeTexts(ctx).some((t) => t.includes('came out PG-13') && t.includes('this comic is PG'))).toBe(true);
    const before = imageCalls().length;
    const gate = await runPublishGate(ctx, ctx.session.doc, { pageIds: ['pg_1'], includeCover: false, languages: [] });
    expect(imageCalls().length - before).toBe(0);
    expect(gate.pages.pg_1.status).toBe('over_rating');
    expect(gate.status).not.toBe('cleared');
  });

  it('the page check says G and the image check X: quarantined, the previous version is back, never published', async () => {
    vi.mocked(analyzePageRender).mockResolvedValue(pageCheck({ assessed: 'G', by: 'qc', at: 2 }));
    fakes.llm.script.vision = [imageSays('X', ['graphic_gore'])];
    const { ctx, path } = await drawPage(onePageDoc({ previous: true }));
    expect(path).not.toBe(GOOD);
    expect(ctx.assetsFake.quarantined.map((q) => q.path)).toEqual([path]);
    expect(storedVerdict(ctx, path)).toMatchObject({ assessed: 'X', by: 'check', quarantined: true, categories: ['graphic_gore'] });
    expect(ctx.session.doc.pages[0].render.asset?.path).toBe(GOOD);
    expect(publishedPaths(ctx)).not.toContain(path);
    expect(publishedPaths(ctx)).toContain(GOOD);
    expect(renderEvents().filter((e) => e.decision === 'withhold').map((e) => e.layer)).toEqual(['vision_check', 'vision_check']);
  });

  it('a block only the page check found is recorded and cased as the page check’s, not the image check’s', async () => {
    vi.mocked(analyzePageRender).mockResolvedValue(pageCheck({ assessed: 'X', categories: ['minor_sexual'], by: 'qc', at: 2 }));
    fakes.llm.script.vision = [imageSays('G')];
    const { ctx, path } = await drawPage(onePageDoc({ previous: true }));
    expect(storedVerdict(ctx, path)).toMatchObject({ assessed: 'X', by: 'qc', quarantined: true });
    expect(renderEvents()).toEqual([
      { layer: 'vision_check', decision: 'allow', assessed: 'G' },
      { layer: 'vision_qc', decision: 'withhold', assessed: 'X' }
    ]);
    expect(fakes.store.cases).toHaveLength(1);
    expect(fakes.store.cases[0].target).toMatchObject({ path, check: { by: 'qc', categories: ['minor_sexual'] } });
  });

  it('past the hourly cap a page draw makes no image check: the page check’s verdict stays by:qc for the gate to re-rate', async () => {
    const ctx = testContext(newSession(onePageDoc()));
    for (let i = 0; i < CAPS.pageCheckPerHour; i += 1) expect(takePageCheckSlot(ctx)).toBe(true);
    vi.mocked(analyzePageRender).mockResolvedValue(pageCheck({ assessed: 'PG', by: 'qc', at: 2 }));
    fakes.llm.script.vision = [imageSays('PG')];
    const info = vi.spyOn(logger, 'info');
    await runAction(ctx, { type: 'render_pages', pageIds: ['pg_1'], force: true }, { confirmed: true });
    await ctx.settled();
    const path = ctx.session.doc.pages[0].render.asset!.path;
    expect(imageCalls()).toHaveLength(0);
    expect(storedVerdict(ctx, path)).toMatchObject({ assessed: 'PG', by: 'qc' });
    expect(publishedPaths(ctx)).toContain(path);
    expect(info).toHaveBeenCalledWith('comic_render_check_timing', expect.objectContaining({ capped: true, failedOpen: false }));
  });

  it('logs how long each check took, with no content', async () => {
    vi.mocked(analyzePageRender).mockResolvedValue(pageCheck({ assessed: 'G', by: 'qc', at: 2 }));
    fakes.llm.script.vision = [imageSays('G')];
    const info = vi.spyOn(logger, 'info');
    await drawPage();
    const timing = info.mock.calls.filter(([event]) => event === 'comic_render_check_timing');
    expect(timing).toHaveLength(1);
    const fields = timing[0][1] as Record<string, unknown>;
    expect(Object.keys(fields).sort()).toEqual(['checkMs', 'failedOpen', 'projectId', 'qcMs', 'target']);
    expect(fields).toMatchObject({ projectId: 'proj-1', failedOpen: false, qcMs: expect.any(Number), checkMs: expect.any(Number) });
  });

  it('the image check starts before the page check answers: both are in flight together', async () => {
    const qcDone = deferred<void>();
    const imageDone = deferred<void>();
    let qcAnswered = false;
    let imageStartedWhileQcOpen = false;
    vi.mocked(analyzePageRender).mockImplementation(async () => {
      await qcDone.promise;
      qcAnswered = true;
      return pageCheck({ assessed: 'G', by: 'qc', at: 2 });
    });
    fakes.llm.script.vision = [
      async () => {
        imageStartedWhileQcOpen = !qcAnswered;
        await imageDone.promise;
        return imageSays('G');
      }
    ];
    const ctx = testContext(newSession(onePageDoc()));
    const run = runAction(ctx, { type: 'render_pages', pageIds: ['pg_1'], force: true }, { confirmed: true });
    await vi.waitFor(() => {
      expect(vi.mocked(analyzePageRender)).toHaveBeenCalledTimes(1);
      expect(imageCalls()).toHaveLength(1);
    });
    // Neither has answered yet, and both were asked.
    expect(qcAnswered).toBe(false);
    expect(imageStartedWhileQcOpen).toBe(true);
    imageDone.resolve();
    qcDone.resolve();
    await run;
    await ctx.settled();
    const path = ctx.session.doc.pages[0].render.asset!.path;
    expect(storedVerdict(ctx, path)).toMatchObject({ assessed: 'G', by: 'check' });
  });

  it.each([
    ['passes', imageSays('G')],
    ['also blocks', imageSays('X', ['graphic_gore'])],
    ['is unavailable', null]
  ] as const)('the page check blocks and the image check %s: quarantined, the previous version is back, never published', async (_what, image) => {
    vi.mocked(analyzePageRender).mockResolvedValue(pageCheck({ assessed: 'X', categories: ['graphic_gore'], by: 'qc', at: 2 }));
    fakes.llm.script.vision = [image];
    const { ctx, path } = await drawPage(onePageDoc({ previous: true }));
    expect(ctx.assetsFake.quarantined.map((q) => q.path)).toEqual([path]);
    expect(storedVerdict(ctx, path)).toMatchObject({ assessed: 'X', quarantined: true, categories: expect.arrayContaining(['graphic_gore']) });
    expect(ctx.session.doc.pages[0].render.asset?.path).toBe(GOOD);
    expect(publishedPaths(ctx)).not.toContain(path);
    expect(publishedPaths(ctx)).toContain(GOOD);
    expect(fakes.store.events.some((e) => e.surface === 'render' && e.decision === 'withhold')).toBe(true);
  });

  it('the image check is unavailable: the stored verdict stays the page check’s by:qc (the publish gate still re-rates it)', async () => {
    vi.mocked(analyzePageRender).mockResolvedValue(pageCheck({ assessed: 'PG', by: 'qc', at: 2 }));
    fakes.llm.script.vision = [null];
    const { ctx, path } = await drawPage();
    expect(imageCalls()).toHaveLength(1);
    expect(storedVerdict(ctx, path)).toMatchObject({ assessed: 'PG', by: 'qc' });
    // The gate pays for that one re-rate (S14), exactly as before render-time checks.
    const before = imageCalls().length;
    const gate = await runPublishGate(ctx, ctx.session.doc, { pageIds: ['pg_1'], includeCover: false, languages: [] });
    expect(imageCalls().length - before).toBe(1);
    expect(gate.pages.pg_1.status).toBe('pass');
  });

  it('a cover render makes exactly one image check (no page check, no double call)', async () => {
    fakes.llm.script.vision = [imageSays('PG')];
    const ctx = testContext(newSession(onePageDoc()));
    await runAction(ctx, { type: 'render_cover' }, { confirmed: true });
    await ctx.settled();
    expect(vi.mocked(analyzePageRender)).not.toHaveBeenCalled();
    expect(imageCalls()).toHaveLength(1);
    expect(ctx.session.doc.cover.render.asset?.safety).toMatchObject({ assessed: 'PG', by: 'check' });
  });

  it('the publish gate over a page drawn this way makes zero image calls (only the words are checked)', async () => {
    vi.mocked(analyzePageRender).mockResolvedValue(pageCheck({ assessed: 'G', by: 'qc', at: 2 }));
    fakes.llm.script.vision = [imageSays('G')];
    const { ctx } = await drawPage();
    const before = fakes.llm.calls.length;
    const gate = await runPublishGate(ctx, ctx.session.doc, { pageIds: ['pg_1'], includeCover: false, languages: [] });
    const during = fakes.llm.calls.slice(before).map((c) => c.jsonSchema?.name);
    expect(during).toEqual(['comic_safety_text']);
    expect(gate).toMatchObject({ status: 'cleared', pages: { pg_1: { status: 'pass' } } });
  });
});
