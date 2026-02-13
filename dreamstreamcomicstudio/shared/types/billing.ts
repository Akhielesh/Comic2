export type BillingPlanTier = 'free' | 'creator' | 'pro' | 'studio' | 'custom' | 'admin';
export type PurchasablePlanTier = 'creator' | 'pro' | 'studio';
export type CreditPackId = 'pack_10' | 'pack_25' | 'pack_100';
export type BillingInterval = 'month' | 'year';

export type BillingPlanDefinition = {
  id: BillingPlanTier;
  name: string;
  monthlyIncludedCt: number;
  dailyGuardrailCt: number;
  monthlyPriceUsd: number;
  allowOverage: boolean;
};

export type CreditPackDefinition = {
  id: CreditPackId;
  usd: number;
  ct: number;
  label: string;
};

export type BillingPlanPricing = {
  planTier: PurchasablePlanTier;
  interval: BillingInterval;
  priceUsd: number;
  stripePriceConfigured: boolean;
};

export type CouponEntitlementPolicy = {
  planTierOverride?: BillingPlanTier;
  includedMonthlyCtOverride?: number;
  dailyGuardrailCtOverride?: number;
  includedMonthlyCtBonus?: number;
  dailyGuardrailCtBonus?: number;
  bonusCt?: number;
  overageEnabledOverride?: boolean;
};

export type BillingCouponEntitlement = {
  assignmentId: string;
  couponDefinitionId: string;
  couponCode: string;
  startsAt: string;
  endsAt: string;
  policy: CouponEntitlementPolicy;
};

export type TokenBreakdownLine = {
  kind: 'input_tokens' | 'output_tokens' | 'image_units' | 'other_billable';
  quantity: number;
  unitPriceUsd: number;
  providerCostUsd: number;
  billableUsd: number;
  ct: number;
};

export type TokenEstimateRequest = {
  provider: 'gemini' | 'pixazo' | 'internal';
  model: string;
  operation: string;
  inputTokens?: number;
  outputTokens?: number;
  imageUnits?: number;
  otherBillableUnits?: number;
  otherBillableUnitPriceUsd?: number;
  projectId?: string;
  comicId?: string;
  stage?: string;
  byok?: boolean;
  metadata?: Record<string, unknown>;
};

