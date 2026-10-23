// DreamStream usage left (P1-LIMITS) + billing preferences.
//
// Backend contract:
//   GET   /api/usage/allowance        → AllowanceStatus (percent + friendly units only)
//   PATCH /api/account/billing-prefs  { usePlatformAllowance?, byokFallbackMode? } → AllowanceStatus
// Admin only (served behind requireAdmin; dollars are fine there):
//   GET   /api/admin/usage/budgets            → { defaultBudgetUsd, users: UsageBudgetRow[] }
//   PUT   /api/admin/usage/budgets/:idOrEmail { budgetUsd?, exempt?, allowPro?, period?, resetPeriod?, note? }
//
// IMPORTANT: for users the meter speaks ONLY in percentages and friendly units ("about 150
// standard comic pages left"). No dollar amounts exist in the user contract and none may be
// invented in any UI built on top of it. Every call degrades to `null` on error so consumers
// hide their UI instead of guessing.
//
// Never polled on a timer (the backend container must be able to sleep): read on mount, on
// window focus, and after something was spent.

import { get, patch, put } from './apiClient';

export type ByokFallbackMode = 'ask' | 'auto' | 'never';

export interface FriendlyUnits {
  /** Standard comic pages the remaining usage covers (rounded down to a calm number). */
  standardPages: number;
  draftPages: number;
  /** How much of the usage one Standard page takes, in percent (lets quotes show "≈2% of your usage"). */
  pctPerStandardPage: number | null;
  /** One calm sentence, e.g. "about 150 standard comic pages left". */
  label: string;
}

export interface AllowanceStatus {
  /** Server feature flag — when false the whole meter UI stays hidden. */
  enabled: boolean;
  /** False for admins and exempt accounts: no usage limit applies (hide the meter). */
  governed: boolean;
  /** Percent of the usage consumed (0–100, never a dollar figure). */
  pctUsed: number;
  /** Percent of the usage still left (0–100). */
  pctLeft: number;
  exhausted: boolean;
  /** Alert thresholds (30/70/90/100) the usage has already crossed. */
  crossed: number[];
  /** Next reset (monthly usage only); null when usage doesn't reset on its own (lifetime). */
  resetsAt: string | null;
  friendlyUnits: FriendlyUnits | null;
  /** Master toggle: run generation on the platform's universal key while usage is left. */
  usePlatformAllowance: boolean;
  /** What happens when the usage runs out. */
  byokFallbackMode: ByokFallbackMode;
  /** Whether the user has a personal key on file to fall back to. */
  byokAvailable: boolean;
}

export interface BillingPrefsPatch {
  usePlatformAllowance?: boolean;
  byokFallbackMode?: ByokFallbackMode;
}

const FALLBACK_MODES: readonly ByokFallbackMode[] = ['ask', 'auto', 'never'];

const finitePct = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.min(100, v)) : null);

const normalizeUnits = (raw: unknown): FriendlyUnits | null => {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.label !== 'string' || !r.label.trim()) return null;
  const count = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.floor(v) : 0);
  const per = r.pctPerStandardPage;
  return {
    standardPages: count(r.standardPages),
    draftPages: count(r.draftPages),
    pctPerStandardPage: typeof per === 'number' && Number.isFinite(per) && per > 0 ? per : null,
    label: r.label.trim().slice(0, 120)
  };
};

