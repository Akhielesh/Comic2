// @vitest-environment node
// P5-TRUTH wiring in the job runner: COMIC_STORY_FIXES reaches every compile and the writer, COMIC_RUN_CHAINS reaches the
// run order and the previous page. Each flag is a stage (off | admins | all) read once per run from the server env.
// Fakes only: no paid call, no network, synthetic docs.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_CAPS } from '../../../shared/comic/capabilities.js';
import type { AssetRef, ComicDoc } from '../../../shared/comic/doc.js';
import { scheduleRun } from './consistency/schedule.js';
import { JOB_TIMINGS, planPages, startAction } from './jobs.js';
import { writePagePlan } from './writer.js';
import { fakeImages, newSession, plannedDoc, testContext } from './orchestrator.fakes.js';
import { onRenderVerdict, checkRenderSafety } from './safety/index.js';
import { analyzePageRender } from './vision.js';

vi.mock('./vision.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./vision.js')>();
  return { ...actual, analyzePageRender: vi.fn(actual.analyzePageRender) };
});
vi.mock('./safety/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./safety/index.js')>();
  return { ...actual, onRenderVerdict: vi.fn(actual.onRenderVerdict), checkRenderSafety: vi.fn(actual.checkRenderSafety) };
});
vi.mock('./consistency/schedule.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./consistency/schedule.js')>();
  return { ...actual, scheduleRun: vi.fn(actual.scheduleRun) };
});

vi.mock('./writer.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./writer.js')>();
  return { ...actual, writePagePlan: vi.fn(actual.writePagePlan) };
});

const TIMINGS = { ...JOB_TIMINGS };
const ENV = { fixes: process.env.COMIC_STORY_FIXES, chains: process.env.COMIC_RUN_CHAINS };
const QC = { score: 0.9, issues: [] as string[], checkedAt: 1 };
const drawn = (name: string): AssetRef => ({ path: `u/user-1/p/proj-1/img/${name}.webp`, source: 'generated', at: 1, w: 800, h: 1200, safety: { assessed: 'G', at: 1 } });

