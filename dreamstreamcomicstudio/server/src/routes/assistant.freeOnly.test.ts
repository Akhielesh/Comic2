// @vitest-environment node
// Gate S10: the Universal Assistant on the PLATFORM key runs free models only. It used to send
// every call with the paid TEXT_FALLBACK retry (and, with no free model in the catalog or the
// catalog down, picked a paid model outright) while holding and settling $0 against the `:free`
// pick — unmetered platform spend for guests and exhausted governed users alike. Now a free-model
// miss is a calm "busy, nothing was spent" 503 and no paid model is ever fetched; the user's own
// key (BYOK) keeps the paid safety net unless they turned Free-only on. The real provider runs
// against a stubbed fetch — nothing leaves the machine.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'net';
import type { Server } from 'http';

vi.mock('../services/supabase.js', () => {
  const chain = { select: () => chain, eq: () => chain, maybeSingle: async () => ({ data: null }) };
  return {
    supabase: { from: () => chain },
    getSupabaseAdmin: () => {
      throw new Error('no database in tests');
    }
  };
});
vi.mock('../services/billingLedger.js', () => ({ getBillingSummary: vi.fn(async () => Promise.reject(new Error('no ledger'))) }));
vi.mock('../services/modelStats.js', () => ({ loadScoreMap: async () => new Map(), recordModelUsage: () => undefined }));
vi.mock('../services/telemetryAnalytics.js', () => ({ getModelLatency: async () => ({}) }));

const catalog = vi.hoisted(() => ({ mode: 'free' as 'free' | 'paid' | 'down' }));
vi.mock('../services/modelCatalog.js', () => {
  const model = (id: string, free: boolean) => ({
    id,
    name: id,
    supportsImageOutput: false,
    outputModalities: ['text'],
    inputModalities: ['text'],
    supportedParameters: ['temperature'],
    costClass: free ? 'free_verified' : 'paid',
    pricing: { promptPerToken: free ? 0 : 0.000001, completionPerToken: free ? 0 : 0.000002, imagePerImage: 0, requestFlat: 0 }
  });
  return {
    getCatalog: async () => {
      if (catalog.mode === 'down') throw new Error('catalog unavailable');
      return {
        models: catalog.mode === 'free' ? [model('acme/model:free', true), model('acme/cheap', false)] : [model('acme/cheap', false)],
        fetchedAt: Date.now(),
        degraded: false
      };
    }
  };
});

const meter = vi.hoisted(() => ({ reserve: vi.fn(), settle: vi.fn(), release: vi.fn() }));
vi.mock('../services/usageEnforcer.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/usageEnforcer.js')>()),
  reserveForOperation: meter.reserve,
  settleReservedOperation: meter.settle,
  releaseReservedOperation: meter.release,
  attachBillingToPayload: (payload: unknown) => payload
}));

// OpenRouter over a stubbed fetch: a `:free` model is "busy" (404 No endpoints, unless
// `freeAnswers`), any other model answers and costs money. Calls to the test server pass through.
const upstream = vi.hoisted(() => ({ models: [] as string[], keys: [] as string[], freeAnswers: false }));
const realFetch = globalThis.fetch;
vi.stubGlobal('fetch', async (url: string | URL, init?: RequestInit) => {
  const href = String(url);
  if (href.startsWith('http://127.0.0.1')) return realFetch(url, init);
  const body = JSON.parse(String(init?.body || '{}'));
  upstream.models.push(body.model);
  upstream.keys.push(String((init?.headers as Record<string, string>)?.Authorization || ''));
  if (/:free$/.test(body.model) && !upstream.freeAnswers) {
    return new Response(`{"error":{"message":"No endpoints found for ${body.model}."}}`, { status: 404, statusText: 'Not Found' });
  }
  return new Response(
    JSON.stringify({ model: body.model, choices: [{ message: { content: '**Summary:** Use Export → PDF.' } }], usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20, cost: 0.001 } }),
    { status: 200, headers: { 'content-type': 'application/json' } }
  );
});

const { assistantRouter } = await import('./assistant.js');
const { errorHandler } = await import('../middleware/errors.js');
const { TEXT_FALLBACK } = await import('../ai/autoRouter.js');

const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  const r = req as unknown as Record<string, unknown>;
  const user = req.header('x-test-user');
  if (user) r.user = { id: user, email: 'tester@example.com' };
  const byok = req.header('x-test-byok') === '1';
  const key = byok ? 'sk-mine' : 'sk-platform';
  r.apiKeys = { openRouterKey: key, openRouterByok: byok, providerKeys: { openrouter: { key, byok } } };
  r.freeOnly = req.header('x-test-free-only') === '1';
  next();
});
app.use('/api/assistant', assistantRouter);
app.use(errorHandler);

