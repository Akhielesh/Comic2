// Client wrapper for POST /api/keys/validate.
//
// Sends a candidate key in its provider header (the same header apiClient uses) so we can
// live-check ANY key — including one being typed or one that isn't the active key — and get
// back a valid / invalid / unsupported verdict for the API Configuration badges.
//
// Exactly one key travels per call — the one being checked, in its header (never in the body
// or URL) — plus the session token: the route is signed-in only.
//
// Only a 200 answer from the route carries a verdict on the key. When the route itself can't
// answer (expired session → 401, rate limit → 429, 5xx, offline) the result is `unavailable`:
// a "couldn't check" state the UI shows WITHOUT storing it as the key's verdict, so a passing
// failure never marks a good key Invalid.

import { buildApiUrl } from './clientConfig';
import { PROVIDER_META, type ApiKeyProvider } from './apiKeys';
import { supabase } from './supabase';
import { allowedSourcesHeader } from './sourceGovernance';

export type KeyValidationStatus = 'valid' | 'invalid' | 'unsupported' | 'missing' | 'unavailable';

/** Copy for a check that could not run (never a verdict on the key). */
export const KEY_CHECK_UNAVAILABLE_COPY = 'Couldn’t check this key right now — try Verify.';
export const KEY_CHECK_SIGNED_OUT_COPY = 'Sign in again to check this key.';

export interface KeyValidationResult {
  provider: string;
  status: KeyValidationStatus;
  valid: boolean;
  message: string;
}

export const validateApiKey = async (
  provider: ApiKeyProvider,
  keyValue?: string
): Promise<KeyValidationResult> => {
  const header = PROVIDER_META[provider].header;
  try {
    const token = (await supabase.auth.getSession()).data.session?.access_token;
    const res = await fetch(buildApiUrl('/api/keys/validate'), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        'X-Allowed-Sources': allowedSourcesHeader(),
        ...(keyValue?.trim() ? { [header]: keyValue.trim() } : {})
      },
      body: JSON.stringify({ provider })
    });
    if (!res.ok) {
      return {
        provider,
        status: 'unavailable',
        valid: false,
        message: res.status === 401 ? KEY_CHECK_SIGNED_OUT_COPY : KEY_CHECK_UNAVAILABLE_COPY
      };
    }
    return (await res.json()) as KeyValidationResult;
  } catch {
    return { provider, status: 'unavailable', valid: false, message: KEY_CHECK_UNAVAILABLE_COPY };
  }
};
