// @vitest-environment node
// /api/text/* metering around the provider call. The provider call IS the spend: when it fails the
// hold is released (nothing was spent); once it succeeded the spend is real and is SETTLED — and a
// settle that throws (a ledger hiccup after the provider was paid) must NEVER release the hold,
// because releasing flips the RESERVED cost event to RELEASED and the real platform spend stops
// counting against the governed user's usage (routes/chat.ts and routes/image.ts guard exactly
// this). Every handler used to wrap provider call and settle in one try whose catch released.
// No provider, database or network is reached: the text engine and the enforcer are mocked.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'net';
import type { Server } from 'http';

const RESULT = { title: 'A story', usage: { promptTokens: 10, candidatesTokens: 10, totalTokens: 20, providerCostUsd: 0.004 } };
const textEngine = vi.hoisted(() => {
  const fns = {
    analyzeScript: vi.fn(),
    generateStoryOutline: vi.fn(),
    generateStoryDraft: vi.fn(),
    runStoryToolPrompt: vi.fn(),
    extractWorldDetails: vi.fn(),
    generatePanelBreakdown: vi.fn(),
    updateContinuitySummary: vi.fn(),
    continuityAudit: vi.fn()
  };
  return fns;
});
vi.mock('../ai/text.js', () => textEngine);
const openrouter = vi.hoisted(() => ({ generateText: vi.fn() }));
vi.mock('../ai/gateway.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../ai/gateway.js')>()),
  getProvider: () => openrouter,
  resolveProviderContext: () => ({})
}));
vi.mock('../ai/stageModels.js', () => ({ resolveStageModel: async () => ({ model: 'openai/gpt-4o-mini' }) }));
vi.mock('../services/modelAccessPolicy.js', () => ({ assertModelAllowedForUser: async () => ({}) }));

const billing = vi.hoisted(() => ({ settle: vi.fn(), release: vi.fn(), settleThrows: false }));
vi.mock('../services/usageEnforcer.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/usageEnforcer.js')>()),
  reserveForOperation: async (input: { req: Record<string, unknown>; provider: string; fallbackModel: string }) => {
    const reservation = { reservationId: 'res-1', byokBypass: false, governed: true, walletSkipped: true, estimated: { estimatedProviderCostUsd: 0.01 }, usage: {} };
    input.req.usageReservation = reservation;
    return { allowed: true, reservation, seed: {}, provider: input.provider, model: input.fallbackModel };
  },
  settleReservedOperation: async (...args: unknown[]) => {
    billing.settle(...args);
    if (billing.settleThrows) throw new Error('ledger write failed after the provider call');
    return { actualCt: 52, billableUsd: 0.0052, providerCostUsd: 0.004, reservationReleased: true };
  },
  releaseReservedOperation: async (...args: unknown[]) => {
    billing.release(...args);
  }
}));

const { textRouter } = await import('./text.js');
const { errorHandler } = await import('../middleware/errors.js');

const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  const r = req as unknown as Record<string, unknown>;
  r.user = { id: 'tester-1', email: 'tester@example.com' };
  r.apiKeys = { openRouterKey: 'sk-platform', openRouterByok: false, providerKeys: { openrouter: { key: 'sk-platform', byok: false } } };
  next();
});
app.use('/api/text', textRouter);
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
  billing.settle.mockClear();
  billing.release.mockClear();
  billing.settleThrows = false;
  for (const fn of Object.values(textEngine)) fn.mockReset().mockResolvedValue(RESULT);
  openrouter.generateText.mockReset().mockResolvedValue({ text: 'ok', json: null, model: 'openai/gpt-4o-mini', usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2, costUsd: 0.004 } });
});

const post = async (path: string, body: Record<string, unknown>) => {
  const res = await fetch(`${base}/api/text${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
};

/** Every /api/text route that reserves, calls a provider and settles — with the engine call it makes. */
const ROUTES: [string, Record<string, unknown>, () => ReturnType<typeof vi.fn>][] = [
  ['/analyze-script', { script: 'INT. KITCHEN — DAY. MAYA pours tea.' }, () => textEngine.analyzeScript],
  ['/story-outline', { premise: 'a hero' }, () => textEngine.generateStoryOutline],
  ['/story-draft', { outline: 'a hero' }, () => textEngine.generateStoryDraft],
  ['/story-tool', { script: 'Scene 1.', instruction: 'Tighten it.' }, () => textEngine.runStoryToolPrompt],
  ['/extract-world', { scenes: [{ id: 1, rawText: 'Scene 1', synopsis: 's', characters: [], setting: 'roof' }], script: 'Scene 1' }, () => textEngine.extractWorldDetails],
  ['/panel-breakdown', { scene: { id: 1, rawText: 'Scene 1' } }, () => textEngine.generatePanelBreakdown],
  ['/continuity-audit', { panels: [{ id: 'p1' }] }, () => textEngine.continuityAudit],
  ['/continuity-summary', { scene: { id: 1 }, panels: [] }, () => textEngine.updateContinuitySummary],
  ['/generate', { prompt: 'hello', model: 'openai/gpt-4o-mini' }, () => openrouter.generateText]
];

describe('/api/text/*: the provider was paid, then the settle throws', () => {
  it.each(ROUTES)('%s: the hold is never released, and the user still gets the result', async (path, body) => {
    billing.settleThrows = true;
    const r = await post(path, body);
    // Without the fix: settle once, release once ('ledger write failed after the provider call'), 500.
    expect(billing.settle).toHaveBeenCalledTimes(1);
    expect(billing.release).not.toHaveBeenCalled();
    expect(r.status).toBe(200);
    expect(r.json).toHaveProperty('usage');
  });
});

describe('/api/text/*: the provider call fails', () => {
  it.each(ROUTES)('%s: the hold is released (nothing was spent) and nothing is settled', async (path, body, engine) => {
    engine().mockRejectedValue(new Error('provider down'));
    const r = await post(path, body);
    expect(r.status).toBe(500);
    expect(billing.settle).not.toHaveBeenCalled();
    expect(billing.release).toHaveBeenCalledTimes(1);
    expect((billing.release.mock.calls[0][0] as { reason: string }).reason).toBe('provider down');
  });
});

describe('/api/text/*: the happy path', () => {
  it.each(ROUTES)('%s: settles once, never releases, and answers with the billing block', async (path, body) => {
    const r = await post(path, body);
    expect(r.status).toBe(200);
    expect(billing.settle).toHaveBeenCalledTimes(1);
    expect(billing.release).not.toHaveBeenCalled();
    expect(r.json).toHaveProperty('billing');
  });
});
