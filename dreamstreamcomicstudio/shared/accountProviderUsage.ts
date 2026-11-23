import type { ProviderBalanceReport } from './providerBalances.js';

export interface AccountProviderUsageRow {
  provider: string;
  modelRequests: number;
  byokRequests: number;
  platformRequests: number;
  connectorCalls: number;
  connectorErrors: number;
  connectorBlocked: number;
  /** Only monetary values for calls made on the member’s own credential can leave the server. */
  reportedByokUsd: number | null;
  estimatedByokUsd: number | null;
  unpricedByokRequests: number;
}

export interface AccountProviderUsageReport {
  from: string;
  to: string;
  generatedAt: string;
  providers: AccountProviderUsageRow[];
  sources: Record<'models' | 'connectors' | 'balances', 'available' | 'unavailable'>;
  /** Provider-reported observations for this account's currently stored credential. */
  balanceReports: ProviderBalanceReport[];
  balancesRefreshing?: boolean;
}

export interface ProviderBalanceRefresh {
  report: ProviderBalanceReport;
  saved: boolean;
}
