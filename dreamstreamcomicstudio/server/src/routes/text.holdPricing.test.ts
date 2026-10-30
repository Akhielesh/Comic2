// @vitest-environment node
// Gate follow-up (F1 S10 sibling): the /api/text/* pipeline routes run through ai/client.ts, whose
// gateway text client ALWAYS sends a provider-level retry model — TEXT_FALLBACK (paid) on an
// OpenRouter key, NVIDIA_TEXT_MODEL on an NVIDIA key. The hold used to price only the primary, so a
// `:free` primary reserved $0 and a busy free model fell through to the paid retry unreserved (an
// exhausted governed user passed the usage gate). Every pipeline hold now prices the whole chain.
// No provider, database or network is reached: the text engine and the enforcer are mocked.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'net';
import type { Server } from 'http';

const textEngine = vi.hoisted(() => {
  const result = async () => ({ usage: { promptTokens: 10, candidatesTokens: 10, totalTokens: 20 } });
  return {
    analyzeScript: vi.fn(result),
    generateStoryOutline: vi.fn(result),
    generateStoryDraft: vi.fn(result),
    runStoryToolPrompt: vi.fn(result),
    extractWorldDetails: vi.fn(result),
    generatePanelBreakdown: vi.fn(result),
    updateContinuitySummary: vi.fn(result),
    continuityAudit: vi.fn(result)
  };
});
vi.mock('../ai/text.js', () => textEngine);

const FREE = 'meta-llama/llama-3.3-70b-instruct:free';
vi.mock('../ai/stageModels.js', () => ({
  resolveStageModel: vi.fn(async (_stage: string, requested?: string) => ({ model: requested || FREE }))
}));
vi.mock('../services/modelAccessPolicy.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/modelAccessPolicy.js')>()),
  assertModelAllowedForUser: vi.fn(async (input: { requestedModel: string }) => ({ effectiveModel: input.requestedModel }))
}));
const openrouter = vi.hoisted(() => ({
  generateText: vi.fn(async (req: { model: string }) => ({ text: 'ok', model: req.model, usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2, costUsd: 0 } }))
}));
vi.mock('../ai/gateway.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../ai/gateway.js')>()),
  getProvider: () => openrouter,
  resolveProviderContext: () => ({})
}));

type ReserveInput = { operation: string; fallbackModel: string; provider?: string; pricedModels?: string[] };
const meter = vi.hoisted(() => ({
  reserves: [] as ReserveInput[],
  refuse: false
}));
vi.mock('../services/usageEnforcer.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/usageEnforcer.js')>();
  return {
    ...actual,
    reserveForOperation: vi.fn(async (input: ReserveInput) => {
      meter.reserves.push(input);
      if (meter.refuse) {
        return { allowed: false, details: { reason: 'usage_budget_exhausted', message: 'You have used all of your usage.' } };
      }
      return {
        allowed: true,
        reservation: { reservationId: 'res-1', byokBypass: false, governed: true, walletSkipped: true, estimated: {}, usage: {} },
        seed: {},
        provider: input.provider,
        model: input.fallbackModel
      };
    }),
    settleReservedOperation: vi.fn(async () => null),
    releaseReservedOperation: vi.fn(async () => undefined),
    attachBillingToPayload: (payload: Record<string, unknown>) => payload,
    formatLimitErrorResponse: (details: unknown) => details
  };
});

const { textRouter, textPricedModels } = await import('./text.js');
const { TEXT_FALLBACK } = await import('../ai/autoRouter.js');
const { NVIDIA_TEXT_MODEL } = await import('../config.js');

const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  const r = req as unknown as Record<string, unknown>;
  r.user = { id: 'tester-1', email: 'tester@example.com' };
  const key = req.header('x-test-key') || 'openrouter';
  r.apiKeys =
    key === 'nvidia'
      ? { nvidiaKey: 'nvapi-platform' }
      : key === 'gemini'
        ? { geminiKey: 'gemini-platform' }
        : { openRouterKey: 'sk-or-platform' };
  next();
});
app.use('/api/text', textRouter);

