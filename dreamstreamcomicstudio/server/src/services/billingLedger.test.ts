import crypto from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TokenEstimateResponse } from '../../../shared/types/billing.js';

const RUN_INTEGRATION = process.env.BILLING_INTEGRATION_TESTS === 'true';

// A recording Supabase fake for the unit tests below. With no fake installed the admin client
// throws exactly like a deployment without the service role (the fail-closed test relies on it);
// integration runs use the real client.
type Call = { table: string; op: string; payload?: unknown; filters: Array<[string, unknown]> };
const sb = vi.hoisted(() => ({ fake: null as null | { from: (t: string) => unknown; rpc: (...a: unknown[]) => unknown }, calls: [] as Call[], rpcs: [] as string[] }));
vi.mock('./supabase.js', async (importOriginal) => {
  if (process.env.BILLING_INTEGRATION_TESTS === 'true') return importOriginal();
  return {
    supabase: {},
    getSupabaseAdmin: () => {
      if (!sb.fake) throw new Error('Supabase service role is not configured');
      return sb.fake;
    }
  };
});

const installFakeSupabase = () => {
  sb.calls = [];
  sb.rpcs = [];
  const builder = (table: string) => {
    const rec: Call = { table, op: 'select', filters: [] };
    const b: Record<string, unknown> = {
      insert(payload: unknown) { rec.op = 'insert'; rec.payload = payload; sb.calls.push(rec); return b; },
      update(payload: unknown) { rec.op = 'update'; rec.payload = payload; sb.calls.push(rec); return b; },
      select() { return b; },
      eq(col: string, val: unknown) { rec.filters.push([col, val]); return b; },
      in() { return b; },
      maybeSingle: async () => ({ data: null, error: null }),
      single: async () => ({ data: null, error: null }),
      then(resolve: (v: unknown) => void) { resolve({ data: null, error: null }); }
    };
    return b;
  };
  sb.fake = {
    from: builder,
    rpc: async (name: unknown) => { sb.rpcs.push(String(name)); return { data: { ok: true, allowed: true }, error: null }; }
  };
};

const {
  getBillingSummary,
  releaseReservation,
  reserveUsageTokens,
  settleReservation
} = await import('./billingLedger.js');

const makeEstimate = (ct: number): TokenEstimateResponse => {
  const billableUsd = Number((ct * 0.0001).toFixed(6));
  return {
    currency: 'USD',
    ctPerUsd: 10_000,
    markup: 1.3,
    estimatedProviderCostUsd: Number((billableUsd / 1.3).toFixed(6)),
    estimatedBillableUsd: billableUsd,
    estimatedCt: ct,
    lines: [],
    modelPricing: {
      provider: 'gemini',
      model: 'gemini-2.5-flash',
      inputPer1kUsd: 0,
      outputPer1kUsd: 0,
      imagePerOutputUsd: 0,
      source: 'unit-test',
      confidence: 1,
      status: 'ACTIVE',
      effectiveFrom: new Date().toISOString()
    }
  };
};

describe('billingLedger', () => {
  it('fails closed when billing backend is unavailable', async () => {
    if (RUN_INTEGRATION) return;
    const userId = crypto.randomUUID();
    await expect(getBillingSummary(userId)).rejects.toMatchObject({
      publicCode: 'BILLING_BACKEND_UNAVAILABLE'
    });
  });

  it('reserves then settles and releases hold correctly', async () => {
    if (!RUN_INTEGRATION) return;
    const userId = crypto.randomUUID();
    const reserveEstimate = makeEstimate(120);
    const settleEstimate = makeEstimate(80);

    const reserved = await reserveUsageTokens({
      userId,
      estimate: reserveEstimate,
      provider: 'gemini',
      model: 'gemini-2.5-flash',
      operation: 'unit_test_settle'
    });

    if (!('reservation' in reserved)) {
      throw new Error('Expected reservation to be allowed in unit test');
    }

    const afterReserve = await getBillingSummary(userId);
    expect(afterReserve.wallet.reservedCt).toBe(120);

    await settleReservation({
      userId,
      reservationId: reserved.reservation.reservationId,
      estimatedCt: reserveEstimate.estimatedCt,
      actual: settleEstimate,
      operation: 'unit_test_settle',
      provider: 'gemini',
      model: 'gemini-2.5-flash'
    });

    const afterSettle = await getBillingSummary(userId);
    expect(afterSettle.wallet.reservedCt).toBe(0);
    expect(afterSettle.wallet.usedMonthlyCt).toBe(80);
  });

  it('releases reservation fully on failure', async () => {
    if (!RUN_INTEGRATION) return;
    const userId = crypto.randomUUID();
    const estimate = makeEstimate(150);

    const reserved = await reserveUsageTokens({
      userId,
      estimate,
      provider: 'gemini',
      model: 'gemini-2.5-flash',
      operation: 'unit_test_release'
    });

    if (!('reservation' in reserved) || !reserved.reservation.reservationId) {
      throw new Error('Expected reservation to be created in unit test');
    }

    await releaseReservation({
      userId,
      reservationId: reserved.reservation.reservationId,
      estimatedCt: estimate.estimatedCt,
      operation: 'unit_test_release',
      reason: 'test_failure'
    });

    const summary = await getBillingSummary(userId);
    expect(summary.wallet.reservedCt).toBe(0);
    expect(summary.wallet.usedMonthlyCt).toBe(0);
  });

  it('enforces daily guardrail before reserve', async () => {
    if (!RUN_INTEGRATION) return;
    const userId = crypto.randomUUID();
    const tooLarge = makeEstimate(900); // Free guardrail is 800 CT/day.

    const reserved = await reserveUsageTokens({
      userId,
      estimate: tooLarge,
      provider: 'gemini',
      model: 'gemini-2.5-flash',
      operation: 'unit_test_daily_limit'
    });

    expect('details' in reserved).toBe(true);
    if ('details' in reserved) {
      expect(reserved.details.reason).toBe('DAILY_LIMIT_EXCEEDED');
      expect(reserved.details.requiredCt).toBe(900);
    }
  });

  it('returns UTC reset timestamps for daily and monthly cycles', async () => {
    if (!RUN_INTEGRATION) return;
    const userId = crypto.randomUUID();
    const summary = await getBillingSummary(userId);
    const now = Date.now();

    const dailyReset = new Date(summary.usage.dailyResetAt);
    const monthlyReset = new Date(summary.usage.monthlyResetAt);

    expect(dailyReset.getTime()).toBeGreaterThan(now);
    expect(dailyReset.getTime() - now).toBeLessThanOrEqual(25 * 60 * 60 * 1000);

    expect(monthlyReset.getTime()).toBeGreaterThan(now);
    expect(monthlyReset.getUTCDate()).toBe(1);
    expect(monthlyReset.getUTCHours()).toBe(0);
    expect(monthlyReset.getUTCMinutes()).toBe(0);
  });
});

