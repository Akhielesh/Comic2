// @vitest-environment node
// GET /api/models/verify is operator telemetry for admins and a self-check for a user's OWN key:
// - signed out → 401 (requireAuth);
// - signed-in non-admin without an own header key → 403, with no outbound call and no catalog work;
//   a header that is only whitespace (a lone NBSP byte) is no key;
// - non-admin with an own header key → only that key is queried, never a platform key on any host,
//   `connected` never reveals which platform keys exist, and the shared catalog is not read at all
//   (so a cold or stale cache can't turn their call into a DB read, a live refresh or an upsert);
// - server-confirmed admin → platform data as before, from the cached catalog, never a forced refresh;
// - always `Cache-Control: private, no-store`.
// The real getCatalog (services/modelCatalog) runs behind a pass-through spy; only the DB store, the
// role lookup and auth are faked, and every outbound fetch is recorded.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'net';
import type { Server } from 'http';
import { PROVIDERS_ORDERED, TEXT_PROVIDER_IDS, type ProviderId } from '../../../shared/providers.js';

// A distinct fake platform key for EVERY provider env var, set before config.ts reads them, so the
// suite never depends on the developer's shell and any platform fallback shows up on the wire.
const PLATFORM = vi.hoisted(() => {
  const keys = {
    openrouter: 'platform-openrouter-env-key-fake',
    nvidia: 'platform-nvidia-env-key-fake',
    openai: 'platform-openai-env-key-fake',
    anthropic: 'platform-anthropic-env-key-fake',
    gemini: 'platform-gemini-env-key-fake',
    deepseek: 'platform-deepseek-env-key-fake',
    zai: 'platform-zai-env-key-fake',
    minimax: 'platform-minimax-env-key-fake',
    tencent: 'platform-tencent-env-key-fake',
    xai: 'platform-xai-env-key-fake'
  };
  const env: Record<string, string> = {
    OPENROUTER_API_KEY: keys.openrouter,
    NVIDIA_API_KEY: keys.nvidia,
    OPENAI_API_KEY: keys.openai,
    ANTHROPIC_API_KEY: keys.anthropic,
    GEMINI_API_KEY: keys.gemini,
    DEEPSEEK_API_KEY: keys.deepseek,
    ZAI_API_KEY: keys.zai,
    MINIMAX_API_KEY: keys.minimax,
    TENCENT_API_KEY: keys.tencent,
    XAI_API_KEY: keys.xai,
    // Aliases and pools that config.ts also reads: pinned so a shell value can't change a key above.
    HUNYUAN_API_KEY: '',
    OPENROUTER_API_KEYS: '',
    NVIDIA_API_KEYS: '',
    DREAMSTREAMSTUDIO_ALL: '',
    dreamstreamstudio_all: '',
    // Legacy image-only providers attachKeys also resolves.
    PIXAZO_API_KEY: 'platform-pixazo-env-key-fake',
    PIXAZO_SUBSCRIPTION_KEY: '',
    FLUX_API_KEY: '',
    IDEOGRAM_API_KEY: 'platform-ideogram-env-key-fake',
    AI_PROVIDER: 'openrouter'
  };
  for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value);
  return { keys, env, all: new Set([...Object.values(keys), 'platform-pixazo-env-key-fake', 'platform-ideogram-env-key-fake']) };
});
const OWN = {
  openrouter: 'user-own-openrouter-key-fake',
  nvidia: 'user-own-nvidia-key-fake',
  openai: 'user-own-openai-key-fake',
  anthropic: 'user-own-anthropic-key-fake'
};

