// ============================================================================
// Account Connectors — persistence layer (Supabase, service role)
// ============================================================================
//
// All reads/writes go through the service-role admin client. Credentials are
// encrypted at rest with the shared secureStore (AES-256-GCM) before they touch the
// connection_credentials table, and decrypted only here on the server. The Chat
// Studio retrieval interface (retrieval.ts) is built on top of queryItems and is
// always scoped by user_id.
// ============================================================================

import { getSupabaseAdmin } from '../services/supabase.js';
import { isUuid } from '../lib/uuid.js';
import { decryptSecret, encryptSecret } from '../lib/secureStore.js';
import type {
  ConnectionRef,
  ConnectionStatus,
  ConnectorAuthType,
  ConnectorMetadata,
  NormalizedItem,
  NormalizedKind,
  TokenSet
} from './types.js';

// ---- Catalog ----------------------------------------------------------------

/** Upsert code-defined connector metadata into the catalog (enablement + admin config). */
export const upsertCatalog = async (items: ConnectorMetadata[]): Promise<void> => {
  if (!items.length) return;
  const rows = items.map((m) => ({
    id: m.id,
    display_name: m.displayName,
    category: m.category,
    auth_type: m.authType
  }));
  // Do NOT overwrite admin-managed `enabled`/`config`; only insert missing + refresh
  // the descriptive columns. onConflict update of the descriptive fields keeps the
  // catalog in sync with code while preserving operator toggles.
  const { error } = await getSupabaseAdmin()
    .from('connectors')
    .upsert(rows, { onConflict: 'id', ignoreDuplicates: false });
  if (error) throw new Error(`catalog upsert failed: ${error.message}`);
};

export interface CatalogRow {
  id: string;
  enabled: boolean;
  config: Record<string, unknown>;
}

/** Read admin enablement/config for connectors (id → row). */
export const getCatalogState = async (): Promise<Map<string, CatalogRow>> => {
  const { data, error } = await getSupabaseAdmin().from('connectors').select('id, enabled, config');
  if (error) throw new Error(`catalog read failed: ${error.message}`);
  const map = new Map<string, CatalogRow>();
  for (const r of data || []) {
    map.set(String(r.id), { id: String(r.id), enabled: Boolean(r.enabled), config: (r.config || {}) as Record<string, unknown> });
  }
  return map;
};

// ---- Connections ------------------------------------------------------------

export interface ConnectionRow {
  id: string;
  user_id: string;
  connector_id: string;
  status: ConnectionStatus;
  auth_type: ConnectorAuthType;
  account_identifier: string;
  account_label: string | null;
  granted_scopes: string[];
  last_error: string | null;
  metadata: Record<string, unknown>;
  last_sync_at: string | null;
  created_at: string;
  updated_at: string;
}

export const toConnectionRef = (row: ConnectionRow): ConnectionRef => ({
  id: row.id,
  userId: row.user_id,
  connectorId: row.connector_id,
  accountIdentifier: row.account_identifier,
  grantedScopes: row.granted_scopes || [],
  metadata: row.metadata || {}
});

/** Create or update a connection (upsert on user+connector+account). Returns the row. */
export const upsertConnection = async (input: {
  userId: string;
  connectorId: string;
  authType: ConnectorAuthType;
  accountIdentifier: string;
  accountLabel?: string | null;
  grantedScopes?: string[];
  status?: ConnectionStatus;
  metadata?: Record<string, unknown>;
}): Promise<ConnectionRow> => {
  const { data, error } = await getSupabaseAdmin()
    .from('user_connections')
    .upsert(
      {
        user_id: input.userId,
        connector_id: input.connectorId,
        auth_type: input.authType,
        account_identifier: input.accountIdentifier,
        account_label: input.accountLabel ?? null,
        granted_scopes: input.grantedScopes ?? [],
        status: input.status ?? 'connected',
        last_error: null,
        metadata: input.metadata ?? {}
      },
      { onConflict: 'user_id,connector_id,account_identifier' }
    )
    .select('*')
    .single();
  if (error) throw new Error(`connection upsert failed: ${error.message}`);
  return data as ConnectionRow;
};

