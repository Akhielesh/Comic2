import crypto from 'node:crypto';
import Stripe from 'stripe';
import type {
  BillingCouponEntitlement,
  BillingPlanDefinition,
  BillingSummaryResponse,
  BillingPlanTier,
  BillingUsageHistoryItem,
  ComicCostReport,
  LimitExceededDetails,
  LimitExceededResolutionOptions,
  ReservationState,
  TokenEstimateResponse,
  UsageLimitState,
  WalletBalance
} from '../../../shared/types/billing.js';
import { CT_USD, DEFAULT_MARKUP, getCreditPackByUsd, resolvePlanDefinition } from './pricingCatalog.js';
import { getSupabaseAdmin, supabase } from './supabase.js';
import { getActiveCouponEntitlementForUser } from './coupons.js';

type WalletRow = {
  user_id: string;
  plan_tier: BillingPlanTier;
  included_monthly_ct: number;
  used_monthly_ct: number;
  purchased_ct: number;
  reserved_ct: number;
  overage_ct: number;
  daily_guardrail_ct: number;
  used_daily_ct: number;
  daily_cycle_date: string;
  cycle_starts_at: string;
  cycle_ends_at: string;
  pending_overage_usd: number;
  auto_reload_enabled: boolean;
  auto_reload_threshold_ct: number;
  auto_reload_pack_usd: number;
  overage_hard_cap_usd: number;
  updated_at?: string;
  created_at?: string;
};

type PaymentProfile = {
  user_id: string;
  has_payment_method: boolean;
  overage_enabled: boolean;
  stripe_customer_id?: string | null;
  default_payment_method_id?: string | null;
  payment_method_brand?: string | null;
  payment_method_last4?: string | null;
};

type WalletEntitlementContext = {
  wallet: WalletRow;
  basePlan: BillingPlanDefinition;
  effectivePlan: BillingPlanDefinition;
  effectiveUsageSource: BillingSummaryResponse['effectiveUsageSource'];
  activeCouponEntitlement?: BillingCouponEntitlement;
  overageEnabledOverride?: boolean;
};

const inMemoryWallets = new Map<string, WalletRow>();
const autoReloadInFlight = new Set<string>();
const overageCaptureInFlight = new Set<string>();
const AUTO_RELOAD_POLICY_ENABLED = false;
const stripeSecretKey = process.env.STRIPE_SECRET_KEY || '';
const stripe = stripeSecretKey
  ? new Stripe(stripeSecretKey, { apiVersion: '2026-01-28.clover' })
  : null;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const asNumber = (value: unknown, fallback = 0) => {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
};

const toTier = (value: unknown): BillingPlanTier => {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : 'free';
  if (normalized === 'free' || normalized === 'creator' || normalized === 'pro' || normalized === 'studio' || normalized === 'custom' || normalized === 'admin') {
    return normalized;
  }
  return 'free';
};

const now = () => new Date();
const toIso = (value: Date) => value.toISOString();

const utcDateString = (value: Date) => {
  const year = value.getUTCFullYear();
  const month = String(value.getUTCMonth() + 1).padStart(2, '0');
  const day = String(value.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
};

const startOfUtcMonth = (value: Date) => new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), 1, 0, 0, 0, 0));
const nextUtcMonth = (value: Date) => new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth() + 1, 1, 0, 0, 0, 0));
const nextUtcDay = (value: Date) => new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate() + 1, 0, 0, 0, 0));

const isMissingTableError = (error: unknown) => {
  const code = String((error as { code?: string })?.code || '').toUpperCase();
  return code === '42P01' || code === 'PGRST205';
};

const createBillingBackendUnavailableError = (details?: unknown) => {
  const error = new Error('Billing backend unavailable. Configure Supabase service role and billing tables.') as Error & {
    status?: number;
    publicCode?: string;
    details?: unknown;
  };
  error.status = 503;
  error.publicCode = 'BILLING_BACKEND_UNAVAILABLE';
  error.details = details;
  return error;
};

const getBillingAdmin = () => {
  try {
    return getSupabaseAdmin();
  } catch (error) {
    throw createBillingBackendUnavailableError(error);
  }
};

const callTryReserveTokens = async (input: { userId: string; requiredCt: number; allowOverage: boolean }) => {
  const admin = getBillingAdmin();
  const { data, error } = await admin.rpc('billing_try_reserve_tokens', {
    p_user_id: input.userId,
    p_required_ct: input.requiredCt,
    p_allow_overage: input.allowOverage
  });

  if (error) {
    throw createBillingBackendUnavailableError(error);
  }

  inMemoryWallets.delete(input.userId);

  return (data || {}) as Record<string, unknown>;
};

const callReleaseReservedTokens = async (input: { userId: string; releaseCt: number }) => {
  const admin = getBillingAdmin();
  const { error } = await admin.rpc('billing_release_reserved_tokens', {
    p_user_id: input.userId,
    p_release_ct: input.releaseCt
  });

  if (error) {
    throw createBillingBackendUnavailableError(error);
  }

  inMemoryWallets.delete(input.userId);
};

const callSettleTokens = async (input: { userId: string; estimatedCt: number; actualCt: number }) => {
  const admin = getBillingAdmin();
  const { data, error } = await admin.rpc('billing_settle_tokens', {
    p_user_id: input.userId,
    p_estimated_ct: input.estimatedCt,
    p_actual_ct: input.actualCt,
    p_ct_usd: CT_USD
  });

  if (error) {
    throw createBillingBackendUnavailableError(error);
  }

  inMemoryWallets.delete(input.userId);

  return (data || {}) as Record<string, unknown>;
};

const makeWalletForTier = (userId: string, planTier: BillingPlanTier, at = now()): WalletRow => {
  const plan = resolvePlanDefinition(planTier);
  return {
    user_id: userId,
    plan_tier: plan.id,
    included_monthly_ct: plan.monthlyIncludedCt,
    used_monthly_ct: 0,
    purchased_ct: 0,
    reserved_ct: 0,
    overage_ct: 0,
    daily_guardrail_ct: plan.dailyGuardrailCt,
    used_daily_ct: 0,
    daily_cycle_date: utcDateString(at),
    cycle_starts_at: toIso(startOfUtcMonth(at)),
    cycle_ends_at: toIso(nextUtcMonth(at)),
    pending_overage_usd: 0,
    auto_reload_enabled: false,
    auto_reload_threshold_ct: 5_000,
    auto_reload_pack_usd: 25,
    overage_hard_cap_usd: 100,
    updated_at: toIso(at),
    created_at: toIso(at)
  };
};

