import type { ProviderId } from './providers.js';

export type BalanceProvider = ProviderId | 'pixazo' | 'ideogram' | 'sarvam';
export type BalanceCapability = 'account_and_key' | 'account' | 'plan_quota' | 'dashboard';
export const PROVIDER_BALANCE_CAPABILITIES: Record<BalanceProvider, BalanceCapability> = {
  openrouter: 'account_and_key',
  deepseek: 'account',
  zai: 'plan_quota',
  minimax: 'plan_quota',
  openai: 'dashboard',
  anthropic: 'dashboard',
  gemini: 'dashboard',
  nvidia: 'dashboard',
  tencent: 'dashboard',
  xai: 'dashboard',
  pixazo: 'dashboard',
  ideogram: 'dashboard',
  sarvam: 'dashboard'
};

export interface ProviderBalanceReport {
  provider: BalanceProvider;
  status: 'reported' | 'unavailable' | 'unsupported' | 'missing';
  /** Unix milliseconds at the original read. */
  checkedAt: number;
  accountBalances: Array<{ currency: 'USD' | 'CNY'; remaining: number }> | null;
  keyQuotaUsd: { limit: number | null; remaining: number | null; usage: number | null } | null;
  planQuotas?: Array<{ label: string; remainingPercent: number }>;
}

/** A reading older than this is stale: the studio and Settings read again when a view opens, and a paid step re-reads
 *  it on the server before it compares (the dashboard's own background revalidation uses the same 15 minutes). */
export const BALANCE_FRESH_MS = 15 * 60_000;

export const balanceIsFresh = (report: Pick<ProviderBalanceReport, 'checkedAt'>, now: number = Date.now()): boolean =>
  Number.isFinite(report.checkedAt) && now - report.checkedAt < BALANCE_FRESH_MS;

/**
 * What this key can still spend, in USD: the smaller of the key's own remaining limit and the account's USD credits,
 * from whichever of the two the provider reported (an account below a key's limit caps the key, and the other way
 * round). null when neither was reported (a key with no limit on an account whose credits this key may not read).
 */
export function spendableUsd(report: ProviderBalanceReport | null | undefined): number | null {
  if (!report || report.status !== 'reported') return null;
  const amounts: number[] = [];
  const key = report.keyQuotaUsd?.remaining;
  if (typeof key === 'number' && Number.isFinite(key)) amounts.push(key);
  for (const entry of report.accountBalances ?? []) {
    if (entry.currency === 'USD' && Number.isFinite(entry.remaining)) amounts.push(entry.remaining);
  }
  return amounts.length ? Math.max(0, Math.min(...amounts)) : null;
}

const record = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {};
const finite = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= Number.MAX_SAFE_INTEGER ? v : null;

/** Rebuild saved measurements using only supported fields and units for this provider. */
export function normalizeSavedBalanceReport(value: unknown, expectedProvider: BalanceProvider): ProviderBalanceReport | null {
  const input = record(value);
  if (input.provider !== expectedProvider || input.status !== 'reported') return null;
  const checkedAt = finite(input.checkedAt);
  if (checkedAt === null || !Number.isSafeInteger(checkedAt) || checkedAt <= 0 || checkedAt > 8.64e15) return null;
  const capability = PROVIDER_BALANCE_CAPABILITIES[expectedProvider];
  const report: ProviderBalanceReport = { provider: expectedProvider, status: 'reported', checkedAt, accountBalances: null, keyQuotaUsd: null };
  if ((capability === 'account' || capability === 'account_and_key') && Array.isArray(input.accountBalances)) {
    const balances: NonNullable<ProviderBalanceReport['accountBalances']> = [];
    for (const entry of input.accountBalances.slice(0, 2)) {
      const row = record(entry);
      const currency = row.currency;
      const remaining = finite(row.remaining);
      if ((currency === 'USD' || (currency === 'CNY' && expectedProvider === 'deepseek')) && remaining !== null && !balances.some(b => b.currency === currency)) {
        balances.push({ currency, remaining });
      }
    }
    if (balances.length) report.accountBalances = balances;
  }
  if (capability === 'account_and_key') {
    const raw = record(input.keyQuotaUsd);
    const quota = { limit: finite(raw.limit), remaining: finite(raw.remaining), usage: finite(raw.usage) };
    if (Object.values(quota).some(v => v !== null)) report.keyQuotaUsd = quota;
  }
  if (capability === 'plan_quota' && Array.isArray(input.planQuotas)) {
    const quotas = input.planQuotas.slice(0, 64).flatMap(entry => {
      const row = record(entry);
      const percent = finite(row.remainingPercent);
      if (typeof row.label !== 'string' || !/^[a-z0-9 ()_.:-]{1,80}$/i.test(row.label) || percent === null || percent < 0 || percent > 100) return [];
      return [{ label: row.label, remainingPercent: percent }];
    });
    if (quotas.length) report.planQuotas = quotas;
  }
  return report.accountBalances || report.keyQuotaUsd || report.planQuotas?.length ? report : null;
}