export const getConnection = async (connectionId: string): Promise<ConnectionRow | null> => {
  // Guard non-UUID ids (e.g. the "demo-connection" placeholder from Gallery demo confirm
  // cards) before they reach the Postgres `uuid` column, which would otherwise 500 with
  // "invalid input syntax for type uuid". Treat them as "not found" so callers return 404.
  if (!isUuid(connectionId)) return null;
  const { data, error } = await getSupabaseAdmin()
    .from('user_connections')
    .select('*')
    .eq('id', connectionId)
    .maybeSingle();
  if (error) throw new Error(`connection read failed: ${error.message}`);
  return (data as ConnectionRow) || null;
};

/** Scoped read — guarantees the connection belongs to the requesting user. */
export const getOwnedConnection = async (userId: string, connectionId: string): Promise<ConnectionRow | null> => {
  const row = await getConnection(connectionId);
  return row && row.user_id === userId ? row : null;
};

/**
 * Find connections by connector + account identity ACROSS users — used by the
 * webhook/push seam, where the provider tells us "this mailbox changed" but not
 * which app user owns it.
 */
export const findConnectionsByAccount = async (
  connectorId: string,
  accountIdentifier: string
): Promise<ConnectionRow[]> => {
  const { data, error } = await getSupabaseAdmin()
    .from('user_connections')
    .select('*')
    .eq('connector_id', connectorId)
    .eq('account_identifier', accountIdentifier);
  if (error) throw new Error(`connection lookup failed: ${error.message}`);
  return (data || []) as ConnectionRow[];
};

/**
 * The user's most-recent usable connection for a connector (for AI tools that act on
 * "my Gmail/Drive/…"). Skips disconnected rows; returns null if none.
 */
export const getActiveConnection = async (
  userId: string,
  connectorId: string
): Promise<ConnectionRow | null> => {
  const { data, error } = await getSupabaseAdmin()
    .from('user_connections')
    .select('*')
    .eq('user_id', userId)
    .eq('connector_id', connectorId)
    .neq('status', 'disconnected')
    .order('updated_at', { ascending: false })
    .limit(1);
  if (error) throw new Error(`active connection lookup failed: ${error.message}`);
  return ((data || [])[0] as ConnectionRow) || null;
};

export const listConnections = async (userId: string): Promise<ConnectionRow[]> => {
  const { data, error } = await getSupabaseAdmin()
    .from('user_connections')
    .select('*')
    .eq('user_id', userId)
    .order('updated_at', { ascending: false });
  if (error) throw new Error(`connection list failed: ${error.message}`);
  return (data || []) as ConnectionRow[];
};

export const setConnectionStatus = async (
  connectionId: string,
  status: ConnectionStatus,
  lastError?: string | null
): Promise<void> => {
  const patch: Record<string, unknown> = { status };
  if (lastError !== undefined) patch.last_error = lastError;
  const { error } = await getSupabaseAdmin().from('user_connections').update(patch).eq('id', connectionId);
  if (error) throw new Error(`connection status update failed: ${error.message}`);
};

export const markConnectionSynced = async (connectionId: string): Promise<void> => {
  const { error } = await getSupabaseAdmin()
    .from('user_connections')
    .update({ last_sync_at: new Date().toISOString() })
    .eq('id', connectionId);
  if (error) throw new Error(`connection sync mark failed: ${error.message}`);
};

export const deleteConnection = async (connectionId: string): Promise<void> => {
  // ON DELETE CASCADE removes credentials/sync_state/items.
  const { error } = await getSupabaseAdmin().from('user_connections').delete().eq('id', connectionId);
  if (error) throw new Error(`connection delete failed: ${error.message}`);
};

// ---- Credentials (encrypted) ------------------------------------------------

export interface StoredCredentials {
  tokenType: 'oauth2' | 'api_key';
  accessToken: string;
  refreshToken: string | null;
  expiresAt: string | null;
  scope: string | null;
}

/** Encrypt + persist tokens for a connection (one row per connection). */
export const saveCredentials = async (
  connectionId: string,
  userId: string,
  tokenType: 'oauth2' | 'api_key',
  tokens: TokenSet
): Promise<void> => {
  const access = encryptSecret(tokens.accessToken);
  if (!access) throw new Error('encryption unavailable (SUPABASE_SERVICE_ROLE_KEY not set)');
  const refresh = tokens.refreshToken ? encryptSecret(tokens.refreshToken) : null;

  const { error } = await getSupabaseAdmin().from('connection_credentials').upsert(
    {
      connection_id: connectionId,
      user_id: userId,
      token_type: tokenType,
      encrypted_access: access.ciphertext,
      access_iv: access.iv,
      encrypted_refresh: refresh?.ciphertext ?? null,
      refresh_iv: refresh?.iv ?? null,
      access_expires_at: tokens.expiresAt ?? null,
      scope: tokens.scope ?? null
    },
    { onConflict: 'connection_id' }
  );
  if (error) throw new Error(`credential save failed: ${error.message}`);
};

