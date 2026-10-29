import crypto from 'crypto';
import { Router, type NextFunction, type Request, type Response } from 'express';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { EmailTemplateName } from '../../../shared/email/index.js';
import {
  buildAuthLink,
  linksToLiveApp,
  maskEmail,
  parseAfter,
  parseApp,
  parseSignInNonce,
  pickLinkOrigin,
  type AuthApp
} from '../services/authEmailLinks.js';
import { countRecentAuthEmails, latestAuthEmailAt, normalizeEmail } from '../services/emailStore.js';
import { getEmailUsageStatus, mailerConfigured, sendEmail } from '../services/mailer.js';
import { getSupabaseAdmin } from '../services/supabase.js';
import { turnstileConfigured, verifyTurnstile } from '../services/turnstile.js';

// Auth emails — sign-up confirmation, resend, password reset, magic link — sent by US.
//
// Why: Supabase Auth's built-in mailer allows ~2 emails/hour for the WHOLE project, so sign-ups
// died with "429: email rate limit exceeded". The Send Email Hook doesn't help (GoTrue applies
// that limit before calling the hook). Instead the service role asks GoTrue for the link
// (auth.admin.generateLink — sends nothing, not email-rate-limited) and we mail our branded
// auth-* template through the email Worker. With that, the throttling GoTrue did is ours:
// Turnstile, a per-IP limiter (index.ts) and a per-recipient throttle over email_log.
//
// Mounted BEFORE the global requireAuth, with optionalAuth (a signed-in user re-sending their
// own confirmation skips the captcha). Pipeline per request:
//   1. validate input;
//   2. readiness preflight → 503 {code:'email_unavailable', fallback:true}. It runs BEFORE the
//      captcha because Turnstile tokens are single-use: the client's fallback (the old direct
//      Supabase call) can still use the token only if we haven't spent it;
//   3. captcha policy;  4. per-recipient throttle;  5. generateLink;  6. sendEmail.
// Every answer after step 2 is final — the client never falls back on it (a fallback would
// just hit Supabase's limit). /resend, /recovery and /magiclink never reveal whether an
// account exists. Logs mask addresses and never contain tokens or links.
//
// Also here (ADR 0006 WS-4):
//   * sign-up refuses passwords known from data breaches (Pwned Passwords, k-anonymity: only
//     the first 5 hex characters of the password's SHA-1 leave the server). Fails open.
//   * POST /secure — the "Not you? Secure my account" link from a new-sign-in email: ends every
//     session (live_secure_account, server/sql/live_security_v2.sql) and mails a reset link.

export const authEmailRouter = Router();

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const USERNAME_REGEX = /^[A-Za-z0-9_]{3,20}$/;
const MIN_SIGNUP_AGE_YEARS = 8;
const DAY_MS = 86_400_000;

/** Per-recipient limits across all auth emails (email_log, status queued|sent). */
export const AUTH_EMAIL_THROTTLE = { minIntervalS: 60, maxPerHour: 5, maxPerDay: 10 } as const;

const EMAIL_EXISTS_MESSAGE = 'An account with this email already exists. Please sign in or reset your password.';
const SEND_FAILED_MESSAGE = 'We couldn’t send the email right now. Please try again in a minute.';

const TEMPLATE_FOR_TYPE: Record<string, EmailTemplateName> = {
  signup: 'auth-confirm-signup',
  magiclink: 'auth-magic-link',
  recovery: 'auth-recovery',
  invite: 'auth-invite'
};

type Body = Record<string, unknown>;
const bodyOf = (req: Request): Body => (req.body && typeof req.body === 'object' ? (req.body as Body) : {});

const fail = (res: Response, status: number, code: string, message: string, extra: Record<string, unknown> = {}) =>
  res.status(status).json({ ok: false, code, message, ...extra });

const readEmail = (raw: unknown): string | null => {
  const email = normalizeEmail(typeof raw === 'string' ? raw : '');
  return email && email.length <= 320 && EMAIL_REGEX.test(email) ? email : null;
};

