// Early-access / BYOK-tester invite codes. Admins generate codes; signed-in users
// redeem them; redemptions are recorded (an "active tester" = has a redemption).
// All access goes through the service role (tables are write-only-by-service-role).

import { getSupabaseAdmin } from './supabase.js';
import { logger } from '../lib/logger.js';
import { APP_PUBLIC_URL, sendBetaInvite } from './mailer.js';
import { isStudioInviteId, type StudioInviteId } from '../../../shared/email/index.js';

// Human-friendly, unambiguous alphabet (no 0/O/1/I) for codes like DS-7K9F-Q3MX.
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const randomBlock = (n: number) => {
  let out = '';
  for (let i = 0; i < n; i++) out += ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
  return out;
};
const generateCode = () => `DS-${randomBlock(4)}-${randomBlock(4)}`;

const normalizeCode = (raw: unknown) => String(raw || '').trim().toUpperCase();

export interface GenerateInput {
  count?: number;
  label?: string;
  note?: string;
  maxUses?: number;
  expiresInDays?: number;
  createdBy: string;
  /**
   * Studio confinement carried by the invite (stored in metadata.products): on redemption
   * the account is granted exactly these studios. Empty/omitted ⇒ default full access.
   */
  products?: StudioInviteId[];
}

export const generateInvites = async (input: GenerateInput) => {
  const count = Math.max(1, Math.min(100, Math.floor(Number(input.count) || 1)));
  const maxUses = Math.max(1, Math.min(1000, Math.floor(Number(input.maxUses) || 1)));
  const expiresAt = input.expiresInDays && Number(input.expiresInDays) > 0
    ? new Date(Date.now() + Number(input.expiresInDays) * 86_400_000).toISOString()
    : null;
  const label = input.label ? String(input.label).slice(0, 120) : null;
  const note = input.note ? String(input.note).slice(0, 500) : null;
  const products = (input.products ?? []).filter(isStudioInviteId);

  const rows = Array.from({ length: count }, () => ({
    code: generateCode(),
    label,
    note,
    status: 'active',
    max_uses: maxUses,
    use_count: 0,
    created_by: input.createdBy,
    expires_at: expiresAt,
    metadata: products.length ? { products } : {}
  }));

  const { data, error } = await getSupabaseAdmin().from('access_invites').insert(rows).select('*');
  if (error) throw error;
  return data || [];
};

/**
 * One persistent personal referral code per user (get-or-create). Reuses access_invites with
 * label 'referral' and a generous max_uses so a user can invite multiple friends from one link.
 */
export const getOrCreateReferral = async (userId: string): Promise<{ id: string; code: string; use_count: number; max_uses: number }> => {
  const admin = getSupabaseAdmin();
  const { data: existing } = await admin
    .from('access_invites')
    .select('id, code, use_count, max_uses')
    .eq('created_by', userId)
    .eq('label', 'referral')
    .eq('status', 'active')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (existing) {
    return {
      id: String(existing.id),
      code: String(existing.code),
      use_count: Number(existing.use_count) || 0,
      max_uses: Number(existing.max_uses) || 0
    };
  }
  const [created] = await generateInvites({ createdBy: userId, label: 'referral', maxUses: 25, count: 1 });
  return { id: String(created.id), code: String(created.code), use_count: 0, max_uses: 25 };
};

// ── Invite delivery tracking (access_invite_sends) ─────────────────────────────
//
// Every emailed invite is recorded per (invite, recipient): first/last sent, send
// count, sender and path. This is what lets the platform answer "was this email
// already invited?" at register time, show admins the sent → joined timeline, and
// show users which of their referral invites were accepted.

export type InviteSendKind = 'admin' | 'referral' | 'resend';

/** Record (or bump) an invite email delivery. Best-effort: a log failure never blocks the send. */
export const recordInviteSend = async (input: {
  inviteId: string;
  code: string;
  email: string;
  sentBy?: string | null;
  kind: InviteSendKind;
}): Promise<void> => {
  const email = String(input.email || '').trim().toLowerCase();
  if (!email) return;
  try {
    const admin = getSupabaseAdmin();
    const { data: existing } = await admin
      .from('access_invite_sends')
      .select('id, send_count')
      .eq('invite_id', input.inviteId)
      .eq('to_email', email)
      .maybeSingle();
    if (existing?.id) {
      await admin
        .from('access_invite_sends')
        .update({ send_count: (Number(existing.send_count) || 1) + 1, last_sent_at: new Date().toISOString() })
        .eq('id', existing.id);
      return;
    }
    await admin.from('access_invite_sends').insert({
      invite_id: input.inviteId,
      code: input.code,
      to_email: email,
      sent_by: input.sentBy ?? null,
      kind: input.kind
    });
  } catch (err) {
    logger.warn('invite_send_record_failed', { message: (err as Error)?.message || String(err) });
  }
};