const walletBalance = (wallet: WalletRow): WalletBalance => {
  const includedRemaining = Math.max(0, wallet.included_monthly_ct - wallet.used_monthly_ct);
  const availableCt = Math.max(0, includedRemaining + wallet.purchased_ct - wallet.reserved_ct);
  return {
    availableCt,
    reservedCt: Math.max(0, wallet.reserved_ct),
    purchasedCt: Math.max(0, wallet.purchased_ct),
    includedMonthlyCt: Math.max(0, wallet.included_monthly_ct),
    usedMonthlyCt: Math.max(0, wallet.used_monthly_ct),
    overageCt: Math.max(0, wallet.overage_ct),
    pendingOverageUsd: Number(Math.max(0, wallet.pending_overage_usd).toFixed(6))
  };
};

const usageState = (wallet: WalletRow): UsageLimitState => {
  const nowTs = now();
  const dailyReset = nextUtcDay(nowTs);
  const dailyRemaining = Math.max(0, wallet.daily_guardrail_ct - wallet.used_daily_ct);
  return {
    planTier: wallet.plan_tier,
    dailyGuardrailCt: Math.max(0, wallet.daily_guardrail_ct),
    dailyUsedCt: Math.max(0, wallet.used_daily_ct),
    dailyRemainingCt: dailyRemaining,
    monthlyResetAt: wallet.cycle_ends_at,
    dailyResetAt: toIso(dailyReset)
  };
};

const maybeResetWalletCycles = (wallet: WalletRow): { wallet: WalletRow; changed: boolean } => {
  let changed = false;
  const current = now();
  const today = utcDateString(current);

  if (wallet.daily_cycle_date !== today) {
    wallet.daily_cycle_date = today;
    wallet.used_daily_ct = 0;
    changed = true;
  }

  const currentTs = current.getTime();
  const cycleEndTs = new Date(wallet.cycle_ends_at).getTime();
  if (!Number.isFinite(cycleEndTs) || currentTs >= cycleEndTs) {
    const monthStart = startOfUtcMonth(current);
    const monthEnd = nextUtcMonth(current);
    wallet.cycle_starts_at = toIso(monthStart);
    wallet.cycle_ends_at = toIso(monthEnd);
    wallet.used_monthly_ct = 0;
    wallet.overage_ct = 0;
    wallet.pending_overage_usd = 0;
    changed = true;
  }

  if (changed) {
    wallet.updated_at = toIso(current);
  }

  return { wallet, changed };
};

const getFallbackPlanTierFromLegacyUsage = async (userId: string): Promise<BillingPlanTier> => {
  try {
    const { data, error } = await supabase
      .from('usage_limits')
      .select('plan_tier, is_premium')
      .eq('user_id', userId)
      .maybeSingle();

    if (error || !data) return 'free';
    const raw = String((data as Record<string, unknown>).plan_tier || '').toLowerCase();
    if (raw === 'admin') return 'admin';
    if (raw === 'pro') return 'pro';
    if (raw === 'studio') return 'studio';
    if (raw === 'creator') return 'creator';
    if ((data as Record<string, unknown>).is_premium === true) return 'pro';
    return 'free';
  } catch {
    return 'free';
  }
};

const getUserPlanTier = async (userId: string): Promise<BillingPlanTier> => {
  const admin = getBillingAdmin();
  const { data, error } = await admin
    .from('user_plan_subscriptions')
    .select('plan_tier, status')
    .eq('user_id', userId)
    .in('status', ['active', 'trialing'])
    .maybeSingle();

  if (error) {
    if (isMissingTableError(error)) {
      return getFallbackPlanTierFromLegacyUsage(userId);
    }
    throw createBillingBackendUnavailableError(error);
  }

  if (data && isRecord(data)) {
    return toTier(data.plan_tier);
  }

  return getFallbackPlanTierFromLegacyUsage(userId);
};

const persistWallet = async (wallet: WalletRow): Promise<WalletRow> => {
  const admin = getBillingAdmin();
  const payload = {
    user_id: wallet.user_id,
    plan_tier: wallet.plan_tier,
    included_monthly_ct: wallet.included_monthly_ct,
    used_monthly_ct: wallet.used_monthly_ct,
    purchased_ct: wallet.purchased_ct,
    reserved_ct: wallet.reserved_ct,
    overage_ct: wallet.overage_ct,
    daily_guardrail_ct: wallet.daily_guardrail_ct,
    used_daily_ct: wallet.used_daily_ct,
    daily_cycle_date: wallet.daily_cycle_date,
    cycle_starts_at: wallet.cycle_starts_at,
    cycle_ends_at: wallet.cycle_ends_at,
    pending_overage_usd: wallet.pending_overage_usd,
    auto_reload_enabled: wallet.auto_reload_enabled,
    auto_reload_threshold_ct: wallet.auto_reload_threshold_ct,
    auto_reload_pack_usd: wallet.auto_reload_pack_usd,
    overage_hard_cap_usd: wallet.overage_hard_cap_usd,
    updated_at: toIso(now())
  };

  const { data, error } = await admin
    .from('token_wallets')
    .upsert(payload, { onConflict: 'user_id' })
    .select('*')
    .single();

  if (error) {
    throw createBillingBackendUnavailableError(error);
  }

  const mapped = mapWallet(data as Record<string, unknown>);
  inMemoryWallets.set(wallet.user_id, mapped);
  return mapped;
};