beforeEach(() => {
  JOB_TIMINGS.retryBackoffMs = 0;
  JOB_TIMINGS.saveRetryMs = 0;
  vi.spyOn(console, 'info').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.mocked(analyzePageRender).mockResolvedValue({ qc: { ...QC }, balloons: [] } as never);
  vi.mocked(onRenderVerdict).mockResolvedValue(undefined);
  vi.mocked(checkRenderSafety).mockResolvedValue(undefined);
  delete process.env.COMIC_STORY_FIXES;
  delete process.env.COMIC_RUN_CHAINS;
});
afterEach(() => {
  Object.assign(JOB_TIMINGS, TIMINGS);
  vi.restoreAllMocks();
  vi.mocked(scheduleRun).mockClear();
  for (const [k, v] of [['COMIC_STORY_FIXES', ENV.fixes], ['COMIC_RUN_CHAINS', ENV.chains]] as const) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

/** The three-page market comic with drawn sheets, and a smile on Maya's card. */
const smilingDoc = (): ComicDoc => {
  const doc = plannedDoc();
  doc.cast = doc.cast.map((c) => ({ ...c, look: c.id === 'c_maya' ? { ...c.look, face: 'freckles, a wide warm smile' } : c.look, sheet: { status: 'ready', asset: drawn(`sheet-${c.id}`), history: [] } }));
  return doc;
};

const continuityDoc = (count = 3): ComicDoc => {
  const doc = smilingDoc();
  for (let n = 4; n <= count; n += 1) {
    const base = doc.pages[2];
    doc.pages.push({ ...base, id: `pg_${n}`, n, summary: `Page ${n} beat`, panels: base.panels.map((p, i) => ({ ...p, id: `pn_${n}_${i + 1}`, action: `Action ${n}.${i + 1}`, lines: p.lines.map((line, k) => ({ ...line, id: `ln_${n}_${i}_${k}` })) })) });
  }
  doc.style.board = drawn('style-board');
  return doc;
};

const renderAll = async (admin: boolean, count = 3) => {
  const session = newSession(continuityDoc(count));
  const ctx = testContext(session, { caps: { ...DEFAULT_CAPS, admin } });
  const started = await startAction(ctx, { type: 'render_pages' }, { confirmed: true });
  await started.done;
  const pageCall = (n: number) => ctx.imagesFake.calls.find((c) => c.prompt.includes(`Action ${n}.1`))!;
  return { session, ctx, pageCall };
};

describe('COMIC_STORY_FIXES in the job runner', () => {
  it('admins stage: an admin\'s page prompts lose the card\'s smile; a non-admin\'s keep today\'s prompt', async () => {
    process.env.COMIC_STORY_FIXES = 'admins';
    const admin = await renderAll(true);
    for (const n of [1, 2]) expect(admin.pageCall(n).prompt).not.toContain('smile');
    expect(admin.pageCall(1).prompt).toContain('face: freckles');
    const user = await renderAll(false);
    expect(user.pageCall(1).prompt).toContain('a wide warm smile');
  });

  it('off (unset): everyone gets today\'s prompt', async () => {
    expect((await renderAll(true)).pageCall(1).prompt).toContain('a wide warm smile');
  });
});

describe('COMIC_RUN_CHAINS in the job runner', () => {
  it('default non-admin runs continue all five pages from the immediate predecessor while keeping original sheet/style references and one call per page', async () => {
    const { session, ctx, pageCall } = await renderAll(false, 5);
    expect(ctx.imagesFake.calls).toHaveLength(5);
    for (let n = 2; n <= 5; n += 1) {
      const current = session.doc.pages[n - 1].render;
      expect(current.continuityPath).toBe(session.doc.pages[n - 2].render.asset?.path);
      expect(pageCall(n).references.some((ref) => ref.label === 'PREVIOUS PAGE')).toBe(true);
      expect(pageCall(n).references.some((ref) => ref.label.includes('CHARACTER SHEET'))).toBe(true);
      expect(pageCall(n).references.some((ref) => ref.label.includes('STYLE'))).toBe(true);
    }
    expect(session.doc.pages.every((page) => page.render.status === 'ready')).toBe(true);
    expect(ctx.billingFake.reserves.filter((reservation) => reservation.stage === 'page')).toHaveLength(5);
  });

  it('keeps legacy limited-reference models on the existing schedule without removing their cast/style references', async () => {
    const doc = continuityDoc();
    doc.imageModel = { modelId: 'nano-banana-legacy', lockedAt: 1, origin: 'migrated' };
    const session = newSession(doc);
    const ctx = testContext(session, { caps: { ...DEFAULT_CAPS, admin: false, modelOverride: true } });
    const started = await startAction(ctx, { type: 'render_pages' }, { confirmed: true });
    expect(started.outcome.status).toBe('started');
    await started.done;
    expect(vi.mocked(scheduleRun).mock.calls[0]).toHaveLength(2);
    expect(ctx.imagesFake.calls).toHaveLength(3);
    expect(ctx.imagesFake.calls.every((call) => call.spec.id === 'nano-banana-legacy')).toBe(true);
    expect(ctx.imagesFake.calls.every((call) => call.references.length <= 3)).toBe(true);
    expect(ctx.imagesFake.calls[1].references.some((ref) => ref.label.includes('STYLE'))).toBe(true);
  });

  it('cancels a five-page chain without dispatching its queued pages or replacing existing artwork', async () => {
    const doc = continuityDoc(5);
    doc.pages[4].render = { status: 'ready', asset: drawn('original-page-five'), history: [] };
    const original = structuredClone(doc.pages[4].render);
    const session = newSession(doc);
    let began!: () => void;
    let release!: () => void;
    const firstStarted = new Promise<void>((resolve) => { began = resolve; });
    const images = fakeImages(async () => {
      began();
      await new Promise<void>((resolve) => { release = resolve; });
      return undefined;
    });
    const ctx = testContext(session, { images, caps: { ...DEFAULT_CAPS, admin: false } });
    const started = await startAction(ctx, { type: 'render_pages', force: true }, { confirmed: true });
    await firstStarted;
    expect(session.doc.pages.slice(1).every((page) => page.render.status === 'queued')).toBe(true);
    session.abort.abort();
    release();
    await started.done;
    expect(images.calls).toHaveLength(1);
    expect(session.doc.pages[4].render).toMatchObject(original);
    expect(session.doc.pages.every((page) => !['queued', 'rendering'].includes(page.render.status))).toBe(true);
  });

  it('admins: an admin\'s run is scheduled as scene chains and page 3 is drawn from page 2', async () => {
    process.env.COMIC_RUN_CHAINS = 'admins';
    const { session, pageCall } = await renderAll(true);
    expect(vi.mocked(scheduleRun)).toHaveBeenCalledWith(expect.anything(), ['pg_1', 'pg_2', 'pg_3'], { chains: true });
    const page = (id: string) => session.doc.pages.find((p) => p.id === id)!.render;
    // The PREVIOUS PAGE reference is attached and recorded by path (VersionMeta.continuityPath).
    expect(pageCall(3).references.some((r) => r.label === 'PREVIOUS PAGE')).toBe(true);
    expect(page('pg_3').continuityPath).toBe(page('pg_2').asset?.path);
    expect(page('pg_2').continuityPath).toBe(page('pg_1').asset?.path);
  });

  it('all enables scene continuity for a non-admin author', async () => {
    process.env.COMIC_RUN_CHAINS = 'all';
    const { session } = await renderAll(false);
    expect(vi.mocked(scheduleRun)).toHaveBeenCalledWith(expect.anything(), ['pg_1', 'pg_2', 'pg_3'], { chains: true });
    const page = (id: string) => session.doc.pages.find((p) => p.id === id)!.render;
    expect(page('pg_3').continuityPath).toBe(page('pg_2').asset?.path);
  });

  it('off: paired scheduling remains available with exactly one draw per page', async () => {
    process.env.COMIC_RUN_CHAINS = 'off';
    const { session, ctx } = await renderAll(true);
    expect(vi.mocked(scheduleRun)).toHaveBeenCalledWith(expect.anything(), ['pg_1', 'pg_2', 'pg_3']);
    expect(vi.mocked(scheduleRun).mock.calls[0]).toHaveLength(2);
    const page = (id: string) => session.doc.pages.find((p) => p.id === id)!.render;
    expect(ctx.imagesFake.calls).toHaveLength(3);
    expect(page('pg_3').continuityPath).toBe(page('pg_2').asset?.path);
  });
});

describe('COMIC_STORY_FIXES reaches the writer', () => {
  const plan = async (admin: boolean) => {
    vi.mocked(writePagePlan).mockClear();
    vi.mocked(writePagePlan).mockImplementation(async ({ doc, llm }) => {
      await llm.complete({ role: 'writer', messages: [{ role: 'user', content: 'plan' }] });
      return { pages: doc.pages, newCast: [], model: 'writer-x' };
    });
    const ctx = testContext(newSession(plannedDoc()), { caps: { ...DEFAULT_CAPS, admin } });
    await planPages(ctx, { instructions: 'tighten page 2' });
    return vi.mocked(writePagePlan).mock.calls[0][0];
  };

  it('admins stage: an admin\'s plan is written with the crowd-line fixes; a non-admin\'s and an unset flag are not', async () => {
    process.env.COMIC_STORY_FIXES = 'admins';
    expect((await plan(true)).storyFixes).toBe(true);
    expect((await plan(false)).storyFixes).toBeUndefined();
    delete process.env.COMIC_STORY_FIXES;
    expect((await plan(true)).storyFixes).toBeUndefined();
  });
});
