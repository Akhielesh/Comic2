// @vitest-environment node
// The per-user usage budget in front of every platform-paid call (P1-LIMITS). No database and
// no provider: the budget RPC is an in-memory fake with the same rules as
// server/sql/user_usage_budgets.sql (per-user lock, SETTLED + RESERVED<20min + estimate ≤ budget,
// RESERVED row inserted atomically), and the ledger is mocked so settle/release update it.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Request } from 'express';

type Ev = { userId: string; reservationId: string; costUsd: number; status: 'RESERVED' | 'SETTLED' | 'RELEASED'; createdAt: number };
const db = vi.hoisted(() => ({ events: [] as Ev[], budgets: new Map<string, number>(), rpcCalls: 0, rpcFails: false }));

const ledger = vi.hoisted(() => ({
  reserveUsageTokens: vi.fn(),
  settleReservation: vi.fn(),
  releaseReservation: vi.fn(),
  getBillingSummary: vi.fn()
}));
vi.mock('./billingLedger.js', () => ledger);

vi.mock('./costEstimator.js', () => ({
  buildEstimateFromRequestBody: (provider: string, model: string, operation: string, _body: unknown, explicit: Record<string, unknown> = {}) => ({
    provider,
    model,
    operation,
    ...explicit
  }),
  estimateCharge: vi.fn(async (seed: { metadata?: { estimateUsd?: number } }) => {
    const usd = seed.metadata?.estimateUsd ?? 0.5;
    return { currency: 'USD', ctPerUsd: 10_000, markup: 1.3, estimatedProviderCostUsd: usd, estimatedBillableUsd: usd * 1.3, estimatedCt: Math.round(usd * 13_000), lines: [] };
  }),
  buildSettleEstimateFromUsage: vi.fn(async (_seed: unknown, usage?: { providerCostUsd?: number }) => {
    const usd = usage?.providerCostUsd ?? 0;
    return { currency: 'USD', ctPerUsd: 10_000, markup: 1.3, estimatedProviderCostUsd: usd, estimatedBillableUsd: usd * 1.3, estimatedCt: Math.round(usd * 13_000), lines: [] };
  })
}));

const keys = vi.hoisted(() => ({ hasKey: false }));
vi.mock('../middleware/accountKeys.js', () => ({ hasAccountKeyFor: vi.fn(async () => keys.hasKey) }));
vi.mock('./rbac.js', () => ({ isBootstrapAdminEmail: () => false, getUserRoles: vi.fn(async () => []) }));

const allowance = await import('./platformAllowance.js');
const { reserveForOperation, settleReservedOperation, releaseReservedOperation, consumeAllowanceNotices, formatLimitErrorResponse } = await import('./usageEnforcer.js');

// ── Fake budget database (mirrors usage_budget_try_reserve) ───────────────────
let lock: Promise<unknown> = Promise.resolve();
const withLock = <T>(fn: () => Promise<T>): Promise<T> => {
  const run = lock.then(fn, fn);
  lock = run.catch(() => undefined);
  return run;
};
const used = (userId: string) =>
  db.events
    .filter((e) => e.userId === userId && (e.status === 'SETTLED' || (e.status === 'RESERVED' && Date.now() - e.createdAt < 20 * 60_000)))
    .reduce((s, e) => s + e.costUsd, 0);

const installFakeRpc = () =>
  allowance.setUsageBudgetRpc({
    tryReserve: ({ userId, reservationId, estimateUsd, event }) =>
      withLock(async () => {
        db.rpcCalls += 1;
        if (db.rpcFails) throw new Error('connection refused');
        await new Promise((r) => setTimeout(r, 1)); // interleave concurrent callers
        const budget = db.budgets.get(userId) ?? Number(event.default_budget_usd);
        const u = used(userId);
        const pct = (v: number) => Math.min(100, Math.round((v / budget) * 1000) / 10);
        if (estimateUsd > 0 && u + estimateUsd > budget) {
          return { governed: true, allowed: false, reason: 'USAGE_BUDGET_EXHAUSTED', pct_used: pct(u), pct_left: 100 - pct(u) };
        }
        db.events.push({ userId, reservationId, costUsd: estimateUsd, status: 'RESERVED', createdAt: Date.now() });
        return { governed: true, allowed: true, pct_used: pct(u + estimateUsd), pct_left: 100 - pct(u + estimateUsd) };
      }),
    status: async () => ({ governed: true, budget_usd: 10, spent_usd: 0, inflight_usd: 0 }),
    adminList: async () => []
  });

const makeReq = (over: Record<string, unknown> = {}) =>
  ({
    user: { id: 'tester-1', email: 'tester@example.com' },
    body: {},
    header: () => undefined,
    apiKeys: { providerKeys: { openrouter: { key: 'sk-platform', byok: false } } },
    ...over
  }) as unknown as Request;