const who = vi.hoisted(() => ({ signedIn: true, role: 'user' as 'user' | 'admin' | 'lookup-fails' }));
vi.mock('../middleware/auth.js', () => ({
  requireAuth: (req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (!who.signedIn) return res.status(401).json({ error: { message: 'Missing Authorization header' } });
    req.user = { id: `user-${who.role}`, email: 'someone@example.com' };
    next();
  }
}));
// The real requireAdmin.hydrateAccessProfile runs; only the role lookup behind it is faked.
vi.mock('../services/rbac.js', () => ({
  resolveAccessProfile: vi.fn(async () => {
    if (who.role === 'lookup-fails') throw new Error('database unavailable');
    const isAdmin = who.role === 'admin';
    return { isAdmin, isModerator: isAdmin, isResearcher: isAdmin, bootstrapAdmin: false, roles: isAdmin ? ['admin'] : [] };
  })
}));

// The REAL getCatalog, behind a pass-through spy so the test can also see how it was called.
const catalog = vi.hoisted(() => ({ getCatalog: vi.fn() }));
vi.mock('../services/modelCatalog.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../services/modelCatalog.js')>();
  catalog.getCatalog.mockImplementation((force?: boolean) => real.getCatalog(force));
  return { ...real, getCatalog: catalog.getCatalog };
});
// Only the DB layer is faked.
const store = vi.hoisted(() => ({
  persistHarvestedModels: vi.fn(async () => undefined),
  loadPersistedModels: vi.fn(async (): Promise<unknown[]> => []),
  loadCallabilityMap: vi.fn(async () => new Map<string, boolean>())
}));
vi.mock('../services/modelCatalogStore.js', () => store);

const config = await import('../config.js');
const { attachKeys } = await import('../middleware/keys.js');
const { modelsRouter } = await import('./models.js');

// Where each provider's platform key may legitimately go (the server's configured base URLs).
const HOST: Record<ProviderId, string> = {
  openrouter: new URL(config.OPENROUTER_BASE_URL).host,
  nvidia: new URL(config.NVIDIA_BASE_URL).host,
  openai: new URL(config.OPENAI_BASE_URL).host,
  anthropic: new URL(config.ANTHROPIC_BASE_URL).host,
  gemini: new URL(config.GEMINI_OPENAI_BASE_URL).host,
  deepseek: new URL(config.DEEPSEEK_BASE_URL).host,
  zai: new URL(config.ZAI_BASE_URL).host,
  minimax: new URL(config.MINIMAX_BASE_URL).host,
  tencent: new URL(config.TENCENT_BASE_URL).host,
  xai: new URL(config.XAI_BASE_URL).host
};

// Mirrors the production mount (server/src/index.ts): attachKeys is global, then
// app.use('/api/models', systemRateLimit, modelsRouter), before the global requireAuth.
const app = express();
app.use(attachKeys);
app.use('/api/models', modelsRouter);

// Outbound calls: every non-loopback fetch is recorded with its credential (Bearer, or Anthropic's
// x-api-key) and answered by a fake that tells platform-key data apart from the user's own.
type Outbound = { host: string; path: string; credential: string | null };
const outbound: Outbound[] = [];
const realFetch = globalThis.fetch;
let base = '';
// What OpenRouter's public /models returns (the shared catalog refresh reads it anonymously).
let openRouterModels: Array<{ id: string }> = [];
const fakeFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  if (base && href.startsWith(base)) return realFetch(input, init);
  const url = new URL(href);
  const headers = new Headers(init?.headers);
  const auth = headers.get('authorization');
  const credential = auth?.startsWith('Bearer ') ? auth.slice(7) : headers.get('x-api-key');
  outbound.push({ host: url.host, path: url.pathname, credential });
  const platform = credential != null && PLATFORM.all.has(credential);
  if (url.pathname.endsWith('/key')) {
    return Response.json({ data: platform ? { label: 'platform', usage: 777.77, limit: 999, limit_remaining: 221.23 } : { label: 'mine', usage: 1.25, limit: 10, limit_remaining: 8.75 } });
  }
  if (url.pathname.endsWith('/credits')) {
    return Response.json({ data: platform ? { total_credits: 999, total_usage: 777.77 } : { total_credits: 20, total_usage: 5 } });
  }
  if (url.pathname.endsWith('/models')) {
    if (url.host === HOST.openrouter) return Response.json({ data: openRouterModels });
    return Response.json({ data: [{ id: 'meta/llama-x-instruct' }, { id: 'nvidia/nemo-y' }] });
  }
  return new Response('not found', { status: 404 });
};
const settleBackground = () => new Promise((resolve) => setTimeout(resolve, 20));