export interface PendingInvite {
  inviteId: string;
  code: string;
  sentBy: string | null;
  kind: InviteSendKind;
  lastSentAt: string;
}

/**
 * Does this email hold a still-usable invite that was emailed to them? Returns the most
 * recently sent one whose code is active, unexpired and has uses left. Best-effort: any
 * failure returns null so callers degrade to the normal (no-invite) path.
 */
export const findPendingInviteForEmail = async (rawEmail: string): Promise<PendingInvite | null> => {
  const email = String(rawEmail || '').trim().toLowerCase();
  if (!email) return null;
  try {
    const admin = getSupabaseAdmin();
    const { data: sends } = await admin
      .from('access_invite_sends')
      .select('invite_id, code, sent_by, kind, last_sent_at')
      .eq('to_email', email)
      .order('last_sent_at', { ascending: false })
      .limit(5);
    for (const send of (sends || []) as Array<Record<string, unknown>>) {
      const { data: invite } = await admin
        .from('access_invites')
        .select('id, status, max_uses, use_count, expires_at')
        .eq('id', String(send.invite_id))
        .maybeSingle();
      if (!invite) continue;
      if (invite.status === 'revoked') continue;
      if (invite.expires_at && Date.parse(String(invite.expires_at)) < Date.now()) continue;
      if (Number(invite.use_count) >= Number(invite.max_uses)) continue;
      return {
        inviteId: String(send.invite_id),
        code: String(send.code),
        sentBy: send.sent_by ? String(send.sent_by) : null,
        kind: (send.kind as InviteSendKind) || 'admin',
        lastSentAt: String(send.last_sent_at)
      };
    }
    return null;
  } catch (err) {
    logger.warn('invite_pending_lookup_failed', { message: (err as Error)?.message || String(err) });
    return null;
  }
};

// Don't re-email more often than this when someone repeatedly retries registering —
// the status message still tells them to check their inbox either way.
const RESEND_COOLDOWN_MS = 10 * 60_000;

export interface ResendOutcome {
  status: 'invited' | 'none';
  /** True when a fresh email actually went out (false inside the cooldown window). */
  resent: boolean;
}

/**
 * Register-intent path: when an already-invited email tries to sign up again, re-send
 * their original invite email (cooldown-guarded) so "follow the instructions in your
 * email" is always actionable.
 */
export const resendPendingInvite = async (
  rawEmail: string,
  meta?: { requestId?: string | null }
): Promise<ResendOutcome> => {
  const email = String(rawEmail || '').trim().toLowerCase();
  const pending = await findPendingInviteForEmail(email);
  if (!pending) return { status: 'none', resent: false };

  const lastSent = Date.parse(pending.lastSentAt);
  if (Number.isFinite(lastSent) && Date.now() - lastSent < RESEND_COOLDOWN_MS) {
    return { status: 'invited', resent: false };
  }

  const inviteUrl = `${APP_PUBLIC_URL}/?invite=${encodeURIComponent(pending.code)}`;
  const result = await sendBetaInvite(
    email,
    { inviteUrl, code: pending.code },
    { userId: pending.sentBy, requestId: meta?.requestId ?? null }
  );
  if (result.ok) {
    await recordInviteSend({ inviteId: pending.inviteId, code: pending.code, email, sentBy: null, kind: 'resend' });
    logger.info('invite_resent', { inviteId: pending.inviteId });
  }
  return { status: 'invited', resent: result.ok };
};

export interface ReferralInviteStat {
  email: string;
  lastSentAt: string;
  sendCount: number;
  joined: boolean;
  joinedAt: string | null;
}

/**
 * What happened to the invites a user sent: per emailed friend, whether they joined
 * (redeemed) and when — plus joins that came through the bare link (no email send).
 * Deliberately NOT usage analytics: an inviter sees accepted-or-not, nothing more.
 */
