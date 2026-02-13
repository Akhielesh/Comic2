import type {
  BillingPlanDefinition,
  BillingPlanTier,
  CreditPackDefinition,
  PricingCatalogResponse
} from '../../../shared/types/billing.js';
import { getSupabaseAdmin } from './supabase.js';
import { getPlanPricingCatalog } from './stripePriceConfig.js';

export const CT_USD = 0.0001;
export const DEFAULT_MARKUP = Number(process.env.BILLING_PLATFORM_MARKUP || '1.30');
export const DEFAULT_CURRENCY = 'USD' as const;

const clampFinite = (value: unknown, fallback: number, min = 0) => {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric < min) return fallback;
  return numeric;
};

const tierOrder: BillingPlanTier[] = ['free', 'creator', 'pro', 'studio', 'custom', 'admin'];
type PricingChangelogEntry = NonNullable<PricingCatalogResponse['pricingChangelog']>[number];

export const DEFAULT_BILLING_PLANS: BillingPlanDefinition[] = [
  {
    id: 'free',
    name: 'Free',
    monthlyIncludedCt: 10_000,
    dailyGuardrailCt: 800,
    monthlyPriceUsd: 0,
    allowOverage: false
  },
  {
    id: 'creator',
    name: 'Creator',
    monthlyIncludedCt: 120_000,
    dailyGuardrailCt: 8_000,
    monthlyPriceUsd: 20,
    allowOverage: true
  },
  {
    id: 'pro',
    name: 'Pro',
    monthlyIncludedCt: 240_000,
    dailyGuardrailCt: 16_000,
    monthlyPriceUsd: 49,
    allowOverage: true
  },
  {
    id: 'studio',
    name: 'Studio',
    monthlyIncludedCt: 350_000,
    dailyGuardrailCt: 25_000,
    monthlyPriceUsd: 50,
    allowOverage: true
  },
  {
    id: 'custom',
    name: 'Custom Credits',
    monthlyIncludedCt: 0,
    dailyGuardrailCt: 20_000,
    monthlyPriceUsd: 0,
    allowOverage: true
  },
  {
    id: 'admin',
    name: 'Admin',
    monthlyIncludedCt: 5_000_000,
    dailyGuardrailCt: 500_000,
    monthlyPriceUsd: 0,
    allowOverage: false
  }
];

export const CREDIT_PACKS: CreditPackDefinition[] = [
  { id: 'pack_10', label: '$10 Pack', usd: 10, ct: 100_000 },
  { id: 'pack_25', label: '$25 Pack', usd: 25, ct: 260_000 },
  { id: 'pack_100', label: '$100 Pack', usd: 100, ct: 1_100_000 }
];

export type ModelPricing = {
  provider: string;
  model: string;
  inputPer1kUsd: number;
  outputPer1kUsd: number;
  imagePerOutputUsd: number;
  source: string;
  confidence: number;
  status: 'ACTIVE' | 'REVIEW_REQUIRED';
  effectiveFrom: string;
};

export const FALLBACK_MODEL_PRICING: ModelPricing[] = [
  {
    provider: 'gemini',
    model: 'gemini-2.5-flash',
    inputPer1kUsd: 0.0003,
    outputPer1kUsd: 0.0025,
    imagePerOutputUsd: 0,
    source: 'fallback/default',
    confidence: 0.5,
    status: 'ACTIVE',
    effectiveFrom: '2026-02-12T00:00:00.000Z'
  },
  {
    provider: 'gemini',
    model: 'gemini-2.5-flash-lite',
    inputPer1kUsd: 0.0001,
    outputPer1kUsd: 0.0004,
    imagePerOutputUsd: 0,
    source: 'fallback/default',
    confidence: 0.5,
    status: 'ACTIVE',
    effectiveFrom: '2026-02-12T00:00:00.000Z'
  },
  {
    provider: 'gemini',
    model: 'gemini-2.5-flash-image',
    inputPer1kUsd: 0,
    outputPer1kUsd: 0,
    imagePerOutputUsd: 0.039,
    source: 'fallback/default',
    confidence: 0.5,
    status: 'ACTIVE',
    effectiveFrom: '2026-02-12T00:00:00.000Z'
  },
  {
    provider: 'pixazo',
    model: 'pixazo/flux-1-schnell',
    inputPer1kUsd: 0,
    outputPer1kUsd: 0,
    imagePerOutputUsd: 0,
    source: 'fallback/default',
    confidence: 0.5,
    status: 'ACTIVE',
    effectiveFrom: '2026-02-12T00:00:00.000Z'
  }
];