const invalidEmail = (res: Response) => fail(res, 400, 'invalid_email', 'Please enter a valid email address.');

/** GoTrue ignores this for existing users; it only satisfies generateLink's signup shape. */
const throwawayPassword = (): string => crypto.randomBytes(32).toString('base64url');

// ── Sign-up input ────────────────────────────────────────────────────────────────

/** Metadata keys a sign-up may set (raw_user_meta_data → the profile trigger + live app). */
export const SIGNUP_DATA_KEYS = [
  'username',
  'first_name',
  'last_name',
  'phone_number',
  'dob',
  'display_name',
  'terms_accepted',
  'marketing_consent',
  'email_pref_product_updates',
  'email_pref_marketing',
  'live_ticket',
  'signup_source'
] as const;

export interface SignupInput {
  app: AuthApp;
  after?: string;
  password: string;
  data: Record<string, string | boolean | null>;
}

const isoDay = (date: Date): string => date.toISOString().slice(0, 10);

/**
 * DOB rules mirroring the clients (the live DB trigger checks the format but NOT the age).
 * One day of slack: the clients check in the user's local zone, which can be ahead of UTC.
 */
export const dobProblem = (dob: string, now: Date = new Date()): string | null => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dob)) return 'Date of birth must be valid.';
  const date = new Date(`${dob}T00:00:00Z`);
  if (Number.isNaN(date.getTime()) || isoDay(date) !== dob || dob < '1900-01-01') return 'Date of birth must be valid.';
  const latest = new Date(now.getTime() + DAY_MS);
  if (dob > isoDay(latest)) return 'Date of birth cannot be in the future.';
  const oldEnough = new Date(latest);
  oldEnough.setUTCFullYear(oldEnough.getUTCFullYear() - MIN_SIGNUP_AGE_YEARS);
  if (dob > isoDay(oldEnough)) return `You must be at least ${MIN_SIGNUP_AGE_YEARS} years old to sign up.`;
  return null;
};

const text = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');

/** Validate a /signup body and keep only whitelisted metadata. */
export const parseSignupInput = (
  body: Body,
  now: Date = new Date()
): { ok: true; value: SignupInput } | { ok: false; message: string } => {
  const bad = (message: string) => ({ ok: false as const, message });
  const password = typeof body.password === 'string' ? body.password : '';
  if (password.length < 8) return bad('Password must be at least 8 characters.');
  if (Buffer.byteLength(password, 'utf8') > 72) return bad('Password must be at most 72 characters.');

  const raw = body.data && typeof body.data === 'object' && !Array.isArray(body.data) ? (body.data as Body) : {};
  const username = text(raw.username);
  if (!USERNAME_REGEX.test(username)) {
    return bad('Username must be 3-20 chars and use only letters, numbers, or underscore.');
  }
  const firstName = text(raw.first_name);
  if (!firstName) return bad('First name is required.');
  if (firstName.length > 100) return bad('First name is too long.');
  const lastName = text(raw.last_name);
  if (lastName.length > 100) return bad('Last name is too long.');
  const phone = text(raw.phone_number);
  if (phone.length > 40) return bad('Phone number is too long.');
  const dob = text(raw.dob);
  if (!dob) return bad('Date of birth is required.');
  const dobError = dobProblem(dob, now);
  if (dobError) return bad(dobError);
  if (raw.terms_accepted !== true) return bad('You must accept the Terms & Conditions.');
  const displayName = text(raw.display_name).replace(/\s+/g, ' ');
  if (displayName.length > 40) return bad('Display name must be 40 characters or fewer.');

  const data: SignupInput['data'] = {
    username,
    first_name: firstName,
    last_name: lastName || null,
    phone_number: phone || null,
    dob,
    terms_accepted: true
  };
  if (displayName) data.display_name = displayName;
  for (const key of ['marketing_consent', 'email_pref_product_updates', 'email_pref_marketing'] as const) {
    if (typeof raw[key] === 'boolean') data[key] = raw[key] as boolean;
  }
  const ticket = text(raw.live_ticket);
  if (ticket && ticket.length <= 128) data.live_ticket = ticket;
  const source = text(raw.signup_source);
  if (/^[a-z0-9_]{1,40}$/.test(source)) data.signup_source = source;

  return { ok: true, value: { app: parseApp(body.app), after: parseAfter(body.after), password, data } };
};

