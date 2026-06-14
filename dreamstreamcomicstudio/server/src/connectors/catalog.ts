// ============================================================================
// Client-facing connector catalog
// ============================================================================
//
// Merges code-defined connector metadata (the registry) with DB enablement/config
// and reports whether each connector is actually CONFIGURED (OAuth client present /
// API key available), so the UI can show "Available" vs "Unavailable" honestly.
// ============================================================================

import { connectorRegistry } from './registry.js';
import { getCatalogState } from './store.js';
import { isGoogleOAuthConfigured } from './oauth.js';
import type { ConnectorAuthType, ConnectorCapabilities, ConnectorCategory } from './types.js';

export interface ClientCatalogEntry {
  id: string;
  displayName: string;
  description: string;
  icon: string;
  category: ConnectorCategory;
  authType: ConnectorAuthType;
  requiredScopes: string[];
  capabilities: ConnectorCapabilities;
  userProvidesKey: boolean;
  /** Whether the connector can actually be connected in this deployment. */
  configured: boolean;
  docsUrl?: string;
}

const isConfigured = (authType: ConnectorAuthType, apiKeyEnv?: string, userProvidesKey?: boolean): boolean => {
  if (authType === 'user_oauth') return isGoogleOAuthConfigured();
  // api_key: connectable if a shared platform key exists OR the user supplies their own.
  const sharedPresent = Boolean(apiKeyEnv && (process.env[apiKeyEnv] || '').trim());
  return sharedPresent || Boolean(userProvidesKey);
};

export const buildClientCatalog = async (): Promise<ClientCatalogEntry[]> => {
  const state = await getCatalogState().catch(() => new Map());
  return connectorRegistry
    .list()
    .map((c) => {
      const m = c.metadata;
      const row = state.get(m.id);
      return {
        id: m.id,
        displayName: m.displayName,
        description: m.description,
        icon: m.icon,
        category: m.category,
        authType: m.authType,
        requiredScopes: m.requiredScopes,
        capabilities: m.capabilities,
        userProvidesKey: Boolean(m.userProvidesKey),
        configured: isConfigured(m.authType, m.apiKeyEnv, m.userProvidesKey),
        docsUrl: m.docsUrl,
        enabled: row?.enabled ?? true
      };
    })
    .filter((e) => e.enabled)
    .map(({ enabled, ...rest }) => rest);
};
