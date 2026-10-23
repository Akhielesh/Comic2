// @vitest-environment node
// P2-PLATFORM: the legacy image routes (/api/image/*).
//  (a) governed testers: no free-plan Nano Banana daily cap and no plan-tier model gate while
//      Stripe billing is off — the usage budget is the one meter (same rule as Comic Studio);
//  (b) a provider call that succeeded is SETTLED even when storing the image fails afterwards
//      (releasing would erase real spend); a provider call that failed releases its hold.
// No provider, storage or database is ever called: every seam is mocked.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'net';
import type { Server } from 'http';

vi.mock('../config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../config.js')>()),
  BILLING_ENABLED: false
}));

vi.mock('../middleware/limits.js', () => ({
  checkLimits: () => (_req: unknown, _res: unknown, next: () => void) => next()
}));
vi.mock('../middleware/keys.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../middleware/keys.js')>()),
  requireGeminiKey: () => 'gemini-key',
  requirePixazoKey: () => 'pixazo-key',
  requireOpenRouterKey: () => 'or-key',
  requireNvidiaKey: () => 'nv-key',
  requireIdeogramKey: () => 'ideo-key'
}));

const providers = vi.hoisted(() => ({
  gemini: vi.fn(async (..._args: unknown[]) => ({ dataUrl: 'data:image/png;base64,AAAA', model: 'gemini-nano-banana-2.1', timings: { apiMs: 5 } })),
  flux: vi.fn(async (..._args: unknown[]) => ({ dataUrl: 'data:image/png;base64,BBBB', model: 'flux', timings: { apiMs: 5 } })),
  openrouter: vi.fn(async (..._args: unknown[]) => ({
    imageDataUrl: 'data:image/png;base64,CCCC',
    model: 'google/gemini-nano-banana-2.1',
    usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2, costUsd: 0.04 }
  }))
}));
vi.mock('../ai/image.js', () => ({ generateGeminiImage: providers.gemini }));
vi.mock('../ai/flux.js', () => ({ generateFluxImage: providers.flux }));
vi.mock('../ai/gateway.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../ai/gateway.js')>()),
  getProvider: () => ({ generateImage: providers.openrouter }),
  resolveProviderContext: () => ({})
}));
vi.mock('../ai/stageModels.js', () => ({
  resolveStageModel: vi.fn(async (_stage: string, requested: string) => ({ model: requested }))
}));

const storage = vi.hoisted(() => ({
  persistGeneratedImage: vi.fn(async (..._args: unknown[]) => ({
    imageId: 'img-1',
    imageUrl: 'https://cdn.example/img-1.png',
    mimeType: 'image/png',
    saveMs: 3,
    originalBytes: 10,
    storedBytes: 8,
    compressionRatio: 0.8
  }))
}));
vi.mock('../services/imageStorage.js', () => storage);

type Reservation = { reservationId: string; byokBypass: boolean; governed?: boolean; walletSkipped?: boolean; estimated: Record<string, unknown>; usage: Record<string, unknown> };
const meter = vi.hoisted(() => ({
  reservation: null as null | Reservation,
  byok: false,
  reserveForOperation: vi.fn(),
  settleReservedOperation: vi.fn(async (..._args: unknown[]) => ({ actualCt: 1, billableUsd: 0.05, providerCostUsd: 0.04, reservationReleased: false })),
  releaseReservedOperation: vi.fn(async (..._args: unknown[]) => undefined)
}));
vi.mock('../services/usageEnforcer.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/usageEnforcer.js')>();
  return {
    ...actual,
    hasByokForProvider: () => meter.byok,
    reserveForOperation: meter.reserveForOperation,
    settleReservedOperation: meter.settleReservedOperation,
    releaseReservedOperation: meter.releaseReservedOperation
  };
});

const policy = vi.hoisted(() => ({
  plan: 'free',
  tryConsumeFreeNanoBananaUsage: vi.fn(async (..._args: unknown[]) => ({
    applied: true as const,
    allowed: false,
    usedCount: 5,
    limit: 5,
    remaining: 0,
    resetAt: '2026-10-24T00:00:00.000Z'
  }))
}));
vi.mock('../services/modelAccessPolicy.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/modelAccessPolicy.js')>()),
  resolvePlanTierForUser: vi.fn(async () => policy.plan),
  tryConsumeFreeNanoBananaUsage: policy.tryConsumeFreeNanoBananaUsage
}));