const mapWallet = (row: Record<string, unknown>): WalletRow => ({
  user_id: String(row.user_id),
  plan_tier: toTier(row.plan_tier),
  included_monthly_ct: Math.max(0, Math.floor(asNumber(row.included_monthly_ct, 0))),
  used_monthly_ct: Math.max(0, Math.floor(asNumber(row.used_monthly_ct, 0))),
  purchased_ct: Math.max(0, Math.floor(asNumber(row.purchased_ct, 0))),
  reserved_ct: Math.max(0, Math.floor(asNumber(row.reserved_ct, 0))),
  overage_ct: Math.max(0, Math.floor(asNumber(row.overage_ct, 0))),
  daily_guardrail_ct: Math.max(0, Math.floor(asNumber(row.daily_guardrail_ct, 0))),
  used_daily_ct: Math.max(0, Math.floor(asNumber(row.used_daily_ct, 0))),
  daily_cycle_date: String(row.daily_cycle_date || utcDateString(now())),
  cycle_starts_at: String(row.cycle_starts_at || toIso(startOfUtcMonth(now()))),
  cycle_ends_at: String(row.cycle_ends_at || toIso(nextUtcMonth(now()))),
  pending_overage_usd: Math.max(0, asNumber(row.pending_overage_usd, 0)),
  auto_reload_enabled: Boolean(row.auto_reload_enabled),
  auto_reload_threshold_ct: Math.max(0, Math.floor(asNumber(row.auto_reload_threshold_ct, 5_000))),
  auto_reload_pack_usd: Math.max(0, asNumber(row.auto_reload_pack_usd, 25)),
  overage_hard_cap_usd: Math.max(0, asNumber(row.overage_hard_cap_usd, 100)),
  updated_at: typeof row.updated_at === 'string' ? row.updated_at : undefined,
  created_at: typeof row.created_at === 'string' ? row.created_at : undefined
});

const getWalletFromDb = async (userId: string): Promise<WalletRow | null> => {
  const admin = getBillingAdmin();
  const { data, error } = await admin
    .from('token_wallets')
    .select('*')
    .eq('user_id', userId)
    .maybeSingle();

  if (error) {
    if (isMissingTableError(error)) return null;
    throw createBillingBackendUnavailableError(error);
  }
  if (!data || !isRecord(data)) return null;
  return mapWallet(data);
};

const loadOrCreateWallet = async (userId: string): Promise<WalletRow> => {
  const dbWallet = await getWalletFromDb(userId);
  if (dbWallet) {
    const reset = maybeResetWalletCycles(dbWallet);
    const persisted = reset.changed ? await persistWallet(reset.wallet) : reset.wallet;
    inMemoryWallets.set(userId, persisted);
    return persisted;
  }

  const planTier = await getUserPlanTier(userId);
  const wallet = makeWalletForTier(userId, planTier);
  const persisted = await persistWallet(wallet);
  inMemoryWallets.set(userId, persisted);
  return persisted;
};

const resolveWalletEntitlementContext = async (userId: string, walletInput: WalletRow): Promise<WalletEntitlementContext> => {
  const basePlan = resolvePlanDefinition(walletInput.plan_tier);
  const activeCouponEntitlement = await getActiveCouponEntitlementForUser({ userId });
  const entitlementPolicy = activeCouponEntitlement?.policy;
  const effectivePlan = entitlementPolicy?.planTierOverride
    ? resolvePlanDefinition(entitlementPolicy.planTierOverride)
    : basePlan;

  let includedMonthlyCt = effectivePlan.monthlyIncludedCt;
  let dailyGuardrailCt = effectivePlan.dailyGuardrailCt;

  if (typeof entitlementPolicy?.includedMonthlyCtOverride === 'number') {
    includedMonthlyCt = Math.max(0, Math.floor(entitlementPolicy.includedMonthlyCtOverride));
  }
  if (typeof entitlementPolicy?.dailyGuardrailCtOverride === 'number') {
    dailyGuardrailCt = Math.max(0, Math.floor(entitlementPolicy.dailyGuardrailCtOverride));
  }
  if (typeof entitlementPolicy?.includedMonthlyCtBonus === 'number') {
    includedMonthlyCt += Math.max(0, Math.floor(entitlementPolicy.includedMonthlyCtBonus));
  }
  if (typeof entitlementPolicy?.dailyGuardrailCtBonus === 'number') {
    dailyGuardrailCt += Math.max(0, Math.floor(entitlementPolicy.dailyGuardrailCtBonus));
  }

  let wallet = walletInput;
  const shouldPersistLimits = wallet.included_monthly_ct !== includedMonthlyCt
    || wallet.daily_guardrail_ct !== dailyGuardrailCt;

  if (shouldPersistLimits) {
    wallet = await persistWallet({
      ...wallet,
      included_monthly_ct: includedMonthlyCt,
      daily_guardrail_ct: dailyGuardrailCt,
      updated_at: toIso(now())
    });
  }

  return {
    wallet,
    basePlan,
    effectivePlan,
    effectiveUsageSource: activeCouponEntitlement ? 'coupon_entitlement' : 'subscription',
    activeCouponEntitlement: activeCouponEntitlement || undefined,
    overageEnabledOverride: entitlementPolicy?.overageEnabledOverride
  };
};

const ensureWalletContext = async (userId: string): Promise<WalletEntitlementContext> => {
  const wallet = await loadOrCreateWallet(userId);
  return resolveWalletEntitlementContext(userId, wallet);
};

const ensureWallet = async (userId: string): Promise<WalletRow> => {
  const context = await ensureWalletContext(userId);
  return context.wallet;
};

const getPaymentProfile = async (userId: string): Promise<PaymentProfile> => {
  const admin = getBillingAdmin();
  const { data, error } = await admin
    .from('payment_profiles')
    .select('user_id, has_payment_method, overage_enabled, stripe_customer_id, default_payment_method_id, payment_method_brand, payment_method_last4')
    .eq('user_id', userId)
    .maybeSingle();

  if (error) {
    if (isMissingTableError(error)) {
      return {
        user_id: userId,
        has_payment_method: false,
        overage_enabled: false,
        stripe_customer_id: null,
        default_payment_method_id: null,
        payment_method_brand: null,
        payment_method_last4: null
      };
    }
    throw createBillingBackendUnavailableError(error);
  }

  return data && isRecord(data)
    ? {
        user_id: userId,
        has_payment_method: Boolean(data.has_payment_method),
        overage_enabled: data.overage_enabled !== false,
        stripe_customer_id: typeof data.stripe_customer_id === 'string' ? data.stripe_customer_id : null,
        default_payment_method_id: typeof data.default_payment_method_id === 'string' ? data.default_payment_method_id : null,
        payment_method_brand: typeof data.payment_method_brand === 'string' ? data.payment_method_brand : null,
        payment_method_last4: typeof data.payment_method_last4 === 'string' ? data.payment_method_last4 : null
      }
    : {
        user_id: userId,
        has_payment_method: false,
        overage_enabled: false,
        stripe_customer_id: null,
        default_payment_method_id: null,
        payment_method_brand: null,
        payment_method_last4: null
      };
};

