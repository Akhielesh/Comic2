// Admin cost centre — where the money goes, on REAL data, with honest provenance.
//
//   buildCostCentreReport(rows, opts)  PURE: plain row arrays in → CostCentreReport out.
//                                      No I/O, no clock reads (now is passed in) → unit-tested.
//   loadCostCentreRows(days, now)      Loader: pages each table for the range (1,000 rows/page,
//                                      hard cap 50,000 rows/table), selecting only needed columns.
//   fetchCloudflareAnalytics(...)      Optional live Workers/R2 usage via the GraphQL Analytics
//                                      API when CF_ANALYTICS_API_TOKEN + CLOUDFLARE_ACCOUNT_ID exist.
//   streamCosts.ts                     Stream Studio's tab: measured DO / R2 / TURN month to date + the
//                                      rooms' usage counters (Analytics Engine) → report.stream and the
//                                      'stream' product row (marginal $ + list value). ADR 0007.
//   getCostCentreReport(days)          The route's entry point (60s cache, request-coalesced).
//
// Provenance (shown as badges in the UI):
//   measured  — AI provider $ as settled per call; email / connector counts × list price
//   estimated — Code Studio sandbox $ (retired, ADR 0005; history from studio_runs) from awake
//               time × Cloudflare Containers unit prices
//   fixed     — flat plan fees (docs/infrastructure/COST_RUNBOOK.md §1), amortized usd/30 per day

import type {
  AiModelRow,
  AiOperationRow,
  AiUserRow,
  CloudflareR2Row,
  CloudflareSection,
  CloudflareWorkerRow,
  ConnectorRow,
  CostCategory,
  CostCentreReport,
  CostDailyRow,
  CostRangeDays,
  CostSource,
  FixedCostRow,
  ProductRow,
  RevenueTierRow
} from '../../../shared/types/costCentre.js';
import { TtlCache } from '../lib/cache.js';
import { getConfiguredProviderBudget, type ProviderBudget } from '../lib/providerUsage.js';
import { getSupabaseAdmin } from './supabase.js';
import {
  buildStreamSection,
  fetchStreamAnalytics,
  namespaceLabelsFromEnv,
  streamVerdict,
  topNurseryIds,
  type StreamAnalytics
} from './streamCosts.js';

// ─── Constants (each documented with its source) ──────────────────────────────────────────

const DAY_MS = 86_400_000;
export const ROW_PAGE_SIZE = 1000;
export const ROW_HARD_CAP = 50_000;

/** Cloudflare Email Sending: 3,000/month included, then $0.35 per 1,000 (docs/email/cloudflare-email-cost-and-limits.md). */
export const EMAIL_FREE_MONTHLY = 3000;
export const EMAIL_USD_PER_1000 = 0.35;

/** Cloudflare Containers list prices on Workers Paid (COST_RUNBOOK.md §2.0, verified 2026-10). */
export const CONTAINER_UNIT_PRICES = {
  memoryPerGiBSecond: 0.0000025,
  vcpuPerSecond: 0.00002,
  diskPerGBSecond: 0.00000007
} as const;

/**
 * The retired Code Studio sandbox instance: the dreamstream-studio Worker ran instance_type
 * "standard-3" = 2 vCPU / 8 GiB / 16 GB (removed with ADR 0005; studio_runs keeps the history).
 * Memory + disk bill for every awake second; CPU bills only while busy, so we ASSUME 25% average
 * utilization (npm install bursts, then an idle dev server).
 */
export const STUDIO_INSTANCE = {
  type: 'standard-3',
  vcpu: 2,
  memoryGiB: 8,
  diskGB: 16,
  assumedCpuUtilization: 0.25
} as const;

export const STUDIO_USD_PER_AWAKE_SECOND =
  STUDIO_INSTANCE.memoryGiB * CONTAINER_UNIT_PRICES.memoryPerGiBSecond +
  STUDIO_INSTANCE.diskGB * CONTAINER_UNIT_PRICES.diskPerGBSecond +
  STUDIO_INSTANCE.vcpu * STUDIO_INSTANCE.assumedCpuUtilization * CONTAINER_UNIT_PRICES.vcpuPerSecond;

/** A run with no awake_seconds and no ended_at counts as live only if it started this recently. */
export const OPEN_RUN_MAX_MS = 2 * 60 * 60 * 1000;

/**
 * $ per upstream call for data-connector providers. Every metered provider is on a free tier
 * and the guardrail budgets in lib/providerUsage.ts keep calls under it, so the marginal price
 * is $0. Add a price here only when a provider moves to pay-as-you-go (e.g. Brave Search past
 * its monthly credit, Tavily past 1,000 credits/mo, CoinGecko on a paid plan).
 */
export const PRICE_PER_CALL: Readonly<Record<string, number>> = {};
export const pricePerCall = (provider: string): number => PRICE_PER_CALL[provider] ?? 0;

/** Flat monthly costs (COST_RUNBOOK.md §1, verified 2026-10-19). Amortized per day as usd / 30. */
export const FIXED_COSTS: ReadonlyArray<FixedCostRow & { source: CostSource }> = [
  {
    service: 'Cloudflare Workers',
    plan: 'Workers Paid',
    usdMonth: 5,
    source: 'fixed',
    note: 'Flat plan fee. Includes 10M requests, 25 GiB-h container memory, 375 vCPU-min and 200 GB-h disk a month, and unlocks Email Sending.'
  },
  {
    service: 'Backend container',
    plan: 'basic · sleeps after 15 min',
    usdMonth: 0.5,
    source: 'estimated',
    note: 'Billed only while awake: ~$0–1/mo at a few awake hours a day (midpoint shown). Exact figure lives in Cloudflare billing.'
  },
  {
    service: 'Supabase',
    plan: 'Free',
    usdMonth: 0,
    source: 'fixed',
    note: 'Under 500 MB DB / 1 GB storage. Pro would be $25/mo.'
  },
  {
    service: 'Cloudflare Pages',
    plan: 'Free',
    usdMonth: 0,
    source: 'fixed',
    note: 'Frontend hosting.'
  },
  {
    service: 'Cloudflare R2',
    plan: 'Free tier (10 GB)',
    usdMonth: 0,
    source: 'fixed',
    note: 'Live segments purged after 24h, recordings after 7d.'
  },
  {
    service: 'Railway',
    plan: 'Dormant (trial expired)',
    usdMonth: 0,
    source: 'fixed',
    note: 'Fallback backend host kept configured; nothing bills.'
  },
  {
    service: 'Durable Objects (Stream Studio rooms)',
    plan: 'Inside Workers Paid allowances',
    usdMonth: 0,
    source: 'estimated',
    note: 'Usage-billed past 1M requests, 400k GB-s and 50M rows written a month (account-wide); $0.15/M, $12.50/M GB-s, $1/M rows beyond. Live figures: Stream Studio tab.'
  },
  {
    service: 'Cloudflare Realtime TURN',
    plan: 'First 1,000 GB/month free (shared)',
    usdMonth: 0,
    source: 'estimated',
    note: 'On since 2026-10-22: $0.05/GB of relay egress past the free 1 TB; alert at $10/month. The baby monitor server relay costs DO requests, not bytes.'
  }
];

export const FIXED_MONTHLY_USD = FIXED_COSTS.reduce((sum, row) => sum + row.usdMonth, 0);

/** Plan tiers that never produce subscription revenue. */
const NON_REVENUE_TIERS = new Set(['free', 'custom', 'admin']);
const ACTIVE_SUB_STATUSES = new Set(['active', 'trialing']);
const DEAD_STRIPE_STATUSES = new Set(['canceled', 'incomplete_expired', 'unpaid']);

