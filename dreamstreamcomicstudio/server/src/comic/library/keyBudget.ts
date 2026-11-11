// Hard caps on admin image spend (Program 3 ST-A; styles §6.3 items 3–4 and C15, PROGRAM3 §5, decision D4).
//
// Two checks, both made by startRun only — an admin's Build (or Regenerate) click — and never at import, on page
// load or on a timer, so the container stays sleepable:
//   1. The app's monthly cap: this UTC month's library spend (library_runs.spent_usd) plus the new run's budget may
//      not pass COMIC_LIBRARY_MONTHLY_CAP_USD (default $20).
//   2. The provider's own cap, checked first-hand: ONE GET {OpenRouter}/key with the admin spend key. A build is
//      refused when the key's `limit_remaining`, or the `effective_budget` that would block first (a workspace or
//      member budget), is below the run's budget. A key with no limit only warns: the app cap still holds.
// Both FAIL CLOSED: no answer, a non-2xx, or a body we can't read refuses the build, and nothing is spent. Errors
// never carry the key, a header or the provider's body — only the HTTP status.
// OpenRouter documents the response (https://openrouter.ai/docs/api-reference/limits, read 2026-11-05):
// { data: { limit, limit_reset, limit_remaining, usage_monthly, budgets[], effective_budget: Budget | null, … } }
// with Budget { scope, limit_usd, spend_usd, remaining_usd, reset_interval, resets_at, … }.

import { OPENROUTER_BASE_URL } from '../../config.js';
import type { AdminSpendKey } from '../../../../shared/comic/library.js';
import { StudioError } from '../types.js';
import { adminSpendKeyEnvName, adminSpendKeyLabel } from './adminSpend.js';

/** The preflight's own deadline for the whole answer, body included (a request-scoped timer, cleared when it settles). */
export const KEY_BUDGET_TIMEOUT_MS = 8000;

/** The provider-side limit of the admin spend key at one moment. Amounts in USD. */
export interface ProviderKeyBudget {
  /** The key's credit limit; null = unlimited. */
  limitUsd: number | null;
  /** Credit left under that limit; null when the key has no limit. */
  remainingUsd: number | null;
  /** 'daily' | 'weekly' | 'monthly' | null. */
  limitReset: string | null;
  /** Spent on this key in the current UTC month. */
  usageMonthlyUsd: number | null;
  /** The budget that blocks requests first (workspace, member or key), when one applies. */
  budget: { scope: string; limitUsd: number | null; remainingUsd: number | null; resetsAt: string | null } | null;
  checkedAt: number;
}

/** One provider check: resolves the key's budget or throws a StudioError (fail closed). Never logs the key. */
export type KeyBudgetCheck = (key: string, label?: AdminSpendKey) => Promise<ProviderKeyBudget>;

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v)) ? Number(v) : null);
const str = (v: unknown, max = 40): string | null => (typeof v === 'string' && v ? v.slice(0, max) : null);
const money = (n: number) => `$${(Math.round(n * 100) / 100).toFixed(2)}`;

/** The documented /key body → a budget; null when it isn't one (the caller refuses the build). */
export function parseKeyBudget(body: unknown, now: number): ProviderKeyBudget | null {
  const data = (body as { data?: unknown } | null)?.data;
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  const d = data as Record<string, unknown>;
  // `limit` must be present (a number, or null for "unlimited"); anything else is not the documented shape.
  if (!('limit' in d) || (d.limit !== null && num(d.limit) === null)) return null;
  const limitUsd = num(d.limit);
  const remaining = num(d.limit_remaining);
  // A limited key that doesn't say what is left can't be checked: refuse rather than guess.
  if (limitUsd !== null && remaining === null) return null;
  const eb = d.effective_budget;
  let budget: ProviderKeyBudget['budget'] = null;
  if (eb && typeof eb === 'object' && !Array.isArray(eb)) {
    const b = eb as Record<string, unknown>;
    const left = num(b.remaining_usd);
    if (left === null) return null; // a blocking budget we can't read is not a pass
    budget = { scope: str(b.scope) ?? 'budget', limitUsd: num(b.limit_usd), remainingUsd: left, resetsAt: str(b.resets_at, 40) };
  }
  return { limitUsd, remainingUsd: limitUsd === null ? null : remaining, limitReset: str(d.limit_reset, 20), usageMonthlyUsd: num(d.usage_monthly), budget, checkedAt: now };
}

const nothingSpent = 'No build was started and nothing was spent.';

/**
 * The production check: GET {OPENROUTER_BASE_URL}/key with the admin spend key as a Bearer header. `fetch` and the
 * base URL are injectable (tests); the default fetch is resolved at call time, so importing this module fetches
 * nothing.
 */
