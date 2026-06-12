// Per-provider usage metering + budget guardrails for upstream data connectors.
//
// WHY: the AI agent decides when to call tools, so without a server-side governor a
// runaway loop (or a hot user) can silently burn a free-tier quota (Tavily 1k/mo,
// CoinGecko 10k/mo, …) or hammer fair-use endpoints. Every upstream fetch is
// metered by hostname → provider, checked against per-minute and per-day budgets,
// and counted (ok/error) so anomalies are visible in the dashboard and the logs.
//
// Budgets are deliberately set UNDER each provider's documented free-tier limits
// (June 2026 audit). Override any of them without a deploy via the PROVIDER_BUDGETS
// env var: JSON like {"tavily":{"perMin":10,"perDay":20}}.
//
// In-process and best-effort (resets on restart) — a guardrail, not billing-grade
// accounting. When a budget is hit the tool degrades to its next provider or an
// honest "budget reached" notice instead of calling upstream.

import { currentAccountId } from './accountContext.js';

const HOST_TO_PROVIDER: [RegExp, string][] = [
  [/api\.tavily\.com/, 'tavily'],
  [/api\.search\.brave\.com/, 'brave'],
  [/google\.serper\.dev/, 'serper'],
  [/googleapis\.com/, 'google-cse'],
  [/duckduckgo\.com/, 'duckduckgo'],
  [/bing\.com/, 'bing-scrape'],
  [/wikipedia\.org/, 'wikipedia'],
  [/api\.met\.no/, 'metno'],
  [/open-meteo\.com/, 'open-meteo'],
  [/nominatim\.openstreetmap\.org/, 'nominatim'],
  [/coingecko\.com/, 'coingecko'],
  [/frankfurter\.app/, 'frankfurter'],
  [/finance\.yahoo\.com|fc\.yahoo\.com/, 'yahoo'],
  [/stooq\.com/, 'stooq'],
  [/data\.alpaca\.markets/, 'alpaca'],
  [/ipinfo\.io/, 'ipinfo'],
  [/ip-api\.com/, 'ip-api']
];

export const providerForUrl = (url: string): string => {
  // SEARXNG_URL is user-configured, so match it explicitly before the host table.
  const sx = process.env.SEARXNG_URL;
  if (sx && url.startsWith(sx.replace(/\/$/, ''))) return 'searxng';
  for (const [re, name] of HOST_TO_PROVIDER) if (re.test(url)) return name;
  try {
    return new URL(url).hostname;
  } catch {
    return 'unknown';
  }
};

export interface ProviderBudget {
  perMin: number;
  perDay: number;
}

// Defaults sit under the documented free-tier limits with headroom for bursts.
const DEFAULT_BUDGETS: Record<string, ProviderBudget> = {
  searxng: { perMin: 60, perDay: 5000 }, // self-hosted — generous but bounded
  tavily: { perMin: 10, perDay: 35 }, // 1,000 credits/mo ≈ 33/day
  brave: { perMin: 10, perDay: 33 }, // $5 credit ≈ 1,000/mo
  serper: { perMin: 10, perDay: 50 }, // 2,500 one-time credits — spend slowly
  'google-cse': { perMin: 10, perDay: 90 }, // 100/day free
  duckduckgo: { perMin: 20, perDay: 1500 }, // scrape politeness
  'bing-scrape': { perMin: 10, perDay: 500 },
  wikipedia: { perMin: 60, perDay: 5000 },
  metno: { perMin: 60, perDay: 8000 }, // TOS soft cap 20 req/s — stay far under
  'open-meteo': { perMin: 20, perDay: 300 }, // non-commercial fallback — keep small
  nominatim: { perMin: 30, perDay: 2000 }, // TOS asks ~1 req/s
  coingecko: { perMin: 10, perDay: 300 }, // demo 10k/mo ≈ 330/day
  frankfurter: { perMin: 60, perDay: 4000 },
  yahoo: { perMin: 60, perDay: 5000 }, // unofficial — politeness cap
  stooq: { perMin: 30, perDay: 2000 },
  alpaca: { perMin: 150, perDay: 20000 }, // plan allows ~200/min
  ipinfo: { perMin: 60, perDay: 5000 },
  'ip-api': { perMin: 40, perDay: 1500 } // hard upstream cap is 45/min
};
const FALLBACK_BUDGET: ProviderBudget = { perMin: 60, perDay: 3000 };

