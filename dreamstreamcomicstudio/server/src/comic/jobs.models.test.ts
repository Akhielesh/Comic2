// Image-model lock, real-price quotes, per-call recording and the money-safe preflight in the job runner
// (models.md §3.4 items 1–10, §3.6 G/H, §5.1 M1-LOCK-SERVER; reliability.md §2 wiring). Fakes only: no network,
// no database, no paid call.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { emptyRender, getRender, type Card, type ComicDoc, type ImageModelLock, type Msg } from '../../../shared/comic/doc.js';
import { DEFAULT_CAPS, type StudioCaps } from '../../../shared/comic/capabilities.js';
import type { DocOp } from '../../../shared/comic/ops.js';
import { logger } from '../lib/logger.js';
import { castOpsForUncast, findUncastBeings } from './castScan.js';
import { JOB_TIMINGS, MODEL_LOCKED, estimateSpendAction, lockOf, runAction, sanitizePatchOps, startAction, type RunActionOptions } from './jobs.js';
import { createImageGenerator, __resetImageClientForTests, type GeminiModelsLike } from './imageClient.js';
import { priceBookFromSources } from './models/pricing.js';
import { fakeImageCalls, fakeImages, newSession, plannedDoc, testContext, type TestContext } from './orchestrator.fakes.js';
import { checkRenderSafety, onRenderVerdict } from './safety/index.js';
import { StudioError, type ImageRequest, type StudioKeys } from './types.js';
import { fakeModelHealth } from './models/health.fakes.js';
import { makeLakeComic } from '../../../shared/comic/__fixtures__/lakeComic.js';
import { analyzePageRender } from './vision.js';

vi.mock('./vision.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./vision.js')>();
  return { ...actual, analyzePageRender: vi.fn(actual.analyzePageRender) };
});
vi.mock('./safety/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./safety/index.js')>();
  return { ...actual, onRenderVerdict: vi.fn(actual.onRenderVerdict), checkRenderSafety: vi.fn(actual.checkRenderSafety) };
});
vi.mock('./castScan.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./castScan.js')>();
  return { ...actual, findUncastBeings: vi.fn(actual.findUncastBeings), castOpsForUncast: vi.fn(actual.castOpsForUncast) };
});

const TIMINGS = { ...JOB_TIMINGS };
beforeEach(() => {
  JOB_TIMINGS.retryBackoffMs = 0;
  JOB_TIMINGS.saveRetryMs = 0;
  JOB_TIMINGS.rateLimitRequeueMs = 1;
  JOB_TIMINGS.requeueJitterMs = 0;
  JOB_TIMINGS.requeueMinMs = 0;
  vi.spyOn(console, 'info').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.mocked(analyzePageRender).mockRejectedValue(new StudioError('RATE_LIMIT', 'The page checker is busy.', { retryable: true }));
  vi.mocked(onRenderVerdict).mockResolvedValue(undefined);
  vi.mocked(checkRenderSafety).mockResolvedValue(undefined);
  vi.mocked(findUncastBeings).mockReturnValue([]);
  vi.mocked(castOpsForUncast).mockReturnValue([]);
});
afterEach(() => {
  Object.assign(JOB_TIMINGS, TIMINGS);
  vi.mocked(analyzePageRender).mockReset();
  vi.mocked(onRenderVerdict).mockReset();
  vi.mocked(checkRenderSafety).mockReset();
  vi.mocked(findUncastBeings).mockReset();
  vi.mocked(castOpsForUncast).mockReset();
  vi.restoreAllMocks();
});

const PAID_CAPS: StudioCaps = { ...DEFAULT_CAPS, plan: 'paid', qualityTiers: ['draft', 'standard', 'pro'], modelOverride: true };
const UI: RunActionOptions = { confirmed: true, caps: PAID_CAPS };
const lockTo = (modelId: string, origin: ImageModelLock['origin'] = 'first_render'): ImageModelLock => ({ modelId, lockedAt: 1_700_000_000_000, origin });

/** plannedDoc with both sheets and the market drawn (generated, on `model`) and the comic locked to `lock`. */
const drawnDoc = (lock?: string, model = lock ?? 'nano-banana-2.1'): ComicDoc => {
  const doc = plannedDoc();
  doc.planStatus = 'approved';
  const sheet = (id: string) => ({ ...emptyRender(), status: 'ready' as const, model, asset: { path: `u/user-1/p/proj-1/img/${id}.webp`, source: 'generated' as const, model, at: 1, w: 1024, h: 1024 } });
  doc.cast = doc.cast.map((c) => ({ ...c, sheet: sheet(c.id) }));
  doc.places = doc.places.map((p) => ({ ...p, sheet: sheet(p.id) }));
  if (lock) doc.imageModel = lockTo(lock);
  return doc;
};

