// Per-user USAGE BUDGET (P1-LIMITS) — one meter for platform-paid usage across every studio.
//
// Owner decision (2026-10-22): every non-admin user gets $10 total (lifetime, not monthly) of
// platform-paid usage across ALL studios combined. Admins are exempt; a user's own API keys
// (BYOK) never count; there are no daily caps. The basis is REAL provider cost
// (generation_cost_events.provider_cost_usd), not the 1.3x billable figure.
//
// Users never see dollars for the limit: only "usage left" as a percent plus friendly units
// ("about 150 standard comic pages left"), computed here from the real registry prices. The
// dollar figures (capUsd / usedUsd / admin listings) are SERVER-ONLY.
//
// Enforcement is ONE atomic database function (server/sql/user_usage_budgets.sql,
// usage_budget_try_reserve): a per-user advisory lock, spent + in-flight + estimate ≤ budget,
// and the RESERVED cost-event row inserted in the same transaction — so parallel comic page
// renders can never overshoot by more than one call's estimate error. It runs from
// services/usageEnforcer.ts after estimateCharge and before every provider call.
//
// Failure policy: a GOVERNED user fails CLOSED (database unreachable → the call is refused
// before anything is spent, with an honest message). Admins never reach the database check.
// The read-only status (meters, banners) fails soft: it reports `enabled:false` and the UI hides.
//
// This replaces the old $5/month "platform allowance" (PLATFORM_MONTHLY_ALLOWANCE_USD, billed
// basis, 60 s cache, fail-open). The exports other modules use keep their names.

import type { Request } from 'express';
import { METERING_ENABLED } from '../config.js';
import { TtlCache } from '../lib/cache.js';
import { logger } from '../lib/logger.js';
import { getSupabaseAdmin } from './supabase.js';
import { getUserRoles, isBootstrapAdminEmail } from './rbac.js';
import { PLAN_USD_PER_PAGE, tierPagePrice } from '../../../shared/comic/models.js';
import type { LimitExceededDetails } from '../../../shared/types/billing.js';
import type { CapabilityNotice } from '../../../apiTypes.js';

export type ByokFallbackMode = 'ask' | 'auto' | 'never';

export type BillingPrefs = {
  /** Master toggle: run platform-funded providers on the PLATFORM key while usage is left. */
  usePlatformAllowance: boolean;
  /** What to do once usage runs out and the user has a BYOK key stored. */
  byokFallbackMode: ByokFallbackMode;
};

export const DEFAULT_BILLING_PREFS: BillingPrefs = {
  usePlatformAllowance: true,
  byokFallbackMode: 'ask'
};

export const isByokFallbackMode = (value: unknown): value is ByokFallbackMode =>
  value === 'ask' || value === 'auto' || value === 'never';

export type BudgetPeriod = 'lifetime' | 'monthly';

export type AllowanceStatus = {
  /** False when metering is off OR the status is currently unavailable (UI hides). */
  enabled: boolean;
  /** True when this user's platform usage is limited (non-admin, not exempt). */
  governed: boolean;
  /** Admin-granted exemption row (no limit). */
  exempt: boolean;
  /** Pro quality / model picker allowed while Stripe billing is off (budget row flag). */
  allowPro: boolean;
  /** SERVER-ONLY — never serialize to users. */
  capUsd: number;
  /** SERVER-ONLY — settled + in-flight platform spend in the window. Never serialize to users. */
  usedUsd: number;
  /** 0–100, clamped. */
  pctUsed: number;
  /** 0–100, clamped (100 − pctUsed). */
  pctLeft: number;
  exhausted: boolean;
  period: BudgetPeriod;
  /** Next reset (monthly budgets only); null for lifetime budgets. */
  resetsAt: string | null;
  /** Thresholds (of 30/70/90/100) already met. */
  crossed: number[];
};

/** Providers whose non-BYOK requests run on platform keys (used by accountKeys key routing). */
export const PLATFORM_FUNDED_PROVIDERS = ['openrouter', 'gemini', 'nvidia'] as const;
export type PlatformFundedProvider = (typeof PLATFORM_FUNDED_PROVIDERS)[number];

