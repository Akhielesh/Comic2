// ============================================================================
// Token lifecycle — valid-access-token resolution with automatic refresh
// ============================================================================
//
// getValidAccessToken is the single source of a usable token for sync/fetch. It:
//   * returns an API key unchanged (api_key connectors)
//   * returns the access token if it is comfortably unexpired
//   * otherwise refreshes via the connector, PERSISTS the new token, and clears any
//     prior error status
//   * on a revoked/expired refresh token, marks the connection 'expired' so the UI
//     shows a "reconnect" prompt — never silently failing.
// ============================================================================

import { ConnectorAuthError, type AccountConnector } from './types.js';
import {
  loadCredentials,
  saveCredentials,
  setConnectionStatus,
  type ConnectionRow
} from './store.js';

/** Refresh this many ms BEFORE the real expiry to avoid using a token mid-flight. */
const EXPIRY_SKEW_MS = 60_000;

export const getValidAccessToken = async (
  connection: ConnectionRow,
  connector: AccountConnector
): Promise<string> => {
  const creds = await loadCredentials(connection.id);
  if (!creds) {
    await setConnectionStatus(connection.id, 'expired', 'No stored credentials — please reconnect.');
    throw new ConnectorAuthError('no_credentials', 'No stored credentials for this connection');
  }

  // API-key connectors: the stored secret is the token.
  if (creds.tokenType === 'api_key') return creds.accessToken;

  const expMs = creds.expiresAt ? new Date(creds.expiresAt).getTime() : 0;
  const comfortablyValid = creds.expiresAt ? expMs - Date.now() > EXPIRY_SKEW_MS : false;
  if (comfortablyValid) return creds.accessToken;

  // Needs refresh.
  if (!creds.refreshToken) {
    await setConnectionStatus(connection.id, 'expired', 'Session expired — please reconnect.');
    throw new ConnectorAuthError('expired', 'Access token expired and no refresh token is on file');
  }

  try {
    const refreshed = await connector.refresh(creds.refreshToken);
    await saveCredentials(connection.id, connection.user_id, 'oauth2', refreshed);
    if (connection.status === 'error' || connection.status === 'expired') {
      await setConnectionStatus(connection.id, 'connected', null);
    }
    return refreshed.accessToken;
  } catch (err) {
    await markReconnectIfAuth(connection, err);
    throw err;
  }
};

/**
 * Translate an auth failure surfaced during a data call (or refresh) into a connection
 * status the UI can act on. Revoked/expired/invalid_grant → 'expired' (reconnect);
 * anything else → 'error'.
 */
export const markReconnectIfAuth = async (connection: ConnectionRow, err: unknown): Promise<void> => {
  if (err instanceof ConnectorAuthError) {
    if (err.code === 'invalid_grant' || err.code === 'revoked' || err.code === 'expired' || err.code === 'no_credentials') {
      await setConnectionStatus(connection.id, 'expired', 'Your connection was revoked or expired — please reconnect.');
      return;
    }
    if (err.code === 'unauthorized') {
      await setConnectionStatus(connection.id, 'expired', 'Authorization is no longer valid — please reconnect.');
      return;
    }
  }
  await setConnectionStatus(connection.id, 'error', `Connection error: ${(err as Error)?.message || 'unknown'}`);
};
