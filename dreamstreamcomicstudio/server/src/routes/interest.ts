import { Router, type Request, type Response } from 'express';
import { APP_PUBLIC_URL, EMAIL_PUBLIC_BASE_URL } from '../config.js';
import { mailerConfigured, sendNewsletterConfirm } from '../services/mailer.js';
import { normalizeEmail } from '../services/emailStore.js';
import { InterestUnavailableError, getInterestSummary, registerInterest } from '../services/interestStore.js';
import { turnstileConfigured, verifyTurnstile } from '../services/turnstile.js';
import { formatStudioInterestList, sanitizeStudioInterests } from '../../../services/studioInterests.js';

// Register interest in DreamStream studios (public, logged-out) + the admin summary.
//
// POST /api/interest {email, studios[], source?, captchaToken?}
//   Mounted in index.ts BEFORE the global requireAuth, behind its own per-IP limiter and
//   optionalAuth. Pipeline: validate → Turnstile (a sent token must verify; none is accepted only
//   while Turnstile isn't configured) → mailer configured? → registerInterest (one row per
//   address, studios merged, per-recipient throttle) → send the double opt-in link (the existing
//   newsletter-confirm email and /api/newsletter/confirm) → answer.
//   Answers carry `status` (pending | confirmed) or `code` (invalid_email, invalid_studios,
//   captcha_required, captcha_failed, too_many, email_unavailable, interest_unavailable).
//   interest_unavailable (503) means this deployment can't take registrations at all (database
//   without the columns, no service role, no mailer): the form hides itself.
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

const unavailable = (res: Response) =>
  fail(
    res,
    503,
    'interest_unavailable',
    'Registering interest isn’t available right now. Email contact@dreamstreamstudio.ai and we’ll add you by hand.'
  );

/** A surface tag like "home-stay-updated" or "/pricing": short, printable, nothing else. */
const readSource = (raw: unknown): string | null => {
  if (typeof raw !== 'string') return null;
  const clean = raw.replace(/[^\w\-/.:#]/g, '').slice(0, 100);
  return clean || null;
};

// Never the Host header: a forged Host would put an attacker's domain in an email we send.
const confirmBase = (): string => EMAIL_PUBLIC_BASE_URL || APP_PUBLIC_URL;

const minutes = (seconds: number) => Math.max(1, Math.ceil(seconds / 60));

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

    // 4) Record (idempotent, merged, throttled).
    const result = await registerInterest({ email, studios, source });
    const named = formatStudioInterestList(result.studios);

    if (result.outcome === 'confirmed') {
      return res.json({
        ok: true,
        status: 'confirmed',
        studios: result.studios,
        message: result.added.length
          ? `You’re already subscribed. We’ve added ${formatStudioInterestList(result.added)} to your picks.`
          : `You’re already subscribed. We’ll keep you posted about ${named}.`
      });
    }

    if (result.outcome === 'throttled') {
      if (result.throttle.code === 'too_many') {
        res.setHeader('Retry-After', String(result.throttle.retryAfterS));
        return fail(
          res,
          429,
          'too_many',
          'We’ve already sent several confirmation emails to this address today. Check your inbox and spam folder, or try again tomorrow.',
          { retryAfterS: result.throttle.retryAfterS }
        );
      }
      // The link sent a few minutes ago still works, and the picks are saved: still "pending".
      return res.json({
        ok: true,
        status: 'pending',
        resent: false,
        retryAfterS: result.throttle.retryAfterS,
        studios: result.studios,
        message: `We sent a confirmation link to this address a few minutes ago, so check your inbox and spam folder. Your picks are saved. You can ask for another link in ${minutes(result.throttle.retryAfterS)} min.`
      });
    }

    // 5) Send the double opt-in link (same email + confirm route as the newsletter).
    const confirmUrl = `${confirmBase()}/api/newsletter/confirm?e=${encodeURIComponent(email)}&t=${result.token}`;
    const sent = await sendNewsletterConfirm(email, confirmUrl, undefined, {
      userId: req.user?.id ?? null,
      requestId: req.requestId ?? null
    });
    if (!sent.ok) {
      if (sent.skipped === 'not_configured') return unavailable(res);
      // Cost cap or a worker hiccup. The picks are saved; a retry isn't throttled (failed and
      // capped sends don't count toward the per-recipient limits).
      console.warn('[interest] confirmation email not sent', { reason: sent.skipped || 'send_failed', requestId: req.requestId });
      return fail(
        res,
        503,
        'email_unavailable',
        'We couldn’t send the confirmation email right now. Your picks are saved. Please try again in a few minutes.'
      );
    }
    return res.json({
      ok: true,
      status: 'pending',
      resent: !result.firstTime,
      studios: result.studios,
      message: `Almost there! Check your inbox and click the link to confirm. Then we’ll email you about ${named}.`
    });
  } catch (err) {
    if (err instanceof InterestUnavailableError) {
      console.warn('[interest] unavailable:', err.message);
      return unavailable(res);
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