export const isPlatformFundedProvider = (provider: string): provider is PlatformFundedProvider =>
  (PLATFORM_FUNDED_PROVIDERS as readonly string[]).includes(provider);

export const ALLOWANCE_THRESHOLDS = [30, 70, 90, 100] as const;

// ---- Config ------------------------------------------------------------------------------

const DEFAULT_BUDGET_USD = 10;
/** Hard ceiling an admin can set (typo guard: $10 000 instead of $10). The SQL check (≤ 100 000) is a looser backstop. */
export const MAX_BUDGET_USD = 1000;

let meteringOverride: boolean | null = null;

/** Metering (config METERING_ENABLED, default on) — independent of Stripe BILLING_ENABLED. */
export const meteringEnabled = (): boolean => meteringOverride ?? METERING_ENABLED;

/** Test seam: force metering on/off (null restores config). */
export const __setMeteringEnabledForTests = (value: boolean | null): void => {
  meteringOverride = value;
};

/**
 * The default budget for users without a `user_usage_budgets` row: PLATFORM_ALLOWANCE_DEFAULT_USD
 * (default $10, lifetime). <= 0 means "no default" — only users with a row are governed by a
 * budget; everyone else stays on the token wallet's own limits (never unlimited).
 */
export const defaultBudgetUsd = (): number => {
  const raw = (process.env.PLATFORM_ALLOWANCE_DEFAULT_USD ?? '').trim();
  if (!raw) return DEFAULT_BUDGET_USD;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? Math.min(parsed, MAX_BUDGET_USD) : DEFAULT_BUDGET_USD;
};

/** Back-compat alias (the old monthly cap). */
export const allowanceCapUsd = defaultBudgetUsd;

/** True while the usage meter runs (accountKeys uses this to keep the platform key in play). */
export const allowanceEnabled = (): boolean => meteringEnabled();

// ---- Pure math (exported for tests) --------------------------------------------------------

export const startOfCurrentUtcMonthIso = (now: Date = new Date()): string =>
  new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();

export const firstOfNextUtcMonthIso = (now: Date = new Date()): string =>
  new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)).toISOString();

export const allowancePctUsed = (usedUsd: number, capUsd: number): number => {
  if (!(capUsd > 0)) return usedUsd > 0 ? 100 : 0;
  const pct = (usedUsd / capUsd) * 100;
  if (!Number.isFinite(pct) || pct <= 0) return 0;
  if (pct >= 100) return 100;
  return Math.round(pct * 10) / 10;
};

const clampPct = (value: unknown, fallback = 0): number => {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(0, Math.min(100, Math.round(n * 10) / 10));
};

/** Which thresholds a usage percentage has met. */
export const thresholdsMet = (pct: number): number[] => ALLOWANCE_THRESHOLDS.filter((t) => pct >= t);

/** Which thresholds were newly crossed between two usage percentages. */
export const thresholdsCrossed = (pctBefore: number, pctAfter: number): number[] =>
  ALLOWANCE_THRESHOLDS.filter((t) => pctBefore < t && pctAfter >= t);

export const buildAllowanceStatus = (input: {
  usedUsd: number;
  capUsd: number;
  governed?: boolean;
  exempt?: boolean;
  allowPro?: boolean;
  period?: BudgetPeriod;
  now?: Date;
}): AllowanceStatus => {
  const governed = input.governed !== false;
  const period: BudgetPeriod = input.period === 'monthly' ? 'monthly' : 'lifetime';
  const capUsd = Math.max(0, Number(input.capUsd) || 0);
  const usedUsd = Number(Math.max(0, Number(input.usedUsd) || 0).toFixed(6));
  const pctUsed = governed ? allowancePctUsed(usedUsd, capUsd) : 0;
  return {
    enabled: true,
    governed,
    exempt: input.exempt === true,
    allowPro: input.allowPro === true,
    capUsd,
    usedUsd,
    pctUsed,
    pctLeft: Math.round((100 - pctUsed) * 10) / 10,
    exhausted: governed && usedUsd >= capUsd,
    period,
    resetsAt: period === 'monthly' ? firstOfNextUtcMonthIso(input.now) : null,
    crossed: governed ? thresholdsMet(pctUsed) : []
  };
};