// ── Breached passwords (Have I Been Pwned, k-anonymity) ─────────────────────────

const PWNED_RANGE_URL = 'https://api.pwnedpasswords.com/range/';
const PWNED_TIMEOUT_MS = 2500;
export const BREACHED_PASSWORD_MESSAGE =
  'This password has appeared in a known data breach, so it’s easy for others to guess. Please choose a different one.';

let pwnedFetcher: typeof fetch = (input, init) => fetch(input, init);
/** Tests only: where the range API is fetched from. */
export const setPwnedFetcher = (f?: typeof fetch): void => {
  pwnedFetcher = f ?? ((input, init) => fetch(input, init));
};

/**
 * How often this password appears in known breaches (0 = never), or null when the check
 * couldn't run. Only the first 5 hex characters of its SHA-1 are sent, with the padding header
 * so even the response size says nothing; the password itself never leaves this process.
 */
export async function pwnedPasswordCount(password: string, opts: { fetcher?: typeof fetch; timeoutMs?: number } = {}): Promise<number | null> {
  const sha1 = crypto.createHash('sha1').update(password, 'utf8').digest('hex').toUpperCase();
  const prefix = sha1.slice(0, 5);
  const suffix = sha1.slice(5);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? PWNED_TIMEOUT_MS);
  try {
    const res = await (opts.fetcher ?? pwnedFetcher)(`${PWNED_RANGE_URL}${prefix}`, {
      headers: { 'Add-Padding': 'true', 'User-Agent': 'DreamStream-Studio-signup' },
      signal: ctrl.signal
    });
    if (!res.ok) return null;
    for (const line of (await res.text()).split('\n')) {
      const [suf, count] = line.trim().split(':');
      if (suf && suf.toUpperCase() === suffix) {
        const n = Number(count);
        return Number.isFinite(n) && n > 0 ? n : 0; // padding rows carry a count of 0
      }
    }
    return 0;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** On unless PWNED_PASSWORDS_CHECK=off; off under the test runner unless forced on. */
export const breachedPasswordCheckOn = (): boolean => {
  const v = (process.env.PWNED_PASSWORDS_CHECK || '').toLowerCase();
  if (v === 'off' || v === 'false' || v === '0') return false;
  if (v === 'on' || v === 'true' || v === '1') return true;
  return process.env.NODE_ENV !== 'test';
};

/** True only when the password is known to be breached. Fails open (with a log line). */
const breachedPassword = async (password: string): Promise<boolean> => {
  if (!breachedPasswordCheckOn()) return false;
  const n = await pwnedPasswordCount(password);
  if (n == null) {
    console.warn('[auth-email] breached-password check unavailable — allowing this sign-up');
    return false;
  }
  return n > 0;
};

// ── Pipeline steps ───────────────────────────────────────────────────────────────

/**
 * Can we send right now? Service role, mailer and the cost caps. Null ⇒ answer 503 with
 * fallback:true so the client uses the old Supabase call (still holding an unspent captcha).
 */
const emailReady = async (): Promise<SupabaseClient | null> => {
  let admin: SupabaseClient;
  try {
    admin = getSupabaseAdmin();
  } catch {
    return null;
  }
  if (!mailerConfigured()) return null;
  try {
    const usage = await getEmailUsageStatus();
    if (usage.maxPerDay > 0 && usage.day >= usage.maxPerDay) return null;
    if (usage.maxPerMonth > 0 && usage.month >= usage.maxPerMonth) return null;
  } catch {
    // Usage unknown — the mailer's own cap check still guards the send.
  }
  return admin;
};

const unavailable = (res: Response) =>
  fail(res, 503, 'email_unavailable', 'Email sending is unavailable right now.', { fallback: true });

/** sha256(ticket) is a live, unredeemed row in live_welcome_tickets (minted by a correct welcome code). */
const isValidLiveTicket = async (admin: SupabaseClient, ticket: unknown): Promise<boolean> => {
  if (typeof ticket !== 'string' || ticket.length < 16 || ticket.length > 128) return false;
  try {
    const { data, error } = await admin
      .from('live_welcome_tickets')
      .select('token_hash')
      .eq('token_hash', crypto.createHash('sha256').update(ticket).digest('hex'))
      .is('used_at', null)
      .gt('expires_at', new Date().toISOString())
      .limit(1)
      .maybeSingle();
    return !error && Boolean(data);
  } catch {
    return false;
  }
};

/**
 * A token, when sent, must verify. Without one: allowed when Turnstile isn't configured, or
 * when `allowWithoutToken()` says so (live sign-ups with a welcome ticket). Resend / reset /
 * magic link always need one — without it, anyone could spend a stranger's per-address
 * allowance and lock them out of these emails for a day (the signed-in own-address resend
 * is the one exception).
 */
const captchaGate = async (
  req: Request,
  allowWithoutToken: () => boolean | Promise<boolean>
): Promise<null | 'captcha_failed' | 'captcha_required'> => {
  const raw = bodyOf(req).captchaToken;
  const token = typeof raw === 'string' ? raw.trim() : '';
  if (token) return (await verifyTurnstile(token, req.ip)) ? null : 'captcha_failed';
  if (!turnstileConfigured()) return null;
  return (await allowWithoutToken()) ? null : 'captcha_required';
};

const captchaFailure = (res: Response, code: 'captcha_failed' | 'captcha_required') =>
  fail(
    res,
    400,
    code,
    code === 'captcha_failed'
      ? 'The verification challenge expired or failed. Please try again.'
      : 'Please complete the verification challenge.'
  );

type Throttle = { code: 'too_soon' | 'too_many'; message: string; retryAfterS?: number };

const checkThrottle = async (email: string, now = Date.now()): Promise<Throttle | null> => {
  const [latest, lastHour, lastDay] = await Promise.all([
    latestAuthEmailAt(email),
    countRecentAuthEmails(email, new Date(now - 3_600_000).toISOString()),
    countRecentAuthEmails(email, new Date(now - DAY_MS).toISOString())
  ]);
  const sinceLast = latest ? now - Date.parse(latest) : Infinity;
  const waitMs = AUTH_EMAIL_THROTTLE.minIntervalS * 1000 - sinceLast;
  if (waitMs > 0) {
    const retryAfterS = Math.max(1, Math.ceil(waitMs / 1000));
    return {
      code: 'too_soon',
      retryAfterS,
      message: `We just sent an email to this address. Please wait ${retryAfterS} seconds before asking for another.`
    };
  }
  if (lastHour >= AUTH_EMAIL_THROTTLE.maxPerHour) {
    return {
      code: 'too_many',
      message: 'We’ve sent several emails to this address in the last hour. Check your inbox and spam folder, or try again later.'
    };
  }
  if (lastDay >= AUTH_EMAIL_THROTTLE.maxPerDay) {
    return {
      code: 'too_many',
      message: 'We’ve sent several emails to this address today. Check your inbox and spam folder, or try again tomorrow.'
    };
  }
  return null;
};

const throttled = (res: Response, t: Throttle) => {
  if (t.retryAfterS) res.setHeader('Retry-After', String(t.retryAfterS));
  return fail(res, 429, t.code, t.message, t.retryAfterS ? { retryAfterS: t.retryAfterS } : {});
};

type Account = { status: 'none' } | { status: 'confirmed' | 'unconfirmed'; userId: string };

/** profiles.email (stored lowercase, one per auth user) → the auth user's confirmation state. */
const lookupAccount = async (admin: SupabaseClient, email: string): Promise<Account> => {
  const { data, error } = await admin.from('profiles').select('id').eq('email', email).limit(1).maybeSingle();
  if (error) throw new Error(`profile lookup failed: ${error.message}`);
  const id = (data as { id?: string } | null)?.id;
  if (!id) return { status: 'none' };
  const { data: found, error: userError } = await admin.auth.admin.getUserById(id);
  if (userError) {
    if (userError.status === 404) return { status: 'none' };
    throw new Error(`user lookup failed: ${userError.message}`);
  }
  if (!found?.user) return { status: 'none' };
  return { status: found.user.email_confirmed_at ? 'confirmed' : 'unconfirmed', userId: id };
};

type LinkError = { status?: number; code?: string; message?: string };
type LinkProps = { hashed_token?: string; verification_type?: string };

/** Build the link from what GoTrue actually issued and mail it. Never throws. */
const deliver = async (
  req: Request,
  route: string,
  opts: { email: string; app: AuthApp; after?: string; origin: string; props: LinkProps | undefined; userId?: string | null }
): Promise<boolean> => {
  const type = opts.props?.verification_type || '';
  let actionUrl: string;
  try {
    actionUrl = buildAuthLink({
      app: opts.app,
      origin: opts.origin,
      after: opts.after,
      hashedToken: opts.props?.hashed_token || '',
      verificationType: type,
      // The requesting browser's nonce: in that browser the link completes without a confirm step.
      signInNonce: parseSignInNonce(bodyOf(req).sn)
    });
  } catch (err) {
    console.error(`[auth-email] ${route} → ${maskEmail(opts.email)}: cannot build link (${(err as Error).message})`);
    return false;
  }
  const result = await sendEmail({
    to: opts.email,
    template: TEMPLATE_FOR_TYPE[type],
    params: { actionUrl },
    brand: linksToLiveApp(opts.app, type) ? 'stream-studio' : undefined,
    track: false,
    userId: opts.userId ?? req.user?.id ?? null,
    requestId: req.requestId ?? null
  });
  if (result.ok) console.log(`[auth-email] ${route} → ${maskEmail(opts.email)} sent (${type})`);
  else console.warn(`[auth-email] ${route} → ${maskEmail(opts.email)} not sent: ${result.skipped || result.error || 'unknown'}`);
  return result.ok;
};

const linkTarget = (req: Request) => {
  const origin = pickLinkOrigin(req.get('origin'));
  return { origin, redirectTo: `${origin}/auth/callback` };
};

const isDatabaseError = (error: LinkError) => /database error/i.test(error.message || '');
const isEmailExists = (error: LinkError) =>
  error.code === 'email_exists' || /already (been )?registered|already exists/i.test(error.message || '');

// ── One request per address at a time ────────────────────────────────────────────
// The per-recipient throttle reads email_log, and the row it counts is only written when the
// mailer sends — several network round trips later. Concurrent requests for one address
// would all read "nothing sent yet" and all send, so they queue behind each other instead.
// The backend runs as a single container instance, so an in-process queue is enough.
const addressQueues = new Map<string, Promise<void>>();
export const oneAtATimePerAddress = (req: Request, res: Response, next: NextFunction): void => {
  const email = readEmail(bodyOf(req).email);
  if (!email) return next();
  const prev = addressQueues.get(email) ?? Promise.resolve();
  let release!: () => void;
  const mine = new Promise<void>((resolve) => (release = resolve));
  const tail = prev.then(() => mine);
  addressQueues.set(email, tail);
  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    release();
    if (addressQueues.get(email) === tail) addressQueues.delete(email);
  };
  res.once('finish', finish);
  res.once('close', finish);
  void prev.then(() => next());
};
authEmailRouter.use(oneAtATimePerAddress);