export const upsertPaymentProfile = async (
  userId: string,
  patch: Partial<PaymentProfile>
): Promise<PaymentProfile> => {
  const previous = await getPaymentProfile(userId);
  const merged: PaymentProfile = {
    ...previous,
    ...patch,
    user_id: userId
  };

  const admin = getBillingAdmin();
  const { error } = await admin
    .from('payment_profiles')
    .upsert(merged, { onConflict: 'user_id' });

  if (error) {
    throw createBillingBackendUnavailableError(error);
  }

  return merged;
};

const canChargeOffSession = (profile: PaymentProfile) =>
  Boolean(
    stripe &&
    profile.has_payment_method &&
    profile.stripe_customer_id &&
    profile.default_payment_method_id
  );

const createOffSessionCharge = async (input: {
  profile: PaymentProfile;
  amountUsd: number;
  kind: string;
  userId: string;
  metadata?: Record<string, unknown>;
}) => {
  if (!stripe) return null;
  if (!canChargeOffSession(input.profile)) return null;

  const amountCents = Math.round(Math.max(0, input.amountUsd) * 100);
  if (amountCents < 50) {
    return null;
  }

  const metadata: Record<string, string> = {
    kind: input.kind,
    userId: input.userId
  };
  for (const [key, value] of Object.entries(input.metadata || {})) {
    metadata[key] = typeof value === 'string' ? value : JSON.stringify(value);
  }

  try {
    return await stripe.paymentIntents.create({
      customer: input.profile.stripe_customer_id || undefined,
      payment_method: input.profile.default_payment_method_id || undefined,
      amount: amountCents,
      currency: 'usd',
      confirm: true,
      off_session: true,
      metadata
    });
  } catch {
    return null;
  }
};

const maybeAutoReloadWallet = async (userId: string, wallet: WalletRow) => {
  if (!AUTO_RELOAD_POLICY_ENABLED) return null;
  if (!wallet.auto_reload_enabled) return null;
  const balance = walletBalance(wallet);
  if (balance.availableCt >= wallet.auto_reload_threshold_ct) return null;
  if (autoReloadInFlight.has(userId)) return null;

  const profile = await getPaymentProfile(userId);
  if (!canChargeOffSession(profile)) return null;

  autoReloadInFlight.add(userId);
  try {
    const packUsd = Number(wallet.auto_reload_pack_usd.toFixed(2));
    const charge = await createOffSessionCharge({
      profile,
      amountUsd: packUsd,
      kind: 'auto_reload',
      userId,
      metadata: {
        thresholdCt: String(wallet.auto_reload_threshold_ct),
        currentAvailableCt: String(balance.availableCt)
      }
    });

    if (!charge) return null;

    const pack = getCreditPackByUsd(packUsd);
    const ctAmount = pack?.ct ?? Math.max(1, Math.round(packUsd / CT_USD));

    await addPurchasedCredits({
      userId,
      ctAmount,
      usdAmount: packUsd,
      source: 'stripe_auto_reload',
      metadata: {
        paymentIntentId: charge.id,
        autoReload: true
      }
    });

    return {
      paymentIntentId: charge.id,
      addedCt: ctAmount,
      chargedUsd: packUsd
    };
  } finally {
    autoReloadInFlight.delete(userId);
  }
};

const maybeCapturePendingOverage = async (userId: string, wallet: WalletRow) => {
  const pendingUsd = Number(wallet.pending_overage_usd.toFixed(2));
  if (pendingUsd < 0.5) return null;
  if (overageCaptureInFlight.has(userId)) return null;

  const profile = await getPaymentProfile(userId);
  if (!canChargeOffSession(profile)) return null;

  overageCaptureInFlight.add(userId);
  try {
    const charge = await createOffSessionCharge({
      profile,
      amountUsd: pendingUsd,
      kind: 'overage_capture',
      userId,
      metadata: {
        pendingOverageUsd: String(wallet.pending_overage_usd)
      }
    });

    if (!charge) return null;

    wallet.pending_overage_usd = Number(Math.max(0, wallet.pending_overage_usd - pendingUsd).toFixed(6));
    wallet.updated_at = toIso(now());
    await persistWallet(wallet);

    await recordLedgerEntry(userId, {
      entryType: 'OVERAGE_CAPTURE',
      ctDelta: 0,
      usdDelta: pendingUsd,
      operation: 'stripe_overage_capture',
      metadata: {
        paymentIntentId: charge.id,
        capturedUsd: pendingUsd
      }
    });

    return {
      paymentIntentId: charge.id,
      capturedUsd: pendingUsd
    };
  } finally {
    overageCaptureInFlight.delete(userId);
  }
};

const recordLedgerEntry = async (
  userId: string,
  entry: {
    entryType: string;
    ctDelta: number;
    usdDelta: number;
    providerCostUsd?: number;
    billableUsd?: number;
    operation?: string;
    provider?: string;
    model?: string;
    projectId?: string;
    reservationId?: string;
    isByok?: boolean;
    metadata?: Record<string, unknown>;
  }
) => {
  const row = {
    id: crypto.randomUUID(),
    created_at: toIso(now()),
    user_id: userId,
    entry_type: entry.entryType,
    ct_delta: entry.ctDelta,
    usd_delta: entry.usdDelta,
    provider_cost_usd: entry.providerCostUsd,
    billable_usd: entry.billableUsd,
    operation: entry.operation,
    provider: entry.provider,
    model: entry.model,
    project_id: entry.projectId,
    reservation_id: entry.reservationId,
    is_byok: entry.isByok === true,
    metadata: entry.metadata || {}
  };

  const admin = getBillingAdmin();
  const { error } = await admin.from('token_ledger_entries').insert(row);
  if (error) {
    throw createBillingBackendUnavailableError(error);
  }
};