/** Status for a user the budget does not govern (admins, exempt rows, metering off). */
export const ungovernedStatus = (opts: { enabled?: boolean; exempt?: boolean; allowPro?: boolean } = {}): AllowanceStatus => ({
  ...buildAllowanceStatus({ usedUsd: 0, capUsd: 0, governed: false, exempt: opts.exempt, allowPro: opts.allowPro }),
  enabled: opts.enabled !== false
});

/** The USD a cost-event row contributes to admin analytics: coalesce(billable_usd, provider_cost_usd, 0). */
export const coalesceEventUsd = (row: Record<string, unknown>): number => {
  const billable = Number(row.billable_usd);
  if (row.billable_usd !== null && row.billable_usd !== undefined && Number.isFinite(billable)) return billable;
  const providerCost = Number(row.provider_cost_usd);
  if (row.provider_cost_usd !== null && row.provider_cost_usd !== undefined && Number.isFinite(providerCost)) {
    return providerCost;
  }
  return 0;
};

// ---- Friendly units (server-side, from the real registry prices) ---------------------------

/** Provider cost of one Standard comic page: the 2K image + vision QC + the planning text. */
export const standardPageProviderUsd = (): number => tierPagePrice('standard', true) + PLAN_USD_PER_PAGE;
/** Provider cost of one Draft comic page. */
export const draftPageProviderUsd = (): number => tierPagePrice('draft', true) + PLAN_USD_PER_PAGE;

export type FriendlyUnits = {
  /** Standard comic pages the remaining usage covers (rounded down to a calm number). */
  standardPages: number;
  /** Draft comic pages the remaining usage covers. */
  draftPages: number;
  /** How much of the user's usage one Standard page takes, in percent (lets the client show quotes as "≈2%"). */
  pctPerStandardPage: number | null;
  /** One calm sentence, e.g. "about 150 standard comic pages left". */
  label: string;
};

/** Round DOWN to a calm number so the meter never over-promises (152 → 150, 47 → 45). */
export const calmCount = (n: number): number => {
  if (!Number.isFinite(n) || n <= 0) return 0;
  const whole = Math.floor(n);
  if (whole >= 100) return Math.floor(whole / 10) * 10;
  if (whole >= 20) return Math.floor(whole / 5) * 5;
  return whole;
};

export const friendlyUnitsFor = (remainingUsd: number, capUsd: number): FriendlyUnits => {
  const remaining = Math.max(0, Number(remainingUsd) || 0);
  const standard = standardPageProviderUsd();
  const draft = draftPageProviderUsd();
  const standardPages = calmCount(remaining / standard);
  const draftPages = calmCount(remaining / draft);
  const pctPerStandardPage = capUsd > 0 ? Math.round((standard / capUsd) * 100 * 100) / 100 : null;
  let label: string;
  if (standardPages >= 1) {
    label = `about ${standardPages} standard comic page${standardPages === 1 ? '' : 's'} left`;
  } else if (draftPages >= 1) {
    label = `enough for about ${draftPages} draft page${draftPages === 1 ? '' : 's'}`;
  } else if (remaining > 0) {
    label = 'a little left for chat and small edits';
  } else {
    label = 'no usage left';
  }
  return { standardPages, draftPages, pctPerStandardPage, label };
};

// ---- Database seam (injectable for tests; never a paid call) -------------------------------

export type BudgetReserveRpcArgs = {
  userId: string;
  reservationId: string;
  estimateUsd: number;
  event: Record<string, unknown>;
};

export type UsageBudgetRpc = {
  tryReserve(args: BudgetReserveRpcArgs): Promise<unknown>;
  status(userId: string, defaultUsd: number): Promise<unknown>;
  adminList(defaultUsd: number, limit: number): Promise<unknown[]>;
};

