// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import type { Request } from 'express';
import { logger } from '../lib/logger.js';
import { billingDenialMessage, createBillingHooks, noopBillingHooks } from './billing.js';
import type { BillingHooks } from './types.js';

type ReserveArgs = Parameters<BillingHooks['reserve']>[0];

const makeReq = (over: Record<string, unknown> = {}) => {
  const headers: Record<string, string> = { 'x-gemini-model': 'client-picked-model', 'x-other': 'kept' };
  const req = {
    user: { id: 'user-1' },
    body: { huge: 'x'.repeat(100_000) },
    apiKeys: {
      openRouterKey: 'sk-or-platform',
      openRouterByok: false,
      geminiKey: 'AIza-mine',
      geminiByok: true,
      providerKeys: {
        openrouter: { key: 'sk-or-platform', byok: false },
        gemini: { key: 'AIza-mine', byok: true }
      }
    },
    header(name: string) {
      return headers[name.toLowerCase()];
    },
    ...over
  };
  return req as unknown as Request;
};

const pageArgs: ReserveArgs = {
  operation: 'comic.image.page',
  provider: 'openrouter',
  model: 'google/gemini-nano-banana-2.1',
  stage: 'page',
  imageUnits: 1,
  resolution: '2K'
};

const allowed = (req: Request, model = 'google/gemini-nano-banana-2.1') => {
  (req as Request & { usageReservation?: unknown }).usageReservation = { reservationId: `r-${Math.random()}`, byokBypass: false } as never;
  return {
    allowed: true as const,
    reservation: (req as Request & { usageReservation: never }).usageReservation,
    seed: { provider: 'openrouter' as const, model, operation: 'comic.image.page', imageUnits: 1 },
    provider: 'openrouter' as const,
    model
  };
};

const setup = (over: { reserve?: ReturnType<typeof vi.fn>; settle?: ReturnType<typeof vi.fn>; release?: ReturnType<typeof vi.fn> } = {}, req = makeReq()) => {
  const reserve = over.reserve || vi.fn(async (input: { req: Request }) => allowed(input.req));
  const settle = over.settle || vi.fn(async () => ({ billableUsd: 0.065 }));
  const release = over.release || vi.fn(async () => undefined);
  const hooks = createBillingHooks(req, 'proj-1', { reserve: reserve as never, settle: settle as never, release: release as never, enabled: true, settleRetryDelayMs: 0 });
  return { hooks, reserve, settle, release, req };
};