const setup = (doc: ComicDoc, opts: Parameters<typeof testContext>[1] = {}) => {
  const session = newSession(doc);
  const ctx = testContext(session, opts);
  return { session, ctx };
};
const lastMsg = (doc: ComicDoc): Msg => doc.conversation[doc.conversation.length - 1];
const cardsOf = (doc: ComicDoc): Card[] => doc.conversation.flatMap((m) => m.cards || []);
const opsOf = (ctx: TestContext): DocOp[][] => ctx.events.flatMap((e) => (e.type === 'ops' ? [e.ops] : []));

// ── §3.4 items 1–5, 10: the lock ─────────────────────────────────────────────

describe('model lock (models.md §3.4)', () => {
  it('the first sheet commit sets imageModel in the SAME op batch as the image; style swatches never lock', async () => {
    const { session, ctx } = setup(plannedDoc());
    await runAction(ctx, { type: 'render_style_options', directions: [{ name: 'Ink', spec: 'Bold ink lines.' }] }, UI);
    expect(session.doc.imageModel).toBeUndefined();
    expect(lockOf(session.doc)).toBeUndefined();

    await runAction(ctx, { type: 'render_sheets', characterIds: ['c_maya'] }, UI);
    const batches = opsOf(ctx).filter((ops) => ops.some((o) => o.op === 'image_model'));
    expect(batches).toHaveLength(1);
    // Same batch = same rev bump as the sheet's image.
    expect(batches[0].some((o) => o.op === 'render' && o.target.kind === 'sheet' && o.target.id === 'c_maya' && !!o.patch.asset)).toBe(true);
    expect(session.doc.imageModel).toMatchObject({ modelId: 'nano-banana-2.1', providerModel: 'google/gemini-nano-banana-2.1', origin: 'first_render' });

    // Later images never re-lock.
    await runAction(ctx, { type: 'render_sheets', characterIds: ['c_arjun'] }, UI);
    expect(opsOf(ctx).filter((ops) => ops.some((o) => o.op === 'image_model'))).toHaveLength(1);
  });

  it('every job resolves through the lock — swatches, sheets, pages and the cover all draw on the locked model; the tier picks only the resolution', async () => {
    const doc = drawnDoc('nano-banana-pro');
    doc.cast[0].sheet = emptyRender();
    doc.settings.quality = 'standard'; // the standard preset's model is Nano Banana 2.1: the lock must win
    const { ctx } = setup(doc);
    await runAction(ctx, { type: 'render_style_options', directions: [{ name: 'Ink', spec: 'Bold ink lines.' }] }, UI);
    await runAction(ctx, { type: 'render_pages', pageIds: ['pg_1'], includeCover: true }, UI);
    const calls = ctx.imagesFake.calls;
    expect(calls.length).toBeGreaterThanOrEqual(4); // swatch, missing sheet, page, cover
    expect(new Set(calls.map((c) => c.spec.id))).toEqual(new Set(['nano-banana-pro']));
    expect(calls[0].resolution).toBe('1K'); // the swatch at the locked model's nearest 1K
    const page = getRender(ctx.session.doc, { kind: 'page', id: 'pg_1' })!;
    expect(page).toMatchObject({ status: 'ready', model: 'nano-banana-pro', resolution: '2K' }); // the standard tier's page size
    expect(getRender(ctx.session.doc, { kind: 'cover' })).toMatchObject({ model: 'nano-banana-pro', resolution: '2K' });
    expect(ctx.session.doc.style.options[0].render.model).toBe('nano-banana-pro');
  });

  it('a forced spec mismatch is refused with MODEL_LOCKED before any provider call or reservation', async () => {
    const error = vi.spyOn(logger, 'error');
    const doc = drawnDoc('nano-banana-2.1');
    const images = fakeImages((_req, index) => {
      // While page 1 draws, the lock moves under the run (defence in depth: the action itself refuses during a run).
      if (index === 0) session.commit([{ op: 'image_model', lock: lockTo('nano-banana-pro', 'user_change') }], { origin: 'job' });
      return undefined;
    });
    const { session, ctx } = setup(doc, { images });
    await runAction(ctx, { type: 'render_pages', pageIds: ['pg_1', 'pg_2'] }, UI);
    expect(images.calls).toHaveLength(1); // page 2 never reached the provider
    expect(ctx.billingFake.reserves).toHaveLength(1);
    const page2 = getRender(session.doc, { kind: 'page', id: 'pg_2' })!;
    expect(page2.status).toBe('failed');
    expect(page2.error).toMatch(/locked to Nano Banana Pro/);
    expect(error).toHaveBeenCalledWith('comic_model_lock_violation', expect.objectContaining({ model: 'nano-banana-2.1', locked: 'nano-banana-pro' }));
    expect(MODEL_LOCKED).toBe('MODEL_LOCKED');
  });

  it('a lock on a model the registry no longer lists fails honestly (H) — never re-pointed, no call', async () => {
    const { session, ctx } = setup(drawnDoc('ghost-model-9'));
    const started = await startAction(ctx, { type: 'render_pages', pageIds: ['pg_1'] }, UI);
    expect(started.outcome).toMatchObject({ status: 'blocked', code: 'MODEL_LOCKED' });
    expect(started.outcome.message).toBe(
      "ghost-model-9 isn't available for this comic right now (it's no longer offered in Comic Studio). Nothing was drawn. You can wait, or switch models. Switching can affect consistency."
    );
    expect(ctx.imagesFake.calls).toHaveLength(0);
    expect(lastMsg(session.doc).nextSteps).toEqual([{ label: 'See other models', client: { type: 'open_model_picker' } }]);
    expect(session.doc.imageModel?.modelId).toBe('ghost-model-9');
  });

  it('access drift: a free plan locked to Nano Banana Pro gets H and no fallback; the own key draws it', async () => {
    const free = setup(drawnDoc('nano-banana-pro'), { caps: DEFAULT_CAPS });
    const out = await startAction(free.ctx, { type: 'render_pages', pageIds: ['pg_1'] }, { confirmed: true, caps: DEFAULT_CAPS });
    expect(out.outcome.status).toBe('blocked');
    expect(out.outcome.message).toBe(
      "Nano Banana Pro isn't available for this comic right now (needs a paid plan or your own key). Nothing was drawn. You can wait, or switch models. Switching can affect consistency."
    );
    expect(free.ctx.imagesFake.calls).toHaveLength(0);

    const own: StudioKeys = { gemini: { key: 'AIza-mine', byok: true } };
    const byok = setup(drawnDoc('nano-banana-pro'), { caps: DEFAULT_CAPS, keys: own });
    await runAction(byok.ctx, { type: 'render_pages', pageIds: ['pg_1'] }, { confirmed: true, caps: DEFAULT_CAPS });
    expect(byok.ctx.imagesFake.calls.map((c) => c.spec.id)).toEqual(['nano-banana-pro']);
  });

  it('settings: imageModelOverride is accepted before the lock and refused with 409 MODEL_LOCKED after it (quality stays free)', () => {
    const before = sanitizePatchOps(plannedDoc(), [{ op: 'settings', patch: { imageModelOverride: 'nano-banana-pro' } }]);
    expect(before).toEqual([{ op: 'settings', patch: { imageModelOverride: 'nano-banana-pro' } }]);

    const locked = drawnDoc('nano-banana-2.1');
    let err: unknown;
    try {
      sanitizePatchOps(locked, [{ op: 'settings', patch: { imageModelOverride: 'nano-banana-pro' } }]);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(StudioError);
    expect(err).toMatchObject({ code: 'MODEL_LOCKED', status: 409, userMessage: 'This comic is locked to Nano Banana 2.1. Use Change model (consistency can be affected).' });
    // Clearing it is a change too (it could re-point a legacy comic's derived lock).
    const withOverride = drawnDoc('nano-banana-2.1');
    withOverride.settings.imageModelOverride = 'nano-banana-2.1';
    expect(() => sanitizePatchOps(withOverride, [{ op: 'settings', patch: { imageModelOverride: null } }])).toThrow(/locked to Nano Banana 2\.1/);
    // A legacy comic (derived lock, nothing persisted) is locked too.
    const legacy = drawnDoc(undefined, 'nano-banana-2.1');
    expect(() => sanitizePatchOps(legacy, [{ op: 'settings', patch: { imageModelOverride: 'nano-banana-pro' } }])).toThrow(/locked to Nano Banana 2\.1/);
    // An echo of the current value and a tier change pass.
    expect(sanitizePatchOps(withOverride, [{ op: 'settings', patch: { imageModelOverride: 'nano-banana-2.1', quality: 'pro' } }])).toEqual([
      { op: 'settings', patch: { imageModelOverride: 'nano-banana-2.1', quality: 'pro' } }
    ]);
    expect(sanitizePatchOps(locked, [{ op: 'settings', patch: { quality: 'draft' } }])).toEqual([{ op: 'settings', patch: { quality: 'draft' } }]);
  });

  it('a stored version drawn on another model is never put back for free on a locked comic (R2)', async () => {
    const doc = drawnDoc('nano-banana-2.1');
    const { pageSpecHash } = await import('../../../shared/comic/doc.js');
    const page = doc.pages[0];
    page.render = {
      ...emptyRender(),
      status: 'failed',
      history: [{ path: 'u/user-1/p/proj-1/img/old-pro.webp', source: 'generated', model: 'nano-banana-pro', at: 5, w: 1024, h: 1536, specHash: pageSpecHash(doc, page) }]
    };
    const { ctx } = setup(doc);
    await runAction(ctx, { type: 'render_pages', pageIds: ['pg_1'] }, UI);
    expect(ctx.imagesFake.calls.map((c) => c.spec.id)).toEqual(['nano-banana-2.1']);
  });
});


// ── §3.4 item 9: recording ───────────────────────────────────────────────────

describe('per-attempt recording (models.md §3.4 item 9)', () => {
  it('a drawn page writes a SpendEntry with res, route, outcome, listUsd and refs, the running totals, and one comic_image_calls row', async () => {
    const doc = drawnDoc('nano-banana-2.1');
    const images = fakeImages(() => ({ costUsd: 0.0386 }));
    const { session, ctx } = setup(doc, { images });
    await runAction(ctx, { type: 'render_pages', pageIds: ['pg_1'] }, UI);
    const entry = session.doc.spend.entries.find((e) => e.kind === 'page')!;
    expect(entry).toMatchObject({
      label: 'Page 1',
      model: 'nano-banana-2.1',
      res: '2K',
      route: 'openrouter',
      outcome: 'ok',
      usd: Math.round(0.0386 * 1.3 * 10000) / 10000,
      listUsd: Math.round(0.0504 * 1.3 * 10000) / 10000, // the list price, in the same (charged) unit as usd
      target: 'page:pg_1',
      estimated: false
    });
    expect(entry.refs).toBe(ctx.imagesFake.calls[0].references.length);
    expect(session.doc.spend.byModel?.['nano-banana-2.1']).toMatchObject({ images: 1, failed: 0 });
    expect(session.doc.spend.byTarget?.['page:pg_1']).toBe(entry.usd);
    const rows = ctx.callsFake.rows.filter((r) => r.kind === 'page');
    expect(rows).toEqual([
      expect.objectContaining({
        userId: 'user-1',
        projectId: 'proj-1',
        modelId: 'nano-banana-2.1',
        providerModel: 'google/gemini-nano-banana-2.1',
        route: 'openrouter',
        res: '2K',
        outcome: 'ok',
        httpStatus: 200,
        providerCostUsd: 0.0386,
        billedUsd: entry.usd,
        byok: false
      })
    ]);
  });

  it('a failed attempt is recorded with what the provider reported (usually $0) and counts in failed totals', async () => {
    const doc = drawnDoc('nano-banana-2.1');
    const images = fakeImages(() => new StudioError('PROVIDER_ERROR', 'The image model rejected the request.', { status: 502, retryable: false }));
    const { session, ctx } = setup(doc, { images });
    await runAction(ctx, { type: 'render_pages', pageIds: ['pg_1'] }, UI);
    expect(session.doc.spend.entries).toEqual([expect.objectContaining({ label: 'Page 1 (failed attempt)', outcome: 'failed', usd: 0, model: 'nano-banana-2.1', res: '2K' })]);
    expect(session.doc.spend.failed).toEqual({ count: 1, usd: 0 });
    expect(session.doc.spend.byModel?.['nano-banana-2.1']).toMatchObject({ images: 0, failed: 1 });
    expect(ctx.callsFake.rows).toEqual([expect.objectContaining({ outcome: 'failed', errorCode: 'PROVIDER_ERROR', providerCostUsd: null, billedUsd: 0 })]);
  });

  it('recording failures never fail the job', async () => {
    const calls = fakeImageCalls();
    calls.failWith = 'throw';
    const { session, ctx } = setup(drawnDoc('nano-banana-2.1'), { calls });
    await runAction(ctx, { type: 'render_pages', pageIds: ['pg_1'] }, UI);
    expect(session.doc.pages[0].render.status).toBe('ready');
    expect(session.doc.spend.entries.filter((e) => e.kind === 'page' && e.outcome === 'ok')).toHaveLength(1);
  });

  it('vision QC calls are recorded as kind qc rows (model = the vision model, res null)', async () => {
    vi.mocked(analyzePageRender).mockImplementation(async ({ llm }) => {
      await llm.complete({ role: 'vision', messages: [{ role: 'user', content: 'check' }] });
      throw new StudioError('NO_IMAGE', 'unreadable');
    });
    const { ctx } = setup(drawnDoc('nano-banana-2.1'));
    await runAction(ctx, { type: 'render_pages', pageIds: ['pg_1'] }, UI);
    expect(ctx.callsFake.rows.filter((r) => r.kind === 'qc')).toEqual([expect.objectContaining({ kind: 'qc', modelId: 'fake-vision', res: null, outcome: 'failed' })]);
  });
});

// ── §2.3 real prices ─────────────────────────────────────────────────────────

describe('quotes through the PriceBook (models.md §2.3)', () => {
  const observedBook = () =>
    priceBookFromSources({
      rows: [],
      observed: [{ modelId: 'nano-banana-2.1', kind: 'page', res: '2K', n: 4, medianUsd: 0.07, minUsd: 0.06, maxUsd: 0.08, scope: 'you' }]
    });

  it('a gate is quoted at the real price (observed median above the list) and says its basis, with no dollar figure in the phrase', async () => {
    const doc = drawnDoc('nano-banana-2.1');
    doc.settings.confirm = 'always';
    const { session, ctx } = setup(doc, { prices: observedBook() });
    const started = await startAction(ctx, { type: 'render_pages', pageIds: ['pg_1'] }, { confirmed: false, caps: PAID_CAPS });
    expect(started.outcome.status).toBe('gated');
    const gate = session.doc.gate!;
    expect(gate.estimateUsd).toBeCloseTo((0.07 + 0.003) * 1.3, 4);
    expect(gate.estimateUsd).toBeGreaterThan(estimateSpendAction(session.doc, { type: 'render_pages', pageIds: ['pg_1'] }, false).usd);
    expect(gate.summary).toContain('priced from your recent real costs');
    expect(ctx.imagesFake.calls).toHaveLength(0);
  });

  it('a chip carrying its list-price quote is not re-gated just because real costs run above the list', async () => {
    const doc = drawnDoc('nano-banana-2.1');
    const { session, ctx } = setup(doc, { prices: observedBook() });
    const quotedUsd = estimateSpendAction(session.doc, { type: 'render_pages', pageIds: ['pg_1'] }, false).usd;
    const started = await startAction(ctx, { type: 'render_pages', pageIds: ['pg_1'], quotedUsd }, UI);
    expect(started.outcome.status).toBe('started');
    await started.done;
    expect(ctx.imagesFake.calls).toHaveLength(1);
  });
});

// ── reliability.md §2: preflight and outage cards ────────────────────────────

describe('money-safe preflight (reliability.md §2)', () => {
  it('a model down on every reachable route starts NOTHING: no reservation, no job, no failed tile, no spend, one calm outage card', async () => {
    const health = fakeModelHealth();
    health.forceRoute('openrouter', 'google/gemini-nano-banana-2.1', 'down', 'Every provider reports a problem');
    const { session, ctx } = setup(drawnDoc('nano-banana-2.1'), { health });
    const before = session.doc.conversation.length;
    const started = await startAction(ctx, { type: 'render_pages', pageIds: ['pg_1', 'pg_2'] }, UI);
    expect(started.outcome).toMatchObject({ status: 'blocked' });
    expect(started.outcome.message).toMatch(/^Not started: Nano Banana 2\.1 is down/);
    expect(ctx.imagesFake.calls).toHaveLength(0);
    expect(ctx.billingFake.reserves).toHaveLength(0);
    expect(session.doc.spend.entries).toHaveLength(0);
    expect(session.doc.pages.every((p) => p.render.status === 'none')).toBe(true);
    expect(opsOf(ctx).flat().some((o) => o.op === 'render')).toBe(false);
    const added = session.doc.conversation.slice(before);
    expect(added).toHaveLength(1);
    expect(added[0].text).toBe(
      "I haven't started pages 1–2: Nano Banana 2.1 is down right now (every provider reports a problem). Nothing was charged — your comic stays on Nano Banana 2.1 so every page matches."
    );
    expect(added[0].cards).toHaveLength(1);
    expect(added[0].cards![0]).toMatchObject({
      type: 'model_outage',
      modelId: 'nano-banana-2.1',
      origin: 'preflight',
      blockedAction: { type: 'render_pages', pageIds: ['pg_1', 'pg_2'] },
      options: expect.arrayContaining([expect.objectContaining({ kind: 'wait_and_retry' })])
    });
    expect(health.preflights).toHaveLength(1);
    expect(ctx.callsFake.rows).toEqual([expect.objectContaining({ modelId: 'nano-banana-2.1', outcome: 'blocked', errorCode: 'MODEL_DOWN', billedUsd: 0 })]);
  });

  it('picks the same model on the same-payer route when only the primary is down (the run starts, routed there)', async () => {
    const health = fakeModelHealth();
    health.forceRoute('openrouter', 'google/gemini-nano-banana-2.1', 'down');
    const keys: StudioKeys = { openrouter: { key: 'sk-or-platform', byok: false }, gemini: { key: 'AIza-platform', byok: false } };
    const { ctx } = setup(drawnDoc('nano-banana-2.1'), { health, keys });
    await runAction(ctx, { type: 'render_pages', pageIds: ['pg_1'] }, UI);
    expect(ctx.imagesFake.calls).toHaveLength(1);
    expect((ctx.imagesFake.calls[0] as ImageRequest & { preferRoute?: string }).preferRoute).toBe('gemini');
  });

  it('unknown health never blocks a run (no public data, no observations)', async () => {
    const { ctx } = setup(drawnDoc('nano-banana-2.1'));
    const started = await startAction(ctx, { type: 'render_pages', pageIds: ['pg_1'] }, UI);
    expect(started.outcome.status).toBe('started');
    await started.done;
    expect(ctx.healthFake.preflights).toHaveLength(1);
    expect(ctx.imagesFake.calls).toHaveLength(1);
  });

  it('a mid-run provider failure ends with the outage card (mid_run, $0 charged, narrowed re-send) and the calm G copy, never raw error text', async () => {
    const limited = () =>
      Object.assign(new StudioError('RATE_LIMIT', 'Nano Banana 2.1 is being throttled by its provider (Google AI Studio) for everyone on OpenRouter right now — your key and limits are fine.', { status: 429, retryable: true }), {
        imageFailure: { route: 'openrouter', status: 429, providerName: 'Google AI Studio', retryAfterMs: 1_000 }
      });
    const images = fakeImages((req) => (req.prompt.includes('Action 2.1') ? limited() : undefined));
    const { session, ctx } = setup(drawnDoc('nano-banana-2.1'), { images });
    await runAction(ctx, { type: 'render_pages', pageIds: ['pg_1', 'pg_2'] }, UI);
    const last = lastMsg(session.doc);
    expect(last.text).toContain(
      "Google AI Studio is rate-limiting Nano Banana 2.1 right now (OpenRouter · 429 · upstream Google AI Studio). Page 2 wasn't drawn, and you weren't charged for it. Your comic stays on Nano Banana 2.1 so every page matches."
    );
    expect(last.text).not.toMatch(/failed —|throttled by its provider/);
    const outage = (last.cards || []).filter((c) => c.type === 'model_outage');
    expect(outage).toEqual([
      expect.objectContaining({ modelId: 'nano-banana-2.1', origin: 'mid_run', chargedUsd: 0, blockedAction: expect.objectContaining({ type: 'render_pages', pageIds: ['pg_2'] }), options: [{ kind: 'wait_and_retry' }] })
    ]);
    expect((last.cards || []).some((c) => c.type === 'notice' && c.tone === 'error')).toBe(false);
    expect(last.nextSteps?.slice(0, 2)).toEqual([
      expect.objectContaining({ label: 'Try again in 1s', action: expect.objectContaining({ type: 'render_pages', pageIds: ['pg_2'], quotedUsd: expect.any(Number) }) }),
      { label: 'See other models', client: { type: 'open_model_picker' } }
    ]);
    // The tile keeps the precise reason for its Details row.
    expect(session.doc.pages[1].render).toMatchObject({ status: 'failed', error: expect.stringContaining('throttled'), errorDetail: { code: '429', provider: 'OpenRouter' } });
    expect(session.doc.pages[0].render.status).toBe('ready');
  });
});

// ── The 429 replay (models.md §5.1) and the 16:52 incident (reliability.md §5) ──

describe('replays with the real image client over fake transports', () => {
  const ORG_429 = { error: { code: 429, message: 'Provider returned error', metadata: { provider_name: 'Google AI Studio', raw: 'RESOURCE_EXHAUSTED' } } };
  const transports = (opts: { gemini?: boolean } = {}) => {
    const bodies: Array<Record<string, unknown>> = [];
    const fetchMock = vi.fn(async (_url: unknown, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify(ORG_429), { status: 429, headers: { 'content-type': 'application/json' } });
    });
    const geminiCalls: Array<Record<string, unknown>> = [];
    const gemini: GeminiModelsLike = {
      generateContent: vi.fn(async (params: Record<string, unknown>) => {
        geminiCalls.push(params);
        throw Object.assign(new Error('RESOURCE_EXHAUSTED: rate limited'), { status: 429 });
      })
    };
    return { bodies, geminiCalls, fetchMock, gemini, withGemini: !!opts.gemini };
  };
  const realImages = (keys: StudioKeys, t: ReturnType<typeof transports>) =>
    createImageGenerator(keys, { fetch: t.fetchMock as unknown as typeof fetch, createGemini: () => t.gemini, sleep: async () => undefined, imageEndpoints: async () => null });

  beforeEach(() => __resetImageClientForTests());

  it('429 on both routes: every call carries the locked model, the notice says it stays on it, a $0 failed SpendEntry and a RATE_LIMIT call row', async () => {
    const keys: StudioKeys = { openrouter: { key: 'sk-or-platform', byok: false }, gemini: { key: 'AIza-platform', byok: false } };
    const t = transports({ gemini: true });
    const doc = drawnDoc('nano-banana-2.1');
    const session = newSession(doc);
    const ctx = testContext(session, { keys });
    ctx.images = realImages(keys, t);
    await runAction(ctx, { type: 'render_pages', pageIds: ['pg_1'] }, UI);
    expect(t.bodies.length + t.geminiCalls.length).toBeGreaterThan(0);
    expect(t.bodies.every((b) => b.model === 'google/gemini-nano-banana-2.1' && !('models' in b))).toBe(true);
    expect(t.geminiCalls.every((c) => c.model === 'gemini-nano-banana-2.1')).toBe(true);
    expect(t.geminiCalls.length).toBeGreaterThan(0); // the same model was tried on the other same-payer route
    const last = lastMsg(session.doc);
    expect(last.text).toContain('stays on Nano Banana 2.1');
    const failedEntries = session.doc.spend.entries.filter((e) => e.outcome === 'failed');
    expect(failedEntries.length).toBeGreaterThan(0);
    expect(failedEntries.every((e) => e.usd === 0 && e.model === 'nano-banana-2.1')).toBe(true);
    expect(ctx.callsFake.rows.some((r) => r.outcome === 'failed' && r.errorCode === 'RATE_LIMIT' && r.modelId === 'nano-banana-2.1')).toBe(true);
    expect(session.doc.spend.totalUsd).toBe(0);
    expect(session.doc.imageModel?.modelId).toBe('nano-banana-2.1');
  });

  it('16:52 incident: 3 style tests on a down single-provider model — the breaker caps the calls, nothing is spent, one calm card, and the next request starts nothing', async () => {
    const keys: StudioKeys = { openrouter: { key: 'sk-or-platform', byok: false } };
    const t = transports();
    const health = fakeModelHealth();
    const session = newSession(drawnDoc(undefined));
    const ctx = testContext(session, { keys, health, caps: PAID_CAPS });
    ctx.images = realImages(keys, t);
    const styles = { type: 'render_style_options' as const, directions: [{ name: 'Ink', spec: 'Bold ink.' }, { name: 'Wash', spec: 'Soft wash.' }, { name: 'Pop', spec: 'Pop art.' }] };
    await runAction(ctx, styles, UI);
    // Three parallel jobs, three 429s: the breaker opened and refused every later attempt (the incident burned 12).
    expect(t.bodies).toHaveLength(3);
    expect(health.acquires.filter((a) => !a.allowed).length).toBeGreaterThan(0);
    expect(health.outcomes.filter((o) => !o.ok)).toHaveLength(3);
    expect(session.doc.spend.totalUsd).toBe(0);
    expect(ctx.billingFake.settled).toHaveLength(0);
    const first = lastMsg(session.doc);
    const outageCards = (first.cards || []).filter((c) => c.type === 'model_outage');
    expect(outageCards).toHaveLength(1);
    expect(outageCards[0]).toMatchObject({ origin: 'mid_run', chargedUsd: 0 });
    const kinds = (outageCards[0] as Extract<Card, { type: 'model_outage' }>).options.map((o) => o.kind);
    expect(kinds).toEqual(expect.arrayContaining(['wait_and_retry', 'add_key', 'switch_model']));
    expect((first.cards || []).some((c) => c.type === 'notice' && c.tone === 'error')).toBe(false);

    // The director asks again a moment later: the preflight sees the open breaker and nothing starts.
    const cards: Card[] = [];
    const out = await startAction(ctx, styles, { confirmed: true, caps: PAID_CAPS, collectCard: (c) => cards.push(c), origin: 'director' });
    expect(t.bodies).toHaveLength(3); // zero image calls after the breaker opened
    expect(out.outcome.status).toBe('blocked');
    expect(out.outcome.message).toMatch(/^Not started: /);
    expect(out.outcome.message).not.toMatch(/Started drawing/);
    expect(cards).toEqual([expect.objectContaining({ type: 'model_outage', origin: 'preflight', modelId: 'nano-banana-2.1' })]);
    expect(session.doc.spend.totalUsd).toBe(0);
    expect(session.doc.conversation.some((m) => /Started drawing/.test(m.text))).toBe(false);
  });
});