const supabaseBudgetRpc: UsageBudgetRpc = {
  async tryReserve(args) {
    const { data, error } = await getSupabaseAdmin().rpc('usage_budget_try_reserve', {
      p_user_id: args.userId,
      p_reservation_id: args.reservationId,
      p_estimate_usd: args.estimateUsd,
      p_event: args.event
    });
    if (error) throw new Error(error.message || 'usage_budget_try_reserve failed');
    return data;
  },
  async status(userId, defaultUsd) {
    const { data, error } = await getSupabaseAdmin().rpc('usage_budget_status', {
      p_user_id: userId,
      p_default: defaultUsd
    });
    if (error) throw new Error(error.message || 'usage_budget_status failed');
    return data;
  },
  async adminList(defaultUsd, limit) {
    const { data, error } = await getSupabaseAdmin().rpc('usage_budget_admin_list', {
      p_default: defaultUsd,
      p_limit: limit
    });
    if (error) throw new Error(error.message || 'usage_budget_admin_list failed');
    return Array.isArray(data) ? data : [];
  }
};

let budgetRpc: UsageBudgetRpc = supabaseBudgetRpc;

/** Test seam: swap the database calls (null restores Supabase). */
export const setUsageBudgetRpc = (impl: UsageBudgetRpc | null): void => {
  budgetRpc = impl || supabaseBudgetRpc;
};

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

// ---- Admin exemption --------------------------------------------------------------------------

const adminCache = new TtlCache<boolean>(60_000, 2000);

/**
 * Admins are exempt from the usage budget. Bootstrap owner emails + active `user_roles` admin
 * rows (cached 60 s). A failed role lookup counts as NOT admin, so the user stays governed.
 */
/** Structural view of an Express request (auth + requireAdmin augment Request with these). */
type UsageRequest = {
  user?: { id: string; email?: string };
  accessProfile?: { isAdmin?: boolean };
};

export const isUsageExemptAdmin = async (reqIn: Request | UsageRequest): Promise<boolean> => {
  const req = reqIn as UsageRequest;
  if (req?.accessProfile) return req.accessProfile.isAdmin === true;
  const userId = req?.user?.id;
  if (!userId) return false;
  if (isBootstrapAdminEmail(req.user?.email)) return true;
  try {
    return await adminCache.getOrSet(userId, async () => (await getUserRoles(userId)).includes('admin'));
  } catch {
    return false;
  }
};

// ---- Status (cached; fails soft) ---------------------------------------------------------------

const STATUS_TTL_MS = 60_000;
const statusCache = new TtlCache<AllowanceStatus>(STATUS_TTL_MS, 2000);

export const parseBudgetStatus = (raw: unknown, now: Date = new Date()): AllowanceStatus => {
  if (!isRecord(raw)) throw new Error('usage_budget_status returned no row');
  const period: BudgetPeriod = raw.period === 'monthly' ? 'monthly' : 'lifetime';
  if (raw.governed !== true) {
    return ungovernedStatus({ exempt: raw.exempt === true, allowPro: raw.allow_pro === true });
  }
  const capUsd = Math.max(0, Number(raw.budget_usd) || 0);
  const usedUsd = Math.max(0, Number(raw.spent_usd) || 0) + Math.max(0, Number(raw.inflight_usd) || 0);
  const status = buildAllowanceStatus({ usedUsd, capUsd, governed: true, allowPro: raw.allow_pro === true, period, now });
  // Trust the database's own percent when present (same formula, one source of truth).
  if (raw.pct_used !== undefined && raw.pct_used !== null) {
    const pctUsed = clampPct(raw.pct_used, status.pctUsed);
    return {
      ...status,
      pctUsed,
      pctLeft: Math.round((100 - pctUsed) * 10) / 10,
      exhausted: raw.exhausted === true || status.exhausted,
      crossed: thresholdsMet(pctUsed)
    };
  }
  return status;
};

/**
 * The user's usage status. `isAdmin` (when the caller knows it) short-circuits to ungoverned.
 * Never throws: an unavailable database reports `enabled:false` (UI hides; enforcement is
 * separate and fails closed).
 */