// ── Routes ───────────────────────────────────────────────────────────────────────

// POST /api/auth/email/signup — { app, after?, email, password, data, captchaToken? }
authEmailRouter.post('/signup', async (req, res, next) => {
  try {
    const body = bodyOf(req);
    const email = readEmail(body.email);
    if (!email) return invalidEmail(res);
    const parsed = parseSignupInput(body);
    if (parsed.ok === false) return fail(res, 400, 'invalid_input', parsed.message);
    const input = parsed.value;

    const admin = await emailReady();
    if (!admin) return unavailable(res);

    // Before the captcha, so a refused password doesn't spend the person's token.
    if (await breachedPassword(input.password)) return fail(res, 400, 'breached_password', BREACHED_PASSWORD_MESSAGE);

    // Live sign-ups have no captcha widget; a welcome ticket (minted only by a correct,
    // rate-limited welcome code) stands in for it.
    const gate = await captchaGate(req, () => input.app === 'live' && isValidLiveTicket(admin, input.data.live_ticket));
    if (gate) return captchaFailure(res, gate);

    const limit = await checkThrottle(email);
    if (limit) return throttled(res, limit);

    const account = await lookupAccount(admin, email);
    if (account.status === 'confirmed') return fail(res, 409, 'email_exists', EMAIL_EXISTS_MESSAGE);

    const { origin, redirectTo } = linkTarget(req);
    // An existing UNCONFIRMED account gets a fresh confirmation, nothing else: GoTrue would
    // merge new metadata into it (Supabase's own signUp deliberately doesn't), and it never
    // changes an existing password.
    const isNew = account.status === 'none';
    const { data, error } = isNew
      ? await admin.auth.admin.generateLink({
          type: 'signup',
          email,
          password: input.password,
          options: { data: input.data, redirectTo }
        })
      : await admin.auth.admin.generateLink({ type: 'signup', email, password: throwawayPassword(), options: { redirectTo } });

    if (error) {
      const e = error as LinkError;
      if (isEmailExists(e)) return fail(res, 409, 'email_exists', EMAIL_EXISTS_MESSAGE);
      // The profile trigger failed (username taken, …). The live app retries with a new username.
      if (isDatabaseError(e)) {
        return fail(res, 422, 'database_error', 'Database error saving new user — that username may already be taken.');
      }
      if (e.code === 'weak_password') return fail(res, 400, 'weak_password', e.message || 'Please choose a stronger password.');
      if (e.code === 'validation_failed') return fail(res, 400, 'invalid_input', e.message || 'Please check your details.');
      console.error(`[auth-email] signup → ${maskEmail(email)}: generateLink failed (${e.status ?? '?'} ${e.code ?? ''})`);
      return fail(res, 500, 'auth_error', 'Could not create the account — please try again.');
    }

    const sent = await deliver(req, 'signup', {
      email,
      app: input.app,
      after: input.after,
      origin,
      props: data?.properties,
      userId: data?.user?.id ?? (account.status === 'none' ? null : account.userId)
    });
    if (!sent) {
      // The account exists now; a resend is the fix, never a second sign-up (no fallback).
      return fail(
        res,
        502,
        'send_failed',
        'Your account was created, but we couldn’t send the confirmation email. Use “Resend verification email” to try again.',
        { created: true }
      );
    }
    return res.json({ ok: true, confirmEmail: true });
  } catch (err) {
    next(err);
  }
});