// ── §3.9 edge cases and the §5.1 acceptance ──────────────────────────────────

describe('locked model edge cases (models.md §3.9)', () => {
  it('the provider no longer serving the locked model ends with H — no other model is tried', async () => {
    const gone = () =>
      Object.assign(new StudioError('PROVIDER_ERROR', "That image model isn't available on OpenRouter right now. Please try again later.", { status: 502, retryable: false }), {
        imageFailure: { route: 'openrouter', status: 404 }
      });
    const images = fakeImages(() => gone());
    const { session, ctx } = setup(drawnDoc('nano-banana-2.1'), { images });
    await runAction(ctx, { type: 'render_pages', pageIds: ['pg_1'] }, UI);
    const last = lastMsg(session.doc);
    expect(cardsOf(session.doc).some((c) => c.type === 'notice' && c.text.startsWith("Nano Banana 2.1 isn't available for this comic right now (the provider no longer serves it). Nothing was drawn."))).toBe(true);
    expect(last.nextSteps).toEqual(expect.arrayContaining([{ label: 'See other models', client: { type: 'open_model_picker' } }]));
    expect(new Set(images.calls.map((c) => c.spec.id))).toEqual(new Set(['nano-banana-2.1']));
  });

  it("an older comic whose assets name the provider's id is locked to that registry entry (no false violation)", async () => {
    const { session, ctx } = setup(drawnDoc(undefined, 'google/gemini-nano-banana-2.1'));
    await runAction(ctx, { type: 'render_pages', pageIds: ['pg_1'] }, UI);
    expect(session.doc.pages[0].render.status).toBe('ready');
    expect(session.doc.imageModel).toMatchObject({ modelId: 'nano-banana-2.1', origin: 'migrated' });
    expect(ctx.imagesFake.calls.map((c) => c.spec.id)).toEqual(['nano-banana-2.1']);
  });

  it('a legacy comic on a deprecated model keeps drawing on it, with one notice that offers the picker', async () => {
    const { session, ctx } = setup(drawnDoc(undefined, 'nano-banana-2'));
    await runAction(ctx, { type: 'render_pages', pageIds: ['pg_1'] }, UI);
    await runAction(ctx, { type: 'render_pages', pageIds: ['pg_2'] }, UI);
    expect(ctx.imagesFake.calls.map((c) => c.spec.id)).toEqual(['nano-banana-2', 'nano-banana-2']);
    expect(session.doc.imageModel).toMatchObject({ modelId: 'nano-banana-2', origin: 'migrated' });
    const notices = cardsOf(session.doc).filter((c) => c.type === 'notice' && /maker has retired/.test(c.text));
    expect(notices).toHaveLength(1);
  });
});