export type TokenEstimateResponse = {
  currency: 'USD';
  ctPerUsd: number;
  markup: number;
  estimatedProviderCostUsd: number;
  estimatedBillableUsd: number;
  estimatedCt: number;
  lines: TokenBreakdownLine[];
  modelPricing: {
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
};

export type WalletBalance = {
  availableCt: number;
  reservedCt: number;
  purchasedCt: number;
  includedMonthlyCt: number;
  usedMonthlyCt: number;
  overageCt: number;
  pendingOverageUsd: number;
};

export type UsageLimitState = {
  planTier: BillingPlanTier;
  dailyGuardrailCt: number;
  dailyUsedCt: number;
  dailyRemainingCt: number;
  monthlyResetAt: string;
  dailyResetAt: string;
};

export type LimitExceededResolutionOptions = {
  canUpgrade: boolean;
  canAddCredits: boolean;
  canWaitForReset: boolean;
  paymentMethodRequired: boolean;
  recommendedAction: 'upgrade' | 'add_credits' | 'wait_for_reset';
};

export type LimitExceededReason =
  | 'DAILY_LIMIT_EXCEEDED'
  | 'MONTHLY_INCLUDED_EXHAUSTED'
  | 'INSUFFICIENT_CREDITS'
  | 'PAYMENT_METHOD_REQUIRED'
  | 'OVERAGE_CAP_REACHED';

export type LimitExceededDetails = {
  reason: LimitExceededReason;
  requiredCt: number;
  availableCt: number;
  resetAt: string;
  usage: UsageLimitState;
  options: LimitExceededResolutionOptions;
};

export type ReservationState = {
  reservationId?: string;
  byokBypass: boolean;
  estimated: TokenEstimateResponse;
  usage: UsageLimitState;
};

export type BillingSummaryResponse = {
  currency: 'USD';
  ctPerUsd: number;
  wallet: WalletBalance;
  usage: UsageLimitState;
  basePlan: BillingPlanDefinition;
  effectivePlan: BillingPlanDefinition;
  effectiveUsageSource: 'subscription' | 'coupon_entitlement' | 'fallback';
  activeCouponEntitlement?: BillingCouponEntitlement;
  plan: BillingPlanDefinition;
  hasPaymentMethodOnFile: boolean;
  overageEnabled: boolean;
  overageHardCapUsd: number;
  subscription?: BillingSubscriptionStatus;
  autoReload: {
    enabled: boolean;
    thresholdCt: number;
    packUsd: number;
  };
};

export type BillingSubscriptionStatus = {
  planTier: BillingPlanTier;
  status: string;
  interval?: BillingInterval;
  stripeStatus?: string;
  stripeSubscriptionId?: string;
  cancelAtPeriodEnd: boolean;
  cancelRequestedAt?: string;
  canceledAt?: string;
  currentPeriodStart?: string;
  currentPeriodEnd?: string;
};

export type PricingCatalogResponse = {
  currency: 'USD';
  ctPerUsd: number;
  markup: number;
  plans: BillingPlanDefinition[];
  planPricing: BillingPlanPricing[];
  creditPacks: CreditPackDefinition[];
  modelPricing: Array<{
    provider: string;
    model: string;
    inputPer1kUsd: number;
    outputPer1kUsd: number;
    imagePerOutputUsd: number;
    source: string;
    confidence: number;
    status: 'ACTIVE' | 'REVIEW_REQUIRED';
    effectiveFrom: string;
  }>;
  lastSyncedAt?: string;
  pricingChangelog?: Array<{
    createdAt: string;
    status: 'ACTIVE' | 'REVIEW_REQUIRED';
    summary: string;
    details?: Record<string, unknown>;
  }>;
};

export type CheckoutSessionResponse = {
  url: string;
  id: string;
};

export type CheckoutSessionConfirmResponse = {
  synced: boolean;
  subscription?: BillingSubscriptionStatus;
};

export type CouponRedemptionResult = {
  success: boolean;
  message: string;
  entitlement?: BillingCouponEntitlement;
};

export type AdminCouponDefinition = {
  id: string;
  code: string;
  startsAt: string;
  endsAt: string;
  isActive: boolean;
  policy: CouponEntitlementPolicy;
  createdAt: string;
  updatedAt: string;
};

export type AdminCouponAssignment = {
  id: string;
  couponDefinitionId: string;
  couponCode: string;
  userId?: string;
  email?: string;
  startsAt: string;
  endsAt: string;
  isActive: boolean;
  isRedeemed: boolean;
  redeemedAt?: string;
  revokedAt?: string;
  revokeReason?: string;
  createdAt: string;
  updatedAt: string;
};

export type AdminCouponRedemptionEvent = {
  id: string;
  couponDefinitionId: string;
  assignmentId?: string;
  userId?: string;
  email?: string;
  couponCode: string;
  outcome: string;
  reason?: string;
  createdAt: string;
};

export type BillingUsageHistoryItem = {
  id: string;
  createdAt: string;
  entryType: string;
  ctDelta: number;
  usdDelta: number;
  provider?: string;
  model?: string;
  operation?: string;
  projectId?: string;
  metadata?: Record<string, unknown>;
};

export type ComicCostReport = {
  comicId: string;
  totalEstimatedCt: number;
  totalActualCt: number;
  totalBillableUsd: number;
  totalProviderCostUsd: number;
  byStage: Record<string, { ct: number; usd: number }>;
  byModel: Record<string, { ct: number; usd: number }>;
  events: Array<{
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
  }>;
};