let server: Server;
beforeAll(async () => {
  vi.stubGlobal('fetch', fakeFetch);
  server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});
beforeEach(() => {
  who.signedIn = true;
  who.role = 'user';
  outbound.length = 0;
  openRouterModels = [];
  catalog.getCatalog.mockClear();
  store.persistHarvestedModels.mockClear();
  store.loadPersistedModels.mockClear();
});

const verify = (headers: Record<string, string> = {}) => fetch(`${base}/api/models/verify`, { headers });

const expectNoStore = (res: Response) => expect(res.headers.get('cache-control')).toBe('private, no-store');
// No catalog work at all: the shared catalog is not read, the DB is not read or written, and the
// OpenRouter catalog is not fetched.
const expectNoCatalogWork = () => {
  expect(catalog.getCatalog).not.toHaveBeenCalled();
  expect(store.loadPersistedModels).not.toHaveBeenCalled();
  expect(store.persistHarvestedModels).not.toHaveBeenCalled();
  expect(outbound.filter((call) => call.host === HOST.openrouter && call.path.endsWith('/models'))).toEqual([]);
};
const expectNoPlatformCredential = () => {
  for (const call of outbound) expect(PLATFORM.all.has(call.credential ?? ''), `${call.host}${call.path}`).toBe(false);
};

