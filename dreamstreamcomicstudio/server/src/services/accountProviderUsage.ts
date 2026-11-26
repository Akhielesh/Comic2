import { createHmac } from 'node:crypto';
import type { AccountProviderUsageReport, AccountProviderUsageRow, ProviderBalanceRefresh } from '../../../shared/accountProviderUsage.js';
import {
  BALANCE_FRESH_MS,
  balanceIsFresh,
  normalizeSavedBalanceReport,
  PROVIDER_BALANCE_CAPABILITIES,
  type BalanceProvider,
  type ProviderBalanceReport
} from '../../../shared/providerBalances.js';
import { getProviderDef } from '../../../shared/providers.js';
import { isKnownConnectorProvider } from '../lib/providerUsage.js';
import { readAccountBalanceKeys } from '../middleware/accountKeys.js';
import { getProviderBalanceReport } from './providerBalances.js';
import { getSupabaseAdmin } from './supabase.js';

type PersonalKeys = Partial<Record<BalanceProvider, string>>;
type ScopedCredential = { ownerId: string | null; provider: BalanceProvider; key: string | null };
const supported = (provider: BalanceProvider) => PROVIDER_BALANCE_CAPABILITIES[provider] !== 'dashboard';

export function platformBalanceKey(provider: BalanceProvider): string | null {
  const def = getProviderDef(provider);
  if (def) return process.env[def.keyEnv]?.trim() || null;
  if (provider === 'pixazo') return process.env.PIXAZO_API_KEY || process.env.PIXAZO_SUBSCRIPTION_KEY || process.env.FLUX_API_KEY || null;
  return provider === 'ideogram' ? process.env.IDEOGRAM_API_KEY || null : null;
}

function balanceBinding({ ownerId, provider, key }: ScopedCredential): string | null {
  const secret = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!secret || !key) return null;
  return createHmac('sha256', secret).update(JSON.stringify(['provider-balance-v1', ownerId, provider, key])).digest('hex');
}

export async function refreshProviderBalance(credential: ScopedCredential, opts: { fresh?: boolean } = {}): Promise<ProviderBalanceRefresh> {
  const { ownerId, provider, key } = credential;
  const report = await getProviderBalanceReport({ ownerId: ownerId ?? 'platform', provider, key, ...(opts.fresh ? { fresh: true } : {}) });
  const binding = balanceBinding(credential);
  if (report.status !== 'reported' || !binding) return { report, saved: false };
  try {
    const { error } = await getSupabaseAdmin().rpc('record_provider_balance', { p_owner: ownerId, p_binding: binding, p_report: report });
    return { report, saved: !error };
  } catch {
    return { report, saved: false };
  }
}

/** The newest saved observation for exactly this credential (owner, provider, key), or null. Throws when unreadable. */
async function savedObservation(credential: ScopedCredential, binding: string): Promise<ProviderBalanceReport | null> {
  const { ownerId, provider } = credential;
  let q = getSupabaseAdmin().from('provider_balance_observations').select('report').eq('provider', provider).eq('credential_binding', binding);
  q = ownerId === null ? q.is('owner_id', null) : q.eq('owner_id', ownerId);
  const { data, error } = await q.order('checked_at', { ascending: false }).limit(1).maybeSingle();
  if (error) throw new Error('Observation history unavailable');
  return normalizeSavedBalanceReport(data?.report, provider);
}

/** latestOwnKeyBalance's provider reads: one in flight per credential, shared by every check that asks meanwhile. */
const ownKeyReads = new Map<string, Promise<ProviderBalanceReport | null>>();
/** After a read that failed or outlasted its wait, the provider is not asked again for this credential until then. */
const ownKeyCooldown = new Map<string, number>();
const OWN_KEY_RETRY_MS = 2 * 60_000;
const TIMED_OUT = Symbol('timed out');

const coolDown = (binding: string, now: number) => {
  if (ownKeyCooldown.size >= 2048 && !ownKeyCooldown.has(binding)) ownKeyCooldown.delete(ownKeyCooldown.keys().next().value!);
  ownKeyCooldown.set(binding, now + OWN_KEY_RETRY_MS);
};

/** Test hook: forget the shared reads and cooldowns. */
export const __resetOwnKeyBalanceReadsForTests = (): void => {
  ownKeyReads.clear();
  ownKeyCooldown.clear();
};

