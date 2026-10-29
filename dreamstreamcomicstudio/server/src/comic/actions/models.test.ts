// change_image_model (models.md §3.4 item 7, §3.6 F; §5.1 M1-LOCK-SERVER tests). Fakes only.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ComicDoc, ImageModelLock } from '../../../../shared/comic/doc.js';
import { DEFAULT_CAPS, type StudioCaps } from '../../../../shared/comic/capabilities.js';
import { getImageModel } from '../../../../shared/comic/models.js';
import { redrawQuote } from '../../../../shared/comic/modelLock.js';
import { makeLakeComic } from '../../../../shared/comic/__fixtures__/lakeComic.js';
import { JOB_TIMINGS, startAction, type RunActionOptions } from '../jobs.js';
import { registryPriceBook } from '../models/index.js';
import { newSession, plannedDoc, testContext } from '../orchestrator.fakes.js';
import { checkRenderSafety, onRenderVerdict } from '../safety/index.js';
import { StudioError, type StudioKeys } from '../types.js';
import { analyzePageRender } from '../vision.js';
import { ACTION_HANDLERS, actionHandlerFor } from './index.js';
import { changeImageModelAction, MODELS_ACTIONS } from './models.js';

vi.mock('../vision.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../vision.js')>();
  return { ...actual, analyzePageRender: vi.fn(actual.analyzePageRender) };
});
vi.mock('../safety/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../safety/index.js')>();
  return { ...actual, onRenderVerdict: vi.fn(actual.onRenderVerdict), checkRenderSafety: vi.fn(actual.checkRenderSafety) };
});

const TIMINGS = { ...JOB_TIMINGS };
beforeEach(() => {
  JOB_TIMINGS.retryBackoffMs = 0;
  JOB_TIMINGS.saveRetryMs = 0;
  vi.spyOn(console, 'info').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.mocked(analyzePageRender).mockRejectedValue(new StudioError('RATE_LIMIT', 'busy', { retryable: true }));
  vi.mocked(onRenderVerdict).mockResolvedValue(undefined);
  vi.mocked(checkRenderSafety).mockResolvedValue(undefined);
});
afterEach(() => {
  Object.assign(JOB_TIMINGS, TIMINGS);
  vi.restoreAllMocks();
});

const PAID: StudioCaps = { ...DEFAULT_CAPS, plan: 'paid', qualityTiers: ['draft', 'standard', 'pro'], modelOverride: true };
const UI: RunActionOptions = { confirmed: true, caps: PAID, origin: 'user' };
const OR: StudioKeys = { openrouter: { key: 'sk-or-platform', byok: false } };

/** The owner's lake comic (f8312c86 shape): 5 drawn pages, 4 sheets and a cover on Nano Banana 2.1, 4:5, a derived lock. */
const lake = (mutate?: (doc: ComicDoc) => void): ComicDoc => makeLakeComic(mutate);
const setup = (doc: ComicDoc, opts: Parameters<typeof testContext>[1] = {}) => {
  const session = newSession(doc);
  const ctx = testContext(session, { keys: OR, caps: PAID, ...opts });
  return { session, ctx };
};
const change = (modelId: string, redraw: 'none' | 'pages_cover' | 'all', quotedUsd: number) => ({ type: 'change_image_model' as const, modelId, redraw, quotedUsd, ack: true as const });
const quoteFor = (doc: ComicDoc, modelId: string, scope: 'none' | 'pages_cover' | 'all') => redrawQuote(doc, modelId, scope, registryPriceBook(), false).usd ?? 0;
const failure = async (p: Promise<unknown>) => (await p.then(() => null, (e: unknown) => e)) as StudioError | null;