// POST /api/auth/email/resend — { email, app?, after?, captchaToken? }. Only ever re-sends a
// confirmation to an existing UNCONFIRMED account; answers {ok:true} for everyone else.
authEmailRouter.post('/resend', async (req, res, next) => {
  try {
    const body = bodyOf(req);
    const email = readEmail(body.email);
    if (!email) return invalidEmail(res);
    const app = parseApp(body.app);
    const after = parseAfter(body.after);

    const admin = await emailReady();
    if (!admin) return unavailable(res);

    // Signed in and asking for your own address (Settings → Security has no captcha widget).
    const ownAddress = Boolean(req.user?.email && normalizeEmail(req.user.email) === email);
    if (!ownAddress) {
      const gate = await captchaGate(req, () => false);
      if (gate) return captchaFailure(res, gate);
    }

    const limit = await checkThrottle(email);
    if (limit) return throttled(res, limit);

    const account = await lookupAccount(admin, email);
    if (account.status !== 'unconfirmed') return res.json({ ok: true });

    const { origin, redirectTo } = linkTarget(req);
    const { data, error } = await admin.auth.admin.generateLink({
      type: 'signup',
      email,
      password: throwawayPassword(),
      options: { redirectTo }
    });
    if (error) {
      // Confirmed in the meantime ⇒ nothing to resend.
      if (isEmailExists(error as LinkError)) return res.json({ ok: true });
      console.error(`[auth-email] resend → ${maskEmail(email)}: generateLink failed (${(error as LinkError).status ?? '?'})`);
      return fail(res, 502, 'send_failed', SEND_FAILED_MESSAGE);
    }
    const sent = await deliver(req, 'resend', { email, app, after, origin, props: data?.properties, userId: account.userId });
    return sent ? res.json({ ok: true }) : fail(res, 502, 'send_failed', SEND_FAILED_MESSAGE);
  } catch (err) {
    next(err);
  }
});

