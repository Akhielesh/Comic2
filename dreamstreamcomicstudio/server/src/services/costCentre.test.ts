// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import {
  buildCostCentreReport,
  computeCostRange,
  emailCostByDay,
  fetchCloudflareAnalytics,
  FIXED_MONTHLY_USD,
  mergeWorkerChunks,
  parseCostRangeDays,
  productForOperation,
  runAwakeSeconds,
  STUDIO_USD_PER_AWAKE_SECOND,
  type CostCentreRows,
  type EmailLogRow
} from './costCentre.js';

const NOW = new Date('2026-10-21T12:00:00.000Z');
const U1 = '11111111-1111-4111-8111-111111111111';
const U2 = '22222222-2222-4222-8222-222222222222';
const U3 = '33333333-3333-4333-8333-333333333333';
const U4 = '44444444-4444-4444-8444-444444444444';
const tavilyBudget = (provider: string) => (provider === 'tavily' ? { perMin: 10, perDay: 35 } : null);

const emptyRows = (): CostCentreRows => ({
  costEvents: [],
  ledger: [],
  providerUsage: [],
  emails: [],
  studioRuns: [],
  subscriptions: [],
  plans: [],
  profiles: [],
  liveProfiles: 0,
  telemetry: [],
  modelUsage: [],
  truncated: []
});

const sentEmails = (n: number, at: string): EmailLogRow[] =>
  Array.from({ length: n }, () => ({ status: 'sent', kind: 'essential', template: 'x', created_at: at }));