export const getAllowanceStatus = async (userId: string, opts: { isAdmin?: boolean } = {}): Promise<AllowanceStatus> => {
  if (!meteringEnabled()) return ungovernedStatus({ enabled: false });
  if (opts.isAdmin) return ungovernedStatus();
  try {
    return await statusCache.getOrSet(userId, async () => parseBudgetStatus(await budgetRpc.status(userId, defaultBudgetUsd())));
  } catch (err) {
    logger.warn('usage_budget_status_failed', { message: (err as Error)?.message });
    return { ...buildAllowanceStatus({ usedUsd: 0, capUsd: defaultBudgetUsd() }), enabled: false };
  }
};

/** Drop a user's cached status (after a reserve/settle/release or an admin change). */
export const invalidateAllowanceStatus = (userId: string): void => {
  statusCache.delete(userId);
};

/** Kept for callers of the old optimistic cache: the status is now re-read after each spend. */
export const bumpAllowanceCache = (userId: string, deltaUsd: number): null => {
  if (deltaUsd > 0) invalidateAllowanceStatus(userId);
  return null;
};

// ---- The atomic reserve ----------------------------------------------------------------------

export type BudgetReserveEvent = {
  projectId?: string;
  comicId?: string;
  operation: string;
  stage?: string;
  provider: string;
  model: string;
  estimatedCt?: number;
  billableUsd?: number;
  metadata?: Record<string, unknown>;
};

export type BudgetReserveOutcome =
  /**
   * No budget applies. `exempt` = an admin-granted "no limit" row (the wallet is skipped too);
   * otherwise there is simply no default budget and the token wallet's limits still apply.
   */
  | { kind: 'ungoverned'; exempt: boolean }
  | { kind: 'reserved'; pctUsed: number; pctLeft: number; crossedNow: number[] }
  /** `resetsAt`: next reset for a monthly budget row; null for lifetime usage (no reset). */
  | { kind: 'denied'; pctUsed: number; pctLeft: number; resetsAt: string | null }
  | { kind: 'unavailable' };

/**
 * Metered spend is never platform overhead: `metadata.platformPaid` (safety checks, the asset
 * library) excludes a cost-event row from the budget, so it must never ride along on a metered call.
 */
export const withoutPlatformPaid = (metadata?: Record<string, unknown> | null): Record<string, unknown> => {
  if (!metadata || typeof metadata !== 'object') return {};
  const { platformPaid: _dropped, ...rest } = metadata;
  return rest;
};

/** Last percent seen per user, so 30/70/90 notices fire once when a reserve crosses them. */
const lastPctCache = new TtlCache<number>(6 * 60 * 60_000, 5000);

/**
 * Reserve `estimateUsd` (provider cost) against the user's budget, atomically, BEFORE the
 * provider call. Never throws: database trouble is `unavailable`, which the caller must treat
 * as a refusal (fail closed).
 */
export const tryReserveAllowance = async (input: {
  userId: string;
  reservationId: string;
  estimateUsd: number;
  event: BudgetReserveEvent;
}): Promise<BudgetReserveOutcome> => {
  const estimateUsd = Number.isFinite(input.estimateUsd) && input.estimateUsd > 0 ? Number(input.estimateUsd.toFixed(6)) : 0;
  let raw: unknown;
  try {
    raw = await budgetRpc.tryReserve({
      userId: input.userId,
      reservationId: input.reservationId,
      estimateUsd,
      event: {
        default_budget_usd: defaultBudgetUsd(),
        project_id: input.event.projectId ?? null,
        comic_id: input.event.comicId ?? input.event.projectId ?? null,
        operation: input.event.operation,
        stage: input.event.stage ?? null,
        provider: input.event.provider,
        model: input.event.model,
        estimated_ct: Math.max(0, Math.floor(Number(input.event.estimatedCt) || 0)),
        billable_usd: Math.max(0, Number(input.event.billableUsd) || 0),
        metadata: withoutPlatformPaid(input.event.metadata)
      }
    });
  } catch (err) {
    logger.error('usage_budget_reserve_failed', { message: (err as Error)?.message, operation: input.event.operation });
    return { kind: 'unavailable' };
  }

  if (!isRecord(raw) || typeof raw.allowed !== 'boolean') {
    logger.error('usage_budget_reserve_malformed', { operation: input.event.operation });
    return { kind: 'unavailable' };
  }
  invalidateAllowanceStatus(input.userId);
  if (raw.governed !== true) return { kind: 'ungoverned', exempt: raw.exempt === true };

  const pctUsed = clampPct(raw.pct_used);
  const pctLeft = clampPct(raw.pct_left, Math.round((100 - pctUsed) * 10) / 10);
  if (!raw.allowed) {
    lastPctCache.set(input.userId, pctUsed);
    return { kind: 'denied', pctUsed, pctLeft, resetsAt: raw.period === 'monthly' ? firstOfNextUtcMonthIso() : null };
  }
  const before = lastPctCache.get(input.userId);
  lastPctCache.set(input.userId, pctUsed);
  return { kind: 'reserved', pctUsed, pctLeft, crossedNow: before === undefined ? [] : thresholdsCrossed(before, pctUsed) };
};

