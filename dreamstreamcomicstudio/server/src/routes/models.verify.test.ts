// @vitest-environment node
// GET /api/models/verify must not hand the PLATFORM keys' live data to any signed-in user.
// Sign-up is open, so before this fix a free account read the platform OpenRouter key's /key
// record (label, usage, limit, limit_remaining, is_free_tier, rate_limit) and the account's
// /credits, plus which platform keys are configured — the same data BK-0 closed on
// /api/keys/validate. Now only admins get platform-key telemetry; everyone else sees their own
// keys only (the provider headers they send).
//
// The real route, requireAuth and hydrateAccessProfile run; only the Supabase token lookup, the
// role lookup, the catalog and the outbound provider fetch are faked.
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import express from 'express';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { annotateModel } from '../ai/catalogAnnotations.js';

const roles = vi.hoisted(() => ({ fail: false }));

vi.mock('../services/supabase.js', () => ({
  supabase: {
    auth: {
      getUser: vi.fn(async (token: string) =>
        token === 'user-token'
          ? { data: { user: { id: 'user-1', email: 'u1@example.com' } }, error: null }
          : token === 'admin-token'
            ? { data: { user: { id: 'admin-1', email: 'ops@example.com' } }, error: null }
            : { data: { user: null }, error: { message: 'bad token' } }
      )
    }
  }
}));
vi.mock('../services/rbac.js', () => ({
  resolveAccessProfile: vi.fn(async ({ userId }: { userId: string }) => {
    if (roles.fail) throw new Error('user_roles unreadable');
    const isAdmin = userId === 'admin-1';
    return { isAdmin, isModerator: isAdmin, isResearcher: isAdmin, bootstrapAdmin: false, roles: isAdmin ? ['admin'] : [] };
  })
}));
vi.mock('../services/modelCatalog.js', () => ({
  getCatalog: vi.fn(async () => ({ models: [], fetchedAt: 1, degraded: false })),
  filterCatalog: vi.fn((models: unknown[]) => models),
  getProviderModels: vi.fn(async () => [])
}));
vi.mock('../services/modelCatalogStore.js', () => ({
  persistHarvestedModels: vi.fn(async () => undefined),
  loadPersistedModels: vi.fn(async () => []),
  loadCallabilityMap: vi.fn(async () => new Map())
}));
vi.mock('../services/telemetryAnalytics.js', () => ({ getModelLatencyReport: vi.fn(async () => ({ models: {} })) }));
vi.mock('../services/usageAnalytics.js', () => ({ getModelPopularity: vi.fn(async () => []), parsePopularityWindow: () => '7d' }));
vi.mock('../services/modelStats.js', () => ({
  listModelScores: vi.fn(async () => []),
  listMonthlyUsage: vi.fn(async () => []),
  loadScoreMap: vi.fn(async () => new Map())
}));

const { modelsRouter, resetModelsRouteCaches, NVIDIA_CACHE_TTL_MS, NVIDIA_PERSIST_INTERVAL_MS } = await import('./models.js');
const catalogStore = await import('../services/modelCatalogStore.js');
const catalogService = await import('../services/modelCatalog.js');

const PLATFORM = {
  OPENROUTER_API_KEY: 'sk-or-PLATFORM-secret',
  NVIDIA_API_KEY: 'nvapi-PLATFORM-secret',
  GEMINI_API_KEY: 'AIza-PLATFORM-secret',
  OPENAI_API_KEY: 'sk-PLATFORM-openai',
  ANTHROPIC_API_KEY: 'sk-ant-PLATFORM-secret'
};
const KEY_RECORD = { label: 'sk-or-v1-abc…', usage: 12.34, limit: 50, limit_remaining: 37.66, is_free_tier: false, rate_limit: { requests: 200, interval: '10s' } };

type Upstream = { url: string; auth?: string };
const upstream: Upstream[] = [];
const realFetch = globalThis.fetch;
const fakeFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  if (/^http:\/\/127\.0\.0\.1:/.test(url)) return realFetch(input, init);
  upstream.push({ url, auth: new Headers(init?.headers).get('authorization') ?? undefined });
  const json = (data: unknown) => new Response(JSON.stringify(data), { status: 200, headers: { 'content-type': 'application/json' } });
  if (url.endsWith('/key')) return json({ data: KEY_RECORD });
  if (url.endsWith('/credits')) return json({ data: { total_credits: 100, total_usage: 40 } });
  return new Response('not found', { status: 404 });
}) as typeof fetch;

