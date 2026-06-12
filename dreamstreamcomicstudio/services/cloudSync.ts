// Cloud sync for per-account configuration.
//
// PROBLEM THIS SOLVES: keys and settings used to live only in this browser's
// localStorage, so two devices showed different data and nothing followed the
// account. This module makes the user's account the source of truth:
//   - on login we PULL the cloud snapshot, MERGE it with whatever is local
//     (union of keys, deduped by secret), apply the result locally, then PUSH the
//     merged result back so every device converges to the same set.
//   - on any local change we PUSH a fresh snapshot (debounced).
//
// The snapshot separates ACCOUNT-level configuration (API keys, model preferences,
// chat memory and custom agents — the same everywhere the account signs in) from
// STUDIO-scoped configuration (each studio's own knobs, e.g. the Code Studio's
// pinned coding model), so studios share one account without sharing one settings
// bag (snapshot v2).
//
// Storage moved server-side: the snapshot is sent over the authenticated API
// (GET/PUT /api/account/settings) and encrypted AT THE SERVER with a server-only
// secret before it reaches the `user_settings` table. The previous design encrypted
// in the browser with a hardcoded secret shipped in the public bundle — decryptable
// by anyone — and rode direct Supabase table access. Legacy rows are decrypted by
// the server on read and re-encrypted properly on the next push.

