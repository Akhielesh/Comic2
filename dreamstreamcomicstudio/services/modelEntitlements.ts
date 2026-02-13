import type { BillingPlanTier, BillingSummaryResponse } from '../shared/types/billing';
import {
  getAllowedTextModelIdsForPlan,
  getDefaultTextModelForPlan,
  isProPlanTier,
  resolveEffectivePlanTier
} from './modelPolicy';
import {
  getAllowedImageModelsForPlan,
  getDefaultImageModelForPlan
} from './imageModels';

export const getPlanTierFromBillingSummary = (
  summary?: BillingSummaryResponse | null
): BillingPlanTier => {
  const rawTier = summary?.effectivePlan?.id || summary?.plan?.id || 'free';
  return resolveEffectivePlanTier(rawTier);
};

export const buildModelEntitlements = (summary?: BillingSummaryResponse | null) => {
  const planTier = getPlanTierFromBillingSummary(summary);
  const allowedTextModelIds = getAllowedTextModelIdsForPlan(planTier);
  const allowedImageModels = getAllowedImageModelsForPlan(planTier);
  return {
    planTier,
    isPro: isProPlanTier(planTier),
    allowedTextModelIds,
    allowedImageModelIds: allowedImageModels.map((model) => model.id),
    defaultTextModelId: getDefaultTextModelForPlan(planTier),
    defaultImageModelId: getDefaultImageModelForPlan(planTier).id
  };
};