describe('GET /api/models/verify', () => {
  it('pins every provider env key the registry knows (the suite does not depend on the shell)', () => {
    for (const def of PROVIDERS_ORDERED) expect(PLATFORM.env[def.keyEnv], def.keyEnv).toBeTruthy();
    expect(Object.keys(PLATFORM.keys).sort()).toEqual([...TEXT_PROVIDER_IDS].sort());
  });

  it('signed out → 401, with no outbound call and no catalog work', async () => {
    who.signedIn = false;
    const res = await verify();
    expect(res.status).toBe(401);
    expectNoStore(res);
    expect(outbound).toEqual([]);
    expectNoCatalogWork();
  });

  it('signed-in non-admin without an own key → 403 "Admins only.", zero outbound fetches, no refresh or upsert', async () => {
    const res = await verify();
    expect(res.status).toBe(403);
    expectNoStore(res);
    expect(await res.json()).toEqual({ error: { message: 'Admins only.' } });
    expect(outbound).toEqual([]);
    expectNoCatalogWork();
  });

  it('fails closed when the role lookup fails: 403, nothing fetched', async () => {
    who.role = 'lookup-fails';
    const res = await verify();
    expect(res.status).toBe(403);
    expect(outbound).toEqual([]);
    expectNoCatalogWork();
  });

  it('an own key that source governance turns off does not count: 403', async () => {
    const res = await verify({ 'X-OpenRouter-Key': OWN.openrouter, 'X-Allowed-Sources': 'nvidia' });
    expect(res.status).toBe(403);
    expect(outbound).toEqual([]);
  });

  // A lone NBSP byte reaches Express as '\u00a0': truthy, but the gateway trims it to '' and would
  // fall back to the platform key. It is no key. (A plain space is stripped by the HTTP parser.)
  it.each([
    ['X-Nvidia-Key', 'a lone NBSP', '\u00a0'],
    ['X-OpenAI-Key', 'a lone NBSP', '\u00a0'],
    ['X-OpenRouter-Key', 'a lone NBSP', '\u00a0'],
    ['X-Nvidia-Key', 'a space', ' '],
    ['X-OpenAI-Key', 'a space', ' ']
  ])('%s holding only whitespace (%s) is no key: 403 and zero outbound calls', async (header, _label, value) => {
    const res = await verify({ [header]: value });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: { message: 'Admins only.' } });
    expect(outbound).toEqual([]);
    expectNoCatalogWork();
  });

  it('a whitespace-only header next to a real own key never becomes a platform call', async () => {
    const res = await verify({ 'X-OpenRouter-Key': OWN.openrouter, 'X-Nvidia-Key': '\u00a0', 'X-OpenAI-Key': '\u00a0' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(outbound.map((call) => [call.host, call.credential])).toEqual(
      expect.arrayContaining([[HOST.openrouter, OWN.openrouter]])
    );
    expect(outbound.every((call) => call.host === HOST.openrouter && call.credential === OWN.openrouter)).toBe(true);
    expect(body.sources.nvidia).toMatchObject({ connected: false, modelCount: 0 });
    expect(body.providers.nvidia.connected).toBe(false);
    expect(body.providers.openai.connected).toBe(false);
    expectNoPlatformCredential();
  });

  it('non-admin with an own OpenRouter key on a COLD cache: only that key is queried, no platform credits, no catalog work', async () => {
    const res = await verify({ 'X-OpenRouter-Key': OWN.openrouter });
    expect(res.status).toBe(200);
    expectNoStore(res);
    const body = await res.json();

    expect(outbound.map((call) => `${call.host}${call.path}`).sort()).toEqual([`${HOST.openrouter}/api/v1/credits`, `${HOST.openrouter}/api/v1/key`]);
    expect(outbound.every((call) => call.credential === OWN.openrouter)).toBe(true);
    expectNoPlatformCredential();
    expectNoCatalogWork();

    expect(body.sources.openrouter).toMatchObject({ connected: true, liveKey: { label: 'mine', usage: 1.25 }, credits: { total: 20, usage: 5, remaining: 15 } });
    expect(body.catalog.fetchedAt).toBeNull();
    // Platform env keys exist for every provider, but a non-admin is never told so.
    expect(body.sources.nvidia.connected).toBe(false);
    for (const [id, p] of Object.entries(body.providers as Record<string, { connected: boolean }>)) {
      expect(p.connected, id).toBe(id === 'openrouter');
    }
    const text = JSON.stringify(body);
    expect(text).not.toContain('999');
    expect(text).not.toContain('777.77');
    expect(text).not.toContain('platform');

    // The setup really was a cold cache: the same getCatalog() the route used to call reads the DB.
    // (It also leaves the cache STALE for the next test: the durable index is served with
    // fetchedAt 0, and its background revalidation fails because OpenRouter lists nothing.)
    store.loadPersistedModels.mockResolvedValueOnce([{ id: 'vendor/persisted-model', source: 'openrouter', isFree: false }]);
    await catalog.getCatalog();
    expect(store.loadPersistedModels).toHaveBeenCalledWith('openrouter');
    await settleBackground();
  });

  it('non-admin with an own OpenRouter key on a STALE cache: still no refresh, no upsert, no OpenRouter /models fetch', async () => {
    const res = await verify({ 'X-OpenRouter-Key': OWN.openrouter });
    expect(res.status).toBe(200);
    expect(outbound.every((call) => call.credential === OWN.openrouter)).toBe(true);
    expectNoCatalogWork();

    // The setup really was a stale cache: getCatalog() now kicks a live revalidation.
    outbound.length = 0;
    await catalog.getCatalog();
    await settleBackground();
    expect(outbound.filter((call) => call.host === HOST.openrouter && call.path.endsWith('/models'))).toHaveLength(1);
  });

  it('non-admin with an own NVIDIA key: NVIDIA is listed on that key, nothing is persisted, and no OpenRouter key data is returned', async () => {
    const res = await verify({ 'X-Nvidia-Key': OWN.nvidia });
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(outbound.map((call) => [call.host, call.credential])).toEqual([[HOST.nvidia, OWN.nvidia]]);
    expect(body.sources.nvidia).toMatchObject({ connected: true, modelCount: 2 });
    expect(body.sources.openrouter).toMatchObject({ connected: false, liveKey: null, credits: null });
    expect(body.providers.openrouter.connected).toBe(false);
    expectNoCatalogWork();
  });

  it('non-admin with own OpenAI and Anthropic keys: each vendor gets only its own user key; no platform key goes anywhere', async () => {
    const res = await verify({ 'X-OpenAI-Key': OWN.openai, 'X-Anthropic-Key': OWN.anthropic });
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(outbound.map((call) => [call.host, call.credential]).sort()).toEqual(
      [[HOST.anthropic, OWN.anthropic], [HOST.openai, OWN.openai]]
    );
    expectNoPlatformCredential();
    expectNoCatalogWork();
    for (const [id, p] of Object.entries(body.providers as Record<string, { connected: boolean }>)) {
      expect(p.connected, id).toBe(id === 'openai' || id === 'anthropic');
    }
    expect(body.sources.openrouter).toMatchObject({ connected: false, liveKey: null, credits: null });
  });

  it('server-confirmed admin (warm cache): platform data as before, each platform key only on its own vendor, no forced refresh, no upsert', async () => {
    // Warm the shared cache the way the refresh loop does, outside the request.
    openRouterModels = [{ id: 'vendor/paid-model' }, { id: 'vendor/free-model:free' }];
    await catalog.getCatalog(true);
    await settleBackground();
    outbound.length = 0;
    catalog.getCatalog.mockClear();
    store.persistHarvestedModels.mockClear();
    store.loadPersistedModels.mockClear();

    who.role = 'admin';
    const res = await verify();
    expect(res.status).toBe(200);
    expectNoStore(res);
    const body = await res.json();

    // The cached catalog, never forced; nothing read from or written to the DB; no catalog fetch.
    expect(catalog.getCatalog).toHaveBeenCalledTimes(1);
    expect(catalog.getCatalog.mock.calls[0][0]).not.toBe(true);
    expect(store.loadPersistedModels).not.toHaveBeenCalled();
    expect(store.persistHarvestedModels).not.toHaveBeenCalled();

    const openRouterCalls = outbound.filter((call) => call.host === HOST.openrouter);
    expect(openRouterCalls.map((call) => call.path).sort()).toEqual(['/api/v1/credits', '/api/v1/key']);
    expect(openRouterCalls.every((call) => call.credential === PLATFORM.keys.openrouter)).toBe(true);
    // Every platform key is used only against its own vendor (never the OpenRouter key elsewhere).
    for (const call of outbound) {
      const owner = (Object.entries(PLATFORM.keys) as Array<[ProviderId, string]>).find(([, key]) => key === call.credential)?.[0];
      expect(owner, `${call.host}${call.path}`).toBeDefined();
      expect(call.host, owner).toBe(HOST[owner!]);
    }
    expect(outbound.filter((call) => call.host === HOST.nvidia).map((call) => call.credential)).toEqual([PLATFORM.keys.nvidia]);

    expect(body.sources.openrouter).toMatchObject({ connected: true, modelCount: 2, liveKey: { label: 'platform' }, credits: { total: 999 } });
    expect(body.sources.nvidia).toMatchObject({ connected: true, modelCount: 2 });
    for (const id of TEXT_PROVIDER_IDS) expect(body.providers[id].connected, id).toBe(true);
    expect(typeof body.catalog.fetchedAt).toBe('number');
    expect(body.catalog).toMatchObject({ degraded: false });
  });

  // getCatalog() without force still revalidates a stale or cold cache in the background (and that
  // refresh upserts). Removing that on the admin path needs a read-only cache accessor in
  // server/src/services/modelCatalog.ts, which DreamStream owns.
  it.todo('admin on a cold or stale cache: no background refresh or upsert (needs DS: read-only catalog accessor)');
});