const fixtureRows = (): CostCentreRows => ({
  costEvents: [
    // current period, settled, platform-paid
    { user_id: U1, operation: 'text.panel_breakdown', provider: 'openrouter', model: 'model-x', provider_cost_usd: 0.1, billable_usd: 0.13, is_byok: false, status: 'SETTLED', created_at: '2026-10-16T10:00:00Z' },
    { user_id: U2, operation: 'assistant.chat', provider: 'openrouter', model: 'model-y', provider_cost_usd: '0.05', billable_usd: null, is_byok: false, status: 'SETTLED', created_at: '2026-10-20T08:00:00Z' },
    // never settled → excluded from spend
    { user_id: U2, operation: 'image.openrouter.generate', provider: 'openrouter', model: 'img', provider_cost_usd: 0.02, billable_usd: null, is_byok: false, status: 'RESERVED', created_at: '2026-10-18T08:00:00Z' },
    // BYOK mirror in generation_cost_events → ignored (counted from the ledger instead)
    { user_id: U1, operation: 'text.extract_world', provider: 'openai', model: 'gpt', provider_cost_usd: 1, billable_usd: 0, is_byok: true, status: 'BYOK_SETTLED', created_at: '2026-10-17T08:00:00Z' },
    // previous period
    { user_id: U1, operation: 'text.analyze_script', provider: 'openrouter', model: 'model-x', provider_cost_usd: 0.3, billable_usd: 0.39, is_byok: false, status: 'SETTLED', created_at: '2026-10-10T08:00:00Z' }
  ],
  ledger: [
    { user_id: U1, entry_type: 'BYOK_SETTLED', usd_delta: 0, provider_cost_usd: 0.4, billable_usd: 0.5, operation: 'image.gemini.generate', provider: 'openrouter', model: 'model-x', created_at: '2026-10-19T08:00:00Z' },
    { user_id: U1, entry_type: 'CREDIT_PURCHASE', usd_delta: 10, operation: 'stripe_checkout_credit_pack', created_at: '2026-10-19T09:00:00Z' },
    { user_id: U2, entry_type: 'CREDIT_PURCHASE', usd_delta: 0, operation: 'coupon_bonus', created_at: '2026-10-19T09:00:00Z' }
  ],
  providerUsage: [
    { account_id: U1, provider: 'tavily', day: '2026-10-15', calls: 20, errors: 1, blocked: 0 },
    { account_id: 'anon', provider: 'tavily', day: '2026-10-16', calls: 30, errors: 0, blocked: 0 },
    { account_id: U2, provider: 'tavily', day: '2026-10-16', calls: 5, errors: 0, blocked: 2 },
    { account_id: U2, provider: 'example.com', day: '2026-10-17', calls: 3, errors: 0, blocked: 0 },
    { account_id: U2, provider: 'tavily', day: '2026-10-09', calls: 99, errors: 0, blocked: 0 } // previous period
  ],
  emails: [
    ...sentEmails(2999, '2026-10-01T08:00:00Z'), // before the range, same month → eats the free tier
    ...sentEmails(3, '2026-10-20T08:00:00Z'),
    { status: 'failed', created_at: '2026-10-20T09:00:00Z' }
  ],
  studioRuns: [
    { user_id: U3, started_at: '2026-10-18T09:00:00Z', ended_at: '2026-10-18T10:00:00Z', awake_seconds: 3600 },
    { user_id: U3, started_at: '2026-10-19T10:00:00Z', ended_at: '2026-10-19T10:30:00Z', awake_seconds: null },
    { user_id: U3, started_at: '2026-10-15T00:00:00Z', ended_at: null, awake_seconds: null }, // orphan
    { user_id: U1, started_at: '2026-10-21T11:30:00Z', ended_at: null, awake_seconds: null }, // live now
    { user_id: U3, started_at: '2026-10-12T00:00:00Z', ended_at: null, awake_seconds: 7200 } // previous period
  ],
  subscriptions: [
    { plan_tier: 'creator', status: 'active', stripe_status: 'active', stripe_subscription_id: 'sub_1' },
    { plan_tier: 'studio', status: 'trialing', stripe_status: 'trialing', stripe_subscription_id: 'sub_2' },
    { plan_tier: 'pro', status: 'active', stripe_status: null, stripe_subscription_id: null }, // comped
    { plan_tier: 'studio', status: 'active', stripe_status: 'canceled', stripe_subscription_id: 'sub_3' }, // dead
    { plan_tier: 'admin', status: 'active', stripe_status: null, stripe_subscription_id: null },
    { plan_tier: 'free', status: 'active', stripe_status: null, stripe_subscription_id: null }
  ],
  plans: [
    { id: 'free', monthly_price_usd: 0, is_active: true },
    { id: 'creator', monthly_price_usd: '11.99', is_active: true },
    { id: 'pro', monthly_price_usd: 49, is_active: false },
    { id: 'studio', monthly_price_usd: 39.99, is_active: true },
    { id: 'custom', monthly_price_usd: 0, is_active: true },
    { id: 'admin', monthly_price_usd: 0, is_active: true }
  ],
  profiles: [
    { id: U1, email: 'one@example.com' },
    { id: U2, email: 'two@example.com' },
    { id: U3, email: 'three@example.com' },
    { id: U4, email: 'four@example.com' }
  ],
  liveProfiles: 2,
  telemetry: [
    { user_id: U4, source: 'ai_chat', created_at: '2026-10-17T08:00:00Z' },
    { user_id: U4, source: 'client', created_at: '2026-10-01T08:00:00Z' } // outside range (loader wouldn't return it)
  ],
  modelUsage: [
    { month: '2026-10', product: 'chat_studio', requests: 40 },
    { month: '2026-09', product: 'chat_studio', requests: 99 }
  ],
  truncated: []
});

const build = (rows = fixtureRows(), days: 7 | 30 | 90 = 7) =>
  buildCostCentreReport(rows, { days, now: NOW, budgetFor: tavilyBudget, cloudflare: { configured: false } });