const app = express();
app.use('/api/models', modelsRouter);

let server: Server;
let base = '';
beforeAll(async () => {
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  return new Promise<void>((resolve) => server.close(() => resolve()));
});
beforeEach(() => {
  upstream.length = 0;
  roles.fail = false;
  vi.stubGlobal('fetch', fakeFetch);
  vi.unstubAllEnvs();
  for (const [k, v] of Object.entries(PLATFORM)) vi.stubEnv(k, v);
});

type Verify = {
  sources: { openrouter: { connected: boolean; liveKey: unknown; credits: unknown }; nvidia: { connected: boolean } };
  providers: Record<string, { connected: boolean }>;
};
const verify = async (token: string | null, headers: Record<string, string> = {}) => {
  const res = await fetch(`${base}/api/models/verify`, { headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers } });
  const text = await res.text();
  return { status: res.status, text, body: JSON.parse(text) as Verify };
};

const PLATFORM_DATA = /usage|limit|is_free_tier|rate_limit|label|PLATFORM/;

describe('GET /api/models/verify — platform-key telemetry is for admins only', () => {
  it('signed-in user, no key header, platform keys set → no liveKey, no credits, nothing "connected", no /key or /credits call', async () => {
    const r = await verify('user-token');
    expect(r.status).toBe(200);
    expect(r.body.sources.openrouter).toMatchObject({ connected: false, liveKey: null, credits: null });
    expect(r.body.sources.nvidia.connected).toBe(false);
    expect(Object.values(r.body.providers).every((p) => !p.connected)).toBe(true);
    expect(r.text).not.toMatch(PLATFORM_DATA);
    expect(upstream).toEqual([]);
  });

  it('signed-in user with their own OpenRouter key: that key — and only it — is reported', async () => {
    const r = await verify('user-token', { 'X-OpenRouter-Key': 'sk-or-user' });
    expect(r.body.sources.openrouter).toMatchObject({ connected: true, liveKey: KEY_RECORD, credits: { total: 100, usage: 40, remaining: 60 } });
    expect(r.body.providers.openrouter.connected).toBe(true);
    expect(r.body.providers.openai.connected).toBe(false);
    expect(upstream.map((u) => u.auth)).toEqual(['Bearer sk-or-user', 'Bearer sk-or-user']);
    expect(upstream.map((u) => u.url.split('/').pop()).sort()).toEqual(['credits', 'key']);
  });

  it('a role lookup that fails counts as "not an admin" (fails closed)', async () => {
    roles.fail = true;
    const r = await verify('admin-token');
    expect(r.body.sources.openrouter).toMatchObject({ connected: false, liveKey: null, credits: null });
    expect(upstream).toEqual([]);
  });

  it('admin, no key header: the platform keys are reported (operator telemetry, unchanged)', async () => {
    const r = await verify('admin-token');
    expect(r.body.sources.openrouter).toMatchObject({ connected: true, liveKey: KEY_RECORD });
    expect(r.body.providers.openai.connected).toBe(false);
    expect(r.body.providers.openai).toMatchObject({ configured: true, status: 'unverified' });
    expect(upstream.map((u) => u.auth)).toEqual(['Bearer sk-or-PLATFORM-secret', 'Bearer sk-or-PLATFORM-secret']);
  });

  it.each([undefined, 'not-a-real-nvidia-key'])('a public live NVIDIA listing cannot verify a missing or supplied key (%s)', async (key) => {
    const publicModel = annotateModel({
      id: 'nvidia/public-model', name: 'Public NVIDIA listing', source: 'nvidia',
      inputModalities: ['text'], outputModalities: ['text'], supportedParameters: [],
      pricing: { promptPerToken: 0, completionPerToken: 0, imagePerImage: 0, requestFlat: 0 },
      pricingKnown: false, pricingOrigin: 'unknown', catalogOrigin: 'live',
      isFree: false, costClass: 'paid', supportsImageOutput: false,
      supportsImageInput: false, supportsJsonOutput: false
    });
    vi.mocked(catalogService.getProviderModels).mockResolvedValueOnce([publicModel]);
    const r = await verify('user-token', key ? { 'X-Nvidia-Key': key } : {});
    expect(r.body.sources.nvidia.connected).toBe(false);
    expect(r.body.providers.nvidia).toMatchObject({
      connected: false, configured: Boolean(key), status: key ? 'unverified' : 'missing', modelCount: 1
    });
    expect(upstream).toEqual([]);
  });

  it('signed out → 401, no provider call', async () => {
    const r = await verify(null);
    expect(r.status).toBe(401);
    expect(upstream).toEqual([]);
  });
});