// ─── Input row shapes (exactly the columns the loader selects) ───────────────────────────

type Numeric = number | string | null | undefined;

export interface CostEventRow {
  user_id?: string | null;
  operation?: string | null;
  stage?: string | null;
  provider?: string | null;
  model?: string | null;
  provider_cost_usd?: Numeric;
  billable_usd?: Numeric;
  is_byok?: boolean | null;
  status?: string | null;
  created_at: string;
}

export interface LedgerRow {
  user_id?: string | null;
  entry_type: string;
  usd_delta?: Numeric;
  provider_cost_usd?: Numeric;
  billable_usd?: Numeric;
  operation?: string | null;
  provider?: string | null;
  model?: string | null;
  created_at: string;
}

export interface ProviderUsageLogRow {
  account_id: string;
  provider: string;
  day: string;
  calls: Numeric;
  errors: Numeric;
  blocked: Numeric;
}

export interface EmailLogRow {
  status: string;
  kind?: string | null;
  template?: string | null;
  created_at: string;
}

export interface StudioRunRow {
  user_id?: string | null;
  status?: string | null;
  started_at: string;
  ended_at?: string | null;
  awake_seconds?: Numeric;
}

export interface SubscriptionRow {
  plan_tier: string;
  status?: string | null;
  stripe_status?: string | null;
  stripe_subscription_id?: string | null;
}

export interface PlanRow {
  id: string;
  name?: string | null;
  monthly_price_usd: Numeric;
  is_active?: boolean | null;
}

export interface ProfileRow {
  id: string;
  email?: string | null;
  created_at?: string | null;
}

export interface TelemetryRow {
  user_id?: string | null;
  source?: string | null;
  created_at: string;
}

export interface ModelUsageRow {
  month: string;
  product: string;
  requests: Numeric;
}

export interface CostCentreRows {
  /** generation_cost_events, created_at in [prevFrom, to). */
  costEvents: CostEventRow[];
  /** token_ledger_entries (CREDIT_PURCHASE + BYOK_SETTLED), created_at in [from, to). */
  ledger: LedgerRow[];
  /** provider_usage_log delta rows, day in [prevFrom, to). */
  providerUsage: ProviderUsageLogRow[];
  /** email_log (sent/failed), created_at in [start of prevFrom's month, to) — the free tier is monthly. */
  emails: EmailLogRow[];
  /** studio_runs, started_at in [prevFrom, to). */
  studioRuns: StudioRunRow[];
  subscriptions: SubscriptionRow[];
  plans: PlanRow[];
  /** All profiles (id, email, created_at). */
  profiles: ProfileRow[];
  /** live_profiles count (Stream Studio members). */
  liveProfiles: number;
  /** telemetry_events with a user_id, created_at in [from, to). */
  telemetry: TelemetryRow[];
  /** model_usage_monthly rows for months overlapping [from, to). */
  modelUsage: ModelUsageRow[];
  /** Tables that hit ROW_HARD_CAP (partial data). */
  truncated: string[];
  /** Tables that could not be read (soft failures → honest notes). */
  failures?: string[];
}

export interface CostCentreBuildOptions {
  days: CostRangeDays;
  now: Date;
  budgetFor?: (provider: string) => ProviderBudget | null;
  cloudflare?: CloudflareSection;
  /** Stream Studio: live analytics (absent = not measured) and admin-only name lookups. */
  stream?: {
    analytics: StreamAnalytics | null;
    nurseryNames?: Map<string, { name: string; owner: string | null }>;
    namespaceLabels?: Record<string, string>;
    phase0Shipped?: boolean;
  };
}

// ─── Small helpers ─────────────────────────────────────────────────────────────────────────

const num = (value: unknown): number => {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : 0;
};

const hasNumber = (value: unknown): boolean =>
  value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value));

/** Round to `dp` decimals, normalising -0. */
const round = (n: number, dp = 4): number => {
  const r = Number(n.toFixed(dp));
  return r === 0 ? 0 : r;
};

const dayKeyOf = (ms: number): string => new Date(ms).toISOString().slice(0, 10);
const monthKeyOf = (ms: number): string => new Date(ms).toISOString().slice(0, 7);
const parseTs = (iso: string | null | undefined): number => (iso ? Date.parse(iso) : NaN);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** "$1,234" / "$12.34" / "$0.0123" / "$0" — for verdict and note strings. */
export const formatUsd = (usd: number): string => {
  if (!Number.isFinite(usd) || usd === 0) return '$0';
  const abs = Math.abs(usd);
  const sign = usd < 0 ? '-' : '';
  if (abs >= 100) return `${sign}$${Math.round(abs).toLocaleString('en-US')}`;
  if (abs >= 0.01) return `${sign}$${abs.toFixed(2)}`;
  return `${sign}$${abs.toPrecision(2)}`;
};

const plural = (n: number, word: string, pluralWord = `${word}s`) => `${n.toLocaleString('en-US')} ${n === 1 ? word : pluralWord}`;

export const parseCostRangeDays = (value: unknown): CostRangeDays => {
  const n = Number(value);
  return n === 7 || n === 30 || n === 90 ? n : 30;
};

export interface CostRange {
  days: CostRangeDays;
  /** Start of the first UTC day in range. */
  fromMs: number;
  /** Exclusive end: `now` (today is a partial day). */
  toMs: number;
  /** Previous period of equal length: [prevFromMs, fromMs). */
  prevFromMs: number;
  dayKeys: string[];
  prevDayKeys: string[];
}

export const computeCostRange = (days: CostRangeDays, now: Date): CostRange => {
  const nowMs = now.getTime();
  const todayStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const fromMs = todayStart - (days - 1) * DAY_MS;
  const prevFromMs = fromMs - days * DAY_MS;
  const dayKeys = Array.from({ length: days }, (_, i) => dayKeyOf(fromMs + i * DAY_MS));
  const prevDayKeys = Array.from({ length: days }, (_, i) => dayKeyOf(prevFromMs + i * DAY_MS));
  return { days, fromMs, toMs: nowMs, prevFromMs, dayKeys, prevDayKeys };
};

const startOfUtcMonthMs = (ms: number): number => {
  const d = new Date(ms);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
};

/** Platform-paid, settled generation event? (BYOK runs on the user's key; RESERVED/RELEASED never settled.) */
const isSettledPlatformEvent = (row: CostEventRow): boolean => {
  if (row.is_byok === true) return false;
  const status = String(row.status || 'SETTLED').toUpperCase();
  return status === 'SETTLED';
};

const eventProviderUsd = (row: { provider_cost_usd?: Numeric }): number => num(row.provider_cost_usd);
/** What the user was billed; falls back to provider cost (no markup) when billable is absent. */
const eventBillableUsd = (row: { billable_usd?: Numeric; provider_cost_usd?: Numeric }): number =>
  hasNumber(row.billable_usd) ? num(row.billable_usd) : num(row.provider_cost_usd);

export type ProductBucket = 'comic' | 'chat' | 'other';
/** Attribute an AI operation to a product by its prefix (see billingLedger operation names). */
export const productForOperation = (operation: string | null | undefined): ProductBucket => {
  const op = String(operation || '').toLowerCase();
  if (op.startsWith('assistant.') || op.startsWith('chat.')) return 'chat';
  if (op.startsWith('text.') || op.startsWith('image.') || op.startsWith('vision.') || op.startsWith('comic.')) return 'comic';
  return 'other';
};

