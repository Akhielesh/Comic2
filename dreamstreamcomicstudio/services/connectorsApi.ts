// Client API for the Account Connectors feature. Thin wrappers over the shared
// apiClient (auth token + base URL handled there). All endpoints are per-user and
// scoped server-side to the authenticated account.

import { get, post, del } from './apiClient';

export type ConnectorAuthType = 'user_oauth' | 'api_key';
export type ConnectionStatus = 'connected' | 'disconnected' | 'error' | 'expired' | 'syncing';

export interface ConnectorCapabilities {
  searchable: boolean;
  syncable: boolean;
  realtime: boolean;
  apiKeyBased: boolean;
}

export interface CatalogEntry {
  id: string;
  displayName: string;
  description: string;
  icon: string;
  category: string;
  authType: ConnectorAuthType;
  /** Connectors sharing one Google consent screen are grouped under 'google'. */
  providerGroup?: 'google';
  requiredScopes: string[];
  capabilities: ConnectorCapabilities;
  userProvidesKey: boolean;
  configured: boolean;
  docsUrl?: string;
}

export interface ConnectionSyncSummary {
  status: 'idle' | 'syncing' | 'error' | 'done';
  itemsSynced: number;
  lastError: string | null;
  lastSyncAt: string | null;
}

export interface ConnectionSummary {
  id: string;
  connectorId: string;
  status: ConnectionStatus;
  authType: ConnectorAuthType;
  accountIdentifier: string;
  accountLabel: string | null;
  grantedScopes: string[];
  lastError: string | null;
  lastSyncAt: string | null;
  sync: ConnectionSyncSummary | null;
}

export interface NormalizedItemView {
  id: string;
  connection_id: string;
  connector_id: string;
  kind: 'document' | 'record' | 'event';
  external_id: string;
  title: string | null;
  snippet: string | null;
  url: string | null;
  author: string | null;
  occurred_at: string | null;
  payload: Record<string, unknown>;
}

export const fetchCatalog = (): Promise<CatalogEntry[]> =>
  get<{ ok: boolean; connectors: CatalogEntry[] }>('/api/connectors/catalog').then((r) => r.connectors || []);

export const fetchConnections = (): Promise<ConnectionSummary[]> =>
  get<{ ok: boolean; connections: ConnectionSummary[] }>('/api/connectors/connections').then((r) => r.connections || []);

export type ConnectResult =
  | { mode: 'redirect'; authorizationUrl: string }
  | { mode: 'completed'; connection: ConnectionSummary };

export const connectConnector = (connectorId: string, body: { apiKey?: string } = {}): Promise<ConnectResult> =>
  post<{ apiKey?: string }, ConnectResult & { ok: boolean }>(`/api/connectors/${encodeURIComponent(connectorId)}/connect`, body);

/** Connect several Google services in ONE consent. Returns the consent URL to open. */
export const connectGoogleServices = (services: string[]): Promise<{ authorizationUrl: string }> =>
  post<{ services: string[] }, { ok: boolean; mode: 'redirect'; authorizationUrl: string }>(
    '/api/connectors/google/connect',
    { services }
  );

export const syncConnection = (connectionId: string, full = false): Promise<{ queued: boolean }> =>
  post<{ full: boolean }, { ok: boolean; queued: boolean }>(
    `/api/connectors/connections/${encodeURIComponent(connectionId)}/sync`,
    { full }
  );

export const disconnectConnection = (connectionId: string): Promise<{ ok: boolean }> =>
  del<{ ok: boolean }>(`/api/connectors/connections/${encodeURIComponent(connectionId)}`);

export const fetchConnectionItems = (
  connectionId: string,
  opts: { q?: string; kind?: string; limit?: number } = {}
): Promise<NormalizedItemView[]> => {
  const params = new URLSearchParams();
  if (opts.q) params.set('q', opts.q);
  if (opts.kind) params.set('kind', opts.kind);
  if (opts.limit) params.set('limit', String(opts.limit));
  const qs = params.toString();
  return get<{ ok: boolean; items: NormalizedItemView[] }>(
    `/api/connectors/connections/${encodeURIComponent(connectionId)}/items${qs ? `?${qs}` : ''}`
  ).then((r) => r.items || []);
};