let envOverrides: Record<string, Partial<ProviderBudget>> | null = null;
const budgetFor = (provider: string): ProviderBudget => {
  if (envOverrides === null) {
    try {
      envOverrides = process.env.PROVIDER_BUDGETS ? JSON.parse(process.env.PROVIDER_BUDGETS) : {};
    } catch {
      envOverrides = {};
    }
  }
  const base = DEFAULT_BUDGETS[provider] || FALLBACK_BUDGET;
  const o = envOverrides?.[provider];
  return { perMin: o?.perMin ?? base.perMin, perDay: o?.perDay ?? base.perDay };
};

interface ProviderStat {
  dayKey: string;
  dayCalls: number;
  dayErrors: number;
  blockedToday: number;
  minuteStamps: number[]; // call timestamps within the rolling minute
  lastCallAt: number;
  lastErrorAt: number;
  warned80: boolean;
}

const stats = new Map<string, ProviderStat>();
const dayKey = (now: number): string => new Date(now).toISOString().slice(0, 10);

// ---------------------------------------------------------------- cloud sink -----
// Account-wise usage, persisted to Supabase. We accumulate DELTAS per
// (account, provider, day) in memory and append them to provider_usage_log every
// flush — append-only inserts are race-free across instances/restarts; daily
// totals come from the provider_usage_daily view (SUM over deltas). Fully
// best-effort: no admin client / table → counted in memory only, never throws.
interface UsageDelta {
  account_id: string;
  provider: string;
  day: string;
  calls: number;
  errors: number;
  blocked: number;
}
const pendingDeltas = new Map<string, UsageDelta>();
const FLUSH_MS = 60_000;
let flusher: ReturnType<typeof setInterval> | null = null;
let cloudSink: ((rows: UsageDelta[]) => Promise<void>) | null = null;

/** Wire the cloud persistence sink (called once at server start; absent in tests). */
export const setUsageCloudSink = (sink: (rows: UsageDelta[]) => Promise<void>): void => {
  cloudSink = sink;
  if (!flusher) {
    flusher = setInterval(() => void flushUsageDeltas(), FLUSH_MS);
    flusher.unref?.();
  }
};

export const flushUsageDeltas = async (): Promise<void> => {
  if (!cloudSink || pendingDeltas.size === 0) return;
  const rows = [...pendingDeltas.values()];
  pendingDeltas.clear();
  try {
    await cloudSink(rows);
  } catch (err) {
    // Cloud write failed — restore the deltas so the next flush retries (merge with
    // anything accumulated meanwhile), and log once per flush, never throw.
    for (const r of rows) {
      const key = `${r.account_id}|${r.provider}|${r.day}`;
      const cur = pendingDeltas.get(key);
      if (cur) {
        cur.calls += r.calls;
        cur.errors += r.errors;
        cur.blocked += r.blocked;
      } else {
        pendingDeltas.set(key, r);
      }
    }
    console.warn(`[provider-usage] cloud flush failed (${(err as Error)?.message || 'unknown'}); will retry`);
  }
};

const noteAccountDelta = (provider: string, now: number, field: 'calls' | 'errors' | 'blocked'): void => {
  const account = currentAccountId() || 'anon';
  const day = dayKey(now);
  const key = `${account}|${provider}|${day}`;
  let d = pendingDeltas.get(key);
  if (!d) {
    d = { account_id: account, provider, day, calls: 0, errors: 0, blocked: 0 };
    pendingDeltas.set(key, d);
  }
  d[field] += 1;
};

const statFor = (provider: string, now: number): ProviderStat => {
  let s = stats.get(provider);
  const dk = dayKey(now);
  if (!s) {
    s = { dayKey: dk, dayCalls: 0, dayErrors: 0, blockedToday: 0, minuteStamps: [], lastCallAt: 0, lastErrorAt: 0, warned80: false };
    stats.set(provider, s);
  }
  if (s.dayKey !== dk) {
    // New UTC day — reset the daily window.
    s.dayKey = dk;
    s.dayCalls = 0;
    s.dayErrors = 0;
    s.blockedToday = 0;
    s.warned80 = false;
  }
  s.minuteStamps = s.minuteStamps.filter((t) => now - t < 60_000);
  return s;
};

export class ProviderBudgetError extends Error {
  constructor(public provider: string, public window: 'minute' | 'day') {
    super(`Provider budget reached for ${provider} (${window} cap) — skipping upstream call to protect the quota.`);
    this.name = 'ProviderBudgetError';
  }
}

