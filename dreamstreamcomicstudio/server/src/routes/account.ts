import { Router } from 'express';
import { getSupabaseAdmin, getSupabaseCapabilityStatus } from '../services/supabase.js';
import { encryptSecret, isSecureStoreAvailable } from '../lib/secureStore.js';
import { logger } from '../lib/logger.js';

// Authenticated account endpoints. Mounted under /api/account after requireAuth.
export const accountRouter = Router();

const PROVIDERS = new Set(['openrouter', 'nvidia', 'gemini', 'flux', 'pixazo', 'ideogram']);

// Store a BYOK provider key, encrypted server-side with a server-only secret.
// Replaces the old client-side encrypt + direct upsert (whose secret was in the bundle).
accountRouter.post('/byok', async (req, res, next) => {
  try {
    if (!req.user?.id) return res.status(401).json({ error: { message: 'User not authenticated' } });
    const provider = String(req.body?.provider || '').trim().toLowerCase();
    const key = typeof req.body?.key === 'string' ? req.body.key.trim() : '';
    if (!PROVIDERS.has(provider)) return res.status(400).json({ error: { message: 'Unknown provider' } });
    if (!key || key.length > 500) return res.status(400).json({ error: { message: 'A valid key is required' } });

    if (!getSupabaseCapabilityStatus().storagePersistenceEnabled || !isSecureStoreAvailable()) {
      return res.json({ ok: false, persisted: false, reason: 'storage_disabled' });
    }

    const enc = encryptSecret(key);
    if (!enc) return res.json({ ok: false, persisted: false, reason: 'encrypt_unavailable' });

    const { error } = await getSupabaseAdmin().from('user_api_keys').upsert(
      { user_id: req.user.id, provider, encrypted_key: enc.ciphertext, iv: enc.iv },
      { onConflict: 'user_id,provider' }
    );
    if (error) {
      logger.warn('byok_store_failed', { provider, message: error.message });
      return res.json({ ok: false, persisted: false });
    }
    res.json({ ok: true, persisted: true });
  } catch (err) {
    next(err);
  }
});

accountRouter.delete('/byok/:provider', async (req, res, next) => {
  try {
    if (!req.user?.id) return res.status(401).json({ error: { message: 'User not authenticated' } });
    const provider = String(req.params.provider || '').trim().toLowerCase();
    if (getSupabaseCapabilityStatus().storagePersistenceEnabled) {
      await getSupabaseAdmin().from('user_api_keys').delete().eq('user_id', req.user.id).eq('provider', provider);
    }
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});
