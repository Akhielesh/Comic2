import express, { Router, type Request, type Response } from 'express';
import { APP_PUBLIC_URL, EMAIL_PUBLIC_BASE_URL } from '../config.js';
import {
  mailerConfigured,
  sendAccessRequested,
  sendNewsletterConfirm,
  sendNewsletterWelcome,
  verifyUnsubscribeToken
} from '../services/mailer.js';
import {
  confirmSubscriber,
  inspectConfirmLink,
  markUnsubscribed,
  newConfirmToken,
  normalizeEmail,
  upsertSubscriber
} from '../services/emailStore.js';
import { InterestRetryError, InterestUnavailableError, registerInterest } from '../services/interestStore.js';
import { resendPendingInvite } from '../services/invites.js';
import { getSupabaseAdmin } from '../services/supabase.js';
import { verifyTurnstile } from '../services/turnstile.js';

// Public, logged-out newsletter + waitlist capture with double opt-in. Mounted with
// optionalAuth BEFORE the global requireAuth (like /api/telemetry), so the marketing site
// can call it while signed out. Reads/writes go through the service role under the hood;
// the client never sees tokens or the list.
//
// The current frontend registers newsletter interest through POST /api/interest
// (routes/interest.ts); /subscribe with kind 'updates' stays for tabs still running the previous
// frontend and shares its service (registerInterest), so both get the same per-recipient
// confirmation throttle and the same rule: the answer never depends on the address's state.
// index.ts puts the same per-IP limiter as /api/interest in front of /subscribe.
// /confirm and /unsubscribe serve both.
//
// Confirming takes two steps on purpose: GET /confirm (the link in the email) only checks the
// link and shows a page with a Confirm button; POST /confirm (that button) subscribes the address
// and lifts an earlier unsubscribe. Mail-security scanners fetch every link in incoming mail, and
// such a fetch must never opt anyone in or undo their opt-out.
export const newsletterRouter = Router();

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const reqMeta = (req: Request) => ({ userId: req.user?.id ?? null, requestId: req.requestId ?? null });

// The configured public origin, else the app's. Never the request's Host header: a forged Host
// would put an attacker's domain into a confirmation email we send to someone else.
const baseUrl = (): string => EMAIL_PUBLIC_BASE_URL || APP_PUBLIC_URL;

const redirectToApp = (status: string): string => `${APP_PUBLIC_URL}/?newsletter=${encodeURIComponent(status)}`;

const COULD_NOT_SEND = 'We couldn’t send the confirmation email right now. Please try again in a few minutes.';

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
    // Optional intent capture — whitelisted/capped in upsertSubscriber.
    const intent = {
      productInterests: Array.isArray(req.body?.productInterests)
        ? (req.body.productInterests as unknown[]).map(String).slice(0, 10)
        : undefined,
      feedback: typeof req.body?.feedback === 'string' ? req.body.feedback.slice(0, 1000) : undefined
    };

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

      // Dedupe 1.5: an ALREADY-INVITED email doesn't belong on the waitlist either —
      // they already have access. Re-send their invite (cooldown-guarded inside) and
      // point them at the email instructions. Behind the same Turnstile gate as the
      // rest of this route, so this isn't a free enumeration oracle.
      const invited = await resendPendingInvite(email, { requestId: req.requestId });
      if (invited.status === 'invited') {
        return res.json({
          ok: false,
          status: 'already-invited',
          resent: invited.resent,
          message: invited.resent
            ? 'You already have access — we just re-sent your invite email. Follow its instructions to set up your account.'
            : 'You already have access — check your inbox for the invite email (sent recently) and follow its instructions to set up your account.'
        });
      }

      const token = newConfirmToken();
      const { outcome } = await upsertSubscriber(email, 'access', token, source ? { source } : {}, intent);

      // Dedupe 2: already on the waitlist — soft success, no duplicate row, no re-email.
      if (outcome === 'already_registered') {
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

    // Newsletter double opt-in (same service as POST /api/interest, so the same throttle). Every
    // valid request gets the same answer, whatever the address's state; failures are about the
    // service, never the address. (This older client shows an ok:false body as an error.)
    if (!mailerConfigured()) {
      // 503: the older client then stores the address with its own direct insert, as before.
      return res.status(503).json({ ok: false, code: 'interest_unavailable', message: 'Signups are unavailable right now.' });
    }
    const result = await registerInterest({
      email,
      studios: intent.productInterests ?? [],
      source,
      feedback: intent.feedback
    });
    if (result.outcome === 'budget_exhausted') return res.json({ ok: false, message: COULD_NOT_SEND });
    if (result.outcome === 'send_confirmation') {
      const confirmUrl = `${baseUrl()}/api/newsletter/confirm?e=${encodeURIComponent(email)}&t=${result.token}`;
      const sent = await sendNewsletterConfirm(email, confirmUrl, firstName, reqMeta(req));
      if (!sent.ok) {
        await result.release();
        return res.json({ ok: false, message: COULD_NOT_SEND });
      }
    }
    return res.json({ ok: true, message: 'Almost there! Check your inbox to confirm your subscription.' });
  } catch (err) {
    // A database without the interest columns: 503, which the older client answers with its own
    // direct insert (services/waitlist.ts) — the same as any other backend outage.
    if (err instanceof InterestUnavailableError) {
      return res.status(503).json({ ok: false, code: 'interest_unavailable', message: 'Signups are unavailable right now.' });
    }
    if (err instanceof InterestRetryError) {
      return res.json({ ok: false, message: 'We couldn’t save that just now. Please try again in a minute.' });
    }
    next(err);
  }
});

