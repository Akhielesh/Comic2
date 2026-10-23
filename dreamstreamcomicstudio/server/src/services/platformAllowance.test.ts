// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Request } from 'express';

// Never touch Supabase: admin roles are driven per test.
const roles = vi.hoisted(() => ({ list: [] as string[], calls: 0 }));
vi.mock('./rbac.js', () => ({
  isBootstrapAdminEmail: (email?: string | null) => String(email || '').toLowerCase() === 'owner@example.com',
  getUserRoles: vi.fn(async () => {
    roles.calls += 1;
    return roles.list;
  })
}));

// A tiny in-memory user_usage_budgets for upsertUsageBudget (no real database).
const store = vi.hoisted(() => ({
  rows: new Map<string, Record<string, unknown>>(),
  users: new Set<string>(['tester-1']),
  writes: [] as Array<{ op: string; row: Record<string, unknown> }>
}));
vi.mock('./supabase.js', () => ({
  getSupabaseAdmin: () => ({
    from: (table: string) => {
      if (table !== 'user_usage_budgets') throw new Error(`unexpected table ${table}`);
      let userId = '';
      let pending: { op: 'insert' | 'update'; row: Record<string, unknown> } | null = null;
      const q: Record<string, unknown> = {
        select: () => q,
        eq: (_col: string, v: string) => {
          userId = v;
          return q;
        },
        insert: (row: Record<string, unknown>) => {
          pending = { op: 'insert', row };
          return q;
        },
        update: (row: Record<string, unknown>) => {
          pending = { op: 'update', row };
          return q;
        },
        maybeSingle: async () => ({ data: store.rows.get(userId) ?? null, error: null }),
        single: async () => {
          if (!pending) return { data: null, error: { message: 'nothing pending' } };
          const p = pending as { op: 'insert' | 'update'; row: Record<string, unknown> };
          store.writes.push({ op: p.op, row: p.row });
          if (p.op === 'insert') {
            const id = String(p.row.user_id);
            if (!store.users.has(id)) return { data: null, error: { code: '23503', message: 'violates foreign key constraint' } };
            store.rows.set(id, { ...p.row });
            return { data: store.rows.get(id), error: null };
          }
          const next = { ...(store.rows.get(userId) || {}), ...p.row };
          store.rows.set(userId, next);
          return { data: next, error: null };
        }
      };
      return q;
    }
  })
}));

const {
  __resetPlatformAllowance,
  __setMeteringEnabledForTests,
  allowanceCrossingNotices,
  allowanceExhaustedMessage,
  allowancePctUsed,
  buildAllowanceExhaustedDetails,
  buildAllowanceStatus,
  calmCount,
  defaultBudgetUsd,
  friendlyUnitsFor,
  getAllowanceStatus,
  isUsageExemptAdmin,
  listUsageBudgets,
  parseBudgetStatus,
  setUsageBudgetRpc,
  standardPageProviderUsd,
  thresholdsCrossed,
  thresholdsMet,
  tryReserveAllowance,
  upsertUsageBudget,
  usageNotEnoughMessage,
  validateUsageBudgetPatch,
  USAGE_UNAVAILABLE_MESSAGE
} = await import('./platformAllowance.js');

const MONEY = /\$|usd|dollar/i;

const fakeRpc = (over: Partial<Parameters<typeof setUsageBudgetRpc>[0] & object> = {}) => {
  const impl = {
    tryReserve: vi.fn(async () => ({ governed: true, allowed: true, pct_used: 1, pct_left: 99 })),
    status: vi.fn(async () => ({ governed: true, budget_usd: 10, spent_usd: 2.5, inflight_usd: 0.5, pct_used: 30, pct_left: 70, exhausted: false, period: 'lifetime', allow_pro: false })),
    adminList: vi.fn(async () => [] as unknown[]),
    ...over
  };
  setUsageBudgetRpc(impl as never);
  return impl;
};

beforeEach(() => {
  __resetPlatformAllowance();
  __setMeteringEnabledForTests(true);
  roles.list = [];
  roles.calls = 0;
  delete process.env.PLATFORM_ALLOWANCE_DEFAULT_USD;
});

afterEach(() => {
  __resetPlatformAllowance();
  delete process.env.PLATFORM_ALLOWANCE_DEFAULT_USD;
});

