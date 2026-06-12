// DreamStream platform-allowance status + billing preferences.
//
// Backend contract (built in a parallel workstream — these endpoints may not exist
// yet, so EVERY call here degrades to `null` on 404/error and consumers hide their UI):
//   GET   /api/usage/allowance        → AllowanceStatus
//   PATCH /api/account/billing-prefs  { usePlatformAllowance?, byokFallbackMode? } → AllowanceStatus
//
// IMPORTANT: the allowance speaks ONLY in percentages. No dollar amounts exist in
// this contract and none may be invented in any UI built on top of it.

import { get, patch } from './apiClient';

export type ByokFallbackMode = 'ask' | 'auto' | 'never';

export interface AllowanceStatus {
  /** Server feature flag — when false the whole allowance UI stays hidden. */
  enabled: boolean;
  /** Percent of the monthly allowance consumed (0–100+, never a dollar figure). */
  pctUsed: number;
  exhausted: boolean;
  /** Alert thresholds (e.g. 30/70/90/100) the usage has already crossed. */
  crossed: number[];
  /** ISO timestamp of the next monthly reset. */
  resetsAt: string;
  /** Master toggle: run generation on the platform's universal key while allowance lasts. */
  usePlatformAllowance: boolean;
  /** What happens when the allowance runs out. */
  byokFallbackMode: ByokFallbackMode;
  /** Whether the user has a personal key on file to fall back to. */
  byokAvailable: boolean;
}

export interface BillingPrefsPatch {
  usePlatformAllowance?: boolean;
  byokFallbackMode?: ByokFallbackMode;
}

const FALLBACK_MODES: readonly ByokFallbackMode[] = ['ask', 'auto', 'never'];

/** Defensive parse — tolerates partial payloads from a backend that's still being built. */
const normalize = (raw: unknown): AllowanceStatus | null => {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.pctUsed !== 'number' || !Number.isFinite(r.pctUsed)) return null;
  const pctUsed = Math.max(0, r.pctUsed);
  return {
    enabled: r.enabled !== false,
    pctUsed,
    exhausted: r.exhausted === true || pctUsed >= 100,
    crossed: Array.isArray(r.crossed) ? r.crossed.filter((n): n is number => typeof n === 'number') : [],
    resetsAt: typeof r.resetsAt === 'string' ? r.resetsAt : '',
    usePlatformAllowance: r.usePlatformAllowance !== false,
    byokFallbackMode: FALLBACK_MODES.includes(r.byokFallbackMode as ByokFallbackMode)
      ? (r.byokFallbackMode as ByokFallbackMode)
      : 'ask',
    byokAvailable: r.byokAvailable === true
  };
};

/** Current allowance status, or null when the endpoint is missing/erroring (hide the UI). */
export const fetchAllowanceStatus = async (options?: { signal?: AbortSignal }): Promise<AllowanceStatus | null> => {
  try {
    return normalize(await get<unknown>('/api/usage/allowance', options));
  } catch {
    return null;
  }
};

/** Persist billing prefs; returns the fresh status, or null when the PATCH failed. */
export const patchBillingPrefs = async (prefs: BillingPrefsPatch): Promise<AllowanceStatus | null> => {
  try {
    const raw = await patch<BillingPrefsPatch, unknown>('/api/account/billing-prefs', prefs);
    // Contract says the full allowance shape comes back; the deployed backend answers
    // { ok, prefs } instead. Accept both: use the full shape when present, otherwise
    // reconcile with a fresh GET so callers always hold server truth.
    return normalize(raw) ?? (await fetchAllowanceStatus());
  } catch {
    return null;
  }
};

// ---------------------------------------------------------------------------
// Alert thresholds + per-threshold banner dismissal
// ---------------------------------------------------------------------------

export const ALLOWANCE_ALERT_THRESHOLDS = [30, 70, 90, 100] as const;
export type AllowanceThreshold = (typeof ALLOWANCE_ALERT_THRESHOLDS)[number];

/**
 * Highest alert threshold this status has crossed — trusts the server's `crossed`
 * array, with pctUsed/exhausted as a fallback so a sparse payload still alerts.
 */
export const highestCrossedThreshold = (status: AllowanceStatus): AllowanceThreshold | null => {
  let highest: AllowanceThreshold | null = null;
  for (const t of ALLOWANCE_ALERT_THRESHOLDS) {
    if (status.crossed.includes(t) || status.pctUsed >= t || (t === 100 && status.exhausted)) highest = t;
  }
  return highest;
};

// Dismissals are remembered per threshold AND per reset period (the stored value is
// the period's resetsAt), so each newly-crossed threshold re-shows once, and every
// threshold re-arms after the monthly reset.
const dismissKey = (threshold: number) => `dreamstream_allowance_dismissed_${threshold}`;

export const isThresholdDismissed = (threshold: number, resetsAt: string): boolean => {
  try {
    return window.localStorage.getItem(dismissKey(threshold)) === (resetsAt || 'unknown');
  } catch {
    return false;
  }
};

export const dismissThreshold = (threshold: number, resetsAt: string): void => {
  try {
    window.localStorage.setItem(dismissKey(threshold), resetsAt || 'unknown');
  } catch {
    /* storage unavailable — banner just re-shows */
  }
};

/** "Jul 1" style label from resetsAt; empty string when missing/unparseable. */
export const resetsLabel = (resetsAt: string): string => {
  if (!resetsAt) return '';
  const d = new Date(resetsAt);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
};
