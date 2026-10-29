// @vitest-environment node
// Probe: /api/text/* (legacy pipeline routes). The provider call succeeds (money spent), then the
// settle throws (ledger hiccup). routes/text.ts has no "settle started" guard (routes/chat.ts does:
// "once the settle has started, the catch below never releases … a release would erase real spend"),
// so its catch RELEASES the hold — the RESERVED row flips to RELEASED and the real platform spend
// stops counting against the governed user's usage. Expected: the hold is never released after
// the provider was paid (chat.ts contract); observed: releaseReservedOperation is called.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'net';
import type { Server } from 'http';

const billing = vi.hoisted(() => ({ settle: vi.fn(), release: vi.fn() }));
vi.mock('../../server/src/services/usageEnforcer.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../server/src/services/usageEnforcer.js')>()),
  reserveForOperation: async (input: { req: Record<string, unknown> }) => {
    const reservation = { reservationId: 'res-1', byokBypass: false, governed: true, walletSkipped: true, estimated: { estimatedProviderCostUsd: 0.01 }, usage: {} };
    input.req.usageReservation = reservation;
    return { allowed: true, reservation, seed: {}, provider: 'openrouter', model: 'x' };
  },
  settleReservedOperation: async (...args: unknown[]) => {
    billing.settle(...args);
    throw new Error('ledger write failed after the provider call');
  },
  releaseReservedOperation: async (...args: unknown[]) => {
    billing.release(...args);
  }
}));
vi.mock('../../server/src/ai/text.js', () => ({
  analyzeScript: async () => ({ title: 'A story', usage: { promptTokens: 10, candidatesTokens: 10, totalTokens: 20, providerCostUsd: 0.004 } }),
  generateStoryOutline: vi.fn(),
  generateStoryDraft: vi.fn(),
  runStoryToolPrompt: vi.fn(),
  extractWorldDetails: vi.fn(),
  generatePanelBreakdown: vi.fn(),
  updateContinuitySummary: vi.fn(),
  continuityAudit: vi.fn()
}));
vi.mock('../../server/src/ai/stageModels.js', () => ({ resolveStageModel: async () => ({ model: 'openai/gpt-4o-mini' }) }));
vi.mock('../../server/src/services/modelAccessPolicy.js', () => ({ assertModelAllowedForUser: async () => ({}) }));

const { textRouter } = await import('../../server/src/routes/text.js');
const { errorHandler } = await import('../../server/src/middleware/errors.js');

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

describe('/api/text/analyze-script: provider paid, settle fails', () => {
  it('does not release the hold once the provider has been paid', async () => {
    const res = await fetch(`${base}/api/text/analyze-script`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ script: 'INT. KITCHEN — DAY. MAYA pours tea.' })
    });
    const body = await res.text();
    process.stderr.write(`probe3 ${JSON.stringify({ status: res.status, body: body.slice(0, 200), settleCalls: billing.settle.mock.calls.length, releaseCalls: billing.release.mock.calls.length, releaseReason: (billing.release.mock.calls[0]?.[0] as { reason?: string } | undefined)?.reason })}\n`);
    expect(billing.settle).toHaveBeenCalledTimes(1);
    expect(billing.release).not.toHaveBeenCalled();
  });
});