describe('default budget (owner decision: $10 lifetime)', () => {
  it('defaults to $10 and honours PLATFORM_ALLOWANCE_DEFAULT_USD (bad values fall back)', () => {
    expect(defaultBudgetUsd()).toBe(10);
    process.env.PLATFORM_ALLOWANCE_DEFAULT_USD = '25';
    expect(defaultBudgetUsd()).toBe(25);
    process.env.PLATFORM_ALLOWANCE_DEFAULT_USD = 'lots';
    expect(defaultBudgetUsd()).toBe(10);
    process.env.PLATFORM_ALLOWANCE_DEFAULT_USD = '0';
    expect(defaultBudgetUsd()).toBe(0);
    process.env.PLATFORM_ALLOWANCE_DEFAULT_USD = '999999';
    expect(defaultBudgetUsd()).toBe(1000);
  });
});

describe('percent math', () => {
  it('clamps pct to 0..100 (a zero budget with spend is 100%)', () => {
    expect(allowancePctUsed(0, 10)).toBe(0);
    expect(allowancePctUsed(2.5, 10)).toBe(25);
    expect(allowancePctUsed(12, 10)).toBe(100);
    expect(allowancePctUsed(0.01, 0)).toBe(100);
    expect(thresholdsMet(71)).toEqual([30, 70]);
    expect(thresholdsCrossed(29, 91)).toEqual([30, 70, 90]);
    expect(thresholdsCrossed(91, 95)).toEqual([]);
  });

  it('lifetime status has no reset date; monthly resets on the first of next month', () => {
    const lifetime = buildAllowanceStatus({ usedUsd: 10, capUsd: 10 });
    expect(lifetime).toMatchObject({ governed: true, exhausted: true, pctUsed: 100, pctLeft: 0, period: 'lifetime', resetsAt: null });
    const monthly = buildAllowanceStatus({ usedUsd: 1, capUsd: 10, period: 'monthly', now: new Date('2026-12-15T10:00:00Z') });
    expect(monthly.resetsAt).toBe('2027-01-01T00:00:00.000Z');
  });
});

describe('friendly units (from the real registry prices)', () => {
  it('counts standard comic pages from the provider-cost page price and rounds down calmly', () => {
    const per = standardPageProviderUsd();
    expect(per).toBeGreaterThan(0.05);
    expect(per).toBeLessThan(0.1);
    const units = friendlyUnitsFor(10, 10);
    expect(units.standardPages).toBe(calmCount(10 / per));
    expect(units.standardPages % 10).toBe(0);
    expect(units.label).toMatch(/^about \d+ standard comic pages left$/);
    expect(units.pctPerStandardPage).toBeCloseTo((per / 10) * 100, 1);
    expect(calmCount(152.9)).toBe(150);
    expect(calmCount(47)).toBe(45);
    expect(calmCount(7.9)).toBe(7);
    expect(friendlyUnitsFor(0, 10).label).toBe('no usage left');
    expect(friendlyUnitsFor(0.04, 10).label).toMatch(/draft page|a little left/);
  });
});

