// credit-safety.md: a drawing run stops at once when a key runs out of credit (or moves to the same payer's other key),
// and a paid step that would not fit what is left does not start. Synthetic keys, prices and readings throughout.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { emptyRender, type Card, type ComicDoc } from '../../../shared/comic/doc.js';
import type { CreditCard } from '../../../shared/comic/credit.js';
import { DEFAULT_CAPS, type StudioCaps } from '../../../shared/comic/capabilities.js';
import type { ProviderBalanceReport } from '../../../shared/providerBalances.js';
import { registryPriceBook } from './models/index.js';
import { JOB_TIMINGS, drawWhatFits, estimateSpendAction, heldUsdFor, pendingUsdOf, planPages, planPagesUsd, runAction, runFeatureAction, startAction } from './jobs.js';
import { costViewFor } from './costText.js';
import { PLATFORM_MARKUP } from '../../../shared/comic/models.js';
import { actionHandlerFor } from './actions/index.js';
import type { ActionHandler } from './extensions.js';
import { classifyImageError } from './imageClient.js';
import { fakeBilling, fakeImages, newSession, plannedDoc, testContext, type TestContext } from './orchestrator.fakes.js';
import { analyzePageRender } from './vision.js';
import { checkRenderSafety, onRenderVerdict } from './safety/index.js';
import { castOpsForUncast, findUncastBeings } from './castScan.js';
import { StudioError, type CreditPort, type ImageRequest, type StudioKeys } from './types.js';

vi.mock('./vision.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./vision.js')>();
  return { ...actual, analyzePageRender: vi.fn(actual.analyzePageRender) };
});
vi.mock('./safety/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./safety/index.js')>();
  return { ...actual, onRenderVerdict: vi.fn(actual.onRenderVerdict), checkRenderSafety: vi.fn(actual.checkRenderSafety) };
});
vi.mock('./actions/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./actions/index.js')>();
  return { ...actual, actionHandlerFor: vi.fn(actual.actionHandlerFor) };
});
vi.mock('./castScan.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./castScan.js')>();
  return { ...actual, findUncastBeings: vi.fn(actual.findUncastBeings), castOpsForUncast: vi.fn(actual.castOpsForUncast) };
});

const OWN_OR: StudioKeys = { openrouter: { key: 'sk-or-synthetic-owner', byok: true } };
const OWN_BOTH: StudioKeys = { openrouter: { key: 'sk-or-synthetic-owner', byok: true }, gemini: { key: 'AIza-synthetic-owner', byok: true } };
const PLATFORM: StudioKeys = { openrouter: { key: 'sk-or-synthetic-platform', byok: false } };
const prices = registryPriceBook();

const TIMINGS = { ...JOB_TIMINGS };
beforeEach(() => {
  JOB_TIMINGS.retryBackoffMs = 0;
  JOB_TIMINGS.saveRetryMs = 0;
  JOB_TIMINGS.rateLimitRequeueMs = 5;
  JOB_TIMINGS.requeueJitterMs = 0;
  JOB_TIMINGS.requeueMinMs = 0;
  for (const level of ['info', 'warn', 'error'] as const) vi.spyOn(console, level).mockImplementation(() => undefined);
  vi.mocked(analyzePageRender).mockRejectedValue(new StudioError('RATE_LIMIT', 'The page checker is busy.', { retryable: true }));
  vi.mocked(onRenderVerdict).mockResolvedValue(undefined);
  vi.mocked(checkRenderSafety).mockResolvedValue(undefined);
  vi.mocked(findUncastBeings).mockReturnValue([]);
  vi.mocked(castOpsForUncast).mockReturnValue([]);
});
afterEach(() => {
  Object.assign(JOB_TIMINGS, TIMINGS);
  vi.restoreAllMocks();
});

/** The planned 3-page comic with every sheet drawn, so a run is exactly its pages. */
const sheetsReady = (): ComicDoc => {
  const doc = plannedDoc();
  doc.cast.forEach((c) => (c.sheet = { ...emptyRender(), status: 'ready', asset: { path: `${c.id}.webp`, source: 'generated', at: 1 } }));
  return doc;
};

/** The error the image client throws for a key out of credit on a route (its real classification). */
const outOfCredit = (route: 'openrouter' | 'gemini', byok = true) =>
  Object.assign(classifyImageError({ status: 402, message: 'Insufficient credits' }, { route, byok }), { imageFailure: { route, status: 402 } });
/** A Google project with no image quota behind the key (429 RESOURCE_EXHAUSTED "limit: 0"), classified as the client does. */
const noQuota = (route: 'openrouter' | 'gemini') =>
  Object.assign(classifyImageError({ status: 429, message: 'RESOURCE_EXHAUSTED: Quota exceeded, limit: 0' }, { route, byok: true }), { imageFailure: { route, status: 429 } });