export const getReferralStats = async (
  userId: string
): Promise<{ invited: ReferralInviteStat[]; joinedViaLink: number }> => {
  try {
    const admin = getSupabaseAdmin();
    const ref = await getOrCreateReferral(userId);
    const [{ data: sends }, { data: reds }] = await Promise.all([
      admin
        .from('access_invite_sends')
        .select('to_email, send_count, last_sent_at')
        .eq('invite_id', ref.id)
        .order('last_sent_at', { ascending: false }),
      admin
        .from('access_invite_redemptions')
        .select('email, redeemed_at')
        .eq('invite_id', ref.id)
    ]);
    const joinedByEmail = new Map<string, string>();
    for (const r of (reds || []) as Array<Record<string, unknown>>) {
      if (r.email) joinedByEmail.set(String(r.email).toLowerCase(), String(r.redeemed_at));
    }
    const invited: ReferralInviteStat[] = ((sends || []) as Array<Record<string, unknown>>).map((s) => {
      const email = String(s.to_email);
      const joinedAt = joinedByEmail.get(email) ?? null;
      return {
        email,
        lastSentAt: String(s.last_sent_at),
        sendCount: Number(s.send_count) || 1,
        joined: joinedAt !== null,
        joinedAt
      };
    });
    const sentEmails = new Set(invited.map((i) => i.email));
    const joinedViaLink = ((reds || []) as Array<Record<string, unknown>>).filter(
      (r) => !r.email || !sentEmails.has(String(r.email).toLowerCase())
    ).length;
    return { invited, joinedViaLink };
  } catch (err) {
    logger.warn('referral_stats_failed', { message: (err as Error)?.message || String(err) });
    return { invited: [], joinedViaLink: 0 };
  }
};

export const listInvites = async (opts: { limit?: number; offset?: number; status?: string } = {}) => {
  const limit = Math.max(1, Math.min(200, Math.floor(Number(opts.limit) || 100)));
  const offset = Math.max(0, Math.floor(Number(opts.offset) || 0));
  const admin = getSupabaseAdmin();
  let query = admin
    .from('access_invites')
    .select('id, code, label, note, status, max_uses, use_count, expires_at, created_at')
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1);
  if (opts.status) query = query.eq('status', opts.status);
  const { data, error } = await query;
  if (error) throw error;
  const invites = (data || []) as Array<Record<string, unknown>>;

  // Attach the full delivery + redemption timeline for the listed invites, so the
  // admin view can answer "sent to whom, when — and did they join?" per code.
  const ids = invites.map((i) => i.id as string).filter(Boolean);
  const redemptionsByInvite = new Map<string, number>();
  const redeemedByInvite = new Map<string, Array<{ email: string | null; user_id: string | null; redeemed_at: string }>>();
  const sendsByInvite = new Map<string, Array<{ email: string; send_count: number; last_sent_at: string; kind: string }>>();
  if (ids.length) {
    const [{ data: reds }, { data: sends }] = await Promise.all([
      admin
        .from('access_invite_redemptions')
        .select('invite_id, email, user_id, redeemed_at')
        .in('invite_id', ids),
      admin
        .from('access_invite_sends')
        .select('invite_id, to_email, send_count, last_sent_at, kind')
        .in('invite_id', ids)
    ]);
    for (const r of (reds || []) as Array<Record<string, unknown>>) {
      const id = String(r.invite_id);
      redemptionsByInvite.set(id, (redemptionsByInvite.get(id) || 0) + 1);
      const list = redeemedByInvite.get(id) || [];
      list.push({
        email: r.email ? String(r.email) : null,
        user_id: r.user_id ? String(r.user_id) : null,
        redeemed_at: String(r.redeemed_at)
      });
      redeemedByInvite.set(id, list);
    }
    for (const s of (sends || []) as Array<Record<string, unknown>>) {
      const id = String(s.invite_id);
      const list = sendsByInvite.get(id) || [];
      list.push({
        email: String(s.to_email),
        send_count: Number(s.send_count) || 1,
        last_sent_at: String(s.last_sent_at),
        kind: String(s.kind || 'admin')
      });
      sendsByInvite.set(id, list);
    }
  }
  return invites.map((i) => ({
    ...i,
    redemptions: redemptionsByInvite.get(String(i.id)) || 0,
    recipients: sendsByInvite.get(String(i.id)) || [],
    redeemedBy: redeemedByInvite.get(String(i.id)) || []
  }));
};

export const revokeInvite = async (id: string) => {
  const { error } = await getSupabaseAdmin()
    .from('access_invites')
    .update({ status: 'revoked' })
    .eq('id', id);
  if (error) throw error;
  return { ok: true };
};