describe('getAllowanceStatus', () => {
  it('reads the per-user status once and caches it (provider-cost basis from the RPC)', async () => {
    const rpc = fakeRpc();
    const a = await getAllowanceStatus('u1');
    const b = await getAllowanceStatus('u1');
    expect(rpc.status).toHaveBeenCalledTimes(1);
    expect(rpc.status).toHaveBeenCalledWith('u1', 10);
    expect(a).toMatchObject({ enabled: true, governed: true, capUsd: 10, usedUsd: 3, pctUsed: 30, pctLeft: 70, exhausted: false, resetsAt: null });
    expect(b).toBe(a);
  });

  it('honours a per-user override row (e.g. a $0.05 test budget)', async () => {
    fakeRpc({ status: vi.fn(async () => ({ governed: true, has_row: true, budget_usd: 0.05, spent_usd: 0.05, inflight_usd: 0, pct_used: 100, pct_left: 0, exhausted: true, period: 'lifetime' })) });
    expect(await getAllowanceStatus('tester')).toMatchObject({ governed: true, capUsd: 0.05, exhausted: true, pctLeft: 0 });
  });

  it('admins and exempt rows are ungoverned; metering off is disabled', async () => {
    const rpc = fakeRpc({ status: vi.fn(async () => ({ governed: false, exempt: true, allow_pro: true })) });
    expect(await getAllowanceStatus('admin', { isAdmin: true })).toMatchObject({ enabled: true, governed: false, exhausted: false });
    expect(rpc.status).not.toHaveBeenCalled();
    expect(await getAllowanceStatus('vip')).toMatchObject({ enabled: true, governed: false, exempt: true, allowPro: true });
    __setMeteringEnabledForTests(false);
    expect((await getAllowanceStatus('anyone')).enabled).toBe(false);
  });

  it('reports enabled:false (UI hides) when the status read fails — enforcement is separate', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    fakeRpc({ status: vi.fn(async () => { throw new Error('db down'); }) });
    expect((await getAllowanceStatus('u2')).enabled).toBe(false);
    warn.mockRestore();
  });

  it('parses a monthly row and trusts the database percent', () => {
    const s = parseBudgetStatus({ governed: true, budget_usd: 10, spent_usd: 9, inflight_usd: 0, pct_used: 90, exhausted: false, period: 'monthly' }, new Date('2026-10-22T00:00:00Z'));
    expect(s).toMatchObject({ pctUsed: 90, pctLeft: 10, crossed: [30, 70, 90], period: 'monthly', resetsAt: '2026-11-01T00:00:00.000Z' });
  });
});

describe('tryReserveAllowance (atomic RPC wrapper)', () => {
  const event = { operation: 'comic.image.page', provider: 'openrouter', model: 'nb', estimatedCt: 700, billableUsd: 0.07 };

  it('passes the provider-cost estimate, the default budget and the event to the RPC', async () => {
    const rpc = fakeRpc();
    const out = await tryReserveAllowance({ userId: 'u', reservationId: 'r1', estimateUsd: 0.0534567891, event });
    expect(out).toEqual({ kind: 'reserved', pctUsed: 1, pctLeft: 99, crossedNow: [] });
    expect(rpc.tryReserve).toHaveBeenCalledWith({
      userId: 'u',
      reservationId: 'r1',
      estimateUsd: 0.053457,
      event: expect.objectContaining({ default_budget_usd: 10, operation: 'comic.image.page', provider: 'openrouter', model: 'nb', estimated_ct: 700, billable_usd: 0.07 })
    });
  });

  it('never lets caller metadata mark metered spend as platform overhead (platformPaid is stripped)', async () => {
    const rpc = fakeRpc();
    await tryReserveAllowance({ userId: 'u', reservationId: 'r2', estimateUsd: 0.05, event: { ...event, metadata: { platformPaid: true, route: '/x' } } });
    const sent = (vi.mocked(rpc.tryReserve).mock.calls[0] as unknown[])[0] as { event: { metadata: Record<string, unknown> } };
    expect(sent.event.metadata).toEqual({ route: '/x' });
  });

  it('reports newly crossed thresholds once', async () => {
    let pct = 25;
    fakeRpc({ tryReserve: vi.fn(async () => ({ governed: true, allowed: true, pct_used: pct, pct_left: 100 - pct })) });
    await tryReserveAllowance({ userId: 'u', reservationId: 'a', estimateUsd: 0.1, event });
    pct = 31;
    const out = await tryReserveAllowance({ userId: 'u', reservationId: 'b', estimateUsd: 0.1, event });
    expect(out).toMatchObject({ kind: 'reserved', crossedNow: [30] });
    pct = 32;
    expect(await tryReserveAllowance({ userId: 'u', reservationId: 'c', estimateUsd: 0.1, event })).toMatchObject({ crossedNow: [] });
  });

  it('denies, is ungoverned, or fails CLOSED (never throws)', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    fakeRpc({ tryReserve: vi.fn(async () => ({ governed: true, allowed: false, reason: 'USAGE_BUDGET_EXHAUSTED', pct_used: 99.6, pct_left: 0.4 })) });
    expect(await tryReserveAllowance({ userId: 'u', reservationId: 'r', estimateUsd: 0.2, event })).toEqual({ kind: 'denied', pctUsed: 99.6, pctLeft: 0.4, resetsAt: null });
    fakeRpc({ tryReserve: vi.fn(async () => ({ governed: true, allowed: false, period: 'monthly', pct_used: 100, pct_left: 0 })) });
    const monthly = await tryReserveAllowance({ userId: 'u', reservationId: 'r', estimateUsd: 0.2, event });
    expect(monthly).toMatchObject({ kind: 'denied', pctLeft: 0 });
    expect(monthly.kind === 'denied' && monthly.resetsAt).toMatch(/^\d{4}-\d{2}-01T00:00:00/);
    fakeRpc({ tryReserve: vi.fn(async () => ({ governed: false, allowed: true })) });
    expect(await tryReserveAllowance({ userId: 'u', reservationId: 'r', estimateUsd: 0.2, event })).toEqual({ kind: 'ungoverned', exempt: false });
    fakeRpc({ tryReserve: vi.fn(async () => ({ governed: false, exempt: true, allowed: true })) });
    expect(await tryReserveAllowance({ userId: 'u', reservationId: 'r', estimateUsd: 0.2, event })).toEqual({ kind: 'ungoverned', exempt: true });
    fakeRpc({ tryReserve: vi.fn(async () => { throw new Error('function usage_budget_try_reserve does not exist'); }) });
    expect(await tryReserveAllowance({ userId: 'u', reservationId: 'r', estimateUsd: 0.2, event })).toEqual({ kind: 'unavailable' });
    fakeRpc({ tryReserve: vi.fn(async () => null) });
    expect(await tryReserveAllowance({ userId: 'u', reservationId: 'r', estimateUsd: 0.2, event })).toEqual({ kind: 'unavailable' });
    err.mockRestore();
  });
});

