import type {
  BillingInterval,
  BillingPlanDefinition,
  BillingPlanTier,
  CreditPackDefinition,
  PricingCatalogResponse
} from '../../../shared/types/billing.js';
import { getSupabaseAdmin } from './supabase.js';
import { getPlanPricingCatalog } from './stripePriceConfig.js';
import { IMAGE_MODELS } from '../../../shared/comic/models.js';

export const CT_USD = 0.0001;
export const DEFAULT_MARKUP = Number(process.env.BILLING_PLATFORM_MARKUP || '1.30');
export const DEFAULT_CURRENCY = 'USD' as const;

const clampFinite = (value: unknown, fallback: number, min = 0) => {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric < min) return fallback;
  return numeric;
};

const tierOrder: BillingPlanTier[] = ['free', 'creator', 'pro', 'studio', 'custom', 'admin'];
const intervalOrder: BillingInterval[] = ['month', 'year'];
type PricingChangelogEntry = NonNullable<PricingCatalogResponse['pricingChangelog']>[number];

export const DEFAULT_BILLING_PLANS: BillingPlanDefinition[] = [
  {
    id: 'free',
    name: 'Free',
    monthlyIncludedCt: 10_000,
    dailyGuardrailCt: 800,
    dailyLimitEnabled: true,
    monthlyPriceUsd: 0,
    allowOverage: false
  },
  {
    id: 'creator',
    name: 'Creator',
    monthlyIncludedCt: 120_000,
    dailyGuardrailCt: 0,
    dailyLimitEnabled: false,
    monthlyPriceUsd: 11.99,
    allowOverage: true
  },
  {
    id: 'pro',
    name: 'Pro',
    monthlyIncludedCt: 240_000,
    dailyGuardrailCt: 16_000,
    dailyLimitEnabled: true,
    monthlyPriceUsd: 49,
    allowOverage: true
  },
  {
    id: 'studio',
    name: 'Studio',
    monthlyIncludedCt: 390_000,
    dailyGuardrailCt: 0,
    dailyLimitEnabled: false,
    monthlyPriceUsd: 39.99,
    allowOverage: true
  },
  {
    id: 'custom',
    name: 'Custom Credits',
    monthlyIncludedCt: 0,
    dailyGuardrailCt: 0,
    dailyLimitEnabled: false,
    monthlyPriceUsd: 0,
    allowOverage: true
  },
  {
    id: 'admin',
    name: 'Admin',
    monthlyIncludedCt: 5_000_000,
    dailyGuardrailCt: 0,
    dailyLimitEnabled: false,
    monthlyPriceUsd: 0,
    allowOverage: false
  }
];

export type BillingPlanEntitlement = {
  planTier: BillingPlanTier;
  interval: BillingInterval;
  includedMonthlyCt: number;
  dailyGuardrailCt: number;
  dailyLimitEnabled: boolean;
  isActive: boolean;
};