/** Awake seconds for a sandbox run; null for an orphan (never closed, no awake time recorded). */
export const runAwakeSeconds = (run: StudioRunRow, nowMs: number): number | null => {
  if (hasNumber(run.awake_seconds)) return Math.max(0, num(run.awake_seconds));
  const started = parseTs(run.started_at);
  if (!Number.isFinite(started)) return null;
  const ended = parseTs(run.ended_at ?? null);
  if (Number.isFinite(ended)) return Math.max(0, (ended - started) / 1000);
  if (nowMs - started <= OPEN_RUN_MAX_MS) return Math.max(0, (nowMs - started) / 1000); // live right now
  return null;
};

/**
 * Per-email overage $ with the MONTHLY free tier applied: emails are counted in order within
 * each UTC calendar month; only those past EMAIL_FREE_MONTHLY cost $0.35/1,000. Returns $ per
 * UTC day. Rows must start at the beginning of the earliest month of interest.
 */
export const emailCostByDay = (emails: EmailLogRow[]): Map<string, { sent: number; usd: number }> => {
  const sent = emails
    .filter((e) => String(e.status).toLowerCase() === 'sent')
    .map((e) => parseTs(e.created_at))
    .filter((t) => Number.isFinite(t))
    .sort((a, b) => a - b);
  const perMonth = new Map<string, number>();
  const out = new Map<string, { sent: number; usd: number }>();
  for (const t of sent) {
    const month = monthKeyOf(t);
    const count = (perMonth.get(month) || 0) + 1;
    perMonth.set(month, count);
    const day = dayKeyOf(t);
    const cur = out.get(day) || { sent: 0, usd: 0 };
    cur.sent += 1;
    if (count > EMAIL_FREE_MONTHLY) cur.usd += EMAIL_USD_PER_1000 / 1000;
    out.set(day, cur);
  }
  return out;
};

const emptyDay = (day: string): CostDailyRow => ({ day, ai: 0, email: 0, containers: 0, connectors: 0, fixed: 0 });
const dayTotal = (row: CostDailyRow): number => row.ai + row.email + row.containers + row.connectors + row.fixed;

// ─── The pure aggregator ───────────────────────────────────────────────────────────────────