// EGRESS-DB E4: the public catalog reads the cached NVIDIA rows and their callability at most every 10 minutes per
// process (never keeping an empty answer), and a keyed NVIDIA list tops the cache up at most hourly.
describe('GET /api/models/catalog — NVIDIA cache reads', () => {
  const NV = [{ id: 'nv/one', source: 'nvidia' }];
  const catalog = async () => {
    const res = await fetch(`${base}/api/models/catalog`);
    expect(res.status).toBe(200);
    return (await res.json()) as { models: Array<{ id: string; apiCallable?: boolean }> };
  };

  beforeEach(() => {
    resetModelsRouteCaches();
    vi.mocked(catalogStore.loadCallabilityMap).mockReset().mockResolvedValue(new Map([['nv/one', true]]));
    vi.mocked(catalogStore.loadPersistedModels).mockReset().mockResolvedValue(NV as never);
    vi.mocked(catalogStore.persistHarvestedModels).mockReset().mockResolvedValue(undefined);
    vi.mocked(catalogService.getProviderModels).mockReset().mockResolvedValue([]);
  });
  afterEach(() => vi.useRealTimers());

  it('two catalog requests within 10 min make one callability read and one cached-list read', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-12T00:00:00Z'));
    const first = await catalog();
    expect(first.models.find((m) => m.id === 'nv/one')?.apiCallable).toBe(true);
    await catalog();
    expect(catalogStore.loadCallabilityMap).toHaveBeenCalledTimes(1);
    expect(catalogStore.loadPersistedModels).toHaveBeenCalledTimes(1);
    expect(catalogStore.loadPersistedModels).toHaveBeenCalledWith('nvidia');
    vi.setSystemTime(new Date(Date.parse('2026-11-12T00:00:00Z') + NVIDIA_CACHE_TTL_MS));
    await catalog();
    expect(catalogStore.loadCallabilityMap).toHaveBeenCalledTimes(2);
    expect(catalogStore.loadPersistedModels).toHaveBeenCalledTimes(2);
  });

  it('never keeps an empty answer (nothing cached yet, or the database unreachable)', async () => {
    vi.mocked(catalogStore.loadCallabilityMap).mockResolvedValue(new Map());
    vi.mocked(catalogStore.loadPersistedModels).mockResolvedValue([]);
    await catalog();
    await catalog();
    expect(catalogStore.loadCallabilityMap).toHaveBeenCalledTimes(2);
    expect(catalogStore.loadPersistedModels).toHaveBeenCalledTimes(2);
  });

  it('a keyed NVIDIA list tops the cache up at most hourly', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-12T00:00:00Z'));
    vi.mocked(catalogService.getProviderModels).mockImplementation(async (id: string) => (id === 'nvidia' ? (NV as never) : []));
    await catalog();
    await catalog();
    expect(vi.mocked(catalogStore.persistHarvestedModels).mock.calls.filter(([source]) => source === 'nvidia')).toHaveLength(1);
    expect(catalogStore.loadPersistedModels).not.toHaveBeenCalled();
    vi.setSystemTime(new Date(Date.parse('2026-11-12T00:00:00Z') + NVIDIA_PERSIST_INTERVAL_MS));
    await catalog();
    expect(vi.mocked(catalogStore.persistHarvestedModels).mock.calls.filter(([source]) => source === 'nvidia')).toHaveLength(2);
  });
});
