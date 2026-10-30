import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  coverSpecHash,
  emptyRender,
  getRender,
  isPageStale,
  newId,
  pageSpecHash,
  sheetSpecHash,
  type Card,
  type ComicDoc,
  type NextStep,
  type Page
} from '../../../shared/comic/doc.js';
import type { SpendAction } from '../../../shared/comic/ops.js';
import { canServeToOwner } from '../../../shared/comic/safety.js';
import { PLATFORM_MARKUP, QC_USD_PER_PAGE, TIER_PRESETS, estimateJobs, imagePriceUsd, resolveImageJob, type SpendEstimate } from '../../../shared/comic/models.js';
import { logger } from '../lib/logger.js';
import { DEFAULT_CAPS } from '../../../shared/comic/capabilities.js';
import { castOpsForUncast, findUncastBeings } from './castScan.js';
import type { ActionHandler } from './extensions.js';
import { getImageModel } from '../../../shared/comic/models.js';
import { pickImageRoute } from './imageClient.js';
import { resolveTextRoute } from './textModels.js';
import {
  JOB_TIMINGS,
  billedLlm,
  estimateSpendAction,
  gateDecision,
  imageRouteFor,
  newTextSpendTracker,
  nextStepsFor,
  pickDefaultPreset,
  planPages,
  runAction,
  runFeatureAction,
  sanitizePatchOps,
  spendActionIsByok,
  spendIsByok,
  startAction,
  suggestNextSteps,
  type RunActionOptions
} from './jobs.js';
import { KEYS, fakeBilling, fakeImages, lakeDoc, newSession, opsOf, plannedDoc, scriptedLlm, testContext, TINY_PNG, type FakeBilling, type TestContext } from './orchestrator.fakes.js';
import { checkRenderSafety, onRenderVerdict } from './safety/index.js';
import type { StudioSession } from './session.js';
import { StudioError, type StudioKeys } from './types.js';
import { analyzePageRender } from './vision.js';
import { proposeStyleDirections, writePagePlan } from './writer.js';

vi.mock('./vision.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./vision.js')>();
  return { ...actual, analyzePageRender: vi.fn(actual.analyzePageRender) };
});
vi.mock('./writer.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./writer.js')>();
  return { ...actual, writePagePlan: vi.fn(actual.writePagePlan), proposeStyleDirections: vi.fn(actual.proposeStyleDirections) };
});
// The safety seams (P1-SAFETY) and the cast scan (P1-DIRECTOR) are module functions: spy on them.
vi.mock('./safety/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./safety/index.js')>();
  return { ...actual, onRenderVerdict: vi.fn(actual.onRenderVerdict), checkRenderSafety: vi.fn(actual.checkRenderSafety) };
});
vi.mock('./castScan.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./castScan.js')>();
  return { ...actual, findUncastBeings: vi.fn(actual.findUncastBeings), castOpsForUncast: vi.fn(actual.castOpsForUncast) };
});

const quiet = () => {
  vi.spyOn(console, 'info').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
};

const TIMINGS = { ...JOB_TIMINGS };
beforeEach(() => {
  JOB_TIMINGS.retryBackoffMs = 0;
  JOB_TIMINGS.saveRetryMs = 0;
  JOB_TIMINGS.rateLimitRequeueMs = 5;
  JOB_TIMINGS.requeueJitterMs = 0;
  JOB_TIMINGS.requeueMinMs = 0;
  quiet();
  vi.mocked(analyzePageRender).mockRejectedValue(new StudioError('RATE_LIMIT', 'The page checker is busy.', { retryable: true }));
  vi.mocked(onRenderVerdict).mockResolvedValue(undefined);
  vi.mocked(checkRenderSafety).mockResolvedValue(undefined);
  vi.mocked(findUncastBeings).mockReturnValue([]);
  vi.mocked(castOpsForUncast).mockReturnValue([]);
});
afterEach(() => {
  Object.assign(JOB_TIMINGS, TIMINGS);
  vi.mocked(analyzePageRender).mockReset();
  vi.mocked(writePagePlan).mockReset();
  vi.mocked(proposeStyleDirections).mockReset();
  vi.mocked(onRenderVerdict).mockReset();
  vi.mocked(checkRenderSafety).mockReset();
  vi.mocked(findUncastBeings).mockReset();
  vi.mocked(castOpsForUncast).mockReset();
  vi.restoreAllMocks();
});

const estimate = (usd: number): SpendEstimate => ({ usd, imageCount: 1, model: 'Nano Banana 2.1', lines: [] });
const cardsOf = (doc: ComicDoc): Card[] => doc.conversation.flatMap((m) => m.cards || []);
const readyPage = (page: Page, path: string): Page => ({
  ...page,
  render: { ...emptyRender(), status: 'ready', asset: { path, source: 'generated', at: 1, w: 1024, h: 1536 } }
});

// ── Gate decision ────────────────────────────────────────────────────────────

describe('gateDecision', () => {
  const withSettings = (patch: Partial<ComicDoc['settings']>, spent = 0): ComicDoc => {
    const doc = plannedDoc();
    doc.settings = { ...doc.settings, ...patch };
    doc.spend = { ...doc.spend, totalUsd: spent };
    return doc;
  };

  it.each([
    ['always', 0.01, false, 'policy'],
    ['always', 0.01, true, null],
    ['big', 0.49, false, null],
    ['big', 0.51, false, 'policy'],
    ['big', 5, true, null],
    ['never', 50, false, null]
  ] as const)('confirm=%s usd=%s confirmed=%s → %s', (confirm, usd, confirmed, want) => {
    expect(gateDecision(withSettings({ confirm, bigSpendUsd: 0.5 }), estimate(usd), confirmed)).toBe(want);
  });

  it('stops at the budget cap even when confirmed, unless a budget gate was approved', () => {
    const doc = withSettings({ confirm: 'never', budgetUsd: 1 }, 0.8);
    expect(gateDecision(doc, estimate(0.3), true)).toBe('budget');
    expect(gateDecision(doc, estimate(0.3), false)).toBe('budget');
    expect(gateDecision(doc, estimate(0.2), true)).toBeNull();
    expect(gateDecision(doc, estimate(0.3), true, { budgetApproved: true })).toBeNull();
  });

  it('treats a zero/absent budget as no cap', () => {
    expect(gateDecision(withSettings({ confirm: 'never', budgetUsd: 0 }, 99), estimate(10), true)).toBeNull();
  });
});

// ── Estimates ────────────────────────────────────────────────────────────────

describe('estimateSpendAction', () => {
  const price = (kind: 'page' | 'sheet' | 'style_option' | 'cover' | 'edit', byok = false) => {
    const { spec, resolution } = resolveImageJob(kind, 'standard');
    return (imagePriceUsd(spec, resolution) + (kind === 'page' || kind === 'edit' ? QC_USD_PER_PAGE : 0)) * (byok ? 1 : PLATFORM_MARKUP);
  };

  it('style options: 3 by default, else the number of directions', () => {
    const doc = plannedDoc();
    expect(estimateSpendAction(doc, { type: 'render_style_options' }, false).imageCount).toBe(3);
    expect(estimateSpendAction(doc, { type: 'render_style_options', directions: [{ name: 'a', spec: 'b' }, { name: 'c', spec: 'd' }] }, false).imageCount).toBe(2);
  });

  it('sheets: lead/support without a ready sheet, or the forced ids', () => {
    const doc = plannedDoc();
    doc.cast.push({ id: 'c_extra', name: 'Crowd', tier: 'extra', look: { summary: 'people' }, refs: [], sheet: emptyRender() });
    expect(estimateSpendAction(doc, { type: 'render_sheets' }, false).imageCount).toBe(2);
    doc.cast[0].sheet = { ...emptyRender(), status: 'ready', asset: { path: 's.webp', source: 'generated', at: 1 } };
    expect(estimateSpendAction(doc, { type: 'render_sheets' }, false).imageCount).toBe(1);
    expect(estimateSpendAction(doc, { type: 'render_sheets', characterIds: ['c_maya'] }, false).imageCount).toBe(0);
    expect(estimateSpendAction(doc, { type: 'render_sheets', characterIds: ['c_maya'], force: true }, false).imageCount).toBe(1);
    expect(estimateSpendAction(doc, { type: 'render_sheets', characterIds: ['pl_market'] }, false).lines).toEqual([
      { label: 'location sheets', count: 1, usd: expect.any(Number) }
    ]);
  });

  it('pages: undrawn + stale pages, plus missing sheets for their lead/support cast', () => {
    const doc = plannedDoc();
    const est = estimateSpendAction(doc, { type: 'render_pages' }, false);
    expect(est.imageCount).toBe(5);
    expect(est.usd).toBeCloseTo(3 * price('page') + 2 * price('sheet'), 3);
    expect(est.model).toBe('Nano Banana 2.1');

    // Page 1 drawn and current; page 3 drawn but stale; sheets ready for Maya.
    doc.cast[0].sheet = { ...emptyRender(), status: 'ready', asset: { path: 's.webp', source: 'generated', at: 1 } };
    doc.pages[0] = readyPage(doc.pages[0], 'p1.webp');
    doc.pages[0].render.specHash = pageSpecHash(doc, doc.pages[0]);
    doc.pages[2] = readyPage(doc.pages[2], 'p3.webp');
    doc.pages[2].render.specHash = 'outdated';
    const next = estimateSpendAction(doc, { type: 'render_pages' }, false);
    expect(next.lines).toEqual([
      { label: 'pages', count: 2, usd: expect.any(Number) },
      { label: 'character sheets', count: 1, usd: expect.any(Number) }
    ]);
    // Explicit pages + force redraws a current page.
    expect(estimateSpendAction(doc, { type: 'render_pages', pageIds: ['pg_1'], force: true }, false).imageCount).toBe(1);
    expect(estimateSpendAction(doc, { type: 'render_pages', pageIds: ['pg_1'] }, false).imageCount).toBe(0);
  });

  it('edit and cover are one image each; BYOK drops the platform markup', () => {
    const doc = plannedDoc();
    expect(estimateSpendAction(doc, { type: 'edit_page', pageId: 'pg_1', instruction: 'x' }, false).usd).toBeCloseTo(price('edit'), 4);
    expect(estimateSpendAction(doc, { type: 'render_cover' }, true).usd).toBeCloseTo(price('cover', true), 4);
    expect(estimateSpendAction(doc, { type: 'render_cover' }, false).usd).toBeCloseTo(
      estimateJobs([{ kind: 'cover', count: 1 }], 'standard', { byok: false }).usd,
      4
    );
  });

  it('style options add the writer cost only when directions must be proposed', () => {
    const doc = plannedDoc();
    const imagesOnly = estimateJobs([{ kind: 'style_option', count: 3 }], 'standard', { byok: false });
    const proposed = estimateSpendAction(doc, { type: 'render_style_options' }, false);
    expect(proposed.usd).toBeGreaterThan(imagesOnly.usd);
    expect(proposed.lines.some((l) => l.label === 'style directions')).toBe(true);
    // Directions supplied: no writer call, so the image-only quote stands.
    const given = estimateSpendAction(doc, { type: 'render_style_options', directions: [{ name: 'a', spec: 'b' }, { name: 'c', spec: 'd' }] }, false);
    expect(given.lines.some((l) => l.label === 'style directions')).toBe(false);
  });
});

// ── render_pages ─────────────────────────────────────────────────────────────