const recordCostEvent = async (event: Record<string, unknown>) => {
  const admin = getBillingAdmin();
  const { error } = await admin.from('generation_cost_events').insert(event);
  if (error) {
    throw createBillingBackendUnavailableError(error);
  }
};

const updateCostEvent = async (reservationId: string, patch: Record<string, unknown>) => {
  const admin = getBillingAdmin();
  const { error } = await admin
    .from('generation_cost_events')
    .update(patch)
    .eq('reservation_id', reservationId);

  if (error) {
    throw createBillingBackendUnavailableError(error);
  }
};

const upsertDailyRollup = async (userId: string, ctSpent: number, byokTrackedCt: number, usdBillable: number) => {
  const usageDate = utcDateString(now());
  const admin = getBillingAdmin();
  const { data, error } = await admin
    .from('usage_daily_rollups')
    .select('ct_spent, ct_byok_tracked, usd_estimated')
    .eq('user_id', userId)
    .eq('usage_date', usageDate)
    .maybeSingle();

  if (error) {
    throw createBillingBackendUnavailableError(error);
  }

  if (!data) {
    const insertResult = await admin.from('usage_daily_rollups').insert({
      user_id: userId,
      usage_date: usageDate,
      ct_spent: ctSpent,
      ct_byok_tracked: byokTrackedCt,
      usd_estimated: usdBillable
    });
    if (insertResult.error) {
      throw createBillingBackendUnavailableError(insertResult.error);
    }
    return;
  }

  const updateResult = await admin
    .from('usage_daily_rollups')
    .update({
      ct_spent: Math.max(0, asNumber((data as Record<string, unknown>).ct_spent) + ctSpent),
      ct_byok_tracked: Math.max(0, asNumber((data as Record<string, unknown>).ct_byok_tracked) + byokTrackedCt),
      usd_estimated: Math.max(0, asNumber((data as Record<string, unknown>).usd_estimated) + usdBillable)
    })
    .eq('user_id', userId)
    .eq('usage_date', usageDate);

  if (updateResult.error) {
    throw createBillingBackendUnavailableError(updateResult.error);
  }
};

const buildLimitOptions = (
  reason: LimitExceededDetails['reason'],
  paymentMethodRequired: boolean
): LimitExceededResolutionOptions => ({
  canUpgrade: true,
  canAddCredits: true,
  canWaitForReset: reason === 'DAILY_LIMIT_EXCEEDED' || reason === 'MONTHLY_INCLUDED_EXHAUSTED',
  paymentMethodRequired,
  recommendedAction: reason === 'DAILY_LIMIT_EXCEEDED' ? 'wait_for_reset' : paymentMethodRequired ? 'add_credits' : 'upgrade'
});

const buildLimitExceeded = (
  reason: LimitExceededDetails['reason'],
  requiredCt: number,
  wallet: WalletRow,
  paymentMethodRequired: boolean
): LimitExceededDetails => {
  const balance = walletBalance(wallet);
  const usage = usageState(wallet);
  return {
    reason,
    requiredCt,
    availableCt: balance.availableCt,
    resetAt: reason === 'DAILY_LIMIT_EXCEEDED' ? usage.dailyResetAt : usage.monthlyResetAt,
    usage,
    options: buildLimitOptions(reason, paymentMethodRequired)
  };
};

export const reserveUsageTokens = async (input: {
  userId: string;
  estimate: TokenEstimateResponse;
  provider: string;
  model: string;
  operation: string;
  projectId?: string;
  comicId?: string;
  stage?: string;
  byok?: boolean;
  metadata?: Record<string, unknown>;
}): Promise<{ allowed: true; reservation: ReservationState } | { allowed: false; details: LimitExceededDetails }> => {
  let walletContext = await ensureWalletContext(input.userId);
  let wallet = walletContext.wallet;

  if (input.byok) {
    const bypass: ReservationState = {
      byokBypass: true,
      estimated: input.estimate,
      usage: usageState(wallet)
    };

    await recordLedgerEntry(input.userId, {
      entryType: 'BYOK_TRACKED',
      ctDelta: 0,
      usdDelta: 0,
      operation: input.operation,
      provider: input.provider,
      model: input.model,
      projectId: input.projectId,
      isByok: true,
      metadata: {
        ...input.metadata,
        estimatedCt: input.estimate.estimatedCt,
        providerCostUsd: input.estimate.estimatedProviderCostUsd,
        billableUsd: input.estimate.estimatedBillableUsd
      }
    });

    await upsertDailyRollup(input.userId, 0, input.estimate.estimatedCt, 0);

    return { allowed: true, reservation: bypass };
  }

  const requiredCt = Math.max(0, Math.floor(input.estimate.estimatedCt));
  const balance = walletBalance(wallet);
  const usage = usageState(wallet);

  if (requiredCt > usage.dailyRemainingCt) {
    return {
      allowed: false,
      details: buildLimitExceeded('DAILY_LIMIT_EXCEEDED', requiredCt, wallet, false)
    };
  }

  const profile = await getPaymentProfile(input.userId);
  const effectiveOverageEnabled = walletContext.overageEnabledOverride ?? profile.overage_enabled;
  const allowOverage = requiredCt > balance.availableCt;
  if (requiredCt > balance.availableCt) {
    const shortfallCt = requiredCt - balance.availableCt;

    if (walletContext.effectivePlan.id === 'free') {
      return {
        allowed: false,
        details: buildLimitExceeded('INSUFFICIENT_CREDITS', requiredCt, wallet, false)
      };
    }

    if (!profile.has_payment_method) {
      return {
        allowed: false,
        details: buildLimitExceeded('PAYMENT_METHOD_REQUIRED', requiredCt, wallet, true)
      };
    }

    if (!effectiveOverageEnabled) {
      return {
        allowed: false,
        details: buildLimitExceeded('PAYMENT_METHOD_REQUIRED', requiredCt, wallet, true)
      };
    }

    const projectedOverageUsd = wallet.pending_overage_usd + shortfallCt * CT_USD;
    if (projectedOverageUsd > wallet.overage_hard_cap_usd) {
      return {
        allowed: false,
        details: buildLimitExceeded('OVERAGE_CAP_REACHED', requiredCt, wallet, false)
      };
    }
  }

  const reservationId = crypto.randomUUID();
  const reserveResult = await callTryReserveTokens({
    userId: input.userId,
    requiredCt,
    allowOverage
  });

  if (reserveResult.allowed !== true) {
    const reason = String(reserveResult.reason || 'INSUFFICIENT_CREDITS');
    const mappedReason = reason === 'DAILY_LIMIT_EXCEEDED' ? 'DAILY_LIMIT_EXCEEDED' : 'INSUFFICIENT_CREDITS';
    walletContext = await ensureWalletContext(input.userId);
    wallet = walletContext.wallet;
    return {
      allowed: false,
      details: buildLimitExceeded(mappedReason, requiredCt, wallet, false)
    };
  }

  walletContext = await ensureWalletContext(input.userId);
  wallet = walletContext.wallet;

  await recordLedgerEntry(input.userId, {
    entryType: 'RESERVE',
    ctDelta: 0,
    usdDelta: 0,
    operation: input.operation,
    provider: input.provider,
    model: input.model,
    projectId: input.projectId,
    reservationId,
    metadata: {
      ...input.metadata,
      estimatedCt: requiredCt,
      estimatedBillableUsd: input.estimate.estimatedBillableUsd,
      estimatedProviderCostUsd: input.estimate.estimatedProviderCostUsd
    }
  });

  await recordCostEvent({
    id: crypto.randomUUID(),
    user_id: input.userId,
    project_id: input.projectId,
    comic_id: input.comicId || input.projectId,
    operation: input.operation,
    stage: input.stage,
    provider: input.provider,
    model: input.model,
    reservation_id: reservationId,
    estimated_ct: requiredCt,
    actual_ct: 0,
    provider_cost_usd: input.estimate.estimatedProviderCostUsd,
    billable_usd: input.estimate.estimatedBillableUsd,
    is_byok: false,
    status: 'RESERVED',
    metadata: input.metadata || {},
    created_at: toIso(now())
  });

  return {
    allowed: true,
    reservation: {
      reservationId,
      byokBypass: false,
      estimated: input.estimate,
      usage: usageState(wallet)
    }
  };
};

