// Platform model-spend allowance — a per-user monthly budget (USD) of PLATFORM-funded
// model usage (requests served on the server's OpenRouter/Gemini/NVIDIA keys; BYOK
// traffic never counts). The cap is a SERVER-ONLY number: users only ever see PERCENT
// used, never dollar amounts (admins see USD via /api/admin/usage/users).
//
// Spend is metered from `generation_cost_events` (the settlement path persists actual
// provider cost there), cached 60s per user, and optimistically bumped in-cache after
// each settlement so rapid-fire requests can't blow far past the cap between refreshes.
// Everything here is best-effort and fails OPEN: when metering is unavailable (no
// Supabase admin, transient query failure) the status reports `enabled: false` and no
// request is ever blocked because of it.

import { TtlCache } from '../lib/cache.js';
import { logger } from '../lib/logger.js';
import { getSupabaseAdmin } from './supabase.js';
import type { LimitExceededDetails } from '../../../shared/types/billing.js';
import type { CapabilityNotice } from '../../../apiTypes.js';

export type ByokFallbackMode = 'ask' | 'auto' | 'never';

export type BillingPrefs = {
  /** Master toggle: run platform-funded providers on the PLATFORM key while the allowance lasts. */
  usePlatformAllowance: boolean;
  /** What to do once the allowance is exhausted and the user has a BYOK key stored. */
  byokFallbackMode: ByokFallbackMode;
};

export const DEFAULT_BILLING_PREFS: BillingPrefs = {
  usePlatformAllowance: true,
  byokFallbackMode: 'ask'
};

export const isByokFallbackMode = (value: unknown): value is ByokFallbackMode =>
  value === 'ask' || value === 'auto' || value === 'never';

export type AllowanceStatus = {
  /** False when the feature is off (cap <= 0) OR metering is currently unavailable. */
  enabled: boolean;
  /** SERVER-ONLY — never serialize to clients. Users only ever see percentages. */
  capUsd: number;
  /** SERVER-ONLY — month-to-date platform spend. Never serialize to clients. */
  usedUsd: number;
  /** 0–100, clamped. */
  pctUsed: number;
  exhausted: boolean;
  /** First of the next UTC month (ISO). */
  resetsAt: string;
  /** Thresholds (of 30/70/90/100) already met. */
  crossed: number[];
};

/** Providers whose non-BYOK requests run on platform keys and count against the allowance. */
export const PLATFORM_FUNDED_PROVIDERS = ['openrouter', 'gemini', 'nvidia'] as const;
export type PlatformFundedProvider = (typeof PLATFORM_FUNDED_PROVIDERS)[number];

export const isPlatformFundedProvider = (provider: string): provider is PlatformFundedProvider =>
  (PLATFORM_FUNDED_PROVIDERS as readonly string[]).includes(provider);

export const ALLOWANCE_THRESHOLDS = [30, 70, 90, 100] as const;

const DEFAULT_CAP_USD = 5;

/** Monthly per-user cap from PLATFORM_MONTHLY_ALLOWANCE_USD (default $5; <= 0 disables). */
export const allowanceCapUsd = (): number => {
  const raw = (process.env.PLATFORM_MONTHLY_ALLOWANCE_USD ?? '').trim();
  if (!raw) return DEFAULT_CAP_USD;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : DEFAULT_CAP_USD;
};

export const allowanceEnabled = (): boolean => allowanceCapUsd() > 0;

// ---- Pure month/percentage math (exported for tests) -----------------------------

export const startOfCurrentUtcMonthIso = (now: Date = new Date()): string =>
  new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();

export const firstOfNextUtcMonthIso = (now: Date = new Date()): string =>
  new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)).toISOString();

export const allowancePctUsed = (usedUsd: number, capUsd: number): number => {
  if (!(capUsd > 0)) return 0;
  const pct = (usedUsd / capUsd) * 100;
  if (!Number.isFinite(pct) || pct <= 0) return 0;
  if (pct >= 100) return 100;
  return Math.round(pct * 10) / 10;
};

/** Which thresholds a usage percentage has met. */
export const thresholdsMet = (pct: number): number[] => ALLOWANCE_THRESHOLDS.filter((t) => pct >= t);

/** Which thresholds were newly crossed between two usage percentages. */
export const thresholdsCrossed = (pctBefore: number, pctAfter: number): number[] =>
  ALLOWANCE_THRESHOLDS.filter((t) => pctBefore < t && pctAfter >= t);

