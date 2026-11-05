// @vitest-environment node
// /api/models authz + caching (Models redesign Phase 0). /verify is out of scope here (a separate
// hotfix branch owns it and its tests).
//   /catalog     S1 ?refresh only for a server-confirmed admin (fails closed).
//                S2 direct providers list live only on the caller's own BYOK keys (never the
//                   platform env keys); without one they come from the seed or cache.
//                S3 Cache-Control + Vary by BYOK header.
//   /popularity  S4 requireAuth; the service's k-anonymous rows + generatedAt, passed through as-is
//                   (the k-floor, SETTLED filter and shares are tested in usageAnalytics.test.ts).
//   /usage-monthly  requireAuth; only the monthly rows whose (month, provider, model) clears the same
//                   k-floor (getMonthlyEligibleModels, tested in usageAnalytics.test.ts).
// models.outbound.test.ts runs /catalog over the REAL gateway and providers with fetch stubbed.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import express, { type NextFunction, type Request, type Response } from 'express';
import type { AddressInfo } from 'net';
import type { Server } from 'http';

type Row = { id: string; name: string; source: string; isFree: boolean };

// ---- auth: the real requireAuth / optionalAuth over a stubbed Supabase token check ----
const USERS: Record<string, { id: string; email: string }> = {
  'admin-token': { id: 'admin-1', email: 'ops@example.test' },
  'user-token': { id: 'user-1', email: 'someone@example.test' },
  'flaky-token': { id: 'flaky-1', email: 'flaky@example.test' }
};
const auth = vi.hoisted(() => ({
  getUser: vi.fn(async (_token: string): Promise<{ data: { user: unknown }; error: unknown }> => ({ data: { user: null }, error: null }))
}));
vi.mock('../services/supabase.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/supabase.js')>()),
  supabase: { auth: { getUser: (token: string) => auth.getUser(token) } }
}));

// ---- roles: the same rbac lookup requireAdmin uses; admin-1 is the only admin, flaky-1's lookup throws ----
const rbac = vi.hoisted(() => ({
  resolveAccessProfile: vi.fn(async ({ userId }: { userId: string }) => {
    if (userId === 'flaky-1') throw new Error('role lookup down');
    const isAdmin = userId === 'admin-1';
    return { isAdmin, isModerator: isAdmin, isResearcher: isAdmin, bootstrapAdmin: false, roles: isAdmin ? ['admin'] : [] };
  })
}));
vi.mock('../services/rbac.js', () => ({ resolveAccessProfile: rbac.resolveAccessProfile }));

// ---- catalog + providers: no network, every call recorded ----
const cat = vi.hoisted(() => ({
  getCatalog: vi.fn(async (_force?: boolean) => ({
    models: [
      { id: 'vendor/free-model:free', name: 'free', source: 'openrouter', isFree: true },
      { id: 'vendor/paid-model', name: 'paid', source: 'openrouter', isFree: false }
    ],
    fetchedAt: 1_700_000_000_000,
    degraded: false
  })),
  // The real getProviderModels lists live with the key it is given and, given none (or a blank
  // one), falls back to a PLATFORM key inside the gateway. So any recorded call is an upstream
  // call, and a call without the caller's own key is a platform-key call.
  getProviderModels: vi.fn(async (id: string, key: string | null) => [
    { id: `${id}/seed`, name: 'seed', source: id, isFree: false },
    { id: `${id}/live`, name: 'live', source: id, isFree: false, listedWith: key }
  ]),
  // The keyless listing: seed only (NVIDIA has none), never the network.
  keylessListModels: vi.fn(async (id: string, ctx: { apiKey: string }) =>
    ctx?.apiKey
      ? [{ id: `${id}/live`, name: 'live', source: id, isFree: false, listedWith: ctx.apiKey }]
      : id === 'nvidia'
        ? []
        : [{ id: `${id}/seed`, name: 'seed', source: id, isFree: false }]
  )
}));
vi.mock('../services/modelCatalog.js', () => ({
  getCatalog: (force?: boolean) => cat.getCatalog(force),
  getProviderModels: (id: string, key: string | null) => cat.getProviderModels(id, key),
  filterCatalog: (models: Row[]) => models
}));
vi.mock('../ai/gateway.js', () => ({
  getProvider: (id: string) => ({ listModels: (ctx: { apiKey: string }) => cat.keylessListModels(id, ctx) })
}));
vi.mock('../ai/catalogAnnotations.js', () => ({ annotateModels: (models: unknown[]) => models }));