export const releaseReservation = async (input: {
  userId: string;
  reservationId?: string;
  estimatedCt: number;
  reason?: string;
  operation?: string;
  provider?: string;
  model?: string;
  projectId?: string;
  metadata?: Record<string, unknown>;
}) => {
  if (!input.reservationId) return;
  await callReleaseReservedTokens({
    userId: input.userId,
    releaseCt: Math.max(0, Math.floor(input.estimatedCt))
  });

  await recordLedgerEntry(input.userId, {
    entryType: 'RELEASE',
    ctDelta: 0,
    usdDelta: 0,
    operation: input.operation,
    provider: input.provider,
    model: input.model,
    projectId: input.projectId,
    reservationId: input.reservationId,
    metadata: {
      ...input.metadata,
      reason: input.reason || 'request_failed'
    }
  });

  await updateCostEvent(input.reservationId, {
    status: 'RELEASED',
    metadata: {
      ...input.metadata,
      releaseReason: input.reason || 'request_failed'
    }
  });
};

export const settleReservation = async (input: {
  userId: string;
  reservationId?: string;
  estimatedCt: number;
  actual: TokenEstimateResponse;
  operation: string;
  provider: string;
  model: string;
  projectId?: string;
  metadata?: Record<string, unknown>;
  byokBypass?: boolean;
}) => {
  const actualCt = Math.max(0, Math.floor(input.actual.estimatedCt));
  const billableUsd = Number(input.actual.estimatedBillableUsd.toFixed(6));
  const providerCostUsd = Number(input.actual.estimatedProviderCostUsd.toFixed(6));

  if (input.byokBypass) {
    await recordLedgerEntry(input.userId, {
      entryType: 'BYOK_SETTLED',
      ctDelta: 0,
      usdDelta: 0,
      operation: input.operation,
      provider: input.provider,
      model: input.model,
      projectId: input.projectId,
      reservationId: input.reservationId,
      isByok: true,
      providerCostUsd,
      billableUsd,
      metadata: input.metadata
    });

    if (input.reservationId) {
      await updateCostEvent(input.reservationId, {
        status: 'BYOK_SETTLED',
        actual_ct: 0,
        provider_cost_usd: providerCostUsd,
        billable_usd: 0,
        is_byok: true,
        metadata: input.metadata || {}
      });
    }

    await upsertDailyRollup(input.userId, 0, actualCt, 0);

    return {
      actualCt: 0,
      billableUsd: 0,
      providerCostUsd,
      reservationReleased: true,
      usage: usageState(await ensureWallet(input.userId)),
      wallet: walletBalance(await ensureWallet(input.userId))
    };
  }

  const estimatedCt = Math.max(0, Math.floor(input.estimatedCt));
  const settleResult = await callSettleTokens({
    userId: input.userId,
    estimatedCt,
    actualCt
  });
  if (settleResult.ok === false) {
    throw createBillingBackendUnavailableError(settleResult);
  }
  const fromIncluded = Math.max(0, Math.floor(asNumber(settleResult.from_included, 0)));
  const fromPurchased = Math.max(0, Math.floor(asNumber(settleResult.from_purchased, 0)));
  const overageCt = Math.max(0, Math.floor(asNumber(settleResult.overage_ct, 0)));

  await recordLedgerEntry(input.userId, {
    entryType: 'SETTLE',
    ctDelta: -actualCt,
    usdDelta: -billableUsd,
    providerCostUsd,
    billableUsd,
    operation: input.operation,
    provider: input.provider,
    model: input.model,
    projectId: input.projectId,
    reservationId: input.reservationId,
    metadata: {
      ...input.metadata,
      estimatedCt,
      actualCt,
      fromIncluded,
      fromPurchased,
      overageCt,
      markup: DEFAULT_MARKUP
    }
  });

  if (input.reservationId) {
    await updateCostEvent(input.reservationId, {
      status: 'SETTLED',
      actual_ct: actualCt,
      provider_cost_usd: providerCostUsd,
      billable_usd: billableUsd,
      metadata: input.metadata || {}
    });
  }

  await upsertDailyRollup(input.userId, actualCt, 0, billableUsd);

  const wallet = await ensureWallet(input.userId);
  const overageCapture = await maybeCapturePendingOverage(input.userId, wallet);
  const autoReload = await maybeAutoReloadWallet(input.userId, wallet);
  const latestWallet = await ensureWallet(input.userId);

  return {
    actualCt,
    billableUsd,
    providerCostUsd,
    reservationReleased: true,
    usage: usageState(latestWallet),
    wallet: walletBalance(latestWallet),
    overageCapture: overageCapture || undefined,
    autoReload: autoReload || undefined
  };
};

