// @vitest-environment node
// K2b (pro plan §10 Wave 2): the jobs.ts seams for Ship 2. Every stub keeps today's behaviour; each seam is driven here
// through a mocked stub module to show it is really called and wired — the run engine's per-page `after` (from
// schedule.ts; promises only, no timer), the new spend actions through the existing gate (governed users read usage,
// never '$'; zero paid calls), the free actions' dispatch, prepare()'s generated references, versionMeta's parts and
// anchor keys, letterPage's board / findings / panelize, edit_page's region paste-back and render_pages.followFrames.
// Fakes only: no paid call, no network, synthetic docs.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cutFor, emptyRender, findPage, type AssetRef, type ComicDoc, type PanelCuts } from '../../../shared/comic/doc.js';
import { DEFAULT_CAPS } from '../../../shared/comic/capabilities.js';
import { getImageModel, imagePriceUsd, nearestResolution, PLAN_USD_PER_PAGE, PLATFORM_MARKUP, QC_USD_PER_PAGE } from '../../../shared/comic/models.js';
import { ANCHOR_SHEET_RES } from '../../../shared/comic/anchors.js';
import { partsOf } from '../../../shared/comic/parts.js';
import { quoteRenderPages } from '../../../shared/comic/plan.js';
import type { PriceBook } from '../../../shared/comic/modelLock.js';
import { harbourComic } from '../../../shared/comic/__fixtures__/consistencyBooks.js';
import { ACTION_HANDLERS, CORE_ACTION_TYPES } from './actions/index.js';
import { FIX_PANEL_NOT_AVAILABLE, compileFixPanel, finishFixPanel, fixPanelMeta, fixPanelProblem } from './actions/panelFix.js';
import { boardForCheck } from './consistency/contactSheet.js';
import { withFindings } from './consistency/findings.js';
import { runDrawsAnchors, scheduleRun } from './consistency/schedule.js';
import {
  JOB_TIMINGS,
  PAGE_REFERENCE_PATH,
  PANEL_REFERENCE_PATH,
  estimateSpendAction,
  priceImageJobs,
  resolveJobFor,
  runAfter,
  runPinOf,
  startAction
} from './jobs.js';
import { KEYS, newSession, plannedDoc, testContext, TINY_PNG } from './orchestrator.fakes.js';
import { cropForPanel, pasteRegion } from './panelize/raster.js';
import { panelizeAfterLetter } from './panelize/server.js';
import { renderLayoutGuide } from './panelize/wireframe.js';
import { checkRenderSafety, onRenderVerdict } from './safety/index.js';
import { StudioError } from './types.js';
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
  return { ...actual, scheduleRun: vi.fn(actual.scheduleRun), runDrawsAnchors: vi.fn(actual.runDrawsAnchors) };
});
vi.mock('./actions/panelFix.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./actions/panelFix.js')>();
  return {
    ...actual,
    fixPanelProblem: vi.fn(actual.fixPanelProblem),
    compileFixPanel: vi.fn(actual.compileFixPanel),
    finishFixPanel: vi.fn(actual.finishFixPanel),
    fixPanelMeta: vi.fn(actual.fixPanelMeta)
  };
});
vi.mock('./panelize/raster.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./panelize/raster.js')>();
  return { ...actual, cropForPanel: vi.fn(actual.cropForPanel), pasteRegion: vi.fn(actual.pasteRegion) };
});
vi.mock('./panelize/server.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./panelize/server.js')>();
  return { ...actual, panelizeAfterLetter: vi.fn(actual.panelizeAfterLetter) };
});
vi.mock('./consistency/contactSheet.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./consistency/contactSheet.js')>();
  return { ...actual, boardForCheck: vi.fn(actual.boardForCheck) };
});
vi.mock('./consistency/findings.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./consistency/findings.js')>();
  return { ...actual, withFindings: vi.fn(actual.withFindings) };
});
vi.mock('./panelize/wireframe.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./panelize/wireframe.js')>();
  return { ...actual, renderLayoutGuide: vi.fn(actual.renderLayoutGuide) };
});

const TIMINGS = { ...JOB_TIMINGS };
const ANCHORS_ENV = process.env.COMIC_CONSISTENCY_ANCHORS;
const QC = { score: 0.9, issues: [] as string[], checkedAt: 1, panelBoxes: [{ x: 0, y: 0, w: 1, h: 0.5 }, { x: 0, y: 0.5, w: 0.5, h: 0.5 }, { x: 0.5, y: 0.5, w: 0.5, h: 0.5 }] };

