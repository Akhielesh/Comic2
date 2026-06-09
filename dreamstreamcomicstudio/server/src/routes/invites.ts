import { Router } from 'express';
import { getInviteStatusForUser, getOrCreateReferral, redeemInvite } from '../services/invites.js';
import { APP_PUBLIC_URL, sendBetaInvite } from '../services/mailer.js';

// Authenticated invite redemption for testers. Mounted under /api/invites after
// the global requireAuth, so req.user is always present here.
export const invitesRouter = Router();

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_REFERRALS_PER_SEND = 10;
const referralUrl = (code: string) => `${APP_PUBLIC_URL}/?invite=${encodeURIComponent(code)}`;

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

// The signed-in user's personal, shareable referral link (get-or-create).
invitesRouter.get('/referral', async (req, res, next) => {
  try {
    if (!req.user?.id) return res.status(401).json({ error: { message: 'Sign in.' } });
    const ref = await getOrCreateReferral(req.user.id);
    res.json({ code: ref.code, url: referralUrl(ref.code), used: ref.use_count, max: ref.max_uses });
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
    const results = [];
    for (const to of recipients) {
      const r = await sendBetaInvite(
        to,
        { inviteUrl: url, code: ref.code, inviterName, personalNote: note },
        { userId: req.user.id, requestId: req.requestId }
      );
      results.push({ to, ok: r.ok, skipped: r.skipped, error: r.error });
    }
    res.json({ url, code: ref.code, sent: results.filter((r) => r.ok).length, results });
  } catch (err) {
    next(err);
  }
});
