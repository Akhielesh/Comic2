import type {
  AdminCouponAssignment,
  AdminCouponDefinition,
  AdminCouponRedemptionEvent,
  BillingInterval,
  BillingSubscriptionStatus,
  BillingSummaryResponse,
  CheckoutSessionConfirmResponse,
  CheckoutSessionResponse,
  ComicCostReport,
  CouponPreviewResult,
  CouponRedemptionResult,
  CreditPackId,
  PricingCatalogResponse,
  PurchasablePlanTier,
  TokenEstimateRequest,
  TokenEstimateResponse
} from '../shared/types/billing';
import { get, post } from './apiClient';

export const getPricingCatalog = async (): Promise<PricingCatalogResponse> =>
  get<PricingCatalogResponse>('/api/billing/pricing-catalog');

export const getBillingSummary = async (): Promise<BillingSummaryResponse> =>
  get<BillingSummaryResponse>('/api/billing/summary');

export const getSubscriptionStatus = async (): Promise<BillingSubscriptionStatus> =>
  get<BillingSubscriptionStatus>('/api/billing/subscription-status');

export const estimateTokenCharge = async (payload: TokenEstimateRequest): Promise<TokenEstimateResponse> =>
  post<TokenEstimateRequest, TokenEstimateResponse>('/api/billing/estimate', payload);

export const reserveTokenCharge = async (payload: TokenEstimateRequest) =>
  post<TokenEstimateRequest, { allowed: boolean; reservation?: unknown }>('/api/billing/reserve', payload);

export const settleTokenCharge = async (payload: Record<string, unknown>) =>
  post<Record<string, unknown>, Record<string, unknown>>('/api/billing/settle', payload);

export const setupPaymentMethod = async () =>
  post<Record<string, never>, { customerId: string; setupIntentClientSecret: string }>('/api/billing/setup-payment-method', {});

export const createSubscriptionCheckout = async (
  planTier: PurchasablePlanTier,
  interval: BillingInterval
): Promise<CheckoutSessionResponse> =>
  post<{ planTier: PurchasablePlanTier; interval: BillingInterval }, CheckoutSessionResponse>('/api/billing/checkout/subscription', { planTier, interval });

export const createCreditPackCheckout = async (packId: CreditPackId): Promise<CheckoutSessionResponse> =>
  post<{ packId: CreditPackId }, CheckoutSessionResponse>('/api/billing/checkout/credits', { packId });

export const confirmCheckoutSession = async (sessionId: string): Promise<CheckoutSessionConfirmResponse> =>
  post<{ sessionId: string }, CheckoutSessionConfirmResponse>('/api/billing/checkout/confirm', { sessionId });

export const createBillingPortal = async (returnUrl?: string): Promise<{ url: string }> =>
  post<{ returnUrl?: string }, { url: string }>('/api/billing/portal', { returnUrl });

export const cancelSubscription = async (): Promise<BillingSubscriptionStatus> =>
  post<Record<string, never>, BillingSubscriptionStatus>('/api/billing/subscription/cancel', {});

export const reactivateSubscription = async (): Promise<BillingSubscriptionStatus> =>
  post<Record<string, never>, BillingSubscriptionStatus>('/api/billing/subscription/reactivate', {});

export const updateAutoReload = async (payload: { enabled: boolean; thresholdCt?: number; packUsd?: number }) =>
  post<typeof payload, { enabled: boolean; thresholdCt: number; packUsd: number }>('/api/billing/auto-reload', payload);

export const getUsageHistory = async (limit = 100) =>
  get<{ items: Array<Record<string, unknown>> }>(`/api/billing/usage-history?limit=${Math.max(1, Math.floor(limit))}`);

export const getComicCost = async (comicId: string): Promise<ComicCostReport> =>
  get<ComicCostReport>(`/api/billing/comic-cost/${encodeURIComponent(comicId)}`);

export const redeemCoupon = async (couponCode: string): Promise<CouponRedemptionResult & { summary?: BillingSummaryResponse }> =>
  post<{ couponCode: string }, CouponRedemptionResult & { summary?: BillingSummaryResponse }>('/api/billing/coupons/redeem', { couponCode });

export const previewCoupon = async (couponCode: string): Promise<CouponPreviewResult> =>
  post<{ couponCode: string }, CouponPreviewResult>('/api/billing/coupons/preview', { couponCode });

export const listAdminCoupons = async (limit = 100): Promise<{
  definitions: AdminCouponDefinition[];
  assignments: AdminCouponAssignment[];
  events: AdminCouponRedemptionEvent[];
  nextCursor?: string;
}> =>
  get<{
    definitions: AdminCouponDefinition[];
    assignments: AdminCouponAssignment[];
    events: AdminCouponRedemptionEvent[];
    nextCursor?: string;
  }>(`/api/billing/admin/coupons?limit=${Math.max(10, Math.floor(limit))}`);

export const listAdminCouponsByCursor = async (input: {
  limit?: number;
  cursor?: string;
}): Promise<{
  definitions: AdminCouponDefinition[];
  assignments: AdminCouponAssignment[];
  events: AdminCouponRedemptionEvent[];
  nextCursor?: string;
}> =>
  get<{
    definitions: AdminCouponDefinition[];
    assignments: AdminCouponAssignment[];
    events: AdminCouponRedemptionEvent[];
    nextCursor?: string;
  }>(`/api/billing/admin/coupons?limit=${Math.max(10, Math.floor(input.limit || 100))}${input.cursor ? `&cursor=${encodeURIComponent(input.cursor)}` : ''}`);

export const createAdminCouponDefinition = async (payload: {
  tokenAmountCt: number;
  validForHours: number;
}) =>
  post<typeof payload, AdminCouponDefinition>('/api/billing/admin/coupons', payload);

export const assignAdminCouponDefinition = async (payload: {
  couponDefinitionId: string;
  userId?: string;
  email?: string;
  startsAt: string;
  endsAt: string;
}) =>
  post<typeof payload, AdminCouponAssignment>('/api/billing/admin/coupons/assign', payload);

export const revokeAdminCouponAssignment = async (assignmentId: string, reason?: string) =>
  post<{ reason?: string }, AdminCouponAssignment>(`/api/billing/admin/coupons/assignments/${encodeURIComponent(assignmentId)}/revoke`, { reason });

// Backward compatible wrappers
export const createCheckoutSession = async (
  planTier: PurchasablePlanTier = 'creator',
  interval: BillingInterval = 'month'
) =>
  createSubscriptionCheckout(planTier, interval);

export const addCredits = async (packId: CreditPackId) =>
  createCreditPackCheckout(packId);