// ---- Billing preferences (user_billing_prefs) --------------------------------------------------

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

// ---- User-facing messaging (PERCENT ONLY — never USD) ------------------------------------------

const formatResetDate = (iso: string): string =>
  new Date(iso).toLocaleDateString('en-US', { month: 'long', day: 'numeric', timeZone: 'UTC' });

/** "about 12%" / "less than 1%" — never a dollar figure. */
export const formatPctLeft = (pctLeft: number): string => (pctLeft < 1 ? 'less than 1%' : `about ${Math.floor(pctLeft)}%`);

const OWN_KEY_PATH = 'add your own API key in Settings → API keys';

/** The honest hard stop. Lifetime budgets don't reset; monthly ones name the reset date. */
export const allowanceExhaustedMessage = (resetsAt?: string | null): string =>
  resetsAt
    ? `You've used all of this month's DreamStream usage. It comes back on ${formatResetDate(resetsAt)} — or ${OWN_KEY_PATH} to keep going now.`
    : `You've used all of your DreamStream usage. It doesn't reset on its own — ask us for a top-up, or ${OWN_KEY_PATH} to keep going.`;

/** Some usage is left, but not enough for this particular call. */
export const usageNotEnoughMessage = (pctLeft: number): string =>
  `This needs a bit more than the usage you have left (${formatPctLeft(pctLeft)} left). Try something lighter — like Draft quality or a shorter request — ask us for a top-up, or ${OWN_KEY_PATH}.`;

export const USAGE_UNAVAILABLE_MESSAGE = `We couldn't check your usage just now, so nothing was spent. Please try again in a moment — or ${OWN_KEY_PATH}.`;

const stubUsage = (resetAt: string) => ({
  planTier: 'free' as const,
  dailyGuardrailCt: 0,
  dailyUsedCt: 0,
  dailyRemainingCt: 0,
  monthlyResetAt: resetAt,
  dailyResetAt: resetAt
});

/**
 * Limit details for a budget refusal. `requiredCt`/`availableCt` stay 0 (credits are dollars in
 * disguise); the message and `pctLeft` are all the client needs.
 */
export const buildAllowanceExhaustedDetails = (input: {
  pctLeft: number;
  resetsAt?: string | null;
  canFallbackToByok: boolean;
  byokFallbackMode: ByokFallbackMode;
  unavailable?: boolean;
}): LimitExceededDetails => {
  const resetAt = input.resetsAt || '';
  const pctLeft = clampPct(input.pctLeft);
  const exhausted = pctLeft < 0.5;
  const message = input.unavailable
    ? USAGE_UNAVAILABLE_MESSAGE
    : exhausted
      ? allowanceExhaustedMessage(input.resetsAt)
      : usageNotEnoughMessage(pctLeft);
  return {
    reason: input.unavailable ? 'usage_budget_unavailable' : 'usage_budget_exhausted',
    requiredCt: 0,
    availableCt: 0,
    resetAt,
    usage: stubUsage(resetAt),
    options: {
      canUpgrade: false,
      canAddCredits: false,
      canWaitForReset: input.unavailable === true || Boolean(input.resetsAt),
      paymentMethodRequired: false,
      recommendedAction: input.unavailable || input.resetsAt ? 'wait_for_reset' : 'add_credits'
    },
    message,
    pctLeft,
    canFallbackToByok: input.canFallbackToByok,
    byokFallbackMode: input.byokFallbackMode
  };
};