const usage = vi.hoisted(() => ({
  admin: false,
  metering: true,
  status: { enabled: true, governed: true, allowPro: false }
}));
vi.mock('../services/platformAllowance.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/platformAllowance.js')>()),
  meteringEnabled: () => usage.metering,
  isUsageExemptAdmin: vi.fn(async () => usage.admin),
  getAllowanceStatus: vi.fn(async () => usage.status)
}));

const { imageRouter, resolveImageModelAccess, freeDailyCapApplies, publicImageUsage, IMAGE_MODEL_USAGE_MESSAGE } = await import('./image.js');
const { errorHandler } = await import('../middleware/errors.js');
const { resolveStageModel } = await import('../ai/stageModels.js');

const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  req.user = { id: 'tester-1', email: 'tester@example.com' };
  next();
});
app.use('/api/image', imageRouter);
app.use(errorHandler);

let server: Server;
let base = '';
beforeAll(async () => {
  server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

const governedReservation = (): Reservation => ({
  reservationId: 'res-1',
  byokBypass: false,
  governed: true,
  walletSkipped: true,
  estimated: { estimatedCt: 10 },
  usage: {}
});

beforeEach(() => {
  usage.admin = false;
  usage.metering = true;
  usage.status = { enabled: true, governed: true, allowPro: false };
  policy.plan = 'free';
  meter.byok = false;
  meter.reservation = governedReservation();
  meter.reserveForOperation.mockReset();
  meter.reserveForOperation.mockImplementation(async () => ({ allowed: true, reservation: meter.reservation, seed: {}, provider: 'gemini', model: 'm' }));
  meter.settleReservedOperation.mockClear();
  meter.releaseReservedOperation.mockClear();
  policy.tryConsumeFreeNanoBananaUsage.mockClear();
  providers.gemini.mockClear();
  providers.flux.mockClear();
  providers.openrouter.mockClear();
  storage.persistGeneratedImage.mockClear();
});

const post = (path: string, body: Record<string, unknown>) =>
  fetch(`${base}/api/image${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ prompt: 'a hero on a rooftop', aspectRatio: '1:1', resolution: '1K', projectId: 'comic-1', ...body })
  });

describe('governed testers on the legacy Gemini route (billing off, metering on)', () => {
  it('no free-plan daily Nano Banana cap: the usage budget is the one meter', async () => {
    const res = await post('/gemini', { model: 'gemini-2.5-flash-image' });
    expect(res.status).toBe(200);
    expect(policy.tryConsumeFreeNanoBananaUsage).not.toHaveBeenCalled();
    expect(providers.gemini).toHaveBeenCalledTimes(1);
    const body = await res.json();
    expect(body.imageId).toBe('img-1');
    // Governed payloads carry no dollars.
    expect(body.billing).toMatchObject({ governed: true });
    expect(JSON.stringify(body.billing)).not.toMatch(/usd/i);
  });

  it('no plan-tier gate on the everyday models for a free-plan tester', async () => {
    const res = await post('/gemini', { model: 'gemini-nano-banana-2.1' });
    expect(res.status).toBe(200);
  });

  it('Pro models stay outside the included usage, with an honest (non-plan) message — before any spend', async () => {
    const res = await post('/gemini', { model: 'gemini-3-pro-image-preview' });
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error.message).toBe(IMAGE_MODEL_USAGE_MESSAGE);
    expect(body.error.message).not.toMatch(/plan/i);
    expect(meter.reserveForOperation).not.toHaveBeenCalled();
    expect(providers.gemini).not.toHaveBeenCalled();
  });

  it('allow_pro rows, exempt rows, admins and own keys may request Pro models', async () => {
    usage.status = { enabled: true, governed: true, allowPro: true };
    expect((await post('/gemini', { model: 'gemini-3-pro-image-preview' })).status).toBe(200);
    usage.status = { enabled: true, governed: false, allowPro: false };
    expect((await post('/gemini', { model: 'gemini-3-pro-image-preview' })).status).toBe(200);
    usage.status = { enabled: true, governed: true, allowPro: false };
    usage.admin = true;
    expect((await post('/gemini', { model: 'gemini-3-pro-image-preview' })).status).toBe(200);
    usage.admin = false;
    meter.byok = true;
    meter.reservation = { ...governedReservation(), byokBypass: true, governed: false, walletSkipped: false };
    expect((await post('/gemini', { model: 'gemini-3-pro-image-preview' })).status).toBe(200);
    // Own key: the platform pays nothing, so no daily cap either.
    expect(policy.tryConsumeFreeNanoBananaUsage).not.toHaveBeenCalled();
  });

  it('users the budget does not cover keep the plan wallet limits, cap included (and the hold is released)', async () => {
    meter.reservation = { ...governedReservation(), governed: false, walletSkipped: false };
    const res = await post('/gemini', { model: 'gemini-2.5-flash-image' });
    expect(res.status).toBe(402);
    expect((await res.json()).error.code).toBe('FREE_MODEL_DAILY_LIMIT_REACHED');
    expect(policy.tryConsumeFreeNanoBananaUsage).toHaveBeenCalledTimes(1);
    expect(providers.gemini).not.toHaveBeenCalled();
    expect(meter.releaseReservedOperation).toHaveBeenCalledTimes(1);
    expect(meter.settleReservedOperation).not.toHaveBeenCalled();
  });
});

describe('S12: the legacy OpenRouter route gates platform-funded image models like /gemini', () => {
  const ownKey = () => {
    meter.byok = true;
    meter.reservation = { ...governedReservation(), byokBypass: true, governed: false, walletSkipped: false };
  };

  it.each([
    'google/gemini-3-pro-image',
    'google/gemini-3-pro-image-preview',
    'google/gemini-3.1-flash-image',
    'openai/gpt-image-2.5-sunburst',
    'black-forest-labs/flux-3-image',
    'bytedance-seed/seedream-5-0-pro',
    'openai/some-unlisted-image-model',
    // Only OpenRouter's own `:free` spelling skips the gate; any other casing is judged like any id.
    'google/gemini-3-pro-image:FREE',
    'google/gemini-3-pro-image:Free'
  ])('governed tester on the platform key: %s is refused honestly, before any hold or provider call', async (model) => {
    const res = await post('/openrouter', { model });
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error.code).toBe('MODEL_NOT_ALLOWED_FOR_PLAN');
    expect(body.error.message).toBe(IMAGE_MODEL_USAGE_MESSAGE);
    expect(meter.reserveForOperation).not.toHaveBeenCalled();
    expect(providers.openrouter).not.toHaveBeenCalled();
    expect(meter.settleReservedOperation).not.toHaveBeenCalled();
    expect(meter.releaseReservedOperation).not.toHaveBeenCalled();
  });

  it('the gate judges the model that actually runs: a capability downgrade onto a Pro model is refused too', async () => {
    vi.mocked(resolveStageModel).mockResolvedValueOnce({
      model: 'google/gemini-3-pro-image',
      downgradedFrom: 'google/gemini-nano-banana-2.1',
      reason: 'test downgrade'
    });
    const res = await post('/openrouter', { model: 'google/gemini-nano-banana-2.1' });
    expect(res.status).toBe(403);
    expect(meter.reserveForOperation).not.toHaveBeenCalled();
    expect(providers.openrouter).not.toHaveBeenCalled();
  });

  it('governed: the everyday models, the route default (Nano Banana legacy) and $0 `:free` variants still run', async () => {
    for (const model of ['google/gemini-nano-banana-2.1', 'google/gemini-2.5-flash-image', 'some-lab/image-model:free']) {
      expect((await post('/openrouter', { model })).status, model).toBe(200);
    }
    // No model sent → the configured default (google/gemini-2.5-flash-image), judged by its Gemini twin.
    expect((await post('/openrouter', {})).status).toBe(200);
    expect(providers.openrouter).toHaveBeenCalledTimes(4);
    expect(meter.reserveForOperation).toHaveBeenCalledTimes(4);
  });

  it('allow_pro rows, exempt rows and admins may run every registry model on the platform key', async () => {
    usage.status = { enabled: true, governed: true, allowPro: true };
    expect((await post('/openrouter', { model: 'google/gemini-3-pro-image' })).status).toBe(200);
    usage.status = { enabled: true, governed: false, allowPro: false };
    expect((await post('/openrouter', { model: 'openai/gpt-image-2.5-sunburst' })).status).toBe(200);
    usage.status = { enabled: true, governed: true, allowPro: false };
    usage.admin = true;
    expect((await post('/openrouter', { model: 'bytedance-seed/seedream-5-0-pro' })).status).toBe(200);
  });

  it('the caller’s own OpenRouter key is never gated (any catalog model, metering on or off)', async () => {
    ownKey();
    expect((await post('/openrouter', { model: 'openai/some-catalog-image-model' })).status).toBe(200);
    expect((await post('/openrouter', { model: 'google/gemini-3-pro-image' })).status).toBe(200);
    usage.metering = false;
    expect((await post('/openrouter', { model: 'openai/some-catalog-image-model' })).status).toBe(200);
    expect(providers.openrouter).toHaveBeenCalledTimes(3);
  });

  it('metering off (legacy plan gate): a free plan on the platform key cannot run a Pro model', async () => {
    usage.metering = false;
    const res = await post('/openrouter', { model: 'google/gemini-3-pro-image' });
    expect(res.status).toBe(403);
    expect((await res.json()).error.code).toBe('MODEL_NOT_ALLOWED_FOR_PLAN');
    expect(providers.openrouter).not.toHaveBeenCalled();
    policy.plan = 'pro';
    expect((await post('/openrouter', { model: 'google/gemini-3-pro-image' })).status).toBe(200);
  });
});

describe('never erase real spend', () => {
  it('Gemini: storage fails after a successful generation → settled, never released', async () => {
    storage.persistGeneratedImage.mockRejectedValueOnce(new Error('bucket unavailable'));
    const res = await post('/gemini', { model: 'gemini-nano-banana-2.1' });
    expect(res.status).toBe(500);
    expect(meter.settleReservedOperation).toHaveBeenCalledTimes(1);
    expect(meter.releaseReservedOperation).not.toHaveBeenCalled();
  });

  it('Gemini: the provider call fails → the hold is released, nothing settled', async () => {
    providers.gemini.mockRejectedValueOnce(new Error('provider 503'));
    const res = await post('/gemini', { model: 'gemini-nano-banana-2.1' });
    expect(res.status).toBe(500);
    expect(meter.releaseReservedOperation).toHaveBeenCalledTimes(1);
    expect(meter.settleReservedOperation).not.toHaveBeenCalled();
  });

  it('Flux: storage fails → settled, never released; a failing settle never turns into a release', async () => {
    storage.persistGeneratedImage.mockRejectedValueOnce(new Error('bucket unavailable'));
    expect((await post('/flux', {})).status).toBe(500);
    expect(meter.settleReservedOperation).toHaveBeenCalledTimes(1);
    expect(meter.releaseReservedOperation).not.toHaveBeenCalled();

    meter.settleReservedOperation.mockClear();
    meter.settleReservedOperation.mockRejectedValueOnce(new Error('ledger down'));
    const ok = await post('/flux', {});
    // The image was generated and stored: the user gets it; the hold stays for reconciliation.
    expect(ok.status).toBe(200);
    expect((await ok.json()).imageId).toBe('img-1');
    expect(meter.releaseReservedOperation).not.toHaveBeenCalled();
  });

  it('OpenRouter: storage fails → settled with the provider-reported cost, never released', async () => {
    storage.persistGeneratedImage.mockRejectedValueOnce(new Error('bucket unavailable'));
    expect((await post('/openrouter', { model: 'google/gemini-nano-banana-2.1' })).status).toBe(500);
    expect(meter.settleReservedOperation).toHaveBeenCalledTimes(1);
    const settleInput = meter.settleReservedOperation.mock.calls[0][0] as { usage?: { providerCostUsd?: number } };
    expect(settleInput.usage?.providerCostUsd).toBe(0.04);
    expect(meter.releaseReservedOperation).not.toHaveBeenCalled();
  });

  it('OpenRouter: the provider call fails → released', async () => {
    providers.openrouter.mockRejectedValueOnce(new Error('429 rate limited'));
    expect((await post('/openrouter', { model: 'google/gemini-nano-banana-2.1' })).status).toBe(500);
    expect(meter.releaseReservedOperation).toHaveBeenCalledTimes(1);
    expect(meter.settleReservedOperation).not.toHaveBeenCalled();
  });
});

describe('no dollars in a governed user’s image response', () => {
  it('OpenRouter, governed: the response usage drops providerCostUsd (settle still gets it)', async () => {
    const res = await post('/openrouter', { model: 'google/gemini-nano-banana-2.1' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.usage).toEqual({ promptTokens: 1, candidatesTokens: 1, totalTokens: 2 });
    expect(JSON.stringify(body)).not.toMatch(/usd|cost/i);
    const settleInput = meter.settleReservedOperation.mock.calls[0][0] as { usage?: { providerCostUsd?: number } };
    expect(settleInput.usage?.providerCostUsd).toBe(0.04);
  });

  it('OpenRouter, admin / exempt / own key (not governed): the provider cost stays in the response', async () => {
    meter.reservation = { ...governedReservation(), governed: false, walletSkipped: true };
    const body = await (await post('/openrouter', { model: 'google/gemini-nano-banana-2.1' })).json();
    expect(body.usage).toMatchObject({ providerCostUsd: 0.04 });
  });

  it('publicImageUsage keeps the block intact for ungoverned reservations', () => {
    const usage = { promptTokens: 3, providerCostUsd: 0.01 };
    expect(publicImageUsage(usage, { governed: false })).toBe(usage);
    expect(publicImageUsage(usage, { governed: undefined })).toBe(usage);
    expect(publicImageUsage(usage, { governed: true })).toEqual({ promptTokens: 3 });
  });
});

describe('resolveImageModelAccess', () => {
  const req = (id?: string) => ({ user: id ? { id } : undefined }) as unknown as Parameters<typeof resolveImageModelAccess>[0];

  it('Stripe billing on: the plan decides', async () => {
    const access = await resolveImageModelAccess(req('u'), { byok: false }, { billingEnabled: true, planFor: async () => 'creator' });
    expect(access).toEqual({ mode: 'plan', planTier: 'creator' });
  });

  it('metering off: the legacy plan gate', async () => {
    const access = await resolveImageModelAccess(req('u'), { byok: false }, { billingEnabled: false, meteringEnabled: false, planFor: async () => 'free' });
    expect(access).toEqual({ mode: 'plan', planTier: 'free' });
  });

  it('billing off + metering on: a failed usage lookup closes to the everyday list', async () => {
    const deps = { billingEnabled: false, meteringEnabled: true, isAdmin: async () => false };
    expect(await resolveImageModelAccess(req('u'), { byok: false }, { ...deps, statusFor: async () => { throw new Error('down'); } })).toEqual({ mode: 'usage', pro: false });
    expect(await resolveImageModelAccess(req('u'), { byok: false }, { ...deps, statusFor: async () => ({ enabled: false, governed: true, allowPro: true }) })).toEqual({ mode: 'usage', pro: false });
    expect(await resolveImageModelAccess(req(), { byok: false }, deps)).toEqual({ mode: 'usage', pro: false });
  });

  it('freeDailyCapApplies only where the budget is not the meter', () => {
    expect(freeDailyCapApplies({ byokBypass: false, governed: true, walletSkipped: true })).toBe(false);
    expect(freeDailyCapApplies({ byokBypass: false, governed: false, walletSkipped: true })).toBe(false);
    expect(freeDailyCapApplies({ byokBypass: true, governed: false, walletSkipped: false })).toBe(false);
    expect(freeDailyCapApplies({ byokBypass: false, governed: false, walletSkipped: false })).toBe(true);
  });
});
