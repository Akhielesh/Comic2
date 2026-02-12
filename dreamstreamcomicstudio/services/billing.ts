import type {
  BillingSummaryResponse,
  ComicCostReport,
  PricingCatalogResponse,
  TokenEstimateRequest,
  TokenEstimateResponse
} from '../shared/types/billing';
import { get, post } from './apiClient';

export interface CheckoutSessionResponse {
  url: string;
  id?: string;
}

export const getPricingCatalog = async (): Promise<PricingCatalogResponse> =>
  get<PricingCatalogResponse>('/api/billing/pricing-catalog');

export const getBillingSummary = async (): Promise<BillingSummaryResponse> =>
  get<BillingSummaryResponse>('/api/billing/summary');

export const estimateTokenCharge = async (payload: TokenEstimateRequest): Promise<TokenEstimateResponse> =>
  post<TokenEstimateRequest, TokenEstimateResponse>('/api/billing/estimate', payload);

export const reserveTokenCharge = async (payload: TokenEstimateRequest) =>
  post<TokenEstimateRequest, { allowed: boolean; reservation?: unknown }>('/api/billing/reserve', payload);

export const settleTokenCharge = async (payload: Record<string, unknown>) =>
  post<Record<string, unknown>, Record<string, unknown>>('/api/billing/settle', payload);

export const setupPaymentMethod = async () =>
  post<Record<string, never>, { customerId: string; setupIntentClientSecret: string }>('/api/billing/setup-payment-method', {});

export const addCredits = async (packUsd: number, options?: { simulate?: boolean }) =>
  post<{ packUsd: number; simulate?: boolean }, Record<string, unknown>>('/api/billing/add-credits', {
    packUsd,
    simulate: options?.simulate
  });

export const updateAutoReload = async (payload: { enabled: boolean; thresholdCt?: number; packUsd?: number }) =>
  post<typeof payload, { enabled: boolean; thresholdCt: number; packUsd: number }>('/api/billing/auto-reload', payload);

export const getUsageHistory = async (limit = 100) =>
  get<{ items: Array<Record<string, unknown>> }>(`/api/billing/usage-history?limit=${Math.max(1, Math.floor(limit))}`);

export const getComicCost = async (comicId: string): Promise<ComicCostReport> =>
  get<ComicCostReport>(`/api/billing/comic-cost/${encodeURIComponent(comicId)}`);

export const createCheckoutSession = async (planTier: 'creator' | 'pro' | 'studio' = 'pro'): Promise<CheckoutSessionResponse> =>
  post<{ planTier: string }, CheckoutSessionResponse>('/api/billing/checkout-plan', { planTier });
