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
// STUDIO-scoped configuration (each studio's own knobs), so studios share one account
// without sharing one settings bag (snapshot v2). The only studio entry so far was
// Code Studio's pinned coding model; Code Studio is retired (ADR 0005), so old
// snapshots may still carry `studios.code` but it is never applied or pushed again.
//
// Storage moved server-side: the snapshot is sent over the authenticated API
// (GET/PUT /api/account/settings) and encrypted AT THE SERVER with a server-only
// secret before it reaches the `user_settings` table. The previous design encrypted
// in the browser with a hardcoded secret shipped in the public bundle — decryptable
// by anyone — and rode direct Supabase table access. Legacy rows are decrypted by
// the server on read and re-encrypted properly on the next push.
//
// A read that FAILS is never "no snapshot". Right after a sign-out → sign-in (or an account
// switch) the local state has just been purged, so seeding the account from it would replace
// the account's keys, model choices, chat memory and custom agents with nothing. When the read
// fails, nothing is applied or pushed — pushes stay off until a read succeeds — and the login
// sync is run again (contexts/AuthContext).

import { get, put } from './apiClient';
import { appStatus } from './appStatus';
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
import { applyGovernanceMap, getGovernanceMap, type GovernanceMap } from './sourceGovernance';
import { getChatMemory, setChatMemory, MAX_CHAT_MEMORY_CHARS } from './chatStorage';
import { listCustomAgents, replaceCustomAgents, parseMemoryItems, formatMemoryItems } from './chatAgents';
import type { CustomAgentDef } from '../apiTypes';
import { isLocalOwner } from './localOwner';

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
  /** Allowed-sources governance (explicit on/off per provider) — an OFF must follow the account. */
  sourceGovernance?: GovernanceMap;
  // ---- Studio-scoped: each studio's own settings, namespaced (v2) ----
  studios?: {
    /** Legacy: Code Studio's pinned coding model (retired, ADR 0005). Ignored on read. */
    code?: unknown;
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
  sourceGovernance: getGovernanceMap(),
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
    if (typeof snap.chat?.memory === 'string') setChatMemory(snap.chat.memory, userId);
    if (Array.isArray(snap.chat?.agents)) replaceCustomAgents(snap.chat.agents, userId);
    if (snap.sourceGovernance) applyGovernanceMap(snap.sourceGovernance);
  } finally {
    suspendKeysSync(false);
    suspendSettingsSync(false);
    applyingSnapshot = false;
  }
};

/** What a read of the account snapshot found: a snapshot, nothing (an account new to the cloud), or no answer. */
export type CloudRead =
  | { kind: 'snapshot'; snapshot: CloudSnapshot }
  | { kind: 'none' }
  | { kind: 'failed'; reason: string };

/**
 * Read the account snapshot. 'none' ONLY for a good answer that holds no snapshot and gives
 * no `reason` — the account has never synced. Everything else is 'failed': a request that did
 * not get through (status 0), a non-2xx answer (a proxy's 502/503 while the backend wakes, a
 * 429), a `reason` from the server (a row it cannot read — `unreadable` —, no storage), or a
 * snapshot version this build does not know. A failed read is never "no snapshot".
 */
export const readCloudSnapshot = async (): Promise<CloudRead> => {
  let res: { ok?: boolean; data?: CloudSnapshot | null; reason?: string } | null | undefined;
  try {
    res = await get<{ ok: boolean; data: CloudSnapshot | null; reason?: string }>('/api/account/settings');
  } catch (err) {
    const status = (err as { status?: unknown } | null)?.status;
    return { kind: 'failed', reason: typeof status === 'number' && status > 0 ? `http_${status}` : 'network' };
  }
  if (typeof res?.reason === 'string' && res.reason) return { kind: 'failed', reason: res.reason };
  if (!res?.ok) return { kind: 'failed', reason: 'not_ok' };
  const snap = res.data;
  if (snap == null) return { kind: 'none' };
  if (typeof snap !== 'object' || (snap.version !== 1 && snap.version !== 2)) {
    return { kind: 'failed', reason: 'unsupported_snapshot' };
  }
  return { kind: 'snapshot', snapshot: snap };
};

/** Read the cloud snapshot for the signed-in user. Null if none / unreadable (readCloudSnapshot tells the two apart). */
export const pullCloudSnapshot = async (): Promise<CloudSnapshot | null> => {
  const read = await readCloudSnapshot();
  return read.kind === 'snapshot' ? read.snapshot : null;
};

