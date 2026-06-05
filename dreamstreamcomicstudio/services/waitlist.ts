import { supabase } from './supabase';

/**
 * Two intents share one table:
 *   - 'updates' — "stay in the loop" newsletter capture.
 *   - 'access'  — request early access while signups are invite-only.
 */
export type WaitlistKind = 'updates' | 'access';

export interface WaitlistResult {
  ok: boolean;
  /** True when the email was already on the list — treated as a soft success. */
  alreadyJoined?: boolean;
  message: string;
}

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const DEFAULT_SUCCESS: Record<WaitlistKind, string> = {
  updates: "You're on the list — we'll keep you posted.",
  access: "Thanks! We'll email you the moment access opens up."
};

/**
 * Add an email to the public waitlist. Never throws: callers get a friendly
 * { ok, message } back regardless of network / RLS / migration state so a
 * marketing form can render the outcome inline.
 */
export const submitWaitlistEmail = async (
  rawEmail: string,
  kind: WaitlistKind = 'updates',
  metadata: Record<string, unknown> = {}
): Promise<WaitlistResult> => {
  const email = rawEmail.trim().toLowerCase();
  if (!email) {
    return { ok: false, message: 'Please enter your email address.' };
  }
  if (!EMAIL_REGEX.test(email) || email.length > 320) {
    return { ok: false, message: 'That email doesn’t look right — please check it.' };
  }

  try {
    // No .select() on purpose: RLS exposes write-only access, so asking for the
    // row back would fail. We only care whether the insert was accepted.
    const { error } = await supabase.from('waitlist_signups').insert({
      email,
      kind,
      source: typeof window !== 'undefined' ? window.location.pathname : null,
      metadata
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