/** Notices for newly crossed 30/70/90 thresholds (100% is the stop, not a notice). */
export const allowanceCrossingNotices = (crossedNow: number[]): CapabilityNotice[] =>
  crossedNow
    .filter((t) => t === 30 || t === 70 || t === 90)
    .map((t) => ({
      tool: 'usage_budget',
      level: t >= 90 ? ('warn' as const) : ('info' as const),
      message:
        t >= 90
          ? `You've used ${t}% of your DreamStream usage — about ${100 - t}% left. Ask us for a top-up or add your own API key in Settings → API keys when you need more.`
          : `You've used ${t}% of your DreamStream usage — about ${100 - t}% left.`,
      at: new Date().toISOString()
    }));

// ---- Admin (dollars allowed: served only behind requireAdmin) -----------------------------------

export type UsageBudgetAdminRow = {
  userId: string;
  email: string | null;
  hasRow: boolean;
  exempt: boolean;
  allowPro: boolean;
  budgetUsd: number;
  period: BudgetPeriod;
  periodStartedAt: string | null;
  spentUsd: number;
  inflightUsd: number;
  pctUsed: number;
  pctLeft: number;
  exhausted: boolean;
  note: string | null;
  updatedAt: string | null;
  lastUsedAt: string | null;
};

const num = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};
const strOrNull = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);

export const parseAdminBudgetRow = (raw: Record<string, unknown>): UsageBudgetAdminRow => {
  const budgetUsd = Math.max(0, num(raw.budget_usd));
  const spentUsd = Math.max(0, num(raw.spent_usd));
  const inflightUsd = Math.max(0, num(raw.inflight_usd));
  const exempt = raw.exempt === true;
  const pctUsed = exempt ? 0 : allowancePctUsed(spentUsd + inflightUsd, budgetUsd);
  return {
    userId: String(raw.user_id || ''),
    email: strOrNull(raw.email),
    hasRow: raw.has_row === true,
    exempt,
    allowPro: raw.allow_pro === true,
    budgetUsd,
    period: raw.period === 'monthly' ? 'monthly' : 'lifetime',
    periodStartedAt: strOrNull(raw.period_started_at),
    spentUsd: Number(spentUsd.toFixed(6)),
    inflightUsd: Number(inflightUsd.toFixed(6)),
    pctUsed,
    pctLeft: Math.round((100 - pctUsed) * 10) / 10,
    exhausted: !exempt && spentUsd + inflightUsd >= budgetUsd,
    note: strOrNull(raw.note),
    updatedAt: strOrNull(raw.updated_at),
    lastUsedAt: strOrNull(raw.last_used_at)
  };
};

export const listUsageBudgets = async (limit = 200): Promise<UsageBudgetAdminRow[]> => {
  const rows = await budgetRpc.adminList(defaultBudgetUsd(), Math.max(1, Math.min(1000, Math.floor(limit) || 200)));
  return rows.filter(isRecord).map(parseAdminBudgetRow);
};

export type UsageBudgetPatch = {
  budgetUsd?: number;
  exempt?: boolean;
  allowPro?: boolean;
  period?: BudgetPeriod;
  /** Start a fresh window now (spend before this moment stops counting). */
  resetPeriod?: boolean;
  note?: string | null;
};

const BUDGET_COLUMNS = 'user_id, budget_usd, period, period_started_at, exempt, allow_pro, note, updated_by, created_at, updated_at';
/**
 * A NEW row counts the user's whole history (like the no-row default), so creating a row to raise
 * someone's budget never silently resets what they already used. Only `resetPeriod` restarts it.
 */
