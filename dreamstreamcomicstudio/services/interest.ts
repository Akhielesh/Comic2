// Register interest in DreamStream studios: the browser side of POST /api/interest
// (server/src/routes/interest.ts). The studio list is the shared one in services/studioInterests.ts.
//
// No direct-to-database fallback, on purpose: a registration only counts once the person has
// confirmed their address (double opt-in), and only the backend can send that email and apply
// the bot check and per-address limits. A failure is reported honestly instead.

import { buildApiUrl } from './clientConfig';
import { sanitizeStudioInterests, type StudioInterestId } from './studioInterests';

/**
 * The only success there is: "check your inbox". The backend answers every valid request the same
 * way, whatever the address's state, so the page can't tell (and never shows) whether an address
 * was already subscribed: anyone can type anyone's address.
 */
export type InterestStatus = 'pending';

export type InterestErrorCode =
  | 'invalid_email'
  | 'invalid_studios'
  | 'captcha_required'
  | 'captcha_failed'
  | 'email_unavailable'
  | 'try_again'
  | 'interest_unavailable'
  | 'rate_limited'
  | 'network';

export interface InterestResult {
  ok: boolean;
  status?: InterestStatus;
  code?: InterestErrorCode;
  message: string;
  /** The studios this request asked about (the backend never echoes stored picks). */
  studios?: StudioInterestId[];
}

export interface RegisterInterestInput {
  email: string;
  studios: readonly string[];
  /** Which surface the form sits on (stored with the registration). */
  source?: string;
  captchaToken?: string;
}

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const KNOWN_CODES = new Set<InterestErrorCode>([
  'invalid_email',
  'invalid_studios',
  'captcha_required',
  'captcha_failed',
  'email_unavailable',
  'try_again',
  'interest_unavailable'
]);

const GENERIC_FAILURE = 'Something went wrong on our end. Please try again in a minute.';

/**
 * Translate an /api/interest answer into an InterestResult. Pure, exported for tests.
 * Unknown shapes become a generic failure (never a fake success).
 */
export const interpretInterestResponse = (httpStatus: number, data: unknown): InterestResult => {
  const body = (data && typeof data === 'object' ? data : {}) as Record<string, unknown>;
  const message = typeof body.message === 'string' && body.message ? body.message : '';
  if (httpStatus >= 200 && httpStatus < 300 && body.ok === true && body.status === 'pending') {
    return {
      ok: true,
      status: 'pending',
      message: message || 'Check your inbox and click the link to confirm.',
      studios: sanitizeStudioInterests(body.studios)
    };
  }
  const code = typeof body.code === 'string' && KNOWN_CODES.has(body.code as InterestErrorCode) ? (body.code as InterestErrorCode) : undefined;
  if (code) return { ok: false, code, message: message || GENERIC_FAILURE };
  // The per-IP limiter's own 429 ({ error: { code: 'RATE_LIMITED' } }).
  if (httpStatus === 429) {
    return { ok: false, code: 'rate_limited', message: 'Too many attempts from this connection. Please wait a few minutes and try again.' };
  }
  return { ok: false, message: GENERIC_FAILURE };
};

/** Register interest. Never throws: the form renders whatever comes back. */
export const registerInterest = async (input: RegisterInterestInput): Promise<InterestResult> => {
  const email = input.email.trim().toLowerCase();
  if (!email) return { ok: false, code: 'invalid_email', message: 'Please enter your email address.' };
  if (email.length > 320 || !EMAIL_REGEX.test(email)) {
    return { ok: false, code: 'invalid_email', message: 'That email doesn’t look right. Please check it.' };
  }
  const studios = sanitizeStudioInterests(input.studios);
  if (studios.length === 0) return { ok: false, code: 'invalid_studios', message: 'Pick at least one studio.' };

  try {
    const res = await fetch(buildApiUrl('/api/interest'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        email,
        studios,
        ...(input.source ? { source: input.source } : {}),
        ...(input.captchaToken ? { captchaToken: input.captchaToken } : {})
      })
    });
    const data = await res.json().catch(() => null);
    return interpretInterestResponse(res.status, data);
  } catch {
    return { ok: false, code: 'network', message: 'Network hiccup. Please check your connection and try again.' };
  }
};

// ── "This deployment can't take registrations" memory ───────────────────────────
// After a 503 interest_unavailable the form hides itself for the rest of the browser session
// (no probe on page load: that would wake the sleeping backend for every visitor).

const UNAVAILABLE_KEY = 'ds.interest.unavailable';

export const rememberInterestUnavailable = (): void => {
  try {
    sessionStorage.setItem(UNAVAILABLE_KEY, '1');
  } catch {
    /* storage blocked: the form just shows again next time */
  }
};

export const interestKnownUnavailable = (): boolean => {
  try {
    return sessionStorage.getItem(UNAVAILABLE_KEY) === '1';
  } catch {
    return false;
  }
};

// ── Landing from the confirm / unsubscribe email links ──────────────────────────
// /api/newsletter/{confirm,unsubscribe} redirect to the app with ?newsletter=<outcome>.

export type NewsletterLanding = 'confirmed' | 'invalid' | 'unsubscribed' | 'unsub-invalid';

const LANDINGS = new Set<NewsletterLanding>(['confirmed', 'invalid', 'unsubscribed', 'unsub-invalid']);

/** The ?newsletter= outcome on this page, if any (read only: safe in a render/useState initializer). */
export const readNewsletterLanding = (): NewsletterLanding | null => {
  if (typeof window === 'undefined') return null;
  try {
    const value = new URLSearchParams(window.location.search).get('newsletter');
    return value && LANDINGS.has(value as NewsletterLanding) ? (value as NewsletterLanding) : null;
  } catch {
    return null;
  }
};

/** Drop ?newsletter= from the address bar (so a reload or a shared link doesn't repeat it). */
export const clearNewsletterLanding = (): void => {
  if (typeof window === 'undefined') return;
  try {
    const url = new URL(window.location.href);
    if (!url.searchParams.has('newsletter')) return;
    url.searchParams.delete('newsletter');
    window.history.replaceState(window.history.state, '', url);
  } catch {
    /* history unavailable: harmless */
  }
};