// POST /api/auth/email/recovery — { email, captchaToken? }. The link always lands on the MAIN
// app's /auth/callback (that's where the new-password screen lives), even from /live.
authEmailRouter.post('/recovery', async (req, res, next) => {
  try {
    const email = readEmail(bodyOf(req).email);
    if (!email) return invalidEmail(res);

    const admin = await emailReady();
    if (!admin) return unavailable(res);

    const gate = await captchaGate(req, () => false);
    if (gate) return captchaFailure(res, gate);

    const limit = await checkThrottle(email);
    if (limit) return throttled(res, limit);

    const { origin, redirectTo } = linkTarget(req);
    const { data, error } = await admin.auth.admin.generateLink({ type: 'recovery', email, options: { redirectTo } });
    if (error) {
      const e = error as LinkError;
      // Unknown address: same answer as a real one (no account enumeration).
      if (e.status === 404 || e.code === 'user_not_found') return res.json({ ok: true });
      console.error(`[auth-email] recovery → ${maskEmail(email)}: generateLink failed (${e.status ?? '?'} ${e.code ?? ''})`);
      return fail(res, 502, 'send_failed', SEND_FAILED_MESSAGE);
    }
    const sent = await deliver(req, 'recovery', { email, app: 'main', origin, props: data?.properties, userId: data?.user?.id });
    return sent ? res.json({ ok: true }) : fail(res, 502, 'send_failed', SEND_FAILED_MESSAGE);
  } catch (err) {
    next(err);
  }
});

