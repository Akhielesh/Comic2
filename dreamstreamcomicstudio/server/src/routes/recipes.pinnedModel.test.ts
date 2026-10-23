// @vitest-environment node
// Gate S11: a recipe can pin its own model (settings.model — inline, saved, or distilled). The
// route used to check and price only the request's model (body.model / the Auto chain) while
// runRecipe ran the recipe's pin — an unchecked, unpriced model. Now the pin becomes the requested
// model BEFORE prepareChat, so it gets the chat-capability check, the plan policy, the
// [pin, paid net] chain and a hold priced at it (including its live catalog price); runRecipe runs
// exactly p.model. No database, provider or network.
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
vi.mock('../ai/clientGeo.js', () => ({ resolveClientGeo: async () => null, clientIpFromReq: () => undefined }));
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

const saved = vi.hoisted(() => ({
  recipe: { version: '1.0.0', id: 'my-pinned', title: 'Pinned', description: 'x', prompt: 'go', settings: { model: 'vendor/expensive' } }
}));
vi.mock('../services/recipes.js', () => ({
  listRecipes: async () => [],
  getRecipe: async (_user: string, id: string) => (id === saved.recipe.id ? saved.recipe : null),
  saveRecipe: async () => null,
  deleteRecipe: async () => false
}));

const { recipesRouter } = await import('./recipes.js');
const { errorHandler } = await import('../middleware/errors.js');
const { TEXT_FALLBACK } = await import('../ai/autoRouter.js');

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

const run = async (body: unknown) => {
  const res = await fetch(`${base}/api/recipes/run`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const text = await res.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { status: res.status, text, json };
};

const metaModel = (text: string) => {
  const block = text.split('\n\n').find((b) => b.startsWith('event: meta'));
  return block ? JSON.parse(/^data: (.+)$/m.exec(block)![1]).model : undefined;
};

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

const messages = [{ role: 'user', content: 'go' }];

describe('POST /api/recipes/run — a recipe’s pinned model is resolved, checked and priced', () => {
  // The picker's own model (body.model) is a cheap `:free` one in these cases: the hold used to be
  // priced at it while the run used the recipe's pin.
  const picker = 'z-ai/glm-4.5-air:free';

  it('inline pin: the hold prices the pin (at its live catalog price) and the run uses exactly it', async () => {
    const r = await run({ recipe: { title: 'x', prompt: 'go', settings: { model: 'vendor/expensive' } }, model: picker, messages });
    expect(r.status).toBe(200);
    const input = enforcer.reserve.mock.calls[0][0];
    expect(input.fallbackModel).toBe('vendor/expensive');
    expect(input.pricedModels).toEqual(expect.arrayContaining(['vendor/expensive', TEXT_FALLBACK]));
    // 3,072 answer tokens at $75/M alone is ≈ $0.23.
    expect(input.estimateFloorUsd).toBeGreaterThan(0.2);
    expect(runner.runRecipe.mock.calls[0][0].model).toBe('vendor/expensive');
    expect(metaModel(r.text)).toBe('vendor/expensive');
  });

  it('a saved recipe (recipeId) with a pin gets the same treatment', async () => {
    const r = await run({ recipeId: 'my-pinned', model: picker, messages });
    expect(r.status).toBe(200);
    expect(enforcer.reserve.mock.calls[0][0].fallbackModel).toBe('vendor/expensive');
    expect(runner.runRecipe.mock.calls[0][0].model).toBe('vendor/expensive');
  });

  it('a pin that can’t hold a conversation is refused before anything is reserved or run', async () => {
    const r = await run({ recipe: { title: 'x', prompt: 'go', settings: { model: 'vendor/image-only' } }, model: picker, messages });
    expect(r.status).toBe(400);
    expect(r.json.error.code).toBe('MODEL_NOT_CHAT_CAPABLE');
    expect(enforcer.reserve).not.toHaveBeenCalled();
    expect(runner.runRecipe).not.toHaveBeenCalled();
  });

  it('review: a VARIANT pin (`:floor`, `:nitro`) is checked and priced as its base model', async () => {
    const r = await run({ recipe: { title: 'x', prompt: 'go', settings: { model: 'vendor/expensive:floor' } }, model: picker, messages });
    expect(r.status).toBe(200);
    expect(enforcer.reserve.mock.calls[0][0].estimateFloorUsd).toBeGreaterThan(0.2);
    expect(runner.runRecipe.mock.calls[0][0].model).toBe('vendor/expensive:floor');

    enforcer.reserve.mockClear();
    runner.runRecipe.mockClear();
    const media = await run({ recipe: { title: 'x', prompt: 'go', settings: { model: 'vendor/image-only:nitro' } }, model: picker, messages });
    expect(media.status).toBe(400);
    expect(media.json.error.code).toBe('MODEL_NOT_CHAT_CAPABLE');
    expect(enforcer.reserve).not.toHaveBeenCalled();
    expect(runner.runRecipe).not.toHaveBeenCalled();
  });

  it('no pin: unchanged — the request’s model and its paid net are priced and run', async () => {
    const r = await run({ recipe: { title: 'x', prompt: 'go' }, model: picker, messages });
    expect(r.status).toBe(200);
    const input = enforcer.reserve.mock.calls[0][0];
    expect(input.fallbackModel).toBe(picker);
    expect(input.pricedModels).toEqual([picker, TEXT_FALLBACK]);
    expect(runner.runRecipe.mock.calls[0][0].model).toBe(picker);
  });

  it('settles on the usage the run reports (S9)', async () => {
    await run({ recipe: { title: 'x', prompt: 'go' }, messages });
    expect(enforcer.settle.mock.calls[0][0].usage).toMatchObject({ providerCostUsd: 0.01 });
  });
});