describe('createBillingHooks', () => {
  it('is a no-op allow when billing is disabled or there is no user', async () => {
    const reserve = vi.fn();
    const off = createBillingHooks(makeReq(), 'p', { reserve: reserve as never, enabled: false });
    const anon = createBillingHooks(makeReq({ user: undefined }), 'p', { reserve: reserve as never, enabled: true });
    for (const hooks of [off, anon, noopBillingHooks]) {
      const res = await hooks.reserve(pageArgs);
      expect(res.ok).toBe(true);
      if (res.ok) {
        await expect(res.reservation.settle({ costUsd: 1 })).resolves.toEqual({});
        await expect(res.reservation.release('x')).resolves.toBeUndefined();
      }
    }
    expect(reserve).not.toHaveBeenCalled();
  });

  it('reserves on a per-call clone with a tiny body, our model and the routed BYOK flag', async () => {
    const { hooks, reserve, req } = setup();
    const res = await hooks.reserve({ ...pageArgs, provider: 'gemini', model: 'gemini-nano-banana-2.1' });
    expect(res.ok).toBe(true);
    const input = reserve.mock.calls[0][0];
    expect(input).toMatchObject({
      operation: 'comic.image.page',
      provider: 'gemini',
      fallbackModel: 'gemini-nano-banana-2.1',
      imageUnits: 1,
      resolution: '2K',
      projectId: 'proj-1',
      comicId: 'proj-1',
      stage: 'page'
    });
    const clone = input.req as Request;
    expect(clone).not.toBe(req);
    expect(Object.getPrototypeOf(clone)).toBe(req);
    expect(clone.body).toEqual({ model: 'gemini-nano-banana-2.1', operation: 'comic.image.page', stage: 'page' });
    expect(clone.header('X-Gemini-Model')).toBeUndefined();
    expect(clone.header('X-Other')).toBe('kept');
    expect(clone.user).toEqual({ id: 'user-1' });
    expect(clone.apiKeys?.providerKeys?.gemini).toEqual({ key: 'AIza-mine', byok: true });
    expect((req as Request & { usageReservation?: unknown }).usageReservation).toBeUndefined();
  });

  it("holds the studio's own price: the registry image price at the rendered resolution, the text list price for its tokens", async () => {
    const { hooks, reserve } = setup();
    await hooks.reserve({ ...pageArgs, resolution: '4K' });
    expect(reserve.mock.calls[0][0].estimateFloorUsd).toBeCloseTo(0.113, 6); // Nano Banana 2.1 at 4K
    await hooks.reserve({ ...pageArgs, resolution: '2K' });
    expect(reserve.mock.calls[1][0].estimateFloorUsd).toBeCloseTo(0.0504, 6);
    await hooks.reserve({ operation: 'comic.text.director', provider: 'openrouter', model: 'google/gemini-3.8-flash', stage: 'chat', inputTokens: 10_000, outputTokens: 2_000 });
    // (10k × $0.825 + 2k × $4.125) / 1M
    expect(reserve.mock.calls[2][0].estimateFloorUsd).toBeCloseTo(0.0165, 6);
    // An unpriced text model adds no floor (the gate's own catalog estimate stands).
    await hooks.reserve({ operation: 'comic.text.director', provider: 'openrouter', model: 'unknown/text-model', stage: 'chat', inputTokens: 100, outputTokens: 100 });
    expect(reserve.mock.calls[3][0]).not.toHaveProperty('estimateFloorUsd');
  });

  it('prices a text hold at the dearest model of its fallback chain and hands the chain to the ledger', async () => {
    const { hooks, reserve } = setup();
    const chain = ['google/gemini-3.8-flash', 'anthropic/claude-sonnet-5.5', 'openai/gpt-6-luna'];
    await hooks.reserve({ operation: 'comic.text.director', provider: 'openrouter', model: chain[0], models: chain, stage: 'chat', inputTokens: 20_000, outputTokens: 2_500 });
    const input = reserve.mock.calls[0][0];
    // Sonnet 5.5 is the dearest member: (20k × $2 + 2.5k × $10) / 1M, not the flash primary's $0.0268.
    expect(input.estimateFloorUsd).toBeCloseTo(0.065, 6);
    expect(input.pricedModels).toEqual(chain);
    expect(input.fallbackModel).toBe(chain[0]);
    // A single-model call carries no chain (the ledger prices the model it is given).
    await hooks.reserve({ operation: 'comic.text.director', provider: 'openrouter', model: chain[0], models: [chain[0]], stage: 'chat', inputTokens: 20_000, outputTokens: 2_500 });
    expect(reserve.mock.calls[1][0]).not.toHaveProperty('pricedModels');
    expect(reserve.mock.calls[1][0].estimateFloorUsd).toBeCloseTo(0.026813, 6);
    // An unpriced fallback never lowers the floor below a priced member.
    await hooks.reserve({ operation: 'comic.text.director', provider: 'openrouter', model: chain[0], models: [chain[0], 'unknown/text-model'], stage: 'chat', inputTokens: 20_000, outputTokens: 2_500 });
    expect(reserve.mock.calls[2][0].estimateFloorUsd).toBeCloseTo(0.026813, 6);
  });

  it('maps a 512 swatch to the ledger 1K price point', async () => {
    const { hooks, reserve } = setup();
    await hooks.reserve({ ...pageArgs, resolution: '512' });
    expect(reserve.mock.calls[0][0].resolution).toBe('1K');
  });

  it('keeps parallel reservations independent', async () => {
    const { hooks, settle } = setup();
    const [a, b] = await Promise.all([hooks.reserve(pageArgs), hooks.reserve(pageArgs)]);
    if (!a.ok || !b.ok) throw new Error('expected ok');
    await a.reservation.settle({ costUsd: 0.05, imageUnits: 1 });
    await b.reservation.settle({ costUsd: 0.06, imageUnits: 1 });
    const reqA = settle.mock.calls[0][0].req as Request & { usageReservation: { reservationId: string } };
    const reqB = settle.mock.calls[1][0].req as Request & { usageReservation: { reservationId: string } };
    expect(reqA.usageReservation.reservationId).not.toBe(reqB.usageReservation.reservationId);
  });

  it('settles with the provider-reported cost in the UsagePayload shape', async () => {
    const { hooks, settle } = setup();
    const res = await hooks.reserve({ operation: 'comic.text.writer', provider: 'openrouter', model: 'anthropic/claude-sonnet-5.5', stage: 'plan', inputTokens: 4000, outputTokens: 6000 });
    if (!res.ok) throw new Error('expected ok');
    const out = await res.reservation.settle({ costUsd: 0.071, promptTokens: 4100, completionTokens: 5900 });
    expect(out).toEqual({ billableUsd: 0.065 });
    const input = settle.mock.calls[0][0];
    expect(input.usage).toEqual({ promptTokens: 4100, candidatesTokens: 5900, totalTokens: 10_000, providerCostUsd: 0.071 });
    expect(input.seed).toBeDefined();
    expect(input.operation).toBe('comic.text.writer');
  });

  it('settles Gemini-direct images (no reported cost) at the registry price for the rendered resolution', async () => {
    const { hooks, settle } = setup();
    const res = await hooks.reserve({ ...pageArgs, provider: 'gemini', model: 'gemini-nano-banana-2.1', resolution: '1K' });
    if (!res.ok) throw new Error('expected ok');
    await res.reservation.settle({ imageUnits: 1 });
    expect(settle.mock.calls[0][0].usage).toEqual({ providerCostUsd: 0.0336 });
    expect(settle.mock.calls[0][0].imageUnits).toBe(1);
  });

  it('settles or releases exactly once', async () => {
    const { hooks, settle, release } = setup();
    const res = await hooks.reserve(pageArgs);
    if (!res.ok) throw new Error('expected ok');
    await res.reservation.release('render failed');
    await res.reservation.settle({ costUsd: 0.05 });
    await res.reservation.release('again');
    expect(release).toHaveBeenCalledTimes(1);
    expect(release.mock.calls[0][0]).toMatchObject({ reason: 'render failed', projectId: 'proj-1' });
    expect(settle).not.toHaveBeenCalled();
  });

  it('returns a friendly denial (and never swallows it)', async () => {
    const reserve = vi.fn(async () => ({ allowed: false, details: { reason: 'platform_allowance_exhausted' } }));
    const { hooks } = setup({ reserve });
    await expect(hooks.reserve(pageArgs)).resolves.toEqual({
      ok: false,
      code: 'BILLING_DENIED',
      message: "You've used this month's included generation allowance. Add your own key in Settings → API keys, or upgrade."
    });
  });

  it('fails open when the ledger itself errors, and swallows settle/release errors', async () => {
    const broken = setup({ reserve: vi.fn(async () => Promise.reject(new Error('ledger offline'))) });
    const res = await broken.hooks.reserve(pageArgs);
    expect(res.ok).toBe(true);

    const flaky = setup({
      settle: vi.fn(async () => Promise.reject(new Error('settle failed'))),
      release: vi.fn(async () => Promise.reject(new Error('release failed')))
    });
    const a = await flaky.hooks.reserve(pageArgs);
    const b = await flaky.hooks.reserve(pageArgs);
    if (!a.ok || !b.ok) throw new Error('expected ok');
    await expect(a.reservation.settle({ costUsd: 0.05 })).resolves.toEqual({});
    await expect(b.reservation.release('x')).resolves.toBeUndefined();
  });

  it('retries a failed settle (the provider call already happened) before giving up, and never releases', async () => {
    const settle = vi
      .fn()
      .mockRejectedValueOnce(new Error('ledger hiccup'))
      .mockRejectedValueOnce(new Error('ledger hiccup'))
      .mockResolvedValueOnce({ billableUsd: 0.065 });
    const { hooks, release } = setup({ settle });
    const res = await hooks.reserve(pageArgs);
    if (!res.ok) throw new Error('expected ok');
    await expect(res.reservation.settle({ costUsd: 0.05, imageUnits: 1 })).resolves.toEqual({ billableUsd: 0.065 });
    expect(settle).toHaveBeenCalledTimes(3);
    expect(release).not.toHaveBeenCalled();
    // Every attempt settles the SAME reservation (idempotent on the row that counts).
    const ids = settle.mock.calls.map((c: [{ req: Request & { usageReservation: { reservationId: string } } }]) => c[0].req.usageReservation.reservationId);
    expect(new Set(ids).size).toBe(1);
  });

  it('logs a stranded hold with its reservation id and amount once the retries are spent', async () => {
    const error = vi.spyOn(logger, 'error').mockImplementation(() => undefined);
    vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    try {
      const settle = vi.fn(async () => Promise.reject(new Error('ledger offline')));
      const { hooks } = setup({ settle });
      const res = await hooks.reserve({ ...pageArgs, resolution: '2K' });
      if (!res.ok) throw new Error('expected ok');
      await expect(res.reservation.settle({ costUsd: 0.05, imageUnits: 1 })).resolves.toEqual({});
      expect(settle).toHaveBeenCalledTimes(3);
      expect(error).toHaveBeenCalledWith(
        'comic_billing_settle_failed',
        expect.objectContaining({ stranded: true, attempts: 3, reservationId: expect.stringMatching(/^r-/), holdUsd: expect.closeTo(0.0504, 6), providerCostUsd: 0.05, projectId: 'proj-1' })
      );
    } finally {
      vi.restoreAllMocks();
    }
  });

  it('forwards allowance threshold notices to the real request', async () => {
    const notice = { tool: 'platform_allowance', level: 'info' as const, message: '30%', at: 'now' };
    const settle = vi.fn(async (input: { req: Request & { allowanceNotices?: unknown[] } }) => {
      input.req.allowanceNotices = [notice];
      return { billableUsd: 0.01 };
    });
    const { hooks, req } = setup({ settle });
    const res = await hooks.reserve(pageArgs);
    if (!res.ok) throw new Error('expected ok');
    await res.reservation.settle({ costUsd: 0.01 });
    expect((req as Request & { allowanceNotices?: unknown[] }).allowanceNotices).toEqual([notice]);
  });
});