export const loadCredentials = async (connectionId: string): Promise<StoredCredentials | null> => {
  const { data, error } = await getSupabaseAdmin()
    .from('connection_credentials')
    .select('token_type, encrypted_access, access_iv, encrypted_refresh, refresh_iv, access_expires_at, scope')
    .eq('connection_id', connectionId)
    .maybeSingle();
  if (error) throw new Error(`credential read failed: ${error.message}`);
  if (!data) return null;

  const accessToken = data.encrypted_access ? decryptSecret(String(data.encrypted_access), String(data.access_iv)) : null;
  if (!accessToken) return null;
  const refreshToken = data.encrypted_refresh
    ? decryptSecret(String(data.encrypted_refresh), String(data.refresh_iv))
    : null;

  return {
    tokenType: (data.token_type as 'oauth2' | 'api_key') || 'oauth2',
    accessToken,
    refreshToken: refreshToken ?? null,
    expiresAt: (data.access_expires_at as string | null) ?? null,
    scope: (data.scope as string | null) ?? null
  };
};

export const deleteCredentials = async (connectionId: string): Promise<void> => {
  const { error } = await getSupabaseAdmin().from('connection_credentials').delete().eq('connection_id', connectionId);
  if (error) throw new Error(`credential delete failed: ${error.message}`);
};

// ---- Sync state -------------------------------------------------------------

export interface SyncStateRow {
  connection_id: string;
  user_id: string;
  cursor: Record<string, unknown>;
  status: 'idle' | 'syncing' | 'error' | 'done';
  last_sync_at: string | null;
  last_full_sync_at: string | null;
  last_error: string | null;
  items_synced: number;
}

export const getSyncState = async (connectionId: string): Promise<SyncStateRow | null> => {
  const { data, error } = await getSupabaseAdmin()
    .from('connector_sync_state')
    .select('*')
    .eq('connection_id', connectionId)
    .maybeSingle();
  if (error) throw new Error(`sync state read failed: ${error.message}`);
  return (data as SyncStateRow) || null;
};

export const upsertSyncState = async (
  connectionId: string,
  userId: string,
  patch: Partial<Omit<SyncStateRow, 'connection_id' | 'user_id'>>
): Promise<void> => {
  const { error } = await getSupabaseAdmin().from('connector_sync_state').upsert(
    { connection_id: connectionId, user_id: userId, ...patch },
    { onConflict: 'connection_id' }
  );
  if (error) throw new Error(`sync state upsert failed: ${error.message}`);
};

// ---- Normalized items -------------------------------------------------------

/** Idempotent upsert of normalized items (conflict key: connection_id, kind, external_id). */
export const upsertItems = async (
  userId: string,
  connection: ConnectionRef,
  items: NormalizedItem[]
): Promise<number> => {
  if (!items.length) return 0;
  const rows = items.map((it) => ({
    user_id: userId,
    connection_id: connection.id,
    connector_id: connection.connectorId,
    kind: it.kind,
    external_id: it.externalId,
    title: it.title ?? null,
    snippet: it.snippet ?? null,
    content_text: it.contentText ?? null,
    url: it.url ?? null,
    author: it.author ?? null,
    occurred_at: it.occurredAt ?? null,
    payload: it.payload ?? {}
  }));
  const { error } = await getSupabaseAdmin()
    .from('connector_items')
    .upsert(rows, { onConflict: 'connection_id,kind,external_id' });
  if (error) throw new Error(`item upsert failed: ${error.message}`);
  return rows.length;
};

export interface ItemQuery {
  userId: string;
  connectionId?: string;
  connectorId?: string;
  kind?: NormalizedKind;
  /** Free-text match across title/snippet/content_text (ILIKE). */
  search?: string;
  since?: string; // ISO
  until?: string; // ISO
  limit?: number;
  offset?: number;
}

export interface ItemRow {
  id: string;
  connection_id: string;
  connector_id: string;
  kind: NormalizedKind;
  external_id: string;
  title: string | null;
  snippet: string | null;
  content_text: string | null;
  url: string | null;
  author: string | null;
  occurred_at: string | null;
  payload: Record<string, unknown>;
}

