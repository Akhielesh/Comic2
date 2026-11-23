import sharp from 'sharp';
// @vitest-environment node
// P2-PLATFORM: the legacy image routes (/api/image/*).
//  (a) governed testers: no free-plan Nano Banana daily cap and no plan-tier model gate while
//      Stripe billing is off — the usage budget is the one meter (same rule as Comic Studio);
//  (b) a provider call that succeeded is SETTLED even when storing the image fails afterwards
//      (releasing would erase real spend); a provider call that failed releases its hold.
// No provider, storage or database is ever called: every seam is mocked.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
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
  })),
  ideogram: vi.fn(async (_key: string, args: { modelId?: string }) => ({
    dataUrl: 'data:image/png;base64,DDDD',
    model: args?.modelId || 'ideogram/ideogram-v2',
    timings: { apiMs: 5 }
  }))
}));
vi.mock('../ai/image.js', () => ({ generateGeminiImage: providers.gemini }));
vi.mock('../ai/flux.js', () => ({ generateFluxImage: providers.flux }));
vi.mock('../ai/ideogram.js', () => ({ generateIdeogramImage: providers.ideogram }));
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

const {
  imageRouter,
  resolveImageModelAccess,
  freeDailyCapApplies,
  publicImageUsage,
  IMAGE_MODEL_USAGE_MESSAGE,
  IDEOGRAM_MODEL_USAGE_MESSAGE,
  IDEOGRAM_UNKNOWN_MODEL_MESSAGE
} = await import('./image.js');
const { errorHandler } = await import('../middleware/errors.js');
const { resolveStageModel } = await import('../ai/stageModels.js');

const app = express();
app.use(express.json());
const { attachKeys } = await import('../middleware/keys.js');
const { attachFreeOnly } = await import('../middleware/freeOnly.js');
app.use(attachKeys, attachFreeOnly);
app.use((req, _res, next) => {
  // This fixture's established default is a platform Gemini key. Inject it deterministically.
  if (req.apiKeys && !req.apiKeys.geminiKey) {
    req.apiKeys.geminiKey = 'fixture-platform';
    req.apiKeys.providerKeys!.gemini = { key: 'fixture-platform', byok: false };
  }
  next();
});
app.use((req, _res, next) => {
  req.user = { id: 'tester-1', email: 'tester@example.com' };
  next();
});
app.use('/api/image', imageRouter);
app.use(errorHandler);

let server: Server;
let base = '';
beforeAll(async () => {
  server = app.listen(0, '127.0.0.1');
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
  providers.ideogram.mockClear();
  storage.persistGeneratedImage.mockClear();
});