describe('billingDenialMessage', () => {
  it('has an actionable sentence for every ledger reason', () => {
    for (const reason of [
      'MONTHLY_INCLUDED_EXHAUSTED',
      'DAILY_LIMIT_EXCEEDED',
      'INSUFFICIENT_CREDITS',
      'PAYMENT_METHOD_REQUIRED',
      'OVERAGE_CAP_REACHED',
      undefined
    ] as const) {
      const msg = billingDenialMessage(reason ? { reason } : undefined);
      expect(msg.length).toBeGreaterThan(20);
      expect(msg).toMatch(/Settings/);
    }
  });
});

describe('usage budget (P1-LIMITS)', () => {
  it('passes the gate’s own percent-only sentence through, with honest fallbacks', () => {
    const gate = "You've used all of your DreamStream usage. It doesn't reset on its own — ask us for a top-up, or add your own API key in Settings → API keys to keep going.";
    expect(billingDenialMessage({ reason: 'usage_budget_exhausted', message: gate })).toBe(gate);
    expect(billingDenialMessage({ reason: 'usage_budget_exhausted' })).toMatch(/top-up.*Settings → API keys/);
    expect(billingDenialMessage({ reason: 'usage_budget_unavailable' })).toMatch(/nothing was spent/);
    for (const reason of ['usage_budget_exhausted', 'usage_budget_unavailable'] as const) {
      expect(billingDenialMessage({ reason })).not.toMatch(/\$|usd|dollar/i);
    }
  });

  it('turns an exhausted budget into a BILLING_DENIED notice (never swallowed)', async () => {
    const message = "You've used all of your DreamStream usage. It doesn't reset on its own — ask us for a top-up, or add your own API key in Settings → API keys to keep going.";
    const reserve = vi.fn(async () => ({ allowed: false, details: { reason: 'usage_budget_exhausted', message } }));
    const { hooks } = setup({ reserve });
    await expect(hooks.reserve(pageArgs)).resolves.toEqual({ ok: false, code: 'BILLING_DENIED', message });
  });

  it('meters Comic Studio with BILLING_ENABLED=false while METERING_ENABLED is on (the production setup)', async () => {
    const saved = { billing: process.env.BILLING_ENABLED, metering: process.env.METERING_ENABLED };
    try {
      vi.resetModules();
      process.env.BILLING_ENABLED = 'false';
      delete process.env.METERING_ENABLED;
      const on = await import('./billing.js');
      const reserve = vi.fn(async (input: { req: Request }) => allowed(input.req));
      const res = await on.createBillingHooks(makeReq(), 'proj-1', { reserve: reserve as never }).reserve(pageArgs);
      expect(res.ok).toBe(true);
      expect(reserve).toHaveBeenCalledTimes(1);

      // METERING_ENABLED=false is the emergency kill switch: nothing is reserved.
      vi.resetModules();
      process.env.METERING_ENABLED = 'false';
      const off = await import('./billing.js');
      const reserveOff = vi.fn();
      await off.createBillingHooks(makeReq(), 'proj-1', { reserve: reserveOff as never }).reserve(pageArgs);
      expect(reserveOff).not.toHaveBeenCalled();
    } finally {
      if (saved.billing === undefined) delete process.env.BILLING_ENABLED;
      else process.env.BILLING_ENABLED = saved.billing;
      if (saved.metering === undefined) delete process.env.METERING_ENABLED;
      else process.env.METERING_ENABLED = saved.metering;
      vi.resetModules();
    }
  });
});
