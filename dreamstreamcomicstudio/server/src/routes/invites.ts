import { Router } from 'express';
import { getInviteStatusForUser, getOrCreateReferral, getReferralStats, recordInviteSend, redeemInvite } from '../services/invites.js';
import { APP_PUBLIC_URL, sendBetaInvite } from '../services/mailer.js';
import { getSupabaseAdmin } from '../services/supabase.js';

// Authenticated invite redemption for testers. Mounted under /api/invites after
// the global requireAuth, so req.user is always present here.
export const invitesRouter = Router();

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_REFERRALS_PER_SEND = 10;
const referralUrl = (code: string) => `${APP_PUBLIC_URL}/?invite=${encodeURIComponent(code)}`;

/**
 * Which of the given emails already belong to an account (profiles, service role).
 * Best-effort: any lookup failure degrades to "not a member" so a backend hiccup can
 * never block invite sending — at worst an existing member gets a harmless invite.
 */
const findExistingMemberEmails = async (emails: string[]): Promise<Set<string>> => {
  const existing = new Set<string>();
  let admin: ReturnType<typeof getSupabaseAdmin>;
  try {
    admin = getSupabaseAdmin();
  } catch {
    return existing;
  }
  await Promise.all(emails.map(async (email) => {
    try {
      // ilike with %/_ stripped = case-insensitive equality (same pattern as the
      // admin product-access lookups).
      const { data, error } = await admin
        .from('profiles')
        .select('id')
        .ilike('email', email.replace(/[%_]/g, ''))
        .limit(1)
        .maybeSingle();
      if (!error && data?.id) existing.add(email);
    } catch {
      // treat as not a member
    }
  }));
  return existing;
};

invitesRouter.post('/redeem', async (req, res, next) => {
  try {
    if (!req.user?.id) {
      return res.status(401).json({ error: { message: 'Sign in to redeem an invite.' } });
    }
    const result = await redeemInvite({ code: req.body?.code, userId: req.user.id, email: req.user.email });
    res.json(result);
  } catch (err) {
    next(err);
  }
});

invitesRouter.get('/me', async (req, res, next) => {
  try {
    if (!req.user?.id) {
      return res.status(401).json({ error: { message: 'User not authenticated' } });
    }
    res.json(await getInviteStatusForUser(req.user.id));
  } catch (err) {
    next(err);
  }
});

// The signed-in user's personal, shareable referral link (get-or-create), plus what
// happened to the invites they sent (per friend: invited/joined — never more).
invitesRouter.get('/referral', async (req, res, next) => {
  try {
    if (!req.user?.id) return res.status(401).json({ error: { message: 'Sign in.' } });
    const ref = await getOrCreateReferral(req.user.id);
    const stats = await getReferralStats(req.user.id);
    res.json({
      code: ref.code,
      url: referralUrl(ref.code),
      used: ref.use_count,
      max: ref.max_uses,
      invited: stats.invited,
      joinedViaLink: stats.joinedViaLink
    });
  } catch (err) {
    next(err);
  }
});

// Email the user's referral link to friends (best-effort, capped). Sends the branded
// beta-invite template via the mailer (cost caps + logging apply).
invitesRouter.post('/referral/send', async (req, res, next) => {
  try {
    if (!req.user?.id) return res.status(401).json({ error: { message: 'Sign in.' } });
    const ref = await getOrCreateReferral(req.user.id);
    const url = referralUrl(ref.code);
    const raw = req.body?.emails;
    const list = (Array.isArray(raw) ? raw : String(raw || '').split(/[\s,;]+/))
      .map((e: unknown) => String(e).trim().toLowerCase())
      .filter((e: string) => EMAIL_REGEX.test(e));
    const recipients = [...new Set(list)].slice(0, MAX_REFERRALS_PER_SEND);
    if (recipients.length === 0) return res.status(400).json({ error: { message: 'Add at least one valid email.' } });

    const inviterName = typeof req.body?.inviterName === 'string' ? req.body.inviterName.slice(0, 80) : undefined;
    const note = typeof req.body?.note === 'string' ? req.body.note.slice(0, 500) : undefined;

    // Dedupe against existing accounts: members don't need a beta invite, so skip the
    // send and report it per-email as 'already-member' instead of "sent".
    const existingMembers = await findExistingMemberEmails(recipients);

    const results: Array<{
      to: string;
      ok: boolean;
      status: 'sent' | 'already-member' | 'skipped' | 'failed';
      skipped?: string;
      error?: string;
    }> = [];
    for (const to of recipients) {
      if (existingMembers.has(to)) {
        results.push({ to, ok: false, status: 'already-member' });
        continue;
      }
      const r = await sendBetaInvite(
        to,
        { inviteUrl: url, code: ref.code, inviterName, personalNote: note },
        { userId: req.user.id, requestId: req.requestId }
      );
      if (r.ok) {
        await recordInviteSend({ inviteId: ref.id, code: ref.code, email: to, sentBy: req.user.id, kind: 'referral' });
      }
      results.push({ to, ok: r.ok, status: r.ok ? 'sent' : r.skipped ? 'skipped' : 'failed', skipped: r.skipped, error: r.error });
    }
    res.json({
      url,
      code: ref.code,
      sent: results.filter((r) => r.ok).length,
      alreadyMembers: results.filter((r) => r.status === 'already-member').length,
      results
    });
  } catch (err) {
    next(err);
  }
});