vi.mock('../ai/providers/openrouter.js', () => ({
  fetchOpenRouterKeyStatus: async () => null,
  fetchOpenRouterCredits: async () => null
}));

const store = vi.hoisted(() => ({ persisted: [] as string[], harvested: [] as string[] }));
vi.mock('../services/modelCatalogStore.js', () => ({
  persistHarvestedModels: async (source: string) => {
    store.harvested.push(source);
  },
  loadPersistedModels: async (source: string) => {
    store.persisted.push(source);
    return [{ id: `${source}/cached`, name: 'cached', source, isFree: false }];
  },
  loadCallabilityMap: async () => new Map<string, boolean>()
}));

type MonthlyRow = { month: string; product: string; source: string; model: string; requests: number };
const monthlyKey = (month: string, provider: string, model: string) => `${month}\u0000${provider}\u0000${model}`;
const pop = vi.hoisted(() => ({
  getModelPopularity: vi.fn(async (_window: string): Promise<unknown> => ({ generatedAt: '', models: [] })),
  getMonthlyEligibleModels: vi.fn(async (_sinceMonth: string): Promise<ReadonlySet<string>> => new Set<string>()),
  listMonthlyUsage: vi.fn(async (_months: number): Promise<MonthlyRow[]> => [])
}));
vi.mock('../services/usageAnalytics.js', () => ({
  parsePopularityWindow: (value: unknown) => (value === 'week' || value === 'month' || value === 'all' ? value : 'week'),
  getModelPopularity: (window: string) => pop.getModelPopularity(window),
  getMonthlyEligibleModels: (sinceMonth: string) => pop.getMonthlyEligibleModels(sinceMonth),
  monthlyModelKey: (month: string, provider: string, model: string) => monthlyKey(month, provider, model)
}));
vi.mock('../services/modelStats.js', () => ({
  listModelScores: async () => ({ runId: null, runAt: null, scores: [] }),
  listMonthlyUsage: (months: number) => pop.listMonthlyUsage(months),
  loadScoreMap: async () => new Map<string, number>()
}));
vi.mock('../services/telemetryAnalytics.js', () => ({ getModelLatency: async () => ({}) }));

const { modelsRouter, CATALOG_BYOK_HEADERS } = await import('./models.js');

// Mirrors server/src/index.ts: app.use('/api/models', systemRateLimit, modelsRouter) — the router is
// public; /verify and /popularity add requireAuth themselves.
const app = express();
app.use('/api/models', modelsRouter);
app.use((_err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  res.status(500).json({ error: { message: 'Unexpected server error' } });
});