beforeEach(() => {
  JOB_TIMINGS.retryBackoffMs = 0;
  JOB_TIMINGS.saveRetryMs = 0;
  vi.spyOn(console, 'info').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.mocked(analyzePageRender).mockResolvedValue({ qc: { ...QC }, balloons: [] } as never);
  vi.mocked(onRenderVerdict).mockResolvedValue(undefined);
  vi.mocked(checkRenderSafety).mockResolvedValue(undefined);
  delete process.env.COMIC_CONSISTENCY_ANCHORS;
});
afterEach(() => {
  Object.assign(JOB_TIMINGS, TIMINGS);
  vi.restoreAllMocks();
  vi.mocked(analyzePageRender).mockReset();
  for (const fn of [scheduleRun, runDrawsAnchors, fixPanelProblem, compileFixPanel, finishFixPanel, fixPanelMeta, cropForPanel, pasteRegion, panelizeAfterLetter, boardForCheck, withFindings, renderLayoutGuide]) {
    (fn as unknown as { mockRestore?: () => void }).mockRestore?.();
  }
  vi.useRealTimers();
  if (ANCHORS_ENV === undefined) delete process.env.COMIC_CONSISTENCY_ANCHORS;
  else process.env.COMIC_CONSISTENCY_ANCHORS = ANCHORS_ENV;
});

const own = (name: string) => `u/user-1/p/proj-1/img/${name}.webp`;
const drawn = (name: string, extra: Partial<AssetRef> = {}): AssetRef => ({ path: own(name), source: 'generated', at: 1, w: 800, h: 1200, safety: { assessed: 'G', at: 1 }, ...extra });
const CUTS: PanelCuts = {
  status: 'ok',
  by: 'detect',
  at: 1,
  cuts: [
    { panelId: 'pn_1_1', drawn: 1, box: { x: 0, y: 0, w: 1, h: 0.5 }, conf: 0.9 },
    { panelId: 'pn_1_2', drawn: 2, box: { x: 0, y: 0.5, w: 0.5, h: 0.5 }, conf: 0.9 },
    { panelId: 'pn_1_3', drawn: 3, box: { x: 0.5, y: 0.5, w: 0.5, h: 0.5 }, conf: 0.9 }
  ]
};
/** plannedDoc with page 1 drawn (checked, with detector cuts) and both cast sheets ready, confirm policy 'always'. */
const drawnDoc = (): ComicDoc => {
  const doc = plannedDoc();
  doc.planStatus = 'approved';
  doc.cast = doc.cast.map((c) => ({ ...c, sheet: { status: 'ready', asset: drawn(`sheet-${c.id}`), history: [] } }));
  doc.pages[0] = { ...doc.pages[0], render: { status: 'ready', asset: drawn('p1'), history: [], qc: { ...QC }, cuts: CUTS } };
  doc.settings = { ...doc.settings, confirm: 'always' };
  return doc;
};
const spendEntries = (doc: ComicDoc) => doc.spend.entries.filter((e) => e.usd > 0);

