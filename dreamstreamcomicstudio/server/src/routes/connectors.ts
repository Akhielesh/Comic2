// ============================================================================
// /api/connectors — account connector control plane
// ============================================================================
//
// Two routers:
//   * connectorsPublicRouter  — the OAuth callback only. A browser redirect from
//     Google carries no app session, so it mounts BEFORE the global requireAuth and
//     authenticates via the one-time, server-stored PKCE `state` row instead.
//   * connectorsRouter        — everything else, behind requireAuth (per-user).
//
// The Chat Studio retrieval/query + dashboard endpoints live here too, always scoped
// to req.user.id so a user can only read connections they own + authorized.
// ============================================================================

import { Router } from 'express';
import {
  CONNECTORS_APP_RETURN_URL,
  CONNECTORS_ENABLED,
  CONNECTORS_OAUTH_STATE_TTL_MS
} from '../config.js';
import { connectorRegistry } from '../connectors/index.js';
import { buildClientCatalog } from '../connectors/catalog.js';
import {
  buildGoogleAuthUrl,
  generatePkce,
  generateState,
  googleRedirectUri,
  isGoogleOAuthConfigured
} from '../connectors/oauth.js';
import { getValidAccessToken } from '../connectors/credentials.js';
import { triggerSync } from '../connectors/sync/trigger.js';
import { connectorDashboardData, retrieveItems } from '../connectors/retrieval.js';
import { ConnectorAuthError, type NormalizedKind } from '../connectors/types.js';
import {
  consumeOAuthState,
  deleteConnection,
  getOwnedConnection,
  getSyncState,
  listConnections,
  loadCredentials,
  saveCredentials,
  saveOAuthState,
  setConnectionStatus,
  upsertConnection,
  type ConnectionRow,
  type SyncStateRow
} from '../connectors/store.js';
import { logger } from '../lib/logger.js';

// ---- response shaping --------------------------------------------------------

const summarize = (row: ConnectionRow, sync?: SyncStateRow | null) => ({
  id: row.id,
  connectorId: row.connector_id,
  status: row.status,
  authType: row.auth_type,
  accountIdentifier: row.account_identifier,
  accountLabel: row.account_label,
  grantedScopes: row.granted_scopes,
  lastError: row.last_error,
  lastSyncAt: row.last_sync_at,
  sync: sync
    ? { status: sync.status, itemsSynced: sync.items_synced, lastError: sync.last_error, lastSyncAt: sync.last_sync_at }
    : null
});

const appReturnUrl = (params: Record<string, string>): string => {
  try {
    const u = new URL(CONNECTORS_APP_RETURN_URL);
    for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
    return u.toString();
  } catch {
    const q = new URLSearchParams(params).toString();
    return `${CONNECTORS_APP_RETURN_URL}${CONNECTORS_APP_RETURN_URL.includes('?') ? '&' : '?'}${q}`;
  }
};

// ============================================================================
// PUBLIC: OAuth callback
// ============================================================================

export const connectorsPublicRouter = Router();