// POST /api/auth/email/magiclink — { email, captchaToken? }. Never creates an account (GoTrue
// would silently turn a magic link for an unknown address into a sign-up).
authEmailRouter.post('/magiclink', async (req, res, next) => {
  try {
    const email = readEmail(bodyOf(req).email);
    if (!email) return invalidEmail(res);

    const admin = await emailReady();
    if (!admin) return unavailable(res);

    const gate = await captchaGate(req, () => false);
    if (gate) return captchaFailure(res, gate);

    const limit = await checkThrottle(email);
    if (limit) return throttled(res, limit);

    const account = await lookupAccount(admin, email);
    if (account.status === 'none') return res.json({ ok: true });

    const { origin, redirectTo } = linkTarget(req);
    const { data, error } = await admin.auth.admin.generateLink({ type: 'magiclink', email, options: { redirectTo } });
    if (error) {
      console.error(`[auth-email] magiclink → ${maskEmail(email)}: generateLink failed (${(error as LinkError).status ?? '?'})`);
      return fail(res, 502, 'send_failed', SEND_FAILED_MESSAGE);
    }
    const sent = await deliver(req, 'magiclink', { email, app: 'main', origin, props: data?.properties, userId: account.userId });
    return sent ? res.json({ ok: true }) : fail(res, 502, 'send_failed', SEND_FAILED_MESSAGE);
  } catch (err) {
    next(err);
  }
});

