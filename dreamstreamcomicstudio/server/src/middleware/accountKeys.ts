// Account-level BYOK key resolution.
//
// PROBLEM THIS SOLVES: the user's provider keys lived only in the browser that
// entered them. Every studio (chat, code, comics) and every device had to send the
// key as a request header, so a key added on one device/studio was invisible to the
// others — the server-encrypted `user_api_keys` mirror existed but was never read.
//
// This middleware makes the ACCOUNT the source of truth: for any authenticated
// request where a provider key was NOT supplied by a header, the user's stored key
// (encrypted at rest with the server-only secret, see lib/secureStore.ts) is
// decrypted and attached. Precedence per provider:
//
//   request header (this device's key)  >  account key (user_api_keys)  >  platform env
//
// `X-Allowed-Sources` governance still applies — a disabled provider stays disabled
// even if the account has a key for it. Results are cached briefly per user so this
// adds at most one small indexed SELECT per user per minute.

import { NextFunction, Request, Response } from 'express';
import { allowedProviderFilter } from './keys.js';
import { decryptSecret, isSecureStoreAvailable } from '../lib/secureStore.js';
import { TtlCache } from '../lib/cache.js';
import { getSupabaseAdmin, getSupabaseCapabilityStatus } from '../services/supabase.js';
import { logger } from '../lib/logger.js';
import {
  allowanceEnabled,
  getAllowanceStatus,
  getBillingPrefs,
  isPlatformFundedProvider
} from '../services/platformAllowance.js';
import { isTextProvider, TEXT_PROVIDER_IDS, type ProviderId } from '../../../shared/providers.js';

export type AccountKeyProvider = ProviderId | 'pixazo' | 'ideogram';

type AccountKeys = Partial<Record<AccountKeyProvider, string>>;

// 60s TTL, bounded; getOrSet coalesces concurrent loads for the same user.
const cache = new TtlCache<AccountKeys>(60_000, 1000);

/** Drop a user's cached keys (call after their stored keys change). */
export const invalidateAccountKeys = (userId: string): void => {
  cache.delete(userId);
};

/**
 * Canonical provider name for an account-key row or request. Historic rows were
 * written under 'flux'; they are the pixazo provider. Single source of truth —
 * the account routes import this too, so alias rules can never drift apart.
 */
export const canonicalAccountProvider = (provider: string): AccountKeyProvider | null => {
  const p = provider.trim().toLowerCase();
  if (p === 'flux') return 'pixazo';
  if (p === 'pixazo' || p === 'ideogram') return p;
  if (isTextProvider(p)) return p;
  return null;
};

const queryAccountKeys = async (userId: string): Promise<AccountKeys> => {
  const keys: AccountKeys = {};
  try {
    const { data, error } = await getSupabaseAdmin()
      .from('user_api_keys')
      .select('provider, encrypted_key, iv')
      .eq('user_id', userId);
    if (!error) {
      for (const row of data || []) {
        const provider = canonicalAccountProvider(String(row.provider || ''));
        if (!provider) continue;
        // An exact-name row wins over an alias row ('pixazo' over 'flux').
        if (keys[provider] && String(row.provider).toLowerCase() !== provider) continue;
        const secret = decryptSecret(String(row.encrypted_key || ''), String(row.iv || ''));
        if (secret) keys[provider] = secret;
      }
    }
  } catch (err) {
    logger.warn('account_keys_load_failed', { message: (err as Error)?.message });
  }
  return keys;
};

// How each provider maps onto the req.apiKeys fields attachKeys populates.
const PROVIDER_FIELDS: {
  provider: AccountKeyProvider;
  keyField: 'openRouterKey' | 'nvidiaKey' | 'geminiKey' | 'pixazoKey' | 'ideogramKey';
  byokField: 'openRouterByok' | 'nvidiaByok' | 'geminiByok' | 'pixazoByok' | 'ideogramByok';
}[] = [
  { provider: 'openrouter', keyField: 'openRouterKey', byokField: 'openRouterByok' },
  { provider: 'nvidia', keyField: 'nvidiaKey', byokField: 'nvidiaByok' },
  { provider: 'gemini', keyField: 'geminiKey', byokField: 'geminiByok' },
  { provider: 'pixazo', keyField: 'pixazoKey', byokField: 'pixazoByok' },
  { provider: 'ideogram', keyField: 'ideogramKey', byokField: 'ideogramByok' }
];

/**
 * Providers the user has a decryptable key for in the account store (cached 60s).
 * Presence metadata only — never returns the secrets.
 */
