import type { BillingPlanTier } from '../../../shared/types/billing.js';
import { getBillingSummary } from './billingLedger.js';
import { getSupabaseAdmin } from './supabase.js';

export type ModelAccessScope = 'text' | 'vision' | 'assistant' | 'image';

type EffectiveModelTier = 'free' | 'pro';

const FREE_TEXT_PRE_SUNSET_MODEL = 'gemini-2.0-flash';
const FREE_TEXT_POST_SUNSET_MODEL = 'gemini-2.5-flash';
const FREE_TEXT_SUNSET_SWITCH_AT = Date.parse('2026-03-31T00:00:00.000Z');
const FREE_TEXT_COMPAT_MODELS = new Set([
  FREE_TEXT_PRE_SUNSET_MODEL,
  FREE_TEXT_POST_SUNSET_MODEL
]);

export const FREE_NANO_BANANA_MODEL = 'gemini-2.5-flash-image';
export const FREE_NANO_BANANA_DAILY_CAP = 5;

const PRO_TEXT_MODELS = [
  'gemini-2.0-flash',
  'gemini-2.5-flash',
  'gemini-2.5-flash-lite',
  'gemini-3-flash-preview',
  'gemini-3-pro-preview'
] as const;

const PRO_IMAGE_MODELS = [
  'pixazo/flux-1-schnell',
  'gemini-2.5-flash-image',
  'gemini-3-pro-image-preview'
] as const;

const isMissingTableError = (error: unknown) => {
  const code = String((error as { code?: string })?.code || '').toUpperCase();
  return code === '42P01' || code === 'PGRST205';
};

const toEffectiveTier = (planTier: BillingPlanTier | string | undefined): EffectiveModelTier => {
  const normalized = String(planTier || 'free').trim().toLowerCase();
  if (normalized === 'pro' || normalized === 'studio' || normalized === 'admin') {
    return 'pro';
  }
  return 'free';
};

const normalizeModel = (model: string) => {
  const trimmed = model.trim();
  if (!trimmed) return '';
  if (trimmed.startsWith('models/')) {
    return trimmed.slice('models/'.length);
  }
  return trimmed;
};

const nowMs = (at?: Date | string | number) => {
  if (typeof at === 'number') return at;
  if (typeof at === 'string') {
    const parsed = Date.parse(at);
    if (Number.isFinite(parsed)) return parsed;
  }
  if (at instanceof Date) return at.getTime();
  return Date.now();
};

const utcDate = (at: number) => {
  const d = new Date(at);
  const year = d.getUTCFullYear();
  const month = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
};

const resolveFreeTextModel = (atMs: number) =>
  atMs >= FREE_TEXT_SUNSET_SWITCH_AT
    ? FREE_TEXT_POST_SUNSET_MODEL
    : FREE_TEXT_PRE_SUNSET_MODEL;

export const resolveAllowedModels = (
  scope: ModelAccessScope,
  planTier: BillingPlanTier | string | undefined,
  at?: Date | string | number
) => {
  const tier = toEffectiveTier(planTier);
  const atMs = nowMs(at);

  if (scope === 'image') {
    if (tier === 'pro') return [...PRO_IMAGE_MODELS];
    return ['pixazo/flux-1-schnell', FREE_NANO_BANANA_MODEL];
  }

  if (tier === 'pro') return [...PRO_TEXT_MODELS];
  return [resolveFreeTextModel(atMs)];
};

const createModelNotAllowedError = (input: {
  scope: ModelAccessScope;
  planTier: BillingPlanTier | string | undefined;
  requestedModel: string;
  allowedModels: string[];
  atMs?: number;
}) => {
  const error = new Error('Selected model is not available for this plan tier.') as Error & {
    status?: number;
    publicCode?: string;
    details?: Record<string, unknown>;
  };
  error.status = 403;
  error.publicCode = 'MODEL_NOT_ALLOWED_FOR_PLAN';
  error.details = {
    scope: input.scope,
    planTier: String(input.planTier || 'free').toLowerCase(),
    requestedModel: input.requestedModel,
    allowedModels: input.allowedModels,
    effectiveFreeTextModel: resolveFreeTextModel(input.atMs || Date.now()),
    freeTextModelSunsetAt: new Date(FREE_TEXT_SUNSET_SWITCH_AT).toISOString()
  };
  return error;
};

