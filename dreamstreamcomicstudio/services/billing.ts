import type {
  BillingSubscriptionStatus,
  BillingSummaryResponse,
  CheckoutSessionResponse,
  ComicCostReport,
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

export const createSubscriptionCheckout = async (planTier: PurchasablePlanTier): Promise<CheckoutSessionResponse> =>
  post<{ planTier: PurchasablePlanTier }, CheckoutSessionResponse>('/api/billing/checkout/subscription', { planTier });

export const createCreditPackCheckout = async (packId: CreditPackId): Promise<CheckoutSessionResponse> =>
  post<{ packId: CreditPackId }, CheckoutSessionResponse>('/api/billing/checkout/credits', { packId });

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

// Backward compatible wrappers
export const createCheckoutSession = async (planTier: PurchasablePlanTier = 'pro') =>
  createSubscriptionCheckout(planTier);

export const addCredits = async (packId: CreditPackId) =>
  createCreditPackCheckout(packId);
