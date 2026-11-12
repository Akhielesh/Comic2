import { Router, type Request, type Response } from 'express';
import { APP_PUBLIC_URL, EMAIL_PUBLIC_BASE_URL } from '../config.js';
import { mailerConfigured, sendNewsletterConfirm } from '../services/mailer.js';
import { normalizeEmail } from '../services/emailStore.js';
import {
  InterestRetryError,
  InterestUnavailableError,
  getInterestSummary,
  holdAnswer,
  noteSentDuration,
  registerInterest
} from '../services/interestStore.js';
import { turnstileConfigured, verifyTurnstile } from '../services/turnstile.js';
import { formatStudioInterestList, sanitizeStudioInterests, type StudioInterestId } from '../../../services/studioInterests.js';

// Register interest in DreamStream studios (public, logged-out) + the admin summary.
//
// POST /api/interest {email, studios[], source?, captchaToken?}
//   Mounted in index.ts BEFORE the global requireAuth, behind its own per-IP limiter and
//   optionalAuth. Pipeline: validate → Turnstile (a sent token must verify; none is accepted only
//   while Turnstile isn't configured) → mailer configured? → registerInterest (one row per
//   address, studios merged, per-recipient throttle, atomic send claim) → send the double opt-in
//   link (the existing newsletter-confirm email and /api/newsletter/confirm) → answer.
//
//   Anyone can type anyone's address, so a valid request ALWAYS gets the same answer:
//   200 {ok, status:'pending', studios, message} with `studios` echoing only what this request
//   picked. Whether the address was new, pending, already subscribed, unsubscribed or throttled
//   is never told, nothing stored is ever echoed, and a request that sent nothing takes as long
//   as one that sent the email (holdAnswer holds both). Other answers are about the request or the
//   service, never the address: 400 invalid_email | invalid_studios | captcha_required |
//   captcha_failed; 503 email_unavailable (public-form mail has used its share of the email budget,
//   or the mailer is at its hard cap: both checked before anything about the address, so every
//   address gets it; or this send failed) | try_again | interest_unavailable (this deployment
//   can't take registrations at all: database without the columns, no service role, no mailer;
//   the form then hides itself).
//
// GET /api/admin/interest/summary — admin only (index.ts mounts requireAdmin): counts per studio,
//   confirmed vs pending. No address ever leaves the server here.

export const interestRouter = Router();
export const adminInterestRouter = Router();

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_STUDIOS_IN_REQUEST = 20;

type Body = Record<string, unknown>;
const bodyOf = (req: Request): Body => (req.body && typeof req.body === 'object' ? (req.body as Body) : {});

const fail = (res: Response, status: number, code: string, message: string, extra: Record<string, unknown> = {}) =>
  res.status(status).json({ ok: false, code, message, ...extra });

/**
 * The routed support mailbox. Mirrors SUPPORT_EMAIL in components/legal/legalFacts.ts (kept as its
 * own constant so the backend bundle doesn't reach into components/); legalFacts.test.ts keeps the
 * two equal.
 */
export const INTEREST_SUPPORT_EMAIL = 'support@dreamstreamstudio.ai';

const unavailable = (res: Response) =>
  fail(
    res,
    503,
    'interest_unavailable',
    `Registering interest isn’t available right now. Email ${INTEREST_SUPPORT_EMAIL} and we’ll add you by hand.`
  );