export const assertModelAllowedForTier = (input: {
  scope: ModelAccessScope;
  planTier: BillingPlanTier | string | undefined;
  requestedModel: string;
  at?: Date | string | number;
}) => {
  const atMs = nowMs(input.at);
  const effectiveTier = toEffectiveTier(input.planTier);
  const requestedModel = normalizeModel(input.requestedModel);
  const allowedModels = resolveAllowedModels(input.scope, input.planTier, atMs);

  if (effectiveTier === 'free' && input.scope !== 'image') {
    const freeModel = resolveFreeTextModel(atMs);
    if (!requestedModel || FREE_TEXT_COMPAT_MODELS.has(requestedModel)) {
      return {
        requestedModel: requestedModel || freeModel,
        effectiveModel: freeModel,
        allowedModels,
        coerced: freeModel !== requestedModel
      };
    }
  }

  const allowed = allowedModels.map(normalizeModel).includes(requestedModel);
  if (!allowed) {
    throw createModelNotAllowedError({
      scope: input.scope,
      planTier: input.planTier,
      requestedModel,
      allowedModels,
      atMs
    });
  }
  return {
    requestedModel,
    effectiveModel: requestedModel,
    allowedModels,
    coerced: false
  };
};

export const resolvePlanTierForUser = async (userId: string): Promise<BillingPlanTier> => {
  const summary = await getBillingSummary(userId);
  return summary.plan.id;
};

export const assertModelAllowedForUser = async (input: {
  userId: string;
  scope: ModelAccessScope;
  requestedModel: string;
  at?: Date | string | number;
}) => {
  const planTier = await resolvePlanTierForUser(input.userId);
  return assertModelAllowedForTier({
    scope: input.scope,
    planTier,
    requestedModel: input.requestedModel,
    at: input.at
  });
};

export const isFreeNanoBananaModel = (modelId: string) =>
  normalizeModel(modelId) === FREE_NANO_BANANA_MODEL;

export const tryConsumeFreeNanoBananaUsage = async (input: {
  userId: string;
  planTier: BillingPlanTier | string | undefined;
  modelId: string;
  at?: Date | string | number;
}) => {
  if (toEffectiveTier(input.planTier) !== 'free' || !isFreeNanoBananaModel(input.modelId)) {
    return {
      applied: false as const,
      allowed: true as const,
      usedCount: 0,
      limit: FREE_NANO_BANANA_DAILY_CAP
    };
  }

  const atMs = nowMs(input.at);
  const usageDate = utcDate(atMs);
  const admin = getSupabaseAdmin();
  const { data, error } = await admin.rpc('free_tier_try_consume_model_usage', {
    p_user_id: input.userId,
    p_model_id: FREE_NANO_BANANA_MODEL,
    p_usage_date: usageDate,
    p_limit: FREE_NANO_BANANA_DAILY_CAP
  });

  if (error) {
    if (isMissingTableError(error)) {
      const migrationError = new Error('Missing free-tier model usage tracking table/function. Apply latest SQL migration.') as Error & {
        status?: number;
        publicCode?: string;
      };
      migrationError.status = 503;
      migrationError.publicCode = 'MODEL_USAGE_BACKEND_UNAVAILABLE';
      throw migrationError;
    }
    throw error;
  }

  const row = (data || {}) as Record<string, unknown>;
  const usedCount = Math.max(0, Math.floor(Number(row.used_count || 0)));
  const limit = Math.max(1, Math.floor(Number(row.limit || FREE_NANO_BANANA_DAILY_CAP)));
  const allowed = row.allowed === true;
  const resetAt = new Date(Date.UTC(
    Number(usageDate.slice(0, 4)),
    Number(usageDate.slice(5, 7)) - 1,
    Number(usageDate.slice(8, 10)) + 1,
    0,
    0,
    0,
    0
  )).toISOString();

  return {
    applied: true as const,
    allowed,
    usedCount,
    limit,
    remaining: Math.max(0, limit - usedCount),
    resetAt
  };
};

export const createFreeNanoBananaLimitError = (input: {
  usedCount: number;
  limit: number;
  resetAt: string;
}) => {
  const error = new Error('Free Nano Banana daily limit reached.') as Error & {
    status?: number;
    publicCode?: string;
    details?: Record<string, unknown>;
  };
  error.status = 402;
  error.publicCode = 'FREE_MODEL_DAILY_LIMIT_REACHED';
  error.details = {
    reason: 'FREE_MODEL_DAILY_LIMIT_REACHED',
    model: FREE_NANO_BANANA_MODEL,
    usedCount: input.usedCount,
    limit: input.limit,
    remaining: Math.max(0, input.limit - input.usedCount),
    resetAt: input.resetAt
  };
  return error;
};
