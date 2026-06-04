// Cloud sync for per-account configuration (API keys + model/settings preferences).
//
// PROBLEM THIS SOLVES: keys and settings used to live only in this browser's
// localStorage, so two devices showed different data and nothing followed the
// account. This module makes the user's account the source of truth:
//   - on login we PULL the cloud snapshot, MERGE it with whatever is local
//     (union of keys, deduped by secret), apply the result locally, then PUSH the
//     merged result back so every device converges to the same set.
//   - on any local change we PUSH a fresh snapshot (debounced).
//
// The whole snapshot is encrypted client-side (AES-GCM) before it is stored in the
// `user_settings` table, so secrets are never written in plaintext.

import { supabase } from './supabase';
import { encryptKey, decryptKey } from './crypto';
import {
  listKeys,
  replaceAllKeys,
  suspendKeysSync,
  type ManagedApiKey,
} from './apiKeys';
import {
  getSettingsState,
  setSettingsState,
  getAllModelKeys,
  setAllModelKeys,
  getImageModelId,
  setImageModelId,
  suspendSettingsSync,
} from './appSettings';

interface CloudSnapshot {
  version: 1;
  keys: ManagedApiKey[];
  settings: ReturnType<typeof getSettingsState>;
  modelKeys: Record<string, string>;
  imageModelId: string | null;
}

const buildLocalSnapshot = (): CloudSnapshot => ({
  version: 1,
  keys: listKeys(),
  settings: getSettingsState(),
  modelKeys: getAllModelKeys(),
  imageModelId: getImageModelId(),
});

/** Union two key lists, de-duplicating by the secret value (keeps the first seen). */
const mergeKeys = (local: ManagedApiKey[], incoming: ManagedApiKey[]): ManagedApiKey[] => {
  const seenSecret = new Set<string>();
  const seenId = new Set<string>();
  const out: ManagedApiKey[] = [];

  for (const key of [...local, ...incoming]) {
    if (!key || typeof key.key !== 'string') continue;
    const secret = key.key.trim();
    if (!secret) continue;
    if (seenSecret.has(secret) || seenId.has(key.id)) continue;
    seenSecret.add(secret);
    seenId.add(key.id);
    out.push(key);
  }

  // Guarantee exactly one active key per provider after the merge.
  const activeSeen = new Set<string>();
  return out.map((key) => {
    if (key.active) {
      if (activeSeen.has(key.provider)) return { ...key, active: false };
      activeSeen.add(key.provider);
    }
    return key;
  });
};

/** Apply a snapshot to local storage without re-triggering the change listeners. */
const applySnapshot = (snap: CloudSnapshot) => {
  suspendKeysSync(true);
  suspendSettingsSync(true);
  try {
    replaceAllKeys(snap.keys || []);
    if (snap.settings) setSettingsState(snap.settings);
    if (snap.modelKeys) setAllModelKeys(snap.modelKeys);
    if (snap.imageModelId) setImageModelId(snap.imageModelId);
  } finally {
    suspendKeysSync(false);
    suspendSettingsSync(false);
  }
};

/** Read + decrypt the cloud snapshot for a user. Returns null if none / unreadable. */
export const pullCloudSnapshot = async (userId: string): Promise<CloudSnapshot | null> => {
  const { data, error } = await supabase
    .from('user_settings')
    .select('encrypted_data, iv')
    .eq('user_id', userId)
    .maybeSingle();

  if (error || !data?.encrypted_data || !data?.iv) return null;

  try {
    const json = await decryptKey(data.encrypted_data, data.iv);
    if (!json) return null;
    const parsed = JSON.parse(json) as CloudSnapshot;
    return parsed && parsed.version === 1 ? parsed : null;
  } catch {
    return null;
  }
};

/** Encrypt + upsert the current local config to the cloud for a user. */
export const pushCloudSnapshot = async (userId: string): Promise<void> => {
  try {
    const snapshot = buildLocalSnapshot();
    const { encrypted, iv } = await encryptKey(JSON.stringify(snapshot));
    await supabase.from('user_settings').upsert(
      { user_id: userId, encrypted_data: encrypted, iv, updated_at: new Date().toISOString() },
      { onConflict: 'user_id' }
    );
  } catch (err) {
    console.error('Cloud sync push failed', err);
  }
};

/**
 * Full login-time reconciliation: pull cloud, merge with local, apply, push back.
 * Makes every device converge on the same union of keys + the latest settings.
 */
export const syncOnLogin = async (userId: string): Promise<void> => {
  try {
    const cloud = await pullCloudSnapshot(userId);
    const local = buildLocalSnapshot();

    if (!cloud) {
      // First time on the cloud: seed it from whatever this device has locally.
      if (local.keys.length > 0 || Object.keys(local.modelKeys).length > 0) {
        await pushCloudSnapshot(userId);
      }
      return;
    }

    const merged: CloudSnapshot = {
      version: 1,
      keys: mergeKeys(local.keys, cloud.keys || []),
      // Cloud is the shared source of truth for preferences; fall back to local.
      settings: { ...local.settings, ...cloud.settings },
      modelKeys: { ...local.modelKeys, ...cloud.modelKeys },
      imageModelId: cloud.imageModelId || local.imageModelId,
    };

    applySnapshot(merged);

    // Push the converged result so other devices pick up anything new this device had.
    await pushCloudSnapshot(userId);
  } catch (err) {
    console.error('Cloud sync (login) failed', err);
  }
};

// ---- Debounced push wiring -----------------------------------------------------

let pushTimer: ReturnType<typeof setTimeout> | null = null;

/** Schedule a debounced cloud push for the given user (coalesces rapid edits). */
export const schedulePush = (userId: string) => {
  if (pushTimer) clearTimeout(pushTimer);
  pushTimer = setTimeout(() => {
    pushTimer = null;
    void pushCloudSnapshot(userId);
  }, 1500);
};
