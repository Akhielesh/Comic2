// @vitest-environment node
// S2 (finding 5) at the network boundary: GET /api/models/catalog over the REAL modelCatalog
// service, gateway and provider adapters, with global fetch stubbed. Every platform env key is set,
// so any fallback to one would show up in an outbound request. Without a BYOK header the only
// outbound call allowed is OpenRouter's public /models list, sent anonymously; with the caller's
// own key, exactly that provider is listed live, on that key.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'net';
import type { Server } from 'http';

// Before any import reads config.ts: a platform key for every text provider.
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
  Object.assign(process.env, keys, { AI_PROVIDER: 'openrouter' });
  delete process.env.DREAMSTREAMSTUDIO_ALL_KEY;
  delete process.env.HUNYUAN_API_KEY;
  return { keys, saved };
});

// No database: the durable catalog index, scores and analytics are stubbed.
const store = vi.hoisted(() => ({ harvested: [] as string[], persisted: [] as string[] }));
vi.mock('../services/modelCatalogStore.js', () => ({
  persistHarvestedModels: async (source: string) => {
    store.harvested.push(source);
  },
  loadPersistedModels: async (source?: string) => {
    store.persisted.push(String(source));
    // A warm durable index for the OpenRouter base list (so the cold start serves it and refreshes
    // in the background) and the cached NVIDIA list.
    return [
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
    ];
  },
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
const { getProviderModels } = await import('../services/modelCatalog.js');
const config = await import('../config.js');

type Outbound = { url: string; auth: string; wire: string };
const outbound: Outbound[] = [];
const realFetch = globalThis.fetch;
let base = '';

// Upstream stub: records each request and answers like a provider's /models list.
const fakeUpstream = (url: string, init?: RequestInit): Response => {
  const headers = new Headers(init?.headers as HeadersInit | undefined);
  outbound.push({
    url,
    auth: headers.get('authorization') || headers.get('x-api-key') || '',
    wire: `${url} ${JSON.stringify([...headers.entries()])} ${typeof init?.body === 'string' ? init.body : ''}`
  });
  return new Response(JSON.stringify({ data: [{ id: 'vendor/live-only-model', name: 'Live only' }] }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' }
  });
};

const app = express();
app.use('/api/models', modelsRouter);
let server: Server;

beforeAll(async () => {
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (base && url.startsWith(base)) return realFetch(input, init);
    return fakeUpstream(url, init);
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
beforeEach(() => {
  outbound.length = 0;
  store.harvested = [];
  store.persisted = [];
});

const catalog = async (headers: Record<string, string> = {}) => {
  const res = await realFetch(`${base}/api/models/catalog`, { headers });
  expect(res.status).toBe(200);
  const body = await res.json();
  // Let the background OpenRouter revalidation (if any) issue its request before we inspect.
  await new Promise((resolve) => setTimeout(resolve, 20));
  return { res, body };
};
const platformKeyValues = () => Object.values(PLATFORM.keys);
const leakedPlatformKeys = () => outbound.filter((call) => platformKeyValues().some((key) => call.wire.includes(key)));
const isOpenRouterModels = (url: string) => url === `${config.OPENROUTER_BASE_URL}/models`;
const directCalls = () => outbound.filter((call) => !isOpenRouterModels(call.url));

describe('GET /api/models/catalog outbound calls (real gateway, fetch stubbed)', () => {
  it('the detector works: the gateway really falls back to a platform key when given none', async () => {
    await getProviderModels('openai', null);
    expect(outbound).toHaveLength(1);
    expect(outbound[0].url).toBe(`${config.OPENAI_BASE_URL}/models`);
    expect(leakedPlatformKeys()).toHaveLength(1);
  });

  it('without a BYOK header: no direct-provider call and no platform key on any request', async () => {
    const { res, body } = await catalog();
    expect(directCalls()).toEqual([]);
    expect(leakedPlatformKeys()).toEqual([]);
    // The only network the route may cause is OpenRouter's public list, anonymously.
    for (const call of outbound) {
      expect(isOpenRouterModels(call.url)).toBe(true);
      expect(call.auth).toBe('');
    }
    // Seeds and the NVIDIA cache still populate the page.
    expect(body.sources.openai).toBeGreaterThan(0);
    expect(body.sources.anthropic).toBeGreaterThan(0);
    expect(body.sources.nvidia).toBe(1);
    expect(store.persisted).toContain('nvidia');
    expect(store.harvested.filter((s) => s !== 'openrouter')).toEqual([]);
    expect(res.headers.get('cache-control')).toBe('public, max-age=60');
  });

  it('a signed-in caller with no BYOK header is the same: still no direct-provider call', async () => {
    await catalog({ Authorization: 'Bearer some-session-token', 'X-Allowed-Sources': 'openrouter,nvidia,openai' });
    expect(directCalls()).toEqual([]);
    expect(leakedPlatformKeys()).toEqual([]);
  });

  it("with the caller's own OpenAI key: one live listing, at OpenAI, on the caller's key", async () => {
    const { res, body } = await catalog({ 'X-OpenAI-Key': 'user-openai-key' });
    expect(directCalls().map((call) => [call.url, call.auth])).toEqual([[`${config.OPENAI_BASE_URL}/models`, 'Bearer user-openai-key']]);
    expect(leakedPlatformKeys()).toEqual([]);
    expect((body.models as { id: string; source: string }[]).some((m) => m.source === 'openai' && m.id === 'vendor/live-only-model')).toBe(true);
    expect(res.headers.get('cache-control')).toBe('private, no-store');
  });

  it('with only the caller\'s OpenRouter key: no direct-provider call, and the key is never sent upstream', async () => {
    const { res } = await catalog({ 'X-OpenRouter-Key': 'user-openrouter-key' });
    expect(directCalls()).toEqual([]);
    expect(outbound.some((call) => call.wire.includes('user-openrouter-key'))).toBe(false);
    expect(res.headers.get('cache-control')).toBe('private, no-cache');
  });

  it("with the caller's own NVIDIA and Anthropic keys: exactly those two, each on its own key", async () => {
    await catalog({ 'X-Nvidia-Key': 'user-nvidia-key', 'X-Anthropic-Key': 'user-anthropic-key' });
    const calls = directCalls().map((call) => [call.url, call.auth]).sort();
    expect(calls).toEqual(
      [
        [`${config.ANTHROPIC_BASE_URL}/models?limit=100`, 'user-anthropic-key'],
        [`${config.NVIDIA_BASE_URL}/models`, 'Bearer user-nvidia-key']
      ].sort()
    );
    expect(leakedPlatformKeys()).toEqual([]);
    expect(store.harvested).toContain('nvidia');
  });

  it('a whitespace-only BYOK header is no key: no call at all, so no platform-key fallback', async () => {
    await catalog({ 'X-Nvidia-Key': ' ', 'X-OpenAI-Key': '  ', 'X-XAI-Key': ' ' });
    expect(directCalls()).toEqual([]);
    expect(leakedPlatformKeys()).toEqual([]);
  });
});
