import type {
  AdminAccessResponse,
  AdminUserListResponse,
  BillingSummaryResponse,
  ComicCostReport,
  ProjectModerationQueueItem,
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

export const getBillingSummary = async (): Promise<BillingSummaryResponse> =>
  get<BillingSummaryResponse>('/api/billing/summary');

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

export const getUsageHistory = async (limit = 100) =>
  get<{ items: Array<Record<string, unknown>> }>(`/api/billing/usage-history?limit=${Math.max(1, Math.floor(limit))}`);

export const getComicCost = async (comicId: string): Promise<ComicCostReport> =>
  get<ComicCostReport>(`/api/billing/comic-cost/${encodeURIComponent(comicId)}`);

// ── Admin governance (roles model: admin / moderator / studio-level access) ──────

export const getAdminAccess = async (): Promise<AdminAccessResponse> =>
  get<AdminAccessResponse>('/api/admin/me');

export const listAdminUsers = async (input?: { q?: string; limit?: number; cursor?: string }): Promise<AdminUserListResponse> =>
  get<AdminUserListResponse>(
    `/api/admin/users?limit=${Math.max(1, Math.floor(input?.limit || 50))}${input?.cursor ? `&cursor=${encodeURIComponent(input.cursor)}` : ''}${input?.q ? `&q=${encodeURIComponent(input.q)}` : ''}`
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
