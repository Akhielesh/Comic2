// The real balance of the person's own OpenRouter key (docs/features/credit-safety.md), one reading shared by the studio
// header and Settings → API keys.
//
// What it reads: POST /api/keys/balance for the active OpenRouter key on this device, or the account's saved one (the
// server only ever reads the caller's own key: an owner bearer, the key in its own header or the owner's saved key).
// The store keeps one reading per credential FINGERPRINT (never the key itself); switching or removing the key, or
// turning OpenRouter off, starts over.
//
// When it reads (never on a timer: the backend sleeps): when a view that shows it opens and the reading is missing or
// older than 15 minutes, after a drawing run settles, and when the person taps it. Concurrent asks share one request.

import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import { hashString } from '../shared/comic/hash';
import { formatUsd } from '../shared/comic/models';
import { balanceIsFresh, spendableUsd, type ProviderBalanceReport } from '../shared/providerBalances';
import { checkPersonalProviderBalance } from './accountProviderUsage';
import { API_KEYS_CHANGED, getAccountKeyMeta, getProviderKeyValue } from './apiKeys';
import { SOURCE_GOVERNANCE_CHANGED, isProviderEnabled } from './sourceGovernance';

export type KeyBalanceState = 'idle' | 'checking' | 'ready' | 'unavailable' | 'unsupported' | 'missing';

export interface KeyBalanceSnapshot {
  /** The credential this reading belongs to (a fingerprint; '' when there is no own OpenRouter key). */
  scope: string;
  state: KeyBalanceState;
  /** The newest provider reading for this credential (kept through a failed refresh). */
  report: ProviderBalanceReport | null;
}

const EMPTY: KeyBalanceSnapshot = Object.freeze({ scope: '', state: 'idle', report: null }) as KeyBalanceSnapshot;

let snapshot: KeyBalanceSnapshot = EMPTY;
let inflight: { scope: string; promise: Promise<void> } | null = null;
const listeners = new Set<() => void>();

const publish = (next: KeyBalanceSnapshot) => {
  snapshot = next;
  listeners.forEach((l) => l());
};

/**
 * Which own OpenRouter credential the balance follows: the active key on this device, else the account's saved key.
 * '' when there is none or OpenRouter is turned off. Never the key: a short fingerprint or the account key's suffix.
 */
export const ownKeyScope = (): string => {
  try {
    if (!isProviderEnabled('openrouter')) return '';
    const local = getProviderKeyValue('openrouter');
    if (local) return `local:${hashString(local)}`;
    const account = getAccountKeyMeta().find((m) => m.provider === 'openrouter');
    return account?.suffix ? `account:${account.suffix}` : '';
  } catch {
    return '';
  }
};

/** The reading for a credential (EMPTY for any other one). Stable between changes (useSyncExternalStore). */
export const keyBalanceFor = (scope: string): KeyBalanceSnapshot => (scope && snapshot.scope === scope ? snapshot : EMPTY);

export const subscribeKeyBalance = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

const newer = (a: ProviderBalanceReport | null, b: ProviderBalanceReport | null): ProviderBalanceReport | null =>
  !a ? b : !b ? a : b.checkedAt >= a.checkedAt ? b : a;

/**
 * Read the provider again for the current own key. Without `force`, only when there is no reading yet or it is older
 * than 15 minutes. A failure keeps the previous reading (with its own time). Never throws.
 */
export function refreshKeyBalance(ownerId: string | null | undefined, opts: { force?: boolean } = {}): Promise<void> {
  const scope = ownKeyScope();
  if (!ownerId || !scope) return Promise.resolve();
  const current = keyBalanceFor(scope);
  if (!opts.force && current.report && balanceIsFresh(current.report)) return Promise.resolve();
  if (inflight?.scope === scope) return inflight.promise;
  publish({ scope, state: 'checking', report: current.report });
  const controller = new AbortController();
  // Started inside a promise so a read that throws at once still lands in the catch: this never throws.
  const promise = Promise.resolve()
    .then(() => checkPersonalProviderBalance(ownerId, 'openrouter', controller.signal))
    .then(({ report }) => {
      if (ownKeyScope() !== scope) return; // the key changed while we read: this reading is not for it
      const before = keyBalanceFor(scope).report;
      if (report.status === 'reported') publish({ scope, state: 'ready', report: newer(before, report) });
      else publish({ scope, state: report.status === 'unsupported' || report.status === 'missing' ? report.status : 'unavailable', report: before });
    })
    .catch(() => {
      if (ownKeyScope() === scope) publish({ scope, state: 'unavailable', report: keyBalanceFor(scope).report });
    })
    .finally(() => {
      if (inflight?.promise === promise) inflight = null;
    });
  inflight = { scope, promise };
  return promise;
}