export const buildCostCentreReport = (rows: CostCentreRows, opts: CostCentreBuildOptions): CostCentreReport => {
  const range = computeCostRange(opts.days, opts.now);
  const { fromMs, toMs, prevFromMs, days } = range;
  const nowMs = opts.now.getTime();
  const budgetFor = opts.budgetFor ?? getConfiguredProviderBudget;
  const inCurrent = (ms: number) => ms >= fromMs && ms < toMs;
  const notes: string[] = [];

  // Daily buckets for both periods (the previous period only feeds the trend total).
  const current = new Map(range.dayKeys.map((d) => [d, emptyDay(d)]));
  const previous = new Map(range.prevDayKeys.map((d) => [d, emptyDay(d)]));
  const bucketFor = (dayKey: string): CostDailyRow | undefined => current.get(dayKey) ?? previous.get(dayKey);

  // ---- fixed: flat plan fees amortized per day -----------------------------------------
  const fixedPerDay = FIXED_MONTHLY_USD / 30;
  for (const row of current.values()) row.fixed = fixedPerDay;
  for (const row of previous.values()) row.fixed = fixedPerDay;

  // ---- AI: settled, platform-paid provider cost (measured) ------------------------------
  const userEmail = new Map(rows.profiles.map((p) => [p.id, p.email ?? null]));
  const byModel = new Map<string, AiModelRow>();
  const byOperation = new Map<string, AiOperationRow>();
  const byUser = new Map<string, AiUserRow>();
  const productAi = {
    comic: { usd: 0, events: 0, users: new Set<string>() },
    chat: { usd: 0, events: 0, users: new Set<string>() },
    other: { usd: 0, events: 0, users: new Set<string>() }
  };
  let aiProviderUsd = 0;
  let aiBillableUsd = 0;
  let platformEvents = 0;
  let unsettledEvents = 0;
  let unsettledUsd = 0;
  const activeUsers = new Set<string>();

  const noteAiEvent = (input: {
    provider?: string | null;
    model?: string | null;
    operation?: string | null;
    userId?: string | null;
    providerUsd: number;
    billableUsd: number;
    byok: boolean;
  }) => {
    const provider = String(input.provider || '').trim() || 'unknown';
    const model = String(input.model || '').trim() || 'unknown';
    const operation = String(input.operation || '').trim() || 'unknown';
    const modelKey = `${provider}\u0000${model}`;
    const m = byModel.get(modelKey) || { provider, model, events: 0, providerUsd: 0, billableUsd: 0, byok: 0, byokUsd: 0 };
    m.events += 1;
    if (input.byok) {
      m.byok += 1;
      m.byokUsd = (m.byokUsd || 0) + input.providerUsd;
    } else {
      m.providerUsd += input.providerUsd;
      m.billableUsd += input.billableUsd;
    }
    byModel.set(modelKey, m);

    const o = byOperation.get(operation) || { operation, events: 0, providerUsd: 0 };
    o.events += 1;
    if (!input.byok) o.providerUsd += input.providerUsd;
    byOperation.set(operation, o);

    const bucket = productAi[productForOperation(operation)];
    bucket.events += 1;
    if (!input.byok) bucket.usd += input.providerUsd;

    const userId = String(input.userId || '');
    if (userId) {
      const u = byUser.get(userId) || { userId, email: userEmail.get(userId) ?? null, events: 0, providerUsd: 0 };
      u.events += 1;
      if (!input.byok) u.providerUsd += input.providerUsd;
      byUser.set(userId, u);
      bucket.users.add(userId);
      activeUsers.add(userId);
    }
  };

  for (const row of rows.costEvents) {
    const t = parseTs(row.created_at);
    if (!Number.isFinite(t)) continue;
    if (row.is_byok === true) continue; // BYOK is counted from the ledger (BYOK_SETTLED) to avoid double counting
    const settled = isSettledPlatformEvent(row);
    if (inCurrent(t)) {
      if (row.user_id) activeUsers.add(String(row.user_id));
      if (!settled) {
        unsettledEvents += 1;
        unsettledUsd += eventProviderUsd(row);
        continue;
      }
      const providerUsd = eventProviderUsd(row);
      const billableUsd = eventBillableUsd(row);
      platformEvents += 1;
      aiProviderUsd += providerUsd;
      aiBillableUsd += billableUsd;
      noteAiEvent({ ...row, userId: row.user_id, providerUsd, billableUsd, byok: false });
      const bucket = current.get(dayKeyOf(t));
      if (bucket) bucket.ai += providerUsd;
    } else if (t >= prevFromMs && t < fromMs && settled) {
      const bucket = previous.get(dayKeyOf(t));
      if (bucket) bucket.ai += eventProviderUsd(row);
    }
  }

  // BYOK calls (users' own keys) + credit-pack revenue from the ledger.
  let byokEvents = 0;
  let byokProviderUsd = 0;
  let creditPurchasesUsd = 0;
  for (const row of rows.ledger) {
    const t = parseTs(row.created_at);
    if (!Number.isFinite(t) || !inCurrent(t)) continue;
    const type = String(row.entry_type || '').toUpperCase();
    if (type === 'BYOK_SETTLED') {
      byokEvents += 1;
      const usd = eventProviderUsd(row);
      byokProviderUsd += usd;
      noteAiEvent({ ...row, userId: row.user_id, providerUsd: usd, billableUsd: 0, byok: true });
    } else if (type === 'CREDIT_PURCHASE') {
      // billingLedger.addPurchasedCredits records usd_delta = +pack price (positive). Coupon
      // bonuses are recorded with usd 0 and are not revenue.
      const usd = num(row.usd_delta);
      if (usd > 0 && String(row.operation || '') !== 'coupon_bonus') creditPurchasesUsd += usd;
    }
  }

  // ---- email: monthly free tier, then $0.35/1,000 (measured counts × list price) ---------
  const emailDays = emailCostByDay(rows.emails);
  for (const [day, value] of emailDays) {
    const bucket = bucketFor(day);
    if (bucket) bucket.email += value.usd;
  }
  let emailSent = 0;
  let emailFailed = 0;
  let emailMonthToDate = 0;
  const monthStartMs = startOfUtcMonthMs(nowMs);
  for (const e of rows.emails) {
    const t = parseTs(e.created_at);
    if (!Number.isFinite(t)) continue;
    const status = String(e.status).toLowerCase();
    if (status === 'sent' && t >= monthStartMs && t < toMs) emailMonthToDate += 1;
    if (!inCurrent(t)) continue;
    if (status === 'sent') emailSent += 1;
    else if (status === 'failed') emailFailed += 1;
  }
  const emailUsd = range.dayKeys.reduce((sum, d) => sum + (current.get(d)?.email || 0), 0);

  // ---- containers: retired Code Studio sandbox (history; estimated from awake time) --------
  let runs = 0;
  let awakeSeconds = 0;
  let orphanRuns = 0;
  const runUsers = new Set<string>();
  for (const run of rows.studioRuns) {
    const t = parseTs(run.started_at);
    if (!Number.isFinite(t)) continue;
    const seconds = runAwakeSeconds(run, nowMs);
    const isCurrent = inCurrent(t);
    if (isCurrent) {
      runs += 1;
      if (run.user_id) {
        runUsers.add(String(run.user_id));
        activeUsers.add(String(run.user_id));
      }
    }
    if (seconds === null) {
      if (isCurrent) orphanRuns += 1;
      continue;
    }
    if (isCurrent) awakeSeconds += seconds;
    const bucket = bucketFor(dayKeyOf(t));
    if (bucket) bucket.containers += seconds * STUDIO_USD_PER_AWAKE_SECOND;
  }
  const containersUsd = awakeSeconds * STUDIO_USD_PER_AWAKE_SECOND;

  // ---- connectors: calls per provider vs guardrail budget (measured, $0 on free tiers) ----
  const connectorAgg = new Map<string, { calls: number; errors: number; blocked: number; perDay: Map<string, number> }>();
  const connectorAccounts = new Set<string>();
  const currentDays = new Set(range.dayKeys);
  for (const row of rows.providerUsage) {
    const day = String(row.day || '').slice(0, 10);
    const calls = num(row.calls);
    const provider = String(row.provider || '').trim() || 'unknown';
    const bucket = bucketFor(day);
    if (bucket) bucket.connectors += calls * pricePerCall(provider);
    if (!currentDays.has(day)) continue;
    const agg = connectorAgg.get(provider) || { calls: 0, errors: 0, blocked: 0, perDay: new Map<string, number>() };
    agg.calls += calls;
    agg.errors += num(row.errors);
    agg.blocked += num(row.blocked);
    agg.perDay.set(day, (agg.perDay.get(day) || 0) + calls);
    connectorAgg.set(provider, agg);
    const account = String(row.account_id || '');
    if (UUID_RE.test(account)) {
      connectorAccounts.add(account);
      activeUsers.add(account);
    }
  }
  const connectors: ConnectorRow[] = [...connectorAgg.entries()]
    .map(([provider, agg]) => {
      const budget = budgetFor(provider);
      const monthlyBudget = budget ? budget.perDay * 30 : null;
      const pctOfBudget = budget && monthlyBudget ? round(((agg.calls / days) * 30 * 100) / monthlyBudget, 1) : null;
      const peakDay = Math.max(0, ...agg.perDay.values());
      const peakDayPct = budget && budget.perDay > 0 ? round((peakDay / budget.perDay) * 100, 1) : null;
      return {
        provider,
        calls: agg.calls,
        errors: agg.errors,
        blocked: agg.blocked,
        monthlyBudget,
        pctOfBudget,
        peakDayPct,
        usd: round(agg.calls * pricePerCall(provider))
      };
    })
    .sort((a, b) => b.calls - a.calls || a.provider.localeCompare(b.provider));
  const connectorsUsd = connectors.reduce((sum, c) => sum + c.usd, 0);

  // ---- users -------------------------------------------------------------------------------
  const telemetryChatUsers = new Set<string>();
  for (const row of rows.telemetry) {
    const t = parseTs(row.created_at);
    if (!Number.isFinite(t) || !inCurrent(t) || !row.user_id) continue;
    activeUsers.add(String(row.user_id));
    if (String(row.source || '') === 'ai_chat') telemetryChatUsers.add(String(row.user_id));
  }
  const users = rows.profiles.length;

  // ---- revenue: MRR estimate from Stripe-backed paid subscriptions ------------------------
  const plansById = new Map(rows.plans.map((p) => [String(p.id).toLowerCase(), p]));
  const tierAgg = new Map<string, { paying: number; comped: number }>();
  for (const sub of rows.subscriptions) {
    const tier = String(sub.plan_tier || '').toLowerCase();
    if (!tier || NON_REVENUE_TIERS.has(tier)) continue;
    if (!ACTIVE_SUB_STATUSES.has(String(sub.status || '').toLowerCase())) continue;
    const hasStripe = Boolean(sub.stripe_subscription_id);
    // A Stripe subscription that died (canceled/unpaid) is neither revenue nor comped.
    if (hasStripe && DEAD_STRIPE_STATUSES.has(String(sub.stripe_status || '').toLowerCase())) continue;
    const agg = tierAgg.get(tier) || { paying: 0, comped: 0 };
    if (hasStripe) agg.paying += 1;
    else agg.comped += 1;
    tierAgg.set(tier, agg);
  }
  const tierIds = new Set<string>([
    ...rows.plans
      .filter((p) => !NON_REVENUE_TIERS.has(String(p.id).toLowerCase()) && p.is_active !== false)
      .map((p) => String(p.id).toLowerCase()),
    ...tierAgg.keys()
  ]);
  const byTier: RevenueTierRow[] = [...tierIds]
    .map((tier) => {
      const agg = tierAgg.get(tier) || { paying: 0, comped: 0 };
      const priceUsd = num(plansById.get(tier)?.monthly_price_usd);
      return { tier, subscribers: agg.paying, priceUsd, mrrUsd: round(agg.paying * priceUsd, 2), comped: agg.comped };
    })
    .sort((a, b) => b.mrrUsd - a.mrrUsd || a.priceUsd - b.priceUsd || a.tier.localeCompare(b.tier));
  const revenueMrrUsd = round(byTier.reduce((sum, t) => sum + t.mrrUsd, 0), 2);
  const compedTotal = byTier.reduce((sum, t) => sum + (t.comped || 0), 0);

  // ---- daily + totals ------------------------------------------------------------------------
  const roundDay = (row: CostDailyRow): CostDailyRow => ({
    day: row.day,
    ai: round(row.ai, 6),
    email: round(row.email, 6),
    containers: round(row.containers, 6),
    connectors: round(row.connectors, 6),
    fixed: round(row.fixed, 6)
  });
  const daily = range.dayKeys.map((d) => roundDay(current.get(d)!));
  const costUsd = [...current.values()].reduce((sum, row) => sum + dayTotal(row), 0);
  const prevCostUsd = [...previous.values()].reduce((sum, row) => sum + dayTotal(row), 0);
  const fixedUsd = fixedPerDay * days;
  const activeCount = activeUsers.size;

  const categories: CostCategory[] = [
    {
      id: 'ai',
      label: 'AI providers',
      usd: round(aiProviderUsd),
      source: 'measured',
      note: `${plural(platformEvents, 'settled platform call')}; provider-reported cost. Calls on users' own keys (BYOK) are not platform spend.`
    },
    {
      id: 'containers',
      label: 'Code Studio sandbox (retired)',
      usd: round(containersUsd),
      source: 'estimated',
      note: `${plural(runs, 'run')}, ${round(awakeSeconds / 3600, 2)}h awake × ${formatUsd(STUDIO_USD_PER_AWAKE_SECOND * 3600)}/h (standard-3 list price, 25% CPU assumed).`
    },
    {
      id: 'connectors',
      label: 'Data connectors',
      usd: round(connectorsUsd),
      source: 'measured',
      note: `${plural(connectors.reduce((s, c) => s + c.calls, 0), 'upstream call')} across ${plural(connectors.length, 'provider')}; all on free tiers ($0/call unless priced).`
    },
    {
      id: 'email',
      label: 'Email sending',
      usd: round(emailUsd),
      source: 'measured',
      note: `${plural(emailSent, 'email')} sent; first ${EMAIL_FREE_MONTHLY.toLocaleString('en-US')}/month free, then $${EMAIL_USD_PER_1000} per 1,000.`
    },
    {
      id: 'fixed',
      label: 'Fixed plans',
      usd: round(fixedUsd),
      source: 'fixed',
      note: `${formatUsd(FIXED_MONTHLY_USD)}/mo of plan fees amortized at ${formatUsd(fixedPerDay)}/day (Workers Paid $5 + ~$0.50 backend-container estimate).`
    }
  ];

  // ---- products cost-benefit ---------------------------------------------------------------
  const rangeMonths = new Set(range.dayKeys.map((d) => d.slice(0, 7)));
  const monthlyRequests = new Map<string, number>();
  for (const row of rows.modelUsage) {
    if (!rangeMonths.has(String(row.month))) continue;
    const product = String(row.product || '');
    monthlyRequests.set(product, (monthlyRequests.get(product) || 0) + num(row.requests));
  }
  const cfWorkers = opts.cloudflare?.workers || [];
  const liveWorker = cfWorkers.find((w) => w.script === 'dreamstream-live');
  const perMonth = (usd: number) => (usd / days) * 30;

  // Stream Studio: measured month to date + the rooms' counters (estimated), independent of billing.
  const stream = buildStreamSection({
    nowMs,
    range: { fromMs, toMs, prevFromMs, days },
    analytics: opts.stream?.analytics ?? null,
    cloudflare: opts.cloudflare,
    emailsMonthToDate: emailMonthToDate,
    emails: userEmail,
    nurseryNames: opts.stream?.nurseryNames,
    namespaceLabels: opts.stream?.namespaceLabels,
    phase0Shipped: opts.stream?.phase0Shipped
  });

  const comic = productAi.comic;
  const chat = productAi.chat;
  const chatMonthly = monthlyRequests.get('chat_studio') || 0;
  const chatUsers = new Set<string>([...chat.users, ...connectorAccounts, ...telemetryChatUsers]);
  const chatCost = chat.usd + connectorsUsd;
  // The whole-month counter also sees free-model chats that never create a cost event, but a
  // range can hold more AI events than a partially covered month's counter — take the larger.
  const chatFromCounter = chatMonthly > chat.events;
  const chatRequests = chatFromCounter ? chatMonthly : chat.events;
  const comicRequests = comic.events + (monthlyRequests.get('comic_studio') || 0);

  const products: ProductRow[] = [
    {
      id: 'comic',
      label: 'Comic Studio',
      costUsd: round(comic.usd),
      requests: comicRequests,
      users: comic.users.size,
      revenueUsd: null,
      note: 'AI calls with text./image./vision. operations (platform + BYOK).',
      verdict:
        comic.events === 0
          ? 'No Comic Studio AI requests in this period.'
          : comic.usd > 0
            ? `${formatUsd(comic.usd)} platform AI for ${plural(comic.events, 'request')} (${formatUsd(comic.usd / comic.events)} each).`
            : `${plural(comic.events, 'request')} at $0 platform cost — users' own keys or free models.`
    },
    {
      id: 'chat',
      label: 'Chat & Assistant',
      costUsd: round(chatCost),
      requests: chatRequests,
      users: chatUsers.size,
      revenueUsd: null,
      note:
        chatFromCounter
          ? 'Requests from model_usage_monthly (whole-month counter); cost = chat AI + data connectors.'
          : 'Requests = chat/assistant AI events; cost = chat AI + data connectors.',
      verdict:
        chatRequests === 0
          ? 'No chat requests recorded in this period.'
          : chatCost > 0
            ? `${formatUsd(chatCost)} for ${plural(chatRequests, 'request')} (${formatUsd(chatCost / chatRequests)} each).`
            : `${plural(chatRequests, 'request')} at $0 marginal cost — free models, BYOK and free-tier connectors.`
    },
    {
      id: 'stream',
      label: 'Stream Studio & Baby monitor',
      // Marginal: its share of the account's overage this month ($0 inside the free tiers).
      costUsd: round(stream.marginalUsd),
      // What the same usage is worth at list price (estimated) — the planning number.
      listValueUsd: round(stream.listValueUsd, 6),
      // Without Cloudflare analytics there is no request count: model_usage_monthly's
      // 'stream_studio' row was Code Studio's model calls (mislabelled), not Stream Studio.
      requests: liveWorker ? liveWorker.requests : 0,
      users: rows.liveProfiles,
      revenueUsd: null,
      note: stream.sources.graphql || stream.sources.analyticsEngine
        ? 'Infra: Durable Objects, R2, TURN and Worker requests (Cloudflare analytics, measured) + in-room usage counters (estimated). Marginal $ is month to date.'
        : 'Infra only: runs on the dreamstream-live Worker inside Workers Paid. Connect Cloudflare analytics for real figures.',
      verdict: `${streamVerdict(stream, formatUsd)} · ${plural(rows.liveProfiles, 'member')}.`
    },
    {
      id: 'code',
      label: 'Code Studio sandbox (retired)',
      costUsd: round(containersUsd),
      requests: runs,
      users: runUsers.size,
      revenueUsd: null,
      note: 'Retired (ADR 0005). History from studio_runs, estimated from awake time (standard-3 container).',
      verdict:
        runs === 0
          ? 'Retired — no sandbox runs in this period.'
          : `Retired — ${formatUsd(containersUsd)} for ${plural(runs, 'run')} in this period (~${formatUsd(perMonth(containersUsd))}/mo no longer spent).`
    }
  ];
  if (productAi.other.events > 0) {
    products.push({
      id: 'other',
      label: 'Other AI',
      costUsd: round(productAi.other.usd),
      requests: productAi.other.events,
      users: productAi.other.users.size,
      revenueUsd: null,
      note: 'AI operations without a product prefix.',
      verdict: `${formatUsd(productAi.other.usd)} for ${plural(productAi.other.events, 'request')}.`
    });
  }

  // ---- notes: every assumption and gap, in plain words ------------------------------------
  if (aiProviderUsd === 0) notes.push('No AI spend recorded in this period.');
  if (unsettledEvents > 0) {
    notes.push(
      `${plural(unsettledEvents, 'reserved/released AI event')} (${formatUsd(unsettledUsd)}) excluded — only settled calls count as spend.`
    );
  }
  if (byokEvents > 0) {
    notes.push(
      `${plural(byokEvents, 'AI call')} ran on users' own keys (${formatUsd(byokProviderUsd)} of provider cost they paid) — not platform spend.`
    );
  }
  if (runs > 0) notes.push(
    `Code Studio sandbox (retired) $ is an estimate at list price (${STUDIO_INSTANCE.type}: ${STUDIO_INSTANCE.memoryGiB} GiB, ${STUDIO_INSTANCE.diskGB} GB disk, ${STUDIO_INSTANCE.vcpu} vCPU at an assumed ${STUDIO_INSTANCE.assumedCpuUtilization * 100}% busy) before the Workers Paid included allowance — the real bill can be lower.`
  );
  if (orphanRuns > 0) notes.push(`${plural(orphanRuns, 'sandbox run')} never closed and recorded no awake time — excluded from the estimate.`);
  notes.push('Auth emails sent through the Supabase hook go straight to the email Worker and are not in email_log, so they are not counted.');
  notes.push("MRR is an estimate: paying (Stripe-backed, active/trialing) subscribers × the plan's monthly list price; annual billing and discounts are not modelled.");
  if (compedTotal > 0) {
    notes.push(`${plural(compedTotal, 'account')} on a paid tier without a Stripe subscription (admin override / comped) — excluded from MRR.`);
  }
  if (chatFromCounter) notes.push('Chat requests come from model_usage_monthly — a whole-month counter, so short ranges still show full-month totals.');
  for (const c of connectors) {
    if (c.blocked > 0) notes.push(`${c.provider} hit its budget guardrail ${plural(c.blocked, 'time')} — calls were refused to protect the free tier.`);
  }
  const r2Bytes = (opts.cloudflare?.r2 || []).reduce((sum, b) => sum + b.payloadBytes, 0);
  if (r2Bytes > 10 * 1024 ** 3) {
    const overGb = r2Bytes / 1024 ** 3 - 10;
    notes.push(`R2 holds ${(r2Bytes / 1024 ** 3).toFixed(1)} GB — ${overGb.toFixed(1)} GB over the free 10 GB (~${formatUsd(overGb * 0.015)}/mo, not included above).`);
  }
  const cfRequests = cfWorkers.reduce((sum, w) => sum + w.requests, 0);
  if (cfRequests > 0 && (cfRequests / days) * 30 > 10_000_000) {
    notes.push('Workers requests are running above the 10M/month included in Workers Paid — overage is not included above.');
  }
  if (stream.marginalUsd > 0) {
    notes.push(`Stream Studio owes ${formatUsd(stream.marginalUsd)} past the free allowances this month (its share of the account's overage) — not in the daily chart above; see the Stream Studio tab.`);
  }
  for (const table of rows.truncated) notes.push(`Row cap reached for ${table} (${ROW_HARD_CAP.toLocaleString('en-US')} rows) — its figures are partial.`);
  for (const failure of rows.failures || []) notes.push(`Could not read ${failure} — treated as empty.`);

  return {
    generatedAt: opts.now.toISOString(),
    range: { from: new Date(fromMs).toISOString(), to: new Date(toMs).toISOString(), days },
    totals: {
      costUsd: round(costUsd),
      prevCostUsd: round(prevCostUsd),
      aiProviderUsd: round(aiProviderUsd),
      aiBillableUsd: round(aiBillableUsd),
      aiMarginUsd: round(aiBillableUsd - aiProviderUsd),
      revenueMrrUsd,
      creditRevenueUsd: round(creditPurchasesUsd, 2),
      users,
      activeUsers: activeCount,
      costPerActiveUserUsd: activeCount > 0 ? round(costUsd / activeCount) : null
    },
    daily,
    categories,
    ai: {
      byModel: [...byModel.values()]
        .map((m) => ({ ...m, providerUsd: round(m.providerUsd), billableUsd: round(m.billableUsd), byokUsd: round(m.byokUsd || 0) }))
        .sort((a, b) => b.providerUsd - a.providerUsd || b.events - a.events),
      byOperation: [...byOperation.values()]
        .map((o) => ({ ...o, providerUsd: round(o.providerUsd) }))
        .sort((a, b) => b.providerUsd - a.providerUsd || b.events - a.events),
      topUsers: [...byUser.values()]
        .map((u) => ({ ...u, providerUsd: round(u.providerUsd) }))
        .sort((a, b) => b.providerUsd - a.providerUsd || b.events - a.events)
        .slice(0, 10),
      byokEvents,
      byokProviderUsd: round(byokProviderUsd)
    },
    connectors,
    email: { sent: emailSent, failed: emailFailed, monthToDate: emailMonthToDate, freeMonthly: EMAIL_FREE_MONTHLY, usd: round(emailUsd) },
    containers: {
      runs,
      awakeHours: round(awakeSeconds / 3600, 2),
      usd: round(containersUsd),
      note: `Estimated: awake time × ${formatUsd(STUDIO_USD_PER_AWAKE_SECOND * 3600)}/h (${STUDIO_INSTANCE.type} list price, ${STUDIO_INSTANCE.assumedCpuUtilization * 100}% CPU assumed), before the Workers Paid included allowance.`
    },
    fixed: FIXED_COSTS.map((row) => ({ ...row })),
    revenue: { byTier, creditPurchasesUsd: round(creditPurchasesUsd, 2) },
    products,
    cloudflare: opts.cloudflare ?? { configured: false },
    notes,
    stream
  };
};

