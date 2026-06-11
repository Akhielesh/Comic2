import { Router, type Request } from 'express';
import { APP_PUBLIC_URL, EMAIL_PUBLIC_BASE_URL } from '../config.js';
import {
  sendAccessRequested,
  sendNewsletterConfirm,
  sendNewsletterWelcome,
  verifyUnsubscribeToken
} from '../services/mailer.js';
import {
  confirmSubscriber,
  markUnsubscribed,
  newConfirmToken,
  normalizeEmail,
  upsertSubscriber
} from '../services/emailStore.js';
import { getSupabaseAdmin } from '../services/supabase.js';
import { verifyTurnstile } from '../services/turnstile.js';

// Public, logged-out newsletter + waitlist capture with double opt-in. Mounted with
// optionalAuth BEFORE the global requireAuth (like /api/telemetry), so the marketing site
// can call it while signed out. Reads/writes go through the service role under the hood;
// the client never sees tokens or the list.
export const newsletterRouter = Router();

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const reqMeta = (req: Request) => ({ userId: req.user?.id ?? null, requestId: req.requestId ?? null });

// Prefer the configured public origin; fall back to the request's own origin so confirm
// links still work before EMAIL_PUBLIC_BASE_URL is set.
const baseUrl = (req: Request): string =>
  EMAIL_PUBLIC_BASE_URL || `${req.protocol}://${req.get('host')}`;

const redirectToApp = (status: string): string => `${APP_PUBLIC_URL}/?newsletter=${encodeURIComponent(status)}`;

/**
 * Does this email already belong to an account (profiles, service role)? Best-effort:
 * any failure (no service role, transient DB error) returns false so the lookup can
 * never block a waitlist capture.
 */
const accountExistsForEmail = async (email: string): Promise<boolean> => {
  try {
    const admin = getSupabaseAdmin();
    const { data, error } = await admin
      .from('profiles')
      .select('id')
      .ilike('email', email.replace(/[%_]/g, ''))
      .limit(1)
      .maybeSingle();
    return !error && Boolean(data?.id);
  } catch {
    return false;
  }
};

// POST /api/newsletter/subscribe — { email, kind?: 'updates'|'access', source?, firstName? }
newsletterRouter.post('/subscribe', async (req, res, next) => {
  try {
    const email = normalizeEmail(String(req.body?.email ?? ''));
    const kind = req.body?.kind === 'access' ? 'access' : 'updates';
    const firstName = typeof req.body?.firstName === 'string' ? req.body.firstName.slice(0, 80) : undefined;
    const source = typeof req.body?.source === 'string' ? req.body.source.slice(0, 200) : undefined;

    if (!email) return res.status(400).json({ ok: false, message: 'Please enter your email address.' });
    if (!EMAIL_REGEX.test(email) || email.length > 320) {
      return res.status(400).json({ ok: false, message: 'That email doesn’t look right — please check it.' });
    }

    // Bot protection (no-op unless TURNSTILE_SECRET_KEY is configured).
    const captchaToken = typeof req.body?.captchaToken === 'string' ? req.body.captchaToken : undefined;
    if (!(await verifyTurnstile(captchaToken, req.ip))) {
      return res.status(400).json({ ok: false, message: 'Please complete the verification challenge and try again.' });
    }

    if (kind === 'access') {
      // Dedupe 1: an existing ACCOUNT doesn't belong on the waitlist — tell them to
      // sign in instead (200 + ok:false + status, so the client treats it as
      // authoritative and doesn't fall back to a direct insert).
      if (await accountExistsForEmail(email)) {
        return res.json({
          ok: false,
          status: 'account-exists',
          message: 'You already have an account — sign in instead.'
        });
      }

      const token = newConfirmToken();
      const { outcome } = await upsertSubscriber(email, 'access', token, source ? { source } : {});

      // Dedupe 2: already on the waitlist — soft success, no duplicate row, no re-email.
      if (outcome === 'already_registered' || outcome === 'already_confirmed') {
        return res.json({
          ok: true,
          status: 'already-registered',
          alreadyJoined: true,
          message: "You're already on the list."
        });
      }

      // NEW signup: acknowledge with the access-requested template (essential) —
      // best-effort and non-blocking; a mailer failure is logged by the mailer and
      // must never fail the signup itself.
      void sendAccessRequested(email, firstName, reqMeta(req));
      return res.json({
        ok: true,
        status: 'joined',
        alreadyJoined: false,
        message: "Thanks! We'll email you the moment access opens up."
      });
    }

    // Newsletter double opt-in.
    const token = newConfirmToken();
    const { outcome } = await upsertSubscriber(email, 'updates', token, source ? { source } : {});
    if (outcome === 'already_confirmed') {
      return res.json({ ok: true, alreadyJoined: true, message: "You're already subscribed — sit tight!" });
    }
    const confirmUrl = `${baseUrl(req)}/api/newsletter/confirm?e=${encodeURIComponent(email)}&t=${token}`;
    void sendNewsletterConfirm(email, confirmUrl, firstName, reqMeta(req));
    return res.json({ ok: true, message: 'Almost there! Check your inbox to confirm your subscription.' });
  } catch (err) {
    next(err);
  }
});

// GET /api/newsletter/confirm?e=&t= — completes double opt-in, then bounces to the app.
newsletterRouter.get('/confirm', async (req, res, next) => {
  try {
    const email = normalizeEmail(String(req.query.e ?? ''));
    const token = String(req.query.t ?? '');
    if (!email || !token) return res.redirect(302, redirectToApp('invalid'));

    const confirmed = await confirmSubscriber(email, token);
    if (!confirmed) return res.redirect(302, redirectToApp('invalid'));

    // Welcome is marketing → only goes out once they've opted in (here).
    void sendNewsletterWelcome(email, undefined, reqMeta(req));
    return res.redirect(302, redirectToApp('confirmed'));
  } catch (err) {
    next(err);
  }
});

// GET /api/newsletter/unsubscribe?e=&t= — clicked from an email; verify + bounce to the app.
newsletterRouter.get('/unsubscribe', async (req, res, next) => {
  try {
    const email = normalizeEmail(String(req.query.e ?? ''));
    const token = String(req.query.t ?? '');
    if (!email || !verifyUnsubscribeToken(email, token)) return res.redirect(302, redirectToApp('unsub-invalid'));
    await markUnsubscribed(email);
    return res.redirect(302, redirectToApp('unsubscribed'));
  } catch (err) {
    next(err);
  }
});

// POST /api/newsletter/unsubscribe?e=&t= — RFC 8058 One-Click target (List-Unsubscribe-Post).
newsletterRouter.post('/unsubscribe', async (req, res, next) => {
  try {
    const email = normalizeEmail(String(req.query.e ?? ''));
    const token = String(req.query.t ?? '');
    if (!email || !verifyUnsubscribeToken(email, token)) return res.status(400).json({ ok: false });
    await markUnsubscribed(email);
    return res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});
