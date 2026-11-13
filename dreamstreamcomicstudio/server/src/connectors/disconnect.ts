import { connectorRegistry } from './registry.js';
import { deleteConnection, loadCredentials, type ConnectionRow } from './store.js';
import { logger } from '../lib/logger.js';

/** A Google grant can back multiple services, including Stream Studio's Drive saving. */
export async function disconnectAccountConnector(connection: ConnectionRow, accountConnections: readonly ConnectionRow[]): Promise<boolean> {
  const connector = connectorRegistry.get(connection.connector_id);
  const group = connector?.metadata.providerGroup;
  const sharesGrant = group && accountConnections.some((other) =>
    other.id !== connection.id &&
    other.auth_type === 'user_oauth' &&
    other.status !== 'disconnected' &&
    other.account_identifier === connection.account_identifier &&
    connectorRegistry.get(other.connector_id)?.metadata.providerGroup === group
  );
  const credentials = connector && connection.auth_type === 'user_oauth' && !sharesGrant
    ? await loadCredentials(connection.id).catch(() => null)
    : null;
  await deleteConnection(connection.id);
  if (!connector || !credentials) return false;
  try {
    await connector.revoke({ accessToken: credentials.accessToken, refreshToken: credentials.refreshToken });
    return true;
  } catch (err) {
    logger.warn('connector_revoke_failed', { message: (err as Error)?.message });
    return false;
  }
}