connectorsPublicRouter.get('/oauth/callback', async (req, res) => {
  const stateParam = String(req.query.state || '');
  const code = String(req.query.code || '');
  const oauthError = String(req.query.error || '');

  // Always resolve to a friendly app redirect rather than a bare JSON error.
  const fail = (reason: string) => res.redirect(appReturnUrl({ connector_error: reason }));

  if (oauthError) return fail(oauthError);
  if (!stateParam || !code) return fail('missing_code_or_state');

  let state: Awaited<ReturnType<typeof consumeOAuthState>>;
  try {
    state = await consumeOAuthState(stateParam);
  } catch (err) {
    logger.warn('connector_oauth_state_error', { message: (err as Error)?.message });
    return fail('storage_unavailable');
  }
  // Unknown/expired/replayed state → CSRF guard trips here.
  if (!state) return fail('invalid_or_expired_state');

  // The auth code is single-use, so we exchange it ONCE (via the primary connector) and
  // apply the resulting Google token to every service in this consent.
  const primary = connectorRegistry.get(state.connectorIds[0]);
  if (!primary) return fail('unknown_connector');

  try {
    const result = await primary.handleCallback({
      code,
      codeVerifier: state.codeVerifier,
      redirectUri: state.redirectUri,
      userId: state.userId,
      scopes: state.scopes
    });

    const connected: string[] = [];
    for (const id of state.connectorIds) {
      const connector = connectorRegistry.get(id);
      if (!connector) continue;
      const connection = await upsertConnection({
        userId: state.userId,
        connectorId: id,
        authType: 'user_oauth',
        accountIdentifier: result.accountIdentifier,
        accountLabel: result.accountLabel ?? null,
        grantedScopes: result.grantedScopes,
        status: 'connected'
      });
      await saveCredentials(connection.id, state.userId, 'oauth2', result.tokens);
      if (connector.metadata.capabilities.syncable) {
        await triggerSync(state.userId, connection.id, 'full');
      }
      connected.push(id);
    }

    return res.redirect(appReturnUrl({ connected: connected.join(',') }));
  } catch (err) {
    logger.warn('connector_oauth_callback_failed', {
      connector: state.connectorIds.join(','),
      message: (err as Error)?.message
    });
    const reason = err instanceof ConnectorAuthError ? err.code : 'callback_failed';
    return fail(reason);
  }
});

// ============================================================================
// AUTHENTICATED: catalog, connections, connect, sync, disconnect, query
// ============================================================================

export const connectorsRouter = Router();

// Short-circuit the whole surface if the feature is disabled by config.
connectorsRouter.use((_req, res, next) => {
  if (!CONNECTORS_ENABLED) return res.status(404).json({ error: { message: 'Connectors are disabled' } });
  next();
});

const requireUser = (req: any, res: any): string | null => {
  const id = req.user?.id;
  if (!id) {
    res.status(401).json({ error: { message: 'User not authenticated' } });
    return null;
  }
  return id;
};

// GET /catalog — available connectors + configured status.
connectorsRouter.get('/catalog', async (req, res, next) => {
  try {
    if (!requireUser(req, res)) return;
    const catalog = await buildClientCatalog();
    res.json({ ok: true, connectors: catalog });
  } catch (err) {
    next(err);
  }
});

// GET /connections — the user's connections + sync summaries.
connectorsRouter.get('/connections', async (req, res, next) => {
  try {
    const userId = requireUser(req, res);
    if (!userId) return;
    const rows = await listConnections(userId);
    const out = await Promise.all(
      rows.map(async (row) => summarize(row, await getSyncState(row.id).catch(() => null)))
    );
    res.json({ ok: true, connections: out });
  } catch (err) {
    next(err);
  }
});

// POST /google/connect — connect MULTIPLE Google services in ONE consent.
// Body: { services: string[] }. Builds a single grant for the union of the selected
// services' scopes; the callback materializes a connection per service from that one
// token. This is the seamless "pick your Google services" flow.
// IMPORTANT: this MUST be registered BEFORE '/:connectorId/connect' — otherwise Express
// matches '/google/connect' as connectorId="google" (an unknown connector) and 404s.
connectorsRouter.post('/google/connect', async (req, res, next) => {
  try {
    const userId = requireUser(req, res);
    if (!userId) return;

    const requested: string[] = Array.isArray(req.body?.services) ? req.body.services.map(String) : [];
    const chosen = requested
      .map((id) => connectorRegistry.get(id))
      .filter((c): c is NonNullable<typeof c> =>
        Boolean(c && c.metadata.authType === 'user_oauth' && c.metadata.providerGroup === 'google')
      );
    if (!chosen.length) {
      return res.status(400).json({ error: { message: 'Select at least one Google service to connect' } });
    }
    if (!isGoogleOAuthConfigured()) {
      return res.status(400).json({ error: { message: 'Google OAuth is not configured on the server', code: 'no_credentials' } });
    }

    // Union of least-privilege scopes across the selected services (deduped).
    const scopes = [...new Set(chosen.flatMap((c) => c.metadata.requiredScopes))];
    const redirectUri = googleRedirectUri();
    const { codeVerifier, codeChallenge } = generatePkce();
    const state = generateState();
    const authorizationUrl = buildGoogleAuthUrl({ scopes, state, codeChallenge, redirectUri });

    await saveOAuthState({
      state,
      userId,
      connectorIds: chosen.map((c) => c.metadata.id),
      codeVerifier,
      redirectUri,
      scopes,
      expiresAt: new Date(Date.now() + CONNECTORS_OAUTH_STATE_TTL_MS).toISOString()
    });

    res.json({ ok: true, mode: 'redirect', authorizationUrl });
  } catch (err) {
    next(err);
  }
});