describe('runAfter: the per-page `after` dependency (promises only)', () => {
  const deferred = () => {
    let resolve!: () => void;
    const promise = new Promise<void>((r) => (resolve = r));
    return { promise, resolve };
  };

  it("settle 'done': an item starts only once its predecessor's run has settled; independent items start at once", async () => {
    const started: string[] = [];
    const gates = { a: deferred(), b: deferred(), c: deferred(), d: deferred() };
    const done = runAfter(
      [
        { id: 'a', after: null },
        { id: 'b', after: 'a' },
        { id: 'c', after: 'b' },
        { id: 'd' }
      ],
      async (item) => {
        started.push(item.id);
        await gates[item.id as keyof typeof gates].promise;
      }
    );
    await Promise.resolve();
    expect(started).toEqual(['a', 'd']);
    gates.d.resolve();
    gates.a.resolve();
    await new Promise((r) => setImmediate(r));
    expect(started).toEqual(['a', 'd', 'b']);
    gates.b.resolve();
    await new Promise((r) => setImmediate(r));
    expect(started).toEqual(['a', 'd', 'b', 'c']);
    gates.c.resolve();
    await done;
  });

  it("settle 'stored': the next item starts when its predecessor's image is stored, before that job finishes", async () => {
    const started: string[] = [];
    const finishA = deferred();
    const done = runAfter(
      [
        { id: 'a', after: null },
        { id: 'b', after: 'a' }
      ],
      async (item, landed) => {
        started.push(item.id);
        if (item.id === 'a') {
          landed(); // image stored; its check is still running
          await finishA.promise;
        }
      },
      'stored'
    );
    await new Promise((r) => setImmediate(r));
    expect(started).toEqual(['a', 'b']);
    finishA.resolve();
    await done;
  });

  it('a failed predecessor never blocks its chain; unknown, self and cyclic dependencies start at once', async () => {
    const started: string[] = [];
    await runAfter(
      [
        { id: 'a', after: null },
        { id: 'b', after: 'a' },
        { id: 'x', after: 'ghost' },
        { id: 's', after: 's' },
        { id: 'p', after: 'q' },
        { id: 'q', after: 'p' }
      ],
      async (item) => {
        started.push(item.id);
        if (item.id === 'a') throw new Error('provider down');
      }
    ).catch(() => undefined);
    expect(started.sort()).toEqual(['a', 'b', 'p', 'q', 's', 'x']);
  });

  it('creates no timer: no setTimeout, no setInterval (the backend stays sleepable)', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'setInterval', 'setImmediate'] });
    const timeout = vi.spyOn(globalThis, 'setTimeout');
    const interval = vi.spyOn(globalThis, 'setInterval');
    const order: string[] = [];
    await runAfter(
      [
        { id: 'p1', after: null },
        { id: 'p2', after: 'p1' },
        { id: 'p3', after: 'p2' }
      ],
      async (item) => {
        order.push(item.id);
      }
    );
    expect(order).toEqual(['p1', 'p2', 'p3']);
    expect(timeout).not.toHaveBeenCalled();
    expect(interval).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('RenderRun honours the schedule (schedule.ts → `after`)', () => {
  /** The pages in the order their images were paid for (the ledger keeps the newest entry first). */
  const paidOrder = (doc: ComicDoc) => doc.spend.entries.map((e) => e.label).filter((l) => /^Page \d+$/.test(l)).reverse();

  it("the stub is today's order: page 1 alone, then the rest", async () => {
    const doc = plannedDoc();
    doc.cast = doc.cast.map((c) => ({ ...c, sheet: { status: 'ready', asset: drawn(`sheet-${c.id}`), history: [] } }));
    const session = newSession(doc);
    const ctx = testContext(session);
    const started = await startAction(ctx, { type: 'render_pages' }, { confirmed: true });
    await started.done;
    expect(vi.mocked(scheduleRun)).toHaveBeenCalledWith(expect.anything(), ['pg_1', 'pg_2', 'pg_3']);
    expect(paidOrder(session.doc)[0]).toBe('Page 1');
    expect(paidOrder(session.doc).sort()).toEqual(['Page 1', 'Page 2', 'Page 3']);
    expect(session.doc.pages.every((p) => p.render.status === 'ready')).toBe(true);
  });

  it('a chain from the schedule is honoured: page 3 waits for page 2, page 2 for page 1; no image starts early', async () => {
    vi.mocked(scheduleRun).mockImplementation((_doc, ids) => ({ order: [...ids], after: { pg_1: null, pg_2: 'pg_1', pg_3: 'pg_2' }, coverAfter: 'pg_3', settle: 'done' }));
    const doc = plannedDoc();
    doc.cast = doc.cast.map((c) => ({ ...c, sheet: { status: 'ready', asset: drawn(`sheet-${c.id}`), history: [] } }));
    const session = newSession(doc);
    let inFlight = 0;
    let maxInFlight = 0;
    const ctx = testContext(session);
    ctx.imagesFake.behave = async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setImmediate(r));
      inFlight -= 1;
      return undefined;
    };
    const started = await startAction(ctx, { type: 'render_pages', includeCover: true }, { confirmed: true });
    await started.done;
    expect(ctx.imagesFake.calls).toHaveLength(4);
    expect(maxInFlight).toBe(1); // a strict chain: one image at a time
    expect(paidOrder(session.doc)).toEqual(['Page 1', 'Page 2', 'Page 3']);
    expect(session.doc.pages.map((p) => p.render.status)).toEqual(['ready', 'ready', 'ready']);
    expect(session.doc.cover.render.status).toBe('ready');
  });
});