/** A surface tag like "home-stay-updated" or "/pricing": short, printable, nothing else. */
const readSource = (raw: unknown): string | null => {
  if (typeof raw !== 'string') return null;
  const clean = raw.replace(/[^\w\-/.:#]/g, '').slice(0, 100);
  return clean || null;
};

// Never the Host header: a forged Host would put an attacker's domain in an email we send.
const confirmBase = (): string => EMAIL_PUBLIC_BASE_URL || APP_PUBLIC_URL;

const emailUnavailable = (res: Response) =>
  fail(res, 503, 'email_unavailable', 'We couldn’t send the confirmation email right now. Please try again in a few minutes.');

/**
 * The one answer every valid request gets, whatever the address's state: a link went out now, or
 * one did within the throttle window (at most one every 10 minutes and three a day), or the address
 * is already subscribed and the link confirms these picks. One case sends nothing and gets this
 * answer too: while email_log can't be read the throttle fails closed (checkConfirmThrottle), and
 * the address's next request once it can be read sends the link. The Privacy Policy says so.
 */
const pendingAnswer = (studios: StudioInterestId[]) => ({
  ok: true,
  status: 'pending' as const,
  studios,
  message: `Almost there. Check your inbox and click the link in our email to confirm updates about ${formatStudioInterestList(studios)}. Nothing yet? Check your spam folder. To protect your inbox, we send at most one link every 10 minutes and three a day.`
});

interestRouter.post('/', async (req, res, next) => {
  try {
    const body = bodyOf(req);

    // 1) Validate.
    const email = normalizeEmail(typeof body.email === 'string' ? body.email : '');
    if (!email) return fail(res, 400, 'invalid_email', 'Please enter your email address.');
    if (email.length > 320 || !EMAIL_REGEX.test(email)) {
      return fail(res, 400, 'invalid_email', 'That email doesn’t look right. Please check it.');
    }
    const rawStudios = body.studios;
    if (!Array.isArray(rawStudios) || rawStudios.length > MAX_STUDIOS_IN_REQUEST) {
      return fail(res, 400, 'invalid_studios', 'Pick at least one studio.');
    }
    // Unknown ids (a tab open since a studio was retired) are dropped; at least one must remain.
    const studios = sanitizeStudioInterests(rawStudios);
    if (studios.length === 0) return fail(res, 400, 'invalid_studios', 'Pick at least one studio.');
    const source = readSource(body.source);

    // 2) Bot check (Cloudflare Turnstile), the captchaGate pattern from routes/authEmail.ts.
    const token = typeof body.captchaToken === 'string' ? body.captchaToken.trim() : '';
    if (token) {
      if (!(await verifyTurnstile(token, req.ip))) {
        return fail(res, 400, 'captcha_failed', 'The verification challenge expired or failed. Please try again.');
      }
    } else if (turnstileConfigured()) {
      return fail(res, 400, 'captcha_required', 'Please complete the verification challenge.');
    }

    // 3) Without a mailer nobody could ever confirm: don't store a registration that can't complete.
    if (!mailerConfigured()) return unavailable(res);

    // 4) Record (idempotent, merged, throttled, send slot claimed atomically).
    const startedAt = Date.now();
    const result = await registerInterest({ email, studios, source });
    if (result.outcome === 'budget_exhausted') {
      console.warn('[interest] confirmation budget used up for now', { requestId: req.requestId });
      return emailUnavailable(res);
    }

    // 5) Send the double opt-in link (same email + confirm route as the newsletter).
    if (result.outcome === 'send_confirmation') {
      const confirmUrl = `${confirmBase()}/api/newsletter/confirm?e=${encodeURIComponent(email)}&t=${result.token}`;
      const sent = await sendNewsletterConfirm(email, confirmUrl, undefined, {
        userId: req.user?.id ?? null,
        requestId: req.requestId ?? null
      });
      if (!sent.ok) {
        // Give the slot back so a retry isn't throttled (failed and capped sends don't count).
        await result.release();
        if (sent.skipped === 'not_configured') return unavailable(res);
        console.warn('[interest] confirmation email not sent', { reason: sent.skipped || sent.error || 'send_failed', requestId: req.requestId });
        return emailUnavailable(res);
      }
      result.sent();
      noteSentDuration(startedAt);
    }
    // Sent or throttled, the answer takes the same time (holdAnswer), so it doesn't say which.
    await holdAnswer(startedAt);

    // 6) Sent now, or throttled: the same answer (see the header).
    return res.json(pendingAnswer(studios));
  } catch (err) {
    if (err instanceof InterestUnavailableError) {
      console.warn('[interest] unavailable:', err.message);
      return unavailable(res);
    }
    if (err instanceof InterestRetryError) {
      console.warn('[interest] retry:', err.message);
      return fail(res, 503, 'try_again', 'We couldn’t save that just now. Please try again in a minute.');
    }
    next(err);
  }
});

// GET /api/admin/interest/summary — counts only (no addresses, no tokens, no free text).
adminInterestRouter.get('/summary', async (_req, res, next) => {
  try {
    res.setHeader('Cache-Control', 'no-store');
    res.json(await getInterestSummary());
  } catch (err) {
    if (err instanceof InterestUnavailableError) {
      return fail(res, 503, 'interest_unavailable', 'Interest registrations aren’t set up on this database.');
    }
    next(err);
  }
});
