import { supabase } from './supabase';
import { API_BASE_URL, buildApiUrl } from './clientConfig';

/**
 * Two intents share one table:
 *   - 'updates' — "stay in the loop" newsletter capture.
 *   - 'access'  — request early access while signups are invite-only.
 */
export type WaitlistKind = 'updates' | 'access';

/** Machine-readable outcome, set by the backend for 'access' signups. */
export type WaitlistStatus = 'joined' | 'already-registered' | 'account-exists' | 'already-invited';

/** Products a signup can ask for first access to (server-accepted values). */
export const PRODUCT_INTERESTS = ['comic_studio', 'chat_studio', 'code_studio', 'stream_studio', 'dashboards'] as const;
export type ProductInterest = (typeof PRODUCT_INTERESTS)[number];

const MAX_FEEDBACK_CHARS = 1000;

/** Optional intent captured with the signup — email alone always still submits. */
export interface WaitlistIntent {
  /** Which products the signup wants first access to. */
  productInterests?: ProductInterest[];
  /** Free-form "anything you'd want to see" note (≤1000 chars). */
  feedback?: string;
}

export interface WaitlistResult {
  ok: boolean;
  /** True when the email was already on the list — treated as a soft success. */
  alreadyJoined?: boolean;
  /**
   * 'account-exists' = the email already has an ACCOUNT; show a sign-in prompt instead.
   * 'already-invited' = the email holds a pending invite; the backend re-sent the invite
   * email — tell them to follow its instructions instead of joining the waitlist.
   */
  status?: WaitlistStatus;
  message: string;
}

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const DEFAULT_SUCCESS: Record<WaitlistKind, string> = {
  updates: "You're on the list — we'll keep you posted.",
  access: "Thanks! We'll email you the moment access opens up."
};

/**
 * Decide whether a backend /subscribe response is authoritative, and translate it into a
 * WaitlistResult. Returns null when the caller should fall back to the direct Supabase
 * insert (unexpected status / unparseable body). Pure + exported for unit tests.
 *
 *   - 2xx bodies are always authoritative — including ok:false outcomes like
 *     'account-exists' ("you already have an account — sign in"), which must NOT fall
 *     back to inserting a waitlist row for an existing member.
 *   - 400 validation errors are authoritative failures.
 */
export const interpretSubscribeResponse = (
  httpOk: boolean,
  httpStatus: number,
  data: Partial<WaitlistResult> | null
): WaitlistResult | null => {
  if (httpOk && data && typeof data.ok === 'boolean' && typeof data.message === 'string') {
    return { ok: data.ok, alreadyJoined: data.alreadyJoined, status: data.status, message: data.message };
  }
  // Validation errors (400) are authoritative — surface them rather than falling back.
  if (httpStatus === 400 && data?.message) return { ok: false, message: data.message };
  return null;
};

/**
 * When the backend is configured, route signups through it so we can send a confirmation
 * email (double opt-in for 'updates', thank-you for 'access') and dedupe against existing
 * accounts. Returns null on any failure so the caller falls back to the direct Supabase
 * insert below — capturing the lead must never fail.
 */
const subscribeViaApi = async (
  email: string,
  kind: WaitlistKind,
  metadata: Record<string, unknown>,
  captchaToken?: string,
  intent: WaitlistIntent = {}
): Promise<WaitlistResult | null> => {
  if (!API_BASE_URL) return null;
  try {
    const res = await fetch(buildApiUrl('/api/newsletter/subscribe'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        email,
        kind,
        captchaToken,
        source: typeof window !== 'undefined' ? window.location.pathname : undefined,
        ...(typeof metadata.source === 'string' ? { source: metadata.source } : {}),
        ...(intent.productInterests?.length ? { productInterests: intent.productInterests } : {}),
        ...(intent.feedback ? { feedback: intent.feedback } : {})
      })
    });
    const data = (await res.json().catch(() => null)) as Partial<WaitlistResult> | null;
    return interpretSubscribeResponse(res.ok, res.status, data);
  } catch {
    return null;
  }
};

/**
 * Add an email to the public waitlist. Never throws: callers get a friendly
 * { ok, message } back regardless of network / RLS / migration state so a
 * marketing form can render the outcome inline.
 */
export const submitWaitlistEmail = async (
  rawEmail: string,
  kind: WaitlistKind = 'updates',
  metadata: Record<string, unknown> = {},
  captchaToken?: string,
  intent: WaitlistIntent = {}
): Promise<WaitlistResult> => {
  const email = rawEmail.trim().toLowerCase();
  if (!email) {
    return { ok: false, message: 'Please enter your email address.' };
  }
  if (!EMAIL_REGEX.test(email) || email.length > 320) {
    return { ok: false, message: 'That email doesn’t look right — please check it.' };
  }

  // Both intent fields are optional — sanitize to the server contract.
  const productInterests = intent.productInterests
    ?.filter((p): p is ProductInterest => (PRODUCT_INTERESTS as readonly string[]).includes(p));
  const feedback = intent.feedback?.trim().slice(0, MAX_FEEDBACK_CHARS) || undefined;
  const cleanIntent: WaitlistIntent = {
    ...(productInterests?.length ? { productInterests } : {}),
    ...(feedback ? { feedback } : {})
  };

  // Preferred path: the backend (sends the confirmation email + logs the capture).
  const apiResult = await subscribeViaApi(email, kind, metadata, captchaToken, cleanIntent);
  if (apiResult) return apiResult;

  // Fallback: write directly to Supabase (no email, but the lead is still captured).
  try {
    // No .select() on purpose: RLS exposes write-only access, so asking for the
    // row back would fail. We only care whether the insert was accepted.
    const { error } = await supabase.from('waitlist_signups').insert({
      email,
      kind,
      source: typeof window !== 'undefined' ? window.location.pathname : null,
      metadata: { ...metadata, ...cleanIntent }
    });

    if (error) {
      const code = (error as { code?: string }).code;
      // 23505 = unique_violation → this email already joined for this intent.
      if (code === '23505' || /duplicate key|already exists/i.test(error.message || '')) {
        return {
          ok: true,
          alreadyJoined: true,
          message: "You're already on the list — sit tight, we'll be in touch."
        };
      }
      console.warn('[waitlist] signup failed', error);
      return { ok: false, message: 'Something went wrong on our end. Please try again shortly.' };
    }

    return { ok: true, message: DEFAULT_SUCCESS[kind] };
  } catch (err) {
    console.warn('[waitlist] signup error', err);
    return { ok: false, message: 'Network hiccup — please try again.' };
  }
};