export const buildAllowanceStatus = (usedUsd: number, capUsd: number, now: Date = new Date()): AllowanceStatus => {
  const enabled = capUsd > 0;
  const safeUsed = Number(Math.max(0, usedUsd).toFixed(6));
  const pctUsed = enabled ? allowancePctUsed(safeUsed, capUsd) : 0;
  return {
    enabled,
    capUsd,
    usedUsd: safeUsed,
    pctUsed,
    exhausted: enabled && safeUsed >= capUsd,
    resetsAt: firstOfNextUtcMonthIso(now),
    crossed: enabled ? thresholdsMet(pctUsed) : []
  };
};

/** The USD a cost-event row contributes: coalesce(billable_usd, provider_cost_usd, 0). */
export const coalesceEventUsd = (row: Record<string, unknown>): number => {
  const billable = Number(row.billable_usd);
  if (row.billable_usd !== null && row.billable_usd !== undefined && Number.isFinite(billable)) return billable;
  const providerCost = Number(row.provider_cost_usd);
  if (row.provider_cost_usd !== null && row.provider_cost_usd !== undefined && Number.isFinite(providerCost)) {
    return providerCost;
  }
  return 0;
};

// ---- Month-to-date spend (injectable for tests, like providerUsage's sink) -------

type SpendQueryFn = (userId: string, sinceIso: string) => Promise<number>;

const SPEND_PAGE_SIZE = 1000;
const SPEND_MAX_PAGES = 10; // 10k events/user/month — past that we undercount slightly

const defaultSpendQuery: SpendQueryFn = async (userId, sinceIso) => {
  const admin = getSupabaseAdmin();
  let totalUsd = 0;
  for (let page = 0; page < SPEND_MAX_PAGES; page++) {
    const { data, error } = await admin
      .from('generation_cost_events')
      .select('billable_usd, provider_cost_usd')
      .eq('user_id', userId)
      .eq('is_byok', false)
      .gte('created_at', sinceIso)
      .range(page * SPEND_PAGE_SIZE, (page + 1) * SPEND_PAGE_SIZE - 1);
    if (error) throw new Error(error.message);
    for (const row of (data || []) as Array<Record<string, unknown>>) {
      totalUsd += coalesceEventUsd(row);
    }
    if (!data || data.length < SPEND_PAGE_SIZE) break;
  }
  return totalUsd;
};

let spendQuery: SpendQueryFn = defaultSpendQuery;

/** Test seam: swap how month-to-date platform spend is read (null restores default). */
export const setAllowanceSpendQuery = (fn: SpendQueryFn | null): void => {
  spendQuery = fn || defaultSpendQuery;
};

// ---- Cached status + optimistic bump ----------------------------------------------

const STATUS_TTL_MS = 60_000;
const statusCache = new TtlCache<AllowanceStatus>(STATUS_TTL_MS, 2000);

export const getAllowanceStatus = async (userId: string): Promise<AllowanceStatus> => {
  const capUsd = allowanceCapUsd();
  if (capUsd <= 0) return buildAllowanceStatus(0, capUsd);
  return statusCache.getOrSet(userId, async () => {
    try {
      const usedUsd = await spendQuery(userId, startOfCurrentUtcMonthIso());
      return buildAllowanceStatus(usedUsd, capUsd);
    } catch (err) {
      // Metering unavailable (no Supabase admin / transient failure) → report the
      // feature disabled for this 60s window instead of blocking generation.
      logger.warn('platform_allowance_status_failed', { message: (err as Error)?.message });
      return { ...buildAllowanceStatus(0, capUsd), enabled: false };
    }
  });
};

export type AllowanceBump = { pctBefore: number; pctAfter: number; crossedNow: number[] };

/**
 * Optimistically add settled platform spend to the cached status so back-to-back
 * requests can't overshoot the cap by much between 60s cache refreshes. No cached
 * entry → no-op (the next getAllowanceStatus reads fresh, settlement-inclusive data).
 */
export const bumpAllowanceCache = (userId: string, deltaUsd: number): AllowanceBump | null => {
  if (!(deltaUsd > 0)) return null;
  const cached = statusCache.get(userId);
  if (!cached || !cached.enabled) return null;
  const next = buildAllowanceStatus(cached.usedUsd + deltaUsd, cached.capUsd);
  statusCache.set(userId, next, STATUS_TTL_MS);
  return {
    pctBefore: cached.pctUsed,
    pctAfter: next.pctUsed,
    crossedNow: thresholdsCrossed(cached.pctUsed, next.pctUsed)
  };
};