const creditCards = (doc: ComicDoc): CreditCard[] => doc.conversation.flatMap((m) => m.cards || []).filter((c): c is CreditCard => c.type === 'credit');
const allCards = (doc: ComicDoc): Card[] => doc.conversation.flatMap((m) => m.cards || []);
const lastText = (doc: ComicDoc) => doc.conversation.filter((m) => m.role === 'assistant').map((m) => m.text).join('\n');

const reading = (remaining: number, at = Date.now()): ProviderBalanceReport => ({
  provider: 'openrouter',
  status: 'reported',
  checkedAt: at,
  accountBalances: null,
  keyQuotaUsd: { limit: 20, remaining, usage: 20 - remaining }
});
const port = (report: ProviderBalanceReport | null): CreditPort & { calls: number } => {
  const fake = {
    calls: 0,
    async ownKeyBalance() {
      fake.calls += 1;
      return report;
    }
  };
  return fake;
};
const withCredit = (ctx: TestContext, credit: CreditPort): TestContext => Object.assign(ctx, { credit });
const findPageStatus = (doc: ComicDoc, i: number) => doc.pages[i].render.status;

describe('MN-1: a run stops at once when its key runs out of credit', () => {
  it('sends nothing more after the refusal: the rest are not started (never failed), cost nothing, and one card says what to do', async () => {
    const session = newSession(sheetsReady());
    const images = fakeImages(() => outOfCredit('openrouter'));
    const billing = fakeBilling();
    const ctx = testContext(session, { keys: OWN_OR, images, billing });
    await runAction(ctx, { type: 'render_pages' }, { confirmed: true });
    const doc = session.doc;
    // Pages draw at most two at a time: the refusal stops everything not already on the wire.
    expect(images.calls.length).toBeGreaterThanOrEqual(1);
    expect(images.calls.length).toBeLessThan(doc.pages.length);
    expect(images.calls.every((c) => !c.excludeRoutes)).toBe(true);
    // Not started, not failed: every page is back to how it was, with no error on it.
    expect(doc.pages.map((p) => p.render.status)).toEqual(['none', 'none', 'none']);
    expect(doc.pages.every((p) => !p.render.error)).toBe(true);
    // Nothing settled: every hold was released, and the comic's spend is unchanged.
    expect(billing.settled).toEqual([]);
    expect(billing.released.every((r) => r === 'key_refused')).toBe(true);
    expect(doc.spend.totalUsd).toBe(0);
    const cards = creditCards(doc);
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({ reason: 'stopped', payer: 'own_key', provider: 'openrouter', drawn: 0, notStarted: 3 });
    expect(cards[0].rest?.action).toMatchObject({ type: 'render_pages' });
    // The run settles with a clear reason, and no other paid chip competes with the card.
    expect(lastText(doc)).toMatch(/Stopped before pages 1–3: your OpenRouter key ran out of credit .*Nothing more was charged\./);
    expect(allCards(doc).some((c) => c.type === 'model_outage')).toBe(false);
    const last = doc.conversation[doc.conversation.length - 1];
    expect((last.nextSteps || []).some((s) => !!s.action && 'type' in s.action && s.action.type === 'render_pages')).toBe(false);
  });

  it('keeps what was drawn before the refusal and stops before the rest', async () => {
    const session = newSession(sheetsReady());
    const images = fakeImages((_req, i) => (i === 0 ? undefined : outOfCredit('openrouter')));
    const ctx = testContext(session, { keys: OWN_OR, images });
    await runAction(ctx, { type: 'render_pages' }, { confirmed: true });
    const doc = session.doc;
    expect(doc.pages.filter((p) => p.render.status === 'ready')).toHaveLength(1);
    expect(doc.pages.filter((p) => p.render.status === 'failed')).toHaveLength(0);
    const [card] = creditCards(doc);
    expect(card).toMatchObject({ reason: 'stopped', drawn: 1, notStarted: 2, rest: { action: { type: 'render_pages' } } });
    expect(images.calls.length).toBeLessThanOrEqual(3);
    // A stopped run never suggests the next paid step.
    expect(lastText(doc)).not.toMatch(/cover next/);
  });

  it('a transient rate limit is not a credit refusal: the run carries on and draws every page', async () => {
    const session = newSession(sheetsReady());
    const images = fakeImages((_req, i) => (i === 0 ? new StudioError('RATE_LIMIT', 'The image model is busy right now (rate limited).', { status: 429, retryable: true }) : undefined));
    const ctx = testContext(session, { keys: OWN_OR, images });
    await runAction(ctx, { type: 'render_pages' }, { confirmed: true });
    expect(session.doc.pages.every((p) => p.render.status === 'ready')).toBe(true);
    expect(creditCards(session.doc)).toEqual([]);
  });

  it('continues on the same payer\'s other key (release 308\'s rule) and never calls the refused key again', async () => {
    const session = newSession(sheetsReady());
    const images = fakeImages((req: ImageRequest) =>
      req.excludeRoutes?.includes('openrouter') ? { route: 'gemini', byok: true, model: 'gemini-nano-banana-2.1' } : outOfCredit('openrouter')
    );
    const ctx = testContext(session, { keys: OWN_BOTH, images });
    await runAction(ctx, { type: 'render_pages' }, { confirmed: true });
    const doc = session.doc;
    expect(doc.pages.every((p) => p.render.status === 'ready')).toBe(true);
    // At most the calls already on the wire went to the refused key; every call after the refusal excluded it.
    const unexcluded = images.calls.filter((c) => !c.excludeRoutes?.includes('openrouter'));
    expect(unexcluded.length).toBeLessThanOrEqual(2);
    const firstExcluded = images.calls.findIndex((c) => !!c.excludeRoutes?.includes('openrouter'));
    expect(images.calls.slice(firstExcluded).every((c) => c.excludeRoutes?.includes('openrouter') && c.preferRoute === 'gemini')).toBe(true);
    expect(creditCards(doc)).toEqual([]);
    const said = allCards(doc).filter((c) => c.type === 'notice' && /carried on with your Gemini key/.test(c.text));
    expect(said).toHaveLength(1);
  });

  it('stops when the other key runs out too', async () => {
    const session = newSession(sheetsReady());
    const images = fakeImages((req: ImageRequest) => (req.excludeRoutes?.includes('openrouter') ? outOfCredit('gemini') : outOfCredit('openrouter')));
    const ctx = testContext(session, { keys: OWN_BOTH, images });
    await runAction(ctx, { type: 'render_pages' }, { confirmed: true });
    const doc = session.doc;
    expect(doc.pages.map((p) => p.render.status)).toEqual(['none', 'none', 'none']);
    // Each key was refused at most for the calls already in flight; nothing was sent once both were refused.
    expect(images.calls.length).toBeLessThanOrEqual(4);
    const [card] = creditCards(doc);
    expect(card).toMatchObject({ reason: 'stopped', payer: 'own_key', provider: 'gemini', notStarted: 3, keys: [{ provider: 'openrouter' }, { provider: 'gemini' }] });
    // Nothing was drawn on the other key, so no notice says the run "carried on"; the stop names both keys.
    expect(allCards(doc).some((c) => c.type === 'notice' && /carried on/.test(c.text))).toBe(false);
    expect(lastText(doc)).toMatch(/Stopped before pages 1–3: your OpenRouter and Gemini keys ran out of credit/);
  });

  it('a busy first key whose fallback key was refused for credit: the retry stays on the first key and never calls the refused one', async () => {
    const session = newSession(sheetsReady());
    // OpenRouter answered 429, so the client tried the same model on Gemini, which has no image quota: the error the
    // run sees is the rate limit, carrying the other key's refusal (imageClient fallbackRefusal).
    const busyThenRefused = () =>
      Object.assign(new StudioError('RATE_LIMIT', 'The image model is busy right now (rate limited).', { status: 429, retryable: true }), {
        imageFailure: { route: 'openrouter', status: 429 },
        fallbackRefusal: { route: 'gemini', refusal: 'no_quota' }
      });
    const images = fakeImages((req: ImageRequest, i) => (i === 0 ? busyThenRefused() : req.excludeRoutes?.includes('gemini') ? undefined : busyThenRefused()));
    const ctx = testContext(session, { keys: OWN_BOTH, images });
    await runAction(ctx, { type: 'render_pages' }, { confirmed: true });
    const doc = session.doc;
    expect(doc.pages.every((p) => p.render.status === 'ready')).toBe(true);
    // Every call after the refusal excludes the refused key and stays on the first one.
    const after = images.calls.slice(1);
    expect(after.length).toBeGreaterThanOrEqual(doc.pages.length);
    expect(after.every((c) => c.excludeRoutes?.includes('gemini') && c.preferRoute === 'openrouter')).toBe(true);
    // The run did not move and did not stop: no credit card, no "carried on" notice.
    expect(creditCards(doc)).toEqual([]);
    expect(allCards(doc).some((c) => c.type === 'notice' && /carried on/.test(c.text))).toBe(false);
  });

  it('a busy first key whose fallback was refused, then the first key refused too: the run stops and names both keys', async () => {
    const session = newSession(sheetsReady());
    const busyThenRefused = () =>
      Object.assign(new StudioError('RATE_LIMIT', 'The image model is busy right now (rate limited).', { status: 429, retryable: true }), {
        imageFailure: { route: 'openrouter', status: 429 },
        fallbackRefusal: { route: 'gemini', refusal: 'credit' }
      });
    const images = fakeImages((req: ImageRequest) => (req.excludeRoutes?.includes('gemini') ? outOfCredit('openrouter') : busyThenRefused()));
    const ctx = testContext(session, { keys: OWN_BOTH, images });
    await runAction(ctx, { type: 'render_pages' }, { confirmed: true });
    const doc = session.doc;
    expect(doc.pages.map((p) => p.render.status)).toEqual(['none', 'none', 'none']);
    const [card] = creditCards(doc);
    expect(card).toMatchObject({ reason: 'stopped', payer: 'own_key', provider: 'openrouter', keys: [{ provider: 'gemini' }, { provider: 'openrouter' }] });
    expect(images.calls.every((c, i) => i < 2 || c.excludeRoutes?.includes('gemini'))).toBe(true);
  });

  it('a key with no image quota is named for what it is when the run carries on with the other key', async () => {
    const session = newSession(sheetsReady());
    const images = fakeImages((req: ImageRequest) =>
      req.excludeRoutes?.includes('openrouter') ? { route: 'gemini', byok: true, model: 'gemini-nano-banana-2.1' } : noQuota('openrouter')
    );
    const ctx = testContext(session, { keys: OWN_BOTH, images });
    await runAction(ctx, { type: 'render_pages' }, { confirmed: true });
    expect(session.doc.pages.every((p) => p.render.status === 'ready')).toBe(true);
    const [note] = allCards(session.doc).filter((c) => c.type === 'notice' && /carried on with your Gemini key/.test(c.text)) as Extract<Card, { type: 'notice' }>[];
    expect(note.text).toMatch(/^Your OpenRouter key has no image quota \(its Google project has no billing\), so the rest of this run carried on/);
    expect(note.text).toMatch(/Turn on billing for that project when you can\.$/);
    expect(note.text).not.toMatch(/Top up/);
  });

  it('the platform key at capacity stops a governed run in plain words: no dollar figure on the card or in the text', async () => {
    const session = newSession(sheetsReady());
    const images = fakeImages(() => outOfCredit('openrouter', false));
    const caps: StudioCaps = { ...DEFAULT_CAPS, usage: { governed: true, pctLeft: 80, exhausted: false, pctPerStandardPage: 1 } };
    const ctx = testContext(session, { keys: PLATFORM, images, caps });
    await runAction(ctx, { type: 'render_pages' }, { confirmed: true, caps });
    const doc = session.doc;
    const [card] = creditCards(doc);
    expect(card).toMatchObject({ reason: 'stopped', payer: 'allowance', notStarted: 3 });
    expect(card.provider).toBeUndefined();
    expect(JSON.stringify(card)).not.toMatch(/needUsd|leftUsd/);
    expect(lastText(doc)).not.toContain('$');
    expect(lastText(doc)).toMatch(/drawing service ran out of capacity/);
  });
});