describe('cost centre — range + helpers', () => {
  it('builds N UTC day buckets ending today, plus an equal previous period', () => {
    const range = computeCostRange(7, NOW);
    expect(range.dayKeys).toEqual(['2026-10-15', '2026-10-16', '2026-10-17', '2026-10-18', '2026-10-19', '2026-10-20', '2026-10-21']);
    expect(range.prevDayKeys[0]).toBe('2026-10-08');
    expect(range.prevDayKeys[6]).toBe('2026-10-14');
    expect(range.toMs).toBe(NOW.getTime());
  });

  it('parses the days param defensively (default 30)', () => {
    expect(parseCostRangeDays('7')).toBe(7);
    expect(parseCostRangeDays(90)).toBe(90);
    expect(parseCostRangeDays('365')).toBe(30);
    expect(parseCostRangeDays(undefined)).toBe(30);
  });

  it('attributes operations to products by prefix', () => {
    expect(productForOperation('assistant.chat')).toBe('chat');
    expect(productForOperation('chat.completion')).toBe('chat');
    expect(productForOperation('text.panel_breakdown')).toBe('comic');
    expect(productForOperation('image.flux.generate')).toBe('comic');
    expect(productForOperation('mystery')).toBe('other');
  });

  it('derives sandbox awake time from awake_seconds, end time, or a live open run', () => {
    const now = NOW.getTime();
    expect(runAwakeSeconds({ started_at: '2026-10-21T00:00:00Z', awake_seconds: 42 }, now)).toBe(42);
    expect(runAwakeSeconds({ started_at: '2026-10-21T10:00:00Z', ended_at: '2026-10-21T10:10:00Z' }, now)).toBe(600);
    expect(runAwakeSeconds({ started_at: '2026-10-21T11:00:00Z' }, now)).toBe(3600);
    expect(runAwakeSeconds({ started_at: '2026-10-20T00:00:00Z' }, now)).toBeNull(); // orphan
  });
});

