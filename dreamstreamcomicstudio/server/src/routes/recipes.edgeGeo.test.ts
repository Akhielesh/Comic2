// @vitest-environment node
// A recipe run from Chat (POST /api/recipes/run) gets the same approximate place as a chat turn: the API Worker
// writes X-DS-Geo for this route too (api-proxy/src/geoHeader.ts), prepareChat reads it through the chat route's
// caps, and runRecipe receives it in the request's clientContext, which becomes its tools' context (weather, maps
// and places). A browser location still wins; without either there is none, and the IP alone never gives one.
// No database, provider, model or network.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'net';
import type { Server } from 'http';

vi.mock('../services/supabase.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/supabase.js')>()),
  getSupabaseAdmin: () => {
    throw new Error('no database in tests');
  }
}));
vi.mock('../services/mcpRegistry.js', () => ({ enabledMcpConfigs: async () => [] }));
vi.mock('../ai/tools/mcpClient.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../ai/tools/mcpClient.js')>()),
  buildMcpTools: async () => []
}));
vi.mock('../services/customAgents.js', () => ({ loadCustomAgentDefinitions: async () => [] }));
vi.mock('../services/modelStats.js', () => ({ recordModelUsage: () => undefined }));
vi.mock('../services/modelAccessPolicy.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/modelAccessPolicy.js')>()),
  assertModelAllowedForUser: async () => ({})
}));
vi.mock('../connectors/store.js', () => ({ listConnections: async () => [] }));

vi.mock('../services/modelCatalog.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/modelCatalog.js')>();
  const entry = (id: string, out: string[], promptPerToken = 0, completionPerToken = 0) => ({
    id,
    name: id,
    supportsImageOutput: out.includes('image'),
    outputModalities: out,
    inputModalities: ['text'],
    supportedParameters: out.includes('text') ? ['tools', 'temperature'] : [],
    costClass: promptPerToken ? 'paid' : 'free_verified',
    pricing: { promptPerToken, completionPerToken, imagePerImage: 0, requestFlat: 0 }
  });
  return {
    ...actual,
    getCatalog: async () => ({
      models: [entry('vendor/expensive', ['text'], 0.000015, 0.000075), entry('vendor/image-only', ['image'])],
      fetchedAt: Date.now(),
      degraded: false
    })
  };
});

const enforcer = vi.hoisted(() => ({ reserve: vi.fn(), settle: vi.fn(), release: vi.fn() }));
vi.mock('../services/usageEnforcer.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/usageEnforcer.js')>()),
  reserveForOperation: enforcer.reserve,
  settleReservedOperation: enforcer.settle,
  releaseReservedOperation: enforcer.release,
  attachBillingToPayload: (payload: unknown) => payload
}));

const runner = vi.hoisted(() => ({ runRecipe: vi.fn() }));
vi.mock('../ai/recipes/runRecipe.js', () => ({ runRecipe: runner.runRecipe }));

vi.mock('../services/recipes.js', () => ({
  listRecipes: async () => [],
  getRecipe: async () => null,
  saveRecipe: async () => null,
  deleteRecipe: async () => false
}));

const { recipesRouter } = await import('./recipes.js');
const { errorHandler } = await import('../middleware/errors.js');

const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  const r = req as unknown as Record<string, unknown>;
  r.user = { id: 'user-1', email: 'tester@example.com' };
  r.apiKeys = { providerKeys: { openrouter: { key: 'sk-platform', byok: false } } };
  next();
});
app.use('/api/recipes', recipesRouter);
app.use(errorHandler);

let server: Server;
let base = '';
beforeAll(async () => {
  server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

beforeEach(() => {
  enforcer.reserve.mockReset().mockImplementation(async (input: { fallbackModel: string }) => ({
    allowed: true,
    reservation: { reservationId: 'r1', byokBypass: false, estimated: {}, usage: {} },
    seed: {},
    provider: 'openrouter',
    model: input.fallbackModel
  }));
  enforcer.settle.mockReset().mockResolvedValue(null);
  enforcer.release.mockReset().mockResolvedValue(undefined);
  runner.runRecipe.mockReset().mockImplementation(async (input: { model: string }) => ({
    text: 'Recipe done.',
    model: input.model,
    artifacts: [],
    activities: [],
    usage: { promptTokens: 10, candidatesTokens: 10, totalTokens: 20, providerCostUsd: 0.01 }
  }));
});

const encode = (value: unknown) => encodeURIComponent(JSON.stringify(value));
const EDGE_PLACE = { city: 'Riverton', region: 'North Province', country: 'NZ', lat: -41.29, lng: 174.78 };
const recipe = { title: 'Live Monitor', prompt: 'Weather here, and what is open near me.' };

/** The location runRecipe was handed for one run. */
const locationFor = async (headers: Record<string, string>, extra: Record<string, unknown> = {}) => {
  const res = await fetch(`${base}/api/recipes/run`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify({ recipe, model: 'vendor/expensive', messages: [{ role: 'user', content: 'go' }], ...extra })
  });
  expect(res.status).toBe(200);
  await res.text();
  expect(runner.runRecipe).toHaveBeenCalledTimes(1);
  return runner.runRecipe.mock.calls[0][0].clientContext?.location;
};

describe('POST /api/recipes/run — the approximate place reaches the run', () => {
  it('the X-DS-Geo place becomes the run’s location, marked approximate', async () => {
    expect(await locationFor({ 'x-ds-geo': encode(EDGE_PLACE) })).toEqual({ ...EDGE_PLACE, approximate: true });
  });

  it('a browser location wins over the edge place', async () => {
    const browser = { city: 'Harbourside', country: 'AU' };
    expect(await locationFor({ 'x-ds-geo': encode(EDGE_PLACE) }, { clientContext: { location: browser } })).toEqual({ ...browser, approximate: true });
  });

  it('without either there is no location, and the IP alone never gives one', async () => {
    expect(await locationFor({ 'cf-connecting-ip': '203.0.113.9', 'x-forwarded-for': '203.0.113.9' })).toBeUndefined();
  });
});