const toPlanTier = (value: unknown): BillingPlanTier | null => {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (!normalized) return null;
  if ((tierOrder as string[]).includes(normalized)) {
    return normalized as BillingPlanTier;
  }
  return null;
};

export const resolvePlanDefinition = (
  planTier: BillingPlanTier | string | null | undefined
): BillingPlanDefinition => {
  const normalized = toPlanTier(planTier) || 'free';
  return DEFAULT_BILLING_PLANS.find((plan) => plan.id === normalized) || DEFAULT_BILLING_PLANS[0];
};

export const getCreditPackByUsd = (usd: number): CreditPackDefinition | undefined =>
  CREDIT_PACKS.find((pack) => pack.usd === usd);

export const getCreditPackById = (id: string): CreditPackDefinition | undefined =>
  CREDIT_PACKS.find((pack) => pack.id === id);

const mapModelPricingRow = (row: Record<string, unknown>): ModelPricing => ({
  provider: String(row.provider || 'gemini'),
  model: String(row.model_id || row.model || 'unknown'),
  inputPer1kUsd: clampFinite(row.input_per_1k, 0),
  outputPer1kUsd: clampFinite(row.output_per_1k, 0),
  imagePerOutputUsd: clampFinite(row.image_per_output, 0),
  source: String(row.source_url || 'unknown'),
  confidence: clampFinite(row.parser_confidence, 0.5),
  status: String(row.status || 'ACTIVE').toUpperCase() === 'REVIEW_REQUIRED' ? 'REVIEW_REQUIRED' : 'ACTIVE',
  effectiveFrom: String(row.effective_from || row.fetched_at || new Date().toISOString())
});

export const selectEffectiveModelPricing = (rows: Record<string, unknown>[]) => {
  const latestActiveByModel = new Map<string, ModelPricing>();
  const latestReviewByModel = new Map<string, ModelPricing>();

  for (const row of rows) {
    const mapped = mapModelPricingRow(row);
    const key = `${mapped.provider}:${mapped.model}`;
    if (mapped.status === 'ACTIVE' && !latestActiveByModel.has(key)) {
      latestActiveByModel.set(key, mapped);
    }
    if (mapped.status === 'REVIEW_REQUIRED' && !latestReviewByModel.has(key)) {
      latestReviewByModel.set(key, mapped);
    }
  }

  const merged = new Map<string, ModelPricing>();
  for (const [key, active] of latestActiveByModel.entries()) {
    merged.set(key, active);
  }
  for (const [key, review] of latestReviewByModel.entries()) {
    if (!merged.has(key)) {
      merged.set(key, review);
    }
  }

  return Array.from(merged.values());
};

export const getActiveModelPricingCatalog = async (): Promise<{ models: ModelPricing[]; lastSyncedAt?: string }> => {
  try {
    const admin = getSupabaseAdmin();
    const { data, error } = await admin
      .from('model_pricing_snapshots')
      .select('provider, model_id, input_per_1k, output_per_1k, image_per_output, source_url, parser_confidence, status, effective_from, fetched_at')
      .in('status', ['ACTIVE', 'REVIEW_REQUIRED'])
      .order('effective_from', { ascending: false });

    if (error || !Array.isArray(data) || data.length === 0) {
      return { models: FALLBACK_MODEL_PRICING };
    }

    let lastSyncedAt: string | undefined;

    for (const row of data) {
      const mapped = mapModelPricingRow(row as Record<string, unknown>);
      if (!lastSyncedAt) {
        lastSyncedAt = mapped.effectiveFrom;
      }
    }

    return { models: selectEffectiveModelPricing(data as Record<string, unknown>[]), lastSyncedAt };
  } catch {
    return { models: FALLBACK_MODEL_PRICING };
  }
};