describe('MN-2: the balance check before spending', () => {
  const pageQuote = (doc: ComicDoc, n: number, byok = true) =>
    estimateSpendAction(doc, { type: 'render_pages', pageIds: doc.pages.slice(0, n).map((p) => p.id) }, byok, prices).usd;

  it('does not start a run the own key cannot pay for: no reservation, no call, one "Not enough credit" card with Draw what fits', async () => {
    const doc = sheetsReady();
    const session = newSession(doc);
    const left = pageQuote(doc, 1) + 0.001; // one page fits, two do not
    const billing = fakeBilling();
    const ctx = withCredit(testContext(session, { keys: OWN_OR, billing, prices }), port(reading(left)));
    await runAction(ctx, { type: 'render_pages' }, { confirmed: true });
    expect(ctx.imagesFake.calls).toEqual([]);
    expect(billing.reserves).toEqual([]);
    expect(session.doc.pages.every((p) => p.render.status === 'none')).toBe(true);
    const [card] = creditCards(session.doc);
    expect(card).toMatchObject({ reason: 'short', payer: 'own_key', provider: 'openrouter', leftUsd: Math.round(left * 1e4) / 1e4 });
    expect(card.needUsd!).toBeGreaterThan(left);
    expect(card.fits).toMatchObject({ pages: 1, action: { type: 'render_pages', pageIds: [doc.pages[0].id] } });
    expect(card.fits!.usd).toBeLessThanOrEqual(left);
    expect(lastText(session.doc)).toMatch(/^Not enough credit, so I haven't started pages 1–3: it needs ≈ \$\d+\.\d\d and your OpenRouter key has \$\d+\.\d\d left\. Nothing was charged\./);
  });

  it('starts the run when it fits', async () => {
    const session = newSession(sheetsReady());
    const ctx = withCredit(testContext(session, { keys: OWN_OR, prices }), port(reading(50)));
    await runAction(ctx, { type: 'render_pages' }, { confirmed: true });
    expect(session.doc.pages.every((p) => p.render.status === 'ready')).toBe(true);
    expect(creditCards(session.doc)).toEqual([]);
  });

  it('never blocks on unknown: no reading, a stale one, a key with no reported balance, or a Gemini key', async () => {
    const stale = reading(0, Date.now() - 16 * 60_000);
    const unreported: ProviderBalanceReport = { provider: 'openrouter', status: 'reported', checkedAt: Date.now(), accountBalances: null, keyQuotaUsd: { limit: null, remaining: null, usage: 3 } };
    for (const [keys, report] of [
      [OWN_OR, null],
      [OWN_OR, stale],
      [OWN_OR, unreported],
      [{ gemini: { key: 'AIza-synthetic-owner', byok: true } }, reading(0)]
    ] as const) {
      const session = newSession(sheetsReady());
      const ctx = withCredit(testContext(session, { keys: keys as StudioKeys, prices }), port(report));
      await runAction(ctx, { type: 'render_pages' }, { confirmed: true });
      expect(session.doc.pages.every((p) => p.render.status === 'ready'), JSON.stringify(report)).toBe(true);
      expect(creditCards(session.doc)).toEqual([]);
    }
  });

  it('governed: compares with the allowance left and words it as a percentage, never dollars', async () => {
    const doc = sheetsReady();
    const session = newSession(doc);
    const caps: StudioCaps = { ...DEFAULT_CAPS, usage: { governed: true, pctLeft: 0.5, exhausted: false, pctPerStandardPage: 4 } };
    const billing = fakeBilling();
    const ctx = testContext(session, { keys: PLATFORM, billing, caps, prices });
    await runAction(ctx, { type: 'render_pages' }, { confirmed: true, caps });
    expect(billing.reserves).toEqual([]);
    expect(ctx.imagesFake.calls).toEqual([]);
    const [card] = creditCards(session.doc);
    expect(card).toMatchObject({ reason: 'short', payer: 'allowance', leftPct: 0.5 });
    expect(card.needPct!).toBeGreaterThan(0.5);
    expect(JSON.stringify(card)).not.toMatch(/needUsd|leftUsd/);
    expect(lastText(session.doc)).not.toContain('$');
    expect(lastText(session.doc)).toMatch(/0\.5% of your usage is left/);
  });

  it('governed with room left starts as before', async () => {
    const session = newSession(sheetsReady());
    const caps: StudioCaps = { ...DEFAULT_CAPS, usage: { governed: true, pctLeft: 90, exhausted: false, pctPerStandardPage: 1 } };
    const ctx = testContext(session, { keys: PLATFORM, caps, prices });
    await runAction(ctx, { type: 'render_pages' }, { confirmed: true, caps });
    expect(session.doc.pages.every((p) => p.render.status === 'ready')).toBe(true);
  });

  it('an approved drawing that does not fit leaves its approval open (Approve again after a top-up)', async () => {
    const doc = sheetsReady();
    doc.settings = { ...doc.settings, confirm: 'always' };
    const session = newSession(doc);
    const ctx = withCredit(testContext(session, { keys: OWN_OR, prices }), port(reading(0.001)));
    await runAction(ctx, { type: 'render_pages' }, { confirmed: false });
    const gate = session.doc.gate!;
    expect(gate.status).toBe('open');
    await runAction(ctx, { type: 'approve_gate', gateId: gate.id }, { confirmed: true });
    expect(session.doc.gate).toMatchObject({ id: gate.id, status: 'open' });
    expect(ctx.imagesFake.calls).toEqual([]);
    expect(creditCards(session.doc)).toHaveLength(1);
  });

  it('a reading that refuses the step and is minutes old is read again first: a top-up since then lets it start', async () => {
    const session = newSession(sheetsReady());
    const asked: Array<number | undefined> = [];
    const credit: CreditPort = {
      async ownKeyBalance({ maxAgeMs }) {
        asked.push(maxAgeMs);
        // The saved reading from when the last run stopped; the provider reports the top-up when asked again.
        return maxAgeMs === undefined ? reading(0.02, Date.now() - 2 * 60_000) : reading(10.02);
      }
    };
    const ctx = withCredit(testContext(session, { keys: OWN_OR, prices }), credit);
    await runAction(ctx, { type: 'render_pages' }, { confirmed: true });
    expect(asked).toEqual([undefined, 30_000]);
    expect(session.doc.pages.every((p) => p.render.status === 'ready')).toBe(true);
    expect(creditCards(session.doc)).toEqual([]);
  });

  it('a reading taken moments ago decides at once (no second read)', async () => {
    const session = newSession(sheetsReady());
    const credit = port(reading(0.001));
    const ctx = withCredit(testContext(session, { keys: OWN_OR, prices }), credit);
    await runAction(ctx, { type: 'render_pages' }, { confirmed: true });
    expect(credit.calls).toBe(1);
    expect(creditCards(session.doc)).toHaveLength(1);
  });

  it('sets aside what this comic is drawing right now before it compares', async () => {
    const doc = sheetsReady();
    const session = newSession(doc);
    const one = pageQuote(doc, 1);
    // Enough for page 1 and half of page 2: each fits alone, both together do not.
    const left = one * 1.5;
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => (release = resolve));
    const images = fakeImages(async () => {
      await held;
      return undefined;
    });
    const ctx = withCredit(testContext(session, { keys: OWN_OR, images, prices }), port(reading(left)));
    const first = await startAction(ctx, { type: 'render_pages', pageIds: [doc.pages[0].id] }, { confirmed: true });
    expect(first.outcome.status).toBe('started');
    const second = await startAction(ctx, { type: 'render_pages', pageIds: [doc.pages[1].id] }, { confirmed: true });
    expect(second.outcome.status).toBe('blocked');
    const [card] = creditCards(session.doc);
    expect(card).toMatchObject({ reason: 'short', payer: 'own_key', held: true });
    expect(card.leftUsd!).toBeCloseTo(left - one, 3);
    expect(lastText(session.doc)).toMatch(/left after what’s drawing now\. Nothing was charged\./);
    release();
    await first.done;
    expect(findPageStatus(session.doc, 0)).toBe('ready');
    expect(findPageStatus(session.doc, 1)).toBe('none');
  });

  it('governed: an image already on the wire is counted once (the usage status holds it), so a step that fits still starts', async () => {
    const doc = sheetsReady();
    const session = newSession(doc);
    const usage = { governed: true, pctLeft: 50, exhausted: false, pctPerStandardPage: 4 };
    const before: StudioCaps = { ...DEFAULT_CAPS, usage };
    const pctPerUsd = costViewFor(before).pctPerUsd!;
    const onePct = (pageQuote(doc, 1, false) / PLATFORM_MARKUP) * pctPerUsd;
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => (release = resolve));
    const images = fakeImages(async () => {
      await held;
      return undefined;
    });
    const billing = fakeBilling();
    const ctx = testContext(session, { keys: PLATFORM, images, billing, caps: before, prices });
    const first = await startAction(ctx, { type: 'render_pages', pageIds: [doc.pages[0].id] }, { confirmed: true, caps: before });
    expect(first.outcome.status).toBe('started');
    await vi.waitFor(() => expect(images.calls).toHaveLength(1));
    // Page 1's hold is made, so only the own-key check sets it aside; the allowance's status already counts it.
    expect(pendingUsdOf(session)).toBeGreaterThan(0);
    expect(heldUsdFor(session, { byok: true })).toBe(pendingUsdOf(session));
    expect(heldUsdFor(session, { byok: false })).toBeCloseTo(0, 4);
    // The status the next request reads includes page 1's in-flight hold: one and a half pages are left after it.
    const after: StudioCaps = { ...DEFAULT_CAPS, usage: { ...usage, pctLeft: Math.round(onePct * 1.5 * 10) / 10 } };
    Object.assign(ctx, { caps: after });
    const second = await startAction(ctx, { type: 'render_pages', pageIds: [doc.pages[1].id] }, { confirmed: true, caps: after });
    expect(second.outcome.status).toBe('started');
    expect(creditCards(session.doc)).toEqual([]);
    release();
    await first.done;
    await second.done;
    expect([findPageStatus(session.doc, 0), findPageStatus(session.doc, 1)]).toEqual(['ready', 'ready']);
    // Every hold settled: nothing is left counted as on the wire or held.
    expect(heldUsdFor(session, { byok: false })).toBe(0);
    expect(pendingUsdOf(session)).toBe(0);
  });

  it('governed: a page that has no hold yet is still set aside', async () => {
    const doc = sheetsReady();
    const session = newSession(doc);
    const usage = { governed: true, pctLeft: 50, exhausted: false, pctPerStandardPage: 4 };
    const before: StudioCaps = { ...DEFAULT_CAPS, usage };
    const pctPerUsd = costViewFor(before).pctPerUsd!;
    const onePct = (pageQuote(doc, 1, false) / PLATFORM_MARKUP) * pctPerUsd;
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => (release = resolve));
    const images = fakeImages(async () => {
      await held;
      return undefined;
    });
    // The billing hold itself waits, so page 1 is quoted and held but not yet on the wire.
    const billing = fakeBilling();
    const reserve = billing.reserve.bind(billing);
    let letReserve: () => void = () => undefined;
    const reserving = new Promise<void>((resolve) => (letReserve = resolve));
    billing.reserve = async (args) => {
      await reserving;
      return reserve(args);
    };
    const ctx = testContext(session, { keys: PLATFORM, images, billing, caps: before, prices });
    const first = await startAction(ctx, { type: 'render_pages', pageIds: [doc.pages[0].id] }, { confirmed: true, caps: before });
    expect(first.outcome.status).toBe('started');
    expect(heldUsdFor(session, { byok: false })).toBe(pendingUsdOf(session));
    const after: StudioCaps = { ...DEFAULT_CAPS, usage: { ...usage, pctLeft: Math.round(onePct * 1.5 * 10) / 10 } };
    Object.assign(ctx, { caps: after });
    const second = await startAction(ctx, { type: 'render_pages', pageIds: [doc.pages[1].id] }, { confirmed: true, caps: after });
    expect(second.outcome.status).toBe('blocked');
    expect(creditCards(session.doc)[0]).toMatchObject({ reason: 'short', payer: 'allowance', held: true });
    letReserve();
    release();
    await first.done;
  });

  it('draws on the person\'s other key when the known one is short and the other could pay (never blocked on unknown)', async () => {
    const session = newSession(sheetsReady());
    const images = fakeImages(() => ({ route: 'gemini', byok: true, model: 'gemini-nano-banana-2.1' }));
    const left = pageQuote(session.doc, 1) * 0.5;
    const ctx = withCredit(testContext(session, { keys: OWN_BOTH, images, prices }), port(reading(left)));
    const started = await startAction(ctx, { type: 'render_pages' }, { confirmed: true });
    expect(started.outcome.status).toBe('started');
    expect(started.outcome.message).toMatch(/Your OpenRouter key has \$\d+\.\d\d left, so this run draws on your Gemini key \(the same model\)\./);
    await started.done;
    expect(session.doc.pages.every((p) => p.render.status === 'ready')).toBe(true);
    expect(images.calls.length).toBeGreaterThan(0);
    expect(images.calls.every((c) => c.preferRoute === 'gemini')).toBe(true);
    expect(creditCards(session.doc)).toEqual([]);
  });

  it('an approved translation that does not fit does not start: its approval stays open and one card says why', async () => {
    const run = vi.fn(async () => ({ outcome: { status: 'done' as const, message: 'Translated.' }, done: Promise.resolve() }));
    const handler: ActionHandler = { type: 'translate', spend: true, estimate: async () => ({ usd: 0.3, imageCount: 0, model: 'Translator', lines: [] }), run };
    const real = vi.mocked(actionHandlerFor).getMockImplementation()!;
    vi.mocked(actionHandlerFor).mockImplementation((type: string) => (type === 'translate' ? handler : real(type)));
    try {
      const doc = sheetsReady();
      doc.settings = { ...doc.settings, confirm: 'always' };
      const session = newSession(doc);
      const ctx = withCredit(testContext(session, { keys: OWN_OR, prices }), port(reading(0.01)));
      // Asked for directly with confirm "always": it opens an approval (no balance check at quote time).
      await runFeatureAction(ctx, handler, { type: 'translate', languages: ['hi', 'ta'] }, { confirmed: false });
      const gate = session.doc.gate!;
      expect(gate).toMatchObject({ status: 'open', action: { type: 'translate' } });
      expect(creditCards(session.doc)).toEqual([]);
      await runAction(ctx, { type: 'approve_gate', gateId: gate.id }, { confirmed: true });
      expect(run).not.toHaveBeenCalled();
      expect(session.doc.gate).toMatchObject({ id: gate.id, status: 'open' });
      const cards = creditCards(session.doc);
      expect(cards).toHaveLength(1);
      expect(cards[0]).toMatchObject({ reason: 'short', payer: 'own_key', needUsd: 0.3, leftUsd: 0.01 });
      // With room on the key the same approval runs.
      Object.assign(ctx, { credit: port(reading(5)) });
      await runAction(ctx, { type: 'approve_gate', gateId: gate.id }, { confirmed: true });
      expect(run).toHaveBeenCalledTimes(1);
    } finally {
      vi.mocked(actionHandlerFor).mockImplementation(real);
    }
  });

  it('Plan the pages on an empty own key: the writer never runs, nothing is charged, and one "Not enough credit" card says why', async () => {
    const doc = plannedDoc();
    doc.pages = [];
    doc.planStatus = 'none';
    const session = newSession(doc);
    const billing = fakeBilling();
    const ctx = withCredit(testContext(session, { keys: OWN_OR, billing, prices }), port(reading(0)));
    const started = await startAction(ctx, { type: 'plan_pages' }, { confirmed: true });
    expect(started.outcome).toMatchObject({ status: 'blocked', code: 'BILLING_DENIED' });
    expect(ctx.llmFake.calls).toEqual([]);
    expect(billing.reserves).toEqual([]);
    expect(session.doc.pages).toEqual([]);
    expect(session.doc.planStatus).toBe('none');
    const [card] = creditCards(session.doc);
    // The need is the quote's honest bound: one writer pass, and up to one more if the plan check sends it back.
    expect(card).toMatchObject({ reason: 'short', payer: 'own_key', provider: 'openrouter', what: 'the page plan', leftUsd: 0, needUsd: 2 * planPagesUsd(doc, true, prices) });
    expect(card.fits).toBeUndefined();
    expect(lastText(session.doc)).toMatch(/^Not enough credit, so I haven't started the page plan: it needs ≈ \$\d+\.\d\d and your OpenRouter key has \$0\.00 left\. Nothing was charged\.$/);
  });

  it('rewriting a page is checked the same way (revise_pages and a written new page go through planPages)', async () => {
    const doc = plannedDoc();
    const session = newSession(doc);
    const ctx = withCredit(testContext(session, { keys: OWN_OR, prices }), port(reading(0)));
    const outcome = await planPages(ctx, { instructions: 'Make it a splash page.', pageIds: [doc.pages[1].id] });
    expect(outcome).toMatchObject({ status: 'blocked', code: 'BILLING_DENIED' });
    expect(ctx.llmFake.calls).toEqual([]);
    expect(creditCards(session.doc)[0]).toMatchObject({ reason: 'short', what: 'rewriting page 2' });
  });

  it('governed planning with no usage left: the writer never runs and the card speaks in shares, never dollars', async () => {
    const doc = plannedDoc();
    doc.pages = [];
    doc.planStatus = 'none';
    const session = newSession(doc);
    const caps: StudioCaps = { ...DEFAULT_CAPS, usage: { governed: true, pctLeft: 0, exhausted: true, pctPerStandardPage: 4 } };
    const ctx = testContext(session, { keys: PLATFORM, caps, prices });
    await runAction(ctx, { type: 'plan_pages' }, { confirmed: true, caps });
    expect(ctx.llmFake.calls).toEqual([]);
    const [card] = creditCards(session.doc);
    expect(card).toMatchObject({ reason: 'short', payer: 'allowance', what: 'the page plan' });
    expect(lastText(session.doc)).not.toContain('$');
  });

  it('planning with room on the key, or an unknown balance, runs the writer as before', async () => {
    for (const credit of [port(reading(50)), port(null)]) {
      const doc = plannedDoc();
      doc.pages = [];
      doc.planStatus = 'none';
      const session = newSession(doc);
      const ctx = withCredit(testContext(session, { keys: OWN_OR, prices }), credit);
      await runAction(ctx, { type: 'plan_pages' }, { confirmed: true }).catch(() => undefined);
      expect(ctx.llmFake.calls.length).toBeGreaterThan(0);
      expect(creditCards(session.doc)).toEqual([]);
    }
  });

  it('Draw what fits: the most leading pages that fit, or nothing when one page does not', () => {
    const doc = sheetsReady();
    const one = pageQuote(doc, 1);
    const two = pageQuote(doc, 2);
    expect(drawWhatFits(doc, { type: 'render_pages' }, true, prices, (usd) => usd <= two)).toMatchObject({ pages: 2 });
    expect(drawWhatFits(doc, { type: 'render_pages' }, true, prices, (usd) => usd <= one)).toMatchObject({ pages: 1, usd: one });
    expect(drawWhatFits(doc, { type: 'render_pages' }, true, prices, () => false)).toBeNull();
    expect(drawWhatFits(doc, { type: 'render_pages', pageIds: [doc.pages[0].id] }, true, prices, () => true)).toBeNull();
  });

  it('Draw what fits with the cover: every page that fits is offered without it (a one-page book too)', () => {
    const doc = sheetsReady();
    expect(doc.cover.render.status).not.toBe('ready');
    const all = pageQuote(doc, 3);
    // The pages fit, the cover does not: all three pages, not two.
    expect(drawWhatFits(doc, { type: 'render_pages', includeCover: true }, true, prices, (usd) => usd <= all)).toMatchObject({ pages: 3, usd: all, action: { pageIds: doc.pages.map((p) => p.id) } });
    const first = pageQuote(doc, 1);
    const fits = drawWhatFits(doc, { type: 'render_pages', pageIds: [doc.pages[0].id], includeCover: true }, true, prices, (usd) => usd <= first);
    expect(fits).toMatchObject({ pages: 1, usd: first });
    expect((fits!.action as { includeCover?: boolean }).includeCover).toBeUndefined();
  });

  it('Draw what fits finds the same answer as trying every page count', () => {
    const doc = sheetsReady();
    const quotes = [1, 2, 3].map((n) => pageQuote(doc, n));
    for (const includeCover of [false, true]) {
      for (const limit of [0, quotes[0] - 1e-6, quotes[0], (quotes[0] + quotes[1]) / 2, quotes[1], quotes[2], quotes[2] * 2]) {
        const most = includeCover ? 3 : 2;
        let want: number | null = null;
        for (let n = most; n >= 1 && want === null; n -= 1) if (quotes[n - 1] > 0 && quotes[n - 1] <= limit) want = n;
        const got = drawWhatFits(doc, { type: 'render_pages', ...(includeCover ? { includeCover: true } : {}) }, true, prices, (usd) => usd <= limit);
        expect(got?.pages ?? null, `cover ${includeCover}, limit ${limit}`).toBe(want);
      }
    }
  });
});