export function createOpenRouterKeyBudget(opts: { fetch?: typeof fetch; baseUrl?: string; timeoutMs?: number; now?: () => number } = {}): KeyBudgetCheck {
  return async (key, label = 'modeltest') => {
    const words = adminSpendKeyLabel(label);
    const doFetch = opts.fetch ?? (typeof globalThis.fetch === 'function' ? globalThis.fetch.bind(globalThis) : undefined);
    if (!doFetch) throw new StudioError('NOT_AVAILABLE', `This server can't reach OpenRouter to check the ${words}'s limit. ${nothingSpent}`, { status: 503 });
    const ctrl = new AbortController();
    // One deadline for the whole answer — headers AND body — so a stalled body fails closed after the timeout
    // instead of holding the admin's Build request open. Cleared on every path before this returns.
    const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? KEY_BUDGET_TIMEOUT_MS);
    (timer as { unref?: () => void }).unref?.();
    try {
      let res: Response;
      try {
        res = await doFetch(`${(opts.baseUrl ?? OPENROUTER_BASE_URL).replace(/\/+$/, '')}/key`, {
          method: 'GET',
          headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' },
          signal: ctrl.signal
        });
      } catch {
        throw new StudioError('NOT_AVAILABLE', `OpenRouter didn't answer the check on the ${words}'s limit. ${nothingSpent} Try again in a minute.`, { status: 503, retryable: true });
      }
      if (res.status === 401 || res.status === 403) {
        throw new StudioError('NOT_AVAILABLE', `OpenRouter didn't accept the ${words} (HTTP ${res.status}). Check ${adminSpendKeyEnvName(label)} on the server. ${nothingSpent}`, { status: 503 });
      }
      if (!res.ok) {
        throw new StudioError('NOT_AVAILABLE', `OpenRouter couldn't report the ${words}'s limit (HTTP ${res.status}). ${nothingSpent} Try again in a minute.`, { status: 503, retryable: true });
      }
      let body: unknown;
      try {
        body = await res.json(); // still under the deadline: an abort here is "couldn't be read" below
      } catch {
        body = null;
      }
      const budget = parseKeyBudget(body, (opts.now ?? Date.now)());
      if (!budget) throw new StudioError('NOT_AVAILABLE', `OpenRouter's answer about the ${words}'s limit couldn't be read. ${nothingSpent}`, { status: 503 });
      return budget;
    } finally {
      clearTimeout(timer);
    }
  };
}

/** Pass (maybe with a warning), or refuse with a calm sentence (`message`) the console shows as is. */
export interface SpendVerdict {
  ok: boolean;
  /** Why a build is refused (set whenever ok is false). */
  message?: string;
  /** A pass with something the admin should know. */
  warning?: string;
}

/**
 * The provider check's verdict for a run budget: refuse when the key's remaining limit, or the budget that blocks
 * first, is below it; warn (don't refuse) when the key has no limit at all.
 */
export function judgeKeyBudget(b: ProviderKeyBudget, budgetUsd: number, label: AdminSpendKey = 'modeltest', monthCapUsd?: number): SpendVerdict {
  const words = adminSpendKeyLabel(label);
  if (b.remainingUsd !== null && b.remainingUsd + 1e-9 < budgetUsd) {
    return { ok: false, message: `The ${words} has ${money(Math.max(0, b.remainingUsd))} left of its ${money(b.limitUsd ?? 0)} OpenRouter limit, less than this build's ${money(budgetUsd)} budget. Lower the budget or raise the key's limit in OpenRouter. ${nothingSpent}` };
  }
  if (b.budget && b.budget.remainingUsd !== null && b.budget.remainingUsd + 1e-9 < budgetUsd) {
    return { ok: false, message: `OpenRouter's ${b.budget.scope.replace(/_/g, ' ')} budget on the ${words} has ${money(Math.max(0, b.budget.remainingUsd))} left, less than this build's ${money(budgetUsd)} budget. ${nothingSpent}` };
  }
  if (b.limitUsd === null && !b.budget) {
    const cap = typeof monthCapUsd === 'number' ? ` only the app's ${money(monthCapUsd)} monthly cap applies` : ' only the app cap applies';
    return { ok: true, warning: `The ${words} has no OpenRouter limit, so${cap}. Set a monthly limit on the key in OpenRouter.` };
  }
  return { ok: true };
}

/** First instant of the UTC month `now` falls in. */
export const utcMonthStartIso = (now: number): string => {
  const d = new Date(now);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)).toISOString();
};

/** The app's monthly cap: this month's spend plus the new budget may not pass it. */
export function judgeMonthlyCap(monthSpentUsd: number, budgetUsd: number, capUsd: number, now: number): SpendVerdict {
  const left = Math.max(0, capUsd - monthSpentUsd);
  if (monthSpentUsd + budgetUsd <= capUsd + 1e-9) return { ok: true };
  const d = new Date(now);
  const resets = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1)).toISOString().slice(0, 10);
  if (left < 0.01) {
    return { ok: false, message: `This month's library cap of ${money(capUsd)} is used up (${money(monthSpentUsd)} spent). It resets on ${resets} (UTC). ${nothingSpent}` };
  }
  return {
    ok: false,
    message: `This build's ${money(budgetUsd)} budget would pass this month's library cap of ${money(capUsd)} (${money(monthSpentUsd)} already spent). Lower the budget to ${money(Math.floor(left * 100) / 100)} or less, or wait until ${resets} (UTC). ${nothingSpent}`
  };
}