describe('acceptance (models.md §5.1 M1-LOCK-SERVER): the f8312c86 replay with a tier change mid-book', () => {
  it('every render stays on nano-banana-2.1 and the model never changes without the action', async () => {
    const own: StudioKeys = { openrouter: { key: 'sk-or-mine', byok: true } };
    const session = newSession(makeLakeComic());
    const ctx = testContext(session, { keys: own, caps: DEFAULT_CAPS });
    const opts: RunActionOptions = { confirmed: true, caps: DEFAULT_CAPS, origin: 'user' };
    expect(session.doc.imageModel).toBeUndefined(); // legacy: derived, not yet persisted

    await runAction(ctx, { type: 'render_pages', pageIds: ['pg_2'], force: true }, opts);
    expect(session.doc.imageModel).toMatchObject({ modelId: 'nano-banana-2.1', origin: 'migrated' });

    // The tier changes mid-book: Pro's preset model is Nano Banana Pro, but on a locked comic the tier is resolution only.
    const tierOps = sanitizePatchOps(session.doc, [{ op: 'settings', patch: { quality: 'pro' } }]);
    session.commit(tierOps, { origin: 'user' });
    await runAction(ctx, { type: 'render_pages', pageIds: ['pg_3', 'pg_4', 'pg_5'], force: true, includeCover: true }, opts);
    await runAction(ctx, { type: 'edit_page', pageId: 'pg_1', instruction: 'Make the sky a little brighter.' }, opts);
    await runAction(ctx, { type: 'render_sheets', characterIds: ['c_frog'], force: true }, opts);
    await runAction(ctx, { type: 'render_style_options', directions: [{ name: 'Sunset', spec: 'Warm sunset wash.' }] }, opts);
    // A model change by settings is refused; nothing else can change it.
    expect(() => sanitizePatchOps(session.doc, [{ op: 'settings', patch: { imageModelOverride: 'nano-banana-pro' } }])).toThrow(/locked to Nano Banana 2\.1/);

    const doc = session.doc;
    expect(new Set(ctx.imagesFake.calls.map((c) => c.spec.id))).toEqual(new Set(['nano-banana-2.1']));
    const renders = [...doc.pages.map((p) => p.render), ...doc.cast.map((c) => c.sheet), doc.cover.render, ...doc.style.options.map((o) => o.render)];
    expect(renders.every((r) => r.model === 'nano-banana-2.1')).toBe(true);
    expect(doc.pages.slice(2).every((p) => p.render.resolution === '2K')).toBe(true); // the tier picked the size only
    expect(doc.imageModel).toMatchObject({ modelId: 'nano-banana-2.1', origin: 'migrated' });
    expect(doc.imageModel?.changes ?? []).toEqual([]);
    const lockOps = ctx.events.flatMap((e) => (e.type === 'ops' ? e.ops : [])).filter((o) => o.op === 'image_model');
    expect(lockOps).toHaveLength(1);
  });
});