export const resolveModelPricing = async (provider: string, model: string): Promise<ModelPricing> => {
  const catalog = await getActiveModelPricingCatalog();
  const normalizedProvider = provider.trim().toLowerCase();
  const normalizedModel = model.trim();

  const exact = catalog.models.find((item) => item.provider === normalizedProvider && item.model === normalizedModel);
  if (exact) return exact;

  const byModel = catalog.models.find((item) => item.model === normalizedModel);
  if (byModel) return byModel;

  const byProvider = catalog.models.find((item) => item.provider === normalizedProvider);
  if (byProvider) return byProvider;

  return FALLBACK_MODEL_PRICING[0];
};

export const getPlanCatalog = async (): Promise<BillingPlanDefinition[]> => {
  try {
    const admin = getSupabaseAdmin();
    const { data, error } = await admin
      .from('billing_plans')
      .select('id, name, monthly_included_ct, daily_guardrail_ct, monthly_price_usd, allow_overage, is_active')
      .eq('is_active', true);

    if (error || !Array.isArray(data) || data.length === 0) {
      return DEFAULT_BILLING_PLANS;
    }

    const mapped = data
      .map((row) => {
        const tier = toPlanTier((row as Record<string, unknown>).id);
        if (!tier) return null;
        return {
          id: tier,
          name: String((row as Record<string, unknown>).name || tier),
          monthlyIncludedCt: Math.max(0, Math.floor(clampFinite((row as Record<string, unknown>).monthly_included_ct, 0))),
          dailyGuardrailCt: Math.max(0, Math.floor(clampFinite((row as Record<string, unknown>).daily_guardrail_ct, 0))),
          monthlyPriceUsd: clampFinite((row as Record<string, unknown>).monthly_price_usd, 0),
          allowOverage: Boolean((row as Record<string, unknown>).allow_overage)
        } satisfies BillingPlanDefinition;
      })
      .filter((entry): entry is BillingPlanDefinition => !!entry)
      .sort((a, b) => tierOrder.indexOf(a.id) - tierOrder.indexOf(b.id));

    return mapped.length > 0 ? mapped : DEFAULT_BILLING_PLANS;
  } catch {
    return DEFAULT_BILLING_PLANS;
  }
};

const normalizeChangelogStatus = (value: unknown): PricingChangelogEntry['status'] =>
  String(value || 'ACTIVE').toUpperCase() === 'REVIEW_REQUIRED' ? 'REVIEW_REQUIRED' : 'ACTIVE';

const getPricingChangelog = async (): Promise<PricingChangelogEntry[]> => {
  try {
    const admin = getSupabaseAdmin();
    const { data, error } = await admin
      .from('pricing_changelog_entries')
      .select('created_at, status, summary, details')
      .order('created_at', { ascending: false })
      .limit(20);

    if (error || !Array.isArray(data)) {
      return [];
    }

    return data.map((row) => {
      const record = row as Record<string, unknown>;
      const details = record.details;
      return {
        createdAt: String(record.created_at || new Date().toISOString()),
        status: normalizeChangelogStatus(record.status),
        summary: String(record.summary || ''),
        details: details && typeof details === 'object'
          ? details as Record<string, unknown>
          : undefined
      };
    });
  } catch {
    return [];
  }
};

export const getPricingCatalog = async (): Promise<PricingCatalogResponse> => {
  const [plans, modelCatalog, pricingChangelog] = await Promise.all([
    getPlanCatalog(),
    getActiveModelPricingCatalog(),
    getPricingChangelog()
  ]);
  const planPricing = await getPlanPricingCatalog(plans);

  return {
    currency: DEFAULT_CURRENCY,
    ctPerUsd: Math.round(1 / CT_USD),
    markup: DEFAULT_MARKUP,
    plans,
    planPricing,
    creditPacks: CREDIT_PACKS,
    modelPricing: modelCatalog.models,
    lastSyncedAt: modelCatalog.lastSyncedAt,
    pricingChangelog
  };
};
