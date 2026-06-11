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
import { getSupabaseAdmin, getSupabaseCapabilityStatus } from '../services/supabase.js';
import { logger } from '../lib/logger.js';

export type AccountKeyProvider = 'openrouter' | 'nvidia' | 'gemini' | 'pixazo' | 'ideogram';

const CACHE_TTL_MS = 60_000;
const CACHE_MAX_USERS = 1000;

type CacheEntry = { at: number; keys: Partial<Record<AccountKeyProvider, string>> };
const cache = new Map<string, CacheEntry>();

/** Drop a user's cached keys (call after their stored keys change). */
export const invalidateAccountKeys = (userId: string): void => {
  cache.delete(userId);
};

/** Historic rows were written under 'flux'; they are the pixazo provider. */
const normalizeProvider = (provider: string): AccountKeyProvider | null => {
  const p = provider.trim().toLowerCase();
  if (p === 'flux') return 'pixazo';
  if (p === 'openrouter' || p === 'nvidia' || p === 'gemini' || p === 'pixazo' || p === 'ideogram') return p;
  return null;
};

const loadAccountKeys = async (userId: string): Promise<Partial<Record<AccountKeyProvider, string>>> => {
  const hit = cache.get(userId);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.keys;

  const keys: Partial<Record<AccountKeyProvider, string>> = {};
  try {
    const { data, error } = await getSupabaseAdmin()
      .from('user_api_keys')
      .select('provider, encrypted_key, iv')
      .eq('user_id', userId);
    if (!error) {
      for (const row of data || []) {
        const provider = normalizeProvider(String(row.provider || ''));
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

  if (cache.size >= CACHE_MAX_USERS) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(userId, { at: Date.now(), keys });
  return keys;
};

/**
 * Fill in provider keys from the user's account store wherever the request didn't
 * carry one. Mounted after `requireAuth`, so `req.user` is always present here.
 */
export const attachAccountKeys = async (req: Request, _res: Response, next: NextFunction) => {
  try {
    const userId = req.user?.id;
    if (!userId || !req.apiKeys || !isSecureStoreAvailable()) return next();
    if (!getSupabaseCapabilityStatus().storagePersistenceEnabled) return next();

    const k = req.apiKeys;
    const needsAny = !k.openRouterByok || !k.nvidiaByok || !k.geminiByok || !k.pixazoByok || !k.ideogramByok;
    if (!needsAny) return next();

    const account = await loadAccountKeys(userId);
    if (Object.keys(account).length === 0) return next();

    const allow = allowedProviderFilter(req);
    if (!k.openRouterByok && account.openrouter && allow('openrouter')) {
      k.openRouterKey = account.openrouter;
      k.openRouterByok = true;
    }
    if (!k.nvidiaByok && account.nvidia && allow('nvidia')) {
      k.nvidiaKey = account.nvidia;
      k.nvidiaByok = true;
    }
    if (!k.geminiByok && account.gemini && allow('gemini')) {
      k.geminiKey = account.gemini;
      k.geminiByok = true;
    }
    if (!k.pixazoByok && account.pixazo && allow('pixazo')) {
      k.pixazoKey = account.pixazo;
      k.pixazoByok = true;
    }
    if (!k.ideogramByok && account.ideogram && allow('ideogram')) {
      k.ideogramKey = account.ideogram;
      k.ideogramByok = true;
    }
    next();
  } catch (err) {
    // Account keys are an enhancement on top of header/env keys — never block a request.
    logger.warn('account_keys_attach_failed', { message: (err as Error)?.message });
    next();
  }
};