// ─── Cloudflare GraphQL Analytics (optional, live) ─────────────────────────────────────────

export const CLOUDFLARE_GRAPHQL_URL = 'https://api.cloudflare.com/client/v4/graphql';
const CLOUDFLARE_TIMEOUT_MS = 8_000;
/** workersInvocationsAdaptive accepts at most ~one month per query; longer ranges are chunked. */
const CLOUDFLARE_MAX_CHUNK_MS = 30 * DAY_MS;

// Schema per developers.cloudflare.com/analytics/graphql-api/tutorials/querying-workers-metrics/
// (filter datetime_geq/_leq; sum requests/errors/subrequests; quantiles cpuTimeP50 in µs).
const WORKERS_QUERY = `query CostCentreWorkers($accountTag: string!, $start: Time!, $end: Time!) {
  viewer {
    accounts(filter: { accountTag: $accountTag }) {
      workersInvocationsAdaptive(limit: 1000, filter: { datetime_geq: $start, datetime_leq: $end }) {
        dimensions { scriptName }
        sum { requests errors subrequests }
        quantiles { cpuTimeP50 }
      }
    }
  }
}`;

// Schema per developers.cloudflare.com/r2/platform/metrics-analytics/ (r2StorageAdaptiveGroups).
const R2_QUERY = `query CostCentreR2($accountTag: string!, $start: Time!, $end: Time!) {
  viewer {
    accounts(filter: { accountTag: $accountTag }) {
      r2StorageAdaptiveGroups(limit: 1000, filter: { datetime_geq: $start, datetime_leq: $end }, orderBy: [datetime_DESC]) {
        dimensions { bucketName datetime }
        max { payloadSize objectCount }
      }
    }
  }
}`;