describe('billingLedger — usage-budget paths (P1-LIMITS)', () => {
  afterEach(() => {
    sb.fake = null;
  });

  it('governed reserve skips the wallet, writes the ledger and reuses the budget RPC row (no duplicate cost event)', async () => {
    if (RUN_INTEGRATION) return;
    installFakeSupabase();
    const out = await reserveUsageTokens({
      userId: 'user-a',
      estimate: makeEstimate(900), // above the free plan's 800 CT/day guardrail — must not matter
      provider: 'openrouter',
      model: 'nb',
      operation: 'comic.image.page',
      skipWalletLimits: true,
      reservationId: '11111111-1111-4111-8111-111111111111',
      costEventRecorded: true,
      governed: true
    });
    expect(out.allowed).toBe(true);
    if (!out.allowed) return;
    expect(out.reservation).toMatchObject({ reservationId: '11111111-1111-4111-8111-111111111111', governed: true, walletSkipped: true, byokBypass: false });
    expect(sb.rpcs).toEqual([]); // no billing_try_reserve_tokens
    expect(sb.calls.filter((c) => c.table === 'generation_cost_events')).toEqual([]);
    const ledgerRow = sb.calls.find((c) => c.table === 'token_ledger_entries')?.payload as Record<string, unknown>;
    expect(ledgerRow).toMatchObject({ entry_type: 'RESERVE', ct_delta: 0, user_id: 'user-a', reservation_id: '11111111-1111-4111-8111-111111111111' });
  });

  it('admin/exempt reserve skips the wallet but still records the RESERVED cost event', async () => {
    if (RUN_INTEGRATION) return;
    installFakeSupabase();
    const out = await reserveUsageTokens({ userId: 'admin-1', estimate: makeEstimate(100), provider: 'openrouter', model: 'nb', operation: 'chat', skipWalletLimits: true });
    expect(out.allowed).toBe(true);
    const ev = sb.calls.find((c) => c.table === 'generation_cost_events');
    expect(ev?.op).toBe('insert');
    expect(ev?.payload).toMatchObject({ user_id: 'admin-1', status: 'RESERVED', is_byok: false });
  });

  it('settle and release update ONLY the owner’s cost event (reservation id AND user id)', async () => {
    if (RUN_INTEGRATION) return;
    installFakeSupabase();
    const reservationId = '22222222-2222-4222-8222-222222222222';
    const settled = await settleReservation({
      userId: 'user-a',
      reservationId,
      estimatedCt: 700,
      actual: makeEstimate(650),
      operation: 'comic.image.page',
      provider: 'openrouter',
      model: 'nb',
      walletSkipped: true
    });
    expect(settled).toMatchObject({ actualCt: 650, reservationReleased: true });
    expect(sb.rpcs).toEqual([]); // no billing_settle_tokens: no wallet CT moved
    const update = sb.calls.find((c) => c.table === 'generation_cost_events' && c.op === 'update');
    expect(update?.filters).toEqual([['reservation_id', reservationId], ['user_id', 'user-a']]);
    expect(update?.payload).toMatchObject({ status: 'SETTLED', provider_cost_usd: makeEstimate(650).estimatedProviderCostUsd });

    installFakeSupabase();
    await releaseReservation({ userId: 'user-a', reservationId, estimatedCt: 700, reason: 'render failed', walletSkipped: true });
    expect(sb.rpcs).toEqual([]);
    const release = sb.calls.find((c) => c.table === 'generation_cost_events' && c.op === 'update');
    expect(release?.filters).toEqual([['reservation_id', reservationId], ['user_id', 'user-a']]);
    expect(release?.payload).toMatchObject({ status: 'RELEASED' });
  });

  it('a normal (wallet) release is user-scoped too', async () => {
    if (RUN_INTEGRATION) return;
    installFakeSupabase();
    await releaseReservation({ userId: 'user-b', reservationId: '33333333-3333-4333-8333-333333333333', estimatedCt: 10 });
    expect(sb.rpcs).toEqual(['billing_release_reserved_tokens']);
    const release = sb.calls.find((c) => c.table === 'generation_cost_events' && c.op === 'update');
    expect(release?.filters).toContainEqual(['user_id', 'user-b']);
  });
});
