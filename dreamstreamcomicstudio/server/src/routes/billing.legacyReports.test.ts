// @vitest-environment node
// P2-PLATFORM: the legacy spend reports (GET /api/billing/comic-cost/:comicId and
// /usage-history) never show governed users dollars. Admins, exempt accounts and a deployment
// with metering off keep the full dollar report (same shape as before).
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'net';
import type { Server } from 'http';
import type { ComicCostReport } from '../../../shared/types/billing.js';

const REPORT: ComicCostReport = {
  comicId: 'comic-1',
  totalEstimatedCt: 900,
  totalActualCt: 800,
  totalBillableUsd: 0.13,
  totalProviderCostUsd: 0.1,
  byStage: { generation: { ct: 700, usd: 0.117 }, planning: { ct: 100, usd: 0.013 } },
  byModel: { 'gemini-nano-banana-2.1': { ct: 800, usd: 0.13 } },
  events: [
    { id: 'e1', createdAt: '2026-10-20T10:00:00Z', operation: 'image.gemini.generate', stage: 'generation', provider: 'gemini', model: 'gemini-nano-banana-2.1', estimatedCt: 600, actualCt: 600, billableUsd: 0.104, providerCostUsd: 0.08, isByok: false, status: 'SETTLED' },
    { id: 'e2', createdAt: '2026-10-20T10:01:00Z', operation: 'text.plan', stage: 'planning', provider: 'openrouter', model: 'gemini-nano-banana-2.1', estimatedCt: 200, actualCt: 200, billableUsd: 0.026, providerCostUsd: 0.02, isByok: false, status: 'SETTLED' },
    // Released hold and an own-key call: neither counts against usage.
    { id: 'e3', createdAt: '2026-10-20T10:02:00Z', operation: 'image.gemini.generate', stage: 'generation', provider: 'gemini', model: 'gemini-nano-banana-2.1', estimatedCt: 600, actualCt: 0, billableUsd: 0, providerCostUsd: 0.5, isByok: false, status: 'RELEASED' },
    { id: 'e4', createdAt: '2026-10-20T10:03:00Z', operation: 'image.openrouter.generate', stage: 'generation', provider: 'openrouter', model: 'google/gemini-3-pro-image', estimatedCt: 0, actualCt: 0, billableUsd: 0.2, providerCostUsd: 0.2, isByok: true, status: 'BYOK_SETTLED' }
  ]
};

const HISTORY = [
  { id: 'h1', createdAt: '2026-10-20T10:00:00Z', entryType: 'usage_settle', ctDelta: -600, usdDelta: -0.06, provider: 'gemini', model: 'gemini-nano-banana-2.1', operation: 'image.gemini.generate', projectId: 'comic-1', metadata: { estimatedBillableUsd: 0.07 } }
];

const ledger = vi.hoisted(() => ({
  getComicCostReport: vi.fn(async (_userId: string, _comicId: string): Promise<unknown> => null),
  listUsageHistory: vi.fn(async (_userId: string, _limit: number): Promise<unknown[]> => [])
}));
vi.mock('../services/billingLedger.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/billingLedger.js')>()),
  ...ledger
}));

type Status = { enabled: boolean; governed: boolean; capUsd: number };
const allowance = vi.hoisted(() => ({
  admin: false,
  adminThrows: false,
  status: { enabled: true, governed: true, capUsd: 10 } as Status
}));
vi.mock('../services/platformAllowance.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/platformAllowance.js')>();
  return {
    ...actual,
    isUsageExemptAdmin: vi.fn(async () => {
      if (allowance.adminThrows) throw new Error('roles down');
      return allowance.admin;
    }),
    getAllowanceStatus: vi.fn(async () => ({
      ...actual.buildAllowanceStatus({ usedUsd: 0, capUsd: allowance.status.capUsd, governed: allowance.status.governed }),
      enabled: allowance.status.enabled
    }))
  };
});

const { billingRouter, toGovernedComicCost, toGovernedUsageHistory } = await import('./billing.js');
const { errorHandler } = await import('../middleware/errors.js');

let signedIn = true;
const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  if (signedIn) req.user = { id: 'user-1', email: 'tester@example.com' };
  next();
});
app.use('/api/billing', billingRouter);
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
  signedIn = true;
  allowance.admin = false;
  allowance.adminThrows = false;
  allowance.status = { enabled: true, governed: true, capUsd: 10 };
  ledger.getComicCostReport.mockReset();
  ledger.getComicCostReport.mockImplementation(async () => structuredClone(REPORT));
  ledger.listUsageHistory.mockReset();
  ledger.listUsageHistory.mockImplementation(async () => structuredClone(HISTORY));
});

// Dollars, and the wallet's CT (dollars at a fixed rate: totalActualCt, estimatedCt, ctDelta…).
const isMoneyKey = (key: string) => /usd|cost|amount|budget|billable|metadata/i.test(key) || /Ct$/.test(key) || /^ct/i.test(key);
const moneyKeys = (value: unknown, path = ''): string[] => {
  if (!value || typeof value !== 'object') return [];
  return Object.entries(value as Record<string, unknown>).flatMap(([key, child]) => [
    ...(isMoneyKey(key) ? [`${path}${key}`] : []),
    ...moneyKeys(child, `${path}${key}.`)
  ]);
};