describe('admin exemption', () => {
  const req = (over: Record<string, unknown>) => ({ user: { id: 'u', email: 'someone@example.com' }, ...over }) as unknown as Request;

  it('bootstrap owners and user_roles admins are exempt; the role lookup is cached', async () => {
    expect(await isUsageExemptAdmin(req({ user: { id: 'o', email: 'Owner@Example.com' } }))).toBe(true);
    expect(await isUsageExemptAdmin(req({ accessProfile: { isAdmin: true } }))).toBe(true);
    expect(await isUsageExemptAdmin(req({}))).toBe(false);
    roles.list = ['admin'];
    expect(await isUsageExemptAdmin(req({ user: { id: 'a2', email: 'x@example.com' } }))).toBe(true);
    await isUsageExemptAdmin(req({ user: { id: 'a2', email: 'x@example.com' } }));
    expect(roles.calls).toBe(2); // 'u' once, 'a2' once
  });
});

describe('user-facing messages (PERCENT only, honest hard stop)', () => {
  it('never mentions money and always offers the top-up / own-key path', () => {
    const lifetime = allowanceExhaustedMessage(null);
    expect(lifetime).toContain("You've used all of your DreamStream usage");
    expect(lifetime).toContain('top-up');
    expect(lifetime).toContain('Settings → API keys');
    expect(allowanceExhaustedMessage('2026-11-01T00:00:00.000Z')).toContain('November 1');
    expect(usageNotEnoughMessage(3.7)).toContain('about 3% left');
    expect(usageNotEnoughMessage(0.2)).toContain('less than 1% left');
    for (const m of [lifetime, usageNotEnoughMessage(12), USAGE_UNAVAILABLE_MESSAGE]) expect(m).not.toMatch(MONEY);
  });

  it('builds refusal details with no credit or dollar figures', () => {
    const d = buildAllowanceExhaustedDetails({ pctLeft: 0, canFallbackToByok: true, byokFallbackMode: 'ask' });
    expect(d).toMatchObject({ reason: 'usage_budget_exhausted', requiredCt: 0, availableCt: 0, resetAt: '', pctLeft: 0, canFallbackToByok: true });
    expect(d.options).toMatchObject({ canUpgrade: false, canAddCredits: false, canWaitForReset: false, recommendedAction: 'add_credits' });
    expect(d.message).toContain('top-up');
    const partial = buildAllowanceExhaustedDetails({ pctLeft: 4, canFallbackToByok: false, byokFallbackMode: 'ask' });
    expect(partial.message).toContain('about 4% left');
    const down = buildAllowanceExhaustedDetails({ pctLeft: 100, canFallbackToByok: false, byokFallbackMode: 'never', unavailable: true });
    expect(down).toMatchObject({ reason: 'usage_budget_unavailable', message: USAGE_UNAVAILABLE_MESSAGE });
  });

  it('emits info notices at 30/70, warn at 90, nothing for 100 — in percent', () => {
    const notices = allowanceCrossingNotices([30, 70, 90, 100]);
    expect(notices.map((n) => n.level)).toEqual(['info', 'info', 'warn']);
    expect(notices[0].message).toBe("You've used 30% of your DreamStream usage — about 70% left.");
    for (const n of notices) expect(n.message).not.toMatch(MONEY);
  });
});

