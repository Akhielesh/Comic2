// AI gateway façade.
//
// Routes call the gateway instead of a concrete provider so that the rest of the
// server never imports a vendor SDK directly. Today there is a single provider
// (OpenRouter); the `AI_PROVIDER` flag gates whether the unified path is active
// so the legacy Gemini/Pixazo path can keep serving traffic until cutover.

import { AI_PROVIDER, OPENROUTER_API_KEY } from '../config.js';
import { openRouterProvider } from './providers/openrouter.js';
import type { AIProvider, ProviderContext } from './providers/types.js';

/** True when the unified OpenRouter path should handle generation. */
export const isOpenRouterEnabled = (): boolean => AI_PROVIDER === 'openrouter';

/** The active provider. Single implementation today; the seam is intentional. */
export const getProvider = (): AIProvider => openRouterProvider;

/**
 * Resolve the provider context (key + BYOK flag) for a request.
 *
 * - A user-supplied OpenRouter key (BYOK) always wins and bypasses platform billing.
 * - Otherwise the platform key funds the call and the request is metered to credits.
 */
export const resolveProviderContext = (userKey?: string | null): ProviderContext => {
  const trimmed = (userKey || '').trim();
  if (trimmed) return { apiKey: trimmed, byok: true };
  return { apiKey: OPENROUTER_API_KEY, byok: false };
};
