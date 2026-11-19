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
import { verifyTurnstile } from '../services/turnstile.js';
import {
  INTEREST_LIMITS,
  INTEREST_THANKS,
  answersForKind,
  cleanBlock,
  cleanLine,
  interestMetadata,
  interestThanks,
  knownHeard,
  knownMakes,
  type InterestAnswers
} from '../../../shared/interest.js';

// Public, logged-out "register your interest" capture (kind 'access') and product updates
// (kind 'updates'). Mounted with optionalAuth BEFORE the global requireAuth (like
// /api/telemetry), so signed-out pages can call it. Writes go through the service role; the
// client never sees tokens or the list. Sends no email unless INTEREST_EMAILS is "on"; the register-interest form's
// "keep me updated" box is stored as a consent flag and is read by no email path. That flag is a request from an
// address nobody has verified, never a reason on its own to mail it (docs/features/register-interest.md).
export const newsletterRouter = Router();

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const reqMeta = (req: Request) => ({ userId: req.user?.id ?? null, requestId: req.requestId ?? null });

// Prefer the configured public origin; fall back to the request's own origin so confirm
// links still work before EMAIL_PUBLIC_BASE_URL is set.
const baseUrl = (req: Request): string =>
  EMAIL_PUBLIC_BASE_URL || `${req.protocol}://${req.get('host')}`;

const redirectToApp = (status: string): string => `${APP_PUBLIC_URL}/?newsletter=${encodeURIComponent(status)}`;

/**
 * Interest emails are off unless INTEREST_EMAILS is exactly "on" (unset, empty or anything else is
 * off). Off means registering (either kind) stores the row and sends nothing, and the confirm link
 * in older emails still confirms without the welcome email. Read per request, never cached.
 */
export const interestEmailsOn = (): boolean => process.env.INTEREST_EMAILS === 'on';

type Checked<T> = { ok: true; value: T; message?: undefined } | { ok: false; value?: undefined; message: string };

/** Optional text: absent is fine; not text, or longer than `max` once cleaned, is refused (never cut). */
const optionalText = (raw: unknown, max: number, clean: (v: string) => string, label: string): Checked<string | undefined> => {
  if (raw === undefined || raw === null) return { ok: true, value: undefined };
  if (typeof raw !== 'string') return { ok: false, message: `${label} must be text.` };
  const value = clean(raw);
  if (value.length > max) return { ok: false, message: `${label} can be at most ${max} characters.` };
  return { ok: true, value: value || undefined };
};

/** Optional list: absent is fine; not a list, or longer than the cap, is refused. Entries are filtered later. */
const optionalList = (raw: unknown, label: string): Checked<unknown[]> => {
  if (raw === undefined || raw === null) return { ok: true, value: [] };
  if (!Array.isArray(raw)) return { ok: false, message: `${label} must be a list.` };
  if (raw.length > INTEREST_LIMITS.listMax) return { ok: false, message: `${label}: choose at most ${INTEREST_LIMITS.listMax}.` };
  return { ok: true, value: raw };
};

/** Fields only the question set before this one sent (an open tab from then); none of them is stored. */
const V1_ONLY_FIELDS = ['features', 'featureOther', 'studios', 'productInterests'] as const;

/** True when the request carries a field only the old question set sent, so its name and note were asked by that set. */
export const fromOldQuestionSet = (body: Record<string, unknown>): boolean =>
  V1_ONLY_FIELDS.some((key) => body[key] !== undefined && body[key] !== null);

/**
 * The optional answers, checked here whatever the client did: unknown ids dropped, each id once,
 * control characters stripped (the note keeps its line breaks), and anything of the wrong type or
 * over its limit refused with a 400 that says what to shorten. The keep-me-updated box is read only when
 * the request carried it as `true` or `false` (the current form always does; answersForKind then decides
 * per kind): a request without it, such as a tab opened before the box existed, records no choice at all
 * rather than a "no" to words the person never saw. Older forms sent `feedback` for the note (still read),
 * and open tabs from before the questions changed may still send `features`, `featureOther`, `studios` or
 * `productInterests`: those are accepted and not stored, since those questions are no longer asked.
 */
export const readInterestAnswers = (body: Record<string, unknown>): Checked<InterestAnswers> => {
  const makes = optionalList(body.makes, 'What you would like to make');
  if (!makes.ok) return { ok: false, message: makes.message };
  if (body.heardFrom !== undefined && body.heardFrom !== null && typeof body.heardFrom !== 'string') {
    return { ok: false, message: 'How you heard about us must be one of the choices.' };
  }
  const firstName = optionalText(body.firstName, INTEREST_LIMITS.firstNameMax, cleanLine, 'First name');
  if (!firstName.ok) return { ok: false, message: firstName.message };
  const comment = optionalText(body.comment ?? body.feedback, INTEREST_LIMITS.commentMax, cleanBlock, 'Your note');
  if (!comment.ok) return { ok: false, message: comment.message };
  const makeIds = knownMakes(makes.value);
  const heardFrom = knownHeard(body.heardFrom);
  return {
    ok: true,
    value: {
      ...(firstName.value ? { firstName: firstName.value } : {}),
      ...(makeIds.length ? { makes: makeIds } : {}),
      ...(heardFrom ? { heardFrom } : {}),
      ...(comment.value ? { comment: comment.value } : {}),
      ...(typeof body.keepUpdated === 'boolean' ? { keepUpdated: body.keepUpdated } : {})
    }
  };
};

