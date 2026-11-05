// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import type { Request } from 'express';
import { logger } from '../lib/logger.js';
import {
  billingDenialMessage,
  createBillingHooks,
  createImageCallRecorder,
  imageCallRow,
  noopBillingHooks,
  recordImageCall,
  setImageCallRecorder,
  type ImageCallRecord
} from './billing.js';
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

const allowed = (req: Request, model = 'google/gemini-nano-banana-2.1', held: Record<string, unknown> = {}) => {
  (req as Request & { usageReservation?: unknown }).usageReservation = { reservationId: `r-${Math.random()}`, byokBypass: false, ...held } as never;
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

  /** A usage-budget hold (the wallet was not touched at reserve): settle is keyed by reservation id, so it may be retried. */
  const budgetHold = (extra: Record<string, unknown> = {}) => vi.fn(async (input: { req: Request }) => allowed(input.req, undefined, { walletSkipped: true, ...extra }));

  it('retries a failed settle (the provider call already happened) before giving up, and never releases', async () => {
    const settle = vi
      .fn()
      .mockRejectedValueOnce(new Error('ledger hiccup'))
      .mockRejectedValueOnce(new Error('ledger hiccup'))
      .mockResolvedValueOnce({ billableUsd: 0.065 });
    const { hooks, release } = setup({ settle, reserve: budgetHold() });
    const res = await hooks.reserve(pageArgs);
    if (!res.ok) throw new Error('expected ok');
    await expect(res.reservation.settle({ costUsd: 0.05, imageUnits: 1 })).resolves.toEqual({ billableUsd: 0.065 });
    expect(settle).toHaveBeenCalledTimes(3);
    expect(release).not.toHaveBeenCalled();
    // Every attempt settles the SAME reservation (idempotent on the row that counts).
    const ids = settle.mock.calls.map((c: [{ req: Request & { usageReservation: { reservationId: string } } }]) => c[0].req.usageReservation.reservationId);
    expect(new Set(ids).size).toBe(1);
  });

  it('logs a stranded hold with its reservation id and the amount actually held once the retries are spent', async () => {
    const error = vi.spyOn(logger, 'error').mockImplementation(() => undefined);
    vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    try {
      const settle = vi.fn(async () => Promise.reject(new Error('ledger offline')));
      // The ledger held more than the studio's floor (0.0504): the log names the real hold.
      const { hooks } = setup({ settle, reserve: budgetHold({ estimated: { estimatedProviderCostUsd: 0.0612 } }) });
      const res = await hooks.reserve({ ...pageArgs, resolution: '2K' });
      if (!res.ok) throw new Error('expected ok');
      await expect(res.reservation.settle({ costUsd: 0.05, imageUnits: 1 })).resolves.toEqual({});
      expect(settle).toHaveBeenCalledTimes(3);
      expect(error).toHaveBeenCalledWith(
        'comic_billing_settle_failed',
        expect.objectContaining({ stranded: true, attempts: 3, reservationId: expect.stringMatching(/^r-/), holdUsd: 0.0612, providerCostUsd: 0.05, projectId: 'proj-1' })
      );
    } finally {
      vi.restoreAllMocks();
    }
  });

  it('never retries a wallet settle (billing_settle_tokens takes no reservation id: a retry would charge twice)', async () => {
    const error = vi.spyOn(logger, 'error').mockImplementation(() => undefined);
    vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    try {
      const settle = vi.fn(async () => Promise.reject(new Error('ledger rollup failed after the wallet moved')));
      const { hooks, release } = setup({ settle, reserve: vi.fn(async (input: { req: Request }) => allowed(input.req, undefined, { walletSkipped: false, byokBypass: false })) });
      const res = await hooks.reserve({ ...pageArgs, resolution: '2K' });
      if (!res.ok) throw new Error('expected ok');
      await expect(res.reservation.settle({ costUsd: 0.05, imageUnits: 1 })).resolves.toEqual({});
      expect(settle).toHaveBeenCalledTimes(1);
      expect(release).not.toHaveBeenCalled();
      expect(error).toHaveBeenCalledWith(
        'comic_billing_settle_failed',
        // No ledger estimate on this hold: the studio's floor stands in for the amount.
        expect.objectContaining({ stranded: true, attempts: 1, reservationId: expect.stringMatching(/^r-/), holdUsd: expect.closeTo(0.0504, 6) })
      );
    } finally {
      vi.restoreAllMocks();
    }
  });

  it('retries a BYOK-bypass settle too (keyed by reservation id)', async () => {
    const settle = vi.fn().mockRejectedValueOnce(new Error('ledger hiccup')).mockResolvedValueOnce({ billableUsd: 0 });
    const { hooks } = setup({ settle, reserve: vi.fn(async (input: { req: Request }) => allowed(input.req, undefined, { byokBypass: true })) });
    const res = await hooks.reserve(pageArgs);
    if (!res.ok) throw new Error('expected ok');
    await expect(res.reservation.settle({ costUsd: 0.05, imageUnits: 1 })).resolves.toEqual({ billableUsd: 0 });
    expect(settle).toHaveBeenCalledTimes(2);
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

  it('the fallback copy names a key already on file (UB-6) — never "add your own key" to a user who has one, never a dollar', () => {
    const exhausted = (o: Record<string, unknown>) => billingDenialMessage({ reason: 'usage_budget_exhausted', ...o });
    expect(exhausted({ canFallbackToByok: true, byokFallbackMode: 'ask', pctLeft: 0 })).toContain("continue on your own key (it's on file) in Settings → API keys");
    expect(exhausted({ canFallbackToByok: true, byokFallbackMode: 'never', pctLeft: 0 })).toContain("it's on file, but set to never be used");
    // 'auto' says the key takes over only when the usage is really used up; unknown ⇒ the conservative sentence.
    expect(exhausted({ canFallbackToByok: true, byokFallbackMode: 'auto', pctLeft: 0 })).toContain("it's on file and takes over from here");
    expect(exhausted({ canFallbackToByok: true, byokFallbackMode: 'auto' })).not.toContain('takes over from here');
    expect(exhausted({ canFallbackToByok: true, byokFallbackMode: 'auto' })).toContain("it's on file");
    // No mode on the details: the consent path ('ask').
    expect(exhausted({ canFallbackToByok: true, pctLeft: 0 })).toContain("continue on your own key (it's on file)");
    // No key on file: unchanged.
    expect(exhausted({ canFallbackToByok: false, pctLeft: 0 })).toBe(
      "You've used all of your DreamStream usage. It doesn't reset on its own — ask us for a top-up, or add your own API key in Settings → API keys to keep going."
    );
    // An unreadable status: the account keys stay on the platform key, so in every mode the user switches.
    for (const mode of ['ask', 'auto', 'never'] as const) {
      const msg = billingDenialMessage({ reason: 'usage_budget_unavailable', canFallbackToByok: true, byokFallbackMode: mode });
      expect(msg).toContain('nothing was spent');
      expect(msg).toContain("switch to your own key (it's on file) in Settings → API keys");
      expect(msg).not.toContain('takes over');
    }
    expect(billingDenialMessage({ reason: 'usage_budget_unavailable' })).toContain('add your own key in Settings → API keys');
    for (const o of [{ canFallbackToByok: true, byokFallbackMode: 'auto', pctLeft: 0 }, { canFallbackToByok: true }]) {
      expect(exhausted(o)).not.toMatch(/\$|usd|dollar/i);
      expect(exhausted(o)).not.toMatch(/add your own/i);
    }
    // The gate's own sentence still wins.
    expect(exhausted({ canFallbackToByok: true, message: 'Gate says so.' })).toBe('Gate says so.');
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

describe('comic_image_calls recording (models.md §3.4 item 9)', () => {
  const USER = '0b2f5a3e-1c4d-4e8f-9a0b-1c2d3e4f5a6b';
  const PROJECT = '7d1e2f3a-4b5c-4d6e-8f70-81a2b3c4d5e6';
  const page429: ImageCallRecord = {
    userId: USER,
    projectId: PROJECT,
    modelId: 'nano-banana-2.1',
    providerModel: 'google/gemini-nano-banana-2.1',
    route: 'openrouter',
    providerName: 'Google AI Studio',
    kind: 'page',
    res: '1K',
    aspect: '4:5',
    refs: 3,
    outcome: 'failed',
    httpStatus: 429,
    errorCode: 'RATE_LIMIT',
    providerCostUsd: null,
    billedUsd: 0,
    byok: false,
    latencyMs: 812
  };
  const fakeDb = (answers: Array<{ error: { message: string } | null }> = []) => {
    const inserts: Record<string, unknown>[] = [];
    const db = () => ({
      from: (table: string) => ({
        insert: async (row: Record<string, unknown>) => {
          inserts.push({ table, ...row });
          return answers.shift() ?? { error: null };
        }
      })
    });
    return { db, inserts };
  };
  const flush = () => new Promise((r) => setTimeout(r, 0));

  it('writes the column meanings M1-CATALOG reads (registry id, provider id, route, res, outcome, RATE_LIMIT, cost before markup)', async () => {
    const { db, inserts } = fakeDb();
    const bump = vi.fn();
    createImageCallRecorder({ db, bumpUsage: bump, enabled: true }).record(page429);
    await flush();
    expect(inserts).toEqual([
      {
        table: 'comic_image_calls',
        user_id: USER,
        project_id: PROJECT,
        model_id: 'nano-banana-2.1',
        provider_model: 'google/gemini-nano-banana-2.1',
        route: 'openrouter',
        provider_name: 'Google AI Studio',
        kind: 'page',
        res: '1K',
        aspect: '4:5',
        refs: 3,
        outcome: 'failed',
        http_status: 429,
        error_code: 'RATE_LIMIT',
        provider_cost_usd: null,
        billed_usd: 0,
        byok: false,
        latency_ms: 812
      }
    ]);
    // A failed attempt is not an image: model_usage_monthly only counts what was drawn.
    expect(bump).not.toHaveBeenCalled();
  });

  it('bumps model_usage_monthly (product comic_studio) for a drawn image, never for QC rows', async () => {
    const { db } = fakeDb();
    const bump = vi.fn();
    const rec = createImageCallRecorder({ db, bumpUsage: bump, enabled: true });
    rec.record({ ...page429, outcome: 'ok', httpStatus: 200, errorCode: undefined, providerCostUsd: 0.0386, billedUsd: 0.0502 });
    rec.record({ userId: USER, modelId: 'google/gemini-3.5-flash', kind: 'qc', res: null, outcome: 'ok', providerCostUsd: 0.0049, billedUsd: 0.0064 });
    await flush();
    expect(bump).toHaveBeenCalledTimes(1);
    expect(bump).toHaveBeenCalledWith('comic_studio', 'openrouter', 'google/gemini-nano-banana-2.1');
  });

  it('keeps writing before the model_version column exists (one retry without it)', async () => {
    const { db, inserts } = fakeDb([{ error: { message: 'column "model_version" of relation "comic_image_calls" does not exist' } }, { error: null }]);
    createImageCallRecorder({ db, bumpUsage: () => undefined, enabled: true }).record({ ...page429, modelVersion: 'google/gemini-nano-banana-2.1-20261006' });
    await flush();
    expect(inserts).toHaveLength(2);
    expect(inserts[0].model_version).toBe('google/gemini-nano-banana-2.1-20261006');
    expect('model_version' in inserts[1]).toBe(false);
  });

  it('never throws: a failed write, a throwing client, a bad user id and a broken recorder are all swallowed', async () => {
    vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const { db, inserts } = fakeDb([{ error: { message: 'permission denied' } }]);
    const rec = createImageCallRecorder({ db, bumpUsage: () => undefined, enabled: true });
    expect(() => rec.record(page429)).not.toThrow();
    const throwing = createImageCallRecorder({
      db: () => {
        throw new Error('service role missing');
      },
      bumpUsage: () => undefined,
      enabled: true
    });
    expect(() => throwing.record(page429)).not.toThrow();
    expect(() => rec.record({ ...page429, userId: 'not-a-uuid' })).not.toThrow();
    await flush();
    expect(inserts).toHaveLength(1); // the bad user id never reached the table (FK to auth.users)
    const prev = setImageCallRecorder({
      record() {
        throw new Error('boom');
      }
    });
    try {
      expect(() => recordImageCall(page429)).not.toThrow();
    } finally {
      setImageCallRecorder(prev);
    }
  });

  it('records nothing when storage is not configured, and bounds every value', () => {
    const { db, inserts } = fakeDb();
    createImageCallRecorder({ db, enabled: false }).record(page429);
    expect(inserts).toHaveLength(0);
    const row = imageCallRow({ ...page429, projectId: 'proj-1', route: 'bogus' as never, res: '8K' as never, refs: 99, latencyMs: -5, providerCostUsd: Number.NaN });
    expect(row).toMatchObject({ project_id: null, route: null, res: null, refs: 32, latency_ms: 0, provider_cost_usd: null });
  });
});