export interface CloudflareCredentials {
  token: string;
  accountId: string;
}

/** Credentials from env, or null when either var is missing. Values never leave this module. */
export const cloudflareCredentialsFromEnv = (env: NodeJS.ProcessEnv = process.env): CloudflareCredentials | null => {
  const token = String(env.CF_ANALYTICS_API_TOKEN || '').trim();
  const accountId = String(env.CLOUDFLARE_ACCOUNT_ID || '').trim();
  return token && accountId ? { token, accountId } : null;
};

type FetchLike = (input: string, init?: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal }) => Promise<{
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
}>;

const cloudflareGraphql = async (
  creds: CloudflareCredentials,
  query: string,
  variables: Record<string, string>,
  fetchImpl: FetchLike
): Promise<Record<string, unknown>> => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CLOUDFLARE_TIMEOUT_MS);
  try {
    const res = await fetchImpl(CLOUDFLARE_GRAPHQL_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${creds.token}`, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ query, variables: { accountTag: creds.accountId, ...variables } }),
      signal: controller.signal
    });
    const body = (await res.json().catch(() => ({}))) as { data?: unknown; errors?: Array<{ message?: string }> | null };
    if (!res.ok) throw new Error(`Cloudflare GraphQL HTTP ${res.status}${body.errors?.[0]?.message ? `: ${body.errors[0].message}` : ''}`);
    if (Array.isArray(body.errors) && body.errors.length > 0) throw new Error(`Cloudflare GraphQL: ${body.errors[0]?.message || 'query failed'}`);
    const account = (body.data as { viewer?: { accounts?: Array<Record<string, unknown>> } } | undefined)?.viewer?.accounts?.[0];
    return account || {};
  } catch (err) {
    const message = (err as Error)?.name === 'AbortError' ? `Cloudflare GraphQL timed out after ${CLOUDFLARE_TIMEOUT_MS / 1000}s` : (err as Error)?.message || 'request failed';
    // Never echo credentials: scrub anything token-like that an upstream error might reflect.
    throw new Error(message.split(creds.token).join('[redacted]').slice(0, 240));
  } finally {
    clearTimeout(timer);
  }
};

const DREAMSTREAM_SCRIPT = /^dreamstream/i;

/** Merge per-chunk Workers rows: sums add up; p50 CPU is request-weighted (approximate across chunks). */
export const mergeWorkerChunks = (chunks: Array<Array<Record<string, any>>>): { workers: CloudflareWorkerRow[]; excluded: number } => {
  const agg = new Map<string, { requests: number; errors: number; subrequests: number; cpuWeighted: number; cpuWeight: number }>();
  for (const rows of chunks) {
    for (const row of rows) {
      const script = String(row?.dimensions?.scriptName || '').trim();
      if (!script) continue;
      const requests = num(row?.sum?.requests);
      const cur = agg.get(script) || { requests: 0, errors: 0, subrequests: 0, cpuWeighted: 0, cpuWeight: 0 };
      cur.requests += requests;
      cur.errors += num(row?.sum?.errors);
      cur.subrequests += num(row?.sum?.subrequests);
      if (hasNumber(row?.quantiles?.cpuTimeP50) && requests > 0) {
        cur.cpuWeighted += num(row.quantiles.cpuTimeP50) * requests;
        cur.cpuWeight += requests;
      }
      agg.set(script, cur);
    }
  }
  let excluded = 0;
  const workers: CloudflareWorkerRow[] = [];
  for (const [script, a] of agg) {
    if (!DREAMSTREAM_SCRIPT.test(script)) {
      excluded += 1;
      continue;
    }
    workers.push({
      script,
      requests: a.requests,
      errors: a.errors,
      subrequests: a.subrequests,
      // cpuTimeP50 is reported in microseconds.
      cpuP50Ms: a.cpuWeight > 0 ? round(a.cpuWeighted / a.cpuWeight / 1000, 2) : null
    });
  }
  workers.sort((a, b) => b.requests - a.requests || a.script.localeCompare(b.script));
  return { workers, excluded };
};

/** Latest storage sample per bucket. */
export const latestR2Storage = (rows: Array<Record<string, any>>): CloudflareR2Row[] => {
  const latest = new Map<string, { at: number; row: CloudflareR2Row }>();
  for (const r of rows) {
    const bucket = String(r?.dimensions?.bucketName || '').trim();
    if (!bucket) continue;
    const at = Date.parse(String(r?.dimensions?.datetime || '')) || 0;
    const cur = latest.get(bucket);
    if (cur && cur.at >= at) continue;
    latest.set(bucket, { at, row: { bucket, payloadBytes: num(r?.max?.payloadSize), objectCount: num(r?.max?.objectCount) } });
  }
  return [...latest.values()].map((v) => v.row).sort((a, b) => b.payloadBytes - a.payloadBytes);
};

export const fetchCloudflareAnalytics = async (input: {
  fromMs: number;
  toMs: number;
  creds?: CloudflareCredentials | null;
  fetchImpl?: FetchLike;
}): Promise<CloudflareSection> => {
  const creds = input.creds === undefined ? cloudflareCredentialsFromEnv() : input.creds;
  if (!creds) return { configured: false };
  const fetchImpl = input.fetchImpl ?? (fetch as unknown as FetchLike);

  const windows: Array<[number, number]> = [];
  for (let start = input.fromMs; start < input.toMs; start += CLOUDFLARE_MAX_CHUNK_MS) {
    windows.push([start, Math.min(input.toMs, start + CLOUDFLARE_MAX_CHUNK_MS)]);
  }
  const iso = (ms: number) => new Date(ms).toISOString();

  const [workersResult, r2Result] = await Promise.allSettled([
    Promise.all(
      windows.map(async ([start, end]) => {
        const account = await cloudflareGraphql(creds, WORKERS_QUERY, { start: iso(start), end: iso(end) }, fetchImpl);
        return (account.workersInvocationsAdaptive as Array<Record<string, any>>) || [];
      })
    ),
    cloudflareGraphql(creds, R2_QUERY, { start: iso(input.toMs - DAY_MS), end: iso(input.toMs) }, fetchImpl).then(
      (account) => (account.r2StorageAdaptiveGroups as Array<Record<string, any>>) || []
    )
  ]);

  if (workersResult.status === 'rejected') {
    return { configured: true, error: (workersResult.reason as Error)?.message || 'Cloudflare analytics unavailable' };
  }
  const { workers, excluded } = mergeWorkerChunks(workersResult.value);
  const section: CloudflareSection = { configured: true, workers, excludedScripts: excluded };
  // R2 is best-effort: a token without R2 analytics access still gets Workers numbers.
  if (r2Result.status === 'fulfilled') section.r2 = latestR2Storage(r2Result.value);
  return section;
};

// ─── Loader (Supabase, service role) ──────────────────────────────────────────────────────

type AnyQuery = any; // supabase-js builder; typed loosely so one pager serves every table

/**
 * Page a table in stable order (1,000 rows/page) up to ROW_HARD_CAP rows. Hitting the cap
 * records the table in `truncated` so the report says its figures are partial.
 */
const pageTable = async <T>(
  table: string,
  columns: string,
  apply: (q: AnyQuery) => AnyQuery,
  orderBy: string[],
  truncated: string[]
): Promise<T[]> => {
  const admin = getSupabaseAdmin();
  const out: T[] = [];
  for (let offset = 0; offset < ROW_HARD_CAP; offset += ROW_PAGE_SIZE) {
    let query = apply(admin.from(table).select(columns));
    for (const col of orderBy) query = query.order(col, { ascending: true });
    const { data, error } = await query.range(offset, offset + ROW_PAGE_SIZE - 1);
    if (error) throw new Error(error.message);
    const page = (data || []) as T[];
    out.push(...page);
    if (page.length < ROW_PAGE_SIZE) return out;
  }
  truncated.push(table);
  return out;
};

export const loadCostCentreRows = async (days: CostRangeDays, now: Date): Promise<CostCentreRows> => {
  const range = computeCostRange(days, now);
  const fromIso = new Date(range.fromMs).toISOString();
  const prevFromIso = new Date(range.prevFromMs).toISOString();
  const toIso = new Date(range.toMs).toISOString();
  const emailFromIso = new Date(startOfUtcMonthMs(range.prevFromMs)).toISOString();
  const truncated: string[] = [];
  const failures: string[] = [];

  // Every table degrades softly: an unreadable table becomes an honest note, not a 500.
  const soft = async <T>(label: string, load: () => Promise<T>, fallback: T): Promise<T> => {
    try {
      return await load();
    } catch (err) {
      failures.push(`${label} (${(err as Error)?.message || 'error'})`);
      return fallback;
    }
  };

  const admin = getSupabaseAdmin(); // throws a clear config error when the service role is missing

  const [costEvents, ledger, providerUsage, emails, studioRuns, subscriptions, plans, profiles, liveProfiles, telemetry, modelUsage] =
    await Promise.all([
      soft('generation_cost_events', () =>
        pageTable<CostEventRow>(
          'generation_cost_events',
          'user_id, operation, stage, provider, model, provider_cost_usd, billable_usd, is_byok, status, created_at',
          (q) => q.gte('created_at', prevFromIso).lt('created_at', toIso),
          ['created_at', 'id'],
          truncated
        ), []),
      soft('token_ledger_entries', () =>
        pageTable<LedgerRow>(
          'token_ledger_entries',
          'user_id, entry_type, usd_delta, provider_cost_usd, billable_usd, operation, provider, model, created_at',
          (q) => q.in('entry_type', ['CREDIT_PURCHASE', 'BYOK_SETTLED']).gte('created_at', fromIso).lt('created_at', toIso),
          ['created_at', 'id'],
          truncated
        ), []),
      soft('provider_usage_log', () =>
        pageTable<ProviderUsageLogRow>(
          'provider_usage_log',
          'account_id, provider, day, calls, errors, blocked',
          (q) => q.gte('day', range.prevDayKeys[0]).lte('day', range.dayKeys[range.dayKeys.length - 1]),
          ['day', 'id'],
          truncated
        ), []),
      soft('email_log', () =>
        pageTable<EmailLogRow>(
          'email_log',
          'status, kind, template, created_at',
          (q) => q.in('status', ['sent', 'failed']).gte('created_at', emailFromIso).lt('created_at', toIso),
          ['created_at', 'id'],
          truncated
        ), []),
      soft('studio_runs', () =>
        pageTable<StudioRunRow>(
          'studio_runs',
          'user_id, status, started_at, ended_at, awake_seconds',
          (q) => q.gte('started_at', prevFromIso).lt('started_at', toIso),
          ['started_at', 'id'],
          truncated
        ), []),
      soft('user_plan_subscriptions', () =>
        pageTable<SubscriptionRow>(
          'user_plan_subscriptions',
          'plan_tier, status, stripe_status, stripe_subscription_id',
          (q) => q,
          ['user_id'],
          truncated
        ), []),
      soft('billing_plans', () =>
        pageTable<PlanRow>('billing_plans', 'id, name, monthly_price_usd, is_active', (q) => q, ['id'], truncated), []),
      soft('profiles', () =>
        pageTable<ProfileRow>('profiles', 'id, email, created_at', (q) => q, ['created_at', 'id'], truncated), []),
      soft('live_profiles', async () => {
        const { count, error } = await admin.from('live_profiles').select('user_id', { count: 'exact', head: true });
        if (error) throw new Error(error.message);
        return count || 0;
      }, 0),
      soft('telemetry_events', () =>
        pageTable<TelemetryRow>(
          'telemetry_events',
          'user_id, source, created_at',
          (q) => q.not('user_id', 'is', null).gte('created_at', fromIso).lt('created_at', toIso),
          ['created_at', 'id'],
          truncated
        ), []),
      soft('model_usage_monthly', () =>
        pageTable<ModelUsageRow>(
          'model_usage_monthly',
          'month, product, requests',
          (q) => q.gte('month', range.dayKeys[0].slice(0, 7)).lte('month', range.dayKeys[range.dayKeys.length - 1].slice(0, 7)),
          ['month', 'product', 'source', 'model'],
          truncated
        ), [])
    ]);

  return {
    costEvents,
    ledger,
    providerUsage,
    emails,
    studioRuns,
    subscriptions,
    plans,
    profiles,
    liveProfiles,
    telemetry,
    modelUsage,
    truncated,
    failures
  };
};

/** Admin console only: the top nurseries' names and their owners' emails (soft — falls back to short ids). */
export const loadNurseryNames = async (ids: string[], profiles: ProfileRow[]): Promise<Map<string, { name: string; owner: string | null }>> => {
  const out = new Map<string, { name: string; owner: string | null }>();
  if (!ids.length) return out;
  try {
    const { data, error } = await getSupabaseAdmin().from('monitor_nurseries').select('id, name, owner_id').in('id', ids.slice(0, 50));
    if (error) return out;
    const email = new Map(profiles.map((p) => [p.id, p.email ?? null]));
    for (const n of (data || []) as Array<{ id: string; name?: string | null; owner_id?: string | null }>) {
      out.set(String(n.id), { name: String(n.name || '').slice(0, 60) || 'Nursery', owner: n.owner_id ? email.get(String(n.owner_id)) ?? null : null });
    }
  } catch {
    /* names are a convenience; ids still show */
  }
  return out;
};

// ─── Entry point ──────────────────────────────────────────────────────────────────────────

const reportCache = new TtlCache<CostCentreReport>(60_000, 6);

export const getCostCentreReport = async (days: CostRangeDays, options: { fresh?: boolean } = {}): Promise<CostCentreReport> => {
  const key = `days:${days}`;
  if (options.fresh) reportCache.delete(key);
  return reportCache.getOrSet(key, async () => {
    const now = new Date();
    const range = computeCostRange(days, now);
    const [rows, cloudflare, streamAnalytics] = await Promise.all([
      loadCostCentreRows(days, now),
      fetchCloudflareAnalytics({ fromMs: range.fromMs, toMs: range.toMs }).catch(
        (err): CloudflareSection => ({ configured: true, error: (err as Error)?.message || 'Cloudflare analytics unavailable' })
      ),
      // Stream Studio: ≤ 4 GraphQL queries + 1 Analytics Engine query, month to date. Never throws.
      fetchStreamAnalytics({ nowMs: now.getTime(), fromMs: range.prevFromMs }).catch((): StreamAnalytics | null => null)
    ]);
    const nurseryNames = await loadNurseryNames(topNurseryIds(streamAnalytics, range.fromMs, range.toMs), rows.profiles);
    return buildCostCentreReport(rows, {
      days,
      now,
      cloudflare,
      stream: {
        analytics: streamAnalytics,
        nurseryNames,
        namespaceLabels: namespaceLabelsFromEnv(),
        phase0Shipped: process.env.STREAM_PHASE0_SHIPPED === '1'
      }
    });
  });
};