// A push replaces the account's whole snapshot, so it is allowed only once this page has read
// the account's copy and merged it in: the account whose snapshot the login sync read (or found
// absent) in this page's life. Until then a local change stays local — the next successful
// login sync merges and pushes it — instead of overwriting a copy this device never saw.
let cloudReadFor: string | null = null;

/** Push the current local config to the account (server encrypts at rest). */
export const pushCloudSnapshot = async (userId: string): Promise<void> => {
  // SECURITY: only the account that owns this device's local data may receive it. A push
  // queued for an account that has since signed out or been switched away from would
  // otherwise upload one account's keys / chat memory with the next account's token.
  if (!isLocalOwner(userId)) return;
  if (cloudReadFor !== userId.toLowerCase()) return;
  try {
    const snapshot = buildLocalSnapshot(userId);
    await put('/api/account/settings', { data: snapshot });
  } catch (err) {
    console.error('Cloud sync push failed', err);
  }
};

/** Refresh which providers have a key stored on the account (metadata, no secrets). */
const refreshAccountKeyMeta = async (userId: string): Promise<void> => {
  try {
    const res = await get<{ ok: boolean; keys: AccountKeyMeta[] }>('/api/account/byok');
    if (res?.ok && Array.isArray(res.keys) && isLocalOwner(userId)) setAccountKeyMeta(res.keys);
  } catch {
    /* metadata is a display nicety — never block sync on it */
  }
};

export type LoginSyncOutcome = 'synced' | 'failed' | 'skipped';

/** Shown when the account snapshot could not be read at sign-in (nothing was changed). */
export const CLOUD_SYNC_READ_FAILED_NOTICE =
  'Couldn’t load your account settings, so nothing was changed. They’ll load on the next try — or reload the page.';

/**
 * Full login-time reconciliation: pull cloud, merge with local, apply, push back.
 * Makes every device converge on the same union of keys + the latest settings.
 * 'failed': the account's snapshot could not be read, so nothing was applied or pushed (the
 * account keeps its copy, this device its local state, pushes stay off) — the caller runs it
 * again. 'skipped': this device's data isn't this account's, nothing to reconcile.
 */
export const reconcileOnLogin = async (userId: string): Promise<LoginSyncOutcome> => {
  try {
    if (!isLocalOwner(userId)) return 'skipped';
    cloudReadFor = null;
    void refreshAccountKeyMeta(userId);

    const read = await readCloudSnapshot();
    // The pull is a network round trip: the device may have signed out or switched accounts
    // meanwhile. Then this account's snapshot must not be written into local storage (it
    // would sit there with no owner, or under someone else's), nor local data pushed to it.
    if (!isLocalOwner(userId)) return 'skipped';
    if (read.kind === 'failed') {
      // A backend without account storage has nothing to load and nothing to lose: no notice.
      if (read.reason !== 'storage_disabled') {
        appStatus.report('warn', CLOUD_SYNC_READ_FAILED_NOTICE, { detail: read.reason, source: 'cloud-sync' });
      }
      return 'failed';
    }
    cloudReadFor = userId.toLowerCase();
    const local = buildLocalSnapshot(userId);

    if (read.kind === 'none') {
      // First time on the cloud: seed it from whatever this device has locally.
      await pushCloudSnapshot(userId);
      return 'synced';
    }
    const cloud = read.snapshot;

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
      // Cloud wins per-provider; local explicit choices not yet synced fill the gaps.
      sourceGovernance: { ...local.sourceGovernance, ...cloud.sourceGovernance },
    };

    applySnapshot(merged, userId);

    // Push the converged result so other devices pick up anything new this device had
    // (and legacy client-encrypted rows get re-encrypted server-side).
    await pushCloudSnapshot(userId);
    return 'synced';
  } catch (err) {
    console.error('Cloud sync (login) failed', err);
    return 'failed';
  }
};

/** reconcileOnLogin for callers that don't act on the outcome. */
export const syncOnLogin = async (userId: string): Promise<void> => {
  await reconcileOnLogin(userId);
};

// ---- Debounced push wiring -----------------------------------------------------

let pushTimer: ReturnType<typeof setTimeout> | null = null;

/** Drop a debounced push that hasn't run yet (an account switch: it was queued for the old one). */
export const cancelScheduledPush = (): void => {
  if (pushTimer) clearTimeout(pushTimer);
  pushTimer = null;
};

/** Schedule a debounced cloud push for the given user (coalesces rapid edits). */
export const schedulePush = (userId: string) => {
  if (applyingSnapshot) return; // change came from a pulled snapshot, not the user
  if (pushTimer) clearTimeout(pushTimer);
  pushTimer = setTimeout(() => {
    pushTimer = null;
    void pushCloudSnapshot(userId);
  }, 1500);
};