let server: Server;
let base = '';
beforeAll(async () => {
  server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

beforeEach(() => {
  meter.reserves = [];
  meter.refuse = false;
  for (const fn of Object.values(textEngine)) fn.mockClear();
  openrouter.generateText.mockClear();
});

const post = (path: string, body: Record<string, unknown>, headers: Record<string, string> = {}) =>
  fetch(`${base}/api/text${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body)
  });

// Every pipeline route (each runs through ai/client.ts) with a body it accepts.
const PIPELINE_ROUTES: [string, Record<string, unknown>][] = [
  ['/analyze-script', { script: 'Scene 1: a hero on a rooftop.' }],
  ['/story-outline', { premise: 'a hero' }],
  ['/story-draft', { outline: 'a hero' }],
  ['/story-tool', { script: 'Scene 1.', instruction: 'Tighten it.' }],
  ['/extract-world', { scenes: [{ id: 1, rawText: 'Scene 1', synopsis: 's', characters: [], setting: 'roof' }], script: 'Scene 1' }],
  ['/panel-breakdown', { scene: { id: 1, rawText: 'Scene 1' } }],
  ['/continuity-audit', { panels: [{ id: 'p1' }] }],
  ['/continuity-summary', { scene: { id: 1 }, panels: [] }]
];

describe('/api/text pipeline holds price the provider-level retry model', () => {
  it.each(PIPELINE_ROUTES)('OpenRouter key, %s: a :free primary is held together with the paid TEXT_FALLBACK retry', async (path, body) => {
    const res = await post(path, body);
    expect(res.status).toBe(200);
    expect(meter.reserves).toHaveLength(1);
    expect(meter.reserves[0].fallbackModel).toBe(FREE);
    expect(meter.reserves[0].pricedModels).toEqual([FREE, TEXT_FALLBACK]);
  });

  it.each(PIPELINE_ROUTES)('NVIDIA key, %s: the NVIDIA retry model is priced too', async (path, body) => {
    const res = await post(path, body, { 'x-test-key': 'nvidia', 'X-Text-Model': 'acme/tiny-instruct' });
    expect(res.status).toBe(200);
    expect(meter.reserves[0].pricedModels).toEqual(['acme/tiny-instruct', NVIDIA_TEXT_MODEL]);
  });

  it('Gemini SDK path (no retry model): nothing extra is priced', async () => {
    const res = await post('/analyze-script', { script: 'Scene 1.' }, { 'x-test-key': 'gemini' });
    expect(res.status).toBe(200);
    expect(meter.reserves[0].pricedModels).toBeUndefined();
  });

  it('a refused hold (exhausted usage) answers 402 before the text engine runs — nothing spent', async () => {
    meter.refuse = true;
    const res = await post('/analyze-script', { script: 'Scene 1.' });
    expect(res.status).toBe(402);
    expect(textEngine.analyzeScript).not.toHaveBeenCalled();
  });

  it('/generate sends no retry model, so its hold stays on the model it calls', async () => {
    const res = await post('/generate', { prompt: 'hello', model: FREE });
    expect(res.status).toBe(200);
    expect(meter.reserves[0].pricedModels).toBeUndefined();
    expect(openrouter.generateText.mock.calls[0][0]).not.toHaveProperty('fallbackModel');
  });
});

describe('textPricedModels', () => {
  it('OpenRouter: primary + TEXT_FALLBACK, de-duplicated', () => {
    expect(textPricedModels('openrouter', FREE)).toEqual([FREE, TEXT_FALLBACK]);
    expect(textPricedModels('openrouter', TEXT_FALLBACK)).toEqual([TEXT_FALLBACK]);
  });

  it('NVIDIA: primary + NVIDIA_TEXT_MODEL; Gemini: none', () => {
    expect(textPricedModels('nvidia', 'a/b')).toEqual(['a/b', NVIDIA_TEXT_MODEL]);
    expect(textPricedModels('gemini', 'gemini-2.5-flash')).toBeUndefined();
  });
});
