import type { BillingInterval, BillingPlanDefinition, BillingPlanPricing, CreditPackId, PurchasablePlanTier } from '../../../shared/types/billing.js';
import { getSupabaseAdmin } from './supabase.js';

type StripeResourceType = 'plan' | 'credit_pack';

type StripePriceConfigRecord = {
  resourceType: StripeResourceType;
  planTier?: PurchasablePlanTier;
  packId?: CreditPackId;
  interval?: BillingInterval;
  priceId: string;
  priceUsd?: number;
  source: 'database' | 'env';
};

type PlanEntitlementLike = {
  planTier: string;
  interval: BillingInterval;
  includedMonthlyCt: number;
  dailyGuardrailCt: number;
  dailyLimitEnabled: boolean;
};

const PURCHASABLE_PLAN_TIERS: PurchasablePlanTier[] = ['creator', 'studio'];
const CREDIT_PACK_IDS: CreditPackId[] = ['pack_10', 'pack_25', 'pack_100'];
const INTERVALS: BillingInterval[] = ['month', 'year'];
const CACHE_TTL_MS = 30_000;

let configCache: { expiresAt: number; values: StripePriceConfigRecord[] } | null = null;

const isMissingTableError = (error: unknown) => {
  const code = String((error as { code?: string })?.code || '').toUpperCase();
  return code === '42P01' || code === 'PGRST205';
};

const asPositiveNumber = (value: unknown): number | undefined => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return undefined;
  return Number(parsed.toFixed(2));
};

const toInterval = (value: unknown): BillingInterval | undefined => {
  if (value === 'month' || value === 'year') return value;
  return undefined;
};

const toPlanTier = (value: unknown): PurchasablePlanTier | undefined => {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim().toLowerCase();
  if (normalized === 'creator' || normalized === 'studio') {
    return normalized;
  }
  return undefined;
};

const toCreditPackId = (value: unknown): CreditPackId | undefined => {
  if (value !== 'pack_10' && value !== 'pack_25' && value !== 'pack_100') {
    return undefined;
  }
  return value;
};

const getEnvPlanPriceId = (planTier: PurchasablePlanTier, interval: BillingInterval): string | undefined => {
  const monthlyFallback = planTier === 'creator' || planTier === 'studio'
    ? process.env.STRIPE_PRICE_ID
    : undefined;

  if (planTier === 'creator') {
    return interval === 'month'
      ? process.env.STRIPE_PRICE_ID_CREATOR || monthlyFallback
      : process.env.STRIPE_PRICE_ID_CREATOR_ANNUAL;
  }

  return interval === 'month'
    ? process.env.STRIPE_PRICE_ID_STUDIO || monthlyFallback
    : process.env.STRIPE_PRICE_ID_STUDIO_ANNUAL;
};

const getEnvCreditPackPriceId = (packId: CreditPackId): string | undefined => {
  if (packId === 'pack_10') return process.env.STRIPE_PRICE_ID_CREDIT_PACK_10;
  if (packId === 'pack_25') return process.env.STRIPE_PRICE_ID_CREDIT_PACK_25;
  return process.env.STRIPE_PRICE_ID_CREDIT_PACK_100;
};

const loadEnvFallbackConfig = (): StripePriceConfigRecord[] => {
  const values: StripePriceConfigRecord[] = [];

  for (const planTier of PURCHASABLE_PLAN_TIERS) {
    for (const interval of INTERVALS) {
      const priceId = getEnvPlanPriceId(planTier, interval);
      if (!priceId) continue;
      values.push({
        resourceType: 'plan',
        planTier,
        interval,
        priceId,
        source: 'env'
      });
    }
  }

  for (const packId of CREDIT_PACK_IDS) {
    const priceId = getEnvCreditPackPriceId(packId);
    if (!priceId) continue;
    values.push({
      resourceType: 'credit_pack',
      packId,
      priceId,
      source: 'env'
    });
  }

  return values;
};

const loadDatabaseConfig = async (): Promise<StripePriceConfigRecord[]> => {
  try {
    const admin = getSupabaseAdmin();
    const { data, error } = await admin
      .from('stripe_price_configs')
      .select('resource_type, plan_tier, pack_id, interval, price_id, price_usd, is_active')
      .eq('is_active', true);

    if (error) {
      if (isMissingTableError(error)) return [];
      return [];
    }

    if (!Array.isArray(data)) return [];

    const values: StripePriceConfigRecord[] = [];
    for (const row of data) {
      const record = row as Record<string, unknown>;
      const resourceType = record.resource_type === 'plan' || record.resource_type === 'credit_pack'
        ? record.resource_type
        : null;
      if (!resourceType) continue;

      const priceId = typeof record.price_id === 'string' ? record.price_id.trim() : '';
      if (!priceId) continue;

      if (resourceType === 'plan') {
        const planTier = toPlanTier(record.plan_tier);
        const interval = toInterval(record.interval);
        if (!planTier || !interval) continue;

        values.push({
          resourceType,
          planTier,
          interval,
          priceId,
          priceUsd: asPositiveNumber(record.price_usd),
          source: 'database'
        });
        continue;
      }

      const packId = toCreditPackId(record.pack_id);
      if (!packId) continue;
      values.push({
        resourceType,
        packId,
        priceId,
        priceUsd: asPositiveNumber(record.price_usd),
        source: 'database'
      });
    }

    return values;
  } catch {
    return [];
  }
};