export const addPurchasedCredits = async (input: {
  userId: string;
  ctAmount: number;
  usdAmount: number;
  source: string;
  metadata?: Record<string, unknown>;
}) => {
  const wallet = await ensureWallet(input.userId);
  const creditCt = Math.max(0, Math.floor(input.ctAmount));
  wallet.purchased_ct += creditCt;
  wallet.updated_at = toIso(now());
  await persistWallet(wallet);

  await recordLedgerEntry(input.userId, {
    entryType: 'CREDIT_PURCHASE',
    ctDelta: creditCt,
    usdDelta: Number(input.usdAmount.toFixed(6)),
    operation: input.source,
    metadata: input.metadata
  });

  return {
    wallet: walletBalance(wallet),
    usage: usageState(wallet)
  };
};

export const getBillingSummary = async (userId: string): Promise<BillingSummaryResponse> => {
  const walletContext = await ensureWalletContext(userId);
  const wallet = walletContext.wallet;
  const profile = await getPaymentProfile(userId);
  const effectiveOverageEnabled = walletContext.overageEnabledOverride ?? profile.overage_enabled;
  const admin = getBillingAdmin();
  const { data: subscriptionRow, error: subscriptionError } = await admin
    .from('user_plan_subscriptions')
    .select('plan_tier, status, stripe_status, stripe_subscription_id, cancel_at_period_end, cancel_requested_at, canceled_at, current_period_start, current_period_end, metadata')
    .eq('user_id', userId)
    .maybeSingle();

  if (subscriptionError) {
    throw createBillingBackendUnavailableError(subscriptionError);
  }

  const metadataIntervalValue = subscriptionRow && isRecord(subscriptionRow.metadata)
    ? subscriptionRow.metadata.interval
    : undefined;
  const intervalFromMetadata: 'month' | 'year' | undefined =
    metadataIntervalValue === 'month' || metadataIntervalValue === 'year'
    ? metadataIntervalValue
    : undefined;

  const subscription = subscriptionRow && isRecord(subscriptionRow)
    ? {
        planTier: toTier(subscriptionRow.plan_tier),
        status: String(subscriptionRow.status || 'inactive'),
        interval: intervalFromMetadata,
        stripeStatus: typeof subscriptionRow.stripe_status === 'string' ? subscriptionRow.stripe_status : undefined,
        stripeSubscriptionId: typeof subscriptionRow.stripe_subscription_id === 'string' ? subscriptionRow.stripe_subscription_id : undefined,
        cancelAtPeriodEnd: Boolean(subscriptionRow.cancel_at_period_end),
        cancelRequestedAt: typeof subscriptionRow.cancel_requested_at === 'string' ? subscriptionRow.cancel_requested_at : undefined,
        canceledAt: typeof subscriptionRow.canceled_at === 'string' ? subscriptionRow.canceled_at : undefined,
        currentPeriodStart: typeof subscriptionRow.current_period_start === 'string' ? subscriptionRow.current_period_start : undefined,
        currentPeriodEnd: typeof subscriptionRow.current_period_end === 'string' ? subscriptionRow.current_period_end : undefined
      }
    : {
        planTier: walletContext.basePlan.id,
        status: 'inactive',
        cancelAtPeriodEnd: false
      };

  return {
    currency: 'USD',
    ctPerUsd: Math.round(1 / CT_USD),
    wallet: walletBalance(wallet),
    usage: usageState(wallet),
    basePlan: walletContext.basePlan,
    effectivePlan: walletContext.effectivePlan,
    effectiveUsageSource: walletContext.effectiveUsageSource,
    activeCouponEntitlement: walletContext.activeCouponEntitlement,
    plan: walletContext.effectivePlan,
    hasPaymentMethodOnFile: profile.has_payment_method,
    overageEnabled: effectiveOverageEnabled,
    overageHardCapUsd: wallet.overage_hard_cap_usd,
    subscription,
    autoReload: {
      enabled: false,
      thresholdCt: wallet.auto_reload_threshold_ct,
      packUsd: wallet.auto_reload_pack_usd
    }
  };
};

export const updateAutoReloadSettings = async (input: {
  userId: string;
  enabled: boolean;
  thresholdCt?: number;
  packUsd?: number;
}) => {
  const wallet = await ensureWallet(input.userId);
  if (input.enabled) {
    const error = new Error('Auto-reload is disabled by billing policy.') as Error & { status?: number; publicCode?: string };
    error.status = 409;
    error.publicCode = 'AUTO_RELOAD_DISABLED';
    throw error;
  }
  wallet.auto_reload_enabled = false;
  if (typeof input.thresholdCt === 'number' && Number.isFinite(input.thresholdCt)) {
    wallet.auto_reload_threshold_ct = Math.max(1_000, Math.floor(input.thresholdCt));
  }
  if (typeof input.packUsd === 'number' && Number.isFinite(input.packUsd)) {
    wallet.auto_reload_pack_usd = Math.max(5, Number(input.packUsd.toFixed(2)));
  }
  wallet.updated_at = toIso(now());
  await persistWallet(wallet);
  return {
    enabled: wallet.auto_reload_enabled,
    thresholdCt: wallet.auto_reload_threshold_ct,
    packUsd: wallet.auto_reload_pack_usd
  };
};

