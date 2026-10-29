// @vitest-environment node
// Probe: a user who added their OWN Gemini key (the path every "usage used up" message points at)
// while the platform OpenRouter key is present. imageClient.pickImageRoute draws on the user's
// Gemini key (prefersGeminiDirect), but jobs.ts imageRouteFor — the route the billing reserve is
// made for — still picks the platform OpenRouter key. Expected: a call on the user's own key never
// counts against their DreamStream usage (billing.ts header, keys.ts prefersGeminiDirect comment).
// Observed: the reservation is made for provider 'openrouter' with byok:false (governed, counted),
// the quote is priced with the platform markup, and the spend entry says byok:true.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Request } from 'express';
import { createBillingHooks } from '../../server/src/comic/billing.js';
import { pickImageRoute } from '../../server/src/comic/imageClient.js';
import { estimateSpendAction, imageRouteFor, runAction, spendIsByok } from '../../server/src/comic/jobs.js';
import { fakeImages, newSession, plannedDoc, testContext, type FakeBilling } from '../../server/src/comic/orchestrator.fakes.js';
import { hasByokForProvider } from '../../server/src/services/usageEnforcer.js';
import { getImageModel } from '../../shared/comic/models.js';
import type { StudioKeys } from '../../server/src/comic/types.js';

beforeEach(() => {
  vi.spyOn(console, 'info').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

/** Production shape: platform OpenRouter key from env (byok:false) + the user's own Gemini key. */
const KEYS: StudioKeys = {
  openrouter: { key: 'sk-or-platform', byok: false },
  gemini: { key: 'AIza-users-own', byok: true }
};

const makeReq = () =>
  ({
    user: { id: 'tester-1', email: 'tester@example.com' },
    body: {},
    header: () => undefined,
    apiKeys: {
      openRouterKey: 'sk-or-platform',
      openRouterByok: false,
      geminiKey: 'AIza-users-own',
      geminiByok: true,
      providerKeys: {
        openrouter: { key: 'sk-or-platform', byok: false },
        gemini: { key: 'AIza-users-own', byok: true }
      }
    }
  }) as unknown as Request;

describe('own Gemini key + platform OpenRouter key: who draws vs who is billed', () => {
  it('the image client and the billing route disagree on the route (and therefore on BYOK)', () => {
    const spec = getImageModel('nano-banana-2.1')!;
    const drawn = pickImageRoute(spec, KEYS);
    const billed = imageRouteFor(spec, KEYS);
    process.stderr.write(`probe1a ${JSON.stringify({ drawn: { route: drawn.route, byok: drawn.key.byok }, billed, quoteByok: spendIsByok(KEYS) })}\n`);
    expect(billed?.route).toBe(drawn.route);
    expect(billed?.byok).toBe(drawn.key.byok);
  });

  it('a cover drawn on the user\'s Gemini key is reserved against their usage as a platform call', async () => {
    const doc = plannedDoc();
    doc.settings = { ...doc.settings, confirm: 'never' };
    const session = newSession(doc);
    const reserves: { provider: string; byok: boolean; model: string }[] = [];
    const settles: unknown[] = [];
    const reserve = vi.fn(async (input: { req: Request; provider: string; fallbackModel: string }) => {
      reserves.push({ provider: input.provider, byok: hasByokForProvider(input.req, input.provider as never), model: input.fallbackModel });
      (input.req as Request & { usageReservation?: unknown }).usageReservation = { reservationId: 'r1', byokBypass: false, governed: true } as never;
      return {
        allowed: true as const,
        reservation: (input.req as Request & { usageReservation: never }).usageReservation,
        seed: { provider: input.provider, model: input.fallbackModel, operation: 'comic.image.cover', imageUnits: 1 },
        provider: input.provider,
        model: input.fallbackModel
      };
    });
    const settle = vi.fn(async (input: unknown) => {
      settles.push(input);
      return { billableUsd: 0.065 };
    });
    const hooks = createBillingHooks(makeReq(), doc.id, { reserve: reserve as never, settle: settle as never, release: vi.fn(async () => undefined) as never, enabled: true });
    // The real image client would answer from Gemini direct on the user's key (no provider cost reported).
    const images = fakeImages(() => ({ route: 'gemini', byok: true, model: 'gemini-nano-banana-2.1', costUsd: undefined }));
    const ctx = testContext(session, { billing: hooks as unknown as FakeBilling, keys: KEYS, images });
    const quote = estimateSpendAction(session.doc, { type: 'render_cover' }, spendIsByok(KEYS));
    await runAction(ctx, { type: 'render_cover' }, { confirmed: true, origin: 'user' });
    await ctx.settled();
    const spend = session.doc.spend.entries.map((e) => ({ label: e.label, usd: e.usd, byok: e.byok, estimated: e.estimated }));
    process.stderr.write(`probe1b ${JSON.stringify({ reserves, settles, quoteUsd: quote.usd, quoteModel: quote.model, spend, imageCalls: images.calls.length })}\n`);
    expect(images.calls).toHaveLength(1);
    // Expected: the call ran on the user's own key, so the ledger sees BYOK (never counted against usage).
    expect(reserves[0]?.byok).toBe(true);
  });

  it('usage used up + "Continue with my key": the cover is still refused although their Gemini key would draw it', async () => {
    const doc = plannedDoc();
    doc.settings = { ...doc.settings, confirm: 'never' };
    const session = newSession(doc);
    // The real enforcer: a BYOK call is never budget-checked; a platform-key call of an exhausted user is refused.
    const reserve = vi.fn(async (input: { req: Request; provider: string; fallbackModel: string }) => {
      if (hasByokForProvider(input.req, input.provider as never)) {
        (input.req as Request & { usageReservation?: unknown }).usageReservation = { reservationId: 'byok', byokBypass: true } as never;
        return { allowed: true as const, reservation: (input.req as Request & { usageReservation: never }).usageReservation, seed: {}, provider: input.provider, model: input.fallbackModel };
      }
      return { allowed: false as const, details: { reason: 'usage_budget_exhausted', message: "You've used all of your DreamStream usage.", pctLeft: 0, canFallbackToByok: true, byokFallbackMode: 'auto' } };
    });
    const hooks = createBillingHooks(makeReq(), doc.id, { reserve: reserve as never, settle: vi.fn(async () => ({})) as never, release: vi.fn(async () => undefined) as never, enabled: true });
    const images = fakeImages(() => ({ route: 'gemini', byok: true, model: 'gemini-nano-banana-2.1', costUsd: undefined }));
    const ctx = testContext(session, { billing: hooks as unknown as FakeBilling, keys: KEYS, images });
    await runAction(ctx, { type: 'render_cover' }, { confirmed: true, origin: 'user' });
    await ctx.settled();
    const last = session.doc.conversation.at(-1);
    process.stderr.write(`probe1c ${JSON.stringify({ imageCalls: images.calls.length, cover: session.doc.cover?.status, error: session.doc.cover?.error, lastText: last?.text, cards: last?.cards })}\n`);
    // Expected: drawn on the user's own key (no usage involved).
    expect(images.calls).toHaveLength(1);
  });
});
