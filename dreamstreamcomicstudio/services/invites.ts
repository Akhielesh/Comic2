// Client for the tester-invite endpoints. Admin: generate/list/revoke codes.
// User: redeem a code + check tester status.

import { get, post } from './apiClient';

export interface InviteRecord {
  id: string;
  code: string;
  label?: string | null;
  note?: string | null;
  status: 'active' | 'redeemed' | 'revoked';
  max_uses: number;
  use_count: number;
  redemptions?: number;
  expires_at?: string | null;
  created_at: string;
}

export const generateInvites = (input: {
  count?: number; label?: string; note?: string; maxUses?: number; expiresInDays?: number;
}): Promise<{ items: InviteRecord[] }> =>
  post('/api/admin/invites', input);

export const listInvites = (status?: string): Promise<{ items: InviteRecord[] }> =>
  get(`/api/admin/invites${status ? `?status=${encodeURIComponent(status)}` : ''}`);

export const revokeInvite = (id: string): Promise<{ success: boolean; id: string }> =>
  post(`/api/admin/invites/${encodeURIComponent(id)}/revoke`, {});

export interface RedeemResult {
  ok: boolean;
  alreadyRedeemed?: boolean;
  message: string;
}

export const redeemInvite = async (code: string): Promise<RedeemResult> => {
  try {
    return await post<{ code: string }, RedeemResult>('/api/invites/redeem', { code });
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : 'Could not redeem that code.' };
  }
};

export const getInviteStatus = (): Promise<{ isTester: boolean; redemptions: Array<Record<string, unknown>> }> =>
  get('/api/invites/me');