export const accountKeyProviders = async (userId: string): Promise<AccountKeyProvider[]> => {
  try {
    if (!isSecureStoreAvailable() || !getSupabaseCapabilityStatus().storagePersistenceEnabled) return [];
    const account = await cache.getOrSet(userId, () => queryAccountKeys(userId));
    return Object.keys(account) as AccountKeyProvider[];
  } catch {
    return [];
  }
};

/** Whether the user has a stored account key for `provider` (alias-aware). */
export const hasAccountKeyFor = async (userId: string, provider: string): Promise<boolean> => {
  const canonical = canonicalAccountProvider(provider);
  if (!canonical) return false;
  return (await accountKeyProviders(userId)).includes(canonical);
};

/**
 * Fill in provider keys from the user's account store wherever the request didn't
 * carry one. Mounted after `requireAuth`, so `req.user` is always present here.
 */
export const attachAccountKeys = async (req: Request, _res: Response, next: NextFunction) => {
  try {
    const userId = req.user?.id;
    const k = req.apiKeys;
    if (!userId || !k || !isSecureStoreAvailable()) return next();
    if (!getSupabaseCapabilityStatus().storagePersistenceEnabled) return next();
    // Skip the account lookup only when EVERY provider already carries a header BYOK key.
    const allHeaderByok =
      PROVIDER_FIELDS.every(({ byokField }) => k[byokField]) &&
      TEXT_PROVIDER_IDS.every((id) => k.providerKeys?.[id]?.byok);
    if (allHeaderByok) return next();

    const account = await cache.getOrSet(userId, () => queryAccountKeys(userId));
    if (Object.keys(account).length === 0) return next();

    const allow = allowedProviderFilter(req);

    // Platform-allowance master toggle (services/platformAllowance.ts): while the user
    // opts to run on the DreamStream allowance and it is NOT exhausted, platform-funded
    // providers stay on the PLATFORM key even though an account key exists — that is
    // the point of the allowance. Once exhausted, the account key is injected only in
    // 'auto' fallback mode; in 'ask'/'never' the platform key is kept so the usage
    // enforcer blocks with a clear, actionable reason instead of silently spending the
    // user's key. Per-provider it only applies where a platform key actually exists
    // (k[keyField] already set from env by attachKeys) — without one, the account key
    // remains the only way to serve the request at all. Header BYOK keys are an
    // explicit per-request choice and keep their precedence untouched.
    let suppressPlatformFunded = false;
    if (allowanceEnabled()) {
      const wouldInjectPlatformFunded = PROVIDER_FIELDS.some(
        ({ provider, keyField, byokField }) =>
          !k[byokField] && Boolean(account[provider]) && Boolean(k[keyField]) && isPlatformFundedProvider(provider)
      );
      if (wouldInjectPlatformFunded) {
        const prefs = await getBillingPrefs(userId);
        if (prefs.usePlatformAllowance) {
          const status = await getAllowanceStatus(userId);
          if (status.enabled) {
            suppressPlatformFunded = !status.exhausted || prefs.byokFallbackMode !== 'auto';
          }
        }
      }
    }

    for (const { provider, keyField, byokField } of PROVIDER_FIELDS) {
      if (k[byokField] || !account[provider] || !allow(provider)) continue;
      if (suppressPlatformFunded && isPlatformFundedProvider(provider) && k[keyField]) continue;
      k[keyField] = account[provider];
      k[byokField] = true;
    }

    // Direct providers without a named field (openai/anthropic/deepseek/zai/minimax/
    // tencent/xai): inject the account key straight into the generic provider map. These
    // are BYOK-only (not platform-funded), so the allowance suppression above never applies.
    const named = new Set(PROVIDER_FIELDS.map((f) => f.provider as string));
    if (!k.providerKeys) k.providerKeys = {};
    for (const id of TEXT_PROVIDER_IDS) {
      if (named.has(id)) continue;
      if (k.providerKeys[id]?.byok || !account[id] || !allow(id)) continue;
      k.providerKeys[id] = { key: account[id]!, byok: true };
    }
    // Mirror the (possibly just-injected) named keys back into the generic map so every
    // provider can be read uniformly from req.apiKeys.providerKeys.
    k.providerKeys.openrouter = { key: k.openRouterKey ?? null, byok: Boolean(k.openRouterByok) };
    k.providerKeys.nvidia = { key: k.nvidiaKey ?? null, byok: Boolean(k.nvidiaByok) };
    k.providerKeys.gemini = { key: k.geminiKey ?? null, byok: Boolean(k.geminiByok) };
    next();
  } catch (err) {
    // Account keys are an enhancement on top of header/env keys — never block a request.
    logger.warn('account_keys_attach_failed', { message: (err as Error)?.message });
    next();
  }
};