// POST /:connectorId/connect — begin connecting.
//   OAuth   → { mode:'redirect', authorizationUrl }
//   api_key → { mode:'completed', connection }  (body: { apiKey })
connectorsRouter.post('/:connectorId/connect', async (req, res, next) => {
  try {
    const userId = requireUser(req, res);
    if (!userId) return;

    const connector = connectorRegistry.get(String(req.params.connectorId || ''));
    if (!connector) return res.status(404).json({ error: { message: 'Unknown connector' } });

    const apiKey = typeof req.body?.apiKey === 'string' ? req.body.apiKey.trim() : undefined;
    const redirectUri = googleRedirectUri();
    const scopes = connector.metadata.requiredScopes;

    const result = await connector.initiate({ userId, redirectUri, apiKey, scopes });

    if (result.mode === 'redirect') {
      if (!result.authorizationUrl || !result.state || !result.codeVerifier) {
        return res.status(500).json({ error: { message: 'Connector did not return an authorization URL' } });
      }
      await saveOAuthState({
        state: result.state,
        userId,
        connectorIds: [connector.metadata.id],
        codeVerifier: result.codeVerifier,
        redirectUri,
        scopes,
        expiresAt: new Date(Date.now() + CONNECTORS_OAUTH_STATE_TTL_MS).toISOString()
      });
      return res.json({ ok: true, mode: 'redirect', authorizationUrl: result.authorizationUrl });
    }

    // api_key 'completed' path.
    const connection = await upsertConnection({
      userId,
      connectorId: connector.metadata.id,
      authType: 'api_key',
      accountIdentifier: result.accountIdentifier || connector.metadata.id,
      accountLabel: result.accountLabel ?? null,
      grantedScopes: [],
      status: 'connected'
    });
    if (result.tokens) {
      await saveCredentials(connection.id, userId, 'api_key', result.tokens);
    }
    res.json({ ok: true, mode: 'completed', connection: summarize(connection) });
  } catch (err) {
    if (err instanceof ConnectorAuthError) {
      return res.status(400).json({ error: { message: err.message, code: err.code } });
    }
    next(err);
  }
});

// POST /connections/:connectionId/sync — force a re-sync.
connectorsRouter.post('/connections/:connectionId/sync', async (req, res, next) => {
  try {
    const userId = requireUser(req, res);
    if (!userId) return;
    const conn = await getOwnedConnection(userId, String(req.params.connectionId || ''));
    if (!conn) return res.status(404).json({ error: { message: 'Connection not found' } });

    const connector = connectorRegistry.get(conn.connector_id);
    if (!connector?.metadata.capabilities.syncable) {
      return res.status(400).json({ error: { message: 'This connector does not sync (query-on-demand only)' } });
    }
    const mode = req.body?.full ? 'full' : 'auto';
    const { queued } = await triggerSync(userId, conn.id, mode);
    res.json({ ok: true, queued });
  } catch (err) {
    next(err);
  }
});