// Platform env keys are SET for every provider, so a fallback to one would be visible.
const DIRECT_IDS = ['nvidia', 'openai', 'anthropic', 'gemini', 'deepseek', 'zai', 'minimax', 'tencent', 'xai'] as const;
const PLATFORM_ENV: Record<string, string> = {
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
// The contract list (finding 5 / S3): every BYOK header attachKeys reads for a text provider.
const EXPECTED_BYOK_HEADERS = [
  'X-OpenRouter-Key',
  'X-Nvidia-Key',
  'X-OpenAI-Key',
  'X-Anthropic-Key',
  'X-Gemini-Key',
  'X-DeepSeek-Key',
  'X-ZAI-Key',
  'X-MiniMax-Key',
  'X-Tencent-Key',
  'X-XAI-Key'
];
const savedEnv: Record<string, string | undefined> = {};

let server: Server;
let base = '';
beforeAll(async () => {
  for (const name of Object.keys(PLATFORM_ENV)) savedEnv[name] = process.env[name];
  server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  for (const [name, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  await new Promise<void>((resolve) => server.close(() => resolve()));
});
beforeEach(() => {
  Object.assign(process.env, PLATFORM_ENV);
  for (const fn of [auth.getUser, rbac.resolveAccessProfile, cat.getCatalog, cat.getProviderModels, cat.keylessListModels, pop.getModelPopularity, pop.getMonthlyEligibleModels, pop.listMonthlyUsage]) {
    fn.mockClear();
  }
  auth.getUser.mockImplementation(async (token: string) =>
    USERS[token] ? { data: { user: USERS[token] }, error: null } : { data: { user: null }, error: { message: 'bad token' } }
  );
  store.persisted = [];
  store.harvested = [];
});

const get = (path: string, headers: Record<string, string> = {}) => fetch(`${base}${path}`, { headers });
const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });
const platformKeyValues = Object.values(PLATFORM_ENV);

describe('GET /api/models/catalog: S1, ?refresh only for a server-confirmed admin', () => {
  it.each([
    ['anonymous', {}],
    ['a signed-in non-admin', bearer('user-token')],
    ['an invalid token', bearer('not-a-token')],
    ['a user whose role lookup fails (fail closed)', bearer('flaky-token')]
  ])('ignores ?refresh for %s', async (_who, headers) => {
    for (const q of ['refresh=1', 'refresh=true']) {
      cat.getCatalog.mockClear();
      const res = await get(`/api/models/catalog?${q}`, headers);
      expect(res.status).toBe(200);
      expect(cat.getCatalog.mock.calls).toEqual([[false]]);
    }
  });

  it('the fail-closed case really reached the role lookup (and it threw)', async () => {
    await get('/api/models/catalog?refresh=1', bearer('flaky-token'));
    expect(rbac.resolveAccessProfile).toHaveBeenCalledTimes(1);
    await expect(rbac.resolveAccessProfile.mock.results[0].value).rejects.toThrow('role lookup down');
  });

  it('honours ?refresh=1 and ?refresh=true for a server-confirmed admin', async () => {
    for (const q of ['refresh=1', 'refresh=true']) {
      cat.getCatalog.mockClear();
      const res = await get(`/api/models/catalog?${q}`, bearer('admin-token'));
      expect(res.status).toBe(200);
      expect(cat.getCatalog.mock.calls).toEqual([[true]]);
    }
  });

  it('only 1|true is a refresh, even for an admin (no other spelling forces one)', async () => {
    for (const q of ['refresh=yes', 'refresh=TRUE', 'refresh=0', 'refresh=', 'refresh=1&refresh=1', 'force=1']) {
      cat.getCatalog.mockClear();
      await get(`/api/models/catalog?${q}`, bearer('admin-token'));
      expect(cat.getCatalog.mock.calls, q).toEqual([[false]]);
    }
  });

  it('does no auth lookup at all without ?refresh (the common public path)', async () => {
    const res = await get('/api/models/catalog', bearer('admin-token'));
    expect(res.status).toBe(200);
    expect(cat.getCatalog.mock.calls).toEqual([[false]]);
    expect(auth.getUser).not.toHaveBeenCalled();
    expect(rbac.resolveAccessProfile).not.toHaveBeenCalled();
  });
});

describe('GET /api/models/catalog: S2, no platform-key provider calls without BYOK', () => {
  it.each([
    ['anonymous', {}],
    ['a signed-in non-admin', bearer('user-token')],
    ['an admin', bearer('admin-token')],
    ['an admin forcing ?refresh', bearer('admin-token')]
  ])('%s with no BYOK header: zero direct-provider listings, seed + NVIDIA cache only', async (who, headers) => {
    const res = await get(who.includes('refresh') ? '/api/models/catalog?refresh=1' : '/api/models/catalog', headers);
    expect(res.status).toBe(200);
    expect(cat.getProviderModels).not.toHaveBeenCalled();
    // Every keyless listing ran with an empty key (the providers return their seed before any fetch).
    expect(cat.keylessListModels.mock.calls.map(([id]) => id).sort()).toEqual([...DIRECT_IDS].sort());
    for (const [, ctx] of cat.keylessListModels.mock.calls) expect(ctx).toEqual({ apiKey: '', byok: false });
    expect(store.persisted).toEqual(['nvidia']);
    expect(store.harvested).toEqual([]);

    const body = await res.json();
    const ids = (body.models as Row[]).map((m) => m.id);
    expect(ids).toEqual(expect.arrayContaining(['openai/seed', 'xai/seed', 'nvidia/cached']));
    expect(ids.some((id) => id.endsWith('/live'))).toBe(false);
    for (const value of platformKeyValues) expect(JSON.stringify(body)).not.toContain(value);
  });

  it("with the caller's own key: the live merge for THAT provider only, on that key", async () => {
    const res = await get('/api/models/catalog', { 'X-OpenAI-Key': 'user-openai-key' });
    expect(res.status).toBe(200);
    expect(cat.getProviderModels.mock.calls).toEqual([['openai', 'user-openai-key']]);
    expect(cat.keylessListModels.mock.calls.map(([id]) => id)).not.toContain('openai');
    const ids = ((await res.json()).models as Row[]).map((m) => m.id);
    expect(ids).toEqual(expect.arrayContaining(['openai/live', 'openai/seed', 'anthropic/seed', 'nvidia/cached']));
  });

  it('several own keys: one live listing per keyed provider; the key is trimmed', async () => {
    await get('/api/models/catalog', { 'X-Nvidia-Key': '  user-nvidia-key  ', 'X-Anthropic-Key': 'user-anthropic-key' });
    expect(cat.getProviderModels.mock.calls.sort()).toEqual([
      ['anthropic', 'user-anthropic-key'],
      ['nvidia', 'user-nvidia-key']
    ]);
    // A live NVIDIA listing on the user's key tops up the shared public cache (as before).
    expect(store.harvested).toEqual(['nvidia']);
    expect(store.persisted).toEqual([]);
  });

  it('X-OpenRouter-Key alone triggers no direct-provider listing (the base list is public)', async () => {
    const res = await get('/api/models/catalog', { 'X-OpenRouter-Key': 'user-openrouter-key' });
    expect(cat.getProviderModels).not.toHaveBeenCalled();
    // So the body is exactly the keyless one.
    expect(await res.json()).toEqual(await (await get('/api/models/catalog')).json());
  });

  it('a blank or whitespace-only header is no key (it would resolve to the platform key)', async () => {
    // Node strips SP/HTAB around header values; NBSP (latin-1 0xA0) survives and String#trim drops it.
    for (const value of ['', ' ', '  ']) {
      cat.getProviderModels.mockClear();
      const res = await get('/api/models/catalog', { 'X-Nvidia-Key': value, 'X-XAI-Key': value });
      expect(res.status).toBe(200);
      expect(cat.getProviderModels, JSON.stringify(value)).not.toHaveBeenCalled();
      expect(res.headers.get('cache-control')).toBe('public, max-age=60');
    }
  });
});

describe('GET /api/models/catalog: S3, Cache-Control and Vary', () => {
  it('Vary names exactly the 10 text BYOK headers, both with and without a key', async () => {
    expect([...CATALOG_BYOK_HEADERS]).toEqual(EXPECTED_BYOK_HEADERS);
    for (const headers of [{}, { 'X-OpenAI-Key': 'user-openai-key' }]) {
      const res = await get('/api/models/catalog', headers);
      const vary = (res.headers.get('vary') || '').split(',').map((h) => h.trim().toLowerCase());
      expect(vary.sort()).toEqual(EXPECTED_BYOK_HEADERS.map((h) => h.toLowerCase()).sort());
    }
  });

  it('public, max-age=60 without an own key (anonymous, signed in, admin refresh)', async () => {
    for (const [path, headers] of [
      ['/api/models/catalog', {}],
      ['/api/models/catalog', bearer('user-token')],
      ['/api/models/catalog?refresh=1', bearer('admin-token')]
    ] as const) {
      const res = await get(path, headers);
      expect(res.headers.get('cache-control')).toBe('public, max-age=60');
    }
  });

  it.each(EXPECTED_BYOK_HEADERS.filter((h) => h !== 'X-OpenRouter-Key'))('private, no-store when %s carries a key (the body holds that live listing)', async (header) => {
    const res = await get('/api/models/catalog', { [header]: 'user-key' });
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('private, no-store');
  });

  it('a direct-provider key wins over an OpenRouter key: private, no-store', async () => {
    const res = await get('/api/models/catalog', { 'X-OpenRouter-Key': 'user-or-key', 'X-XAI-Key': 'user-xai-key' });
    expect(res.headers.get('cache-control')).toBe('private, no-store');
  });

  it('only an OpenRouter key: never a public cache, but private, no-cache keeps ETag revalidation (304)', async () => {
    const headers = { 'X-OpenRouter-Key': 'user-openrouter-key' };
    const first = await get('/api/models/catalog', headers);
    expect(first.headers.get('cache-control')).toBe('private, no-cache');
    const etag = first.headers.get('etag');
    expect(etag).toBeTruthy();
    // As a browser revalidates (fetch() would otherwise add `Cache-Control: no-cache` to a conditional request).
    const again = await get('/api/models/catalog', { ...headers, 'If-None-Match': etag as string, 'Cache-Control': 'max-age=0' });
    expect(again.status).toBe(304);
    expect(again.headers.get('cache-control')).toBe('private, no-cache');
  });

  it('image-provider and governance headers do not change the response, so they stay public', async () => {
    const res = await get('/api/models/catalog', { 'X-Pixazo-Key': 'k', 'X-Flux-Key': 'k', 'X-Ideogram-Key': 'k', 'X-Allowed-Sources': 'openai' });
    expect(res.headers.get('cache-control')).toBe('public, max-age=60');
    expect(cat.getProviderModels).not.toHaveBeenCalled();
  });
});

describe('GET /api/models/catalog: response shape', () => {
  it('keeps the body keys, refresh or not, admin or not; sources count the seed and cache', async () => {
    const anon = await (await get('/api/models/catalog?refresh=1')).json();
    const admin = await (await get('/api/models/catalog?refresh=1', bearer('admin-token'))).json();
    expect(Object.keys(anon).sort()).toEqual(['count', 'degraded', 'fetchedAt', 'models', 'sources', 'total']);
    expect(admin).toEqual(anon);
    expect(Object.keys(anon.sources).sort()).toEqual(['openrouter', ...DIRECT_IDS].sort());
    expect(anon.sources).toMatchObject({ openrouter: 2, nvidia: 1, openai: 1, xai: 1 });
    expect(anon.total).toBe(2 + DIRECT_IDS.length);
  });
});

describe('GET /api/models/usage-monthly: signed in, k-anonymous rows only', () => {
  const ROWS: MonthlyRow[] = [
    { month: '2026-10', product: 'chat_studio', source: 'openrouter', model: 'vendor/broad', requests: 900 },
    { month: '2026-11', product: 'chat_studio', source: 'openrouter', model: 'vendor/broad', requests: 400 },
    { month: '2026-11', product: 'comic_studio', source: 'openrouter', model: 'vendor/broad', requests: 12 },
    { month: '2026-11', product: 'chat_studio', source: 'openrouter', model: 'vendor/one-person', requests: 85 },
    { month: '2026-11', product: 'chat_studio', source: 'nvidia', model: 'vendor/broad', requests: 30 }
  ];

  it('rejects anonymous callers and bad tokens (requireAuth) without reading any usage', async () => {
    expect((await get('/api/models/usage-monthly?months=24')).status).toBe(401);
    expect((await get('/api/models/usage-monthly', bearer('not-a-token'))).status).toBe(401);
    expect(pop.listMonthlyUsage).not.toHaveBeenCalled();
    expect(pop.getMonthlyEligibleModels).not.toHaveBeenCalled();
  });

  it('returns only the rows whose month, provider and model clear the k-floor', async () => {
    pop.listMonthlyUsage.mockResolvedValueOnce(ROWS);
    // vendor/broad on OpenRouter cleared k in November only; nothing else did.
    pop.getMonthlyEligibleModels.mockResolvedValueOnce(new Set([monthlyKey('2026-11', 'openrouter', 'vendor/broad')]));
    const res = await get('/api/models/usage-monthly?months=2', bearer('user-token'));
    expect(res.status).toBe(200);
    expect(pop.listMonthlyUsage.mock.calls).toEqual([[2]]);
    // The span the floor is computed over starts at the oldest row returned.
    expect(pop.getMonthlyEligibleModels.mock.calls).toEqual([['2026-10']]);
    const body = await res.json();
    expect(Object.keys(body)).toEqual(['rows']);
    expect(body.rows).toEqual([ROWS[1], ROWS[2]]);
    expect(JSON.stringify(body)).not.toContain('one-person');
  });

  it('nothing eligible (today: a handful of beta users) is an empty list, never the raw counters', async () => {
    pop.listMonthlyUsage.mockResolvedValueOnce(ROWS);
    const body = await (await get('/api/models/usage-monthly?months=24', bearer('user-token'))).json();
    expect(body).toEqual({ rows: [] });
  });

  it('no rows at all: no ledger read', async () => {
    const body = await (await get('/api/models/usage-monthly', bearer('user-token'))).json();
    expect(body).toEqual({ rows: [] });
    expect(pop.getMonthlyEligibleModels).not.toHaveBeenCalled();
  });

  it('a failed eligibility read is a 500 (fail closed), never the unfiltered rows', async () => {
    pop.listMonthlyUsage.mockResolvedValueOnce(ROWS);
    pop.getMonthlyEligibleModels.mockRejectedValueOnce(new Error('ledger down'));
    const res = await get('/api/models/usage-monthly', bearer('user-token'));
    expect(res.status).toBe(500);
    expect(await res.text()).not.toContain('vendor/');
  });
});

describe('GET /api/models/popularity: S4 at the route', () => {
  const AGGREGATE = {
    generatedAt: '2026-11-05T10:00:00.000Z',
    models: [{ model: 'vendor/model-a', provider: 'openrouter', requests: 120, users: 31, sharePct: 100 }]
  };

  it('rejects anonymous callers and bad tokens (requireAuth) without reading usage', async () => {
    expect((await get('/api/models/popularity')).status).toBe(401);
    expect((await get('/api/models/popularity', bearer('not-a-token'))).status).toBe(401);
    expect(pop.getModelPopularity).not.toHaveBeenCalled();
  });

  it("returns the service's k-anonymous rows and generatedAt as-is: no totals, no extra fields", async () => {
    pop.getModelPopularity.mockResolvedValueOnce(AGGREGATE);
    const res = await get('/api/models/popularity?window=month', bearer('user-token'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(pop.getModelPopularity.mock.calls).toEqual([['month']]);
    expect(Object.keys(body).sort()).toEqual(['generatedAt', 'models', 'window']);
    expect(body).toEqual({ window: 'month', ...AGGREGATE });
    expect(new Date(body.generatedAt).toISOString()).toBe(body.generatedAt);
  });

  it('an unknown window falls back to week; an empty aggregate stays an empty list', async () => {
    pop.getModelPopularity.mockResolvedValueOnce({ generatedAt: AGGREGATE.generatedAt, models: [] });
    const body = await (await get('/api/models/popularity?window=decade', bearer('user-token'))).json();
    expect(pop.getModelPopularity.mock.calls).toEqual([['week']]);
    expect(body).toEqual({ window: 'week', generatedAt: AGGREGATE.generatedAt, models: [] });
  });

  it('a failed read is a 500 through the error handler (never a cached or partial body)', async () => {
    pop.getModelPopularity.mockRejectedValueOnce(new Error('supabase down: secret detail'));
    const res = await get('/api/models/popularity', bearer('user-token'));
    expect(res.status).toBe(500);
    expect(await res.text()).not.toContain('secret detail');
  });
});