/**
 * The reading a paid step compares with (Comic Studio's balance check before spending): this owner's saved observation
 * of exactly this key while it is younger than `maxAgeMs` (default and at most BALANCE_FRESH_MS), else a read through the
 * same code as POST /api/keys/balance (saved for next time; a stricter `maxAgeMs` also skips the provider read's 60 s
 * cache, for a check about to refuse a step on a reading taken before a top-up).
 *
 * Bounded: one read in flight per credential, at most `timeoutMs` of waiting, and after a read that failed or timed out
 * no new one for two minutes. A read that fails, times out or is skipped leaves the saved reading while it is still
 * under BALANCE_FRESH_MS old, else null: a stale reading never decides anything, so the caller proceeds as if the balance
 * were unknown. Unsupported providers, a missing key and a server without the binding secret are unknown too. Never throws.
 */
export async function latestOwnKeyBalance(
  credential: { ownerId: string; provider: BalanceProvider; key: string },
  opts: { timeoutMs?: number; now?: () => number; maxAgeMs?: number } = {}
): Promise<ProviderBalanceReport | null> {
  const now = opts.now ?? Date.now;
  const maxAgeMs = Math.min(BALANCE_FRESH_MS, Math.max(0, opts.maxAgeMs ?? BALANCE_FRESH_MS));
  const scoped: ScopedCredential = { ownerId: credential.ownerId, provider: credential.provider, key: credential.key?.trim() || null };
  if (!scoped.ownerId || !scoped.key || !supported(scoped.provider)) return null;
  const binding = balanceBinding(scoped);
  if (!binding) return null;
  let previous: ProviderBalanceReport | null = null;
  try {
    previous = await savedObservation(scoped, binding);
    if (previous && now() - previous.checkedAt < maxAgeMs && balanceIsFresh(previous, now())) return previous;
  } catch {
    /* no saved history right now: read the provider instead */
  }
  const fallback = previous && balanceIsFresh(previous, now()) ? previous : null;
  if ((ownKeyCooldown.get(binding) ?? 0) > now()) return fallback;
  let read = ownKeyReads.get(binding);
  if (!read) {
    const started: Promise<ProviderBalanceReport | null> = refreshProviderBalance(scoped, maxAgeMs < BALANCE_FRESH_MS ? { fresh: true } : {})
      .then(({ report }) => (report.status === 'reported' ? report : null))
      .catch(() => null)
      .then((report) => {
        if (report) ownKeyCooldown.delete(binding);
        else coolDown(binding, now());
        return report;
      })
      .finally(() => {
        if (ownKeyReads.get(binding) === started) ownKeyReads.delete(binding);
      });
    ownKeyReads.set(binding, started);
    read = started;
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<typeof TIMED_OUT>((resolve) => {
    timer = setTimeout(() => resolve(TIMED_OUT), opts.timeoutMs ?? 3_500);
    (timer as { unref?: () => void }).unref?.();
  });
  try {
    const result = await Promise.race([read, late]);
    if (result === TIMED_OUT) {
      // The read carries on (and saves a reading for the next check when it lands); this step does not wait for it.
      coolDown(binding, now());
      return fallback;
    }
    return result ?? fallback;
  } finally {
    clearTimeout(timer);
  }
}

// Active dashboard reads revalidate stale observations without delaying the response.
const FRESH_MS = BALANCE_FRESH_MS;
const RETRY_MS = 2 * 60_000;
const MAX_PROBES = 8;
const backgroundProbes = new Set<string>();
const retryAfter = new Map<string, number>();

function revalidateBalance(credential: ScopedCredential, binding: string, previous: ProviderBalanceReport | null, now: number): boolean {
  if (previous && now - previous.checkedAt < FRESH_MS) return false;
  if (backgroundProbes.has(binding)) return true;
  if ((retryAfter.get(binding) ?? 0) > now || backgroundProbes.size >= MAX_PROBES) return false;
  backgroundProbes.add(binding);
  // Evict old cooldown keys at a fixed bound. A second process may also sample; the
  // database keeps the newest observation per credential and day in either order.
  if (retryAfter.size >= 2048) retryAfter.delete(retryAfter.keys().next().value!);
  retryAfter.set(binding, now + RETRY_MS);
  void refreshProviderBalance(credential).then(({ report, saved }) => {
    if (saved && report.status === 'reported') retryAfter.set(binding, report.checkedAt + FRESH_MS);
  }).catch(() => { /* keep the last observation and the short backoff */ })
    .finally(() => backgroundProbes.delete(binding));
  return true;
}

async function readBalances(ownerId: string | null, keys: PersonalKeys, allow: (provider: BalanceProvider) => boolean = () => true) {
  const keysWithReports = (Object.entries(keys) as [BalanceProvider,string][]).filter(([provider, key]) => key && supported(provider));
  let balancesRefreshing = false;
  const observations = await Promise.all(keysWithReports.map(async ([provider, key]) => {
    const binding = balanceBinding({ ownerId, provider, key });
    if (!binding) throw new Error('Credential binding unavailable');
    const previous = await savedObservation({ ownerId, provider, key }, binding);
    if (allow(provider) && revalidateBalance({ownerId, provider, key}, binding, previous, Date.now())) balancesRefreshing = true;
    return previous;
  }));
  return { balanceReports: observations.filter((x): x is ProviderBalanceReport => x !== null), balancesRefreshing };
}

export async function platformBalanceHistory() {
  const providers = Object.keys(PROVIDER_BALANCE_CAPABILITIES) as BalanceProvider[];
  const keys: PersonalKeys = {};
  for (const provider of providers) {
    const key = platformBalanceKey(provider);
    if (key && supported(provider)) keys[provider] = key;
  }
  try { return { ...await readBalances(null, keys), available: true }; }
  catch { return { balanceReports: [], available: false }; }
}

type Aggregate = Record<string, unknown>;
const count = (value: unknown) => Number.isSafeInteger(Number(value)) && Number(value) > 0 ? Number(value) : 0;
const addAmount = (previous: number | null, raw: unknown): number | null => {
  if (raw == null || !Number.isFinite(Number(raw)) || Number(raw) < 0) return previous;
  return Number(((previous ?? 0) + Number(raw)).toFixed(6));
};

export function combineAccountUsage(models: Aggregate[], connectors: Aggregate[]): AccountProviderUsageRow[] {
  const result = new Map<string, AccountProviderUsageRow>();
  const row = (provider: string) => {
    const found = result.get(provider);
    if (found) return found;
    const item: AccountProviderUsageRow = { provider, modelRequests: 0, byokRequests: 0, platformRequests: 0,
      connectorCalls: 0, connectorErrors: 0, connectorBlocked: 0, reportedByokUsd: null, estimatedByokUsd: null, unpricedByokRequests: 0 };
    result.set(provider, item);
    return item;
  };
  for (const model of models) {
    const name = String(model.provider || '').toLowerCase();
    const r = row(Object.hasOwn(PROVIDER_BALANCE_CAPABILITIES, name) ? name : name === 'flux' ? 'pixazo' : 'other');
    r.byokRequests += count(model.byok_requests);
    r.platformRequests += count(model.platform_requests);
    r.modelRequests = r.byokRequests + r.platformRequests;
    r.estimatedByokUsd = addAmount(r.estimatedByokUsd, model.estimated_byok_usd);
    r.reportedByokUsd = addAmount(r.reportedByokUsd, model.reported_byok_usd);
    r.unpricedByokRequests += count(model.unpriced_byok_requests);
  }
  for (const connector of connectors) {
    const name = String(connector.provider || '');
    const r = row(isKnownConnectorProvider(name) ? name : 'other');
    r.connectorCalls += count(connector.calls);
    r.connectorErrors += count(connector.errors);
    r.connectorBlocked += count(connector.blocked);
  }
  return [...result.values()].sort((a,b) => (b.modelRequests+b.connectorCalls) - (a.modelRequests+a.connectorCalls) || a.provider.localeCompare(b.provider));
}

export async function accountProviderUsage(ownerId: string, now = new Date(), allow?: (provider: BalanceProvider) => boolean): Promise<AccountProviderUsageReport> {
  const from = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
  const to = now.toISOString();
  const nextDay = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()+1)).toISOString().slice(0,10);
  const query = async (rpc: string, start: string, end: string): Promise<Aggregate[]> => {
    const { data, error } = await getSupabaseAdmin().rpc(rpc, { p_owner: ownerId, p_from: start, p_to: end });
    if (error || !Array.isArray(data)) throw new Error('Usage history unavailable');
    return data;
  };
  const [models, connectors, balances] = await Promise.allSettled([
    query('member_provider_models', from, to),
    query('member_provider_connectors', from.slice(0,10), nextDay),
    readAccountBalanceKeys(ownerId).then(keys => readBalances(ownerId, keys, allow))
  ]);
  return {
    from, to, generatedAt: to,
    providers: combineAccountUsage(models.status === 'fulfilled' ? models.value : [], connectors.status === 'fulfilled' ? connectors.value : []),
    sources: {
      models: models.status === 'fulfilled' ? 'available' : 'unavailable',
      connectors: connectors.status === 'fulfilled' ? 'available' : 'unavailable',
      balances: balances.status === 'fulfilled' ? 'available' : 'unavailable'
    },
    balanceReports: balances.status === 'fulfilled' ? balances.value.balanceReports : [],
    balancesRefreshing: balances.status === 'fulfilled' && balances.value.balancesRefreshing
  };
}