describe('runAction render_pages', () => {
  it('draws sheets first, page 1 alone, then the rest; records spend, QC fallback balloons and urls', async () => {
    const session = newSession(plannedDoc());
    const ctx = testContext(session);
    await runAction(ctx, { type: 'render_pages' }, { confirmed: true });

    const calls = ctx.imagesFake.calls;
    expect(calls).toHaveLength(5);
    expect(calls.slice(0, 2).every((c) => c.prompt.includes('Character model sheet'))).toBe(true);
    expect(calls[2].prompt).toContain('Action 1.1');
    expect(calls.slice(3).map((c) => (c.prompt.includes('Action 2.1') ? 2 : 3)).sort()).toEqual([2, 3]);
    // Page 1 uses the freshly drawn sheet; later pages get page 1 as continuity.
    expect(calls[2].references.map((r) => r.label)).toContain('CHARACTER SHEET: MAYA');
    expect(calls[3].references.map((r) => r.label)).toContain('PREVIOUS PAGE');

    const doc = session.doc;
    expect(doc.cast.every((c) => c.sheet.status === 'ready' && c.sheet.asset)).toBe(true);
    for (const page of doc.pages) {
      expect(page.render.status).toBe('ready');
      expect(page.render.asset?.path).toMatch(/gen-/);
      expect(page.render.model).toBe('nano-banana-2.1');
      expect(page.render.attempts).toBe(1);
      expect(page.render.specHash).toBe(pageSpecHash(doc, page));
      // QC failed → layout-based balloons for every line, no QC report claimed.
      expect(page.render.qc).toBeUndefined();
      expect(page.balloons.map((b) => b.lineId)).toEqual(page.panels.flatMap((p) => p.lines.map((l) => l.id)));
    }
    expect(doc.planStatus).toBe('approved');

    const entries = doc.spend.entries;
    expect(entries.filter((e) => e.kind === 'sheet')).toHaveLength(2);
    expect(entries.filter((e) => e.kind === 'page').map((e) => e.label).sort()).toEqual(['Page 1', 'Page 2', 'Page 3']);
    for (const e of entries.filter((x) => x.kind === 'page')) {
      expect(e).toMatchObject({ usd: Math.round(0.05 * PLATFORM_MARKUP * 10000) / 10000, byok: false, estimated: false, model: 'nano-banana-2.1' });
    }
    expect(doc.spend.totalUsd).toBeCloseTo(5 * 0.05 * PLATFORM_MARKUP, 4);
    expect(ctx.billingFake.reserves.filter((r) => r.operation === 'comic.image.page')).toHaveLength(3);
    expect(ctx.billingFake.settled.filter((s) => s.imageUnits === 1)).toHaveLength(5);

    const urlEvents = ctx.events.filter((e) => e.type === 'urls');
    expect(urlEvents).toHaveLength(5);
    // UI-started run: the progress message (still the last one) is rewritten in place with the real outcome.
    const progress = doc.conversation.find((m) => m.cards?.some((c) => c.type === 'renders'));
    expect(progress?.text).toMatch(/^Pages 1–3 and 2 sheets are ready \(\$0\.\d\d\)\./);
    expect(doc.conversation.at(-1)?.id).toBe(progress?.id);
    expect(progress?.nextSteps?.length).toBeGreaterThan(0);
    // Activity start/end pairs for every image.
    const starts = ctx.events.filter((e) => e.type === 'activity' && e.phase === 'start' && e.label.startsWith('Drawing page'));
    expect(starts.map((e) => (e as { label: string }).label)).toEqual(expect.arrayContaining(['Drawing page 1', 'Drawing page 2', 'Drawing page 3']));
    // Nothing is left queued, ever.
    expect(opsOf(ctx.events).some((op) => op.op === 'render' && op.patch.status === 'queued')).toBe(true);
  });

  it('commits QC + balloons from vision, keeps pinned balloons, and warns on a low score', async () => {
    const doc = plannedDoc();
    doc.cast.forEach((c) => (c.sheet = { ...emptyRender(), status: 'ready', asset: { path: `${c.id}.webp`, source: 'generated', at: 1 } }));
    doc.pages[1].balloons = [{ lineId: 'ln_2_2', x: 0.5, y: 0.5, w: 0.2, pinned: true }];
    const session = newSession(doc);
    const ctx = testContext(session);
    vi.mocked(analyzePageRender).mockImplementation(async ({ page, llm }) => ({
      ...(await llm.complete({ role: 'vision', messages: [{ role: 'user', content: 'check' }] }).then(() => ({}))),
      qc: { score: page.n === 2 ? 0.3 : 0.9, issues: page.n === 2 ? ['ARJUN is missing from panel 2.'] : [], checkedAt: 1 },
      balloons: page.panels.flatMap((p) => p.lines.map((l) => ({ lineId: l.id, x: 0.1, y: 0.1, w: 0.3 }))),
      costUsd: 0.002,
      model: 'vision-x'
    }));
    await runAction(ctx, { type: 'render_pages' }, { confirmed: true });
    const after = session.doc;
    expect(after.pages[0].render.qc?.score).toBe(0.9);
    expect(after.pages[1].balloons).toEqual([{ lineId: 'ln_2_2', x: 0.5, y: 0.5, w: 0.2, pinned: true }]);
    expect(after.pages[0].balloons).toEqual([{ lineId: 'ln_1_2', x: 0.1, y: 0.1, w: 0.3 }]);
    const warn = cardsOf(after).find((c) => c.type === 'notice' && c.tone === 'warn');
    expect(warn && 'text' in warn ? warn.text : '').toContain('Page 2 may need another pass');
    expect(after.spend.entries.filter((e) => e.kind === 'qc')).toHaveLength(3);
    expect(ctx.imagesFake.calls).toHaveLength(3);
  });

  it('billing denial fails that image, stops the rest (restored, never queued) and posts an error notice', async () => {
    const doc = plannedDoc();
    doc.cast.forEach((c) => (c.sheet = { ...emptyRender(), status: 'ready', asset: { path: `${c.id}.webp`, source: 'generated', at: 1 } }));
    const session = newSession(doc);
    const ctx = testContext(session, { billing: fakeBilling(1) });
    await runAction(ctx, { type: 'render_pages' }, { confirmed: true });
    const after = session.doc;
    expect(after.pages[0].render.status).toBe('ready');
    const others = after.pages.slice(1).map((p) => p.render);
    expect(others.filter((r) => r.status === 'failed')).toHaveLength(1);
    expect(others.filter((r) => r.status === 'none')).toHaveLength(1);
    expect(others.find((r) => r.status === 'failed')?.error).toContain('allowance');
    expect(after.pages.some((p) => p.render.status === 'queued' || p.render.status === 'rendering')).toBe(false);
    expect(ctx.imagesFake.calls).toHaveLength(1);
    const errorCard = cardsOf(after).find((c) => c.type === 'notice' && c.tone === 'error');
    expect(errorCard && 'text' in errorCard ? errorCard.text : '').toContain('allowance');
  });

  it('retries a retryable image error once, and marks a hard error failed with its message', async () => {
    const doc = plannedDoc();
    doc.cast.forEach((c) => (c.sheet = { ...emptyRender(), status: 'ready', asset: { path: `${c.id}.webp`, source: 'generated', at: 1 } }));
    const session = newSession(doc);
    const images = fakeImages((req, i) => {
      if (req.prompt.includes('Action 1.1') && i === 0) return new StudioError('TIMEOUT', 'The image provider timed out.', { retryable: true });
      if (req.prompt.includes('Action 2.1')) return new StudioError('SAFETY_BLOCKED', 'The safety filter blocked this page.', { retryable: false });
      return undefined;
    });
    const ctx = testContext(session, { images });
    await runAction(ctx, { type: 'render_pages' }, { confirmed: true });
    const [p1, p2, p3] = session.doc.pages;
    expect(p1.render).toMatchObject({ status: 'ready', attempts: 2 });
    // A filter refusal gets one automatic safe take (unbilled refusals), then fails honestly.
    expect(p2.render).toMatchObject({ status: 'failed', error: 'The safety filter blocked this page.', attempts: 2 });
    const p2Calls = ctx.imagesFake.calls.filter((c) => c.prompt.includes('Action 2.1'));
    expect(p2Calls).toHaveLength(2);
    expect(p2Calls[1].prompt).toContain('SAFE TAKE');
    expect(p3.render.status).toBe('ready');
    expect(ctx.billingFake.released).toHaveLength(1);
    const progress = session.doc.conversation.find((m) => m.cards?.some((c) => c.type === 'renders'));
    expect(progress?.text).toContain('Page 2 failed — The safety filter blocked this page.');
    expect(progress?.text).toContain('2 of 3 pages are ready');
  });

  it('records money spent on a failed attempt as an estimated spend line', async () => {
    const doc = plannedDoc();
    doc.cast.forEach((c) => (c.sheet = { ...emptyRender(), status: 'ready', asset: { path: `${c.id}.webp`, source: 'generated', at: 1 } }));
    const session = newSession(doc);
    const images = fakeImages(() => Object.assign(new StudioError('NO_IMAGE', 'No image came back.', { retryable: false }), { spentUsd: 0.01 }));
    const ctx = testContext(session, { images });
    await runAction(ctx, { type: 'render_pages', pageIds: ['pg_1'], force: true }, { confirmed: true });
    expect(session.doc.spend.entries.map((e) => e.label)).toEqual(['Page 1 (failed attempt)']);
    expect(ctx.billingFake.settled).toEqual([{ costUsd: 0.01, imageUnits: 0 }]);
  });

  it('bills an earlier paid-but-failed attempt alongside the image when the retry succeeds', async () => {
    const doc = plannedDoc();
    doc.cast.forEach((c) => (c.sheet = { ...emptyRender(), status: 'ready', asset: { path: `${c.id}.webp`, source: 'generated', at: 1 } }));
    const session = newSession(doc);
    // First attempt is paid but returns no image (retryable); the retry succeeds.
    const images = fakeImages((_req, i) => (i === 0 ? Object.assign(new StudioError('NO_IMAGE', 'No image came back.', { retryable: true }), { spentUsd: 0.02 }) : undefined));
    const ctx = testContext(session, { images });
    await runAction(ctx, { type: 'render_pages', pageIds: ['pg_1'], force: true }, { confirmed: true });
    const pageEntries = session.doc.spend.entries.filter((e) => e.kind === 'page');
    // Both are billed (ledger order is newest-first, so assert membership, not sequence).
    expect(pageEntries.map((e) => e.label).sort()).toEqual(['Page 1', 'Page 1 (failed attempt)']);
    expect(session.doc.pages[0].render.status).toBe('ready');
    // The successful settle carries both the image price and the earlier paid attempt.
    expect(ctx.billingFake.settled.filter((s) => s.imageUnits === 1)).toEqual([{ costUsd: Math.round((0.05 + 0.02) * 10000) / 10000, imageUnits: 1 }]);
  });

  it('pins the image model at start, so a mid-run quality change cannot switch it', async () => {
    const doc = plannedDoc();
    doc.cast.forEach((c) => (c.sheet = { ...emptyRender(), status: 'ready', asset: { path: `${c.id}.webp`, source: 'generated', at: 1 } }));
    const session = newSession(doc);
    // Flip to Pro while page 1 is drawing; later pages must still use the quoted Standard model.
    const images = fakeImages((_req, i) => {
      if (i === 0) session.commit([{ op: 'settings', patch: { quality: 'pro' } }]);
      return undefined;
    });
    const ctx = testContext(session, { images });
    await runAction(ctx, { type: 'render_pages' }, { confirmed: true });
    for (const page of session.doc.pages) expect(page.render.model).toBe('nano-banana-2.1');
  });

  it('cancel stops unstarted work and restores previous statuses; in-flight images are kept', async () => {
    const doc = plannedDoc();
    doc.cast.forEach((c) => (c.sheet = { ...emptyRender(), status: 'ready', asset: { path: `${c.id}.webp`, source: 'generated', at: 1 } }));
    doc.pages[2] = readyPage(doc.pages[2], 'old-p3.webp');
    const session = newSession(doc);
    let releaseFirst!: () => void;
    let markStarted!: () => void;
    const firstStarted = new Promise<void>((resolve) => (markStarted = resolve));
    const images = fakeImages(async (_req, i) => {
      if (i === 0) {
        markStarted();
        await new Promise<void>((r) => (releaseFirst = r));
      }
      return undefined;
    });
    const ctx = testContext(session, { images });
    const run = runAction(ctx, { type: 'render_pages', force: true }, { confirmed: true });
    await firstStarted;
    expect(session.doc.pages[1].render.status).toBe('queued');
    session.abort.abort();
    releaseFirst();
    await run;
    const [p1, p2, p3] = session.doc.pages;
    expect(p1.render.status).toBe('ready');
    expect(p2.render.status).toBe('none');
    expect(p3.render).toMatchObject({ status: 'ready', asset: { path: 'old-p3.webp' } });
    expect(ctx.imagesFake.calls).toHaveLength(1);
    const progress = session.doc.conversation.find((m) => m.cards?.some((c) => c.type === 'renders'));
    expect(progress?.text).toContain('Stopped before');
  });

  it('drops a reference that cannot be loaded and recompiles so labels stay aligned', async () => {
    const doc = plannedDoc();
    doc.cast[0].sheet = { ...emptyRender(), status: 'ready', asset: { path: 'gone.webp', source: 'generated', at: 1 } };
    doc.cast[1].sheet = { ...emptyRender(), status: 'ready', asset: { path: 'arjun.webp', source: 'generated', at: 1 } };
    const session = newSession(doc);
    const ctx = testContext(session);
    ctx.assetsFake.missing.add('gone.webp');
    await runAction(ctx, { type: 'render_pages', pageIds: ['pg_2'], force: true }, { confirmed: true });
    const call = ctx.imagesFake.calls[0];
    expect(call.references.map((r) => r.label)).not.toContain('CHARACTER SHEET: MAYA');
    expect(call.references[0].label).toBe('CHARACTER SHEET: ARJUN');
    expect(call.prompt).toContain('Image 1 — CHARACTER SHEET: ARJUN');
    expect(call.prompt).not.toContain('CHARACTER SHEET: MAYA');
    expect(session.doc.pages[1].render.status).toBe('ready');
  });

  it('sets a default style from the best-fitting preset when none was chosen', async () => {
    const doc = plannedDoc();
    doc.style = { status: 'empty', refs: [], options: [] };
    doc.brief.genre = 'crime mystery';
    const session = newSession(doc);
    const ctx = testContext(session);
    await runAction(ctx, { type: 'render_sheets' }, { confirmed: true });
    expect(session.doc.style).toMatchObject({ status: 'drafted', presetId: pickDefaultPreset(doc).id });
    expect(cardsOf(session.doc).some((c) => c.type === 'notice' && c.text.includes('No style was chosen'))).toBe(true);
  });
});

// ── Gating ───────────────────────────────────────────────────────────────────