/** Defensive parse — tolerates partial payloads (and the pre-P1-LIMITS monthly shape). */
export const normalizeAllowanceStatus = (raw: unknown): AllowanceStatus | null => {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const pctUsedRaw = finitePct(r.pctUsed);
  const pctLeftRaw = finitePct(r.pctLeft);
  if (pctUsedRaw === null && pctLeftRaw === null) return null;
  const pctUsed = pctUsedRaw ?? Math.round((100 - (pctLeftRaw as number)) * 10) / 10;
  const pctLeft = pctLeftRaw ?? Math.round((100 - pctUsed) * 10) / 10;
  const exhausted = r.exhausted === true || pctUsed >= 100 || pctLeft <= 0;
  return {
    enabled: r.enabled !== false,
    governed: r.governed !== false,
    pctUsed,
    pctLeft: exhausted ? 0 : pctLeft,
    exhausted,
    crossed: Array.isArray(r.crossed) ? r.crossed.filter((n): n is number => typeof n === 'number') : [],
    resetsAt: typeof r.resetsAt === 'string' && r.resetsAt ? r.resetsAt : null,
    friendlyUnits: normalizeUnits(r.friendlyUnits),
    usePlatformAllowance: r.usePlatformAllowance !== false,
    byokFallbackMode: FALLBACK_MODES.includes(r.byokFallbackMode as ByokFallbackMode)
      ? (r.byokFallbackMode as ByokFallbackMode)
      : 'ask',
    byokAvailable: r.byokAvailable === true
  };
};

const normalize = normalizeAllowanceStatus;

/** Should a usage meter show for this status? (Admins/exempt and a hidden backend → no.) */
export const showsUsageMeter = (status: AllowanceStatus | null | undefined): status is AllowanceStatus =>
  !!status && status.enabled && status.governed;

/** "62%", "<1%", "0%" — usage left, never a dollar figure. */
export const formatPctLeft = (pctLeft: number): string => {
  if (!Number.isFinite(pctLeft) || pctLeft <= 0) return '0%';
  if (pctLeft < 1) return '<1%';
  return `${Math.floor(pctLeft)}%`;
};

/** Calm tone for a meter: plenty → ok, under 30% → low, under 10% → critical. */
export const usageTone = (status: Pick<AllowanceStatus, 'pctLeft' | 'exhausted'>): 'ok' | 'low' | 'critical' =>
  status.exhausted || status.pctLeft < 10 ? 'critical' : status.pctLeft < 30 ? 'low' : 'ok';

/** The honest hard-stop copy (lifetime usage doesn't reset on its own). */
export const USAGE_EXHAUSTED_COPY =
  "You've used all of your DreamStream usage. It doesn't reset on its own — ask us for a top-up (reply to your welcome email), or add your own API key in Settings → API keys to keep going.";

// ---------------------------------------------------------------------------
// Shared status store — the settings panel (60s poll) and the chat banner
// (5min poll) render from ONE module-level status, so a change made on either
// surface (e.g. switching byokFallbackMode) shows up everywhere immediately.
// The polls remain purely as refresh sources feeding this store.
// ---------------------------------------------------------------------------

type AllowanceListener = (status: AllowanceStatus) => void;

let lastStatus: AllowanceStatus | null = null;
const listeners = new Set<AllowanceListener>();

/** Last known status (null until the first successful fetch). */
export const getLastAllowanceStatus = (): AllowanceStatus | null => lastStatus;

/** Push a status to every subscriber — also used for optimistic UI updates/reverts. */
export const publishAllowanceStatus = (status: AllowanceStatus): void => {
  lastStatus = status;
  for (const fn of [...listeners]) fn(status);
};

/** Subscribe to status updates; returns the unsubscribe function. */
export const subscribeAllowanceStatus = (fn: AllowanceListener): (() => void) => {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
};

let lastFetchAt = 0;
let inflight: Promise<AllowanceStatus | null> | null = null;

/** Current allowance status, or null when the endpoint is missing/erroring (hide the UI). */
export const fetchAllowanceStatus = async (options?: { signal?: AbortSignal }): Promise<AllowanceStatus | null> => {
  try {
    lastFetchAt = Date.now();
    const status = normalize(await get<unknown>('/api/usage/allowance', options));
    if (status) publishAllowanceStatus(status); // keep the last good status on transient failures
    return status;
  } catch {
    return null;
  }
};

/**
 * Event-driven refresh (mount, focus, after a spend): coalesces concurrent callers and skips
 * the request when the last read is younger than `minAgeMs`. Never runs on a timer.
 */