export const listUsageHistory = async (userId: string, limit = 100): Promise<BillingUsageHistoryItem[]> => {
  const safeLimit = Math.max(1, Math.min(500, Math.floor(limit)));
  const admin = getBillingAdmin();
  const { data, error } = await admin
    .from('token_ledger_entries')
    .select('id, created_at, entry_type, ct_delta, usd_delta, provider, model, operation, project_id, metadata')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(safeLimit);

  if (error || !Array.isArray(data)) {
    throw createBillingBackendUnavailableError(error);
  }

  return data.map((row) => ({
    id: String((row as Record<string, unknown>).id),
    createdAt: String((row as Record<string, unknown>).created_at),
    entryType: String((row as Record<string, unknown>).entry_type),
    ctDelta: Math.floor(asNumber((row as Record<string, unknown>).ct_delta, 0)),
    usdDelta: Number(asNumber((row as Record<string, unknown>).usd_delta, 0).toFixed(6)),
    provider: typeof (row as Record<string, unknown>).provider === 'string' ? String((row as Record<string, unknown>).provider) : undefined,
    model: typeof (row as Record<string, unknown>).model === 'string' ? String((row as Record<string, unknown>).model) : undefined,
    operation: typeof (row as Record<string, unknown>).operation === 'string' ? String((row as Record<string, unknown>).operation) : undefined,
    projectId: typeof (row as Record<string, unknown>).project_id === 'string' ? String((row as Record<string, unknown>).project_id) : undefined,
    metadata: isRecord((row as Record<string, unknown>).metadata) ? (row as Record<string, unknown>).metadata as Record<string, unknown> : undefined
  }));
};

export const getComicCostReport = async (userId: string, comicId: string): Promise<ComicCostReport> => {
  const byStage: Record<string, { ct: number; usd: number }> = {};
  const byModel: Record<string, { ct: number; usd: number }> = {};

  let events: Array<{
    id: string;
    createdAt: string;
    operation: string;
    stage?: string;
    provider: string;
    model: string;
    estimatedCt: number;
    actualCt: number;
    billableUsd: number;
    providerCostUsd: number;
    isByok: boolean;
    status: string;
  }> = [];

  const admin = getBillingAdmin();
  const { data, error } = await admin
    .from('generation_cost_events')
    .select('id, created_at, operation, stage, provider, model, estimated_ct, actual_ct, billable_usd, provider_cost_usd, is_byok, status')
    .eq('user_id', userId)
    .or(`comic_id.eq.${comicId},project_id.eq.${comicId}`)
    .order('created_at', { ascending: false })
    .limit(500);

  if (error || !Array.isArray(data)) {
    throw createBillingBackendUnavailableError(error);
  }

  events = data.map((row) => ({
    id: String((row as Record<string, unknown>).id),
    createdAt: String((row as Record<string, unknown>).created_at),
    operation: String((row as Record<string, unknown>).operation || 'unknown'),
    stage: typeof (row as Record<string, unknown>).stage === 'string' ? String((row as Record<string, unknown>).stage) : undefined,
    provider: String((row as Record<string, unknown>).provider || 'unknown'),
    model: String((row as Record<string, unknown>).model || 'unknown'),
    estimatedCt: Math.floor(asNumber((row as Record<string, unknown>).estimated_ct, 0)),
    actualCt: Math.floor(asNumber((row as Record<string, unknown>).actual_ct, 0)),
    billableUsd: Number(asNumber((row as Record<string, unknown>).billable_usd, 0).toFixed(6)),
    providerCostUsd: Number(asNumber((row as Record<string, unknown>).provider_cost_usd, 0).toFixed(6)),
    isByok: Boolean((row as Record<string, unknown>).is_byok),
    status: String((row as Record<string, unknown>).status || 'UNKNOWN')
  }));

  let totalEstimatedCt = 0;
  let totalActualCt = 0;
  let totalBillableUsd = 0;
  let totalProviderCostUsd = 0;

  events.forEach((event) => {
    totalEstimatedCt += event.estimatedCt;
    totalActualCt += event.actualCt;
    totalBillableUsd += event.billableUsd;
    totalProviderCostUsd += event.providerCostUsd;

    const stageKey = event.stage || 'unknown';
    const modelKey = event.model || 'unknown';

    if (!byStage[stageKey]) byStage[stageKey] = { ct: 0, usd: 0 };
    if (!byModel[modelKey]) byModel[modelKey] = { ct: 0, usd: 0 };

    byStage[stageKey].ct += event.actualCt;
    byStage[stageKey].usd += event.billableUsd;

    byModel[modelKey].ct += event.actualCt;
    byModel[modelKey].usd += event.billableUsd;
  });

  return {
    comicId,
    totalEstimatedCt,
    totalActualCt,
    totalBillableUsd: Number(totalBillableUsd.toFixed(6)),
    totalProviderCostUsd: Number(totalProviderCostUsd.toFixed(6)),
    byStage,
    byModel,
    events
  };
};

export const setUserPlanTier = async (userId: string, planTier: BillingPlanTier, metadata?: Record<string, unknown>) => {
  const plan = resolvePlanDefinition(planTier);
  const wallet = await ensureWallet(userId);

  wallet.plan_tier = plan.id;
  wallet.included_monthly_ct = plan.monthlyIncludedCt;
  wallet.daily_guardrail_ct = plan.dailyGuardrailCt;
  wallet.updated_at = toIso(now());
  await persistWallet(wallet);

  const admin = getBillingAdmin();
  const { error } = await admin
    .from('user_plan_subscriptions')
    .upsert({
      user_id: userId,
      plan_tier: plan.id,
      status: 'active',
      updated_at: toIso(now()),
      metadata: metadata || {}
    }, { onConflict: 'user_id' });

  if (error) {
    throw createBillingBackendUnavailableError(error);
  }

  await recordLedgerEntry(userId, {
    entryType: 'PLAN_CHANGE',
    ctDelta: 0,
    usdDelta: 0,
    operation: 'plan_change',
    metadata: {
      ...metadata,
      newPlanTier: plan.id,
      includedMonthlyCt: plan.monthlyIncludedCt,
      dailyGuardrailCt: plan.dailyGuardrailCt
    }
  });

  return getBillingSummary(userId);
};