describe('GET /api/billing/comic-cost/:comicId', () => {
  it('governed user: shares of usage, no money anywhere in the payload', async () => {
    const res = await fetch(`${base}/api/billing/comic-cost/comic-1`);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toContain('no-store');
    const body = await res.json();
    expect(moneyKeys(body)).toEqual([]);
    expect(JSON.stringify(body)).not.toMatch(/\$/);
    // Settled platform-paid provider cost: 0.08 + 0.02 = $0.10 of a $10 budget → 1%.
    expect(body).toMatchObject({ comicId: 'comic-1', governed: true, usagePct: 1, ownKeyEvents: 1 });
    expect(body.byStage).toEqual({ generation: { usagePct: 0.8 }, planning: { usagePct: 0.2 } });
    expect(body.byModel).toEqual({ 'gemini-nano-banana-2.1': { usagePct: 1 } });
    expect(body.events.map((e: { id: string; usagePct: number }) => [e.id, e.usagePct])).toEqual([
      ['e1', 0.8],
      ['e2', 0.2],
      ['e3', 0],
      ['e4', 0]
    ]);
  });

  it('admin: the full dollar report, unchanged shape', async () => {
    allowance.admin = true;
    const body = await (await fetch(`${base}/api/billing/comic-cost/comic-1`)).json();
    expect(body).toEqual(REPORT);
  });

  it('exempt account or metering off (no limit applies): the dollar report', async () => {
    allowance.status = { enabled: true, governed: false, capUsd: 0 };
    expect(await (await fetch(`${base}/api/billing/comic-cost/comic-1`)).json()).toEqual(REPORT);
    allowance.status = { enabled: false, governed: false, capUsd: 0 };
    expect(await (await fetch(`${base}/api/billing/comic-cost/comic-1`)).json()).toEqual(REPORT);
  });

  it('usage lookup unavailable: fails closed to the governed shape with an unknown share', async () => {
    allowance.status = { enabled: false, governed: true, capUsd: 10 };
    const body = await (await fetch(`${base}/api/billing/comic-cost/comic-1`)).json();
    expect(body.governed).toBe(true);
    expect(body.usagePct).toBeNull();
    expect(moneyKeys(body)).toEqual([]);
  });

  it('admin lookup throws: governed shape (never dollars on a failure)', async () => {
    allowance.adminThrows = true;
    const body = await (await fetch(`${base}/api/billing/comic-cost/comic-1`)).json();
    expect(body.governed).toBe(true);
    expect(moneyKeys(body)).toEqual([]);
  });

  it('own-key (BYOK) spend never counts against a governed user’s usage', async () => {
    ledger.getComicCostReport.mockImplementation(async () => ({ ...structuredClone(REPORT), events: [structuredClone(REPORT.events[3])] }));
    const body = await (await fetch(`${base}/api/billing/comic-cost/comic-1`)).json();
    expect(body).toMatchObject({ governed: true, usagePct: 0, ownKeyEvents: 1, byStage: {}, byModel: {} });
  });

  it('rejects ids that could reshape the ledger filter, before any lookup', async () => {
    const res = await fetch(`${base}/api/billing/comic-cost/${encodeURIComponent('x,user_id.neq.y')}`);
    expect(res.status).toBe(400);
    expect(ledger.getComicCostReport).not.toHaveBeenCalled();
  });

  it('requires a signed-in user', async () => {
    signedIn = false;
    expect((await fetch(`${base}/api/billing/comic-cost/comic-1`)).status).toBe(401);
    expect(ledger.getComicCostReport).not.toHaveBeenCalled();
  });
});

describe('GET /api/billing/usage-history', () => {
  it('governed user: entries without USD, CT or metadata', async () => {
    const res = await fetch(`${base}/api/billing/usage-history?limit=5`);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toContain('no-store');
    const body = await res.json();
    expect(body.governed).toBe(true);
    expect(body.items).toEqual([
      { id: 'h1', createdAt: '2026-10-20T10:00:00Z', entryType: 'usage_settle', provider: 'gemini', model: 'gemini-nano-banana-2.1', operation: 'image.gemini.generate', projectId: 'comic-1' }
    ]);
    expect(moneyKeys(body)).toEqual([]);
  });

  it('admin: the full ledger entries', async () => {
    allowance.admin = true;
    const body = await (await fetch(`${base}/api/billing/usage-history`)).json();
    expect(body).toEqual({ items: HISTORY });
  });
});

describe('pure projections', () => {
  it('toGovernedComicCost leaves the share unknown without a usable cap and caps it at 100', () => {
    expect(toGovernedComicCost(REPORT, null).usagePct).toBeNull();
    expect(toGovernedComicCost(REPORT, 0).usagePct).toBeNull();
    expect(toGovernedComicCost(REPORT, 0.05).usagePct).toBe(100);
  });

  it('toGovernedUsageHistory drops optional fields that are absent', () => {
    expect(toGovernedUsageHistory([{ id: 'a', createdAt: 't', entryType: 'grant', ctDelta: 5, usdDelta: 1 }])).toEqual([
      { id: 'a', createdAt: 't', entryType: 'grant' }
    ]);
  });
});