let server: Server;
let base = '';
beforeAll(async () => {
  server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

const ask = async (headers: Record<string, string> = {}) => {
  const res = await fetch(`${base}/api/assistant/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify({ message: 'How do I export my comic as a PDF in DreamStream Comic Studio?' })
  });
  const text = await res.text();
  return { status: res.status, text, json: JSON.parse(text) };
};

const paidFetches = () => upstream.models.filter((m) => !/:free$/.test(m));

beforeEach(() => {
  catalog.mode = 'free';
  upstream.models = [];
  upstream.keys = [];
  upstream.freeAnswers = false;
  meter.reserve.mockReset().mockImplementation(async (input: { fallbackModel: string }) => ({
    allowed: true,
    reservation: { reservationId: 'r1', byokBypass: false, estimated: {}, usage: {}, governed: true },
    seed: { provider: 'openrouter', model: input.fallbackModel, operation: 'assistant.chat' },
    provider: 'openrouter',
    model: input.fallbackModel
  }));
  meter.settle.mockReset().mockResolvedValue(null);
  meter.release.mockReset().mockResolvedValue(undefined);
});

describe('assistant on the platform key: free models only, never a paid fetch', () => {
  it('signed-in (governed) user, free model busy: calm 503, nothing paid, hold released', async () => {
    const r = await ask({ 'x-test-user': 'user-1' });
    expect(paidFetches()).toEqual([]);
    expect(upstream.models).not.toContain(TEXT_FALLBACK);
    expect(r.status).toBe(503);
    expect(r.json.error.code).toBe('ASSISTANT_BUSY');
    expect(r.json.error.message).toMatch(/Nothing was spent/);
    expect(r.text).not.toMatch(/OpenRouter|404|No endpoints/);
    expect(meter.release).toHaveBeenCalledTimes(1);
    expect(meter.settle).not.toHaveBeenCalled();
  });

  it('guest, free model busy: no paid fetch, calm 503', async () => {
    const r = await ask();
    expect(paidFetches()).toEqual([]);
    expect(r.status).toBe(503);
    expect(meter.reserve).not.toHaveBeenCalled();
  });

  it('no free model in the catalog: never picks the cheapest paid model — zero fetches, 503', async () => {
    catalog.mode = 'paid';
    const r = await ask({ 'x-test-user': 'user-1' });
    expect(upstream.models).toEqual([]);
    expect(r.status).toBe(503);
    expect(r.json.error.code).toBe('ASSISTANT_BUSY');
  });

  it('catalog down: never falls to the paid TEXT_FALLBACK — zero fetches, 503', async () => {
    catalog.mode = 'down';
    const r = await ask();
    expect(upstream.models).toEqual([]);
    expect(r.status).toBe(503);
  });

  it('own key with Free-only on: no paid retry either', async () => {
    const r = await ask({ 'x-test-user': 'user-1', 'x-test-byok': '1', 'x-test-free-only': '1' });
    expect(paidFetches()).toEqual([]);
    expect(r.status).toBe(503);
  });

  it('the assistant mount has its own per-user/IP rate limit', () => {
    const index = readFileSync(fileURLToPath(new URL('../index.ts', import.meta.url)), 'utf8');
    expect(index).toMatch(/app\.use\('\/api\/assistant', optionalAuth, createRateLimit\(\{ scope: 'assistant', windowMs: 60_000, maxRequests: 20 \}\), assistantLimits, assistantRouter\);/);
  });
});

describe('unchanged paths', () => {
  it('own key (BYOK), Free-only off: the paid safety net still answers, on the user’s key', async () => {
    const r = await ask({ 'x-test-user': 'user-1', 'x-test-byok': '1' });
    expect(r.status).toBe(200);
    expect(upstream.models).toEqual(['acme/model:free', TEXT_FALLBACK]);
    expect(upstream.keys.every((k) => k.includes('sk-mine'))).toBe(true);
  });

  it('platform key, free model answers: 200, settled at the :free pick', async () => {
    upstream.freeAnswers = true;
    const r = await ask({ 'x-test-user': 'user-1' });
    expect(r.status).toBe(200);
    expect(r.json.text).toContain('Export');
    expect(upstream.models).toEqual(['acme/model:free']);
    expect(meter.settle).toHaveBeenCalledTimes(1);
    expect(meter.settle.mock.calls[0][0].seed.model).toBe('acme/model:free');
    expect(JSON.stringify(r.json.usage || {})).not.toMatch(/providerCostUsd/);
  });
});