import { get, put } from './apiClient';
import {
  listKeys,
  replaceAllKeys,
  setAccountKeyMeta,
  suspendKeysSync,
  type AccountKeyMeta,
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
import {
  getStoredModelSelection,
  replaceModelSelection,
  type ModelSelection,
} from './modelSelection';
import {
  getStoredStudioModelSelection,
  replaceStudioModelSelection,
  type StudioModelSelection,
} from './studioModelSelection';
import { getChatMemory, setChatMemory, MAX_CHAT_MEMORY_CHARS } from './chatStorage';
import { listCustomAgents, replaceCustomAgents, parseMemoryItems, formatMemoryItems } from './chatAgents';
import type { CustomAgentDef } from '../apiTypes';

interface CloudSnapshot {
  version: 1 | 2;
  // ---- Account-level: identical everywhere the account signs in ----
  keys: ManagedApiKey[];
  settings: ReturnType<typeof getSettingsState>;
  modelKeys: Record<string, string>;
  imageModelId: string | null;
  /** Chat/comics model preferences (v2). */
  modelSelection?: ModelSelection | null;
  /** Chat personalization (v2): long-term memory + custom agents. */
  chat?: {
    memory?: string;
    agents?: CustomAgentDef[];
  };
  // ---- Studio-scoped: each studio's own settings, namespaced (v2) ----
  studios?: {
    /** Code Studio: pinned coding model, cost pref, agents, runtime, … */
    code?: StudioModelSelection | null;
  };
}

const buildLocalSnapshot = (userId: string): CloudSnapshot => ({
  version: 2,
  keys: listKeys(),
  settings: getSettingsState(),
  modelKeys: getAllModelKeys(),
  imageModelId: getImageModelId(),
  // Stored-or-null getters: an untouched device contributes null here, so its
  // implicit defaults can never overwrite another device's real choices in the
  // `cloud ?? local` merge below.
  modelSelection: getStoredModelSelection(),
  chat: {
    memory: getChatMemory(userId),
    agents: listCustomAgents(userId),
  },
  studios: {
    code: getStoredStudioModelSelection(),
  },
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

/** Union memories as bullet items, deduped case-insensitively (local first). */
const mergeMemory = (local: string, incoming: string): string => {
  const seen = new Set<string>();
  const items: string[] = [];
  for (const item of [...parseMemoryItems(local), ...parseMemoryItems(incoming)]) {
    const norm = item.toLowerCase();
    if (seen.has(norm)) continue;
    seen.add(norm);
    items.push(item);
  }
  return formatMemoryItems(items).slice(0, MAX_CHAT_MEMORY_CHARS);
};

/** Union custom agents by id (local wins on conflict, mirroring mergeKeys). */
const mergeAgents = (local: CustomAgentDef[], incoming: CustomAgentDef[]): CustomAgentDef[] => {
  const seen = new Set<string>();
  const out: CustomAgentDef[] = [];
  for (const agent of [...local, ...incoming]) {
    if (!agent || typeof agent.id !== 'string' || seen.has(agent.id)) continue;
    seen.add(agent.id);
    out.push(agent);
  }
  return out;
};

// While a pulled snapshot is being applied locally, every "local change" listener
// fires — without this guard they'd schedule a push of the very data we just pulled
// (and worse, loop). schedulePush() checks it, so registrations stay simple.
let applyingSnapshot = false;
export const isApplyingSnapshot = (): boolean => applyingSnapshot;

/** Apply a snapshot to local storage without re-triggering the change listeners. */
const applySnapshot = (snap: CloudSnapshot, userId: string) => {
  applyingSnapshot = true;
  suspendKeysSync(true);
  suspendSettingsSync(true);
  try {
    replaceAllKeys(snap.keys || []);
    if (snap.settings) setSettingsState(snap.settings);
    if (snap.modelKeys) setAllModelKeys(snap.modelKeys);
    if (snap.imageModelId) setImageModelId(snap.imageModelId);
    if (snap.modelSelection) replaceModelSelection(snap.modelSelection);
    if (snap.studios?.code) replaceStudioModelSelection(snap.studios.code);
    if (typeof snap.chat?.memory === 'string') setChatMemory(snap.chat.memory, userId);
    if (Array.isArray(snap.chat?.agents)) replaceCustomAgents(snap.chat.agents, userId);
  } finally {
    suspendKeysSync(false);
    suspendSettingsSync(false);
    applyingSnapshot = false;
  }
};

/** Read the cloud snapshot for the signed-in user. Null if none / unreadable. */
export const pullCloudSnapshot = async (): Promise<CloudSnapshot | null> => {
  try {
    const res = await get<{ ok: boolean; data: CloudSnapshot | null }>('/api/account/settings');
    const snap = res?.data;
    return snap && (snap.version === 1 || snap.version === 2) ? snap : null;
  } catch {
    return null;
  }
};

/** Push the current local config to the account (server encrypts at rest). */
export const pushCloudSnapshot = async (userId: string): Promise<void> => {
  try {
    const snapshot = buildLocalSnapshot(userId);
    await put('/api/account/settings', { data: snapshot });
  } catch (err) {
    console.error('Cloud sync push failed', err);
  }
};

/** Refresh which providers have a key stored on the account (metadata, no secrets). */
const refreshAccountKeyMeta = async (): Promise<void> => {
  try {
    const res = await get<{ ok: boolean; keys: AccountKeyMeta[] }>('/api/account/byok');
    if (res?.ok && Array.isArray(res.keys)) setAccountKeyMeta(res.keys);
  } catch {
    /* metadata is a display nicety — never block sync on it */
  }
};

/**
 * Full login-time reconciliation: pull cloud, merge with local, apply, push back.
 * Makes every device converge on the same union of keys + the latest settings.
 */
export const syncOnLogin = async (userId: string): Promise<void> => {
  try {
    void refreshAccountKeyMeta();

    const cloud = await pullCloudSnapshot();
    const local = buildLocalSnapshot(userId);

    if (!cloud) {
      // First time on the cloud: seed it from whatever this device has locally.
      await pushCloudSnapshot(userId);
      return;
    }

    const merged: CloudSnapshot = {
      version: 2,
      keys: mergeKeys(local.keys, cloud.keys || []),
      // Cloud is the shared source of truth for preferences; fall back to local.
      settings: { ...local.settings, ...cloud.settings },
      modelKeys: { ...local.modelKeys, ...cloud.modelKeys },
      imageModelId: cloud.imageModelId || local.imageModelId,
      modelSelection: cloud.modelSelection ?? local.modelSelection,
      chat: {
        memory: mergeMemory(local.chat?.memory || '', cloud.chat?.memory || ''),
        agents: mergeAgents(local.chat?.agents || [], cloud.chat?.agents || []),
      },
      studios: {
        code: cloud.studios?.code ?? local.studios?.code,
      },
    };

    applySnapshot(merged, userId);

    // Push the converged result so other devices pick up anything new this device had
    // (and legacy client-encrypted rows get re-encrypted server-side).
    await pushCloudSnapshot(userId);
  } catch (err) {
    console.error('Cloud sync (login) failed', err);
  }
};

// ---- Debounced push wiring -----------------------------------------------------

let pushTimer: ReturnType<typeof setTimeout> | null = null;

/** Schedule a debounced cloud push for the given user (coalesces rapid edits). */
export const schedulePush = (userId: string) => {
  if (applyingSnapshot) return; // change came from a pulled snapshot, not the user
  if (pushTimer) clearTimeout(pushTimer);
  pushTimer = setTimeout(() => {
    pushTimer = null;
    void pushCloudSnapshot(userId);
  }, 1500);
};