describe('spend gating', () => {
  it('policy gate: no spend, a gate card; approving runs it', async () => {
    const doc = plannedDoc();
    doc.settings.confirm = 'always';
    const session = newSession(doc);
    const ctx = testContext(session);
    const started = await startAction(ctx, { type: 'render_cover' }, { confirmed: false });
    expect(started.outcome.status).toBe('gated');
    expect(started.outcome.message).toMatch(/^Waiting for the user to approve ~\$0\.\d\d \(the cover on Nano Banana 2\.1\)\.$/);
    expect(ctx.imagesFake.calls).toHaveLength(0);
    const gate = session.doc.gate!;
    expect(gate).toMatchObject({ status: 'open', reason: 'policy', imageCount: 1, model: 'Nano Banana 2.1', action: { type: 'render_cover' } });
    expect(cardsOf(session.doc)).toContainEqual(expect.objectContaining({ type: 'gate', gateId: gate.id }));

    await runAction(ctx, { type: 'approve_gate', gateId: gate.id }, { confirmed: false });
    expect(session.doc.gate?.status).toBe('approved');
    expect(session.doc.cover.render.status).toBe('ready');
    expect(ctx.imagesFake.calls).toHaveLength(1);
  });

  it('collects the gate card for a director turn instead of posting a message', async () => {
    const doc = plannedDoc();
    doc.settings.confirm = 'always';
    const session = newSession(doc);
    const ctx = testContext(session);
    const collected: Card[] = [];
    await startAction(ctx, { type: 'render_pages' }, { confirmed: false, collectCard: (c) => collected.push(c) });
    // The user sees what they approve: the breakdown of the bound pages above the gate (decisions-final #3).
    expect(collected).toEqual([
      expect.objectContaining({ type: 'breakdown', pageIds: ['pg_1', 'pg_2', 'pg_3'], gateId: session.doc.gate!.id }),
      expect.objectContaining({ type: 'gate', gateId: session.doc.gate!.id })
    ]);
    expect(session.doc.conversation).toHaveLength(0);
  });

  it('budget gate applies to confirmed clicks; approving it allows going over once', async () => {
    const doc = plannedDoc();
    doc.settings = { ...doc.settings, confirm: 'never', budgetUsd: 0.05 };
    const session = newSession(doc);
    const ctx = testContext(session);
    await runAction(ctx, { type: 'render_cover' }, { confirmed: true });
    const gate = session.doc.gate!;
    expect(gate.reason).toBe('budget');
    expect(gate.summary).toContain('over your $0.05 budget');
    expect(ctx.imagesFake.calls).toHaveLength(0);
    // The budget gate offers the way to raise the cap, as a chip that opens the comic's settings.
    expect(session.doc.conversation.at(-1)!.nextSteps).toEqual([{ label: 'Raise the budget', client: { type: 'open_settings', section: 'budget' } }]);
    await runAction(ctx, { type: 'approve_gate', gateId: gate.id }, { confirmed: true });
    expect(ctx.imagesFake.calls).toHaveLength(1);
  });

  it('approving a gate runs exactly what was quoted; a grown plan or new model re-quotes', async () => {
    const doc = plannedDoc();
    doc.settings.confirm = 'always';
    const session = newSession(doc);
    const ctx = testContext(session);
    await startAction(ctx, { type: 'render_pages', pageIds: ['pg_1'] }, { confirmed: false });
    const first = session.doc.gate!;
    expect(first.action).toMatchObject({ type: 'render_pages', pageIds: ['pg_1'] });
    // The quality jumps to Pro after the card was shown: approving must not run the pricier spend.
    session.commit([{ op: 'settings', patch: { quality: 'pro' } }]);
    await runAction(ctx, { type: 'approve_gate', gateId: first.id }, { confirmed: false });
    expect(ctx.imagesFake.calls).toHaveLength(0);
    expect(session.doc.gate?.id).not.toBe(first.id);
    expect(session.doc.gate).toMatchObject({ status: 'open', model: 'Nano Banana Pro' });
  });

  it('under confirm "big" (the default) a stale approval re-quotes with a fresh card instead of running the pricier spend', async () => {
    const doc = plannedDoc();
    doc.settings = { ...doc.settings, confirm: 'big', bigSpendUsd: 0.5 };
    const session = newSession(doc);
    const ctx = testContext(session);
    // The director quoted the cover without draw intent (a forced gate), at Standard quality.
    const quoted = await startAction(ctx, { type: 'render_cover' }, { confirmed: false, forceGate: 'no_intent' });
    expect(quoted.outcome.status).toBe('gated');
    const first = session.doc.gate!;
    expect(first).toMatchObject({ status: 'open', reason: 'no_intent', model: 'Nano Banana 2.1' });
    // The user switches quality to Pro (still under bigSpendUsd), then taps Approve on the old card.
    session.commit([{ op: 'settings', patch: { quality: 'pro' } }], { origin: 'user' });
    const proUsd = estimateSpendAction(session.doc, { type: 'render_cover' }, false).usd;
    expect(proUsd).toBeLessThan(0.5);
    await runAction(ctx, { type: 'approve_gate', gateId: first.id }, { confirmed: true, origin: 'user' });
    // Nothing drawn, nothing spent: a NEW open gate at the Pro price that says the price changed.
    expect(ctx.imagesFake.calls).toHaveLength(0);
    expect(session.doc.spend.totalUsd).toBe(0);
    const gate = session.doc.gate!;
    expect(gate.id).not.toBe(first.id);
    expect(gate).toMatchObject({ status: 'open', reason: 'policy', model: 'Nano Banana Pro', estimateUsd: proUsd });
    expect(session.doc.conversation.at(-1)!.text).toContain(`The price changed since that button was shown: the cover is now ≈ $${proUsd.toFixed(2)} (was $${first.estimateUsd.toFixed(2)})`);
    expect(cardsOf(session.doc)).toContainEqual(expect.objectContaining({ type: 'gate', gateId: gate.id }));
  });

  it('approving a gate whose page was deleted meanwhile closes the gate and says which page is gone — never "Approved — drawing now."', async () => {
    const doc = plannedDoc();
    doc.settings = { ...doc.settings, confirm: 'always' };
    for (const c of doc.cast) c.sheet = { ...c.sheet, status: 'ready', asset: { path: `${c.id}.webp`, source: 'generated', at: 1 } };
    const session = newSession(doc);
    const ctx = testContext(session);
    await startAction(ctx, { type: 'render_pages', pageIds: ['pg_3'] }, { confirmed: false });
    const gate = session.doc.gate!;
    expect(gate.status).toBe('open');
    // The user deletes page 3 in the timeline, then taps Approve on the still-visible card.
    session.commit([{ op: 'page_delete', id: 'pg_3', deletedAt: Date.now() }], { origin: 'user' });
    await runAction(ctx, { type: 'approve_gate', gateId: gate.id }, { confirmed: true, origin: 'user' });
    expect(ctx.imagesFake.calls).toHaveLength(0);
    // Closed for a reason the card can name ("Nothing left to draw"), not a plain "Not now".
    expect(session.doc.gate).toMatchObject({ id: gate.id, status: 'declined', closedReason: 'nothing_to_draw' });
    const last = session.doc.conversation.at(-1)!;
    expect(last.text).toMatch(/^Page 3 is no longer in the plan\./);
    expect(last.text).toContain('Nothing was spent.');
  });

  it('an open-ended render gate is pinned to the pages it quoted', async () => {
    const doc = plannedDoc();
    doc.settings.confirm = 'always';
    const session = newSession(doc);
    const ctx = testContext(session);
    await startAction(ctx, { type: 'render_pages' }, { confirmed: false });
    expect(session.doc.gate?.action).toMatchObject({ type: 'render_pages', pageIds: ['pg_1', 'pg_2', 'pg_3'] });
  });

  it('advanced model overrides are paid-plan only on the platform key', async () => {
    const doc = plannedDoc();
    doc.settings.imageModelOverride = 'flux-3';
    const session = newSession(doc);
    const ctx = testContext(session);
    (ctx as { qualityDenied?: string }).qualityDenied = 'Needs a paid plan.';
    const blocked = await startAction(ctx, { type: 'render_cover' }, { confirmed: true });
    expect(blocked.outcome.status).toBe('blocked');
    expect(ctx.imagesFake.calls).toHaveLength(0);
  });

  it('decline closes the gate; a stale gate id is rejected', async () => {
    const doc = plannedDoc();
    doc.settings.confirm = 'always';
    const session = newSession(doc);
    const ctx = testContext(session);
    await startAction(ctx, { type: 'render_cover' }, { confirmed: false });
    const gate = session.doc.gate!;
    await runAction(ctx, { type: 'decline_gate', gateId: gate.id }, { confirmed: false });
    expect(session.doc.gate?.status).toBe('declined');
    await expect(runAction(ctx, { type: 'approve_gate', gateId: gate.id }, { confirmed: false })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(ctx.imagesFake.calls).toHaveLength(0);
  });

  it('blocks without keys and for Pro without access — with a notice, no spend', async () => {
    const session = newSession(plannedDoc());
    const noKeys = testContext(session, { keys: {} });
    const blocked = await startAction(noKeys, { type: 'render_cover' }, { confirmed: true });
    expect(blocked.outcome).toMatchObject({ status: 'blocked', message: expect.stringContaining('Connect a Gemini or OpenRouter key') });

    const pro = newSession({ ...plannedDoc('p2'), settings: { ...plannedDoc().settings, quality: 'pro' } });
    const ctx = testContext(pro);
    const denied = await startAction(ctx, { type: 'render_pages' }, { confirmed: true, qualityDenied: 'Pro quality needs a paid plan.' });
    expect(denied.outcome.status).toBe('blocked');
    expect(ctx.imagesFake.calls).toHaveLength(0);
    // Style options never run on Pro, so they are allowed.
    vi.mocked(proposeStyleDirections).mockResolvedValue({ options: [{ name: 'A', spec: 'spec a' }], model: 'w' });
    const allowed = await startAction(ctx, { type: 'render_style_options' }, { confirmed: true, qualityDenied: 'Pro quality needs a paid plan.' });
    expect(allowed.outcome.status).toBe('started');
    await allowed.done;
  });

  it('keeps an approval open (not a false "drawing now") when the spend cannot start', async () => {
    const doc = plannedDoc();
    doc.pages[0] = readyPage(doc.pages[0], 'page1.webp');
    doc.settings.confirm = 'always';
    const session = newSession(doc);
    const ctx = testContext(session);
    await startAction(ctx, { type: 'edit_page', pageId: 'pg_1', instruction: 'make it night' }, { confirmed: false });
    const gate = session.doc.gate!;
    expect(gate.status).toBe('open');
    // The page starts drawing before the user taps Approve, so the edit can't run.
    session.commit([{ op: 'render', target: { kind: 'page', id: 'pg_1' }, patch: { status: 'rendering' } }]);
    await expect(runAction(ctx, { type: 'approve_gate', gateId: gate.id }, { confirmed: false })).rejects.toMatchObject({ code: 'BAD_REQUEST', status: 409 });
    expect(session.doc.gate?.status).toBe('open');
    expect(ctx.imagesFake.calls).toHaveLength(0);
  });

  it('nothing to draw → a $0 `nothing` outcome with an honest notice, no gate', async () => {
    const doc = plannedDoc();
    doc.cast.forEach((c) => (c.sheet = { ...emptyRender(), status: 'ready', asset: { path: `${c.id}.webp`, source: 'generated', at: 1 } }));
    const session = newSession(doc);
    const started = await startAction(testContext(session), { type: 'render_sheets' }, { confirmed: false });
    expect(started.outcome).toMatchObject({ status: 'nothing', message: expect.stringContaining('All character sheets are already drawn') });
    expect(session.doc.gate).toBeNull();
    expect(session.doc.conversation.at(-1)?.text).toContain('nothing was spent');
  });
});

// ── Edits ────────────────────────────────────────────────────────────────────

describe('edit_page', () => {
  it('outlines the region on the current page, substitutes it as Image 2, and versions the result', async () => {
    const doc = plannedDoc();
    doc.pages[0] = readyPage(doc.pages[0], 'u/user-1/p/proj-1/img/page1.webp');
    const session = newSession(doc);
    const ctx = testContext(session);
    ctx.assetsFake.files.set('u/user-1/p/proj-1/img/page1.webp', 'data:image/png;base64,Q1VSUkVOVA==');
    const action: SpendAction = { type: 'edit_page', pageId: 'pg_1', instruction: 'Make it night', region: { x: 0.1, y: 0.2, w: 0.3, h: 0.4 }, panelN: 2 };
    await runAction(ctx, action, { confirmed: true });

    expect(ctx.assetsFake.outlines).toEqual([{ dataUrl: 'data:image/png;base64,Q1VSUkVOVA==', box: { x: 0.1, y: 0.2, w: 0.3, h: 0.4 } }]);
    const call = ctx.imagesFake.calls[0];
    expect(call.references[0]).toEqual({ label: 'CURRENT PAGE', dataUrl: 'data:image/png;base64,Q1VSUkVOVA==' });
    expect(call.references[1]).toEqual({ label: 'SAME PAGE — AREA TO CHANGE OUTLINED IN RED', dataUrl: 'data:image/png;base64,T1VUTElORUQ=' });
    expect(call.prompt).toContain('Make it night');
    const page = session.doc.pages[0];
    expect(page.render.status).toBe('ready');
    expect(page.render.asset?.path).toMatch(/gen-/);
    expect(page.render.history[0].path).toBe('u/user-1/p/proj-1/img/page1.webp');
    expect(session.doc.spend.entries[0]).toMatchObject({ kind: 'edit', label: 'Edit page 1' });
  });

  it('a failed edit keeps the page as it was and explains', async () => {
    const doc = plannedDoc();
    doc.pages[0] = readyPage(doc.pages[0], 'page1.webp');
    const session = newSession(doc);
    const ctx = testContext(session, { images: fakeImages(() => new StudioError('SAFETY_BLOCKED', 'Blocked by the safety filter.')) });
    await runAction(ctx, { type: 'edit_page', pageId: 'pg_1', instruction: 'Add a dragon' }, { confirmed: true });
    expect(session.doc.pages[0].render).toMatchObject({ status: 'ready', asset: { path: 'page1.webp' }, error: 'Blocked by the safety filter.' });
    expect(cardsOf(session.doc).some((c) => c.type === 'notice' && c.text.includes("Edit page 1 didn't work"))).toBe(true);
  });

  it('rejects an edit of an undrawn page', async () => {
    const ctx = testContext(newSession(plannedDoc()));
    await expect(runAction(ctx, { type: 'edit_page', pageId: 'pg_1', instruction: 'x' }, { confirmed: true })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });
});

// ── Style options & doc-only actions ─────────────────────────────────────────

describe('style options and doc actions', () => {
  it('renders given directions, then replaces the progress card with a style_choice card; pick_style locks it', async () => {
    const doc = plannedDoc();
    doc.style.options = [{ id: 'old', name: 'Old', spec: 'old', render: emptyRender() }];
    const session = newSession(doc);
    const ctx = testContext(session);
    await runAction(ctx, { type: 'render_style_options', directions: [{ name: 'Ink Noir', spec: 'Heavy blacks' }, { name: 'Pastel', spec: 'Soft' }] }, { confirmed: true });
    const options = session.doc.style.options;
    expect(options.map((o) => o.name)).toEqual(['Ink Noir', 'Pastel']);
    expect(options.every((o) => o.render.status === 'ready')).toBe(true);
    expect(ctx.imagesFake.calls.every((c) => c.aspect === '4:5')).toBe(true);
    const msg = session.doc.conversation.find((m) => m.cards?.some((c) => c.type === 'style_choice'));
    expect(msg?.cards?.some((c) => c.type === 'renders')).toBe(false);
    expect(session.doc.spend.entries.filter((e) => e.kind === 'style')).toHaveLength(2);

    await runAction(ctx, { type: 'pick_style', optionId: options[0].id }, { confirmed: false });
    expect(session.doc.style).toMatchObject({ status: 'locked', name: 'Ink Noir', spec: 'Heavy blacks', board: options[0].render.asset });
  });

  it('a per-option retry redraws that option in place, keeping the other paid options', async () => {
    const doc = plannedDoc();
    const ready = (path: string) => ({ ...emptyRender(), status: 'ready' as const, asset: { path, source: 'generated' as const, at: 1 } });
    doc.style.options = [
      { id: 'o_a', name: 'Ink Noir', spec: 'Heavy blacks', render: ready('a.webp') },
      { id: 'o_b', name: 'Pastel', spec: 'Soft', render: ready('b.webp') },
      { id: 'o_c', name: 'Retro', spec: 'Halftone', render: { ...emptyRender(), status: 'failed', error: 'blocked' } }
    ];
    const session = newSession(doc);
    const ctx = testContext(session);
    // The failed tile's Retry sends just that direction — it must not clear the two ready boards.
    await runAction(ctx, { type: 'render_style_options', directions: [{ name: 'Retro', spec: 'Halftone' }] }, { confirmed: true });
    const options = session.doc.style.options;
    expect(options.map((o) => o.id)).toEqual(['o_a', 'o_b', 'o_c']);
    expect(options.every((o) => o.render.status === 'ready')).toBe(true);
    expect(options[0].render.asset?.path).toBe('a.webp');
    expect(ctx.imagesFake.calls).toHaveLength(1);
  });

  it('proposes directions with the writer when none are given (billed as style spend)', async () => {
    const session = newSession(plannedDoc());
    const ctx = testContext(session);
    vi.mocked(proposeStyleDirections).mockImplementation(async ({ llm }) => {
      await llm.complete({ role: 'writer', messages: [{ role: 'user', content: 'go' }] });
      return { options: [{ name: 'A', spec: 'a' }, { name: 'B', spec: 'b' }, { name: 'C', spec: 'c' }], model: 'w' };
    });
    await runAction(ctx, { type: 'render_style_options' }, { confirmed: true });
    expect(session.doc.style.options).toHaveLength(3);
    expect(session.doc.spend.entries.map((e) => e.label)).toContain('Style directions');
    expect(ctx.billingFake.reserves[0]).toMatchObject({ operation: 'comic.text.writer', stage: 'style' });
  });

  it('plan_pages commits pages + new cast, a breakdown card, and plan spend; a re-plan rewrites drawn pages in place by id', async () => {
    const doc = plannedDoc();
    doc.format.pageCount = 3;
    doc.pages[0] = readyPage(doc.pages[0], 'p1.webp');
    const session = newSession(doc);
    const ctx = testContext(session);
    vi.mocked(writePagePlan).mockImplementation(async ({ llm, pageIds }) => {
      await llm.complete({ role: 'writer', messages: [{ role: 'user', content: 'plan' }] });
      // Like the real writer: a revision returns the target ids.
      const fresh = plannedDoc().pages.map((p, i) => ({ ...p, id: pageIds?.[i] ?? `new_${p.n}`, summary: `New ${p.n}` }));
      return {
        pages: fresh,
        newCast: [{ id: 'c_new', name: 'Nani', tier: 'support', look: { summary: 'grandmother' }, refs: [], sheet: emptyRender() }],
        model: 'writer-x'
      };
    });
    await runAction(ctx, { type: 'plan_pages', instructions: 'faster' }, { confirmed: false });
    const after = session.doc;
    expect(after.pages.map((p) => p.id)).toEqual(['pg_1', 'pg_2', 'pg_3']);
    expect(after.pages[0].summary).toBe('New 1');
    expect(after.pages[0].render.asset?.path).toBe('p1.webp');
    expect(after.planStatus).toBe('draft');
    expect(after.cast.map((c) => c.name)).toContain('Nani');
    expect(cardsOf(after).some((c) => c.type === 'breakdown' && c.view === 'plan')).toBe(true);
    expect(after.spend.entries[0]).toMatchObject({ kind: 'plan', label: 'Page plan' });
    expect(vi.mocked(writePagePlan).mock.calls[0][0].pageIds).toEqual(['pg_1', 'pg_2', 'pg_3']);
    expect(vi.mocked(writePagePlan).mock.calls[0][0].instructions).toBe('faster');
  });

  it('approve_plan, restore_render and relayout_balloons', async () => {
    const doc = plannedDoc();
    doc.pages[0] = {
      ...doc.pages[0],
      render: { ...emptyRender(), status: 'ready', asset: { path: 'v2.webp', source: 'generated', at: 2 }, history: [{ path: 'v1.webp', source: 'generated', at: 1 }], specHash: 'h', qc: { score: 0.9, issues: [], checkedAt: 1 } }
    };
    const session = newSession(doc);
    const ctx = testContext(session);
    await runAction(ctx, { type: 'approve_plan' }, { confirmed: false });
    expect(session.doc.planStatus).toBe('approved');

    await expect(runAction(ctx, { type: 'restore_render', target: { kind: 'page', id: 'pg_1' }, path: 'nope.webp' }, { confirmed: false })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await runAction(ctx, { type: 'restore_render', target: { kind: 'page', id: 'pg_1' }, path: 'v1.webp' }, { confirmed: false });
    const r = session.doc.pages[0].render;
    expect(r.asset?.path).toBe('v1.webp');
    expect(r.history[0].path).toBe('v2.webp');
    expect(r.qc).toBeUndefined();

    await runAction(ctx, { type: 'relayout_balloons', pageId: 'pg_1' }, { confirmed: false });
    expect(session.doc.pages[0].balloons.map((b) => b.lineId)).toEqual(['ln_1_2']);
  });

  it('cancel aborts the session controller', async () => {
    const session = newSession(plannedDoc());
    await runAction(testContext(session), { type: 'cancel' }, { confirmed: false });
    expect(session.abort.signal.aborted).toBe(true);
  });
});

// ── Patch validation ─────────────────────────────────────────────────────────

describe('sanitizePatchOps', () => {
  const doc = plannedDoc();

  it('accepts client-patchable content edits, bounded and stripped of unknown keys', () => {
    const ops = sanitizePatchOps(doc, [
      { op: 'brief', patch: { title: 'New', evil: 1 } },
      { op: 'format', patch: { pageCount: 99, pageAspect: '3:4' } },
      { op: 'settings', patch: { budgetUsd: null, confirm: 'always' } },
      { op: 'line', pageId: 'pg_1', panelId: 'pn_1_2', id: 'ln_1_2', patch: { text: 'Hi!' } },
      { op: 'balloon', pageId: 'pg_1', lineId: 'ln_1_2', patch: { x: 2, pinned: true } },
      { op: 'character', id: 'c_new', patch: { name: 'Nani', tier: 'extra', look: { summary: 'old', bogus: 'x' } } },
      { op: 'panel', pageId: 'pg_1', id: 'pn_1_1', patch: { castIds: ['c_new'], placeId: null } }
    ]);
    expect(ops[0]).toEqual({ op: 'brief', patch: { title: 'New' } });
    expect(ops[1]).toEqual({ op: 'format', patch: { pageCount: 40, pageAspect: '3:4' } });
    expect(ops[2]).toEqual({ op: 'settings', patch: { budgetUsd: undefined, confirm: 'always' } });
    expect(ops[4]).toEqual({ op: 'balloon', pageId: 'pg_1', lineId: 'ln_1_2', patch: { x: 1, pinned: true } });
    expect(ops[5]).toEqual({ op: 'character', id: 'c_new', patch: { name: 'Nani', tier: 'extra', look: { summary: 'old' } } });
    expect(ops[6]).toEqual({ op: 'panel', pageId: 'pg_1', id: 'pn_1_1', patch: { castIds: ['c_new'], placeId: undefined } });
  });

  // P2-GATE L5: text is cleaned where it enters (str → sanitize/text.ts), so the live doc never holds a
  // NUL or a lone surrogate (jsonb rejects both, and a stored copy that differs from the live doc would
  // hash differently after a reload) — and a clip never splits an emoji.
  it('drops NULs and lone surrogates from free text at the door, keeps whole emoji, never splits a pair at the clip', () => {
    const ops = sanitizePatchOps(doc, [
      { op: 'brief', patch: { title: ' Spice\u0000 Run \uD83C', logline: 'A fox 🦊 races\uDC00', themes: ['\u0000', 'home 🏁', '\uD800'], notes: [`${'n'.repeat(499)}🦊`] } },
      { op: 'note_add', text: '\uDC00call\u0000 the vet' },
      { op: 'character', id: 'c_new2', patch: { name: 'Na\u0000ni', role: 'guide \uD83E' } }
    ]);
    expect(ops[0]).toEqual({ op: 'brief', patch: { title: 'Spice Run', logline: 'A fox 🦊 races', themes: ['home 🏁'], notes: ['n'.repeat(499)] } });
    expect(ops[1]).toEqual({ op: 'note_add', text: 'call the vet' });
    expect(ops[2]).toEqual({ op: 'character', id: 'c_new2', patch: { name: 'Nani', role: 'guide' } });
    expect(JSON.stringify(ops)).not.toMatch(/\\u0000|\\ud8[0-9a-f]{2}"|\\udc00/i);
    // A note that is only unstorable characters is "no note" (never an empty entry).
    expect(() => sanitizePatchOps(doc, [{ op: 'note_add', text: '\u0000\uD83C' }])).toThrow('Invalid note');
  });

  // P2-GATE L5 (gate review follow-up): the entry points str() did not cover follow the same rule —
  // balloon text (`line`: clipped at 600 without splitting a pair) and the pasted script (`source`:
  // kept as typed, line breaks and spacing included; only a NUL or a lone surrogate goes).
  it('line text and the source script are jsonb-safe at the door too, and a clip never leaves half a pair', () => {
    const ops = sanitizePatchOps(doc, [
      { op: 'line', pageId: 'pg_1', panelId: 'pn_1_2', id: 'ln_1_2', patch: { text: `\u0000${'x'.repeat(599)}🦊` } },
      { op: 'line', pageId: 'pg_1', panelId: 'pn_1_2', id: 'ln_1_2', patch: { text: 'Hi\u0000 there \uD83C 🦊 ‍ గ్' } },
      { op: 'source', patch: { script: 'PAGE 1\n\n  Maya\u0000 runs \uDC00🦊 హలో\n' } }
    ]);
    expect(ops[0]).toEqual({ op: 'line', pageId: 'pg_1', panelId: 'pn_1_2', id: 'ln_1_2', patch: { text: 'x'.repeat(599) } });
    expect(ops[1]).toEqual({ op: 'line', pageId: 'pg_1', panelId: 'pn_1_2', id: 'ln_1_2', patch: { text: 'Hi there  🦊 ‍ గ్' } });
    expect((ops[2] as { patch: { script: string } }).patch.script).toBe('PAGE 1\n\n  Maya runs 🦊 హలో\n');
    expect(JSON.stringify(ops)).not.toMatch(/\\u0000|\\ud8[0-9a-f]{2}"|\\udc00/i);
  });

  it.each([
    [{ op: 'render', target: { kind: 'cover' }, patch: { status: 'ready' } }, "can't be changed directly"],
    [{ op: 'spend', entry: {} }, "can't be changed directly"],
    [{ op: 'gate', gate: null }, "can't be changed directly"],
    [{ op: 'format', patch: { kind: 'novel' } }, 'Invalid format: kind'],
    [{ op: 'style', patch: { board: { path: 'u/other-user/p/x/img/secret.webp' } } }, 'Invalid style: board'],
    [{ op: 'character', id: 'c_maya', patch: { refs: [{ path: 'u/other/secret.webp' }] } }, 'Invalid character: refs'],
    [{ op: 'line', pageId: 'pg_9', panelId: 'x', id: 'y', patch: { text: 'a' } }, 'no longer in the plan'],
    [{ op: 'character', id: 'bad id!', patch: { name: 'x' } }, 'Invalid character id'],
    [{ op: 'character', id: 'c_brand_new', patch: { tier: 'lead' } }, 'needs a name']
  ])('rejects %j', (op, message) => {
    expect(() => sanitizePatchOps(doc, [op])).toThrow(message);
  });

  it('patch action applies valid ops atomically', async () => {
    const session = newSession(plannedDoc());
    const ctx = testContext(session);
    await expect(runAction(ctx, { type: 'patch', ops: [{ op: 'note_add', text: 'ok' }, { op: 'spend', entry: {} } as never] }, { confirmed: false })).rejects.toBeInstanceOf(StudioError);
    expect(session.doc.brief.notes).toEqual([]);
    await runAction(ctx, { type: 'patch', ops: [{ op: 'note_add', text: 'ok' }] }, { confirmed: false });
    expect(session.doc.brief.notes).toEqual(['ok']);
  });
});

describe('suggestNextSteps', () => {
  // P2-GATE L5 (gate review follow-up): jobs.ts clean() is jsonb-safe too, so a premise that holds only
  // what Postgres rejects counts as "no idea yet" — the same answer the stored doc would give after a reload.
  it('a premise of only a NUL and a lone surrogate is no idea at all', () => {
    const noise = plannedDoc();
    noise.brief = { title: 'x', notes: [], premise: '\u0000 \uD83C' };
    noise.cast = [];
    noise.pages = [];
    noise.planStatus = 'none';
    expect(suggestNextSteps(noise)).toContain('Paste a script');
  });

  it('follows the forward motion', () => {
    const empty = plannedDoc();
    empty.brief = { title: 'x', notes: [] };
    empty.cast = [];
    empty.pages = [];
    empty.planStatus = 'none';
    expect(suggestNextSteps(empty)).toContain('Paste a script');
    const draft = plannedDoc();
    expect(suggestNextSteps(draft)).toContain('Approve & draw all');
    const noStyle = { ...draft, style: { status: 'empty' as const, refs: [], options: [] } };
    expect(suggestNextSteps(noStyle)[0]).toBe('Show me 3 styles');
    const done = plannedDoc();
    done.planStatus = 'approved';
    done.pages = done.pages.map((p, i) => readyPage(p, `p${i}.webp`));
    expect(suggestNextSteps(done)).toEqual(expect.arrayContaining(['Make the cover', 'Read it']));
    // Never "draw all" when everything is drawn and current.
    expect(suggestNextSteps(done).some((s) => /draw all|remaining/i.test(s))).toBe(false);
    for (const d of [empty, draft, noStyle, done]) {
      const s = suggestNextSteps(d);
      expect(s.length).toBeGreaterThanOrEqual(2);
      expect(s.length).toBeLessThanOrEqual(4);
    }
  });
});

// ── v5 helpers ───────────────────────────────────────────────────────────────

const readySheets = (doc: ComicDoc) =>
  doc.cast.forEach((c) => (c.sheet = { ...emptyRender(), status: 'ready', asset: { path: `${c.id}.webp`, source: 'generated', at: 1, w: 1536, h: 1024 } }));
const onePage = (doc: ComicDoc) => {
  doc.pages = doc.pages.slice(0, 1);
  doc.format.pageCount = 1;
  return doc;
};
const rateLimited = (retryAfterMs = 1) =>
  Object.assign(new StudioError('RATE_LIMIT', 'The image model is busy right now (rate limited). Wait a minute and try again.', { status: 429, retryable: true }), {
    imageFailure: { route: 'openrouter', status: 429, providerName: 'Google', retryAfterMs }
  });
const pageOf = (prompt: string) => Number(/Action (\d+)\.1/.exec(prompt)?.[1] ?? 0);
const labelsOf = (steps?: NextStep[]) => (steps || []).map((s) => s.label);

/**
 * A director turn as director.ts runs it: inside the turn lock, the user's message, the tool
 * calls (cards collected), then the reply committed after the tools — while renders that the
 * tools started keep running in the background.
 */
async function directorTurn(
  ctx: TestContext,
  userText: string,
  act: (collect: { opts: RunActionOptions; cards: Card[]; steps: NextStep[] }) => Promise<string>
): Promise<{ replyId: string }> {
  const session = ctx.session as StudioSession;
  const replyId = newId('msg');
  await session.runExclusive(async () => {
    session.commit([{ op: 'message', msg: { id: newId('msg'), role: 'user', text: userText, at: Date.now() } }]);
    const cards: Card[] = [];
    const steps: NextStep[] = [];
    const opts: RunActionOptions = { confirmed: false, collectCard: (c) => cards.push(c), collectNextSteps: (s) => steps.push(...s), origin: 'director' };
    const text = await act({ opts, cards, steps });
    // The fakes draw instantly: the renders finish while the director is still writing.
    await new Promise((r) => setTimeout(r, 15));
    session.commit([
      { op: 'message', msg: { id: replyId, role: 'assistant', text, at: Date.now(), ...(cards.length ? { cards } : {}), ...(steps.length ? { nextSteps: steps } : {}) } }
    ]);
  });
  await ctx.settled();
  return { replyId };
}

const startTracked = async (ctx: TestContext, action: SpendAction, opts: RunActionOptions) => {
  const started = await startAction(ctx, action, opts);
  void ctx.track(started.done);
  return started;
};

// ── Message ordering ─────────────────────────────────────────────────────────

describe('message ordering (director.md §3.7)', () => {
  it('a director-started run: [user, reply with the live renders card, completion appended after it]', async () => {
    const doc = onePage(plannedDoc());
    readySheets(doc);
    doc.planStatus = 'approved';
    const session = newSession(doc);
    const ctx = testContext(session);
    const { replyId } = await directorTurn(ctx, 'draw page 1', async ({ opts }) => {
      const started = await startTracked(ctx, { type: 'render_pages' }, opts);
      expect(started.outcome.status).toBe('started');
      return 'Page 1 is on its way.';
    });
    const conv = session.doc.conversation;
    expect(conv.map((m) => m.role)).toEqual(['user', 'assistant', 'assistant']);
    expect(conv[1].id).toBe(replyId);
    expect(conv[1].cards?.map((c) => c.type)).toEqual(['renders']);
    expect(conv[2].text).toMatch(/^Page 1 is ready \(\$0\.\d\d\)\./);
    expect(conv[2].at).toBeGreaterThanOrEqual(conv[1].at);
    expect((conv[2].cards || []).some((c) => c.type === 'renders')).toBe(false);
    // Next steps are computed AFTER the run: page 1 is drawn, so the cover is next.
    expect(conv[2].text).toContain('Want the cover next?');
    expect(labelsOf(conv[2].nextSteps)).toContain('Make the cover');
    expect(conv[2].nextSteps!.find((s) => s.label === 'Make the cover')).toMatchObject({ action: { type: 'render_cover', quotedUsd: expect.any(Number) }, usd: expect.any(Number) });
  });

  it.each([
    ['while the director is still writing', 5],
    ['after the turn ended', 40]
  ])('a director run that starts late (the writer proposes style directions first, %s): its own progress message lands below the reply', async (_when, writerMs) => {
    const session = newSession(plannedDoc());
    const ctx = testContext(session);
    vi.mocked(proposeStyleDirections).mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, writerMs));
      return { options: [{ name: 'Ink Noir', spec: 'Heavy blacks' }, { name: 'Pastel', spec: 'Soft washes' }], model: 'w' };
    });
    const { replyId } = await directorTurn(ctx, 'show me some styles', async ({ opts }) => {
      const started = await startTracked(ctx, { type: 'render_style_options' }, opts);
      expect(started.outcome.status).toBe('started');
      return 'Drawing a few looks for you.';
    });
    const conv = session.doc.conversation;
    expect(conv.map((m) => m.role)).toEqual(['user', 'assistant', 'assistant']);
    expect(conv[1].id).toBe(replyId);
    expect(conv[1].cards ?? []).toEqual([]);
    expect(conv[2].cards?.map((c) => c.type)).toEqual(['style_choice']);
    expect(conv[2].at).toBeGreaterThanOrEqual(conv[1].at);
    // The live card was shown — in its own message, committed after the reply (never lost, never above it).
    const msgOps = opsOf(ctx.events).flatMap((o) => (o.op === 'message' ? [o.msg] : []));
    const replyIdx = msgOps.findIndex((m) => m.id === replyId);
    const progressIdx = msgOps.findIndex((m) => m.cards?.some((c) => c.type === 'renders'));
    expect(progressIdx).toBeGreaterThan(replyIdx);
    expect(msgOps[progressIdx].id).toBe(conv[2].id);
  });

  it('a UI-started run rewrites its progress message only while it is the last; otherwise it points down and appends', async () => {
    const doc = onePage(plannedDoc());
    readySheets(doc);
    const session = newSession(doc);
    let release!: () => void;
    const hold = new Promise<void>((r) => (release = r));
    const images = fakeImages(async () => {
      await hold;
      return undefined;
    });
    const ctx = testContext(session, { images });
    const run = runAction(ctx, { type: 'render_pages' }, { confirmed: true });
    await vi.waitFor(() => expect(images.calls).toHaveLength(1));
    session.commit([{ op: 'message', msg: { id: 'later', role: 'user', text: 'meanwhile, a question', at: Date.now() } }]);
    release();
    await run;
    const conv = session.doc.conversation;
    const progress = conv.find((m) => m.cards?.some((c) => c.type === 'renders'))!;
    expect(progress.text).toMatch(/finished \(\$0\.\d\d\); see below\.$/);
    expect(conv.map((m) => m.id).indexOf('later')).toBe(conv.indexOf(progress) + 1);
    expect(conv.at(-1)!.text).toMatch(/^Page 1 is ready/);
    expect(conv.at(-1)!.nextSteps?.length).toBeGreaterThan(0);
  });

  it('no committed assistant message is ever empty (success, billing denial, gate, nothing)', async () => {
    const scenarios: Array<() => Promise<ComicDoc>> = [
      async () => {
        const session = newSession(plannedDoc());
        await runAction(testContext(session), { type: 'render_pages' }, { confirmed: true });
        return session.doc;
      },
      async () => {
        const doc = plannedDoc();
        readySheets(doc);
        const session = newSession(doc);
        await runAction(testContext(session, { billing: fakeBilling(0) }), { type: 'render_pages' }, { confirmed: true });
        return session.doc;
      },
      async () => {
        const doc = plannedDoc();
        doc.settings.confirm = 'always';
        const session = newSession(doc);
        await runAction(testContext(session), { type: 'render_cover' }, { confirmed: false });
        return session.doc;
      },
      async () => {
        const doc = onePage(plannedDoc());
        readySheets(doc);
        const session = newSession(doc);
        const ctx = testContext(session);
        await runAction(ctx, { type: 'render_pages' }, { confirmed: true });
        await runAction(ctx, { type: 'render_pages' }, { confirmed: false });
        return session.doc;
      }
    ];
    for (const scenario of scenarios) {
      const doc = await scenario();
      expect(doc.conversation.length).toBeGreaterThan(0);
      for (const m of doc.conversation) {
        if (m.role !== 'assistant' || m.cards?.some((c) => c.type === 'renders')) continue;
        expect(m.text.trim()).not.toBe('');
      }
    }
  });
});

// ── R1: never redraw a ready, current page implicitly ────────────────────────

describe('ready pages and redraws', () => {
  it('render_pages on a ready, current page is `nothing` ($0): a breakdown card, versions + cover facts, a priced new-take chip', async () => {
    const doc = onePage(plannedDoc());
    readySheets(doc);
    const session = newSession(doc);
    const ctx = testContext(session);
    await runAction(ctx, { type: 'render_pages' }, { confirmed: true });
    const calls = ctx.imagesFake.calls.length;
    const spent = session.doc.spend.totalUsd;
    const cards: Card[] = [];
    const steps: NextStep[] = [];
    const started = await startAction(ctx, { type: 'render_pages', pageIds: ['pg_1'] }, { confirmed: false, collectCard: (c) => cards.push(c), collectNextSteps: (s) => steps.push(...s) });
    expect(started.outcome.status).toBe('nothing');
    expect(started.outcome.message).toContain('Page 1 is already drawn and up to date');
    expect(started.outcome.message).toContain("The cover isn't drawn yet");
    expect(started.outcome.message).toContain('Nothing was spent');
    expect(cards).toEqual([expect.objectContaining({ type: 'breakdown', view: 'status', pageIds: ['pg_1'] })]);
    expect(labelsOf(steps)).toEqual(expect.arrayContaining(['Make the cover', 'Read it', 'New take of page 1']));
    expect(steps.find((s) => s.label === 'New take of page 1')).toMatchObject({ action: { type: 'render_pages', pageIds: ['pg_1'], force: true } });
    expect(ctx.imagesFake.calls).toHaveLength(calls);
    expect(session.doc.spend.totalUsd).toBe(spent);
    expect(session.doc.gate).toBeNull();
  });

  it('a director redraw of a ready, current page always gates (redraw), even under confirm "never"; a UI Redraw click runs', async () => {
    const doc = onePage(plannedDoc());
    readySheets(doc);
    const session = newSession(doc);
    const ctx = testContext(session);
    await runAction(ctx, { type: 'render_pages' }, { confirmed: true });
    const before = ctx.imagesFake.calls.length;
    const gated = await startAction(ctx, { type: 'render_pages', pageIds: ['pg_1'], force: true }, { confirmed: false, collectCard: () => undefined });
    expect(gated.outcome.status).toBe('gated');
    expect(session.doc.gate).toMatchObject({ reason: 'redraw', status: 'open' });
    expect(gated.outcome.message).toContain('already drawn and current');
    expect(ctx.imagesFake.calls).toHaveLength(before);
    await runAction(ctx, { type: 'render_pages', pageIds: ['pg_1'], force: true }, { confirmed: true });
    expect(ctx.imagesFake.calls).toHaveLength(before + 1);
    expect(session.doc.pages[0].render).toMatchObject({ status: 'ready', note: 'New take' });
    expect(session.doc.pages[0].render.history).toHaveLength(1);
  });
});

// ── Gates ────────────────────────────────────────────────────────────────────

describe('director guards (softwarefirst.md §1.5)', () => {
  it('first director render of a project gates as first_render with the breakdown; a UI click runs; reviewFirstRender:false skips it', async () => {
    const doc = lakeDoc();
    doc.planStatus = 'approved';
    const session = newSession(doc);
    const ctx = testContext(session);
    const cards: Card[] = [];
    const gated = await startAction(ctx, { type: 'render_pages' }, { confirmed: false, collectCard: (c) => cards.push(c) });
    expect(gated.outcome.status).toBe('gated');
    expect(session.doc.gate?.reason).toBe('first_render');
    expect(cards.map((c) => c.type)).toEqual(['breakdown', 'gate']);
    expect(ctx.imagesFake.calls).toHaveLength(0);

    const clicked = newSession({ ...lakeDoc('lake-2'), planStatus: 'approved' });
    const clickCtx = testContext(clicked);
    await runAction(clickCtx, { type: 'render_pages' }, { confirmed: true });
    expect(clickCtx.imagesFake.calls.length).toBeGreaterThan(0);

    const relaxed = lakeDoc('lake-3');
    relaxed.planStatus = 'approved';
    relaxed.settings.reviewFirstRender = false;
    const relaxedCtx = testContext(newSession(relaxed));
    const started = await startAction(relaxedCtx, { type: 'render_pages' }, { confirmed: false, collectCard: () => undefined });
    expect(started.outcome.status).toBe('started');
    await started.done;
  });

  it('a director render of a draft plan gates as plan_review; approving it approves the plan and draws', async () => {
    const doc = lakeDoc();
    doc.settings.reviewFirstRender = false;
    const session = newSession(doc);
    const ctx = testContext(session);
    await startAction(ctx, { type: 'render_pages' }, { confirmed: false, collectCard: () => undefined });
    const gate = session.doc.gate!;
    expect(gate.reason).toBe('plan_review');
    expect(session.doc.planStatus).toBe('draft');
    await runAction(ctx, { type: 'approve_gate', gateId: gate.id }, { confirmed: true });
    expect(session.doc.planStatus).toBe('approved');
    expect(session.doc.pages[0].render.status).toBe('ready');
  });

  it('a chip whose quote went stale (>15 %) is re-gated instead of overspending; an honest quote runs', async () => {
    const session = newSession(plannedDoc());
    const ctx = testContext(session);
    const stale = await startAction(ctx, { type: 'render_cover', quotedUsd: 0.01 }, { confirmed: true });
    expect(stale.outcome.status).toBe('gated');
    expect(session.doc.gate).toMatchObject({ reason: 'policy', action: { type: 'render_cover' } });
    expect('quotedUsd' in session.doc.gate!.action).toBe(false);
    expect(session.doc.conversation.at(-1)!.text).toContain('The price changed since that button was shown');
    expect(ctx.imagesFake.calls).toHaveLength(0);
    const quote = estimateSpendAction(session.doc, { type: 'render_cover' }, false).usd;
    await runAction(ctx, { type: 'render_cover', quotedUsd: quote }, { confirmed: true });
    expect(ctx.imagesFake.calls).toHaveLength(1);
  });

  it('gateDecision: guards stop director spends, never the user\'s click; "never" skips all but redraw/policy', () => {
    const doc = lakeDoc();
    const est = estimate(0.07);
    const pages: SpendAction = { type: 'render_pages' };
    expect(gateDecision(doc, est, false, { action: pages })).toBe('first_render');
    expect(gateDecision(doc, est, true, { action: pages })).toBeNull();
    doc.settings.reviewFirstRender = false;
    expect(gateDecision(doc, est, false, { action: pages })).toBe('plan_review');
    doc.planStatus = 'approved';
    expect(gateDecision(doc, est, false, { action: pages })).toBeNull();
    expect(gateDecision(doc, est, false, { action: pages, forceGate: 'no_intent' })).toBe('no_intent');
    doc.settings.confirm = 'never';
    expect(gateDecision(doc, est, false, { action: pages, forceGate: 'no_intent' })).toBeNull();
    expect(gateDecision(doc, est, false, { action: pages, forceGate: 'redraw' })).toBe('redraw');
  });
});

// ── Aspect ───────────────────────────────────────────────────────────────────

describe('aspect (bug: a 4:5 page came back 1:1)', () => {
  it('detects, logs, records the requested aspect, adds a notice and Fit (Free) · Keep · Redraw chips — no retry, no auto-fit', async () => {
    const session = newSession({ ...lakeDoc(), planStatus: 'approved' });
    const ctx = testContext(session);
    ctx.assetsFake.generatedSize = (n) => (n === 1 ? { w: 2528, h: 1696 } : { w: 2048, h: 2048 });
    vi.mocked(analyzePageRender).mockResolvedValue({ qc: { score: 0.9, issues: [], checkedAt: 1 }, balloons: [], model: 'vision-x' });
    const info = vi.spyOn(logger, 'info');
    await runAction(ctx, { type: 'render_pages' }, { confirmed: true });
    const page = session.doc.pages[0];
    expect(page.render).toMatchObject({ status: 'ready', aspect: '4:5', asset: { w: 2048, h: 2048 } });
    expect(page.render.qc?.issues).toContain('Came back 1:1 instead of 4:5.');
    expect(ctx.imagesFake.calls).toHaveLength(2); // the sheet and page 1 — nothing redrawn
    expect(ctx.assetsFake.fits).toHaveLength(0);
    expect(info).toHaveBeenCalledWith('comic_aspect_mismatch', expect.objectContaining({ target: 'page:pg_lake_1', want: '4:5', w: 2048, h: 2048 }));
    const last = session.doc.conversation.at(-1)!;
    expect(last.text).toContain('Page 1 came back 1:1 instead of 4:5.');
    expect(last.cards?.some((c) => c.type === 'notice' && c.text.includes('came back 1:1 instead of 4:5'))).toBe(true);
    expect(labelsOf(last.nextSteps)).toEqual(expect.arrayContaining(['Fit to 4:5 (Free)', 'Keep square', 'Redraw at 4:5']));
    expect(last.nextSteps!.find((s) => s.label === 'Fit to 4:5 (Free)')).toMatchObject({ usd: 0, action: { type: 'fit_render', target: { kind: 'page', id: 'pg_lake_1' } } });
    const redraw = last.nextSteps!.find((s) => s.label === 'Redraw at 4:5')!;
    expect(redraw.action).toMatchObject({ type: 'render_pages', pageIds: ['pg_lake_1'], force: true, quotedUsd: redraw.usd });
  });

  it('restoring a version made for another shape keeps it out of date and says so, with Fit / Switch / Redraw', async () => {
    const doc = onePage(plannedDoc());
    readySheets(doc);
    doc.format.pageAspect = '1:1';
    const session = newSession(doc);
    const ctx = testContext(session);
    ctx.assetsFake.generatedSize = (n) => (n === 1 ? { w: 1024, h: 1024 } : { w: 1024, h: 1280 });
    await runAction(ctx, { type: 'render_pages' }, { confirmed: true });
    const v1 = session.doc.pages[0].render.asset!.path;
    session.commit([{ op: 'format', patch: { pageAspect: '4:5' } }]);
    expect(isPageStale(session.doc, session.doc.pages[0])).toBe(true);
    await runAction(ctx, { type: 'render_pages' }, { confirmed: true }); // out of date ⇒ drawn again (no force needed)
    expect(session.doc.pages[0].render.asset!.path).not.toBe(v1);
    expect(isPageStale(session.doc, session.doc.pages[0])).toBe(false);
    await runAction(ctx, { type: 'restore_render', target: { kind: 'page', id: 'pg_1' }, path: v1 }, { confirmed: false });
    const after = session.doc;
    expect(after.pages[0].render.asset!.path).toBe(v1);
    expect(after.pages[0].render).toMatchObject({ aspect: '1:1', origin: 'render' });
    expect(isPageStale(after, after.pages[0])).toBe(true);
    const msg = after.conversation.at(-1)!;
    expect(msg.text).toContain("note it's 1:1, your pages are 4:5");
    expect(msg.text).toContain('out of date');
    expect(labelsOf(msg.nextSteps)).toEqual(expect.arrayContaining(['Fit to 4:5 (Free)', 'Switch book to 1:1 (Free)', 'Redraw at 4:5']));
  });

  it('restore keeps the version\'s own QC and spec hash; a blocked version is refused', async () => {
    const doc = onePage(plannedDoc());
    const spec = pageSpecHash(doc, doc.pages[0]);
    doc.pages[0].render = {
      ...emptyRender(),
      status: 'ready',
      asset: { path: 'v2.webp', source: 'generated', at: 2 },
      specHash: 'later',
      history: [
        { path: 'v1.webp', source: 'generated', at: 1, specHash: spec, qc: { score: 0.8, issues: ['ok'], checkedAt: 1 } },
        { path: 'bad.webp', source: 'generated', at: 0, safety: { assessed: 'X', quarantined: true, at: 1 } }
      ]
    };
    const session = newSession(doc);
    const ctx = testContext(session);
    await runAction(ctx, { type: 'restore_render', target: { kind: 'page', id: 'pg_1' }, path: 'v1.webp' }, { confirmed: false });
    expect(session.doc.pages[0].render).toMatchObject({ specHash: spec, qc: { score: 0.8 } });
    expect(isPageStale(session.doc, session.doc.pages[0])).toBe(false);
    await expect(runAction(ctx, { type: 'restore_render', target: { kind: 'page', id: 'pg_1' }, path: 'bad.webp' }, { confirmed: false })).rejects.toMatchObject({
      code: 'CONTENT_POLICY'
    });
  });
});

// ── Versions: full meta, include cover, textless cover ───────────────────────

describe('version meta, includeCover and the textless cover', () => {
  it('every draw records its full VersionMeta and the ledger target; an edit keeps the base spec hash', async () => {
    const doc = plannedDoc();
    readySheets(doc);
    const session = newSession(doc);
    const ctx = testContext(session);
    await runAction(ctx, { type: 'render_pages' }, { confirmed: true });
    const [p1, p2] = session.doc.pages;
    expect(p1.render).toMatchObject({ origin: 'render', aspect: '2:3', resolution: expect.any(String), specHash: pageSpecHash(session.doc, p1) });
    expect(p1.render.jobHash).toMatch(/^[0-9a-f]{24}$/);
    expect(p2.render.continuityPath).toBe(p1.render.asset!.path);
    expect(session.doc.spend.entries.filter((e) => e.kind === 'page').map((e) => e.target).sort()).toEqual(['page:pg_1', 'page:pg_2', 'page:pg_3']);

    await runAction(ctx, { type: 'render_sheets', characterIds: ['c_maya'], force: true }, { confirmed: true });
    const maya = session.doc.cast[0];
    expect(maya.sheet.specHash).toBe(sheetSpecHash(session.doc, maya));

    const base = session.doc.pages[1].render;
    await runAction(ctx, { type: 'edit_page', pageId: 'pg_2', instruction: 'Make it night' }, { confirmed: true });
    const edited = session.doc.pages[1].render;
    expect(edited).toMatchObject({ origin: 'edit', note: 'Make it night', parentPath: base.asset!.path, specHash: base.specHash });
  });

  it('render_pages {includeCover}: the quote includes the cover, which is drawn after page 1', async () => {
    const doc = plannedDoc();
    readySheets(doc);
    const session = newSession(doc);
    const ctx = testContext(session);
    const est = estimateSpendAction(session.doc, { type: 'render_pages', includeCover: true }, false);
    expect(est.lines.map((l) => l.label)).toEqual(['pages', 'cover']);
    await runAction(ctx, { type: 'render_pages', includeCover: true }, { confirmed: true });
    const starts = ctx.events.filter((e) => e.type === 'activity' && e.phase === 'start').map((e) => (e as { label: string }).label);
    expect(starts.indexOf('Drawing the cover')).toBeGreaterThan(starts.indexOf('Drawing page 1'));
    expect(session.doc.cover.render).toMatchObject({ status: 'ready', specHash: coverSpecHash(session.doc) });
    expect(session.doc.conversation.at(-1)!.text).toMatch(/^Pages 1–3 and the cover are ready/);
  });

  it('render_cover {textless}: asks for no lettering in words and turns the cover title into editable overlay text', async () => {
    const doc = plannedDoc();
    doc.cover.render = { ...emptyRender(), status: 'ready', asset: { path: 'painted.webp', source: 'generated', at: 1 } };
    const session = newSession(doc);
    const ctx = testContext(session);
    await runAction(ctx, { type: 'render_cover', textless: true }, { confirmed: true });
    expect(ctx.imagesFake.calls[0].prompt).toMatch(/free of text|no text|textless|no lettering/i);
    expect(session.doc.cover.lettering).toBe('overlay');
    expect(session.doc.cover.render).toMatchObject({ status: 'ready', note: 'Textless cover', specHash: coverSpecHash(session.doc) });
    expect(session.doc.cover.render.history[0].path).toBe('painted.webp');
  });
});

// ── Software reuse (R2/R3/R7) ────────────────────────────────────────────────

describe('software reuse with savedUsd (decisions-final #6)', () => {
  it('R2: a stored version made from today\'s spec comes back free — no image or vision call, a $0 ledger line with savedUsd', async () => {
    const doc = onePage(plannedDoc());
    readySheets(doc);
    doc.planStatus = 'approved';
    const spec = pageSpecHash(doc, doc.pages[0]);
    doc.pages[0].render = {
      ...emptyRender(),
      status: 'failed',
      error: 'Interrupted — tap retry.',
      history: [{ path: 'same-spec.webp', source: 'generated', at: 1, specHash: spec, qc: { score: 0.9, issues: [], checkedAt: 1, panelBoxes: [{ x: 0, y: 0, w: 1, h: 0.5 }] } }]
    };
    const session = newSession(doc);
    const ctx = testContext(session);
    await runAction(ctx, { type: 'render_pages' }, { confirmed: true });
    expect(ctx.imagesFake.calls).toHaveLength(0);
    expect(vi.mocked(analyzePageRender)).not.toHaveBeenCalled();
    expect(session.doc.pages[0].render).toMatchObject({ status: 'ready', asset: { path: 'same-spec.webp' }, specHash: spec, qc: { score: 0.9 } });
    const entry = session.doc.spend.entries[0];
    expect(entry).toMatchObject({ usd: 0, kind: 'page', target: 'page:pg_1', label: expect.stringContaining('(reused') });
    expect(entry.savedUsd).toBeGreaterThan(0);
    expect(session.doc.spend.savedUsd).toBe(entry.savedUsd);
    expect(session.doc.spend.totalUsd).toBe(0);
    const last = session.doc.conversation.at(-1)!;
    expect(last.text).toContain('Page 1 is back from an earlier version drawn from exactly this script — free');
    expect(labelsOf(last.nextSteps)).toContain('Fresh take of page 1');
  });

  it('R2 from the archive (no balloon snapshot) re-lays the balloons from the blueprint for free; a wrong-shape version is never brought back', async () => {
    const doc = onePage(plannedDoc());
    readySheets(doc);
    doc.planStatus = 'approved';
    const spec = pageSpecHash(doc, doc.pages[0]);
    doc.pages[0].render = { ...emptyRender(), status: 'ready', specHash: 'older-spec', asset: { path: 'cur.webp', source: 'generated', at: 3, w: 1024, h: 1280 } };
    // Balloons placed for the outgoing picture.
    doc.pages[0].balloons = [{ lineId: 'ln_1_2', x: 0.97, y: 0.97, w: 0.05 }];
    doc.archive = [
      { path: 'arch-square.webp', source: 'generated', at: 2, targetKey: 'page:pg_1', label: 'Page 1', archivedAt: 2, specHash: spec, aspect: '4:5', w: 2048, h: 2048 },
      { path: 'arch-tall.webp', source: 'generated', at: 1, targetKey: 'page:pg_1', label: 'Page 1', archivedAt: 1, specHash: spec, aspect: '4:5', w: 1638, h: 2048 }
    ];
    const session = newSession(doc);
    const ctx = testContext(session);
    await runAction(ctx, { type: 'render_pages' }, { confirmed: true });
    expect(ctx.imagesFake.calls).toHaveLength(0);
    expect(vi.mocked(analyzePageRender)).not.toHaveBeenCalled();
    expect(session.doc.pages[0].render.asset?.path).toBe('arch-tall.webp');
    const balloon = session.doc.pages[0].balloons.find((b) => b.lineId === 'ln_1_2');
    expect(balloon).toBeTruthy();
    expect(balloon!.x).not.toBe(0.97);
    expect(session.doc.spend.totalUsd).toBe(0);
  });

  it('R2 never applies to an explicit redraw', async () => {
    const doc = onePage(plannedDoc());
    readySheets(doc);
    const spec = pageSpecHash(doc, doc.pages[0]);
    doc.pages[0].render = { ...emptyRender(), status: 'failed', history: [{ path: 'same-spec.webp', source: 'generated', at: 1, specHash: spec }] };
    const session = newSession(doc);
    const ctx = testContext(session);
    await runAction(ctx, { type: 'render_pages', force: true }, { confirmed: true });
    expect(ctx.imagesFake.calls).toHaveLength(1);
    expect(session.doc.pages[0].render.asset?.path).toMatch(/gen-/);
  });

  it('R3: an asset made by the identical job is copied for free', async () => {
    const make = () => {
      const doc = onePage(plannedDoc());
      readySheets(doc);
      doc.planStatus = 'approved';
      return doc;
    };
    const first = newSession(make());
    await runAction(testContext(first), { type: 'render_pages' }, { confirmed: true });
    const jobHash = first.doc.pages[0].render.jobHash!;
    expect(jobHash).toBeTruthy();

    const doc = make();
    doc.pages[0].render = { ...emptyRender(), status: 'none', history: [{ path: 'identical.webp', source: 'generated', at: 1, jobHash, specHash: 'older-spec' }] };
    const session = newSession(doc);
    const ctx = testContext(session);
    await runAction(ctx, { type: 'render_pages' }, { confirmed: true });
    expect(ctx.imagesFake.calls).toHaveLength(0);
    expect(session.doc.pages[0].render).toMatchObject({ status: 'ready', origin: 'reused', jobHash, costUsd: 0, asset: { path: 'identical.webp' } });
    expect(session.doc.spend.entries[0]).toMatchObject({ usd: 0, savedUsd: expect.any(Number) });
    expect(session.doc.conversation.at(-1)!.text).toContain('Page 1 reused an identical earlier drawing — free');

    // A copied picture in the wrong frame is not silently passed off: same notice and free Fit chip as a fresh draw.
    const squareDoc = make();
    squareDoc.pages[0].render = { ...emptyRender(), status: 'none', history: [{ path: 'identical-square.webp', source: 'generated', at: 1, jobHash, w: 2048, h: 2048 }] };
    const squareSession = newSession(squareDoc);
    const squareCtx = testContext(squareSession);
    await runAction(squareCtx, { type: 'render_pages' }, { confirmed: true });
    expect(squareCtx.imagesFake.calls).toHaveLength(0);
    const want = squareSession.doc.pages[0].render.aspect!;
    const last = squareSession.doc.conversation.at(-1)!;
    expect(last.text).toContain(`Page 1 came back 1:1 instead of ${want}.`);
    expect(labelsOf(last.nextSteps)).toContain(`Fit to ${want} (Free)`);
  });

  it('R7: two identical jobs in flight pay once — the second joins the first', async () => {
    const session = newSession(plannedDoc());
    const ctx = testContext(session);
    await runAction(ctx, { type: 'render_style_options', directions: [{ name: 'Soft A', spec: 'Soft pastel washes' }, { name: 'Soft B', spec: 'Soft pastel washes' }] }, { confirmed: true });
    expect(ctx.imagesFake.calls).toHaveLength(1);
    const [a, b] = session.doc.style.options;
    expect(a.render.status).toBe('ready');
    expect(b.render.status).toBe('ready');
    expect(b.render.asset?.path).toBe(a.render.asset?.path);
    expect(session.doc.spend.entries.filter((e) => e.kind === 'style' && e.usd === 0 && (e.savedUsd || 0) > 0)).toHaveLength(1);
  });

  it('R7: when the leading twin fails, ONE waiting twin draws and the other joins it (never both pay)', async () => {
    const session = newSession(plannedDoc());
    const images = fakeImages((_req, i) => (i === 0 ? new StudioError('PROVIDER_ERROR', 'The provider refused this one.', { retryable: false }) : undefined));
    const ctx = testContext(session, { images });
    const same = { spec: 'Soft pastel washes' };
    await runAction(ctx, { type: 'render_style_options', directions: [{ name: 'Soft A', ...same }, { name: 'Soft B', ...same }, { name: 'Soft C', ...same }] }, { confirmed: true });
    expect(images.calls).toHaveLength(2); // the failed leader + one new leader
    const [a, b, c] = session.doc.style.options;
    expect(a.render.status).toBe('failed');
    expect(b.render.status).toBe('ready');
    expect(c.render.status).toBe('ready');
    expect(c.render.asset?.path).toBe(b.render.asset?.path);
    const style = session.doc.spend.entries.filter((e) => e.kind === 'style');
    expect(style.filter((e) => e.usd > 0)).toHaveLength(1);
    expect(style.filter((e) => e.usd === 0 && (e.savedUsd || 0) > 0)).toHaveLength(1);
  });
});

// ── QC once / relayout ───────────────────────────────────────────────────────

describe('QC once and free relayout', () => {
  it('relayout_balloons uses the stored QC boxes with no AI call; useVision makes exactly one vision call', async () => {
    const doc = onePage(plannedDoc());
    doc.pages[0].render = {
      ...emptyRender(),
      status: 'ready',
      asset: { path: 'p1.webp', source: 'generated', at: 1 },
      qc: { score: 0.9, issues: [], checkedAt: 1, panelBoxes: [{ x: 0, y: 0, w: 1, h: 0.3 }, { x: 0, y: 0.3, w: 1, h: 0.3 }, { x: 0, y: 0.6, w: 1, h: 0.4 }] }
    };
    const session = newSession(doc);
    const ctx = testContext(session);
    const free = await startAction(ctx, { type: 'relayout_balloons', pageId: 'pg_1' }, { confirmed: false });
    expect(free.outcome.message).toContain('free');
    expect(vi.mocked(analyzePageRender)).not.toHaveBeenCalled();
    expect(session.doc.pages[0].balloons.map((b) => b.lineId)).toEqual(['ln_1_2']);
    vi.mocked(analyzePageRender).mockImplementation(async ({ llm, page }) => {
      await llm.complete({ role: 'vision', messages: [{ role: 'user', content: 'check' }] });
      return { qc: { score: 0.7, issues: [], checkedAt: 2 }, balloons: page.panels.flatMap((p) => p.lines.map((l) => ({ lineId: l.id, x: 0.2, y: 0.2, w: 0.3 }))), model: 'v' };
    });
    // The paid re-check is a gated spend of its own (lettering.md §9): useVision never calls vision by itself.
    const gated = await startAction(ctx, { type: 'relayout_balloons', pageId: 'pg_1', useVision: true }, { confirmed: false });
    expect(gated.outcome.status).toBe('gated');
    expect(session.doc.gate).toMatchObject({ status: 'open', action: { type: 'recheck_page', pageId: 'pg_1' }, model: 'Page check', imageCount: 0 });
    expect(session.doc.gate!.estimateUsd).toBeGreaterThan(0);
    expect(vi.mocked(analyzePageRender)).not.toHaveBeenCalled();
    // Approving it runs exactly one vision call, recorded on the ledger as QC text.
    await runAction(ctx, { type: 'approve_gate', gateId: session.doc.gate!.id }, { confirmed: true });
    expect(vi.mocked(analyzePageRender)).toHaveBeenCalledTimes(1);
    expect(ctx.llmFake.calls.filter((c) => c.role === 'vision')).toHaveLength(1);
    expect(session.doc.pages[0].render.qc?.score).toBe(0.7);
    expect(session.doc.spend.entries.filter((e) => e.kind === 'qc')).toHaveLength(1);
    expect(session.doc.conversation.at(-1)!.text).toMatch(/^Re-checked page 1 \(\$0\.\d+|^Re-checked page 1 \(<\$0\.01\)/);
  });

  it('recheck_page: a click runs one priced vision call; never on an undrawn, busy or blocked page or without a key', async () => {
    const drawn = () => {
      const doc = onePage(plannedDoc());
      doc.pages[0].render = { ...emptyRender(), status: 'ready', asset: { path: 'p1.webp', source: 'generated', at: 1 }, qc: { score: 0.9, issues: [], checkedAt: 1 } };
      return doc;
    };
    vi.mocked(analyzePageRender).mockImplementation(async ({ llm, page }) => {
      await llm.complete({ role: 'vision', messages: [{ role: 'user', content: 'check' }] });
      return {
        qc: { score: 0.8, issues: [], checkedAt: 3, keepOut: [{ panel: 1, kind: 'face', box: { x: 0.4, y: 0.05, w: 0.2, h: 0.1 } }] },
        balloons: page.panels.flatMap((p) => p.lines.map((l) => ({ lineId: l.id, x: 0.1, y: 0.1, w: 0.3 }))),
        model: 'v'
      };
    });
    // Undrawn: nothing to re-check ($0, no call).
    const undrawn = newSession(onePage(plannedDoc()));
    const u = await startAction(testContext(undrawn), { type: 'recheck_page', pageId: 'pg_1' }, { confirmed: true });
    expect(u.outcome).toMatchObject({ status: 'blocked' });
    expect(u.outcome.message).toMatch(/isn't drawn yet/);
    // No key: honest, nothing called.
    const nokey = newSession(drawn());
    const k = await startAction(testContext(nokey, { keys: {} }), { type: 'recheck_page', pageId: 'pg_1' }, { confirmed: true });
    expect(k.outcome.message).toMatch(/Connect a Gemini or OpenRouter key/);
    // A blocked current take is never sent anywhere.
    const blockedDoc = drawn();
    blockedDoc.pages[0].render.asset = { ...blockedDoc.pages[0].render.asset!, safety: { assessed: 'X', at: 1 } };
    const b = await startAction(testContext(newSession(blockedDoc)), { type: 'recheck_page', pageId: 'pg_1' }, { confirmed: true });
    expect(b.outcome.message).toMatch(/didn't pass the content check/);
    expect(vi.mocked(analyzePageRender)).not.toHaveBeenCalled();
    // The click (with its quote) is the confirmation: one call, the faces keep-out is stored, the message is honest.
    const session = newSession(drawn());
    const ctx = testContext(session);
    const quotedUsd = estimateSpendAction(session.doc, { type: 'recheck_page', pageId: 'pg_1' }, false).usd;
    const ran = await startAction(ctx, { type: 'recheck_page', pageId: 'pg_1', quotedUsd }, { confirmed: true });
    expect(ran.outcome.status).toBe('done');
    expect(vi.mocked(analyzePageRender)).toHaveBeenCalledTimes(1);
    expect(session.doc.pages[0].render.qc?.keepOut?.[0].kind).toBe('face');
    expect(ran.outcome.message).toMatch(/Re-checked page 1 .*keeping faces clear/);
    expect(session.doc.conversation.at(-1)!.cards?.[0]).toMatchObject({ type: 'notice', tone: 'success' });
  });
});

// ── Safety hooks (safety.md §14 #24–26, with a fake safety module) ──────────

describe('safety hooks', () => {
  it('#24 a blocked verdict: the seam quarantines and restores the previous version; the blocked image is never published', async () => {
    const doc = onePage(plannedDoc());
    readySheets(doc);
    doc.pages[0].render = { ...emptyRender(), status: 'ready', asset: { path: 'good.webp', source: 'generated', at: 1, safety: { assessed: 'G', at: 1 } } };
    const session = newSession(doc);
    const ctx = testContext(session);
    vi.mocked(analyzePageRender).mockResolvedValue({
      qc: { score: 0.9, issues: [], checkedAt: 1 },
      balloons: [],
      model: 'v',
      safety: { assessed: 'X', categories: ['gore'], at: 2, by: 'qc' }
    } as never);
    vi.mocked(onRenderVerdict).mockImplementation(async (c, target, asset, verdict) => {
      if (verdict?.assessed !== 'X') return;
      await c.assets.quarantine(asset.path, 'blocked');
      c.session.commit([{ op: 'asset_meta', path: asset.path, patch: { safety: { ...verdict, quarantined: true } } }]);
      const prev = getRender(c.session.doc, target)!.history.find((v) => canServeToOwner(v));
      if (prev) c.session.commit([{ op: 'render_use', target, path: prev.path, at: Date.now() }]);
    });
    await runAction(ctx, { type: 'render_pages', pageIds: ['pg_1'], force: true }, { confirmed: true });
    const drawn = ctx.assetsFake.quarantined[0].path;
    expect(vi.mocked(onRenderVerdict)).toHaveBeenCalledWith(expect.anything(), { kind: 'page', id: 'pg_1' }, expect.objectContaining({ path: drawn }), expect.objectContaining({ assessed: 'X' }));
    const published = ctx.events.flatMap((e) => (e.type === 'urls' ? Object.keys(e.urls) : []));
    expect(published).not.toContain(drawn);
    expect(published).toContain('good.webp');
    expect(session.doc.pages[0].render.asset?.path).toBe('good.webp');
    expect(session.doc.conversation.at(-1)!.text).toContain("didn't fit the content rules, so the previous version is back");
  });

  it('#25 reveal after the verdict: the URL follows the verdict; a slow check fails open after the deadline and the image stays unchecked', async () => {
    const doc = onePage(plannedDoc());
    readySheets(doc);
    const session = newSession(doc);
    const ctx = testContext(session);
    await runAction(ctx, { type: 'render_pages' }, { confirmed: true });
    const path = session.doc.pages[0].render.asset!.path;
    const metaAt = ctx.events.findIndex((e) => e.type === 'ops' && e.ops.some((o) => o.op === 'asset_meta' && o.path === path));
    const urlAt = ctx.events.findIndex((e) => e.type === 'urls' && path in e.urls);
    expect(metaAt).toBeGreaterThan(-1);
    expect(urlAt).toBeGreaterThan(metaAt);
    expect(session.doc.pages[0].render.asset?.safety).toBeUndefined();
    // The pending verdict was committed with the image.
    expect(opsOf(ctx.events).some((o) => o.op === 'render' && o.patch.asset?.path === path && o.patch.asset.safety?.pending === true)).toBe(true);

    JOB_TIMINGS.safetyFailOpenMs = 10;
    const slow = newSession(onePage(plannedDoc('slow')));
    readySheets(slow.doc);
    const slowCtx = testContext(slow);
    vi.mocked(onRenderVerdict).mockImplementation(() => new Promise((r) => setTimeout(r, 60)));
    await runAction(slowCtx, { type: 'render_pages', force: true }, { confirmed: true });
    const slowPath = slow.doc.pages[0].render.asset!.path;
    const slowUrl = slowCtx.events.findIndex((e) => e.type === 'urls' && slowPath in e.urls);
    const slowMeta = slowCtx.events.findIndex((e) => e.type === 'ops' && e.ops.some((o) => o.op === 'asset_meta' && o.path === slowPath));
    expect(slowUrl).toBeGreaterThan(-1);
    expect(slowUrl).toBeLessThan(slowMeta);
    expect(slow.doc.pages[0].render.asset?.safety).toBeUndefined();
  });

  it('#26 safe take: the filter declines once, the safer recompile draws it, the spend is recorded once, and the user is told', async () => {
    const doc = onePage(plannedDoc());
    readySheets(doc);
    const session = newSession(doc);
    const images = fakeImages((_req, i) => (i === 0 ? new StudioError('SAFETY_BLOCKED', "The image model's safety filter declined this one.", { status: 422 }) : undefined));
    const ctx = testContext(session, { images });
    await runAction(ctx, { type: 'render_pages' }, { confirmed: true });
    expect(images.calls).toHaveLength(2);
    expect(images.calls[0].prompt).not.toContain('SAFE TAKE');
    expect(images.calls[1].prompt).toContain('SAFE TAKE');
    expect(session.doc.pages[0].render).toMatchObject({ status: 'ready', note: 'Safer take' });
    // The image is billed once; the declined take is recorded as a failed $0 attempt (models.md §3.4 item 9).
    expect(session.doc.spend.entries.filter((e) => e.kind === 'page' && e.outcome !== 'failed')).toHaveLength(1);
    expect(session.doc.spend.entries.filter((e) => e.kind === 'page' && e.outcome === 'failed')).toEqual([expect.objectContaining({ usd: 0, model: 'nano-banana-2.1' })]);
    expect(session.doc.conversation.at(-1)!.text).toContain('a little tamer');
  });
});

// ── Rate limits (production incident follow-ups) ─────────────────────────────

describe('provider rate limits', () => {
  it('after the first rate limit, the run\'s remaining images go one at a time', async () => {
    const doc = plannedDoc();
    readySheets(doc);
    doc.pages = [...doc.pages, ...[4, 5].map((n) => ({ ...doc.pages[2], id: `pg_${n}`, n, panels: doc.pages[2].panels.map((p) => ({ ...p, id: `pn_${n}_${p.n}`, action: `Action ${n}.${p.n}`, lines: [] })) }))];
    const session = newSession(doc);
    const log: string[] = [];
    let limited = false;
    const images = fakeImages(async (req) => {
      const n = pageOf(req.prompt);
      log.push(`start ${n}`);
      if (n === 2 && !limited) {
        limited = true;
        log.push(`429 ${n}`);
        return rateLimited();
      }
      await new Promise((r) => setTimeout(r, 15));
      log.push(`end ${n}`);
      return undefined;
    });
    const ctx = testContext(session, { images });
    await runAction(ctx, { type: 'render_pages' }, { confirmed: true });
    expect(session.doc.pages.every((p) => p.render.status === 'ready')).toBe(true);
    // Page 5 was still waiting for a slot when page 2 hit the limit: it starts only after everything else ended.
    const start5 = log.indexOf('start 5');
    for (const n of [2, 3, 4]) expect(log.lastIndexOf(`end ${n}`)).toBeLessThan(start5);
    expect(log.indexOf('429 2')).toBeLessThan(start5);
  });

  it('a rate-limited image is re-queued once after Retry-After ("waiting for the provider…") and lands', async () => {
    const doc = onePage(plannedDoc());
    readySheets(doc);
    const session = newSession(doc);
    const images = fakeImages((_req, i) => (i < 2 ? rateLimited() : undefined));
    const ctx = testContext(session, { images });
    await runAction(ctx, { type: 'render_pages' }, { confirmed: true });
    expect(images.calls).toHaveLength(3);
    expect(session.doc.pages[0].render.status).toBe('ready');
    const waits = ctx.events.filter((e) => e.type === 'activity' && e.phase === 'start' && /^Waiting for the provider… page 1 retries in \d+ s$/.test(e.label));
    expect(waits).toHaveLength(1);
    expect(opsOf(ctx.events).some((o) => o.op === 'render' && o.patch.status === 'failed')).toBe(false);
    expect(ctx.billingFake.released).toEqual(['RATE_LIMIT']);
  });

  it('still rate-limited after the re-queue: failed, with the real outcome and a sanitized provider detail', async () => {
    const doc = onePage(plannedDoc());
    readySheets(doc);
    const session = newSession(doc);
    const images = fakeImages(() => rateLimited());
    const ctx = testContext(session, { images });
    await runAction(ctx, { type: 'render_pages' }, { confirmed: true });
    expect(images.calls).toHaveLength(4); // 2 attempts × (first try + one re-queue)
    // The tile keeps the precise reason and the provider facts for its Details row.
    expect(session.doc.pages[0].render).toMatchObject({ status: 'failed', error: expect.stringContaining('rate limited'), errorDetail: { code: '429', provider: 'OpenRouter' } });
    expect(session.doc.pages[0].render.errorDetail!.text).toMatch(/^OpenRouter · 429 · upstream Google · \d\d:\d\d UTC$/);
    // The message is the calm §3.6 G copy (never the raw error), with what was already tried.
    const text = session.doc.conversation.at(-1)!.text;
    expect(text).toMatch(/^Google is rate-limiting Nano Banana 2\.1 right now \(OpenRouter · 429 · upstream Google\)\. Page 1 wasn't drawn, and you weren't charged for it\. Your comic stays on Nano Banana 2\.1 so every page matches\./);
    expect(text).toContain('I already waited for the provider and tried it once more.');
    expect(text).not.toMatch(/sk-|Bearer|failed —/);
  });

  it('cancelling while waiting for the provider stops honestly (not failed, nothing left queued)', async () => {
    JOB_TIMINGS.rateLimitRequeueMs = 5_000;
    const doc = onePage(plannedDoc());
    readySheets(doc);
    const session = newSession(doc);
    const images = fakeImages(() => rateLimited(0));
    const ctx = testContext(session, { images });
    const run = runAction(ctx, { type: 'render_pages' }, { confirmed: true });
    await vi.waitFor(() => expect(ctx.events.some((e) => e.type === 'activity' && e.label.startsWith('Waiting for the provider'))).toBe(true));
    session.abort.abort();
    await run;
    expect(session.doc.pages[0].render.status).toBe('none');
    expect(session.doc.conversation.at(-1)!.text).toContain('Stopped before page 1');
  });
});

// ── planPages ────────────────────────────────────────────────────────────────

describe('planPages (v5)', () => {
  const writerReturns = (pages: (doc: ComicDoc, pageIds?: string[]) => Page[]) =>
    vi.mocked(writePagePlan).mockImplementation(async ({ doc, llm, pageIds }) => {
      await llm.complete({ role: 'writer', messages: [{ role: 'user', content: 'plan' }] });
      return { pages: pages(doc, pageIds), newCast: [], model: 'writer-x' };
    });

  it('runs the cast scan and commits recurring uncast beings; the tool result names them', async () => {
    const session = newSession(lakeDoc());
    const ctx = testContext(session);
    writerReturns((doc) => doc.pages.map((p) => ({ ...p, id: `fresh_${p.n}` })));
    vi.mocked(findUncastBeings).mockReturnValue([
      { noun: 'duckling', name: 'Ducklings', kind: 'animal', count: 3, panels: 3, firstMention: 'p1 panel 1' },
      { noun: 'frog', name: 'Frog', kind: 'animal', panels: 2, firstMention: 'p1 panel 2' }
    ]);
    vi.mocked(castOpsForUncast).mockImplementation((_doc, beings) =>
      beings.map((b) => ({ op: 'character' as const, id: `c_${b.noun}`, patch: { name: b.name, tier: 'extra' as const, kind: b.kind, ...(b.count ? { count: b.count } : {}), look: { summary: `${b.name} from the script` } } }))
    );
    const cards: Card[] = [];
    const outcome = await planPages(ctx, {}, { collectCard: (c) => cards.push(c) });
    expect(session.doc.cast.find((c) => c.name === 'Ducklings')).toMatchObject({ kind: 'animal', count: 3, tier: 'extra' });
    expect(session.doc.cast.map((c) => c.name)).toContain('Frog');
    expect(outcome.message).toContain('Also added to the cast so they stay consistent: Ducklings ×3, Frog.');
    expect(cards).toEqual([expect.objectContaining({ type: 'breakdown', view: 'plan' })]);
    expect(session.doc.pages[0].id).toBe('pg_lake_1'); // nothing drawn: identity by position is kept
  });

  it('R5: re-planning with unchanged inputs and no instructions is free; instructions or a changed brief call the writer', async () => {
    const session = newSession(lakeDoc());
    const ctx = testContext(session);
    writerReturns((doc) => doc.pages);
    await planPages(ctx, {});
    const again = await planPages(ctx, {});
    expect(vi.mocked(writePagePlan)).toHaveBeenCalledTimes(1);
    expect(again.message).toContain('unchanged inputs');
    expect(session.doc.conversation.at(-1)!.text).toContain('no writer call ($0)');
    await planPages(ctx, { instructions: 'make it funnier' });
    expect(vi.mocked(writePagePlan)).toHaveBeenCalledTimes(2);
    session.commit([{ op: 'brief', patch: { tone: 'spooky' } }]);
    await planPages(ctx, {});
    expect(vi.mocked(writePagePlan)).toHaveBeenCalledTimes(3);
  });

  it('with pages drawn, a full re-plan to a different page count is refused before any paid call', async () => {
    const doc = plannedDoc();
    doc.pages[0] = readyPage(doc.pages[0], 'p1.webp');
    doc.format.pageCount = 5;
    const session = newSession(doc);
    const ctx = testContext(session);
    const outcome = await planPages(ctx, {});
    expect(outcome).toMatchObject({ status: 'blocked', message: expect.stringContaining('revise_pages') });
    expect(vi.mocked(writePagePlan)).not.toHaveBeenCalled();
    expect(session.doc.spend.entries).toHaveLength(0);
    expect(session.doc.pages[0].render.asset?.path).toBe('p1.webp');
  });

  it('a plan click at the budget cap never runs the paid writer; under the cap it still plans', async () => {
    const atCap = plannedDoc();
    atCap.settings = { ...atCap.settings, budgetUsd: 0.05 };
    atCap.spend = { ...atCap.spend, totalUsd: 0.09 };
    const session = newSession(atCap);
    const llm = scriptedLlm({ writer: [{ text: '{}' }] });
    const ctx = testContext(session, { llm });
    // The UI's "Plan the pages" / "Re-plan" button posts plan_pages as a confirmed click.
    const outcome = await startAction(ctx, { type: 'plan_pages', instructions: 'make it funnier' }, { confirmed: true, origin: 'user' });
    expect(outcome.outcome).toMatchObject({ status: 'blocked', code: 'BUDGET_EXCEEDED' });
    expect(vi.mocked(writePagePlan)).not.toHaveBeenCalled();
    expect(llm.calls.filter((c) => c.role === 'writer')).toHaveLength(0);
    expect(ctx.billingFake.reserves.filter((r) => r.stage === 'plan')).toHaveLength(0);
    expect(session.doc.spend.totalUsd).toBe(0.09);
    const last = session.doc.conversation.at(-1)!;
    expect(last.text).toContain('at its budget cap');
    expect(last.text).toContain('Nothing was spent.');
    expect(last.cards).toContainEqual(expect.objectContaining({ type: 'notice', tone: 'info' }));
    // …with a "Raise the budget" chip first (it opens the comic's settings at the budget cap).
    expect(last.nextSteps?.[0]).toEqual({ label: 'Raise the budget', client: { type: 'open_settings', section: 'budget' } });

    // Under the cap the same click plans as before.
    const under = plannedDoc();
    under.settings = { ...under.settings, budgetUsd: 1 };
    under.spend = { ...under.spend, totalUsd: 0.09 };
    const session2 = newSession(under);
    const ctx2 = testContext(session2);
    writerReturns((doc) => doc.pages);
    await startAction(ctx2, { type: 'plan_pages', instructions: 'make it funnier' }, { confirmed: true, origin: 'user' });
    expect(vi.mocked(writePagePlan)).toHaveBeenCalledTimes(1);
    expect(ctx2.billingFake.reserves.filter((r) => r.stage === 'plan')).toHaveLength(1);
  });

  it('a page that got art while planning and is dropped by the new plan goes to the trash, never lost', async () => {
    const doc = plannedDoc();
    doc.format.pageCount = 2;
    const session = newSession(doc);
    const ctx = testContext(session);
    vi.mocked(writePagePlan).mockImplementation(async () => {
      // A render lands on page 3 while the writer is busy.
      session.commit([{ op: 'render', target: { kind: 'page', id: 'pg_3' }, patch: { status: 'ready', asset: { path: 'late.webp', source: 'generated', at: 5 } } }]);
      return { pages: plannedDoc().pages.slice(0, 2).map((p) => ({ ...p, id: `new_${p.n}` })), newCast: [], model: 'w' };
    });
    await planPages(ctx, {});
    expect(session.doc.pages.map((p) => p.id)).toEqual(['pg_1', 'pg_2']);
    expect(session.doc.trash?.[0].page).toMatchObject({ id: 'pg_3', render: { asset: { path: 'late.webp' } } });
  });
});

// ── nextStepsFor ─────────────────────────────────────────────────────────────

describe('nextStepsFor', () => {
  it('acts: priced spend chips carry their quote; navigation is a client action; compare versions comes before redraw', () => {
    const doc = plannedDoc();
    doc.planStatus = 'approved';
    doc.pages = doc.pages.map((p, i) => readyPage(p, `p${i}.webp`));
    doc.pages[1].render = {
      ...doc.pages[1].render,
      qc: { score: 0.2, issues: ['ARJUN is missing'], checkedAt: 1 },
      history: [{ path: 'older.webp', source: 'generated', at: 0 }]
    };
    const steps = nextStepsFor(doc);
    const labels = labelsOf(steps);
    expect(labels.indexOf('Compare page 2 versions')).toBeLessThan(labels.indexOf('Redraw page 2'));
    expect(steps.find((s) => s.label === 'Compare page 2 versions')).toMatchObject({ client: { type: 'open_page', pageId: 'pg_2' } });
    const cover = steps.find((s) => s.label === 'Make the cover')!;
    expect(cover.action).toMatchObject({ type: 'render_cover', quotedUsd: cover.usd });
    expect(steps.length).toBeLessThanOrEqual(4);
  });

  it('"Make the cover" as soon as page 1 is ready; "Share it" after the last page; "Update the published version" when behind', () => {
    const doc = plannedDoc();
    doc.planStatus = 'approved';
    doc.pages[0] = readyPage(doc.pages[0], 'p1.webp');
    expect(labelsOf(nextStepsFor(doc))).toContain('Make the cover');
    doc.pages = doc.pages.map((p, i) => readyPage(p, `p${i}.webp`));
    doc.cover.render = { ...emptyRender(), status: 'ready', asset: { path: 'c.webp', source: 'generated', at: 1 } };
    expect(labelsOf(nextStepsFor(doc))).toEqual(expect.arrayContaining(['Read it', 'Share it']));
    doc.publication = { visibility: 'unlisted', status: 'live', publishedRev: 1, publishedAt: 10, languages: ['en'] };
    doc.pages[0].render = { ...doc.pages[0].render, updatedAt: 20 };
    expect(labelsOf(nextStepsFor(doc))).toContain('Update the published version');
  });
});


// ── Feature spends, caps, adoption ───────────────────────────────────────────

describe('feature spend handlers, caps and adoption', () => {
  it('a feature spend with an estimate (translate) goes through estimate → gate; a confirmed spend runs; a stale quote re-gates', async () => {
    const run = vi.fn(async () => ({ outcome: { status: 'done' as const, message: 'Translated.' }, done: Promise.resolve() }));
    const handler: ActionHandler = { type: 'translate', spend: true, estimate: async () => ({ usd: 0.4, imageCount: 0, model: 'Sonnet 5.5', lines: [] }), run };
    const doc = plannedDoc();
    doc.settings.confirm = 'always';
    const session = newSession(doc);
    const ctx = testContext(session);
    const gated = await runFeatureAction(ctx, handler, { type: 'translate', languages: ['te'] }, { confirmed: false });
    expect(gated.outcome.status).toBe('gated');
    expect(session.doc.gate).toMatchObject({ reason: 'policy', estimateUsd: 0.4, model: 'Sonnet 5.5', action: { type: 'translate', languages: ['te'] } });
    expect(session.doc.conversation.at(-1)!.text).toContain('≈ $0.40');
    expect(run).not.toHaveBeenCalled();
    const ran = await runFeatureAction(ctx, handler, { type: 'translate', languages: ['te'], quotedUsd: 0.4 }, { confirmed: true });
    expect(ran.outcome.status).toBe('done');
    expect(run).toHaveBeenCalledTimes(1);
    const stale = await runFeatureAction(ctx, handler, { type: 'translate', languages: ['hi'], quotedUsd: 0.1 }, { confirmed: true });
    expect(stale.outcome.status).toBe('gated');
    expect(run).toHaveBeenCalledTimes(1);
    // A handler without an estimate (wave-0 stubs, non-spend actions) runs directly.
    const plain = vi.fn(async () => ({ outcome: { status: 'done' as const, message: 'ok' }, done: Promise.resolve() }));
    await runFeatureAction(ctx, { type: 'fit_render', spend: false, run: plain }, { type: 'fit_render', target: { kind: 'page', id: 'pg_1' } }, { confirmed: true });
    expect(plain).toHaveBeenCalledTimes(1);
  });

  it('caps decide quality access when given: a tier the user lacks is blocked with a one-tap fix; allowed tiers run', async () => {
    const doc = plannedDoc();
    doc.settings.quality = 'pro';
    const session = newSession(doc);
    const ctx = testContext(session, { caps: DEFAULT_CAPS });
    const blockedOut = await startAction(ctx, { type: 'render_cover' }, { confirmed: true });
    expect(blockedOut.outcome).toMatchObject({ status: 'blocked', message: expect.stringContaining('Pro quality needs a paid plan or your own key') });
    const chip = session.doc.conversation.at(-1)!.nextSteps?.[0];
    expect(chip).toMatchObject({ label: 'Switch to Standard quality', usd: 0, action: { type: 'patch', ops: [{ op: 'settings', patch: { quality: 'standard' } }] } });
    expect(ctx.imagesFake.calls).toHaveLength(0);
    const paid = testContext(newSession(doc), { caps: { ...DEFAULT_CAPS, qualityTiers: ['draft', 'standard', 'pro'] } });
    await runAction(paid, { type: 'render_cover' }, { confirmed: true });
    expect(paid.imagesFake.calls).toHaveLength(1);
  });

  it('any image the project owns can become a reference or the style board (Media bin); blocked and foreign images cannot', () => {
    const doc = plannedDoc();
    doc.pages[0] = readyPage(doc.pages[0], 'u/user-1/p/proj-1/img/page1.webp');
    doc.pages[1] = { ...doc.pages[1], render: { ...emptyRender(), status: 'ready', asset: { path: 'u/user-1/p/proj-1/img/bad.webp', source: 'generated', at: 1, safety: { quarantined: true, at: 1 } } } };
    doc.archive = [{ path: 'u/user-1/p/proj-1/img/old.webp', source: 'generated', at: 1, targetKey: 'page:pg_3', label: 'Page 3', archivedAt: 2, specHash: 'x' }];
    const [board] = sanitizePatchOps(doc, [{ op: 'style', patch: { board: { path: 'u/user-1/p/proj-1/img/page1.webp' } } }]);
    expect(board).toMatchObject({ op: 'style', patch: { board: { path: 'u/user-1/p/proj-1/img/page1.webp', source: 'generated' } } });
    const [refs] = sanitizePatchOps(doc, [{ op: 'character', id: 'c_maya', patch: { refs: [{ path: 'u/user-1/p/proj-1/img/old.webp' }] } }]);
    const ref = (refs as Extract<typeof refs, { op: 'character' }>).patch.refs![0];
    expect(ref).toMatchObject({ path: 'u/user-1/p/proj-1/img/old.webp' });
    expect(ref).not.toHaveProperty('targetKey');
    expect(ref).not.toHaveProperty('label');
    expect(ref).not.toHaveProperty('specHash');
    expect(() => sanitizePatchOps(doc, [{ op: 'style', patch: { board: { path: 'u/user-1/p/proj-1/img/bad.webp' } } }])).toThrow('Invalid style: board');
    expect(() => sanitizePatchOps(doc, [{ op: 'style', patch: { refs: [{ path: 'u/other/p/x/img/secret.webp' }] } }])).toThrow('Invalid style: refs');
  });
});

// ── Acceptance: the owner's lake session ─────────────────────────────────────

describe("acceptance: the owner's lake session replayed with fakes", () => {
  it('correct order, no redraw of a ready page, breakdown cards, honest shape notice, never silent', async () => {
    const session = newSession(lakeDoc());
    const ctx = testContext(session);
    // The real session's sizes: sheet 3:2, page 1 square (the bug), cover 4:5.
    ctx.assetsFake.generatedSize = (n) => (n === 1 ? { w: 2528, h: 1696 } : n === 2 ? { w: 2048, h: 2048 } : { w: 1856, h: 2304 });

    // 12:44:16 "Use watercolor storybook style" — the director wants to draw: the first render waits for
    // approval and the user sees exactly what will be drawn (breakdown above the gate).
    const t1 = await directorTurn(ctx, 'Use watercolor storybook style', async ({ opts }) => {
      const started = await startTracked(ctx, { type: 'render_pages' }, opts);
      expect(started.outcome.status).toBe('gated');
      return "Here's your page — approve to draw it.";
    });
    const reply1 = session.doc.conversation.find((m) => m.id === t1.replyId)!;
    expect(reply1.cards?.map((c) => c.type)).toEqual(['breakdown', 'gate']);
    expect(session.doc.gate?.reason).toBe('first_render');
    expect(ctx.imagesFake.calls).toHaveLength(0);

    // 12:44:49 the user taps Approve.
    await runAction(ctx, { type: 'approve_gate', gateId: session.doc.gate!.id }, { confirmed: true });
    expect(ctx.imagesFake.calls).toHaveLength(2); // the baby's sheet + page 1
    expect(session.doc.planStatus).toBe('approved');
    const approved = session.doc.conversation.at(-1)!;
    expect(approved.text).toContain('Page 1 came back 1:1 instead of 4:5.');
    expect(labelsOf(approved.nextSteps)).toContain('Fit to 4:5 (Free)');

    // 12:46:58 "generate all pages" on a drawn, current 1-page book: nothing to draw, $0, breakdown.
    const spent = session.doc.spend.totalUsd;
    const t2 = await directorTurn(ctx, 'generate all pages', async ({ opts }) => {
      const started = await startTracked(ctx, { type: 'render_pages', pageIds: ['pg_lake_1'] }, opts);
      expect(started.outcome.status).toBe('nothing');
      return started.outcome.message;
    });
    expect(ctx.imagesFake.calls).toHaveLength(2);
    expect(session.doc.spend.totalUsd).toBe(spent);
    const reply2 = session.doc.conversation.find((m) => m.id === t2.replyId)!;
    expect(reply2.cards?.map((c) => c.type)).toEqual(['breakdown']);
    expect(reply2.text).toContain('Page 1 is already drawn and up to date');
    expect(labelsOf(reply2.nextSteps)).toEqual(expect.arrayContaining(['Make the cover', 'New take of page 1']));

    // 13:02 "make the cover" — the reply (with the live card) comes first, the completion after it.
    const t3 = await directorTurn(ctx, 'make the cover', async ({ opts }) => {
      const started = await startTracked(ctx, { type: 'render_cover' }, opts);
      expect(started.outcome.status).toBe('started');
      return 'The cover is on its way.';
    });
    const conv = session.doc.conversation;
    const i3 = conv.findIndex((m) => m.id === t3.replyId);
    expect(conv[i3 - 1]).toMatchObject({ role: 'user', text: 'make the cover' });
    expect(conv[i3].cards?.map((c) => c.type)).toEqual(['renders']);
    expect(conv[i3 + 1].text).toMatch(/^The cover is ready \(\$0\.\d\d\)\./);
    expect(conv).toHaveLength(i3 + 2);
    expect(session.doc.cover.render).toMatchObject({ status: 'ready', aspect: '4:5' });

    // Never silent: every assistant message without a live progress card has text.
    for (const m of conv) if (m.role === 'assistant' && !m.cards?.some((c) => c.type === 'renders')) expect(m.text.trim()).not.toBe('');
  });
});

it('fakes stay honest: TINY_PNG is a valid data URL and KEYS route via OpenRouter', () => {
  expect(TINY_PNG.startsWith('data:image/png;base64,')).toBe(true);
  expect(KEYS.openrouter?.byok).toBe(false);
  expect(scriptedLlm).toBeTypeOf('function');
});

// ── Text holds cover the fallback chain ──────────────────────────────────────

describe('billedLlm reserves', () => {
  it('names every model of the route’s fallback chain, so the hold is priced at the dearest, not the primary', async () => {
    const session = newSession(plannedDoc());
    const seen: { model: string; models?: string[] }[] = [];
    const base = fakeBilling();
    const billing: FakeBilling = {
      ...base,
      async reserve(args) {
        seen.push({ model: args.model, models: args.models });
        return base.reserve(args);
      }
    };
    const ctx = testContext(session, { billing });
    const route = resolveTextRoute('director', ctx.keys)!;
    expect(route.models.length).toBeGreaterThan(1);
    await billedLlm(ctx, { stage: 'chat', operation: 'comic.text.director', tracker: newTextSpendTracker() }).complete({ role: 'director', messages: [{ role: 'user', content: 'hi' }] });
    expect(seen).toEqual([{ model: route.model, models: route.models }]);
  });
});

// ── BYOK image routing (the user's own Gemini key beside the platform OpenRouter key) ──

describe('own Gemini key beside the platform OpenRouter key', () => {
  /** Production shape: the platform OpenRouter key from env plus the user's own Gemini key. */
  const OWN_GEMINI: StudioKeys = { openrouter: { key: 'sk-or-platform', byok: false }, gemini: { key: 'AIza-own', byok: true } };
  const OWN_BOTH: StudioKeys = { openrouter: { key: 'sk-or-own', byok: true }, gemini: { key: 'AIza-own', byok: true } };
  const spec = getImageModel('nano-banana-2.1')!;

  /** Billing hooks that remember which provider each reserve was made for (the fake keeps only the model). */
  const billingRecordingProvider = (allow: (provider: string) => boolean = () => true) => {
    const reserves: { provider: string; model: string; operation: string }[] = [];
    const base = fakeBilling();
    const billing: FakeBilling = {
      ...base,
      async reserve(args) {
        reserves.push({ provider: args.provider, model: args.model, operation: args.operation });
        if (!allow(args.provider)) return { ok: false, code: 'BILLING_DENIED', message: "You've used all of your DreamStream usage." };
        return base.reserve(args);
      }
    };
    return { billing, reserves };
  };

  it('imageRouteFor is the image client’s own pick, so the reserve names the key that draws; spendIsByok stays keys-level', () => {
    for (const keys of [KEYS, OWN_GEMINI, OWN_BOTH, { gemini: { key: 'AIza-own', byok: true } } as StudioKeys]) {
      const drawn = pickImageRoute(spec, keys);
      expect(imageRouteFor(spec, keys)).toEqual({ route: drawn.route, model: drawn.model, byok: drawn.key.byok });
    }
    // The own-Gemini-key user draws on Gemini direct — their own key, not the platform's.
    expect(imageRouteFor(spec, OWN_GEMINI)).toEqual({ route: 'gemini', model: spec.routes.gemini, byok: true });
    // …but at the keys level they are still a usage user: their text (OpenRouter-first) and OpenRouter-only
    // images run on the platform key, so caps, the cost view and text quotes stay governed.
    expect(spendIsByok(OWN_GEMINI)).toBe(false);
    expect(spendIsByok(OWN_BOTH)).toBe(true);
    expect(spendIsByok(KEYS)).toBe(false);
    expect(spendIsByok({ gemini: { key: 'AIza-own', byok: true } })).toBe(true);
    expect(imageRouteFor(spec, KEYS)).toMatchObject({ route: 'openrouter', byok: false });
    expect(imageRouteFor(spec, {})).toBeNull();
    // An OpenRouter-only model still goes through the platform key for that user (platform spend).
    const orOnly = getImageModel('flux-3')!;
    expect(orOnly.routes.gemini).toBeUndefined();
    expect(imageRouteFor(orOnly, OWN_GEMINI)).toMatchObject({ route: 'openrouter', byok: false });
  });

  it('a cover drawn on the user’s own Gemini key is reserved on the Gemini route as BYOK, quoted without the platform markup, and recorded as their own spend', async () => {
    const doc = plannedDoc();
    doc.settings = { ...doc.settings, confirm: 'never' };
    const session = newSession(doc);
    const { billing, reserves } = billingRecordingProvider();
    const images = fakeImages(() => ({ route: 'gemini', byok: true, model: spec.routes.gemini, costUsd: undefined }));
    const ctx = testContext(session, { keys: OWN_GEMINI, images, billing });
    const quote = estimateSpendAction(session.doc, { type: 'render_cover' }, imageRouteFor(spec, OWN_GEMINI)!.byok);
    await runAction(ctx, { type: 'render_cover' }, { confirmed: true });
    expect(images.calls).toHaveLength(1);
    expect(reserves).toEqual([{ provider: 'gemini', model: spec.routes.gemini, operation: 'comic.image.cover' }]);
    // Own key: the registry price, no platform markup — the same figure the ledger sees.
    expect(quote.usd).toBeCloseTo(imagePriceUsd(spec, '2K'), 6);
    expect(session.doc.spend.entries).toEqual([expect.objectContaining({ label: 'Cover', byok: true, usd: quote.usd })]);
    expect(session.doc.cover.render.status).toBe('ready');
  });

  it('usage used up: the cover still draws on the user’s own Gemini key (the platform key would be refused)', async () => {
    const doc = plannedDoc();
    doc.settings = { ...doc.settings, confirm: 'never' };
    const session = newSession(doc);
    // The real enforcer never budget-checks a BYOK call; a platform-key call of an exhausted user is refused.
    const { billing, reserves } = billingRecordingProvider((provider) => provider === 'gemini');
    const images = fakeImages(() => ({ route: 'gemini', byok: true, model: spec.routes.gemini, costUsd: undefined }));
    const ctx = testContext(session, { keys: OWN_GEMINI, images, billing });
    await runAction(ctx, { type: 'render_cover' }, { confirmed: true });
    expect(reserves.map((r) => r.provider)).toEqual(['gemini']);
    expect(images.calls).toHaveLength(1);
    expect(session.doc.cover.render.status).toBe('ready');
    expect(session.doc.conversation.at(-1)?.text).not.toMatch(/used all of your DreamStream usage/);
  });

  it('an approval re-prices like with like: the page re-check on the vision (text) route’s key, a drawing on its model’s route', async () => {
    const doc = onePage(plannedDoc());
    doc.pages[0].render = { ...emptyRender(), status: 'ready', asset: { path: 'p1.webp', source: 'generated', at: 1 }, qc: { score: 0.9, issues: [], checkedAt: 1 } };
    const session = newSession(doc);
    const ctx = testContext(session, { keys: OWN_GEMINI });
    const recheck: SpendAction = { type: 'recheck_page', pageId: 'pg_1' };
    // Text routes are OpenRouter-first: this user's re-check runs on the platform key; their cover on their own Gemini key.
    expect(resolveTextRoute('vision', OWN_GEMINI)?.key.byok).toBe(false);
    expect(spendActionIsByok(session.doc, recheck, OWN_GEMINI)).toBe(false);
    expect(spendActionIsByok(session.doc, { type: 'render_cover' }, OWN_GEMINI)).toBe(true);
    const gated = await startAction(ctx, recheck, { confirmed: false, forceGate: 'policy' });
    expect(gated.outcome.status).toBe('gated');
    const gate = session.doc.gate!;
    // The approval's re-estimate is the gate's own quote (platform price with the markup), not the own-key price.
    expect(estimateSpendAction(session.doc, gate.action as SpendAction, spendActionIsByok(session.doc, gate.action as SpendAction, OWN_GEMINI)).usd).toBe(gate.estimateUsd);
    expect(gate.estimateUsd).toBeCloseTo(estimateSpendAction(session.doc, recheck, false).usd, 6);
  });

  it('governed caps: an OpenRouter-only override is still refused (platform key), while Pro on their own Gemini key draws', async () => {
    // FLUX has no Gemini route: for this user it would draw on the PLATFORM key, so the plan's caps apply.
    const flux = plannedDoc();
    flux.settings = { ...flux.settings, confirm: 'never', imageModelOverride: 'flux-3' };
    const fluxSession = newSession(flux);
    const blockedRun = billingRecordingProvider();
    const fluxImages = fakeImages();
    const fluxCtx = testContext(fluxSession, { keys: OWN_GEMINI, images: fluxImages, billing: blockedRun.billing, caps: DEFAULT_CAPS });
    const refused = await startAction(fluxCtx, { type: 'render_cover' }, { confirmed: true });
    await refused.done;
    expect(refused.outcome).toMatchObject({ status: 'blocked' });
    expect(refused.outcome.message).toMatch(/FLUX/i);
    expect(blockedRun.reserves).toHaveLength(0);
    expect(fluxImages.calls).toHaveLength(0);
    expect(fluxSession.doc.cover.render.status).not.toBe('ready');

    // Pro (Nano Banana Pro) reaches their own Gemini key: plan limits govern the platform key only.
    const pro = getImageModel(TIER_PRESETS.pro.coverModel)!;
    expect(pro.routes.gemini).toBeDefined();
    expect(DEFAULT_CAPS.qualityTiers).not.toContain('pro');
    const doc = plannedDoc();
    doc.settings = { ...doc.settings, confirm: 'never', quality: 'pro' };
    const session = newSession(doc);
    const { billing, reserves } = billingRecordingProvider();
    const images = fakeImages(() => ({ route: 'gemini', byok: true, model: pro.routes.gemini, costUsd: undefined }));
    const ctx = testContext(session, { keys: OWN_GEMINI, images, billing, caps: DEFAULT_CAPS });
    await runAction(ctx, { type: 'render_cover' }, { confirmed: true });
    expect(images.calls).toHaveLength(1);
    expect(reserves).toEqual([{ provider: 'gemini', model: pro.routes.gemini, operation: 'comic.image.cover' }]);
    expect(session.doc.cover.render.status).toBe('ready');
  });
});