export interface RedeemResult {
  ok: boolean;
  alreadyRedeemed?: boolean;
  message: string;
}

export const redeemInvite = async (input: { code: unknown; userId: string; email?: string | null }): Promise<RedeemResult> => {
  const code = normalizeCode(input.code);
  if (!code) return { ok: false, message: 'Enter an invite code.' };

  try {
    const admin = getSupabaseAdmin();
    // Codes are generated uppercase; match case-insensitively to be forgiving.
    const { data: invite, error } = await admin
      .from('access_invites')
      .select('id, code, status, max_uses, use_count, expires_at, metadata, created_by')
      .ilike('code', code)
      .maybeSingle();
    if (error) throw error;
    if (!invite) return { ok: false, message: 'That invite code is not valid.' };
    if (invite.status === 'revoked') return { ok: false, message: 'That invite code has been revoked.' };
    if (invite.expires_at && Date.parse(String(invite.expires_at)) < Date.now()) {
      return { ok: false, message: 'That invite code has expired.' };
    }

    // Already redeemed by this user → idempotent success.
    const { data: existing } = await admin
      .from('access_invite_redemptions')
      .select('id')
      .eq('invite_id', invite.id)
      .eq('user_id', input.userId)
      .maybeSingle();
    if (existing) return { ok: true, alreadyRedeemed: true, message: "You're already in — invite already redeemed." };

    if (Number(invite.use_count) >= Number(invite.max_uses)) {
      return { ok: false, message: 'That invite code has already been fully used.' };
    }

    const { error: redeemError } = await admin.from('access_invite_redemptions').insert({
      invite_id: invite.id,
      code: invite.code,
      user_id: input.userId,
      email: input.email || null
    });
    if (redeemError) {
      // Unique-violation race: someone (this user) redeemed concurrently → treat as success.
      const codeStr = String((redeemError as { code?: string }).code || '');
      if (codeStr === '23505') return { ok: true, alreadyRedeemed: true, message: "You're already in — invite already redeemed." };
      throw redeemError;
    }

    const nextCount = Number(invite.use_count) + 1;
    await admin
      .from('access_invites')
      .update({
        use_count: nextCount,
        status: nextCount >= Number(invite.max_uses) ? 'redeemed' : 'active'
      })
      .eq('id', invite.id);

    // Studio confinement carried by the invite: grant exactly the chosen studios.
    // Best-effort — a grant failure must not undo a successful redemption.
    const rawProducts = (invite as { metadata?: { products?: unknown } }).metadata?.products;
    const products = (Array.isArray(rawProducts) ? rawProducts : []).filter(isStudioInviteId);
    if (products.length > 0) {
      try {
        const { error: grantError } = await admin.from('product_access').upsert(
          products.map((product) => ({
            user_id: input.userId,
            product,
            active: true,
            note: `invite ${invite.code}`,
            granted_by: (invite as { created_by?: string | null }).created_by ?? null,
            updated_at: new Date().toISOString()
          })),
          { onConflict: 'user_id,product' }
        );
        if (grantError) throw grantError;
        logger.info('invite_products_granted', { inviteId: invite.id, userId: input.userId, products });
      } catch (grantErr) {
        logger.warn('invite_product_grant_failed', {
          inviteId: invite.id,
          userId: input.userId,
          message: (grantErr as Error)?.message || String(grantErr)
        });
      }
    }

    logger.info('invite_redeemed', { inviteId: invite.id, userId: input.userId });
    return { ok: true, message: "Access granted — you're set up as a tester. Add your API keys in Settings." };
  } catch (err) {
    logger.warn('invite_redeem_failed', { message: (err as Error)?.message || String(err) });
    return { ok: false, message: 'Could not redeem that code right now. Please try again.' };
  }
};

export const getInviteStatusForUser = async (userId: string): Promise<{ isTester: boolean; redemptions: Array<Record<string, unknown>> }> => {
  try {
    const { data } = await getSupabaseAdmin()
      .from('access_invite_redemptions')
      .select('code, redeemed_at')
      .eq('user_id', userId)
      .order('redeemed_at', { ascending: false });
    const redemptions = (data || []) as Array<Record<string, unknown>>;
    return { isTester: redemptions.length > 0, redemptions };
  } catch {
    return { isTester: false, redemptions: [] };
  }
};