// POST /api/auth/email/secure — { token } from a new-sign-in email's "Not you? Secure my
// account" link (email-worker/src/securityAlert.ts). No captcha and no session: the one-time
// token (7 days, single use, only its hash stored) proves the mailbox. Steps:
//   1. live_secure_account (service role): spends the token, ends EVERY session of the account
//      (each device must sign in again; refresh tokens die with them), revokes devices added
//      since that sign-in, records a 'secured' event;
//   2. mails a password-reset link to the account's address (same throttle as /recovery).
// The answer says honestly what happened; a reset email that couldn't go out is reported, and
// the app then offers "Forgot password".
authEmailRouter.post('/secure', async (req, res, next) => {
  try {
    const raw = bodyOf(req).token;
    const token = typeof raw === 'string' ? raw.trim() : '';
    if (!/^[A-Za-z0-9_-]{20,128}$/.test(token)) {
      return fail(res, 400, 'invalid_token', 'This link isn’t valid — open it straight from the email.');
    }
    let admin: SupabaseClient;
    try {
      admin = getSupabaseAdmin();
    } catch {
      return fail(res, 503, 'unavailable', 'We can’t secure your account right now. Please try again in a minute.');
    }

    const { data, error } = await admin.rpc('live_secure_account', { p_token: token });
    if (error) {
      console.error(`[auth-email] secure: live_secure_account failed (${(error as LinkError).code ?? '?'})`);
      return fail(res, 503, 'unavailable', 'We can’t secure your account right now. Please try again in a minute.');
    }
    const r = (data ?? {}) as {
      ok?: boolean;
      error?: string;
      secured_at?: string;
      sessions_ended?: number;
      devices_revoked?: unknown[];
      email?: string | null;
      user_id?: string | null;
      email_hint?: string | null;
    };
    if (!r.ok) {
      if (r.error === 'used') {
        return fail(res, 409, 'used', 'This link was already used — your account was secured then. To change your password now, use “Forgot password”.', {
          securedAt: r.secured_at ?? null
        });
      }
      if (r.error === 'expired') {
        return fail(res, 410, 'expired', 'This link has expired. Sign in and use “Sign out everywhere”, or use “Forgot password”.');
      }
      return fail(res, 400, 'invalid_token', 'This link isn’t valid — open it straight from the email.');
    }

    const sessionsEnded = typeof r.sessions_ended === 'number' ? r.sessions_ended : null;
    const devicesRevoked = Array.isArray(r.devices_revoked) ? r.devices_revoked.length : 0;
    const email = readEmail(r.email);
    let resetEmail: 'sent' | 'throttled' | 'unavailable' | 'failed' = 'unavailable';
    if (email && (await emailReady())) {
      const limit = await checkThrottle(email);
      if (limit) {
        resetEmail = 'throttled';
      } else {
        const { origin, redirectTo } = linkTarget(req);
        const { data: link, error: linkError } = await admin.auth.admin.generateLink({ type: 'recovery', email, options: { redirectTo } });
        if (linkError) {
          console.error(`[auth-email] secure → ${maskEmail(email)}: generateLink failed (${(linkError as LinkError).status ?? '?'})`);
          resetEmail = 'failed';
        } else {
          const sent = await deliver(req, 'secure', { email, app: 'main', origin, props: link?.properties, userId: r.user_id ?? null });
          resetEmail = sent ? 'sent' : 'failed';
        }
      }
    }
    console.log(
      `[auth-email] secure: account secured${email ? ` (${maskEmail(email)})` : ''} — sessions ended: ${sessionsEnded ?? '?'}, devices revoked: ${devicesRevoked}, reset email: ${resetEmail}`
    );
    return res.json({
      ok: true,
      // -1: the database couldn't end the sessions — never claim it did.
      sessionsEnded: sessionsEnded != null && sessionsEnded >= 0 ? sessionsEnded : null,
      signedOutEverywhere: sessionsEnded != null && sessionsEnded >= 0,
      devicesRevoked,
      resetEmail,
      emailHint: r.email_hint ?? null
    });
  } catch (err) {
    next(err);
  }
});