describe('admin helpers', () => {
  it('lists budgets with dollars AND percent for the admin console', async () => {
    fakeRpc({
      adminList: vi.fn(async () => [
        { user_id: 'u1', email: 'a@example.com', has_row: true, exempt: false, budget_usd: 10, spent_usd: 7, inflight_usd: 0.5, period: 'lifetime' },
        { user_id: 'u2', email: null, has_row: true, exempt: true, budget_usd: 10, spent_usd: 50, inflight_usd: 0, period: 'lifetime' }
      ])
    });
    const rows = await listUsageBudgets(50);
    expect(rows[0]).toMatchObject({ userId: 'u1', budgetUsd: 10, spentUsd: 7, inflightUsd: 0.5, pctUsed: 75, pctLeft: 25, exhausted: false });
    expect(rows[1]).toMatchObject({ exempt: true, pctUsed: 0, exhausted: false });
  });

  it('validates admin patches', () => {
    expect(validateUsageBudgetPatch({ budgetUsd: 10, exempt: false, period: 'lifetime', note: 'beta' })).toBeNull();
    expect(validateUsageBudgetPatch({ budgetUsd: -1 })).toMatch(/between/);
    expect(validateUsageBudgetPatch({ budgetUsd: 5000 })).toMatch(/between/);
    expect(validateUsageBudgetPatch({ budgetUsd: '10' as unknown as number })).toMatch(/number/);
    expect(validateUsageBudgetPatch({ period: 'weekly' as never })).toMatch(/period/);
    expect(validateUsageBudgetPatch({ exempt: 'yes' as never })).toMatch(/exempt/);
    expect(validateUsageBudgetPatch({ note: 'x'.repeat(501) })).toMatch(/note/);
  });
});

describe('upsertUsageBudget (admin)', () => {
  beforeEach(() => {
    store.rows.clear();
    store.writes = [];
  });

  it("a new row counts the user's whole history (topping up never silently resets what they used)", async () => {
    const { before, after } = await upsertUsageBudget({ userId: 'tester-1', actorId: 'admin-1', patch: { budgetUsd: 15, note: '  beta top-up  ' } });
    expect(before).toBeNull();
    expect(after).toMatchObject({ user_id: 'tester-1', budget_usd: 15, period: 'lifetime', note: 'beta top-up', updated_by: 'admin-1' });
    expect(after.period_started_at).toBe('1970-01-01T00:00:00.000Z');
  });

  it('updates only the patched fields; resetPeriod starts a fresh window now', async () => {
    await upsertUsageBudget({ userId: 'tester-1', actorId: 'admin-1', patch: { budgetUsd: 10 } });
    const t0 = Date.now();
    const { before, after } = await upsertUsageBudget({ userId: 'tester-1', actorId: 'admin-2', patch: { exempt: true, resetPeriod: true } });
    expect(before).toMatchObject({ budget_usd: 10 });
    expect(before?.exempt).not.toBe(true);
    expect(after).toMatchObject({ budget_usd: 10, exempt: true, updated_by: 'admin-2' });
    expect(Date.parse(String(after.period_started_at))).toBeGreaterThanOrEqual(t0 - 5);
    expect(store.writes.at(-1)).toMatchObject({ op: 'update' });
    expect(store.writes.at(-1)?.row).not.toHaveProperty('budget_usd');
  });

  it('an id that is not an account is an honest 404, not a raw database error', async () => {
    await expect(upsertUsageBudget({ userId: 'ghost', actorId: 'admin-1', patch: { budgetUsd: 5 } })).rejects.toMatchObject({
      status: 404,
      message: 'No account with this user id.'
    });
  });
});
