// Image-model lock, real-price quotes, per-call recording and the money-safe preflight in the job runner
// (models.md §3.4 items 1–10, §3.6 G/H, §5.1 M1-LOCK-SERVER; reliability.md §2 wiring). Fakes only: no network,
// no database, no paid call.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { emptyRender, getRender, type Card, type ComicDoc, type ImageModelLock, type Msg } from '../../../shared/comic/doc.js';
import { DEFAULT_CAPS, type StudioCaps } from '../../../shared/comic/capabilities.js';
import type { DocOp } from '../../../shared/comic/ops.js';
import { logger } from '../lib/logger.js';
import { castOpsForUncast, findUncastBeings } from './castScan.js';
import { JOB_TIMINGS, MODEL_LOCKED, lockOf, runAction, sanitizePatchOps, startAction, type RunActionOptions } from './jobs.js';
import { fakeImages, newSession, plannedDoc, testContext, type TestContext } from './orchestrator.fakes.js';
import { checkRenderSafety, onRenderVerdict } from './safety/index.js';
import { StudioError, type StudioKeys } from './types.js';
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