/** The one answer every valid address gets, per kind, whatever its history (here: with no optional answers). */
export const NEUTRAL_REPLY = {
  access: { ok: true, status: 'registered', message: INTEREST_THANKS.access },
  updates: { ok: true, status: 'registered', message: INTEREST_THANKS.updates }
} as const;

/** NEUTRAL_REPLY for one request: it thanks for the answers when some were sent (what was sent, never the address). */
export const neutralReply = (kind: 'access' | 'updates', answers: InterestAnswers) => ({
  ...NEUTRAL_REPLY[kind],
  message: interestThanks(kind, answers)
});

const invalid = (message: string) => ({ ok: false, status: 'invalid', message });

// POST /api/newsletter/subscribe
//   { email, kind?: 'access'|'updates', source?, firstName?, makes?: string[], heardFrom?, comment?,
//     keepUpdated?: boolean, captchaToken? }
// Every valid address gets NEUTRAL_REPLY[kind]: the same status and body for a new address, one already
// on the list, one with an account and one holding an invite. The route never looks the address up in
// accounts or invites and never re-sends an invite, so a caller learns nothing about it.
newsletterRouter.post('/subscribe', async (req, res, next) => {
  try {
    const body = (req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {}) as Record<string, unknown>;
    const email = normalizeEmail(typeof body.email === 'string' ? body.email : '');
    const kind = body.kind === 'access' ? 'access' : 'updates';

    if (!email) return res.status(400).json(invalid('Please enter your email address.'));
    if (!EMAIL_REGEX.test(email) || email.length > 320) {
      return res.status(400).json(invalid('That email does not look right. Please check it.'));
    }
    const read = readInterestAnswers(body);
    if (!read.ok) return res.status(400).json(invalid(read.message));
    // Register interest records the box when the form showed it (false unless ticked); the list card has none.
    const answers = read.value.keepUpdated === undefined ? read.value : answersForKind(kind, read.value);
    // The surface tag is ours, not the person's: cleaned and cut, never a reason to refuse.
    const source = typeof body.source === 'string' ? cleanLine(body.source).slice(0, INTEREST_LIMITS.sourceMax) || undefined : undefined;

    // Bot protection (no-op unless TURNSTILE_SECRET_KEY is configured).
    const captchaToken = typeof body.captchaToken === 'string' ? body.captchaToken : undefined;
    if (!(await verifyTurnstile(captchaToken, req.ip))) {
      return res
        .status(400)
        .json({ ok: false, status: 'verify', message: 'Please complete the verification check and try again.' });
    }

    // Answers and the consent flag (with this moment as its time) ride in the existing metadata (jsonb) column, the
    // shape the form's direct save writes too; the note also goes to the existing feedback column.
    const { firstName, comment } = answers;
    const intent = comment ? { feedback: comment } : {};
    const metadata = interestMetadata(source, answers, new Date().toISOString());
    // An open tab from before the questions changed: its name and note were asked by the old set, so say so.
    if (fromOldQuestionSet(body) && metadata.answers) metadata.answers = { ...(metadata.answers as Record<string, unknown>), v: 1 };
    const token = newConfirmToken();
    const emailsOn = interestEmailsOn();
    let outcome: string;
    try {
      // An address already on the list keeps its answers; a ticked box is recorded on a register-interest row that
      // held no yes, and only with emails on does an unconfirmed 'updates' row get a fresh confirm token (the link
      // about to be sent). A store that saved nothing throws.
      ({ outcome } = await upsertSubscriber(email, kind, token, metadata, intent, { reissueToken: emailsOn }));
    } catch (err) {
      console.warn('[newsletter] store failed', (err as Error)?.message);
      return res
        .status(503)
        .json({ ok: false, status: 'unavailable', message: 'We could not save that just now. Please try again in a moment.' });
    }

    if (emailsOn) {
      // Neither branch reads the keep-me-updated box: it starts no email of its own.
      // Best-effort and never awaited: a mailer failure must not change the answer. A confirm email only goes
      // with a token the store just wrote (a new row, or a renewed one), so its link always matches the row.
      if (kind === 'access' && outcome === 'new') void sendAccessRequested(email, firstName, reqMeta(req));
      if (kind === 'updates' && (outcome === 'new' || outcome === 'pending')) {
        const confirmUrl = `${baseUrl(req)}/api/newsletter/confirm?e=${encodeURIComponent(email)}&t=${token}`;
        void sendNewsletterConfirm(email, confirmUrl, firstName, reqMeta(req));
      }
    }
    return res.status(200).json(neutralReply(kind, answers));
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

    // Welcome is marketing: only once they opted in (here), and only while interest emails are on.
    if (interestEmailsOn()) void sendNewsletterWelcome(email, undefined, reqMeta(req));
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
