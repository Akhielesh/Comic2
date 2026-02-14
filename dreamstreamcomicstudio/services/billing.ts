import type {
  AdminAccessResponse,
  AdminCouponAssignment,
  AdminCouponDefinition,
  AdminCouponRedemptionEvent,
  AdminUserListResponse,
  BillingInterval,
  BillingPlanTier,
  BillingSubscriptionStatus,
  BillingSummaryResponse,
  CheckoutSessionConfirmResponse,
  CheckoutSessionResponse,
  ComicCostReport,
  CouponPreviewResult,
  CouponRedemptionResult,
  CreditPackId,
  PricingCatalogResponse,
  ProjectModerationQueueItem,
  PurchasablePlanTier,
  TokenEstimateRequest,
  TokenEstimateResponse,
  UserRole
} from '../shared/types/billing';
import { get, post } from './apiClient';

export const BILLING_SUMMARY_REFRESH_EVENT = 'dreamstream:billing-summary-refresh';

export const emitBillingSummaryRefresh = () => {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new Event(BILLING_SUMMARY_REFRESH_EVENT));
};

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
  post<Record<string, unknown>, Record<string, unknown>>('/api/billing/settle', payload)
    .then((result) => {
      emitBillingSummaryRefresh();
      return result;
    });

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
  post<{ sessionId: string }, CheckoutSessionConfirmResponse>('/api/billing/checkout/confirm', { sessionId })
    .then((result) => {
      emitBillingSummaryRefresh();
      return result;
    });

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
  post<{ couponCode: string }, CouponRedemptionResult & { summary?: BillingSummaryResponse }>('/api/billing/coupons/redeem', { couponCode })
    .then((result) => {
      emitBillingSummaryRefresh();
      return result;
    });

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

export const getAdminAccess = async (): Promise<AdminAccessResponse> =>
  get<AdminAccessResponse>('/api/admin/me');

export const listAdminUsers = async (input?: { q?: string; limit?: number; cursor?: string }): Promise<AdminUserListResponse> =>
  get<AdminUserListResponse>(
    `/api/admin/users?limit=${Math.max(1, Math.floor(input?.limit || 50))}${input?.cursor ? `&cursor=${encodeURIComponent(input.cursor)}` : ''}${input?.q ? `&q=${encodeURIComponent(input.q)}` : ''}`
  );

export const updateAdminUserPlan = async (input: { userId: string; planTier?: BillingPlanTier; removePlanStatus?: boolean }) =>
  post<{ planTier?: BillingPlanTier; removePlanStatus?: boolean }, { success: boolean }>(
    `/api/admin/users/${encodeURIComponent(input.userId)}/plan`,
    { planTier: input.planTier, removePlanStatus: input.removePlanStatus }
  );

export const updateAdminUserRole = async (input: { userId: string; role: UserRole; action: 'grant' | 'revoke' }) =>
  post<{ role: UserRole; action: 'grant' | 'revoke' }, { success: boolean }>(
    `/api/admin/users/${encodeURIComponent(input.userId)}/role`,
    { role: input.role, action: input.action }
  );

export const forceProjectPrivate = async (input: { projectId: string; reason: string }) =>
  post<{ reason: string }, { success: boolean; projectId: string }>(
    `/api/admin/projects/${encodeURIComponent(input.projectId)}/force-private`,
    { reason: input.reason }
  );

export const listModerationQueue = async (input?: { limit?: number; cursor?: string }) =>
  get<{ items: ProjectModerationQueueItem[]; nextCursor?: string }>(
    `/api/moderation/projects/queue?limit=${Math.max(1, Math.floor(input?.limit || 50))}${input?.cursor ? `&cursor=${encodeURIComponent(input.cursor)}` : ''}`
  );

export const requestProjectRepublish = async (input: { projectId: string; reason?: string }) =>
  post<{ reason?: string }, { success: boolean; republishRequestStatus: string }>(
    `/api/moderation/projects/${encodeURIComponent(input.projectId)}/request-republish`,
    { reason: input.reason }
  );

export const approveProjectRepublish = async (input: { projectId: string; approve?: boolean; reason?: string }) =>
  post<{ approve?: boolean; reason?: string }, { success: boolean; republishRequestStatus: string }>(
    `/api/moderation/projects/${encodeURIComponent(input.projectId)}/approve-republish`,
    { approve: input.approve, reason: input.reason }
  );

export const moderateUser = async (input: {
  userId: string;
  status: 'active' | 'restricted' | 'suspended';
  reason?: string;
}) =>
  post<{ status: 'active' | 'restricted' | 'suspended'; reason?: string }, { success: boolean }>(
    `/api/moderation/users/${encodeURIComponent(input.userId)}/action`,
    { status: input.status, reason: input.reason }
  );

// Backward compatible wrappers
export const createCheckoutSession = async (
  planTier: PurchasablePlanTier = 'creator',
  interval: BillingInterval = 'month'
) =>
  createSubscriptionCheckout(planTier, interval);

export const addCredits = async (packId: CreditPackId) =>
  createCreditPackCheckout(packId);
