// AI gateway façade + provider registry.
//
// Routes call the gateway instead of a concrete provider so that the rest of the
// server never imports a vendor SDK directly. OpenRouter is the first provider;
// the `PROVIDERS` registry below is the single place to add more — each new
// provider is a drop-in `AIProvider`, so adding another BYOK source later does
// not touch any route code.

import { AI_PROVIDER, OPENROUTER_API_KEY, NVIDIA_API_KEY } from '../config.js';
import { openRouterProvider } from './providers/openrouter.js';
import { nvidiaProvider } from './providers/nvidia.js';
import type { AIProvider, ProviderContext } from './providers/types.js';

/** Registry of available providers, keyed by id. Add new providers here. */
const PROVIDERS: Record<string, AIProvider> = {
  openrouter: openRouterProvider,
  nvidia: nvidiaProvider
};

/** Platform (non-BYOK) key for a provider, used when the user hasn't supplied their own. */
const platformKeyFor = (providerId?: string): string =>
  providerId === 'nvidia' ? NVIDIA_API_KEY : OPENROUTER_API_KEY;

/** The provider id the platform runs by default (from AI_PROVIDER, fallback openrouter). */
export const defaultProviderId = (): string =>
  PROVIDERS[AI_PROVIDER] ? AI_PROVIDER : 'openrouter';

/** True when the unified OpenRouter path should handle the default generation flow. */
export const isOpenRouterEnabled = (): boolean => AI_PROVIDER === 'openrouter';

/**
 * Resolve a provider implementation.
 *
 * - Pass an explicit id to target a specific provider (e.g. a route that is
 *   OpenRouter-only regardless of the AI_PROVIDER flag).
 * - Omit the id to use the platform's active provider.
 */
export const getProvider = (id?: string): AIProvider =>
  PROVIDERS[(id || defaultProviderId()).toLowerCase()] || openRouterProvider;

/**
 * Resolve the provider context (key + BYOK flag) for a request.
 *
 * - A user-supplied OpenRouter key (BYOK) always wins and bypasses platform billing.
 * - Otherwise the platform key funds the call and the request is metered to credits.
 */
export const resolveProviderContext = (userKey?: string | null, providerId?: string): ProviderContext => {
  const trimmed = (userKey || '').trim();
  if (trimmed) return { apiKey: trimmed, byok: true };
  return { apiKey: platformKeyFor(providerId), byok: false };
};
