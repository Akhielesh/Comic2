import type { ProviderBalanceRefresh } from '../shared/accountProviderUsage';
import { normalizeSavedBalanceReport, type BalanceProvider, type ProviderBalanceReport } from '../shared/providerBalances';
import { ownerBearer } from './accountProviderUsage';
import { buildApiUrl } from './clientConfig';

export type PlatformBalanceHistory = { available: boolean; balancesRefreshing?: boolean; balanceReports: ProviderBalanceReport[] };

async function request(ownerId: string, signal: AbortSignal, provider?: BalanceProvider) {
  const auth = await ownerBearer(ownerId, signal);
  const path = '/api/admin/provider-balances' + (provider ? '/' + provider : '');
  const response = await fetch(buildApiUrl(path), {
    method: provider ? 'POST' : 'GET', headers: { Authorization: auth },
    signal, cache: 'no-store', redirect: 'error'
  });
  if (!response.ok) throw new Error('Platform readings unavailable');
  return response.json();
}

export async function getPlatformBalances(ownerId: string, signal: AbortSignal): Promise<PlatformBalanceHistory> {
  const data = await request(ownerId, signal);
  if (typeof data?.available !== 'boolean' || !Array.isArray(data.balanceReports)) throw new Error('Platform readings unavailable');
  return {
    available: data.available,
    balancesRefreshing: data.balancesRefreshing === true,
    balanceReports: data.balanceReports.flatMap((entry: ProviderBalanceReport) => {
      const report = entry && normalizeSavedBalanceReport(entry, entry.provider);
      return report ? [report] : [];
    })
  };
}

export async function refreshPlatformBalance(ownerId: string, provider: BalanceProvider, signal: AbortSignal): Promise<ProviderBalanceRefresh> {
  const data = await request(ownerId, signal, provider);
  const report = data?.report;
  if (report?.provider !== provider || typeof data.saved !== 'boolean') throw new Error('Invalid provider reading');
  if (report.status === 'reported') {
    const clean = normalizeSavedBalanceReport(report, provider);
    if (clean) return { report: clean, saved: data.saved };
  } else if (['missing', 'unsupported', 'unavailable'].includes(report.status)) {
    return { report: { provider, status: report.status, checkedAt: Date.now(), keyQuotaUsd: null, accountBalances: null }, saved: false };
  }
  throw new Error('Invalid provider reading');
}