const reserve = (req: Request, estimateUsd = 0.5) =>
  reserveForOperation({ req, operation: 'comic.image.page', provider: 'openrouter', fallbackModel: 'nb-2.1', imageUnits: 1, metadata: { estimateUsd } });

beforeEach(() => {
  allowance.__resetPlatformAllowance();
  allowance.__setMeteringEnabledForTests(true);
  installFakeRpc();
  db.events = [];
  db.budgets.clear();
  db.rpcCalls = 0;
  db.rpcFails = false;
  keys.hasKey = false;
  lock = Promise.resolve();
  ledger.reserveUsageTokens.mockReset().mockImplementation(async (input: { reservationId?: string; estimate: unknown; governed?: boolean; skipWalletLimits?: boolean; byok?: boolean }) => ({
    allowed: true,
    reservation: {
      reservationId: input.reservationId ?? (input.byok ? undefined : 'wallet-res'),
      byokBypass: !!input.byok,
      estimated: input.estimate,
      usage: {},
      governed: input.governed === true,
      walletSkipped: input.skipWalletLimits === true
    }
  }));
  ledger.settleReservation.mockReset().mockImplementation(async (input: { reservationId: string; actual: { estimatedProviderCostUsd: number } }) => {
    const ev = db.events.find((e) => e.reservationId === input.reservationId);
    if (ev) Object.assign(ev, { status: 'SETTLED', costUsd: input.actual.estimatedProviderCostUsd });
    return { actualCt: 0, billableUsd: input.actual.estimatedProviderCostUsd * 1.3, providerCostUsd: input.actual.estimatedProviderCostUsd, reservationReleased: true };
  });
  ledger.releaseReservation.mockReset().mockImplementation(async (input: { reservationId: string }) => {
    const ev = db.events.find((e) => e.reservationId === input.reservationId);
    if (ev) ev.status = 'RELEASED';
  });
});

afterEach(() => allowance.__resetPlatformAllowance());