describe('change_image_model (models.md §3.4 item 7)', () => {
  it('is registered as a non-spend feature action', () => {
    expect(MODELS_ACTIONS.map((h) => h.type)).toEqual(['change_image_model']);
    expect(ACTION_HANDLERS.change_image_model).toBe(changeImageModelAction);
    expect(actionHandlerFor('change_image_model')?.spend).toBe(false);
  });

  it('without the ack: 400, nothing changes', async () => {
    const { session, ctx } = setup(lake());
    const before = JSON.stringify(session.doc);
    const err = await failure(startAction(ctx, { ...change('nano-banana-pro', 'none', 0), ack: false } as never, UI));
    expect(err).toMatchObject({ code: 'BAD_REQUEST', status: 400 });
    expect(JSON.stringify(session.doc)).toBe(before);
  });

  it('a confirmed quote that drifted more than 15% + $0.01 is re-quoted and nothing changes', async () => {
    const { session, ctx } = setup(lake());
    const real = quoteFor(session.doc, 'nano-banana-pro', 'pages_cover');
    const started = await startAction(ctx, change('nano-banana-pro', 'pages_cover', 0.2), UI);
    expect(started.outcome).toMatchObject({ status: 'blocked', code: 'CONFLICT', requote: { usd: real, quotedUsd: 0.2 } });
    expect(session.doc.imageModel).toBeUndefined(); // the lake comic's lock is still the derived (unpersisted) one
    expect(ctx.imagesFake.calls).toHaveLength(0);
    expect(session.doc.conversation.at(-1)!.text).toMatch(/^The redraw price changed: .*Nothing was switched/);
    // Within the tolerance it goes through.
    const ok = await startAction(ctx, change('nano-banana-pro', 'none', 0), UI);
    expect(ok.outcome.status).toBe('done');
  });

  it('during a render run: 409 RUN_ACTIVE', async () => {
    const doc = lake((d) => (d.pages[1].render = { ...d.pages[1].render, status: 'rendering' }));
    const { session, ctx } = setup(doc);
    const err = await failure(startAction(ctx, change('nano-banana-pro', 'none', 0), UI));
    expect(err).toMatchObject({ code: 'RUN_ACTIVE', status: 409, userMessage: 'Wait for the current drawing to finish, or stop it first.' });
    expect(session.doc.imageModel).toBeUndefined();
  });

  it('4:5 + GPT Image 2.5: 422 aspect (once the model is offered at all)', async () => {
    const gpt = getImageModel('gpt-image-2.5')!;
    const was = gpt.pickable;
    gpt.pickable = true; // as after the owner's D2 smoke test
    try {
      const { session, ctx } = setup(lake());
      const err = await failure(startAction(ctx, change('gpt-image-2.5', 'none', 0), UI));
      expect(err).toMatchObject({ status: 422, reason: 'aspect' });
      expect(err!.userMessage).toContain("Can't draw 4:5 pages");
      expect(session.doc.imageModel).toBeUndefined();
    } finally {
      gpt.pickable = was;
    }
    // Still hidden today: refused before anything else is judged.
    const { ctx } = setup(lake());
    expect(await failure(startAction(ctx, change('gpt-image-2.5', 'none', 0), UI))).toMatchObject({ status: 422 });
  });

  it('free plan + Nano Banana Pro: 403 with the honest copy (the comic stays put)', async () => {
    const { session, ctx } = setup(lake(), { caps: DEFAULT_CAPS });
    const err = await failure(startAction(ctx, change('nano-banana-pro', 'none', 0), { ...UI, caps: DEFAULT_CAPS }));
    expect(err).toMatchObject({ code: 'FORBIDDEN', status: 403 });
    expect(err!.userMessage).toMatch(/^Nano Banana Pro (needs a paid plan or your own key\.|isn't part of your included usage yet — add your own Gemini or OpenRouter key in Settings → API keys to use it\.) Your comic stays on Nano Banana 2\.1\.$/);
    expect(session.doc.imageModel).toBeUndefined();
  });

  it('never resolves a hidden id through a `replacement`, and refuses unknown ids', async () => {
    const { ctx } = setup(lake());
    expect(await failure(startAction(ctx, change('nano-banana-legacy', 'none', 0), UI))).toMatchObject({ status: 422 });
    expect(await failure(startAction(ctx, change('google/gemini-3-pro-image', 'none', 0), UI))).toMatchObject({ status: 400 });
  });

  it('success with redraw none: the lock changes, changes[0] records it, the §3.6 F notice, $0 spent', async () => {
    const { session, ctx } = setup(lake());
    const spentBefore = session.doc.spend.totalUsd;
    const started = await startAction(ctx, change('nano-banana-pro', 'none', 0), UI);
    expect(started.outcome.status).toBe('done');
    const lock = session.doc.imageModel as ImageModelLock;
    expect(lock).toMatchObject({ modelId: 'nano-banana-pro', providerModel: 'google/gemini-3-pro-image', origin: 'user_change' });
    expect(lock.changes?.[0]).toMatchObject({ from: 'nano-banana-2.1', to: 'nano-banana-pro', redraw: 'none', quotedUsd: 0 });
    const notice = session.doc.conversation.at(-1)!;
    expect(notice.text).toBe('Switched to Nano Banana Pro. 5 pages and the cover were drawn with Nano Banana 2.1 and stay as they are.');
    expect(notice.nextSteps?.map((s) => s.label)).toEqual([expect.stringMatching(/^Redraw them · /), 'Switch back to Nano Banana 2.1']);
    expect(notice.nextSteps?.[1]).toMatchObject({ client: { type: 'open_model_picker', suggest: 'nano-banana-2.1' } });
    expect(session.doc.spend.totalUsd).toBe(spentBefore);
    expect(ctx.imagesFake.calls).toHaveLength(0);
    expect(ctx.billingFake.reserves).toHaveLength(0);
    // "Switch back" is allowed even to a model that is hidden later (changes[0].from).
    const back = await startAction(ctx, change('nano-banana-2.1', 'none', 0), UI);
    expect(back.outcome.status).toBe('done');
    expect(session.doc.imageModel).toMatchObject({ modelId: 'nano-banana-2.1', changes: [expect.objectContaining({ from: 'nano-banana-pro' }), expect.objectContaining({ from: 'nano-banana-2.1' })] });
  });

  it('pages_cover: exactly one render action carrying the confirmed quotedUsd, drawn on the new model', async () => {
    const { session, ctx } = setup(lake());
    const quotedUsd = quoteFor(session.doc, 'nano-banana-pro', 'pages_cover');
    const started = await startAction(ctx, change('nano-banana-pro', 'pages_cover', quotedUsd), UI);
    expect(started.outcome.status).toBe('started');
    await started.done;
    const runs = ctx.events.filter((e) => e.type === 'activity' && e.phase === 'start' && e.cost === 'image' && /^Drawing pages/.test(e.label));
    expect(runs).toHaveLength(1);
    expect(ctx.imagesFake.calls).toHaveLength(6); // 5 pages + the cover, sheets stay
    expect(new Set(ctx.imagesFake.calls.map((c) => c.spec.id))).toEqual(new Set(['nano-banana-pro']));
    expect(session.doc.conversation.some((m) => m.text.startsWith('Switched to Nano Banana Pro. Redrawing 5 pages and the cover ('))).toBe(true);
    expect(session.doc.imageModel?.changes?.[0]).toMatchObject({ redraw: 'pages_cover', quotedUsd });
  });

  it('before the first image there is no lock to change: the choice is the pre-lock preference', async () => {
    const { session, ctx } = setup(plannedDoc());
    const started = await startAction(ctx, change('nano-banana-pro', 'none', 0), UI);
    expect(started.outcome.status).toBe('done');
    expect(session.doc.imageModel).toBeUndefined();
    expect(session.doc.settings.imageModelOverride).toBe('nano-banana-pro');
  });

  it('the redraw goes through the normal budget gate (the switch itself is free)', async () => {
    const doc = lake((d) => (d.settings.budgetUsd = d.spend.totalUsd + 0.05));
    const { session, ctx } = setup(doc);
    const quotedUsd = quoteFor(session.doc, 'nano-banana-pro', 'pages_cover');
    const started = await startAction(ctx, change('nano-banana-pro', 'pages_cover', quotedUsd), UI);
    expect(started.outcome.status).toBe('gated');
    expect(session.doc.gate).toMatchObject({ reason: 'budget', status: 'open' });
    expect(session.doc.imageModel?.modelId).toBe('nano-banana-pro');
    expect(ctx.imagesFake.calls).toHaveLength(0);
  });
});