const HISTORY_START_ISO = '1970-01-01T00:00:00.000Z';

/** Validate an admin patch; returns an error sentence or null. */
export const validateUsageBudgetPatch = (patch: UsageBudgetPatch): string | null => {
  if (patch.budgetUsd !== undefined) {
    if (typeof patch.budgetUsd !== 'number' || !Number.isFinite(patch.budgetUsd)) return 'budgetUsd must be a number.';
    if (patch.budgetUsd < 0 || patch.budgetUsd > MAX_BUDGET_USD) return `budgetUsd must be between 0 and ${MAX_BUDGET_USD}.`;
  }
  if (patch.exempt !== undefined && typeof patch.exempt !== 'boolean') return 'exempt must be true or false.';
  if (patch.allowPro !== undefined && typeof patch.allowPro !== 'boolean') return 'allowPro must be true or false.';
  if (patch.resetPeriod !== undefined && typeof patch.resetPeriod !== 'boolean') return 'resetPeriod must be true or false.';
  if (patch.period !== undefined && patch.period !== 'lifetime' && patch.period !== 'monthly') return "period must be 'lifetime' or 'monthly'.";
  if (patch.note !== undefined && patch.note !== null && (typeof patch.note !== 'string' || patch.note.length > 500)) {
    return 'note must be text up to 500 characters.';
  }
  return null;
};

/** Create or update a user's budget row. Returns the row before and after (for the audit log). */
export const upsertUsageBudget = async (input: {
  userId: string;
  actorId: string;
  patch: UsageBudgetPatch;
}): Promise<{ before: Record<string, unknown> | null; after: Record<string, unknown> }> => {
  const db = getSupabaseAdmin();
  const { data: existing, error: readError } = await db
    .from('user_usage_budgets')
    .select(BUDGET_COLUMNS)
    .eq('user_id', input.userId)
    .maybeSingle();
  if (readError) throw new Error(readError.message);

  const nowIso = new Date().toISOString();
  const p = input.patch;
  const changes: Record<string, unknown> = { updated_at: nowIso, updated_by: input.actorId };
  if (p.budgetUsd !== undefined) changes.budget_usd = Number(p.budgetUsd.toFixed(4));
  if (p.exempt !== undefined) changes.exempt = p.exempt;
  if (p.allowPro !== undefined) changes.allow_pro = p.allowPro;
  if (p.period !== undefined) changes.period = p.period;
  if (p.note !== undefined) changes.note = p.note ? p.note.trim().slice(0, 500) : null;
  if (p.resetPeriod) changes.period_started_at = nowIso;

  let after: Record<string, unknown> | null = null;
  if (existing) {
    const { data, error } = await db.from('user_usage_budgets').update(changes).eq('user_id', input.userId).select(BUDGET_COLUMNS).single();
    if (error) throw new Error(error.message);
    after = data as Record<string, unknown>;
  } else {
    const row = {
      user_id: input.userId,
      budget_usd: defaultBudgetUsd() > 0 ? defaultBudgetUsd() : DEFAULT_BUDGET_USD,
      period: 'lifetime',
      period_started_at: HISTORY_START_ISO,
      created_at: nowIso,
      ...changes
    };
    const { data, error } = await db.from('user_usage_budgets').insert(row).select(BUDGET_COLUMNS).single();
    if (error) {
      // auth.users FK: an id that isn't an account gets an honest 404, not a raw database error.
      if ((error as { code?: string }).code === '23503') {
        throw Object.assign(new Error('No account with this user id.'), { status: 404, publicMessage: 'No account with this user id.' });
      }
      throw new Error(error.message);
    }
    after = data as Record<string, unknown>;
  }
  invalidateAllowanceStatus(input.userId);
  return { before: (existing as Record<string, unknown> | null) || null, after: after || {} };
};

/** Test-only: clear caches and restore the default database seam. */
export const __resetPlatformAllowance = (): void => {
  statusCache.clear();
  prefsCache.clear();
  adminCache.clear();
  lastPctCache.clear();
  budgetRpc = supabaseBudgetRpc;
  meteringOverride = null;
};
