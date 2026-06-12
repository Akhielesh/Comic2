// Client for the tester-invite endpoints. Admin: generate/list/revoke codes.
// User: redeem a code + check tester status.

import { get, post } from './apiClient';

export interface InviteRecipient {
  email: string;
  send_count: number;
  last_sent_at: string;
  kind: 'admin' | 'referral' | 'resend';
}

export interface InviteRedemption {
  email: string | null;
  user_id: string | null;
  redeemed_at: string;
}

export interface InviteRecord {
  id: string;
  code: string;
  label?: string | null;
  note?: string | null;
  status: 'active' | 'redeemed' | 'revoked';
  max_uses: number;
  use_count: number;
  redemptions?: number;
  /** Who the invite was emailed to (and when) — the sent half of the timeline. */
  recipients?: InviteRecipient[];
  /** Who redeemed it (and when) — the joined half of the timeline. */
  redeemedBy?: InviteRedemption[];
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

// ── Referrals (any signed-in user) ───────────────────────────────────────────
export interface ReferralInviteStat {
  email: string;
  lastSentAt: string;
  sendCount: number;
  joined: boolean;
  joinedAt: string | null;
}

export interface ReferralInfo {
  code: string;
  url: string;
  used: number;
  max: number;
  /** Per emailed friend: invited or joined (accepted-or-not only — no usage analytics). */
  invited?: ReferralInviteStat[];
  /** Joins that came through the bare link rather than an emailed invite. */
  joinedViaLink?: number;
}

/** The user's personal, shareable referral link (get-or-create). */
export const getReferral = (): Promise<ReferralInfo> => get('/api/invites/referral');

export interface ReferralSendResult {
  to: string;
  ok: boolean;
  /** 'already-member' = the email already has an account, so no invite was sent. */
  status: 'sent' | 'already-member' | 'skipped' | 'failed';
  skipped?: string;
  error?: string;
}

export interface ReferralSendResponse {
  url: string;
  code: string;
  sent: number;
  alreadyMembers: number;
  results: ReferralSendResult[];
}

/** Email the user's referral link to friends (≤10). Existing members are skipped server-side. */
export const sendReferral = (
  emails: string,
  note?: string,
  inviterName?: string
): Promise<ReferralSendResponse> =>
  post('/api/invites/referral/send', { emails, note, inviterName });

// ── Pending invite capture (email-link deep link) ─────────────────────────────
//
// Invite emails link to `/?invite=DS-XXXX-XXXX`. The code is stashed here when the
// app loads, survives the auth round-trip (sign-up → email verify → sign-in), and is
// auto-redeemed on the first signed-in load — no manual code entry needed.

const PENDING_INVITE_KEY = 'ds_pending_invite_code';
const INVITE_CODE_REGEX = /^[A-Z0-9][A-Z0-9-]{3,39}$/i;

/** Pull `?invite=` off the current URL into storage (and strip it). Returns the code if one was captured. */
export const captureInviteCodeFromUrl = (): string | null => {
  if (typeof window === 'undefined') return null;
  try {
    const url = new URL(window.location.href);
    const raw = (url.searchParams.get('invite') || '').trim();
    if (!raw || !INVITE_CODE_REGEX.test(raw)) return null;
    const code = raw.toUpperCase();
    window.localStorage.setItem(PENDING_INVITE_KEY, code);
    url.searchParams.delete('invite');
    window.history.replaceState({}, '', url);
    return code;
  } catch {
    return null;
  }
};

export const getPendingInviteCode = (): string | null => {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage.getItem(PENDING_INVITE_KEY);
  } catch {
    return null;
  }
};

export const clearPendingInviteCode = (): void => {
  try {
    window.localStorage.removeItem(PENDING_INVITE_KEY);
  } catch {
    /* noop */
  }
};
