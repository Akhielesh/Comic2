// credit-safety.md: a drawing run stops at once when a key runs out of credit (or moves to the same payer's other key),
// and a paid step that would not fit what is left does not start. Synthetic keys, prices and readings throughout.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { emptyRender, type Card, type ComicDoc } from '../../../shared/comic/doc.js';
import type { CreditCard } from '../../../shared/comic/credit.js';
import { DEFAULT_CAPS, type StudioCaps } from '../../../shared/comic/capabilities.js';
import type { ProviderBalanceReport } from '../../../shared/providerBalances.js';
import { registryPriceBook } from './models/index.js';
import { JOB_TIMINGS, drawWhatFits, estimateSpendAction, runAction } from './jobs.js';
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
    expect(card).toMatchObject({ reason: 'stopped', payer: 'own_key', provider: 'gemini', notStarted: 3 });
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

  it('Draw what fits: the most leading pages that fit, or nothing when one page does not', () => {
    const doc = sheetsReady();
    const one = pageQuote(doc, 1);
    const two = pageQuote(doc, 2);
    expect(drawWhatFits(doc, { type: 'render_pages' }, true, prices, (usd) => usd <= two)).toMatchObject({ pages: 2 });
    expect(drawWhatFits(doc, { type: 'render_pages' }, true, prices, (usd) => usd <= one)).toMatchObject({ pages: 1, usd: one });
    expect(drawWhatFits(doc, { type: 'render_pages' }, true, prices, () => false)).toBeNull();
    expect(drawWhatFits(doc, { type: 'render_pages', pageIds: [doc.pages[0].id] }, true, prices, () => true)).toBeNull();
  });
});