export const refreshAllowanceStatus = (minAgeMs = 30_000): Promise<AllowanceStatus | null> => {
  if (inflight) return inflight;
  if (lastStatus && Date.now() - lastFetchAt < minAgeMs) return Promise.resolve(lastStatus);
  inflight = fetchAllowanceStatus().finally(() => {
    inflight = null;
  });
  return inflight;
};

/** Test-only: forget the shared store. */
export const __resetAllowanceStore = (): void => {
  lastStatus = null;
  lastFetchAt = 0;
  inflight = null;
  listeners.clear();
};

/** Persist billing prefs; returns the fresh status, or null when the PATCH failed. */
export const patchBillingPrefs = async (prefs: BillingPrefsPatch): Promise<AllowanceStatus | null> => {
  try {
    const raw = await patch<BillingPrefsPatch, unknown>('/api/account/billing-prefs', prefs);
    // Contract says the full allowance shape comes back; the deployed backend answers
    // { ok, prefs } instead. Accept both: use the full shape when present, otherwise
    // reconcile with a fresh GET so callers always hold server truth.
    const status = normalize(raw) ?? (await fetchAllowanceStatus());
    if (status) publishAllowanceStatus(status);
    return status;
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

// Dismissals are remembered per threshold AND per period (the stored value is the
// period's resetsAt, or 'lifetime'), so each newly-crossed threshold re-shows once, and
// every threshold re-arms after a monthly reset.
const dismissKey = (threshold: number) => `dreamstream_allowance_dismissed_${threshold}`;

export const isThresholdDismissed = (threshold: number, resetsAt: string | null): boolean => {
  try {
    return window.localStorage.getItem(dismissKey(threshold)) === (resetsAt || 'lifetime');
  } catch {
    return false;
  }
};

export const dismissThreshold = (threshold: number, resetsAt: string | null): void => {
  try {
    window.localStorage.setItem(dismissKey(threshold), resetsAt || 'lifetime');
  } catch {
    /* storage unavailable — banner just re-shows */
  }
};

/** "Jul 1" style label from resetsAt; empty string when missing/unparseable. */
export const resetsLabel = (resetsAt: string | null): string => {
  if (!resetsAt) return '';
  const d = new Date(resetsAt);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
};

// ---------------------------------------------------------------------------
// Admin: usage budgets (dollars are fine here — admin console only)
// ---------------------------------------------------------------------------

export interface UsageBudgetRow {
  userId: string;
  email: string | null;
  hasRow: boolean;
  exempt: boolean;
  allowPro: boolean;
  budgetUsd: number;
  period: 'lifetime' | 'monthly';
  periodStartedAt: string | null;
  spentUsd: number;
  inflightUsd: number;
  pctUsed: number;
  pctLeft: number;
  exhausted: boolean;
  note: string | null;
  updatedAt: string | null;
  lastUsedAt: string | null;
  /** Admins are exempt in code (no limit regardless of the row). */
  admin: boolean;
}

export interface UsageBudgetsReport {
  defaultBudgetUsd: number;
  defaultPeriod: 'lifetime' | 'monthly';
  maxBudgetUsd: number;
  users: UsageBudgetRow[];
}

export interface UsageBudgetUpdate {
  budgetUsd?: number;
  exempt?: boolean;
  allowPro?: boolean;
  period?: 'lifetime' | 'monthly';
  resetPeriod?: boolean;
  note?: string | null;
}

export const listUsageBudgets = (options?: { signal?: AbortSignal }): Promise<UsageBudgetsReport> =>
  get<UsageBudgetsReport>('/api/admin/usage/budgets', options);

/** `who` is a user id or an email address. */
export const updateUsageBudget = (who: string, update: UsageBudgetUpdate): Promise<{ success: boolean; userId: string }> =>
  put<UsageBudgetUpdate, { success: boolean; userId: string }>(`/api/admin/usage/budgets/${encodeURIComponent(who.trim())}`, update);