export const DEFAULT_PLAN_ENTITLEMENTS: BillingPlanEntitlement[] = [
  { planTier: 'free', interval: 'month', includedMonthlyCt: 10_000, dailyGuardrailCt: 800, dailyLimitEnabled: true, isActive: true },
  { planTier: 'free', interval: 'year', includedMonthlyCt: 10_000, dailyGuardrailCt: 800, dailyLimitEnabled: true, isActive: true },
  { planTier: 'creator', interval: 'month', includedMonthlyCt: 120_000, dailyGuardrailCt: 0, dailyLimitEnabled: false, isActive: true },
  { planTier: 'creator', interval: 'year', includedMonthlyCt: 100_000, dailyGuardrailCt: 0, dailyLimitEnabled: false, isActive: true },
  { planTier: 'pro', interval: 'month', includedMonthlyCt: 240_000, dailyGuardrailCt: 16_000, dailyLimitEnabled: true, isActive: true },
  { planTier: 'pro', interval: 'year', includedMonthlyCt: 240_000, dailyGuardrailCt: 16_000, dailyLimitEnabled: true, isActive: true },
  { planTier: 'studio', interval: 'month', includedMonthlyCt: 390_000, dailyGuardrailCt: 0, dailyLimitEnabled: false, isActive: true },
  { planTier: 'studio', interval: 'year', includedMonthlyCt: 340_000, dailyGuardrailCt: 0, dailyLimitEnabled: false, isActive: true },
  { planTier: 'custom', interval: 'month', includedMonthlyCt: 0, dailyGuardrailCt: 0, dailyLimitEnabled: false, isActive: true },
  { planTier: 'custom', interval: 'year', includedMonthlyCt: 0, dailyGuardrailCt: 0, dailyLimitEnabled: false, isActive: true },
  { planTier: 'admin', interval: 'month', includedMonthlyCt: 5_000_000, dailyGuardrailCt: 0, dailyLimitEnabled: false, isActive: true },
  { planTier: 'admin', interval: 'year', includedMonthlyCt: 5_000_000, dailyGuardrailCt: 0, dailyLimitEnabled: false, isActive: true }
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

/**
 * Per-image price the ledger uses for a registry image model. One row can hold one
 * price, so it is the 2K price (the studio's Standard/Pro page resolution) when listed,
 * else the highest listed price — reservations err high and are trued up at
 * settlement (provider-reported cost, or billing.ts's per-resolution registry price).
 */
export const registryImagePriceUsd = (priceUsd: Partial<Record<string, number>>): number => {
  if (typeof priceUsd['2K'] === 'number') return priceUsd['2K'];
  const values = Object.values(priceUsd).filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
  return values.length ? Math.max(...values) : 0;
};

/** Hand-maintained rows above win over generated ones for the same provider:model. */
const HAND_PRICED_IMAGE_MODELS = new Set(['gemini:gemini-2.5-flash-image', 'openrouter:google/gemini-2.5-flash-image']);

function comicImageModelPricing(): ModelPricing[] {
  const rows: ModelPricing[] = [];
  for (const spec of IMAGE_MODELS) {
    const price = registryImagePriceUsd(spec.priceUsd);
    if (!price) continue;
    for (const [route, modelId] of Object.entries(spec.routes)) {
      if (!modelId) continue;
      const provider = route === 'gemini' ? 'gemini' : 'openrouter';
      if (HAND_PRICED_IMAGE_MODELS.has(`${provider}:${modelId}`)) continue;
      rows.push({
        provider,
        model: modelId,
        inputPer1kUsd: 0,
        outputPer1kUsd: 0,
        imagePerOutputUsd: price,
        source: 'fallback/comic-registry',
        confidence: 0.6,
        status: 'ACTIVE',
        effectiveFrom: '2026-10-21T00:00:00.000Z'
      });
    }
  }
  return rows;
}

export const FALLBACK_MODEL_PRICING: ModelPricing[] = [
  {
    provider: 'gemini',
    model: 'gemini-2.0-flash',
    inputPer1kUsd: 0.0003,
    outputPer1kUsd: 0.0025,
    imagePerOutputUsd: 0,
    source: 'fallback/default',
    confidence: 0.5,
    status: 'ACTIVE',
    effectiveFrom: '2026-02-13T00:00:00.000Z'
  },
  {
    provider: 'gemini',
    model: 'gemini-2.5-flash',
    inputPer1kUsd: 0.0003,
    outputPer1kUsd: 0.0025,
    imagePerOutputUsd: 0,
    source: 'fallback/default',
    confidence: 0.5,
    status: 'ACTIVE',
    effectiveFrom: '2026-02-13T00:00:00.000Z'
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
    effectiveFrom: '2026-02-13T00:00:00.000Z'
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
    effectiveFrom: '2026-02-13T00:00:00.000Z'
  },
  {
    provider: 'gemini',
    model: 'gemini-3-flash-preview',
    inputPer1kUsd: 0.0004,
    outputPer1kUsd: 0.003,
    imagePerOutputUsd: 0,
    source: 'fallback/default',
    confidence: 0.5,
    status: 'ACTIVE',
    effectiveFrom: '2026-02-13T00:00:00.000Z'
  },
  {
    provider: 'gemini',
    model: 'gemini-3-pro-preview',
    inputPer1kUsd: 0.001,
    outputPer1kUsd: 0.006,
    imagePerOutputUsd: 0,
    source: 'fallback/default',
    confidence: 0.5,
    status: 'ACTIVE',
    effectiveFrom: '2026-02-13T00:00:00.000Z'
  },
  {
    provider: 'gemini',
    model: 'gemini-3-pro-image-preview',
    inputPer1kUsd: 0,
    outputPer1kUsd: 0,
    imagePerOutputUsd: 0.134,
    source: 'fallback/default',
    confidence: 0.5,
    status: 'ACTIVE',
    effectiveFrom: '2026-02-13T00:00:00.000Z'
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
    effectiveFrom: '2026-02-13T00:00:00.000Z'
  },
  {
    provider: 'ideogram',
    model: 'ideogram/ideogram-v2',
    inputPer1kUsd: 0,
    outputPer1kUsd: 0,
    imagePerOutputUsd: 0.08,
    source: 'fallback/default',
    confidence: 0.5,
    status: 'ACTIVE',
    effectiveFrom: '2026-02-13T00:00:00.000Z'
  },
  {
    provider: 'ideogram',
    model: 'ideogram/ideogram-v2-turbo',
    inputPer1kUsd: 0,
    outputPer1kUsd: 0,
    imagePerOutputUsd: 0.05,
    source: 'fallback/default',
    confidence: 0.5,
    status: 'ACTIVE',
    effectiveFrom: '2026-02-13T00:00:00.000Z'
  },
  // --- OpenRouter fallbacks (the daily pricing sync overwrites these from /models) ---
  {
    provider: 'openrouter',
    model: 'google/gemini-2.5-flash',
    inputPer1kUsd: 0.0003,
    outputPer1kUsd: 0.0025,
    imagePerOutputUsd: 0,
    source: 'fallback/openrouter',
    confidence: 0.4,
    status: 'REVIEW_REQUIRED',
    effectiveFrom: '2026-02-13T00:00:00.000Z'
  },
  {
    provider: 'openrouter',
    model: 'google/gemini-2.5-flash-image',
    inputPer1kUsd: 0,
    outputPer1kUsd: 0,
    imagePerOutputUsd: 0.04,
    source: 'fallback/openrouter',
    confidence: 0.4,
    status: 'REVIEW_REQUIRED',
    effectiveFrom: '2026-02-13T00:00:00.000Z'
  },
  {
    provider: 'openrouter',
    model: 'google/gemini-2.0-flash-exp:free',
    inputPer1kUsd: 0,
    outputPer1kUsd: 0,
    imagePerOutputUsd: 0,
    source: 'fallback/openrouter',
    confidence: 0.4,
    status: 'REVIEW_REQUIRED',
    effectiveFrom: '2026-02-13T00:00:00.000Z'
  },
  // --- Comic Studio v4 text roles (server/src/comic/textModels.ts). OpenRouter list prices
  //     2026-10-21; the Google ones are also priced for the Gemini-direct route. ---
  {
    provider: 'openrouter',
    model: 'google/gemini-3.8-flash',
    inputPer1kUsd: 0.000825,
    outputPer1kUsd: 0.004125,
    imagePerOutputUsd: 0,
    source: 'fallback/openrouter',
    confidence: 0.6,
    status: 'ACTIVE',
    effectiveFrom: '2026-10-21T00:00:00.000Z'
  },
  {
    provider: 'openrouter',
    model: 'anthropic/claude-sonnet-5.5',
    inputPer1kUsd: 0.002,
    outputPer1kUsd: 0.01,
    imagePerOutputUsd: 0,
    source: 'fallback/openrouter',
    confidence: 0.6,
    status: 'ACTIVE',
    effectiveFrom: '2026-10-21T00:00:00.000Z'
  },
  {
    provider: 'openrouter',
    model: 'openai/gpt-6-luna',
    inputPer1kUsd: 0.0001,
    outputPer1kUsd: 0.0005,
    imagePerOutputUsd: 0,
    source: 'fallback/openrouter',
    confidence: 0.6,
    status: 'ACTIVE',
    effectiveFrom: '2026-10-21T00:00:00.000Z'
  },
  {
    provider: 'openrouter',
    model: 'google/gemini-4-argon',
    inputPer1kUsd: 0.002,
    outputPer1kUsd: 0.01,
    imagePerOutputUsd: 0,
    source: 'fallback/openrouter',
    confidence: 0.6,
    status: 'ACTIVE',
    effectiveFrom: '2026-10-21T00:00:00.000Z'
  },
  {
    provider: 'openrouter',
    model: 'google/gemini-3.7-flash',
    inputPer1kUsd: 0.00075,
    outputPer1kUsd: 0.00375,
    imagePerOutputUsd: 0,
    source: 'fallback/openrouter',
    confidence: 0.6,
    status: 'ACTIVE',
    effectiveFrom: '2026-10-21T00:00:00.000Z'
  },
  {
    provider: 'gemini',
    model: 'gemini-3.8-flash',
    inputPer1kUsd: 0.000825,
    outputPer1kUsd: 0.004125,
    imagePerOutputUsd: 0,
    source: 'fallback/default',
    confidence: 0.5,
    status: 'ACTIVE',
    effectiveFrom: '2026-10-21T00:00:00.000Z'
  },
  {
    provider: 'gemini',
    model: 'gemini-4-argon',
    inputPer1kUsd: 0.002,
    outputPer1kUsd: 0.01,
    imagePerOutputUsd: 0,
    source: 'fallback/default',
    confidence: 0.5,
    status: 'ACTIVE',
    effectiveFrom: '2026-10-21T00:00:00.000Z'
  },
  {
    provider: 'gemini',
    model: 'gemini-3.7-flash',
    inputPer1kUsd: 0.00075,
    outputPer1kUsd: 0.00375,
    imagePerOutputUsd: 0,
    source: 'fallback/default',
    confidence: 0.5,
    status: 'ACTIVE',
    effectiveFrom: '2026-10-21T00:00:00.000Z'
  },
  // --- Comic Studio v4 image models, generated from the capability registry
  //     (shared/comic/models.ts) for both transports — see comicImageModelPricing below. ---
  ...comicImageModelPricing()
];

const toPlanTier = (value: unknown): BillingPlanTier | null => {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (!normalized) return null;
  if ((tierOrder as string[]).includes(normalized)) {
    return normalized as BillingPlanTier;
  }
  return null;
};

const toBillingInterval = (value: unknown): BillingInterval | null => {
  if (value === 'month' || value === 'year') return value;
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

/** Ids that name an image-generation model (never priced from a text row). */
const IMAGE_MODEL_ID_RE = /image|banana|flux|seedream|imagen|dall-?e|ideogram|stable-diffusion|sdxl|recraft|midjourney/i;

export const looksLikeImageModel = (model: string): boolean => IMAGE_MODEL_ID_RE.test(model);

export const resolveModelPricing = async (provider: string, model: string): Promise<ModelPricing> => {
  const catalog = await getActiveModelPricingCatalog();
  const normalizedProvider = provider.trim().toLowerCase();
  const normalizedModel = model.trim();

  const exact = catalog.models.find((item) => item.provider === normalizedProvider && item.model === normalizedModel);
  if (exact) return exact;

  const byModel = catalog.models.find((item) => item.model === normalizedModel);
  if (byModel) return byModel;

  // A live snapshot table may predate a model the fallback rows already price (new
  // registry entries) — prefer that known price over a provider-wide guess.
  if (catalog.models !== FALLBACK_MODEL_PRICING) {
    const fallbackExact =
      FALLBACK_MODEL_PRICING.find((item) => item.provider === normalizedProvider && item.model === normalizedModel) ||
      FALLBACK_MODEL_PRICING.find((item) => item.model === normalizedModel);
    if (fallbackExact) return fallbackExact;
  }

  // An unknown IMAGE model must never resolve to a text row (imagePerOutputUsd 0 would
  // bill every image at $0). Use the provider's most expensive known image price so a
  // reservation errs high; settlement trues it up with the reported cost.
  if (looksLikeImageModel(normalizedModel)) {
    const providerImageRows = (rows: ModelPricing[]) =>
      rows.filter((item) => item.provider === normalizedProvider && item.imagePerOutputUsd > 0);
    const pool = [
      providerImageRows(catalog.models),
      providerImageRows(FALLBACK_MODEL_PRICING),
      FALLBACK_MODEL_PRICING.filter((item) => item.imagePerOutputUsd > 0)
    ].find((rows) => rows.length > 0);
    if (pool) return pool.reduce((max, item) => (item.imagePerOutputUsd > max.imagePerOutputUsd ? item : max));
  }

  const byProvider = catalog.models.find((item) => item.provider === normalizedProvider);
  if (byProvider) return byProvider;

  return FALLBACK_MODEL_PRICING[0];
};

export const getPlanCatalog = async (): Promise<BillingPlanDefinition[]> => {
  try {
    const admin = getSupabaseAdmin();
    const { data, error } = await admin
      .from('billing_plans')
      .select('id, name, monthly_included_ct, daily_guardrail_ct, daily_limit_enabled, monthly_price_usd, allow_overage, is_active')
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
          dailyLimitEnabled: (row as Record<string, unknown>).daily_limit_enabled === true
            || Math.max(0, Math.floor(clampFinite((row as Record<string, unknown>).daily_guardrail_ct, 0))) > 0,
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

export const getPlanEntitlementCatalog = async (): Promise<BillingPlanEntitlement[]> => {
  try {
    const admin = getSupabaseAdmin();
    const { data, error } = await admin
      .from('billing_plan_entitlements')
      .select('plan_tier, interval, included_monthly_ct, daily_guardrail_ct, daily_limit_enabled, is_active')
      .eq('is_active', true);

    if (error || !Array.isArray(data) || data.length === 0) {
      return DEFAULT_PLAN_ENTITLEMENTS;
    }

    const mapped = data
      .map((row): BillingPlanEntitlement | null => {
        const record = row as Record<string, unknown>;
        const planTier = toPlanTier(record.plan_tier);
        const interval = toBillingInterval(record.interval);
        if (!planTier || !interval) return null;
        const includedMonthlyCt = Math.max(0, Math.floor(clampFinite(record.included_monthly_ct, 0)));
        const dailyGuardrailCt = Math.max(0, Math.floor(clampFinite(record.daily_guardrail_ct, 0)));
        const dailyLimitEnabled = record.daily_limit_enabled === true || dailyGuardrailCt > 0;
        return {
          planTier,
          interval,
          includedMonthlyCt,
          dailyGuardrailCt,
          dailyLimitEnabled,
          isActive: true
        };
      })
      .filter((entry): entry is BillingPlanEntitlement => entry !== null)
      .sort((a, b) => {
        const planOrder = tierOrder.indexOf(a.planTier) - tierOrder.indexOf(b.planTier);
        if (planOrder !== 0) return planOrder;
        return intervalOrder.indexOf(a.interval) - intervalOrder.indexOf(b.interval);
      });

    return mapped.length > 0 ? mapped : DEFAULT_PLAN_ENTITLEMENTS;
  } catch {
    return DEFAULT_PLAN_ENTITLEMENTS;
  }
};

export const resolvePlanEntitlement = async (
  planTier: BillingPlanTier | string | null | undefined,
  interval: BillingInterval = 'month'
): Promise<BillingPlanEntitlement> => {
  const normalizedPlan = toPlanTier(planTier) || 'free';
  const catalog = await getPlanEntitlementCatalog();
  const exact = catalog.find((entry) => entry.planTier === normalizedPlan && entry.interval === interval);
  if (exact) return exact;
  const monthlyFallback = catalog.find((entry) => entry.planTier === normalizedPlan && entry.interval === 'month');
  if (monthlyFallback) return monthlyFallback;

  const plan = resolvePlanDefinition(normalizedPlan);
  return {
    planTier: plan.id,
    interval,
    includedMonthlyCt: plan.monthlyIncludedCt,
    dailyGuardrailCt: plan.dailyGuardrailCt,
    dailyLimitEnabled: plan.dailyLimitEnabled,
    isActive: true
  };
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
  const [plans, entitlements, modelCatalog, pricingChangelog] = await Promise.all([
    getPlanCatalog(),
    getPlanEntitlementCatalog(),
    getActiveModelPricingCatalog(),
    getPricingChangelog()
  ]);
  const publicPlans = plans.filter((plan) => plan.id !== 'pro');
  const publicEntitlements = entitlements.filter((entry) => entry.planTier !== 'pro');
  const planPricing = await getPlanPricingCatalog(publicPlans, publicEntitlements);

  return {
    currency: DEFAULT_CURRENCY,
    ctPerUsd: Math.round(1 / CT_USD),
    markup: DEFAULT_MARKUP,
    plans: publicPlans,
    planPricing,
    creditPacks: CREDIT_PACKS,
    modelPricing: modelCatalog.models,
    lastSyncedAt: modelCatalog.lastSyncedAt,
    pricingChangelog
  };
};