const str = (value: unknown): string => (typeof value === 'string' ? value : '');

const escapeHtml = (value: string): string =>
  value.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string);

const originOf = (url: string): string => {
  try {
    return new URL(url).origin;
  } catch {
    return '';
  }
};

/**
 * The page the email link opens: one Confirm button that POSTs the link back. No script, so a
 * scanner that fetches (or even renders) the page changes nothing.
 */
const sendConfirmPage = (res: Response, email: string, token: string) => {
  const appOrigin = originOf(APP_PUBLIC_URL);
  res
    .status(200)
    .set('Content-Type', 'text/html; charset=utf-8')
    .set('Cache-Control', 'no-store')
    .set('X-Robots-Tag', 'noindex, nofollow')
    // same-origin (not the global no-referrer): a form POST under no-referrer carries
    // `Origin: null`, which the CORS check rejects. Nothing on this page links off-site.
    .set('Referrer-Policy', 'same-origin')
    .set(
      'Content-Security-Policy',
      `default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'${appOrigin ? ` ${appOrigin}` : ''}`
    )
    .send(`<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow">
<title>Confirm your email · DreamStream</title>
<style>
:root{color-scheme:light dark}
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;font:15px/1.55 -apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,sans-serif;color:#1a1915;background:#FAF9F5}
main{max-width:26rem;padding:2rem 1.5rem}
h1{font-size:1.35rem;line-height:1.3;margin:0 0 .6rem}
p{margin:.5rem 0}
.muted{color:#6e6a60;font-size:.85rem}
button{margin-top:1rem;font:inherit;font-weight:600;padding:.7rem 1.4rem;border-radius:.6rem;border:1px solid #1a1915;background:#1a1915;color:#FAF9F5;cursor:pointer}
button:focus-visible{outline:3px solid #c2643f;outline-offset:2px}
@media (prefers-color-scheme:dark){body{color:#f1efe8;background:#1f1e1b}.muted{color:#a8a397}button{background:#f1efe8;color:#1f1e1b;border-color:#f1efe8}}
</style></head>
<body><main>
<h1>Confirm your DreamStream updates</h1>
<p>Press Confirm to get DreamStream updates at <strong>${escapeHtml(email)}</strong>. We send occasional emails about the studios you picked, and every one has a one-click unsubscribe.</p>
<form method="post" action="/api/newsletter/confirm">
<input type="hidden" name="e" value="${escapeHtml(email)}">
<input type="hidden" name="t" value="${escapeHtml(token)}">
<button type="submit">Confirm</button>
</form>
<p class="muted">Didn’t ask for this? Just close this page. Nothing changes unless you press Confirm.</p>
</main></body></html>`);
};

// GET /api/newsletter/confirm?e=&t= — the link in the email. Read-only: checks the link, then
// shows the Confirm page (or bounces straight to the app when there is nothing to confirm).
newsletterRouter.get('/confirm', async (req, res, next) => {
  try {
    const email = normalizeEmail(str(req.query.e));
    const token = str(req.query.t);
    if (!email || !token) return res.redirect(302, redirectToApp('invalid'));
    const state = await inspectConfirmLink(email, token);
    if (!state) return res.redirect(302, redirectToApp('invalid'));
    if (state === 'already_confirmed') return res.redirect(302, redirectToApp('confirmed'));
    return sendConfirmPage(res, email, token);
  } catch (err) {
    next(err);
  }
});

// POST /api/newsletter/confirm (form: e, t) — the Confirm button. Completes double opt-in, then
// bounces to the app.
newsletterRouter.post('/confirm', express.urlencoded({ extended: false, limit: '4kb' }), async (req, res, next) => {
  try {
    const body = (req.body && typeof req.body === 'object' ? req.body : {}) as Record<string, unknown>;
    const email = normalizeEmail(str(body.e));
    const token = str(body.t);
    if (!email || !token) return res.redirect(303, redirectToApp('invalid'));

    const outcome = await confirmSubscriber(email, token);
    if (!outcome) return res.redirect(303, redirectToApp('invalid'));

    // Welcome is marketing → only goes out once they've opted in (here), and only on the click
    // that actually opted them in (not on a later click, or one that only confirmed new picks).
    if (outcome === 'confirmed') void sendNewsletterWelcome(email, undefined, reqMeta(req));
    return res.redirect(303, redirectToApp('confirmed'));
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
