// @vitest-environment node
// The comic v4 billing gap (models.md §5.1 M1-LOCK-SERVER item 7, AT-11): in production every comic image and
// text call reached ZERO rows of token_ledger_entries / generation_cost_events. Cause: v4's createBillingHooks was
// gated on BILLING_ENABLED, which production keeps "false" (no Stripe; api-proxy/wrangler.jsonc), so every call got
// noopBillingHooks. v5 meters on METERING_ENABLED (default on) instead.
//
// This test runs the REAL chain — comic billing hooks → usageEnforcer → platformAllowance → billingLedger — with
// production's flags (BILLING_ENABLED=false, METERING_ENABLED unset) and only the database replaced by a recording
// fake, and proves that one settled comic call writes exactly one SETTLE row (plus its RESERVE row and cost event).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Request } from 'express';

type Call = { table: string; op: string; payload?: Record<string, unknown>; filters: Array<[string, unknown]> };
const sb = vi.hoisted(() => ({ calls: [] as Call[], rpcs: [] as string[] }));
vi.mock('../services/supabase.js', () => {
  const builder = (table: string) => {
    const rec: Call = { table, op: 'select', filters: [] };
    const b: Record<string, unknown> = {
      insert(payload: Record<string, unknown>) { rec.op = 'insert'; rec.payload = payload; sb.calls.push(rec); return b; },
      update(payload: Record<string, unknown>) { rec.op = 'update'; rec.payload = payload; sb.calls.push(rec); return b; },
      upsert(payload: Record<string, unknown>) { rec.op = 'upsert'; rec.payload = payload; sb.calls.push(rec); return b; },
      select() { return b; },
      eq(col: string, val: unknown) { rec.filters.push([col, val]); return b; },
      in() { return b; },
      gte() { return b; },
      order() { return b; },
      limit() { return b; },
      abortSignal() { return b; },
      maybeSingle: async () => ({ data: null, error: null }),
      single: async () => ({ data: null, error: null }),
      then(resolve: (v: unknown) => void) { resolve({ data: null, error: null }); }
    };
    return b;
  };
  const admin = { from: builder, rpc: async (name: unknown) => { sb.rpcs.push(String(name)); return { data: { ok: true, allowed: true }, error: null }; } };
  return {
    supabase: {},
    getSupabaseAdmin: () => admin,
    getSupabaseCapabilityStatus: () => ({ supabaseConfigured: true, storagePersistenceEnabled: true })
  };
});
// The price catalog lives in the database too: a fixed estimate keeps this test about the ledger writes.
vi.mock('../services/costEstimator.js', () => ({
  buildEstimateFromRequestBody: (provider: string, model: string, operation: string, _body: unknown, explicit: Record<string, unknown> = {}) => ({ provider, model, operation, ...explicit }),
  estimateCharge: vi.fn(async () => ({ currency: 'USD', ctPerUsd: 10_000, markup: 1.3, estimatedProviderCostUsd: 0.0336, estimatedBillableUsd: 0.0437, estimatedCt: 437, lines: [] })),
  buildSettleEstimateFromUsage: vi.fn(async (_seed: unknown, usage?: { providerCostUsd?: number }) => {
    const usd = usage?.providerCostUsd ?? 0;
    return { currency: 'USD', ctPerUsd: 10_000, markup: 1.3, estimatedProviderCostUsd: usd, estimatedBillableUsd: usd * 1.3, estimatedCt: Math.round(usd * 13_000), lines: [] };
  })
}));
vi.mock('../middleware/accountKeys.js', () => ({ hasAccountKeyFor: vi.fn(async () => false) }));
vi.mock('../services/rbac.js', () => ({ isBootstrapAdminEmail: () => false, getUserRoles: vi.fn(async () => []) }));

const saved = { billing: process.env.BILLING_ENABLED, metering: process.env.METERING_ENABLED };

const loadChain = async () => {
  vi.resetModules();
  process.env.BILLING_ENABLED = 'false'; // production (api-proxy/wrangler.jsonc)
  delete process.env.METERING_ENABLED; // production leaves it unset (default on)
  const allowance = await import('../services/platformAllowance.js');
  const billing = await import('./billing.js');
  allowance.__resetPlatformAllowance();
  // A governed tester's budget RPC (server/sql/user_usage_budgets.sql): reserve inserts the RESERVED cost event.
  allowance.setUsageBudgetRpc({
    tryReserve: async () => ({ governed: true, allowed: true, pct_used: 1, pct_left: 99 }),
    status: async () => ({ governed: true, budget_usd: 10, spent_usd: 0, inflight_usd: 0 }),
    adminList: async () => []
  } as never);
  return { billing, allowance };
};

