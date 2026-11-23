import { createHash } from 'node:crypto';
import {
  normalizeSavedBalanceReport,
  PROVIDER_BALANCE_CAPABILITIES,
  type BalanceProvider,
  type ProviderBalanceReport
} from '../../../shared/providerBalances.js';
import { fetchOpenRouterCredits, fetchOpenRouterKeyStatus } from '../ai/providers/openrouter.js';

const READ_TIMEOUT_MS = 5_000;
const CACHE_TTL_MS = 60_000;
const MAX_ENTRIES = 512;
type Data = Pick<ProviderBalanceReport, 'accountBalances' | 'keyQuotaUsd' | 'planQuotas'>;
const noData = (): Data => ({ accountBalances: null, keyQuotaUsd: null });
const cache = new Map<string, { expires: number; pending: Promise<ProviderBalanceReport> }>();

const obj = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};

const amount = (value: unknown): number | null => {
  const n = typeof value === 'string' && /^-?\d+(?:\.\d+)?$/.test(value) ? Number(value) : value;
  return typeof n === 'number' && Number.isFinite(n) && Math.abs(n) <= Number.MAX_SAFE_INTEGER ? n : null;
};
const percent = (value: unknown): number | null => {
  const n = amount(value);
  return n !== null && n >= 0 && n <= 100 ? n : null;
};

// GET /key reports key spend and its own cap. GET /credits requires a management
// credential. A missing cap says nothing about the account's available credit.
// https://openrouter.ai/docs/api/api-reference/credits/get-remaining-credits
// https://openrouter.ai/docs/api/api-reference/api-keys/get-current-key
async function openRouterData(key: string): Promise<Data> {
  const info = await fetchOpenRouterKeyStatus(key, READ_TIMEOUT_MS);
  const credits = info?.is_management_key === false ? null : await fetchOpenRouterCredits(key, READ_TIMEOUT_MS);
  const quota = { limit: amount(info?.limit), remaining: amount(info?.limit_remaining), usage: amount(info?.usage) };
  const remaining = amount(credits?.remaining);
  return {
    accountBalances: remaining === null ? null : [{ currency: 'USD', remaining }],
    keyQuotaUsd: Object.values(quota).some(value => value !== null) ? quota : null
  };
}

// Personal credentials go only to these official read-only addresses, regardless of
// any configured platform base URL. No redirects, upstream bodies, or key material
// are exposed to the caller or logs.
// https://api-docs.deepseek.com/api/get-user-balance/
// https://github.com/zai-org/zai-coding-plugins/tree/main/plugins/glm-plan-usage
// https://platform.minimax.io/subscribe/token-plan
const endpoints = {
  deepseek: 'https://api.deepseek.com/user/balance',
  zai: 'https://api.z.ai/api/monitor/usage/quota/limit',
  minimax: 'https://www.minimax.io/v1/token_plan/remains'
} as const;

async function query(provider: keyof typeof endpoints, key: string): Promise<Record<string, unknown>> {
  const response = await fetch(endpoints[provider], {
    method: 'GET',
    headers: { Authorization: provider === 'zai' ? key : 'Bearer ' + key, Accept: 'application/json' },
    redirect: 'error',
    signal: AbortSignal.timeout(READ_TIMEOUT_MS)
  });
  return response.ok ? obj(await response.json()) : {};
}

function deepSeekData(body: Record<string, unknown>): Data {
  const balances: NonNullable<Data['accountBalances']> = [];
  for (const entry of Array.isArray(body.balance_infos) ? body.balance_infos : []) {
    const { currency, total_balance } = obj(entry);
    const remaining = amount(total_balance);
    if ((currency === 'USD' || currency === 'CNY') && remaining !== null) balances.push({ currency, remaining });
  }
  return { accountBalances: balances.length ? balances : null, keyQuotaUsd: null };
}

function zaiQuotas(body: Record<string, unknown>): NonNullable<Data['planQuotas']> {
  const rows = obj(body.data).limits;
  if (body.success === false || !Array.isArray(rows)) return [];
  return rows.flatMap(entry => {
    const row = obj(entry);
    const label = row.type === 'TOKENS_LIMIT' ? 'Token allowance' : row.type === 'TIME_LIMIT' ? 'MCP tool allowance' : null;
    const used = percent(row.percentage);
    if (!label || used === null) return [];
    const reset = amount(row.nextResetTime);
    const suffix = reset !== null && reset > 0 && reset < 8.64e15
      ? ' (resets ' + new Date(reset).toISOString().slice(0, 16).replace('T', ' ') + ' UTC)' : '';
    return [{ label: label + suffix, remainingPercent: 100 - used }];
  });
}

function miniMaxQuotas(body: Record<string, unknown>): NonNullable<Data['planQuotas']> {
  const base = obj(body.base_resp);
  if ((base.status_code !== undefined && base.status_code !== 0) || !Array.isArray(body.model_remains)) return [];
  const quotas: NonNullable<Data['planQuotas']> = [];
  for (const entry of body.model_remains) {
    const row = obj(entry);
    const name = row.model_name;
    if (typeof name !== 'string' || !/^[a-z0-9][a-z0-9 ._-]{0,39}$/i.test(name)) continue;
    for (const [field, period] of [['interval', 'current window'], ['weekly', 'weekly']] as const) {
      // Counts on older responses have ambiguous units. Use only explicit remaining
      // percentages. Status 3 can be an unlimited window or an unavailable model;
      // in both cases a numerical percentage would misrepresent the allowance.
      const remaining = percent(row['current_' + field + '_remaining_percent']);
      if (remaining !== null && row['current_' + field + '_status'] !== 3) {
        quotas.push({ label: name + ' ' + period, remainingPercent: remaining });
      }
    }
  }
  return quotas;
}

async function read(provider: BalanceProvider, key: string): Promise<Data> {
  if (provider === 'openrouter') return openRouterData(key);
  if (provider === 'deepseek') return deepSeekData(await query(provider, key));
  if (provider === 'zai' || provider === 'minimax') {
    const body = await query(provider, key);
    const quotas = provider === 'zai' ? zaiQuotas(body) : miniMaxQuotas(body);
    if (quotas.length) return { ...noData(), planQuotas: quotas.slice(0, 64) };
  }
  return noData();
}

export async function getProviderBalanceReport({ ownerId, provider, key }: {
  ownerId: string; provider: BalanceProvider; key: string | null;
}): Promise<ProviderBalanceReport> {
  const checkedAt = Date.now();
  const empty = { provider, checkedAt, ...noData() };
  if (!ownerId || !key?.trim()) return { ...empty, status: 'missing' };
  if (PROVIDER_BALANCE_CAPABILITIES[provider] === 'dashboard') return { ...empty, status: 'unsupported' };
  const credential = key.trim();
  const cacheKey = createHash('sha256').update(JSON.stringify([ownerId, provider, credential])).digest('hex');
  const cached = cache.get(cacheKey);
  if (cached && checkedAt < cached.expires) return cached.pending;
  if (cache.size >= MAX_ENTRIES) cache.delete(cache.keys().next().value!);
  const unavailable: ProviderBalanceReport = { ...empty, status: 'unavailable' };
  const pending = read(provider, credential)
    .then(data => normalizeSavedBalanceReport({ provider, checkedAt, ...data, status: 'reported' }, provider) ?? unavailable)
    .catch(() => unavailable);
  cache.set(cacheKey, { pending, expires: checkedAt + CACHE_TTL_MS });
  return pending;
}
