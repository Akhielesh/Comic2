import { supabase } from './supabase';
import { API_BASE_URL, buildApiUrl, turnstileEnabled } from './clientConfig';
import {
  INTEREST_LIMITS,
  INTEREST_THANKS,
  cleanBlock,
  cleanLine,
  interestMetadata,
  knownFeatures,
  knownStudios,
  type InterestAnswers
} from '../shared/interest';

export { INTEREST_COUNT_FROM, INTEREST_FEATURES, INTEREST_LIMITS, INTEREST_STUDIOS } from '../shared/interest';
export type { InterestFeature, InterestStudio } from '../shared/interest';

/**
 * Two intents share one table:
 *   - 'updates' — "keep me posted" product updates.
 *   - 'access'  — register interest while sign-up is closed.
 * Neither sends an email today (the server holds them behind INTEREST_EMAILS).
 */
export type WaitlistKind = 'updates' | 'access';

/** Machine-readable outcome. 'registered' is the one answer for every valid address. */
export type WaitlistStatus = 'registered' | 'invalid' | 'verify' | 'unavailable' | 'rate-limited';

/** Optional answers sent with the email (shared/interest.ts). The email alone always submits. */
export type WaitlistAnswers = InterestAnswers;

export interface WaitlistResult {
  ok: boolean;
  status?: WaitlistStatus;
  message: string;
}

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
/** How long the form waits for the server before saving the row directly. */
export const SUBSCRIBE_DEADLINE_MS = 8000;

/** The one success answer per kind, whichever path saved the row. Promises no email. */
export const NEUTRAL_SUCCESS: Record<WaitlistKind, string> = INTEREST_THANKS;
const UNAVAILABLE = 'We could not save that just now. Please try again in a moment.';
const RATE_LIMITED = 'Too many tries from this connection. Please wait a few minutes and try again.';

/**
 * Translate a /subscribe response. Returns null when the caller should save the row
 * directly instead (no usable answer, a server error, or a bot-check refusal on a page
 * that shows no check). Pure + exported for unit tests.
 */
export const interpretSubscribeResponse = (
  httpOk: boolean,
  httpStatus: number,
  data: Partial<WaitlistResult> | null,
  kind: WaitlistKind = 'access',
  pageHasCheck: boolean = turnstileEnabled()
): WaitlistResult | null => {
  if (httpOk && data && data.ok === true) return { ok: true, status: 'registered', message: NEUTRAL_SUCCESS[kind] };
  if (httpStatus === 429) return { ok: false, status: 'rate-limited', message: RATE_LIMITED };
  if (httpStatus === 400 && data?.status === 'verify') {
    // With no check on the page the person cannot pass one; save the row directly.
    return pageHasCheck ? { ok: false, status: 'verify', message: data.message || 'Please complete the check and try again.' } : null;
  }
  if (httpStatus === 400 && typeof data?.message === 'string') return { ok: false, status: 'invalid', message: data.message };
  return null;
};

/**
 * Clean the answers the way the server does (shared/interest.ts), and cut rather than refuse: the form's
 * own maxLength already holds each field to its limit. Empty answers are left out.
 */
export const cleanAnswers = (answers: WaitlistAnswers = {}): WaitlistAnswers => {
  const text = (v: string | undefined, max: number, clean: (s: string) => string) => clean(v ?? '').slice(0, max).trim() || undefined;
  const firstName = text(answers.firstName, INTEREST_LIMITS.firstNameMax, cleanLine);
  const features = knownFeatures(answers.features ?? []);
  const featureOther = text(answers.featureOther, INTEREST_LIMITS.otherMax, cleanLine);
  const studios = knownStudios(answers.studios ?? []);
  const comment = text(answers.comment, INTEREST_LIMITS.commentMax, cleanBlock);
  return {
    ...(firstName ? { firstName } : {}),
    ...(features.length ? { features } : {}),
    ...(featureOther ? { featureOther } : {}),
    ...(studios.length ? { studios } : {}),
    ...(comment ? { comment } : {})
  };
};

const subscribeViaApi = async (
  email: string,
  kind: WaitlistKind,
  source: string | undefined,
  captchaToken: string | undefined,
  answers: WaitlistAnswers
): Promise<WaitlistResult | null> => {
  if (!API_BASE_URL) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SUBSCRIBE_DEADLINE_MS);
  try {
    const res = await fetch(buildApiUrl('/api/newsletter/subscribe'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({ email, kind, captchaToken, ...(source ? { source } : {}), ...answers })
    });
    const data = (await res.json().catch(() => null)) as Partial<WaitlistResult> | null;
    return interpretSubscribeResponse(res.ok, res.status, data, kind);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
};

/**
 * Register an email (and the optional answers). Never throws: callers get { ok, message }
 * whatever the network or database does, and every saved address gets the same answer.
 */
export const submitWaitlistEmail = async (
  rawEmail: string,
  kind: WaitlistKind = 'updates',
  metadata: Record<string, unknown> = {},
  captchaToken?: string,
  answers: WaitlistAnswers = {}
): Promise<WaitlistResult> => {
  const email = rawEmail.trim().toLowerCase();
  if (!email) return { ok: false, status: 'invalid', message: 'Please enter your email address.' };
  if (!EMAIL_REGEX.test(email) || email.length > 320) {
    return { ok: false, status: 'invalid', message: 'That email does not look right. Please check it.' };
  }
  const clean = cleanAnswers(answers);
  const rawSource =
    typeof metadata.source === 'string' ? metadata.source : typeof window !== 'undefined' ? window.location.pathname : '';
  const source = cleanLine(rawSource).slice(0, INTEREST_LIMITS.sourceMax) || undefined;

  const apiResult = await subscribeViaApi(email, kind, source, captchaToken, clean);
  if (apiResult) return apiResult;

  // Fallback: save the row directly (insert-only; RLS allows nothing else). Sends no email.
  try {
    const { error } = await supabase.from('waitlist_signups').insert({
      email,
      kind,
      source: source ?? null,
      metadata: interestMetadata(source, clean)
    });
    if (error) {
      const code = (error as { code?: string }).code;
      // 23505: already on the list for this kind. Same answer as a new address.
      if (code === '23505' || /duplicate key|already exists/i.test(error.message || '')) {
        return { ok: true, status: 'registered', message: NEUTRAL_SUCCESS[kind] };
      }
      console.warn('[waitlist] save failed', (error as { code?: string }).code ?? 'unknown');
      return { ok: false, status: 'unavailable', message: UNAVAILABLE };
    }
    return { ok: true, status: 'registered', message: NEUTRAL_SUCCESS[kind] };
  } catch {
    return { ok: false, status: 'unavailable', message: UNAVAILABLE };
  }
};
