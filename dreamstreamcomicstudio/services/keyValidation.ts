// Client wrapper for POST /api/keys/validate.
//
// Sends a candidate key in its provider header (the same header apiClient uses) so we can
// live-check ANY key — including one being typed or one that isn't the active key — and get
// back a valid / invalid / unsupported verdict for the API Configuration badges.

import { buildApiUrl } from './clientConfig';
import { PROVIDER_META, type ApiKeyProvider } from './apiKeys';

export type KeyValidationStatus = 'valid' | 'invalid' | 'unsupported' | 'missing';

export interface KeyValidationResult {
  provider: string;
  status: KeyValidationStatus;
  valid: boolean;
  message: string;
  detail?: Record<string, unknown>;
}

export const validateApiKey = async (
  provider: ApiKeyProvider,
  keyValue: string
): Promise<KeyValidationResult> => {
  const header = PROVIDER_META[provider].header;
  try {
    const res = await fetch(buildApiUrl('/api/keys/validate'), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        [header]: keyValue
      },
      body: JSON.stringify({ provider })
    });
    if (!res.ok) {
      return { provider, status: 'invalid', valid: false, message: `Validation failed (HTTP ${res.status}).` };
    }
    return (await res.json()) as KeyValidationResult;
  } catch (err) {
    return {
      provider,
      status: 'invalid',
      valid: false,
      message: `Could not validate: ${(err as Error)?.message || 'network error'}.`
    };
  }
};