const post = (path: string, body: Record<string, unknown>) =>
  fetch(`${base}/api/image${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ prompt: 'a hero on a rooftop', aspectRatio: '1:1', resolution: '1K', projectId: 'comic-1', ...body })
  });

describe('abandoned or joined direct image requests', () => {
  const request = (key: string, prompt: string, signal?: AbortSignal) => fetch(base + '/api/image/gemini', {
    method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': key },
    body: JSON.stringify({ prompt, model: 'gemini-2.5-flash-image', aspectRatio: '1:1', resolution: '1K' }), signal
  });
  it('removes a disconnected waiting client before any billing or provider call', async () => {
    const { comicImageCapacity } = await import('../comic/generationCapacity.js');
    let release!: () => void;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    const blockers = [1, 2, 3].map(() => comicImageCapacity.run('tester-1', undefined, () => blocked));
    const watch = vi.spyOn(comicImageCapacity, 'run');
    const controller = new AbortController();
    try {
      const waiting = request('abandon-queued-image', 'garden', controller.signal).catch(() => undefined);
      await vi.waitFor(() => expect(watch).toHaveBeenCalledOnce());
      const signal = watch.mock.calls[0][1]!;
      controller.abort();
      await waiting;
      await vi.waitFor(() => expect(signal.aborted).toBe(true));
    } finally { watch.mockRestore(); release(); await Promise.all(blockers); }
    expect(meter.reserveForOperation).not.toHaveBeenCalled();
    expect(providers.gemini).not.toHaveBeenCalled();
  });

  it('remembers a large unsaved result without charging another render after its inline bytes are evicted', async () => {
    const request = () => fetch(base + '/api/image/gemini', {
      method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': 'large-legacy-image' },
      body: JSON.stringify({ prompt: 'Woodland', model: 'gemini-2.5-flash-image', aspectRatio: '1:1', resolution: '1K', storage: 'test' })
    });
    providers.gemini.mockResolvedValueOnce({ dataUrl: 'data:image/png;base64,' + 'A'.repeat(2_000_001), model: 'gemini-2.5-flash-image', timings: { apiMs: 1 } });
    const first = await request();
    expect(first.status).toBe(200);
    await first.arrayBuffer();
    expect((await request()).status).toBe(410);
    expect(providers.gemini).toHaveBeenCalledOnce();
  });

  it('one surviving identical retry keeps the request; a conflicting retry is refused before release', async () => {
    let unlock!: () => void;
    const gate = new Promise<void>(resolve => { unlock = resolve; });
    meter.reserveForOperation.mockImplementationOnce(async () => {
      await gate;
      return { allowed: true, reservation: meter.reservation };
    });
    const controller = new AbortController();
    const pending = request('joined-image', 'garden', controller.signal).catch(() => undefined);
    try {
      await vi.waitFor(() => expect(meter.reserveForOperation).toHaveBeenCalledOnce());
      const joined = request('joined-image', 'garden');
      expect((await request('joined-image', 'different')).status).toBe(409);
      controller.abort();
      await pending;
      unlock();
      expect((await joined).status).toBe(200);
      expect(meter.reserveForOperation).toHaveBeenCalledOnce();
      expect(providers.gemini).toHaveBeenCalledOnce();
    } finally { unlock(); }
  });
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

describe('Ideogram on the platform key: governed users get the everyday list only (owner decision)', () => {
  const ownKey = () => {
    meter.byok = true;
    meter.reservation = { ...governedReservation(), byokBypass: true, governed: false, walletSkipped: false };
  };

  it.each([
    ['no model sent (the route default)', {}],
    ['Ideogram V2', { modelId: 'ideogram/ideogram-v2' }],
    ['Ideogram V2 Turbo', { modelId: 'ideogram/ideogram-v2-turbo' }],
    // A caller-chosen id the route does not know: it would run Ideogram's default version while the
    // hold and the settle were priced at the cheap id the caller sent.
    ['a cheap-priced foreign id', { modelId: 'pixazo/flux-1-schnell' }],
    ['an everyday Gemini id', { modelId: 'gemini-nano-banana-2.1' }],
    // Unlike /openrouter there is no `:free` skip here (Ideogram has no free variant), and the
    // pricing helper would hold `:free`/`:FREE` at $0 while Ideogram ran its default version.
    ['a `:free` spelling of an Ideogram id', { modelId: 'ideogram/ideogram-v2:free' }],
    ['an upper-case `:FREE` spelling', { modelId: 'ideogram/ideogram-v2:FREE' }]
  ])('governed tester, %s: refused honestly before any hold or provider call', async (_label, body) => {
    const res = await post('/ideogram', body);
    expect(res.status).toBe(403);
    const json = await res.json();
    expect(json.error.code).toBe('MODEL_NOT_ALLOWED_FOR_PLAN');
    expect(json.error.message).toBe(IDEOGRAM_MODEL_USAGE_MESSAGE);
    expect(json.error.message).not.toMatch(/plan|\$/i);
    expect(meter.reserveForOperation).not.toHaveBeenCalled();
    expect(providers.ideogram).not.toHaveBeenCalled();
    expect(meter.settleReservedOperation).not.toHaveBeenCalled();
    expect(meter.releaseReservedOperation).not.toHaveBeenCalled();
  });

  it('a usage lookup that fails closes to the everyday list (refused, nothing spent)', async () => {
    const { getAllowanceStatus } = await import('../services/platformAllowance.js');
    vi.mocked(getAllowanceStatus).mockRejectedValueOnce(new Error('status down'));
    const res = await post('/ideogram', { modelId: 'ideogram/ideogram-v2' });
    expect(res.status).toBe(403);
    expect(providers.ideogram).not.toHaveBeenCalled();
  });

  it('allow_pro rows, exempt rows and admins run the Ideogram models this route knows', async () => {
    usage.status = { enabled: true, governed: true, allowPro: true };
    expect((await post('/ideogram', { modelId: 'ideogram/ideogram-v2-turbo' })).status).toBe(200);
    usage.status = { enabled: true, governed: false, allowPro: false };
    expect((await post('/ideogram', {})).status).toBe(200);
    usage.status = { enabled: true, governed: true, allowPro: false };
    usage.admin = true;
    expect((await post('/ideogram', { modelId: 'ideogram/ideogram-v2' })).status).toBe(200);
    expect(providers.ideogram).toHaveBeenCalledTimes(3);
    expect(meter.reserveForOperation).toHaveBeenCalledTimes(3);
  });

  it('…but even they cannot price a platform Ideogram call at a foreign model id', async () => {
    usage.admin = true;
    const res = await post('/ideogram', { modelId: 'pixazo/flux-1-schnell' });
    expect(res.status).toBe(403);
    const json = await res.json();
    expect(json.error.message).toBe(IDEOGRAM_UNKNOWN_MODEL_MESSAGE);
    expect(json.error.details.allowedModels).toEqual(expect.arrayContaining(['ideogram/ideogram-v2', 'ideogram/ideogram-v2-turbo']));
    expect(meter.reserveForOperation).not.toHaveBeenCalled();
    expect(providers.ideogram).not.toHaveBeenCalled();
  });

  it.each(['ideogram/ideogram-v2:free', 'ideogram/ideogram-v2-turbo:FREE'])(
    '…nor at a free-looking spelling (%s): no $0 hold for a call Ideogram would run at its default version',
    async (modelId) => {
      usage.admin = true;
      const res = await post('/ideogram', { modelId });
      expect(res.status).toBe(403);
      expect((await res.json()).error.message).toBe(IDEOGRAM_UNKNOWN_MODEL_MESSAGE);
      expect(meter.reserveForOperation).not.toHaveBeenCalled();
      expect(providers.ideogram).not.toHaveBeenCalled();
    }
  );

  it('the caller’s own Ideogram key is never gated (governed or not, any model id)', async () => {
    ownKey();
    expect((await post('/ideogram', { modelId: 'ideogram/ideogram-v2' })).status).toBe(200);
    expect((await post('/ideogram', { modelId: 'some/other-id' })).status).toBe(200);
    expect(providers.ideogram).toHaveBeenCalledTimes(2);
  });

  it('metering off (legacy plan gate): a free plan is refused on the platform key, a paid plan runs', async () => {
    usage.metering = false;
    const res = await post('/ideogram', { modelId: 'ideogram/ideogram-v2' });
    expect(res.status).toBe(403);
    expect((await res.json()).error.code).toBe('MODEL_NOT_ALLOWED_FOR_PLAN');
    expect(providers.ideogram).not.toHaveBeenCalled();
    policy.plan = 'pro';
    expect((await post('/ideogram', { modelId: 'ideogram/ideogram-v2' })).status).toBe(200);
    expect(providers.ideogram).toHaveBeenCalledTimes(1);
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

describe('standalone images', () => {
  const accessRows = vi.fn();
  beforeEach(async () => {
    const db = await import('../services/supabase.js');
    vi.spyOn(db, 'getSupabaseAdmin').mockReturnValue({
      from: () => ({ select: () => ({ eq: accessRows }) })
    } as unknown as ReturnType<typeof db.getSupabaseAdmin>);
    accessRows.mockResolvedValue({ data: [], error: null });
  });
  afterEach(() => vi.restoreAllMocks());

  it('renders all provided references without a project and persists private artwork, including on a trailing-slash URL', async () => {
    const image = await sharp({ create: { width: 3, height: 3, channels: 3, background: '#458080' } }).png().toBuffer();
    const ref = 'data:image/png;base64,' + image.toString('base64');
    const res = await post('/standalone/', { referenceImages: [ref, ref], projectId: 'ignored', storage: 'test' });
    expect(res.status).toBe(200);
    expect(providers.gemini).toHaveBeenCalledWith(expect.any(String), 'a hero on a rooftop', '1:1', '1K', [ref, ref], 'gemini-2.5-flash-image', { singleRequest: true });
    expect(storage.persistGeneratedImage).toHaveBeenCalledWith(expect.objectContaining({ standalone: true, projectId: undefined, userId: 'tester-1' }));
    expect(meter.reserveForOperation).toHaveBeenCalledWith(expect.objectContaining({ stage: 'standalone-image' }));
  });

  it('uses one metered render to choose open-ended details, respects clear format cues, and forwards every reference', async () => {
    const image = await sharp({ create: { width: 3, height: 3, channels: 3, background: '#224488' } }).webp().toBuffer();
    const referenceImages = ['data:image/webp;base64,' + image.toString('base64')];
    const examples = [
      { prompt: 'A phone wallpaper of a golden retriever', aspectRatio: 'auto', ratio: '9:16' },
      { prompt: 'A panoramic beach with calm waves in a 3:4 composition', aspectRatio: 'auto', ratio: '3:4' },
      { prompt: 'Moonlight on the water', aspectRatio: 'auto', ratio: '' },
      { prompt: 'Wide banner or portrait format, use your judgment', aspectRatio: 'auto', ratio: '' },
      { prompt: 'A wide banner showing a garden', aspectRatio: '1:1', ratio: '1:1' }
    ];
    for (const { prompt, aspectRatio, ratio } of examples) {
      const res = await post('/standalone', { prompt, aspectRatio, referenceImages });
      expect(res.status).toBe(200);
      expect(providers.gemini).toHaveBeenLastCalledWith(expect.any(String), aspectRatio === 'auto' ? expect.stringContaining(prompt) : prompt,
        ratio, '1K', referenceImages, 'gemini-2.5-flash-image', { singleRequest: true });
    }
    expect(meter.reserveForOperation).toHaveBeenCalledTimes(examples.length);
    expect(providers.gemini).toHaveBeenCalledTimes(examples.length);
  });

  it('includes all ten references in three numbered sheets in one provider call and rejects eleven before billing', async () => {
    const colors = ['#f00','#0f0','#00f','#ff0','#0ff','#f0f','#fff','#000','#808080','#e05020'];
    const refs = await Promise.all(colors.map(async color => {
      const bytes = await sharp({ create: { width: 8, height: 8, channels: 3, background: color } }).png().toBuffer();
      return 'data:image/png;base64,' + bytes.toString('base64');
    }));
    expect((await post('/standalone', { referenceImages: [...refs, refs[0]] })).status).toBe(400);
    expect((await post('/standalone', { referenceImages: ['data:image/png;base64,AQID'] })).status).toBe(400);
    expect(meter.reserveForOperation).not.toHaveBeenCalled();
    expect((await post('/standalone', { referenceImages: refs })).status).toBe(200);
    expect(providers.gemini).toHaveBeenCalledTimes(1);
    const sheets = providers.gemini.mock.calls[0][4] as string[];
    expect(sheets).toHaveLength(3);
    const observed: number[][] = [];
    for (const [i, sheet] of sheets.entries()) {
      const input = Buffer.from(sheet.split(',')[1], 'base64');
      for (let j = 0; j < (i === 0 ? 4 : 3); j++) {
        observed.push([...await sharp(input).extract({ left: (j % 2) * 576 + 100, top: Math.floor(j / 2) * 612 + 100, width: 1, height: 1 }).raw().toBuffer()]);
      }
    }
    const expected = [[255,0,0],[0,255,0],[0,0,255],[255,255,0],[0,255,255],[255,0,255],[255,255,255],[0,0,0],[128,128,128],[224,80,32]];
    observed.forEach((channels,i) => channels.forEach((value,c) => expect(Math.abs(value - expected[i][c])).toBeLessThan(8)));
  });

  it('uses the member’s resolved OpenRouter credential for the same model, format, private storage and replay', async () => {
    const network = globalThis.fetch;
    vi.spyOn(globalThis, 'fetch').mockImplementation((url, options) => {
      if (String(url) === 'https://openrouter.ai/api/v1/key') return Promise.resolve(Response.json({ data: { limit_remaining: 2 } }));
      if (!String(url).startsWith(base + '/')) throw new Error('Unexpected non-local test request');
      return network(url, options);
    });
    meter.byok = true;
    meter.reservation = { ...governedReservation(), byokBypass: true, governed: false };
    const request = (headers: Record<string, string>) => fetch(base + '/api/image/standalone', {
      method: 'POST', headers: { 'content-type': 'application/json', 'Idempotency-Key': 'standalone-or-personal', ...headers },
      body: JSON.stringify({ prompt: 'Wide greenhouse', aspectRatio: '16:9' })
    });
    expect((await request({ 'X-OpenRouter-Key': 'sk-or-fixture', 'X-Free-Only': 'true' })).status).toBe(402);
    expect(meter.reserveForOperation).not.toHaveBeenCalled();
    expect((await request({ 'X-OpenRouter-Key': 'sk-or-fixture' })).status).toBe(200);
    expect(providers.openrouter.mock.calls[0][0]).toMatchObject({
      model: 'google/gemini-2.5-flash-image', retries: 1, aspectRatio: '16:9', imageSize: undefined
    });
    expect(storage.persistGeneratedImage.mock.calls[0][0]).toMatchObject({ source: 'openrouter', standalone: true, userId: 'tester-1' });
    expect(meter.reserveForOperation).toHaveBeenCalledWith(expect.objectContaining({
      provider: 'openrouter', resolvedModel: 'google/gemini-2.5-flash-image'
    }));
    const replay = await request({ 'X-Gemini-Key': 'fixture-direct-key' });
    expect(replay.status).toBe(200);
    expect(replay.headers.get('Idempotency-Replayed')).toBe('true');
    expect(providers.openrouter).toHaveBeenCalledOnce();
    expect(providers.gemini).not.toHaveBeenCalled();
  });

  it('shows a working personal router on the same page after Gemini fails preflight; a lost generation cannot charge a replay', async () => {
    const network = globalThis.fetch;
    vi.spyOn(globalThis, 'fetch').mockImplementation((url, options) => {
      if (String(url).startsWith('https://generativelanguage.googleapis.com/v1beta/models/')) return Promise.resolve(new Response(null, {status: 403}));
      if (String(url) === 'https://openrouter.ai/api/v1/key') return Promise.resolve(Response.json({data: {limit_remaining: 1}}));
      if (!String(url).startsWith(base + '/')) throw new Error('Unexpected non-local test request');
      return network(url, options);
    });
    const headers = { 'content-type': 'application/json', 'X-OpenRouter-Key': 'sk-or-retained-fixture', 'X-Gemini-Key': 'rejected-test-gemini' };
    const preview = await fetch(base + '/api/image/standalone/route', { headers });
    expect(await preview.json()).toEqual({ provider: 'openrouter', payer: 'personal', model: 'google/gemini-2.5-flash-image' });
    expect(meter.reserveForOperation).not.toHaveBeenCalled();
    meter.byok = true;
    const generate = (id: string) => fetch(base + '/api/image/standalone', {
      method: 'POST', headers: { ...headers, 'Idempotency-Key': id }, body: JSON.stringify({prompt: 'Silver clouds'})
    });
    const saved = await generate('automatic-fallback-success');
    expect(await saved.json()).toMatchObject({ provider: 'openrouter', payer: 'personal', imageId: 'img-1' });
    expect(providers.openrouter).toHaveBeenCalledOnce();
    expect(providers.gemini).not.toHaveBeenCalled();
    providers.openrouter.mockRejectedValueOnce(Object.assign(new Error('image timed out'), { status: 504 }));
    const lost = await generate('automatic-fallback-unknown');
    expect((await lost.json()).error.code).toBe('IMAGE_RESULT_UNCONFIRMED');
    expect(((await (await generate('automatic-fallback-unknown')).json()).error.code)).toBe('IMAGE_RESULT_UNCONFIRMED');
    expect(providers.openrouter).toHaveBeenCalledTimes(2);
    expect(meter.releaseReservedOperation).not.toHaveBeenCalled();
    expect(providers.gemini).not.toHaveBeenCalled();
  });

  it('replays a completed standalone generation when the same client action is retried', async () => {
    const send = () => fetch(`${base}/api/image/standalone`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'Idempotency-Key': 'workspace-duplicate' },
      body: JSON.stringify({ prompt: 'A tiny flower', aspectRatio: '1:1' })
    });
    expect((await send()).status).toBe(200);
    const retry = await send();
    expect(retry.status).toBe(200);
    expect(retry.headers.get('Idempotency-Replayed')).toBe('true');
    expect(providers.gemini).toHaveBeenCalledTimes(1);
  });

  it('signs history and renewed file URLs only from the signed-in account’s private standalone folder', async () => {
    const db = await import('../services/supabase.js');
    const { COMIC_PRIVATE_BUCKET } = await import('../config.js');
    const file = 'c69db4c4-afa4-47f6-8ca1-97a0689a7985.webp';
    const path = `u/tester-1/standalone/${file}`;
    const query = { eq: vi.fn(), like: vi.fn(), is: vi.fn(), order: vi.fn(), range: vi.fn() };
    for (const method of [query.eq, query.like, query.is, query.order]) method.mockReturnValue(query);
    query.range.mockResolvedValue({ data: [{ path, created_at: '2026-11-23T12:00:00Z' }], error: null });
    const sign = vi.fn(async () => ({ data: [{ path, signedUrl: 'https://test.invalid/private' }], error: null }));
    const bucket = vi.fn(() => ({ createSignedUrls: sign }));
    vi.mocked(db.getSupabaseAdmin).mockReturnValue({
      from: (table: string) => table === 'product_access' ? { select: () => ({ eq: accessRows }) } : { select: () => query },
      storage: { from: bucket }
    } as unknown as ReturnType<typeof db.getSupabaseAdmin>);
    const res = await fetch(`${base}/api/image/standalone?file=${file}`);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toContain('no-store');
    expect((await res.json()).images[0].imageId).toBe(path);
    expect(query.eq).toHaveBeenCalledWith('user_id', 'tester-1');
    expect(query.eq).toHaveBeenCalledWith('bucket', COMIC_PRIVATE_BUCKET);
    expect(query.eq).toHaveBeenCalledWith('path', path);
    expect(query.like).toHaveBeenCalledWith('path', 'u/tester-1/standalone/%');
    expect(query.is).toHaveBeenCalledWith('deleted_at', null);
    expect(bucket).toHaveBeenCalledWith(COMIC_PRIVATE_BUCKET);
    expect(sign).toHaveBeenCalledWith([path], 3600);
    expect((await fetch(`${base}/api/image/standalone?file=another-owner%2Fimage.webp`)).status).toBe(400);
    expect(sign).toHaveBeenCalledTimes(1);
  });

  it('refuses malformed references and oversized or unsupported requests before spending', async () => {
    for (const body of [{ referenceImages: [{}] }, { referenceImages: ['data:image/svg+xml;base64,AAAA'] },
      { model: 'different-model' }, { prompt: 'x'.repeat(4001) }, { aspectRatio: '0:0' }]) {
      expect((await post('/standalone', body)).status).toBe(400);
    }
    expect(providers.gemini).not.toHaveBeenCalled();
    expect(meter.reserveForOperation).not.toHaveBeenCalled();
  });

  it('requires the account’s comic entitlement and fails closed during entitlement lookup errors', async () => {
    const rbac = await import('../services/rbac.js');
    vi.spyOn(rbac, 'resolveAccessProfile').mockResolvedValue({ isAdmin: false } as Awaited<ReturnType<typeof rbac.resolveAccessProfile>>);
    accessRows.mockResolvedValueOnce({ data: [{ product: 'stream_studio', active: true }], error: null });
    expect((await post('/standalone', {})).status).toBe(403);
    accessRows.mockResolvedValueOnce({ data: null, error: new Error('offline') });
    expect((await post('/standalone', {})).status).toBe(503);
    expect(providers.gemini).not.toHaveBeenCalled();
  });
});
