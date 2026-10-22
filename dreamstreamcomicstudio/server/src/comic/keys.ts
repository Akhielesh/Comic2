// Provider keys for Comic Studio (v4).
//
// The studio only ever talks to two upstreams: OpenRouter (preferred — the platform key
// in production, or the user's own) and Gemini direct. Keys are read from the request's
// already-resolved key map (middleware/keys.ts → attachKeys, then accountKeys.ts), so the
// `X-Allowed-Sources` governance header and the account BYOK store apply exactly as they
// do for every other route. Nothing here reads raw headers or env vars.

import type { Request } from 'express';
import { allowedProviderFilter } from '../middleware/keys.js';
import type { ResolvedKey, StudioKeys } from './types.js';

/** OpenRouter keys are recognisable by prefix; Gemini direct can never use one. */
const OPENROUTER_KEY_PREFIX = /^sk-or-/i;

const toResolved = (key: unknown, byok: unknown): ResolvedKey | undefined => {
  const trimmed = typeof key === 'string' ? key.trim() : '';
  return trimmed ? { key: trimmed, byok: byok === true } : undefined;
};

/**
 * The OpenRouter / Gemini keys this request may use. Generic `providerKeys` entries win;
 * the named legacy fields are the fallback for callers that ran before the generic map
 * existed. Providers without a non-empty key are omitted entirely.
 */
export function studioKeysFromRequest(req: Request): StudioKeys {
  const apiKeys = req.apiKeys;
  if (!apiKeys) return {};
  const providerKeys = apiKeys.providerKeys || {};

  let openrouter =
    toResolved(providerKeys.openrouter?.key, providerKeys.openrouter?.byok) ??
    toResolved(apiKeys.openRouterKey, apiKeys.openRouterByok);
  let gemini =
    toResolved(providerKeys.gemini?.key, providerKeys.gemini?.byok) ?? toResolved(apiKeys.geminiKey, apiKeys.geminiByok);

  // Users regularly paste an OpenRouter key into the Gemini slot (the legacy studio
  // accepted that). Gemini direct would reject it on every call, so treat it as the
  // OpenRouter key it is. Two guards keep that from undoing the user's intent:
  //  - governance: never promote to OpenRouter when `X-Allowed-Sources` turned it off
  //    (the key is simply dropped, so the studio shows its "connect a key" notice);
  //  - precedence: the user's own key (BYOK) beats a non-BYOK platform OpenRouter key,
  //    so it is not silently overridden (header > account > platform env).
  if (gemini && OPENROUTER_KEY_PREFIX.test(gemini.key)) {
    // Tests pass a bare fake request without header(); real requests always have one.
    const openRouterAllowed = typeof req.header !== 'function' || allowedProviderFilter(req)('openrouter');
    if (openRouterAllowed && (!openrouter || (gemini.byok && !openrouter.byok))) openrouter = gemini;
    gemini = undefined;
  }

  const keys: StudioKeys = {};
  if (openrouter) keys.openrouter = openrouter;
  if (gemini) keys.gemini = gemini;
  return keys;
}

/** True when at least one provider key is usable. */
export const hasAnyStudioKey = (keys: StudioKeys): boolean => Boolean(keys.openrouter || keys.gemini);

/**
 * The user's own Gemini key beats a non-BYOK platform OpenRouter key (precedence
 * header > account > platform env). Routing and billing helpers consult this so a BYOK
 * user is actually billed against — and served by — their own key: google/* work goes to
 * Gemini direct instead of the platform OpenRouter key, with OpenRouter-only models still
 * falling through to the platform route.
 */
export const prefersGeminiDirect = (keys: StudioKeys): boolean =>
  Boolean(keys.gemini?.key && keys.gemini.byok && !keys.openrouter?.byok);
