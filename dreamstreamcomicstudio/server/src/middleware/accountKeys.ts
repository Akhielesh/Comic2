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

export type AccountKeyProvider = 'openrouter' | 'nvidia' | 'gemini' | 'pixazo' | 'ideogram';

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
  if (p === 'openrouter' || p === 'nvidia' || p === 'gemini' || p === 'pixazo' || p === 'ideogram') return p;
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
 * Fill in provider keys from the user's account store wherever the request didn't
 * carry one. Mounted after `requireAuth`, so `req.user` is always present here.
 */
export const attachAccountKeys = async (req: Request, _res: Response, next: NextFunction) => {
  try {
    const userId = req.user?.id;
    const k = req.apiKeys;
    if (!userId || !k || !isSecureStoreAvailable()) return next();
    if (!getSupabaseCapabilityStatus().storagePersistenceEnabled) return next();
    if (PROVIDER_FIELDS.every(({ byokField }) => k[byokField])) return next();

    const account = await cache.getOrSet(userId, () => queryAccountKeys(userId));
    if (Object.keys(account).length === 0) return next();

    const allow = allowedProviderFilter(req);
    for (const { provider, keyField, byokField } of PROVIDER_FIELDS) {
      if (k[byokField] || !account[provider] || !allow(provider)) continue;
      k[keyField] = account[provider];
      k[byokField] = true;
    }
    next();
  } catch (err) {
    // Account keys are an enhancement on top of header/env keys — never block a request.
    logger.warn('account_keys_attach_failed', { message: (err as Error)?.message });
    next();
  }
};
