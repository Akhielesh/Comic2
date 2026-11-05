// @vitest-environment node
// S2 (finding 5) when the platform's default provider is NVIDIA (AI_PROVIDER=nvidia; production sets
// openrouter, docs/RAILWAY_DEPLOY.md). Same harness as models.outbound.test.ts: the REAL catalog
// service, gateway and adapters, fetch stubbed, every platform env key set.
//
// KNOWN GAP, needs DreamStream (server/src/services/modelCatalog.ts is theirs): refresh() lists the
// DEFAULT provider, and for any default but OpenRouter it does so on the platform key
// (resolveProviderContext(undefined, provider.id)). A keyless /catalog that finds the cache cold or
// stale triggers that refresh in the background. The route's own direct-provider merge stays keyless;
// the base-list refresh is what leaks. The `it.fails` case below pins it: it passes while the gap is
// open and FAILS once refresh() stops using the platform key, which is the cue to drop `.fails`.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'net';
import type { Server } from 'http';

const PLATFORM = vi.hoisted(() => {
  const keys: Record<string, string> = {
    OPENROUTER_API_KEY: 'platform-openrouter-key',
    NVIDIA_API_KEY: 'platform-nvidia-key',
    OPENAI_API_KEY: 'platform-openai-key',
    ANTHROPIC_API_KEY: 'platform-anthropic-key',
    GEMINI_API_KEY: 'platform-gemini-key',
    DEEPSEEK_API_KEY: 'platform-deepseek-key',
    ZAI_API_KEY: 'platform-zai-key',
    MINIMAX_API_KEY: 'platform-minimax-key',
    TENCENT_API_KEY: 'platform-tencent-key',
    XAI_API_KEY: 'platform-xai-key'
  };
  const saved: Record<string, string | undefined> = {};
  for (const name of [...Object.keys(keys), 'AI_PROVIDER', 'DREAMSTREAMSTUDIO_ALL_KEY', 'HUNYUAN_API_KEY']) saved[name] = process.env[name];
  Object.assign(process.env, keys, { AI_PROVIDER: 'nvidia' });
  delete process.env.DREAMSTREAMSTUDIO_ALL_KEY;
  delete process.env.HUNYUAN_API_KEY;
  return { keys, saved };
});

vi.mock('../services/modelCatalogStore.js', () => ({
  persistHarvestedModels: async () => undefined,
  // A warm durable index (so a cold start serves it and refreshes in the background).
  loadPersistedModels: async (source?: string) => [
    {
      id: `${source}/cached-model`,
      name: 'cached',
      source,
      pricing: { promptPerToken: 0, completionPerToken: 0, imagePerImage: 0, requestFlat: 0 },
      isFree: false,
      costClass: 'paid',
      inputModalities: ['text'],
      outputModalities: ['text'],
      supportedParameters: []
    }
  ],
  loadCallabilityMap: async () => new Map<string, boolean>()
}));
vi.mock('../services/modelStats.js', () => ({
  listModelScores: async () => ({ runId: null, runAt: null, scores: [] }),
  listMonthlyUsage: async () => [],
  loadScoreMap: async () => new Map<string, number>()
}));
vi.mock('../services/usageAnalytics.js', () => ({
  parsePopularityWindow: () => 'week',
  getModelPopularity: async () => ({ generatedAt: '', models: [] }),
  getMonthlyEligibleModels: async () => new Set<string>(),
  monthlyModelKey: (month: string, provider: string, model: string) => `${month}|${provider}|${model}`
}));
vi.mock('../services/telemetryAnalytics.js', () => ({ getModelLatency: async () => ({}) }));

const { modelsRouter } = await import('./models.js');
const { getProvider } = await import('../ai/gateway.js');
const config = await import('../config.js');

type Outbound = { url: string; wire: string };
const outbound: Outbound[] = [];
const realFetch = globalThis.fetch;
let base = '';

const app = express();
app.use('/api/models', modelsRouter);
let server: Server;

beforeAll(async () => {
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (base && url.startsWith(base)) return realFetch(input, init);
    const headers = new Headers(init?.headers as HeadersInit | undefined);
    outbound.push({ url, wire: `${url} ${JSON.stringify([...headers.entries()])} ${typeof init?.body === 'string' ? init.body : ''}` });
    return new Response(JSON.stringify({ data: [{ id: 'vendor/live-only-model', name: 'Live only' }] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  });
  server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  vi.unstubAllGlobals();
  for (const [name, value] of Object.entries(PLATFORM.saved)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

// What one keyless request caused upstream, recorded by the first case and checked by the next two
// (if the request never ran, the list is empty and the `it.fails` case reports itself as failed).
const seen: Outbound[] = [];

describe('AI_PROVIDER=nvidia: a keyless GET /api/models/catalog', () => {
  it('runs with NVIDIA as the platform default, and the request is served', async () => {
    expect(getProvider().id).toBe('nvidia');
    const res = await realFetch(`${base}/api/models/catalog`);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('public, max-age=60');
    // Let the background revalidation issue its request before we look.
    await new Promise((resolve) => setTimeout(resolve, 30));
    seen.push(...outbound);
  });

  it("the route's own direct-provider merge makes no call: anything upstream is NVIDIA's /models (the base refresh)", () => {
    expect(seen.filter((call) => call.url !== `${config.NVIDIA_BASE_URL}/models`)).toEqual([]);
  });

  it.fails('KNOWN GAP (needs DS: modelCatalog.refresh lists the default provider on the platform key): no call carries a platform key', () => {
    const platformKeys = Object.values(PLATFORM.keys);
    expect(seen.filter((call) => platformKeys.some((key) => call.wire.includes(key)))).toEqual([]);
  });
});