const ITEM_COLUMNS = 'id, connection_id, connector_id, kind, external_id, title, snippet, content_text, url, author, occurred_at, payload';

/** Scoped query over normalized items. ALWAYS filtered by user_id. */
export const queryItems = async (q: ItemQuery): Promise<ItemRow[]> => {
  let query = getSupabaseAdmin().from('connector_items').select(ITEM_COLUMNS).eq('user_id', q.userId);
  if (q.connectionId) query = query.eq('connection_id', q.connectionId);
  if (q.connectorId) query = query.eq('connector_id', q.connectorId);
  if (q.kind) query = query.eq('kind', q.kind);
  if (q.since) query = query.gte('occurred_at', q.since);
  if (q.until) query = query.lte('occurred_at', q.until);
  if (q.search) {
    const term = q.search.replace(/[%,()]/g, ' ').trim();
    if (term) {
      const like = `%${term}%`;
      query = query.or(`title.ilike.${like},snippet.ilike.${like},content_text.ilike.${like}`);
    }
  }
  query = query
    .order('occurred_at', { ascending: false, nullsFirst: false })
    .range(q.offset ?? 0, (q.offset ?? 0) + (q.limit ?? 25) - 1);

  const { data, error } = await query;
  if (error) throw new Error(`item query failed: ${error.message}`);
  return (data || []) as ItemRow[];
};

/** Count items for a connection (for connection cards / dashboards). */
export const countItems = async (userId: string, connectionId: string): Promise<number> => {
  const { count, error } = await getSupabaseAdmin()
    .from('connector_items')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', userId)
    .eq('connection_id', connectionId);
  if (error) throw new Error(`item count failed: ${error.message}`);
  return count ?? 0;
};

// ---- OAuth handshake state (PKCE + CSRF) ------------------------------------

export const saveOAuthState = async (input: {
  state: string;
  userId: string;
  /** All services in this single consent (≥1). The first is the primary. */
  connectorIds: string[];
  codeVerifier: string;
  redirectUri: string;
  scopes: string[];
  expiresAt: string;
}): Promise<void> => {
  const enc = encryptSecret(input.codeVerifier);
  if (!enc) throw new Error('encryption unavailable for OAuth state');
  const { error } = await getSupabaseAdmin().from('connector_oauth_state').insert({
    state: input.state,
    user_id: input.userId,
    connector_id: input.connectorIds[0],
    connector_ids: input.connectorIds,
    encrypted_verifier: enc.ciphertext,
    verifier_iv: enc.iv,
    redirect_uri: input.redirectUri,
    scopes: input.scopes,
    expires_at: input.expiresAt
  });
  if (error) throw new Error(`oauth state save failed: ${error.message}`);
};

export interface ConsumedOAuthState {
  userId: string;
  /** All services to materialize from this single grant. */
  connectorIds: string[];
  codeVerifier: string;
  redirectUri: string;
  scopes: string[];
}

/**
 * One-time consume: load, delete, and validate expiry. Returns null if the state is
 * unknown (CSRF / replay) or expired. The DELETE makes the nonce single-use.
 */
export const consumeOAuthState = async (state: string): Promise<ConsumedOAuthState | null> => {
  const admin = getSupabaseAdmin();
  const { data, error } = await admin
    .from('connector_oauth_state')
    .select('user_id, connector_id, connector_ids, encrypted_verifier, verifier_iv, redirect_uri, scopes, expires_at')
    .eq('state', state)
    .maybeSingle();
  if (error) throw new Error(`oauth state read failed: ${error.message}`);
  if (!data) return null;

  // Single-use: delete immediately regardless of outcome.
  await admin.from('connector_oauth_state').delete().eq('state', state);

  if (new Date(String(data.expires_at)).getTime() < Date.now()) return null;
  const codeVerifier = decryptSecret(String(data.encrypted_verifier), String(data.verifier_iv));
  if (!codeVerifier) return null;

  const ids = (data.connector_ids as string[] | null) || [];
  return {
    userId: String(data.user_id),
    connectorIds: ids.length ? ids : [String(data.connector_id)],
    codeVerifier,
    redirectUri: String(data.redirect_uri),
    scopes: (data.scopes as string[]) || []
  };
};

/** Housekeeping — drop expired handshake rows. */
export const purgeExpiredOAuthState = async (): Promise<void> => {
  await getSupabaseAdmin().from('connector_oauth_state').delete().lt('expires_at', new Date().toISOString());
};
