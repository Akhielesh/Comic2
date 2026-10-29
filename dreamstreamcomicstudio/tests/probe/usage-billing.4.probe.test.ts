// @vitest-environment node
// Probe: Comic Studio text calls (director / writer / translator) run on an OpenRouter `models`
// fallback chain of up to 3 models, and OpenRouter may serve any of them. usageEnforcer prices a
// governed hold at the most expensive member of `pricedModels` ("a `:free` primary with a paid
// fallback can never slip past an exhausted budget"), and routes/chat.ts + routes/text.ts pass their
// chains. billing.ts's reserve passes only the primary (`fallbackModel: args.model`, no
// pricedModels), so a governed hold is priced at the primary alone while the call may be served
// by the pricier fallback. Expected: the hold covers the chain; observed: pricedModels is absent and
// the floor is the primary's price only.
import { describe, expect, it, vi } from 'vitest';
import type { Request } from 'express';
import { createBillingHooks } from '../../server/src/comic/billing.js';
import { estimateTextCostUsd, resolveTextRoute } from '../../server/src/comic/textModels.js';
import type { StudioKeys } from '../../server/src/comic/types.js';

const KEYS: StudioKeys = { openrouter: { key: 'sk-or-platform', byok: false } };

const makeReq = () =>
  ({
    user: { id: 'tester-1' },
    body: {},
    header: () => undefined,
    apiKeys: { openRouterKey: 'sk-or-platform', openRouterByok: false, providerKeys: { openrouter: { key: 'sk-or-platform', byok: false } } }
  }) as unknown as Request;

describe('comic text hold vs the fallback chain', () => {
  it('reserves with every model the call may be served by', async () => {
    // The director chain: a cheap primary (gemini-3.8-flash) with a ~2.4x pricier fallback (Sonnet 5.5).
    const route = resolveTextRoute('director', KEYS, {} as NodeJS.ProcessEnv)!;
    const inputTokens = 20_000;
    const outputTokens = 2_500;
    const prices = route.models.map((m) => ({ model: m, usd: estimateTextCostUsd(m, inputTokens, outputTokens) }));
    const captured: Record<string, unknown>[] = [];
    const reserve = vi.fn(async (input: Record<string, unknown>) => {
      captured.push(input);
      ((input.req as Request) as Request & { usageReservation?: unknown }).usageReservation = { reservationId: 'r', byokBypass: false } as never;
      return { allowed: true, reservation: {}, seed: {}, provider: 'openrouter', model: input.fallbackModel };
    });
    const hooks = createBillingHooks(makeReq(), 'proj-1', { reserve: reserve as never, settle: vi.fn() as never, release: vi.fn() as never, enabled: true });
    await hooks.reserve({ operation: 'comic.text.writer', provider: route.route, model: route.model, stage: 'plan', inputTokens, outputTokens });
    const input = captured[0];
    process.stderr.write(`probe4 ${JSON.stringify({ chain: route.models, prices, pricedModels: input.pricedModels, estimateFloorUsd: input.estimateFloorUsd, fallbackModel: input.fallbackModel })}\n`);
    const dearest = Math.max(...prices.map((p) => p.usd || 0));
    expect(input.pricedModels).toEqual(route.models);
    expect(Number(input.estimateFloorUsd)).toBeGreaterThanOrEqual(dearest);
  });
});
