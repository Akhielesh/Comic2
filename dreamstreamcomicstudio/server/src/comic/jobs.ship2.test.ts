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
import { getImageModel, imagePriceUsd, nearestResolution, PLATFORM_MARKUP, QC_USD_PER_PAGE } from '../../../shared/comic/models.js';
import { ANCHOR_SHEET_RES } from '../../../shared/comic/anchors.js';
import { partsOf } from '../../../shared/comic/parts.js';
import { quoteRenderPages } from '../../../shared/comic/plan.js';
import type { PriceBook } from '../../../shared/comic/modelLock.js';
import { harbourComic } from '../../../shared/comic/__fixtures__/consistencyBooks.js';
import { ACTION_HANDLERS, CORE_ACTION_TYPES } from './actions/index.js';
import { ENRICH_USD_PER_PAGE } from './actions/consistency.js';
import { FIX_PANEL_NOT_AVAILABLE, compileFixPanel, finishFixPanel, fixPanelMeta, fixPanelProblem } from './actions/panelFix.js';
import { boardForCheck } from './consistency/contactSheet.js';
import { withFindings } from './consistency/findings.js';
import { runDrawsAnchors, scheduleRun } from './consistency/schedule.js';
import {
  JOB_TIMINGS,
  PAGE_REFERENCE_PATH,
  anchorSheetJobFor,
  PANEL_REFERENCE_PATH,
  estimateSpendAction,
  priceImageJobs,
  resolveJobFor,
  runAfter,
  runPinOf,
  startAction
} from './jobs.js';
import { KEYS, newSession, plannedDoc, testContext, TINY_PNG } from './orchestrator.fakes.js';
import { cropForPanel, PANEL_CROP_CONTEXT, pasteRegion } from './panelize/raster.js';
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
  // PANEL_CROP_CONTEXT is B8's to tune: a value other than the stub's shows jobs.ts passes raster's own constant.
  return { ...actual, PANEL_CROP_CONTEXT: 0.06, cropForPanel: vi.fn(actual.cropForPanel), pasteRegion: vi.fn(actual.pasteRegion) };
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
    const failed: string[] = [];
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
        // runJob records a failed drawing (provider down, blocked…) and returns: that is a failure, not a throw.
        if (item.id === 'a') failed.push(item.id);
      }
    );
    expect(failed).toEqual(['a']);
    expect(started.sort()).toEqual(['a', 'b', 'p', 'q', 's', 'x']);
  });

  it('a predecessor that throws stops its chain, and the run settles only after everything already started has finished', async () => {
    const started: string[] = [];
    const finished: string[] = [];
    const gate = deferred();
    let settled = false;
    const done = runAfter(
      [
        { id: 'a', after: null },
        { id: 'b', after: 'a' },
        { id: 'x', after: null }
      ],
      async (item) => {
        started.push(item.id);
        if (item.id === 'a') throw new Error('restore failed');
        await gate.promise;
        finished.push(item.id);
      }
    ).then(
      () => ((settled = true), null),
      (err: Error) => ((settled = true), err)
    );
    await new Promise((r) => setImmediate(r));
    expect(started).toEqual(['a', 'x']); // b never starts: a threw (today's rule: a throw from page 1 stops the rest)
    expect(settled).toBe(false); // x is still drawing: the run is not over
    gate.resolve();
    expect(((await done) as Error).message).toBe('restore failed');
    expect(finished).toEqual(['x']);
  });

  it("settle 'stored': a dependent already drawing when its predecessor throws is waited for before the run fails", async () => {
    const finished: string[] = [];
    const gate = deferred();
    let settled = false;
    const done = runAfter(
      [
        { id: 'a', after: null },
        { id: 'b', after: 'a' }
      ],
      async (item, landed) => {
        if (item.id === 'a') {
          landed(); // image stored, then its follow-up throws
          await new Promise((r) => setImmediate(r));
          throw new Error('letter failed');
        }
        await gate.promise;
        finished.push(item.id);
      },
      'stored'
    ).then(
      () => ((settled = true), null),
      (err: Error) => ((settled = true), err)
    );
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    expect(settled).toBe(false);
    gate.resolve();
    expect(((await done) as Error).message).toBe('letter failed');
    expect(finished).toEqual(['b']);
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

  it("fix_panel started unconfirmed (the director) always stops at a 'redraw' gate under the 'big' policy, however small", async () => {
    vi.mocked(fixPanelProblem).mockReturnValue(null);
    const doc = drawnDoc();
    doc.settings = { ...doc.settings, confirm: 'big' };
    const est = estimateSpendAction(doc, { type: 'fix_panel', pageId: 'pg_1', panelId: 'pn_1_2', mode: 'fix' }, false);
    expect(est.usd).toBeLessThan(0.5); // under the big-spend line: only the redraw rule stops it
    const session = newSession(doc);
    const ctx = testContext(session);
    const started = await startAction(ctx, { type: 'fix_panel', pageId: 'pg_1', panelId: 'pn_1_2', mode: 'fix', instruction: 'Red scarf' } as never, { confirmed: false });
    expect(started.outcome.status).toBe('gated');
    expect(session.doc.gate!.reason).toBe('redraw');
    expect(ctx.imagesFake.calls).toHaveLength(0);
    expect(ctx.billingFake.reserves).toHaveLength(0);
  });

  it('fix_panel gate titles follow the mode (plan §4.4): Fix, Redraw, Draw, and Redraw … to its new shape', async () => {
    vi.mocked(fixPanelProblem).mockReturnValue(null);
    const titles: Record<string, string> = {};
    for (const mode of ['fix', 'redraw', 'draw', 'extend'] as const) {
      const session = newSession(drawnDoc());
      const ctx = testContext(session);
      await startAction(ctx, { type: 'fix_panel', pageId: 'pg_1', panelId: 'pn_1_3', mode } as never, { confirmed: false });
      titles[mode] = session.doc.gate!.title;
    }
    expect(titles).toEqual({
      fix: 'Fix panel 3 on page 1?',
      redraw: 'Redraw panel 3 on page 1?',
      draw: 'Draw panel 3 on page 1?',
      extend: 'Redraw panel 3 on page 1 to its new shape?'
    });
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

  it('enrich_pages: priced at the writer price; while its stub is inert it is refused before any quote or gate card', async () => {
    const doc = drawnDoc();
    const est = estimateSpendAction(doc, { type: 'enrich_pages', pageIds: ['pg_1', 'pg_2'] }, false);
    // Plan §7: "Add detail to an old page (enrich_pages) | about $0.008" — per page, after the markup.
    expect(ENRICH_USD_PER_PAGE * PLATFORM_MARKUP).toBeCloseTo(0.008, 3);
    expect(est).toEqual({ usd: Math.round(ENRICH_USD_PER_PAGE * 2 * PLATFORM_MARKUP * 10000) / 10000, imageCount: 0, model: 'Writer', lines: [{ label: 'page details', count: 2, usd: est.usd }] });
    expect(est.usd).toBe(0.0156);
    const session = newSession(doc);
    const ctx = testContext(session, { caps: { ...DEFAULT_CAPS } });
    // The inert stub declares its refusal (ActionHandler.unavailable): no quote, no gate card, nothing charged.
    const unconfirmed = await startAction(ctx, { type: 'enrich_pages', pageIds: ['pg_1', 'pg_2'] } as never, { confirmed: false });
    expect(unconfirmed.outcome).toMatchObject({ status: 'blocked', code: 'NOT_AVAILABLE' });
    expect(session.doc.gate ?? null).toBeNull();
    for (const m of session.doc.conversation) expect(m.text).not.toContain('$');
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

  it('the action registry lists the Ship 2 types now that shared/comic/doc.ts names them (fix_panel stays core)', () => {
    for (const type of ['panelize_page', 'rebind_panels', 'apply_finding', 'flatten_page', 'enrich_pages']) expect(ACTION_HANDLERS[type]?.type).toBe(type);
    expect(CORE_ACTION_TYPES.has('fix_panel')).toBe(true);
    expect(ACTION_HANDLERS.fix_panel).toBeUndefined();
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
    expect(PANEL_CROP_CONTEXT).toBe(0.06);
    expect(vi.mocked(cropForPanel)).toHaveBeenCalledWith(expect.objectContaining({ box: cutFor(doc.pages[0], 'pn_1_2')!.box, context: PANEL_CROP_CONTEXT }));
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

  it('a reference that keeps failing never sends a panel fix with no images: it stops before any reservation', async () => {
    vi.mocked(fixPanelProblem).mockReturnValue(null);
    // A compiler that keeps naming a sheet that can't be loaded (four passes, then prepare() gives up on references).
    vi.mocked(compileFixPanel).mockImplementation((doc) => {
      const c = compiled(doc);
      return { ...c, references: [...c.references, { label: 'Image 3: MAYA', path: own('sheet-gone') }] } as never;
    });
    vi.mocked(cropForPanel).mockResolvedValue('data:image/png;base64,CROP');
    const doc = drawnDoc();
    doc.settings = { ...doc.settings, confirm: 'never' };
    const session = newSession(doc);
    const ctx = testContext(session);
    ctx.assetsFake.missing.add(own('sheet-gone'));
    const started = await startAction(ctx, { type: 'fix_panel', pageId: 'pg_1', panelId: 'pn_1_2', mode: 'fix', instruction: 'Red scarf' } as never, { confirmed: true });
    await started.done;
    expect(vi.mocked(compileFixPanel).mock.calls.length).toBeGreaterThanOrEqual(4);
    expect(ctx.imagesFake.calls).toHaveLength(0);
    expect(ctx.billingFake.reserves).toHaveLength(0);
    expect(spendEntries(session.doc)).toEqual([]);
    expect(findPage(session.doc, 'pg_1')!.render).toMatchObject({ status: 'ready', asset: { path: own('p1') } });
  });

  it('a panel fix with a region outlines it on the whole page (the __page__ reference), never on the panel crop', async () => {
    vi.mocked(fixPanelProblem).mockReturnValue(null);
    vi.mocked(compileFixPanel).mockImplementation((doc) => {
      const c = compiled(doc);
      return { ...c, references: [...c.references, { label: 'Image 3: AREA TO CHANGE', path: '__region__' }] } as never;
    });
    vi.mocked(cropForPanel).mockResolvedValue('data:image/png;base64,CROP');
    vi.mocked(finishFixPanel).mockImplementation(async ({ base }) => `${await base()}#pasted`);
    const doc = drawnDoc();
    doc.settings = { ...doc.settings, confirm: 'never' };
    const session = newSession(doc);
    const ctx = testContext(session);
    ctx.assetsFake.files.set(own('p1'), 'data:image/png;base64,PAGE');
    const region = { x: 0.55, y: 0.6, w: 0.2, h: 0.2 };
    await (await startAction(ctx, { type: 'fix_panel', pageId: 'pg_1', panelId: 'pn_1_3', mode: 'fix', instruction: 'Red scarf', region } as never, { confirmed: true })).done;
    expect(ctx.assetsFake.outlines).toEqual([{ dataUrl: 'data:image/png;base64,PAGE', box: region }]);
    expect(ctx.imagesFake.calls[0].references.map((r) => r.dataUrl)).toEqual(['data:image/png;base64,CROP', 'data:image/png;base64,PAGE', 'data:image/png;base64,T1VUTElORUQ=']);
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
    await ctx.settled(); // panelize is tracked, not awaited by the page job
    expect(vi.mocked(analyzePageRender).mock.calls[0][0]).toMatchObject({ board: { tiles: 3 } });
    const page = findPage(session.doc, 'pg_1')!;
    expect(page.render.qc).toMatchObject({ checkV: 2, findings: [{ id: 'f_1' }] });
    expect(page.render.cuts).toMatchObject({ by: 'detect', at: 7 });
    expect(vi.mocked(panelizeAfterLetter).mock.calls[0][1]).toMatchObject({ pageId: 'pg_1', path: page.render.asset!.path, dataUrl: TINY_PNG });
  });

  it('the board helper adds only `board`: it can never replace the billed LLM, the image or the signal', async () => {
    const rogue = { complete: vi.fn() };
    vi.mocked(boardForCheck).mockResolvedValue({ board: { tiles: 2 }, llm: rogue, dataUrl: 'data:image/png;base64,EVIL', signal: new AbortController().signal, doc: null });
    const doc = plannedDoc();
    doc.cast = doc.cast.map((c) => ({ ...c, sheet: { status: 'ready', asset: drawn(`sheet-${c.id}`), history: [] } }));
    const session = newSession(doc);
    const ctx = testContext(session);
    await (await startAction(ctx, { type: 'render_pages', pageIds: ['pg_1'], force: true }, { confirmed: true })).done;
    const args = vi.mocked(analyzePageRender).mock.calls[0][0] as unknown as Record<string, unknown>;
    expect(args.board).toEqual({ tiles: 2 });
    expect(args.dataUrl).toBe(TINY_PNG);
    expect(args.llm).not.toBe(rogue);
    expect((args.doc as ComicDoc).id).toBe(doc.id);
    expect(args.signal).not.toBe(undefined);
    expect((args.signal as AbortSignal).aborted).toBe(false);
  });

  it('a panelize step that never returns holds up neither the page nor the next page of its chain', async () => {
    vi.mocked(scheduleRun).mockImplementation((_doc, ids) => ({ order: [...ids], after: { pg_1: null, pg_2: 'pg_1' }, coverAfter: null, settle: 'done' }));
    let release!: () => void;
    const hang = new Promise<never[]>((r) => (release = () => r([])));
    vi.mocked(panelizeAfterLetter).mockImplementation(() => hang);
    const doc = plannedDoc();
    doc.cast = doc.cast.map((c) => ({ ...c, sheet: { status: 'ready', asset: drawn(`sheet-${c.id}`), history: [] } }));
    const session = newSession(doc);
    const ctx = testContext(session);
    const started = await startAction(ctx, { type: 'render_pages', pageIds: ['pg_1', 'pg_2'], force: true }, { confirmed: true });
    let finished = false;
    void started.done.then(() => (finished = true));
    try {
      await vi.waitFor(() => expect(finished).toBe(true), { timeout: 3000, interval: 5 });
      expect(ctx.imagesFake.calls).toHaveLength(2);
      expect(['pg_1', 'pg_2'].map((id) => findPage(session.doc, id)!.render.status)).toEqual(['ready', 'ready']);
    } finally {
      release();
      await ctx.settled();
    }
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

  const framedDoc = (): ComicDoc => {
    const doc = drawnDoc();
    doc.settings = { ...doc.settings, confirm: 'never' };
    doc.pages[0] = { ...doc.pages[0], artMode: 'panels', panels: doc.pages[0].panels.map((pn, j) => ({ ...pn, frame: { box: CUTS.cuts[j].box } })) };
    return doc;
  };
  const GUIDE_ENV = process.env.COMIC_LAYOUT_GUIDE;
  afterEach(() => {
    if (GUIDE_ENV === undefined) delete process.env.COMIC_LAYOUT_GUIDE;
    else process.env.COMIC_LAYOUT_GUIDE = GUIDE_ENV;
  });

  it('“Redraw with my layout” with COMIC_LAYOUT_GUIDE off draws no guide at all (PD-8): no guide image, no __layout__ reference', async () => {
    delete process.env.COMIC_LAYOUT_GUIDE;
    const session = newSession(framedDoc());
    const ctx = testContext(session);
    await (await startAction(ctx, { type: 'render_pages', pageIds: ['pg_1'], force: true, followFrames: true } as never, { confirmed: true })).done;
    expect(ctx.imagesFake.calls).toHaveLength(1);
    expect(vi.mocked(renderLayoutGuide)).not.toHaveBeenCalled();
    expect(ctx.imagesFake.calls[0].references.map((r) => r.label)).not.toContain('PAGE LAYOUT GUIDE');
    expect(ctx.imagesFake.calls[0].prompt).not.toContain('PAGE LAYOUT GUIDE');
    expect(findPage(session.doc, 'pg_1')!.render.status).toBe('ready');
  });

  it('with COMIC_LAYOUT_GUIDE on, followFrames draws the guide from the page’s frames, and from the blueprint without frames', async () => {
    process.env.COMIC_LAYOUT_GUIDE = '1';
    const session = newSession(framedDoc());
    const ctx = testContext(session);
    await (await startAction(ctx, { type: 'render_pages', pageIds: ['pg_1'], force: true, followFrames: true } as never, { confirmed: true })).done;
    expect(vi.mocked(renderLayoutGuide)).toHaveBeenCalledWith(CUTS.cuts.map((c) => c.box), expect.any(String), expect.any(String));
    expect(ctx.imagesFake.calls[0].references[0].label).toBe('PAGE LAYOUT GUIDE');
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

  it('the run draws each anchor exactly as its quote line priced it (operation, model, resolution) and spends no more than the quote', async () => {
    vi.mocked(runDrawsAnchors).mockReturnValue(true);
    process.env.COMIC_CONSISTENCY_ANCHORS = 'places,props';
    const doc = harbourComic();
    const pin = runPinOf(doc);
    const q = quoteRenderPages(doc, {
      byok: false,
      tier: doc.settings.quality,
      modelOverride: doc.settings.imageModelOverride,
      holdBack: {},
      anchors: { mode: 'auto', kinds: { places: true, props: true, styleKey: false, sheetV2: false }, layoutGuide: false }
    });
    const lines = q.anchors!.lines;
    const count = (kinds: string[]) => lines.filter((l) => kinds.includes(l.kind)).reduce((n, l) => n + l.count, 0);
    // The fixture really exercises every kind: places, a prop and a recurring extra.
    expect(count(['place'])).toBeGreaterThan(0);
    expect(count(['prop'])).toBeGreaterThan(0);
    expect(count(['sheet'])).toBeGreaterThan(0);
    const session = newSession(doc);
    const ctx = testContext(session);
    // The provider bills the list price of what was asked (model × resolution), so a resolution the quote didn't price shows.
    ctx.imagesFake.behave = (req) => ({ costUsd: imagePriceUsd(req.spec, req.resolution) });
    const reserves: { operation: string; resolution?: string; model: string }[] = [];
    const reserve = ctx.billing.reserve.bind(ctx.billing);
    ctx.billing.reserve = async (args) => {
      reserves.push({ operation: args.operation, resolution: args.resolution, model: args.model });
      return reserve(args);
    };
    const est = estimateSpendAction(doc, { type: 'render_pages' }, false, await ctx.prices());
    await (await startAction(ctx, { type: 'render_pages', quotedUsd: est.usd }, { confirmed: true })).done;

    const anchor = anchorSheetJobFor(pin);
    expect(anchor).toMatchObject({ kind: 'place', resolution: nearestResolution(resolveJobFor(pin, 'place').spec, ANCHOR_SHEET_RES) });
    const sheet = resolveJobFor(pin, 'sheet');
    expect(anchor.resolution).not.toBe(sheet.resolution); // the gap this pins: sheets draw at the preset's sheet size
    // Every sheet reservation is a sheet operation (a 'place' job bills as one); place and prop anchors at
    // ANCHOR_SHEET_RES, one each; character sheets (missing ones and recurring-character anchors) at the sheet size.
    const sheetReserves = reserves.filter((r) => r.operation === 'comic.image.sheet');
    expect(sheetReserves).toHaveLength(q.sheetIds.length + count(['sheet', 'place', 'prop']));
    expect(sheetReserves.filter((r) => r.resolution === anchor.resolution)).toHaveLength(count(['place', 'prop']));
    expect(sheetReserves.filter((r) => r.resolution === sheet.resolution)).toHaveLength(q.sheetIds.length + count(['sheet']));
    expect(reserves.every((r) => r.model === sheetReserves[0].model)).toBe(true);
    expect(ctx.imagesFake.calls.filter((c) => c.resolution === anchor.resolution)).toHaveLength(count(['place', 'prop']));
    // What the anchors cost is what their lines quoted, and the run as a whole stays within its quote.
    const anchorNames = [...doc.places.map((p) => `Location: ${p.name}`), 'Sheet: Brass Lantern'];
    const anchorSpend = session.doc.spend.entries.filter((e) => anchorNames.includes(e.label)).reduce((s, e) => s + e.usd, 0);
    const anchorQuoted = est.lines.filter((l) => l.label === 'place sheets' || l.label === 'prop sheets').reduce((s, l) => s + l.usd, 0);
    expect(anchorSpend).toBeCloseTo(anchorQuoted, 3); // within per-entry rounding (0.0001 each)
    const spent = spendEntries(session.doc).reduce((s, e) => s + e.usd, 0);
    expect(spent).toBeLessThanOrEqual(est.usd + 1e-9);
  });
});

void StudioError;
void KEYS;