/** A reading another view just took for the own OpenRouter key (Settings' "Check provider"): the header shows it too. */
export function seedKeyBalance(report: ProviderBalanceReport | null | undefined): void {
  if (!report || report.provider !== 'openrouter' || report.status !== 'reported') return;
  const scope = ownKeyScope();
  if (!scope) return;
  const current = keyBalanceFor(scope);
  if (current.report && current.report.checkedAt >= report.checkedAt) return;
  publish({ scope, state: current.state === 'checking' ? 'checking' : 'ready', report });
}

/** Test hook: forget every reading. */
export const __resetKeyBalanceForTests = (): void => {
  inflight = null;
  publish(EMPTY);
};

// ── Words ───────────────────────────────────────────────────────────────────

/** "just now" · "5 min ago" · "3 h ago" · "on 12 Nov" — when the provider reported it. */
export const readingAge = (checkedAt: number, now: number = Date.now()): string => {
  const ms = Math.max(0, now - checkedAt);
  if (ms < 60_000) return 'just now';
  if (ms < 60 * 60_000) return `${Math.floor(ms / 60_000)} min ago`;
  if (ms < 24 * 60 * 60_000) return `${Math.floor(ms / (60 * 60_000))} h ago`;
  return `on ${new Date(checkedAt).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}`;
};

/** "about 5 minutes ago" for a screen reader. */
const spokenAge = (checkedAt: number, now: number): string => {
  const age = readingAge(checkedAt, now);
  return age.replace(/(\d+) min ago/, (_m, n) => `${n} minute${n === '1' ? '' : 's'} ago`).replace(/(\d+) h ago/, (_m, n) => `${n} hour${n === '1' ? '' : 's'} ago`);
};

export interface KeyBalanceView {
  /** USD this key can still spend (the smaller of its limit left and the account's credits). */
  leftUsd: number;
  /** "$12.40" */
  amount: string;
  /** "5 min ago" */
  age: string;
  stale: boolean;
  /** "OpenRouter balance: $12.40 left, read 5 minutes ago." */
  spoken: string;
}

/** What a reading shows, or null when the provider did not share a balance for this key (shown as unknown). */
export function keyBalanceView(report: ProviderBalanceReport | null | undefined, now: number = Date.now()): KeyBalanceView | null {
  const left = spendableUsd(report);
  if (left === null || !report) return null;
  const amount = formatUsd(left);
  return {
    leftUsd: left,
    amount,
    age: readingAge(report.checkedAt, now),
    stale: !balanceIsFresh(report, now),
    spoken: `OpenRouter balance: ${amount} left, read ${spokenAge(report.checkedAt, now)}.`
  };
}

// ── Hook ────────────────────────────────────────────────────────────────────

/** The own-key credential, followed live (keys added, switched or removed; OpenRouter turned on or off). */
export function useOwnKeyScope(): string {
  const [scope, setScope] = useState(ownKeyScope);
  useEffect(() => {
    const update = () => setScope(ownKeyScope());
    for (const name of [API_KEYS_CHANGED, SOURCE_GOVERNANCE_CHANGED, 'storage']) window.addEventListener(name, update);
    update();
    return () => {
      for (const name of [API_KEYS_CHANGED, SOURCE_GOVERNANCE_CHANGED, 'storage']) window.removeEventListener(name, update);
    };
  }, []);
  return scope;
}

/**
 * The own OpenRouter key's balance for a view: reads when the view opens and the reading is missing or stale (while
 * `enabled`), and `refresh()` reads now (a tap, a run that settled).
 */
export function useKeyBalance(ownerId: string | null | undefined, opts: { enabled?: boolean } = {}) {
  const enabled = opts.enabled !== false;
  const scope = useOwnKeyScope();
  const snap = useSyncExternalStore(subscribeKeyBalance, () => keyBalanceFor(scope), () => EMPTY);
  useEffect(() => {
    if (enabled && ownerId && scope) void refreshKeyBalance(ownerId);
  }, [enabled, ownerId, scope]);
  const refresh = useCallback(() => refreshKeyBalance(ownerId, { force: true }), [ownerId]);
  return { ...snap, scope, refresh };
}