describe('cost centre — aggregation', () => {
  const report = build();
  const day = (key: string) => report.daily.find((d) => d.day === key)!;

  it('buckets each category into the right UTC day', () => {
    expect(report.daily).toHaveLength(7);
    expect(day('2026-10-16').ai).toBeCloseTo(0.1, 6);
    expect(day('2026-10-20').ai).toBeCloseTo(0.05, 6);
    expect(day('2026-10-18').ai).toBe(0); // RESERVED event is not spend
    expect(day('2026-10-17').ai).toBe(0); // BYOK is not platform spend
    expect(day('2026-10-18').containers).toBeCloseTo(3600 * STUDIO_USD_PER_AWAKE_SECOND, 6);
    expect(day('2026-10-19').containers).toBeCloseTo(1800 * STUDIO_USD_PER_AWAKE_SECOND, 6);
    expect(day('2026-10-21').containers).toBeCloseTo(1800 * STUDIO_USD_PER_AWAKE_SECOND, 6);
    expect(day('2026-10-20').email).toBeCloseTo(0.0007, 6);
    for (const row of report.daily) expect(row.fixed).toBeCloseTo(FIXED_MONTHLY_USD / 30, 6);
  });

  it('totals AI provider vs billable vs margin from settled platform events only', () => {
    expect(report.totals.aiProviderUsd).toBeCloseTo(0.15, 6);
    expect(report.totals.aiBillableUsd).toBeCloseTo(0.18, 6); // null billable falls back to provider cost
    expect(report.totals.aiMarginUsd).toBeCloseTo(0.03, 6);
    expect(report.ai.byokEvents).toBe(1);
    expect(report.ai.byokProviderUsd).toBeCloseTo(0.4, 6);
    const modelX = report.ai.byModel.find((m) => m.model === 'model-x')!;
    expect(modelX).toMatchObject({ provider: 'openrouter', events: 2, byok: 1 });
    expect(modelX.providerUsd).toBeCloseTo(0.1, 6);
    expect(report.ai.topUsers[0]).toMatchObject({ userId: U1, email: 'one@example.com', events: 2 });
    expect(report.notes.some((n) => n.includes('reserved/released'))).toBe(true);
  });

  it('computes the previous-period trend over an equal-length window', () => {
    const fixed7 = (FIXED_MONTHLY_USD / 30) * 7;
    const current = fixed7 + 0.15 + 7200 * STUDIO_USD_PER_AWAKE_SECOND + 0.0007;
    const previous = fixed7 + 0.3 + 7200 * STUDIO_USD_PER_AWAKE_SECOND;
    expect(report.totals.costUsd).toBeCloseTo(current, 3);
    expect(report.totals.prevCostUsd).toBeCloseTo(previous, 3);
    const categorySum = report.categories.reduce((s, c) => s + c.usd, 0);
    expect(categorySum).toBeCloseTo(report.totals.costUsd, 3);
  });

  it('applies the monthly email free tier (3,000) before billing $0.35/1,000', () => {
    expect(report.email).toMatchObject({ sent: 3, failed: 1, monthToDate: 3002, freeMonthly: 3000 });
    expect(report.email.usd).toBeCloseTo(0.0007, 6);
    // Under the free tier → $0.
    const under = emailCostByDay(sentEmails(10, '2026-10-20T08:00:00Z'));
    expect(under.get('2026-10-20')).toEqual({ sent: 10, usd: 0 });
    // The tier resets each calendar month.
    const twoMonths = emailCostByDay([...sentEmails(3000, '2026-09-30T08:00:00Z'), ...sentEmails(5, '2026-10-01T08:00:00Z')]);
    expect(twoMonths.get('2026-10-01')?.usd).toBe(0);
  });

  it('estimates sandbox cost from awake time and flags orphan runs', () => {
    expect(report.containers.runs).toBe(4);
    expect(report.containers.awakeHours).toBeCloseTo(2, 6);
    expect(report.containers.usd).toBeCloseTo(7200 * STUDIO_USD_PER_AWAKE_SECOND, 3);
    expect(report.categories.find((c) => c.id === 'containers')?.source).toBe('estimated');
    expect(report.notes.some((n) => n.includes('never closed'))).toBe(true);
    const code = report.products.find((p) => p.id === 'code')!;
    expect(code.requests).toBe(4);
    expect(code.verdict).toMatch(/retiring it saves ~\$\d/);
  });

  it('reports connector calls vs guardrail budget (monthly run-rate and peak day)', () => {
    const tavily = report.connectors.find((c) => c.provider === 'tavily')!;
    expect(tavily).toMatchObject({ calls: 55, errors: 1, blocked: 2, monthlyBudget: 1050, usd: 0 });
    expect(tavily.pctOfBudget).toBeCloseTo(((55 / 7) * 30 * 100) / 1050, 1);
    expect(tavily.peakDayPct).toBe(100);
    const unknown = report.connectors.find((c) => c.provider === 'example.com')!;
    expect(unknown.monthlyBudget).toBeNull();
    expect(unknown.pctOfBudget).toBeNull();
    expect(report.notes.some((n) => n.startsWith('tavily hit its budget guardrail'))).toBe(true);
  });

  it('estimates MRR from Stripe-backed active/trialing subscriptions only', () => {
    expect(report.totals.revenueMrrUsd).toBeCloseTo(51.98, 2);
    const tiers = Object.fromEntries(report.revenue.byTier.map((t) => [t.tier, t]));
    expect(tiers.creator).toMatchObject({ subscribers: 1, priceUsd: 11.99, comped: 0 });
    expect(tiers.studio).toMatchObject({ subscribers: 1, priceUsd: 39.99 });
    expect(tiers.pro).toMatchObject({ subscribers: 0, comped: 1, mrrUsd: 0 });
    expect(tiers.admin).toBeUndefined();
    expect(tiers.free).toBeUndefined();
    expect(report.totals.creditRevenueUsd).toBe(10); // coupon bonus is not revenue
    expect(report.notes.some((n) => n.includes('excluded from MRR'))).toBe(true);
  });

  it('counts users, active users and cost per active user', () => {
    expect(report.totals.users).toBe(4);
    expect(report.totals.activeUsers).toBe(4); // U1 (AI), U2 (AI/connector), U3 (runs), U4 (telemetry)
    expect(report.totals.costPerActiveUserUsd).toBeCloseTo(report.totals.costUsd / 4, 3);
  });

  it('builds the product cost-benefit rows', () => {
    const byId = Object.fromEntries(report.products.map((p) => [p.id, p]));
    expect(byId.comic).toMatchObject({ requests: 2, users: 1 }); // panel_breakdown + BYOK image
    expect(byId.comic.costUsd).toBeCloseTo(0.1, 6);
    expect(byId.chat.requests).toBe(40); // whole-month counter for 2026-10 only
    expect(byId.stream).toMatchObject({ costUsd: 0, users: 2 });
    expect(report.categories.map((c) => c.source)).toEqual(['measured', 'estimated', 'measured', 'measured', 'fixed']);
  });
});