/** Throws ProviderBudgetError when the call would exceed the provider's budget. */
export const assertProviderBudget = (url: string, now = Date.now()): void => {
  const provider = providerForUrl(url);
  const s = statFor(provider, now);
  const b = budgetFor(provider);
  if (s.minuteStamps.length >= b.perMin) {
    s.blockedToday += 1;
    noteAccountDelta(provider, now, 'blocked');
    console.warn(`[provider-usage] BLOCKED ${provider}: per-minute budget (${b.perMin}) reached`);
    throw new ProviderBudgetError(provider, 'minute');
  }
  if (s.dayCalls >= b.perDay) {
    s.blockedToday += 1;
    noteAccountDelta(provider, now, 'blocked');
    console.warn(`[provider-usage] BLOCKED ${provider}: daily budget (${b.perDay}) reached`);
    throw new ProviderBudgetError(provider, 'day');
  }
};

/** Record a completed upstream call (after the fetch resolves/throws). */
export const noteProviderCall = (url: string, ok: boolean, now = Date.now()): void => {
  const provider = providerForUrl(url);
  const s = statFor(provider, now);
  const b = budgetFor(provider);
  s.dayCalls += 1;
  s.minuteStamps.push(now);
  s.lastCallAt = now;
  noteAccountDelta(provider, now, 'calls');
  if (!ok) {
    s.dayErrors += 1;
    s.lastErrorAt = now;
    noteAccountDelta(provider, now, 'errors');
  }
  // One log line when a provider crosses 80% of its daily budget — the early-warning
  // anomaly signal ("why is the agent calling CoinGecko 250×today?").
  if (!s.warned80 && s.dayCalls >= b.perDay * 0.8) {
    s.warned80 = true;
    console.warn(`[provider-usage] ${provider} at ${s.dayCalls}/${b.perDay} daily calls (80%+) — check for runaway usage`);
  }
};

/** Convenience wrapper: budget-check, run, record. */
export const withProviderMeter = async <T>(url: string, run: () => Promise<T>): Promise<T> => {
  assertProviderBudget(url);
  try {
    const out = await run();
    noteProviderCall(url, true);
    return out;
  } catch (err) {
    if (!(err instanceof ProviderBudgetError)) noteProviderCall(url, false);
    throw err;
  }
};

export type ProviderHealth = 'ok' | 'hot' | 'failing' | 'near-cap' | 'capped';

export interface ProviderUsageRow {
  provider: string;
  todayCalls: number;
  todayErrors: number;
  blockedToday: number;
  lastMinute: number;
  perMin: number;
  perDay: number;
  /** 0–100, share of the daily budget used. */
  dayUsedPct: number;
  lastCallAt?: string;
  health: ProviderHealth;
}

/** Snapshot for the dashboard/ops endpoint — counts only, never keys or queries. */
export const getProviderUsageSnapshot = (now = Date.now()): ProviderUsageRow[] => {
  const rows: ProviderUsageRow[] = [];
  for (const [provider] of stats) {
    const s = statFor(provider, now);
    const b = budgetFor(provider);
    const lastMinute = s.minuteStamps.length;
    const dayUsedPct = Math.min(100, Math.round((s.dayCalls / b.perDay) * 100));
    const errRatio = s.dayCalls >= 5 ? s.dayErrors / s.dayCalls : 0;
    const health: ProviderHealth =
      s.dayCalls >= b.perDay
        ? 'capped'
        : dayUsedPct >= 80
          ? 'near-cap'
          : errRatio >= 0.5
            ? 'failing'
            : lastMinute >= b.perMin * 0.8
              ? 'hot'
              : 'ok';
    rows.push({
      provider,
      todayCalls: s.dayCalls,
      todayErrors: s.dayErrors,
      blockedToday: s.blockedToday,
      lastMinute,
      perMin: b.perMin,
      perDay: b.perDay,
      dayUsedPct,
      lastCallAt: s.lastCallAt ? new Date(s.lastCallAt).toISOString() : undefined,
      health
    });
  }
  return rows.sort((a, b2) => b2.todayCalls - a.todayCalls);
};

/** Test hook. */
export const __resetProviderUsage = (): void => {
  stats.clear();
  pendingDeltas.clear();
  envOverrides = null;
};

/** Test/inspection hook for the un-flushed account deltas. */
export const __pendingUsageDeltas = (): UsageDelta[] => [...pendingDeltas.values()];