// DELETE /connections/:connectionId — revoke + delete (cascades creds/sync/items).
connectorsRouter.delete('/connections/:connectionId', async (req, res, next) => {
  try {
    const userId = requireUser(req, res);
    if (!userId) return;
    const conn = await getOwnedConnection(userId, String(req.params.connectionId || ''));
    if (!conn) return res.json({ ok: true }); // already gone — idempotent

    const connector = connectorRegistry.get(conn.connector_id);
    if (connector && conn.auth_type === 'user_oauth') {
      const creds = await loadCredentials(conn.id).catch(() => null);
      if (creds) {
        await connector
          .revoke({ accessToken: creds.accessToken, refreshToken: creds.refreshToken })
          .catch((e) => logger.warn('connector_revoke_failed', { message: (e as Error)?.message }));
      }
    }
    await deleteConnection(conn.id);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// GET /connections/:connectionId/items — scoped items for one connection.
connectorsRouter.get('/connections/:connectionId/items', async (req, res, next) => {
  try {
    const userId = requireUser(req, res);
    if (!userId) return;
    const conn = await getOwnedConnection(userId, String(req.params.connectionId || ''));
    if (!conn) return res.status(404).json({ error: { message: 'Connection not found' } });

    const items = await retrieveItems({
      userId,
      connectionId: conn.id,
      query: typeof req.query.q === 'string' ? req.query.q : undefined,
      kind: typeof req.query.kind === 'string' ? (req.query.kind as NormalizedKind) : undefined,
      limit: Math.min(100, Number(req.query.limit) || 25),
      offset: Number(req.query.offset) || 0
    });
    res.json({ ok: true, items });
  } catch (err) {
    next(err);
  }
});

// POST /query — unified retrieval for chat/analysis (scoped to the user).
connectorsRouter.post('/query', async (req, res, next) => {
  try {
    const userId = requireUser(req, res);
    if (!userId) return;
    const body = (req.body || {}) as Record<string, unknown>;
    const items = await retrieveItems({
      userId,
      query: typeof body.query === 'string' ? body.query : undefined,
      connectorId: typeof body.connectorId === 'string' ? body.connectorId : undefined,
      connectionId: typeof body.connectionId === 'string' ? body.connectionId : undefined,
      kind: typeof body.kind === 'string' ? (body.kind as NormalizedKind) : undefined,
      since: typeof body.since === 'string' ? body.since : undefined,
      until: typeof body.until === 'string' ? body.until : undefined,
      limit: Math.min(100, Number(body.limit) || 25),
      offset: Number(body.offset) || 0
    });
    res.json({ ok: true, items });
  } catch (err) {
    next(err);
  }
});

// POST /fetch — on-demand connector fetch (e.g. Maps geocode/places, Gmail search).
connectorsRouter.post('/connections/:connectionId/fetch', async (req, res, next) => {
  try {
    const userId = requireUser(req, res);
    if (!userId) return;
    const conn = await getOwnedConnection(userId, String(req.params.connectionId || ''));
    if (!conn) return res.status(404).json({ error: { message: 'Connection not found' } });

    const connector = connectorRegistry.get(conn.connector_id);
    if (!connector) return res.status(404).json({ error: { message: 'Unknown connector' } });

    const resource = String(req.body?.resource || '');
    const params = (req.body?.params || {}) as Record<string, unknown>;
    try {
      const data = await connector.fetch({
        connection: {
          id: conn.id,
          userId,
          connectorId: conn.connector_id,
          accountIdentifier: conn.account_identifier,
          grantedScopes: conn.granted_scopes,
          metadata: conn.metadata
        },
        getAccessToken: () => getValidAccessToken(conn, connector),
        resource,
        params
      });
      res.json({ ok: true, data });
    } catch (err) {
      if (err instanceof ConnectorAuthError) {
        await setConnectionStatus(conn.id, 'expired', 'Authorization is no longer valid — please reconnect.').catch(() => {});
        return res.status(401).json({ error: { message: err.message, code: err.code } });
      }
      throw err;
    }
  } catch (err) {
    next(err);
  }
});

// GET /dashboard — typed aggregates for dashboard generation (scoped to the user).
connectorsRouter.get('/dashboard', async (req, res, next) => {
  try {
    const userId = requireUser(req, res);
    if (!userId) return;
    const data = await connectorDashboardData(userId);
    res.json({ ok: true, dashboard: data });
  } catch (err) {
    next(err);
  }
});