describe('cost centre — empty + partial data', () => {
  it('is honest when nothing was recorded', () => {
    const report = build(emptyRows(), 30);
    expect(report.daily).toHaveLength(30);
    expect(report.totals.aiProviderUsd).toBe(0);
    expect(report.totals.activeUsers).toBe(0);
    expect(report.totals.costPerActiveUserUsd).toBeNull();
    expect(report.notes).toContain('No AI spend recorded in this period.');
    expect(report.totals.costUsd).toBeCloseTo(FIXED_MONTHLY_USD, 3); // 30 days of fixed fees
  });

  it('notes truncated and unreadable tables', () => {
    const rows = { ...emptyRows(), truncated: ['telemetry_events'], failures: ['studio_runs (boom)'] };
    const report = build(rows);
    expect(report.notes.some((n) => n.startsWith('Row cap reached for telemetry_events'))).toBe(true);
    expect(report.notes.some((n) => n.startsWith('Could not read studio_runs'))).toBe(true);
  });
});

describe('cost centre — Cloudflare analytics', () => {
  it('merges ≤30-day chunks: sums add, CPU p50 is request-weighted, non-DreamStream scripts are excluded', () => {
    const merged = mergeWorkerChunks([
      [
        { dimensions: { scriptName: 'dreamstream-api' }, sum: { requests: 100, errors: 1, subrequests: 10 }, quantiles: { cpuTimeP50: 2000 } },
        { dimensions: { scriptName: 'atlasd' }, sum: { requests: 5, errors: 0, subrequests: 0 }, quantiles: { cpuTimeP50: 1 } }
      ],
      [{ dimensions: { scriptName: 'dreamstream-api' }, sum: { requests: 300, errors: 2, subrequests: 30 }, quantiles: { cpuTimeP50: 4000 } }]
    ]);
    expect(merged.excluded).toBe(1);
    expect(merged.workers).toEqual([{ script: 'dreamstream-api', requests: 400, errors: 3, subrequests: 40, cpuP50Ms: 3.5 }]);
  });

  it('returns {configured:false} without credentials and makes no request', async () => {
    const fetchImpl = vi.fn();
    const section = await fetchCloudflareAnalytics({ fromMs: 0, toMs: 1000, creds: null, fetchImpl });
    expect(section).toEqual({ configured: false });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('chunks a 90-day range and reads R2 storage', async () => {
    const range = computeCostRange(90, NOW);
    const fetchImpl = vi.fn(async (_url: string, init?: { body?: string }) => {
      const body = JSON.parse(String(init?.body));
      const account = body.query.includes('r2StorageAdaptiveGroups')
        ? { r2StorageAdaptiveGroups: [{ dimensions: { bucketName: 'dreamstream-live', datetime: '2026-10-21T10:00:00Z' }, max: { payloadSize: 2048, objectCount: 3 } }] }
        : { workersInvocationsAdaptive: [{ dimensions: { scriptName: 'dreamstream-live' }, sum: { requests: 10, errors: 0, subrequests: 0 }, quantiles: { cpuTimeP50: 1000 } }] };
      return { ok: true, status: 200, json: async () => ({ data: { viewer: { accounts: [account] } }, errors: null }) };
    });
    const section = await fetchCloudflareAnalytics({ fromMs: range.fromMs, toMs: range.toMs, creds: { token: 't', accountId: 'a' }, fetchImpl });
    expect(fetchImpl).toHaveBeenCalledTimes(4); // 3 Workers chunks + 1 R2
    expect(section.configured).toBe(true);
    expect(section.workers?.[0]).toMatchObject({ script: 'dreamstream-live', requests: 30, cpuP50Ms: 1 });
    expect(section.r2).toEqual([{ bucket: 'dreamstream-live', payloadBytes: 2048, objectCount: 3 }]);
  });

  it('surfaces GraphQL errors without ever echoing the token', async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ data: null, errors: [{ message: 'not authorized for token SECRET-TOKEN-123' }] })
    }));
    const section = await fetchCloudflareAnalytics({ fromMs: 0, toMs: 1000, creds: { token: 'SECRET-TOKEN-123', accountId: 'a' }, fetchImpl });
    expect(section.configured).toBe(true);
    expect(section.error).toBeTruthy();
    expect(section.error).not.toContain('SECRET-TOKEN-123');
  });
});
