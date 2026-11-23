import type { AccountProviderUsageReport } from '../shared/accountProviderUsage';
import type { ProviderBalanceReport } from '../shared/providerBalances';
import { getProviderKeyValue, PROVIDER_META, type ApiKeyProvider } from './apiKeys';
import { buildApiUrl } from './clientConfig';
import { isLocalOwner } from './localOwner';
import { allowedSourcesHeader, isProviderEnabled } from './sourceGovernance';
import { isStoredSession, supabase } from './supabase';

// These endpoints need only an account bearer. Only an explicit balance check may add
// the selected personal key. The normal model API client attaches other provider keys.
export async function ownerBearer(ownerId: string, signal: AbortSignal): Promise<string> {
  const { data: { session } } = await supabase.auth.getSession();
  if (signal.aborted || !session?.access_token || session.user.id !== ownerId || !isStoredSession(session)) {
    throw new Error('Account unavailable');
  }
  return `Bearer ${session.access_token}`;
}

export async function fetchAccountProviderUsage(ownerId: string, signal: AbortSignal): Promise<AccountProviderUsageReport> {
  const authorization = await ownerBearer(ownerId, signal);
  const response = await fetch(buildApiUrl('/api/usage/account-providers'), {
    headers: { Authorization: authorization, 'X-Allowed-Sources': allowedSourcesHeader() }, cache: 'no-store', redirect: 'error', signal
  });
  if (!response.ok) throw new Error('Activity unavailable');
  const report = await response.json() as AccountProviderUsageReport;
  if (!report.sources || !Array.isArray(report.providers) || !Array.isArray(report.balanceReports)) {
    throw new Error('Activity unavailable');
  }
  return report;
}

export async function checkPersonalProviderBalance(ownerId: string, provider: ApiKeyProvider, signal: AbortSignal) {
  const authorization = await ownerBearer(ownerId, signal);
  if (!isProviderEnabled(provider) || !isLocalOwner(ownerId)) throw new Error('Provider unavailable');
  const key = getProviderKeyValue(provider)?.trim();
  const response = await fetch(buildApiUrl('/api/keys/balance'), {
    method: 'POST',
    headers: {
      Authorization: authorization,
      'Content-Type': 'application/json',
      'X-Allowed-Sources': allowedSourcesHeader(),
      ...(key ? { [PROVIDER_META[provider].header]: key } : {})
    },
    body: JSON.stringify({ provider }), cache: 'no-store', redirect: 'error', signal
  });
  if (!response.ok) throw new Error('Balance unavailable');
  const result = await response.json() as { report: ProviderBalanceReport; saved: boolean };
  if (result.report?.provider !== provider) throw new Error('Balance unavailable');
  return result;
}