describe('usage budget gate (reserveForOperation)', () => {
  it('refuses BEFORE the provider call once the budget is used, with an honest percent-only message', async () => {
    db.budgets.set('tester-1', 0.05); // the post-deploy check: a $0.05 test budget
    const provider = vi.fn();
    const run = async () => {
      const req = makeReq();
      const r = await reserve(req, 0.04);
      if (r.allowed) {
        provider();
        await settleReservedOperation({ req, operation: 'comic.image.page', provider: r.provider, model: r.model, seed: r.seed, usage: { providerCostUsd: 0.04 } });
      }
      return r;
    };
    expect((await run()).allowed).toBe(true);
    const second = await run();
    expect(second.allowed).toBe(false);
    expect(provider).toHaveBeenCalledTimes(1);
    if (!('details' in second)) throw new Error('unreachable');
    expect(second.details).toMatchObject({ reason: 'usage_budget_exhausted', requiredCt: 0, availableCt: 0 });
    expect(second.details.message).toContain('Settings → API keys');
    expect(JSON.stringify(second.details)).not.toMatch(/\$\d/);
    const keys = (o: unknown): string[] => (o && typeof o === 'object' ? Object.entries(o).flatMap(([k, v]) => [k, ...keys(v)]) : []);
    expect(keys(second.details).filter((k) => /usd|cost|amount/i.test(k))).toEqual([]);
    expect(formatLimitErrorResponse(second.details).message).toBe(second.details.message);
    // Only the first call reached the ledger.
    expect(ledger.reserveUsageTokens).toHaveBeenCalledTimes(1);
  });

  it('BYOK never touches the budget (and keeps the normal wallet path)', async () => {
    db.budgets.set('tester-1', 0);
    const req = makeReq({ apiKeys: { providerKeys: { openrouter: { key: 'sk-mine', byok: true } } } });
    const r = await reserve(req);
    expect(r.allowed).toBe(true);
    expect(db.rpcCalls).toBe(0);
    expect(ledger.reserveUsageTokens.mock.calls[0][0]).toMatchObject({ byok: true });
    expect(ledger.reserveUsageTokens.mock.calls[0][0].skipWalletLimits).toBeUndefined();
  });

  it('governed users skip the wallet deny and reuse the RPC reservation (no duplicate cost event)', async () => {
    const r = await reserve(makeReq());
    expect(r.allowed).toBe(true);
    const input = ledger.reserveUsageTokens.mock.calls[0][0];
    expect(input).toMatchObject({ skipWalletLimits: true, governed: true, costEventRecorded: true });
    expect(input.reservationId).toBe(db.events[0].reservationId);
    if (r.allowed) expect(r.reservation).toMatchObject({ governed: true, walletSkipped: true });
  });

  it('admins are exempt: no budget check, still metered in the ledger', async () => {
    const r = await reserve(makeReq({ accessProfile: { isAdmin: true } }));
    expect(r.allowed).toBe(true);
    expect(db.rpcCalls).toBe(0);
    expect(ledger.reserveUsageTokens.mock.calls[0][0]).toMatchObject({ skipWalletLimits: true, governed: false, costEventRecorded: false });
  });

  it('settle records the actual provider cost; release frees the hold', async () => {
    db.budgets.set('tester-1', 1);
    const req = makeReq();
    const a = await reserve(req, 0.6);
    if (!a.allowed) throw new Error('expected allowed');
    // 0.6 held: another 0.6 doesn't fit…
    expect((await reserve(makeReq(), 0.6)).allowed).toBe(false);
    // …until the first is released.
    await releaseReservedOperation({ req, operation: 'x', provider: 'openrouter', model: 'm', reason: 'render failed' });
    expect(ledger.releaseReservation.mock.calls[0][0]).toMatchObject({ walletSkipped: true, reason: 'render failed' });
    const req2 = makeReq();
    const b = await reserve(req2, 0.6);
    expect(b.allowed).toBe(true);
    if (!b.allowed) return;
    await settleReservedOperation({ req: req2, operation: 'x', provider: b.provider, model: b.model, seed: b.seed, usage: { providerCostUsd: 0.25 } });
    expect(ledger.settleReservation.mock.calls[0][0]).toMatchObject({ walletSkipped: true });
    expect(db.events.find((e) => e.status === 'SETTLED')?.costUsd).toBe(0.25);
    // 0.25 actually spent → 0.7 fits now.
    expect((await reserve(makeReq(), 0.7)).allowed).toBe(true);
  });

  it('concurrent reserves never exceed the cap', async () => {
    db.budgets.set('tester-1', 10);
    const results = await Promise.all(Array.from({ length: 25 }, () => reserve(makeReq(), 0.6)));
    const allowed = results.filter((r) => r.allowed).length;
    expect(allowed).toBe(16); // 16 × 0.6 = 9.6; the 17th would be 10.2
    expect(used('tester-1')).toBeLessThanOrEqual(10);
  });

  it('fails CLOSED for governed users when the budget cannot be checked', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    db.rpcFails = true;
    keys.hasKey = true;
    const r = await reserve(makeReq());
    expect(r.allowed).toBe(false);
    if (!('details' in r)) return;
    expect(r.details).toMatchObject({ reason: 'usage_budget_unavailable', canFallbackToByok: true });
    expect(r.details.message).toContain('nothing was spent');
    expect(ledger.reserveUsageTokens).not.toHaveBeenCalled();
    err.mockRestore();
  });

  it('frees the budget hold and refuses when the ledger write fails after the reserve', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    ledger.reserveUsageTokens.mockRejectedValueOnce(new Error('ledger offline'));
    const r = await reserve(makeReq());
    expect(r.allowed).toBe(false);
    expect(ledger.releaseReservation).toHaveBeenCalledWith(expect.objectContaining({ walletSkipped: true, reason: 'ledger_unavailable' }));
    expect(db.events[0].status).toBe('RELEASED');
    err.mockRestore();
  });

  it('raises a percent-only notice when a reserve crosses 30%', async () => {
    db.budgets.set('tester-1', 10);
    await reserve(makeReq(), 2.5); // 25%
    const req = makeReq();
    await reserve(req, 1); // 35%
    const notices = consumeAllowanceNotices(req);
    expect(notices).toHaveLength(1);
    expect(notices[0].message).toContain('30%');
    expect(notices[0].message).not.toMatch(/\$/);
  });

  it('metering off: no budget, legacy wallet path', async () => {
    allowance.__setMeteringEnabledForTests(false);
    const r = await reserve(makeReq());
    expect(r.allowed).toBe(true);
    expect(db.rpcCalls).toBe(0);
    expect(ledger.reserveUsageTokens.mock.calls[0][0].skipWalletLimits).toBeUndefined();
  });
});

describe('attachBillingToPayload', () => {
  it('sends governed users no dollar amounts; admins/own key keep the real figures', async () => {
    const { attachBillingToPayload } = await import('./usageEnforcer.js');
    const estimated = { estimatedProviderCostUsd: 0.05, estimatedBillableUsd: 0.065, estimatedCt: 650 } as never;
    const settled = { actualCt: 650, billableUsd: 0.065, providerCostUsd: 0.05, reservationReleased: true } as never;
    const governed = attachBillingToPayload({ ok: true }, { reservationId: 'r', byokBypass: false, estimated, usage: {} as never, governed: true }, settled);
    expect(governed.billing).toEqual({ reservationId: 'r', byokBypass: false, governed: true, settled: { reservationReleased: true } });
    expect(JSON.stringify(governed)).not.toMatch(/usd|cost/i);
    const admin = attachBillingToPayload({ ok: true }, { reservationId: 'r', byokBypass: false, estimated, usage: {} as never }, settled);
    expect(admin.billing?.settled).toMatchObject({ providerCostUsd: 0.05 });
  });
});
