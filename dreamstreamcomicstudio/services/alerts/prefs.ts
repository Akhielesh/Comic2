// The Alerts preferences (notify SPEC §6 NF-1 "Prefs", §3 item 6): per browser, never synced to the account, so the
// card says "Saved in this browser" and nothing here touches services/appSettings.ts. One key, `ds.alerts.v1`, holding
// { sound, volume, level }; every read and write is guarded (a blocked storage keeps the choice for this tab); a change
// is announced to this tab by an event and to other tabs by the storage event. A memory store with the same shape
// serves the QA scene and tests.

import { useSyncExternalStore } from 'react';
import { DEFAULT_ALERT_PREFS, type AlertLevel, type AlertPrefs, type AlertVolume } from './types';

export const ALERT_PREFS_KEY = 'ds.alerts.v1';
const CHANGED = 'dreamstream:alert-prefs-changed';

const VOLUMES: readonly AlertVolume[] = ['soft', 'normal'];
const LEVELS: readonly AlertLevel[] = ['all', 'needs'];

/** A stored value, read field by field: anything unknown falls back to its default. */
export const normalizeAlertPrefs = (value: unknown): AlertPrefs => {
  const v = value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  return {
    sound: typeof v.sound === 'boolean' ? v.sound : DEFAULT_ALERT_PREFS.sound,
    volume: VOLUMES.includes(v.volume as AlertVolume) ? (v.volume as AlertVolume) : DEFAULT_ALERT_PREFS.volume,
    level: LEVELS.includes(v.level as AlertLevel) ? (v.level as AlertLevel) : DEFAULT_ALERT_PREFS.level
  };
};

// A choice made while storage is blocked (private mode, a sandboxed frame) holds for this tab.
let unsaved: AlertPrefs | undefined;
// The last parse, so a snapshot read in a render is the same object until something changes.
let cache: { raw: string | null; prefs: AlertPrefs } | undefined;

/** The person's alert settings in this browser. */
export const loadAlertPrefs = (): AlertPrefs => {
  if (unsaved) return unsaved;
  let raw: string | null = null;
  try {
    raw = window.localStorage.getItem(ALERT_PREFS_KEY);
  } catch {
    return DEFAULT_ALERT_PREFS;
  }
  if (cache && cache.raw === raw) return cache.prefs;
  let parsed: unknown = null;
  try {
    parsed = raw ? JSON.parse(raw) : null;
  } catch {
    parsed = null;
  }
  cache = { raw, prefs: normalizeAlertPrefs(parsed) };
  return cache.prefs;
};

/** Store a change and tell this tab (other tabs hear it through the storage event). */
export const saveAlertPrefs = (patch: Partial<AlertPrefs>): AlertPrefs => {
  const next = normalizeAlertPrefs({ ...loadAlertPrefs(), ...patch });
  try {
    window.localStorage.setItem(ALERT_PREFS_KEY, JSON.stringify(next));
    unsaved = undefined;
  } catch {
    unsaved = next;
  }
  try {
    window.dispatchEvent(new Event(CHANGED));
  } catch {
    /* no window events: nothing listens either */
  }
  return next;
};

/** Calls `notify` when the prefs change here or in another tab. */
export const subscribeAlertPrefs = (notify: () => void): (() => void) => {
  const onStorage = (event: StorageEvent) => {
    if (event.key === ALERT_PREFS_KEY || event.key === null) notify();
  };
  window.addEventListener(CHANGED, notify);
  window.addEventListener('storage', onStorage);
  return () => {
    window.removeEventListener(CHANGED, notify);
    window.removeEventListener('storage', onStorage);
  };
};

/** Where the Alerts card reads and writes (the browser's store, or a memory one in the QA scene). */
export interface AlertPrefsStore {
  get(): AlertPrefs;
  set(patch: Partial<AlertPrefs>): void;
  subscribe(notify: () => void): () => void;
}

export const localPrefsStore: AlertPrefsStore = {
  get: loadAlertPrefs,
  set: (patch) => void saveAlertPrefs(patch),
  subscribe: subscribeAlertPrefs
};

/** Prefs kept in memory only (never in localStorage). */
export const createMemoryPrefsStore = (initial: Partial<AlertPrefs> = {}): AlertPrefsStore => {
  let prefs = normalizeAlertPrefs({ ...DEFAULT_ALERT_PREFS, ...initial });
  const listeners = new Set<() => void>();
  return {
    get: () => prefs,
    set: (patch) => {
      prefs = normalizeAlertPrefs({ ...prefs, ...patch });
      listeners.forEach((fn) => fn());
    },
    subscribe: (fn) => {
      listeners.add(fn);
      return () => void listeners.delete(fn);
    }
  };
};

/** The prefs of a store, live. */
export const useAlertPrefs = (store: AlertPrefsStore = localPrefsStore): AlertPrefs => useSyncExternalStore(store.subscribe, store.get, store.get);

/** Test seam: forget the tab-only choice and the parse cache. */
export const __resetAlertPrefsForTests = (): void => {
  unsaved = undefined;
  cache = undefined;
};