describe('the new spend actions go through the existing gate (zero paid calls)', () => {
  it('fix_panel: the stub refuses it before any quote, gate or spend', async () => {
    const session = newSession(drawnDoc());
    const ctx = testContext(session);
    const started = await startAction(ctx, { type: 'fix_panel', pageId: 'pg_1', panelId: 'pn_1_2', mode: 'fix', instruction: 'Make the scarf red' } as never, { confirmed: true });
    await started.done;
    expect(started.outcome).toMatchObject({ status: 'blocked', message: FIX_PANEL_NOT_AVAILABLE });
    expect(session.doc.gate).toBeNull();
    expect(ctx.imagesFake.calls).toHaveLength(0);
    expect(ctx.billingFake.reserves).toHaveLength(0);
    expect(spendEntries(session.doc)).toEqual([]);
  });

  it('fix_panel quotes one panel job (locked model one tier down + one check) and stops at a gate; governed users read usage, never "$"', async () => {
    vi.mocked(fixPanelProblem).mockReturnValue(null);
    const doc = drawnDoc();
    const est = estimateSpendAction(doc, { type: 'fix_panel', pageId: 'pg_1', panelId: 'pn_1_2', mode: 'fix' }, false);
    const { spec, resolution } = resolveJobFor(runPinOf(doc), 'panel');
    expect(est.imageCount).toBe(1);
    expect(est.usd).toBe(Math.round((imagePriceUsd(spec, resolution) + QC_USD_PER_PAGE) * PLATFORM_MARKUP * 10000) / 10000);
    const session = newSession(doc);
    const ctx = testContext(session, { caps: { ...DEFAULT_CAPS } });
    const started = await startAction(ctx, { type: 'fix_panel', pageId: 'pg_1', panelId: 'pn_1_2', mode: 'fix', instruction: 'Make the scarf red' } as never, { confirmed: false });
    expect(started.outcome.status).toBe('gated');
    const gate = session.doc.gate!;
    expect(gate.action).toMatchObject({ type: 'fix_panel', pageId: 'pg_1', panelId: 'pn_1_2' });
    expect(gate.title).toBe('Fix panel 2 on page 1?');
    expect(gate.summary).not.toContain('$');
    expect(session.doc.conversation.at(-1)!.text).not.toContain('$');
    expect(ctx.imagesFake.calls).toHaveLength(0);
  });

  it('fix_panel: a confirmed tap whose quote went stale is gated again instead of spending', async () => {
    vi.mocked(fixPanelProblem).mockReturnValue(null);
    const doc = drawnDoc();
    doc.settings = { ...doc.settings, confirm: 'never' };
    const session = newSession(doc);
    const ctx = testContext(session);
    const started = await startAction(ctx, { type: 'fix_panel', pageId: 'pg_1', panelId: 'pn_1_2', mode: 'redraw', quotedUsd: 0.001 } as never, { confirmed: true });
    expect(started.outcome.status).toBe('gated');
    expect(session.doc.gate!.reason).toBe('policy');
    expect(ctx.imagesFake.calls).toHaveLength(0);
  });

  it('enrich_pages: quoted at the writer price and gated; confirmed, the stub runs nothing and charges nothing', async () => {
    const doc = drawnDoc();
    const est = estimateSpendAction(doc, { type: 'enrich_pages', pageIds: ['pg_1', 'pg_2'] }, false);
    expect(est).toEqual({ usd: Math.round(PLAN_USD_PER_PAGE * 2 * PLATFORM_MARKUP * 10000) / 10000, imageCount: 0, model: 'Writer', lines: [{ label: 'page details', count: 2, usd: est.usd }] });
    const session = newSession(doc);
    const ctx = testContext(session, { caps: { ...DEFAULT_CAPS } });
    const gated = await startAction(ctx, { type: 'enrich_pages', pageIds: ['pg_1', 'pg_2'] } as never, { confirmed: false });
    expect(gated.outcome.status).toBe('gated');
    expect(session.doc.gate!.title).toBe('Add detail to pages 1–2?');
    expect(session.doc.gate!.summary).not.toContain('$');
    const run = await startAction(ctx, { type: 'enrich_pages', pageIds: ['pg_1'], quotedUsd: est.usd } as never, { confirmed: true });
    expect(run.outcome).toMatchObject({ status: 'blocked', code: 'NOT_AVAILABLE' });
    expect(ctx.llmFake.calls).toHaveLength(0);
    expect(spendEntries(session.doc)).toEqual([]);
  });

  it('the free actions reach their stubs, which say so and change nothing', async () => {
    for (const action of [
      { type: 'panelize_page', pageId: 'pg_1' },
      { type: 'rebind_panels', pageId: 'pg_1', order: [2, 1, 3] },
      { type: 'apply_finding', pageId: 'pg_1', findingId: 'f_1' },
      { type: 'flatten_page', pageId: 'pg_1' }
    ]) {
      const session = newSession(drawnDoc());
      const ctx = testContext(session);
      const before = session.doc.pages;
      const started = await startAction(ctx, action as never, { confirmed: false });
      expect(started.outcome).toMatchObject({ status: 'blocked', code: 'NOT_AVAILABLE' });
      expect(session.doc.pages).toBe(before);
      expect(session.doc.conversation.at(-1)!.role).toBe('assistant');
      expect(ctx.imagesFake.calls).toHaveLength(0);
    }
  });

  it('the action registry is unchanged until shared/comic/doc.ts names the Ship 2 types (then it lists them)', () => {
    for (const type of ['panelize_page', 'rebind_panels', 'apply_finding', 'flatten_page', 'enrich_pages']) expect(ACTION_HANDLERS[type]).toBeUndefined();
    expect(CORE_ACTION_TYPES.has('fix_panel')).toBe(false);
  });
});

