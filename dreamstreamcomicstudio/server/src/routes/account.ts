import { Router } from 'express';
import { getSupabaseAdmin, getSupabaseCapabilityStatus } from '../services/supabase.js';
import { decryptLegacyClientBlob, decryptSecret, encryptSecret, isSecureStoreAvailable } from '../lib/secureStore.js';
import { canonicalAccountProvider, invalidateAccountKeys } from '../middleware/accountKeys.js';
import { isByokFallbackMode, setBillingPrefs, type BillingPrefs } from '../services/platformAllowance.js';
import { logger } from '../lib/logger.js';
import { cleanName, NAME_MAX, splitName } from '../../../shared/accountName.js';

// Authenticated account endpoints. Mounted under /api/account after requireAuth.
export const accountRouter = Router();

const storageReady = (): boolean =>
  getSupabaseCapabilityStatus().storagePersistenceEnabled && isSecureStoreAvailable();

// Store a BYOK provider key, encrypted server-side with a server-only secret.
// Replaces the old client-side encrypt + direct upsert (whose secret was in the bundle).
accountRouter.post('/byok', async (req, res, next) => {
  try {
    if (!req.user?.id) return res.status(401).json({ error: { message: 'User not authenticated' } });
    const provider = canonicalAccountProvider(String(req.body?.provider || ''));
    const key = typeof req.body?.key === 'string' ? req.body.key.trim() : '';
    if (!provider) return res.status(400).json({ error: { message: 'Unknown provider' } });
    if (!key || key.length > 500) return res.status(400).json({ error: { message: 'A valid key is required' } });

    if (!storageReady()) {
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
    // Retire any legacy alias row so the fallback never resolves a stale secret —
    // the write above always lands on the canonical 'pixazo' row, so a leftover
    // 'flux' row can only ever be stale.
    if (provider === 'pixazo') {
      await getSupabaseAdmin().from('user_api_keys').delete().eq('user_id', req.user.id).eq('provider', 'flux');
    }
    invalidateAccountKeys(req.user.id);
    res.json({ ok: true, persisted: true });
  } catch (err) {
    next(err);
  }
});

accountRouter.delete('/byok/:provider', async (req, res, next) => {
  try {
    if (!req.user?.id) return res.status(401).json({ error: { message: 'User not authenticated' } });
    const provider = canonicalAccountProvider(String(req.params.provider || ''));
    if (!provider) return res.json({ ok: true });
    if (getSupabaseCapabilityStatus().storagePersistenceEnabled) {
      const providers = provider === 'pixazo' ? ['pixazo', 'flux'] : [provider];
      await getSupabaseAdmin().from('user_api_keys').delete().eq('user_id', req.user.id).in('provider', providers);
      invalidateAccountKeys(req.user.id);
    }
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// What providers have a key on the account — metadata only (suffix for display),
// never the secret. Lets every studio/device show "key on file" without holding
// the key locally; the actual secret is attached server-side per request
// (middleware/accountKeys.ts).
accountRouter.get('/byok', async (req, res, next) => {
  try {
    if (!req.user?.id) return res.status(401).json({ error: { message: 'User not authenticated' } });
    if (!storageReady()) return res.json({ ok: true, keys: [] });

    const { data, error } = await getSupabaseAdmin()
      .from('user_api_keys')
      .select('provider, encrypted_key, iv')
      .eq('user_id', req.user.id);
    if (error) {
      logger.warn('byok_list_failed', { message: error.message });
      return res.json({ ok: true, keys: [] });
    }

    const byProvider = new Map<string, { provider: string; suffix: string }>();
    for (const row of data || []) {
      const provider = canonicalAccountProvider(String(row.provider || ''));
      if (!provider) continue;
      if (byProvider.has(provider) && String(row.provider).toLowerCase() !== provider) continue;
      const secret = decryptSecret(String(row.encrypted_key || ''), String(row.iv || ''));
      if (!secret) continue;
      byProvider.set(provider, { provider, suffix: secret.slice(-4) });
    }
    res.json({ ok: true, keys: [...byProvider.values()] });
  } catch (err) {
    next(err);
  }
});

// ---- Platform-allowance billing preferences --------------------------------------
//
// PATCH /api/account/billing-prefs { usePlatformAllowance?, byokFallbackMode? }
// The master toggle ("run on the DreamStream allowance vs my own keys") and the
// exhausted-allowance fallback behavior. Read back via GET /api/usage/allowance.

accountRouter.patch('/billing-prefs', async (req, res, next) => {
  try {
    if (!req.user?.id) return res.status(401).json({ error: { message: 'User not authenticated' } });

    const body = (req.body || {}) as Record<string, unknown>;
    const patch: Partial<BillingPrefs> = {};
    if (body.usePlatformAllowance !== undefined) {
      if (typeof body.usePlatformAllowance !== 'boolean') {
        return res.status(400).json({ error: { message: 'usePlatformAllowance must be a boolean' } });
      }
      patch.usePlatformAllowance = body.usePlatformAllowance;
    }
    if (body.byokFallbackMode !== undefined) {
      if (!isByokFallbackMode(body.byokFallbackMode)) {
        return res.status(400).json({ error: { message: "byokFallbackMode must be 'ask', 'auto' or 'never'" } });
      }
      patch.byokFallbackMode = body.byokFallbackMode;
    }
    if (Object.keys(patch).length === 0) {
      return res.status(400).json({ error: { message: 'Provide usePlatformAllowance and/or byokFallbackMode' } });
    }

    if (!getSupabaseCapabilityStatus().storagePersistenceEnabled) {
      return res.json({ ok: false, persisted: false, reason: 'storage_disabled' });
    }

    const prefs = await setBillingPrefs(req.user.id, patch);
    res.json({ ok: true, prefs });
  } catch (err) {
    next(err);
  }
});

// ---- One display name ------------------------------------------------------------
//
// PATCH /api/account/name { name }
// The one name every studio shows (DreamStream, Stream Studio, the baby monitor and
// calls), written to all three places it lives so the apps can never disagree:
//   - profile_private.first_name/last_name (DreamStream's profile),
//   - live_profiles.display_name — only when the person already has a Stream Studio
//     membership; never created here (membership stays welcome-code gated, live_join),
//   - auth user_metadata.display_name (+ first/last) — what live__default_name, a later
//     live_join, auth-email greetings and Chat Studio read.
// The @username (profiles.username) is the sign-in/Comic handle and is never touched.

accountRouter.patch('/name', async (req, res, next) => {
  try {
    const uid = req.user?.id;
    if (!uid) return res.status(401).json({ error: { message: 'User not authenticated' } });
    const name = cleanName(req.body?.name);
    if (!name) return res.status(400).json({ error: { message: `Add your name (1–${NAME_MAX} characters).` } });
    if (!getSupabaseCapabilityStatus().storagePersistenceEnabled) {
      return res.status(503).json({ error: { message: 'Accounts are unavailable right now — try again shortly.' } });
    }

    const db = getSupabaseAdmin();
    const { first, last } = splitName(name);
    const failed = (stage: string, message: string) => {
      logger.warn('account_name_save_failed', { stage, message });
      return res.status(500).json({ error: { message: 'Couldn’t save your name right now — try again.' } });
    };
    // Upsert: older accounts may not have a private-profile row yet.
    const pp = await db.from('profile_private').upsert({ id: uid, first_name: first, last_name: last }, { onConflict: 'id' });
    if (pp.error) return failed('profile_private', pp.error.message);
    // Rename only (UPDATE, never INSERT). The table has no updated_at trigger.
    const lp = await db
      .from('live_profiles')
      .update({ display_name: name, updated_at: new Date().toISOString() })
      .eq('user_id', uid)
      .select('user_id');
    if (lp.error) return failed('live_profiles', lp.error.message);
    // Best effort: the two tables above are what the apps read back; the metadata only
    // seeds future defaults, so a failure here is logged rather than failing the save.
    const meta = await db.auth.admin.updateUserById(uid, { user_metadata: { display_name: name, first_name: first, last_name: last } });
    if (meta.error) logger.warn('account_name_meta_failed', { message: meta.error.message });

    res.json({ ok: true, name, stream: (lp.data?.length ?? 0) > 0 });
  } catch (err) {
    next(err);
  }
});

// ---- Account settings snapshot --------------------------------------------------
//
// The per-account configuration snapshot (preferences + per-studio settings + chat
// personalization; see services/cloudSync.ts for the shape). Stored in
// `user_settings`, encrypted server-side with the server-only secret — replacing the
// old client-side encryption whose hardcoded secret shipped in the public bundle.
// Legacy client-encrypted rows are decrypted once on read and re-encrypted properly
// on the next write.

const MAX_SETTINGS_BYTES = 128 * 1024;

accountRouter.get('/settings', async (req, res, next) => {
  try {
    if (!req.user?.id) return res.status(401).json({ error: { message: 'User not authenticated' } });
    if (!storageReady()) return res.json({ ok: true, data: null, reason: 'storage_disabled' });

    // `data: null` WITHOUT a reason means "this account has no snapshot yet" — the client then
    // seeds the account from the device. Anything that stops the row from being read is told
    // apart with a `reason`, so a snapshot that exists is never reported as absent (the device,
    // just purged at sign-in, would overwrite it with nothing).
    const { data, error } = await getSupabaseAdmin()
      .from('user_settings')
      .select('encrypted_data, iv')
      .eq('user_id', req.user.id)
      .maybeSingle();
    if (error) {
      logger.warn('account_settings_read_failed', { message: error.message });
      return res.json({ ok: true, data: null, reason: 'read_failed' });
    }
    if (!data?.encrypted_data || !data?.iv) return res.json({ ok: true, data: null });

    const ciphertext = String(data.encrypted_data);
    const iv = String(data.iv);
    // New rows are server-encrypted; rows from before the migration used the legacy
    // in-browser scheme. The GCM auth tag makes trying both safe and unambiguous.
    const json = decryptSecret(ciphertext, iv) ?? decryptLegacyClientBlob(ciphertext, iv);
    if (!json) {
      // Neither scheme opens it (a rotated server secret, say): the row is there, unreadable.
      logger.warn('account_settings_unreadable', { stage: 'decrypt' });
      return res.json({ ok: true, data: null, reason: 'unreadable' });
    }

    try {
      return res.json({ ok: true, data: JSON.parse(json) });
    } catch {
      logger.warn('account_settings_unreadable', { stage: 'parse' });
      return res.json({ ok: true, data: null, reason: 'unreadable' });
    }
  } catch (err) {
    next(err);
  }
});

accountRouter.put('/settings', async (req, res, next) => {
  try {
    if (!req.user?.id) return res.status(401).json({ error: { message: 'User not authenticated' } });
    const snapshot = req.body?.data;
    if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) {
      return res.status(400).json({ error: { message: 'A settings object is required' } });
    }
    const json = JSON.stringify(snapshot);
    if (json.length > MAX_SETTINGS_BYTES) {
      return res.status(413).json({ error: { message: 'Settings snapshot too large' } });
    }

    if (!storageReady()) return res.json({ ok: false, persisted: false, reason: 'storage_disabled' });

    const enc = encryptSecret(json);
    if (!enc) return res.json({ ok: false, persisted: false, reason: 'encrypt_unavailable' });

    const { error } = await getSupabaseAdmin().from('user_settings').upsert(
      { user_id: req.user.id, encrypted_data: enc.ciphertext, iv: enc.iv, updated_at: new Date().toISOString() },
      { onConflict: 'user_id' }
    );
    if (error) {
      logger.warn('account_settings_store_failed', { message: error.message });
      return res.json({ ok: false, persisted: false });
    }
    res.json({ ok: true, persisted: true });
  } catch (err) {
    next(err);
  }
});