const buildConfigKey = (row: Pick<StripePriceConfigRecord, 'resourceType' | 'planTier' | 'packId' | 'interval'>) =>
  `${row.resourceType}|${row.planTier || ''}|${row.packId || ''}|${row.interval || ''}`;

const mergeConfigs = (databaseValues: StripePriceConfigRecord[], envValues: StripePriceConfigRecord[]) => {
  const merged = new Map<string, StripePriceConfigRecord>();

  for (const envValue of envValues) {
    merged.set(buildConfigKey(envValue), envValue);
  }

  for (const dbValue of databaseValues) {
    merged.set(buildConfigKey(dbValue), dbValue);
  }

  return Array.from(merged.values());
};

const getConfigValues = async (): Promise<StripePriceConfigRecord[]> => {
  const now = Date.now();
  if (configCache && configCache.expiresAt > now) {
    return configCache.values;
  }

  const [databaseValues, envValues] = await Promise.all([
    loadDatabaseConfig(),
    Promise.resolve(loadEnvFallbackConfig())
  ]);

  const mergedValues = mergeConfigs(databaseValues, envValues);
  configCache = {
    values: mergedValues,
    expiresAt: now + CACHE_TTL_MS
  };

  return mergedValues;
};

export const resetStripePriceConfigCache = () => {
  configCache = null;
};

export const resolvePlanStripePriceId = async (
  planTier: PurchasablePlanTier,
  interval: BillingInterval
): Promise<string | undefined> => {
  const values = await getConfigValues();
  const match = values.find((row) => row.resourceType === 'plan' && row.planTier === planTier && row.interval === interval);
  return match?.priceId;
};

export const resolveCreditPackStripePriceId = async (packId: CreditPackId): Promise<string | undefined> => {
  const values = await getConfigValues();
  const match = values.find((row) => row.resourceType === 'credit_pack' && row.packId === packId);
  return match?.priceId;
};

export const resolvePlanFromStripePriceId = async (priceId?: string | null): Promise<{ planTier: PurchasablePlanTier; interval: BillingInterval } | null> => {
  if (!priceId) return null;
  const values = await getConfigValues();
  const match = values.find((row) => row.resourceType === 'plan' && row.priceId === priceId && row.planTier && row.interval);
  if (!match || !match.planTier || !match.interval) return null;
  return {
    planTier: match.planTier,
    interval: match.interval
  };
};

export const resolveCreditPackFromStripePriceId = async (priceId?: string | null): Promise<CreditPackId | null> => {
  if (!priceId) return null;
  const values = await getConfigValues();
  const match = values.find((row) => row.resourceType === 'credit_pack' && row.priceId === priceId && row.packId);
  return match?.packId || null;
};

export const getPlanPricingCatalog = async (
  plans: BillingPlanDefinition[],
  entitlements: PlanEntitlementLike[] = []
): Promise<BillingPlanPricing[]> => {
  const values = await getConfigValues();
  const monthlyByTier = new Map<PurchasablePlanTier, number>();

  for (const plan of plans) {
    if (plan.id === 'creator' || plan.id === 'studio') {
      monthlyByTier.set(plan.id, Math.max(0, Number(plan.monthlyPriceUsd || 0)));
    }
  }

  const defaultAnnualByTier: Record<PurchasablePlanTier, number> = {
    creator: 119.88,
    studio: 419.88
  };

  const catalog: BillingPlanPricing[] = [];
  for (const tier of PURCHASABLE_PLAN_TIERS) {
    const monthly = monthlyByTier.get(tier) || 0;
    for (const interval of INTERVALS) {
      const configured = values.find((row) => row.resourceType === 'plan' && row.planTier === tier && row.interval === interval);
      const entitlement = entitlements.find((entry) => entry.planTier === tier && entry.interval === interval)
        || entitlements.find((entry) => entry.planTier === tier && entry.interval === 'month');
      const fallbackPlan = plans.find((entry) => entry.id === tier);
      const defaultPrice = interval === 'month'
        ? monthly
        : defaultAnnualByTier[tier] ?? Number((monthly * 12).toFixed(2));

      catalog.push({
        planTier: tier,
        interval,
        priceUsd: configured?.priceUsd ?? defaultPrice,
        includedMonthlyCt: entitlement?.includedMonthlyCt
          ?? fallbackPlan?.monthlyIncludedCt
          ?? 0,
        dailyGuardrailCt: entitlement?.dailyGuardrailCt
          ?? fallbackPlan?.dailyGuardrailCt
          ?? 0,
        dailyLimitEnabled: entitlement?.dailyLimitEnabled
          ?? fallbackPlan?.dailyLimitEnabled
          ?? false,
        stripePriceConfigured: Boolean(configured?.priceId)
      });
    }
  }

  return catalog;
};

export const getStripePriceConfigSnapshot = async () => getConfigValues();