describe('fix_panel through the run engine (B8 hooks mocked): generated references, paste-back, version meta', () => {
  const compiled = (doc: ComicDoc) => {
    const { spec, resolution } = resolveJobFor(runPinOf(doc), 'panel');
    return {
      spec,
      resolution,
      aspect: '2:3' as const,
      prompt: 'PANEL FIX test prompt',
      references: [
        { label: 'Image 1: PANEL TO FIX', path: PANEL_REFERENCE_PATH },
        { label: 'Image 2: CURRENT PAGE', path: PAGE_REFERENCE_PATH }
      ]
    };
  };

  it('no panel crop can be made (raster stub): the job fails before any reservation or image call', async () => {
    vi.mocked(fixPanelProblem).mockReturnValue(null);
    vi.mocked(compileFixPanel).mockImplementation((doc) => compiled(doc) as never);
    const doc = drawnDoc();
    doc.settings = { ...doc.settings, confirm: 'never' };
    const session = newSession(doc);
    const ctx = testContext(session);
    const started = await startAction(ctx, { type: 'fix_panel', pageId: 'pg_1', panelId: 'pn_1_2', mode: 'fix', instruction: 'Red scarf' } as never, { confirmed: true });
    await started.done;
    expect(vi.mocked(cropForPanel)).toHaveBeenCalledWith(expect.objectContaining({ box: cutFor(doc.pages[0], 'pn_1_2')!.box, context: 0.04 }));
    expect(ctx.imagesFake.calls).toHaveLength(0);
    expect(spendEntries(session.doc)).toEqual([]);
    // The page keeps its drawing (keepStatusOnFailure).
    expect(findPage(session.doc, 'pg_1')!.render).toMatchObject({ status: 'ready', asset: { path: own('p1') } });
  });

  it('with the crop and paste-back in place: one panel call, a new page version (origin edit, parent, parts, the hook’s cuts)', async () => {
    vi.mocked(fixPanelProblem).mockReturnValue(null);
    vi.mocked(compileFixPanel).mockImplementation((doc) => compiled(doc) as never);
    vi.mocked(cropForPanel).mockResolvedValue('data:image/png;base64,CROP');
    vi.mocked(finishFixPanel).mockImplementation(async ({ base }) => `${await base()}#pasted`);
    vi.mocked(fixPanelMeta).mockImplementation((doc) => ({ cuts: doc.pages[0].render.cuts }));
    const doc = drawnDoc();
    doc.settings = { ...doc.settings, confirm: 'never' };
    const session = newSession(doc);
    const ctx = testContext(session);
    const started = await startAction(ctx, { type: 'fix_panel', pageId: 'pg_1', panelId: 'pn_1_2', mode: 'fix', instruction: 'Red scarf' } as never, { confirmed: true });
    await started.done;
    expect(ctx.imagesFake.calls).toHaveLength(1);
    expect(ctx.imagesFake.calls[0].references.map((r) => r.label)).toEqual(['Image 1: PANEL TO FIX', 'Image 2: CURRENT PAGE']);
    expect(ctx.imagesFake.calls[0].references[0].dataUrl).toBe('data:image/png;base64,CROP');
    expect(ctx.billingFake.reserves[0]).toMatchObject({ operation: 'comic.image.panel' });
    expect(ctx.callsFake.rows.at(-1)).toMatchObject({ kind: 'panel', outcome: 'ok', refs: 2 });
    const page = findPage(session.doc, 'pg_1')!;
    expect(page.render.asset!.path).not.toBe(own('p1'));
    expect(page.render).toMatchObject({ status: 'ready', origin: 'edit', parentPath: own('p1'), cuts: CUTS, parts: partsOf(session.doc, page) });
    expect(page.render.history.map((v) => v.path)).toContain(own('p1'));
    const entry = session.doc.spend.entries.find((e) => e.label.startsWith('Panel 2 on page 1'))!;
    expect(entry).toMatchObject({ refs: 2, outcome: 'ok' });
  });

  it('a paste-back that cannot be made is billed honestly and changes nothing on the page', async () => {
    vi.mocked(fixPanelProblem).mockReturnValue(null);
    vi.mocked(compileFixPanel).mockImplementation((doc) => compiled(doc) as never);
    vi.mocked(cropForPanel).mockResolvedValue('data:image/png;base64,CROP');
    const doc = drawnDoc();
    doc.settings = { ...doc.settings, confirm: 'never' };
    const session = newSession(doc);
    const ctx = testContext(session);
    const started = await startAction(ctx, { type: 'fix_panel', pageId: 'pg_1', panelId: 'pn_1_2', mode: 'fix', instruction: 'Red scarf' } as never, { confirmed: true });
    await started.done;
    const page = findPage(session.doc, 'pg_1')!;
    expect(page.render.asset!.path).toBe(own('p1'));
    expect(page.render.error).toMatch(/couldn't be put into the page/);
    expect(session.doc.spend.entries.some((e) => /not placed/.test(e.label))).toBe(true);
  });
});

describe('versionMeta stamps parts and the anchors really attached (pro plan §5.2, I3)', () => {
  it('a drawn page records partsOf and its anchor keys; an edit keeps the parent', async () => {
    const doc = plannedDoc();
    doc.cast = doc.cast.map((c) => ({ ...c, sheet: { status: 'ready', asset: drawn(`sheet-${c.id}`), history: [] } }));
    const session = newSession(doc);
    const ctx = testContext(session);
    await (await startAction(ctx, { type: 'render_pages', pageIds: ['pg_2'], force: true }, { confirmed: true })).done;
    const p2 = findPage(session.doc, 'pg_2')!;
    expect(p2.render.parts).toEqual(partsOf(session.doc, p2));
    expect(p2.render.anchorKeys).toEqual(expect.arrayContaining(['char:c_maya', 'char:c_arjun']));
    // Only what was really attached: an anchor whose image can't load is not counted.
    const missing = plannedDoc();
    missing.cast = missing.cast.map((c) => ({ ...c, sheet: { status: 'ready', asset: drawn(`sheet-${c.id}`), history: [] } }));
    const s2 = newSession(missing);
    const c2 = testContext(s2);
    const load = c2.assetsFake.loadDataUrl.bind(c2.assetsFake);
    c2.assetsFake.loadDataUrl = async (path: string) => {
      if (path.includes('sheet-c_arjun')) throw new Error('gone');
      return load(path);
    };
    await (await startAction(c2, { type: 'render_pages', pageIds: ['pg_2'], force: true }, { confirmed: true })).done;
    expect(findPage(s2.doc, 'pg_2')!.render.anchorKeys).toEqual(['char:c_maya']);
  });
});

describe('letterPage → board, findings, panelize (through their stubs)', () => {
  it('the board rides the check call, findings shape the report, and a fresh drawing is panelized (ops committed)', async () => {
    vi.mocked(boardForCheck).mockResolvedValue({ board: { tiles: 3 } });
    vi.mocked(withFindings).mockImplementation((qc) => ({ ...qc, checkV: 2, findings: [{ id: 'f_1', kind: 'identity', panel: 1, severity: 'minor', note: 'Scarf colour' }] }));
    vi.mocked(panelizeAfterLetter).mockImplementation(async (_ctx, input) => [
      { op: 'render', target: { kind: 'page', id: input.pageId }, patch: { cuts: { status: 'ok', by: 'detect', at: 7, cuts: [{ drawn: 1, box: { x: 0, y: 0, w: 1, h: 1 }, conf: 0.9 }] } } }
    ]);
    const doc = plannedDoc();
    doc.cast = doc.cast.map((c) => ({ ...c, sheet: { status: 'ready', asset: drawn(`sheet-${c.id}`), history: [] } }));
    const session = newSession(doc);
    const ctx = testContext(session);
    await (await startAction(ctx, { type: 'render_pages', pageIds: ['pg_1'], force: true }, { confirmed: true })).done;
    expect(vi.mocked(analyzePageRender).mock.calls[0][0]).toMatchObject({ board: { tiles: 3 } });
    const page = findPage(session.doc, 'pg_1')!;
    expect(page.render.qc).toMatchObject({ checkV: 2, findings: [{ id: 'f_1' }] });
    expect(page.render.cuts).toMatchObject({ by: 'detect', at: 7 });
    expect(vi.mocked(panelizeAfterLetter).mock.calls[0][1]).toMatchObject({ pageId: 'pg_1', path: page.render.asset!.path, dataUrl: TINY_PNG });
  });

  it('a helper that throws never fails the paid render', async () => {
    vi.mocked(boardForCheck).mockRejectedValue(new Error('sharp crashed'));
    vi.mocked(withFindings).mockImplementation(() => {
      throw new Error('bad reading');
    });
    vi.mocked(panelizeAfterLetter).mockRejectedValue(new Error('detector crashed'));
    const doc = plannedDoc();
    doc.cast = doc.cast.map((c) => ({ ...c, sheet: { status: 'ready', asset: drawn(`sheet-${c.id}`), history: [] } }));
    const session = newSession(doc);
    const ctx = testContext(session);
    await (await startAction(ctx, { type: 'render_pages', pageIds: ['pg_1'], force: true }, { confirmed: true })).done;
    const page = findPage(session.doc, 'pg_1')!;
    expect(page.render.status).toBe('ready');
    expect(page.render.qc).toMatchObject({ score: 0.9 });
    expect(page.render.cuts).toBeUndefined();
  });
});

describe('edit_page → raster.pasteRegion; render_pages.followFrames → a guide from the frames', () => {
  it('a region edit goes through pasteRegion; the stub stores the whole edited image (today); a real paste is stored', async () => {
    const doc = drawnDoc();
    doc.settings = { ...doc.settings, confirm: 'never' };
    const session = newSession(doc);
    const ctx = testContext(session);
    const region = { x: 0.1, y: 0.1, w: 0.3, h: 0.3 };
    await (await startAction(ctx, { type: 'edit_page', pageId: 'pg_1', instruction: 'Add a lantern', region }, { confirmed: true })).done;
    expect(vi.mocked(pasteRegion)).toHaveBeenCalledWith(expect.objectContaining({ region, feather: 0.02, drawn: TINY_PNG }));
    const first = findPage(session.doc, 'pg_1')!.render;
    expect(first).toMatchObject({ origin: 'edit', parentPath: own('p1') });
    expect(ctx.assetsFake.files.get(first.asset!.path)).toBe(TINY_PNG);
    vi.mocked(pasteRegion).mockImplementation(async (input) => ({ dataUrl: `${await input.base()}#region`, pasted: true }));
    await (await startAction(ctx, { type: 'edit_page', pageId: 'pg_1', instruction: 'Add a lantern', region }, { confirmed: true })).done;
    const second = findPage(session.doc, 'pg_1')!.render;
    // The base is the version the edit started from (its parent), the pasted result is what is stored.
    expect(second.parentPath).toBe(first.asset!.path);
    expect(ctx.assetsFake.files.get(second.asset!.path)).toBe(`${TINY_PNG}#region`);
    // Without a region nothing is pasted (the whole edit, as today).
    vi.mocked(pasteRegion).mockClear();
    await (await startAction(ctx, { type: 'edit_page', pageId: 'pg_1', instruction: 'Brighter' }, { confirmed: true })).done;
    expect(vi.mocked(pasteRegion)).not.toHaveBeenCalled();
  });

  it('“Redraw with my layout” draws the layout guide from the page’s frames (flag off), and never without frames', async () => {
    const doc = drawnDoc();
    doc.settings = { ...doc.settings, confirm: 'never' };
    doc.pages[0] = { ...doc.pages[0], artMode: 'panels', panels: doc.pages[0].panels.map((pn, j) => ({ ...pn, frame: { box: CUTS.cuts[j].box } })) };
    const session = newSession(doc);
    const ctx = testContext(session);
    await (await startAction(ctx, { type: 'render_pages', pageIds: ['pg_1'], force: true, followFrames: true } as never, { confirmed: true })).done;
    expect(vi.mocked(renderLayoutGuide)).toHaveBeenCalledWith(CUTS.cuts.map((c) => c.box), expect.any(String), expect.any(String));
    vi.mocked(renderLayoutGuide).mockClear();
    await (await startAction(ctx, { type: 'render_pages', pageIds: ['pg_2'], force: true, followFrames: true } as never, { confirmed: true })).done;
    expect(vi.mocked(renderLayoutGuide)).not.toHaveBeenCalled();
  });
});

describe('render_pages anchors: quoted only once the run draws them, re-priced by kind', () => {
  const bookAt = (factor: number): PriceBook => ({
    unit: (modelId, res) => {
      const spec = getImageModel(modelId);
      return { usd: spec ? imagePriceUsd(spec, res) * factor : null, basis: `test ×${factor}` };
    },
    qcUsd: QC_USD_PER_PAGE
  });

  it("today (the stub): the quote is byte-identical to quoteRenderPages without anchors, even with the kinds flag on", () => {
    process.env.COMIC_CONSISTENCY_ANCHORS = 'places,props';
    const doc = harbourComic();
    const plain = quoteRenderPages(doc, { byok: false, tier: doc.settings.quality, modelOverride: doc.settings.imageModelOverride, holdBack: {} });
    expect(estimateSpendAction(doc, { type: 'render_pages' }, false)).toEqual({ usd: plain.usd, imageCount: plain.imageCount, model: plain.model, lines: plain.lines });
  });

  it("once the run draws anchors: their lines are quoted ('none' opts out) and a PriceBook re-prices each by kind", () => {
    vi.mocked(runDrawsAnchors).mockReturnValue(true);
    process.env.COMIC_CONSISTENCY_ANCHORS = 'places,props';
    const doc = harbourComic();
    const opts = { byok: false, tier: doc.settings.quality, modelOverride: doc.settings.imageModelOverride, holdBack: {} };
    const withAnchors = quoteRenderPages(doc, { ...opts, anchors: { mode: 'auto', kinds: { places: true, props: true, styleKey: false, sheetV2: false }, layoutGuide: false } });
    expect(withAnchors.anchors!.lines.length).toBeGreaterThan(0);
    const est = estimateSpendAction(doc, { type: 'render_pages' }, false);
    expect(est.lines).toEqual(withAnchors.lines);
    expect(est.usd).toBe(withAnchors.usd);
    expect(estimateSpendAction(doc, { type: 'render_pages', anchors: 'none' }, false).lines).toEqual(quoteRenderPages(doc, opts).lines);
    // PriceBook: base lines priced as today, anchor lines by kind (places/props as a 'place' job at 1K).
    const prices = bookAt(2);
    const priced = estimateSpendAction(doc, { type: 'render_pages' }, false, prices);
    const base = estimateSpendAction(doc, { type: 'render_pages', anchors: 'none' }, false, prices);
    expect(priced.lines.slice(0, base.lines.length)).toEqual(base.lines);
    const pin = runPinOf(doc);
    const { spec } = resolveJobFor(pin, 'place');
    const placeUnit = imagePriceUsd(spec, nearestResolution(spec, ANCHOR_SHEET_RES)) * 2;
    for (const line of withAnchors.anchors!.lines) {
      const got = priced.lines[base.lines.length + withAnchors.anchors!.lines.indexOf(line)];
      if (line.kind === 'refs') expect(got).toEqual({ label: line.label, count: line.count, usd: line.usd });
      else if (line.kind === 'sheet') expect(got).toEqual(priceImageJobs(doc, [{ kind: 'sheet', count: line.count, label: line.label }], false, prices, pin).lines[0]);
      else expect(got).toEqual({ label: line.label, count: line.count, usd: Math.round(placeUnit * line.count * PLATFORM_MARKUP * 10000) / 10000 });
    }
    expect(priced.usd).toBe(Math.round(priced.lines.reduce((s, l) => s + l.usd, 0) * 10000) / 10000);
  });
});

void StudioError;
void KEYS;