const makeReq = (over: Record<string, unknown> = {}) =>
  ({
    user: { id: 'user-owner', email: 'owner@example.com' },
    body: {},
    header: () => undefined,
    apiKeys: { providerKeys: { openrouter: { key: 'sk-platform', byok: false } } },
    ...over
  }) as unknown as Request;

const pageCall = { operation: 'comic.image.page', provider: 'openrouter', model: 'google/gemini-nano-banana-2.1', stage: 'page', imageUnits: 1, resolution: '1K' as const };
const rows = (table: string, op?: string) => sb.calls.filter((c) => c.table === table && (!op || c.op === op));
const ledgerRows = (type: string) => rows('token_ledger_entries', 'insert').filter((c) => c.payload?.entry_type === type);

beforeEach(() => {
  sb.calls = [];
  sb.rpcs = [];
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'info').mockImplementation(() => undefined);
});
afterEach(() => {
  if (saved.billing === undefined) delete process.env.BILLING_ENABLED;
  else process.env.BILLING_ENABLED = saved.billing;
  if (saved.metering === undefined) delete process.env.METERING_ENABLED;
  else process.env.METERING_ENABLED = saved.metering;
  vi.restoreAllMocks();
  vi.resetModules();
});

describe('comic billing reaches the ledger (the v4 billing gap)', () => {
  it("one settled page on the owner's admin account writes exactly one SETTLE row with the real provider cost", async () => {
    const { billing } = await loadChain();
    const hooks = billing.createBillingHooks(makeReq({ accessProfile: { isAdmin: true } }), 'proj-lake');
    const reserved = await hooks.reserve(pageCall);
    expect(reserved.ok).toBe(true);
    if (!reserved.ok) return;
    await reserved.reservation.settle({ costUsd: 0.0386, imageUnits: 1 });

    const settle = ledgerRows('SETTLE');
    expect(settle).toHaveLength(1);
    expect(settle[0].payload).toMatchObject({
      user_id: 'user-owner',
      operation: 'comic.image.page',
      provider: 'openrouter',
      model: 'google/gemini-nano-banana-2.1',
      project_id: 'proj-lake',
      provider_cost_usd: 0.0386
    });
    // The hold that preceded it, and the cost event the usage meter and Admin → Costs read.
    expect(ledgerRows('RESERVE')).toHaveLength(1);
    expect(rows('generation_cost_events', 'insert')).toHaveLength(1);
    const settled = rows('generation_cost_events', 'update');
    expect(settled).toHaveLength(1);
    expect(settled[0].payload).toMatchObject({ status: 'SETTLED', provider_cost_usd: 0.0386 });
    expect(settled[0].filters).toEqual(expect.arrayContaining([['user_id', 'user-owner']]));
  });

  it("a governed tester's settled page writes one SETTLE row too (the budget RPC holds the cost event)", async () => {
    const { billing } = await loadChain();
    const hooks = billing.createBillingHooks(makeReq({ user: { id: 'user-tester', email: 'tester@example.com' } }), 'proj-1');
    const reserved = await hooks.reserve(pageCall);
    expect(reserved.ok).toBe(true);
    if (!reserved.ok) return;
    await reserved.reservation.settle({ costUsd: 0.05, imageUnits: 1 });
    expect(ledgerRows('SETTLE')).toHaveLength(1);
    expect(ledgerRows('SETTLE')[0].payload).toMatchObject({ user_id: 'user-tester', operation: 'comic.image.page', provider_cost_usd: 0.05 });
    // The budget RPC already inserted the RESERVED row: never a duplicate cost event.
    expect(rows('generation_cost_events', 'insert')).toHaveLength(0);
    expect(rows('generation_cost_events', 'update')[0].payload).toMatchObject({ status: 'SETTLED' });
  });

  it('a failed call that is released writes no SETTLE row (nothing billed)', async () => {
    const { billing } = await loadChain();
    const hooks = billing.createBillingHooks(makeReq({ accessProfile: { isAdmin: true } }), 'proj-lake');
    const reserved = await hooks.reserve(pageCall);
    if (!reserved.ok) throw new Error('reserve refused');
    await reserved.reservation.release('RATE_LIMIT');
    expect(ledgerRows('SETTLE')).toHaveLength(0);
    expect(ledgerRows('RESERVE')).toHaveLength(1);
  });
});