// ---- Billing preferences (user_billing_prefs) -------------------------------------

const prefsCache = new TtlCache<BillingPrefs>(60_000, 2000);

export const getBillingPrefs = async (userId: string): Promise<BillingPrefs> =>
  prefsCache.getOrSet(userId, async () => {
    try {
      const { data, error } = await getSupabaseAdmin()
        .from('user_billing_prefs')
        .select('use_platform_allowance, byok_fallback_mode')
        .eq('user_id', userId)
        .maybeSingle();
      if (error || !data) return { ...DEFAULT_BILLING_PREFS };
      return {
        usePlatformAllowance: (data as Record<string, unknown>).use_platform_allowance !== false,
        byokFallbackMode: isByokFallbackMode((data as Record<string, unknown>).byok_fallback_mode)
          ? ((data as Record<string, unknown>).byok_fallback_mode as ByokFallbackMode)
          : DEFAULT_BILLING_PREFS.byokFallbackMode
      };
    } catch (err) {
      logger.warn('billing_prefs_load_failed', { message: (err as Error)?.message });
      return { ...DEFAULT_BILLING_PREFS };
    }
  });

export const setBillingPrefs = async (userId: string, patch: Partial<BillingPrefs>): Promise<BillingPrefs> => {
  const current = await getBillingPrefs(userId);
  const next: BillingPrefs = {
    usePlatformAllowance: patch.usePlatformAllowance ?? current.usePlatformAllowance,
    byokFallbackMode: patch.byokFallbackMode ?? current.byokFallbackMode
  };
  const { error } = await getSupabaseAdmin()
    .from('user_billing_prefs')
    .upsert(
      {
        user_id: userId,
        use_platform_allowance: next.usePlatformAllowance,
        byok_fallback_mode: next.byokFallbackMode,
        updated_at: new Date().toISOString()
      },
      { onConflict: 'user_id' }
    );
  if (error) throw new Error(error.message);
  prefsCache.set(userId, next);
  return next;
};

// ---- User-facing messaging (PERCENT ONLY — never USD) ------------------------------

const formatResetDate = (iso: string): string =>
  new Date(iso).toLocaleDateString('en-US', { month: 'long', day: 'numeric', timeZone: 'UTC' });

export const allowanceExhaustedMessage = (resetsAt: string): string =>
  `You've used 100% of your monthly DreamStream allowance — resets ${formatResetDate(resetsAt)}.`;

export const buildAllowanceExhaustedDetails = (input: {
  status: AllowanceStatus;
  canFallbackToByok: boolean;
  byokFallbackMode: ByokFallbackMode;
}): LimitExceededDetails => ({
  reason: 'platform_allowance_exhausted',
  requiredCt: 0,
  availableCt: 0,
  resetAt: input.status.resetsAt,
  // Stub usage block (this gate runs before any wallet read; the shape requires one).
  usage: {
    planTier: 'free',
    dailyGuardrailCt: 0,
    dailyUsedCt: 0,
    dailyRemainingCt: 0,
    monthlyResetAt: input.status.resetsAt,
    dailyResetAt: input.status.resetsAt
  },
  options: {
    canUpgrade: true,
    canAddCredits: false,
    canWaitForReset: true,
    paymentMethodRequired: false,
    recommendedAction: 'wait_for_reset'
  },
  message: allowanceExhaustedMessage(input.status.resetsAt),
  canFallbackToByok: input.canFallbackToByok,
  byokFallbackMode: input.byokFallbackMode
});

/** Notices for newly crossed 30/70/90 thresholds (100% is the block, not a notice). */
export const allowanceCrossingNotices = (crossedNow: number[], resetsAt: string): CapabilityNotice[] =>
  crossedNow
    .filter((t) => t === 30 || t === 70 || t === 90)
    .map((t) => ({
      tool: 'platform_allowance',
      level: t >= 90 ? ('warn' as const) : ('info' as const),
      message: `You've used ${t}% of your monthly DreamStream allowance — resets ${formatResetDate(resetsAt)}.`,
      at: new Date().toISOString()
    }));

/** Test-only: clear caches and restore the default spend query. */
export const __resetPlatformAllowance = (): void => {
  statusCache.clear();
  prefsCache.clear();
  spendQuery = defaultSpendQuery;
};
