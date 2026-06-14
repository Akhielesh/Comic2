// ============================================================================
// Account Connectors framework — core contracts
// ============================================================================
//
// Every connector (Gmail, Drive, Calendar, Sheets, YouTube, Google Maps, and any
// future third-party source) implements the `AccountConnector` interface and is
// registered in the ConnectorRegistry. Adding a connector = implement this
// interface + register it; nothing in core routing, the DB schema, or the UI
// shell changes.
//
// The contract is deliberately auth-model-agnostic: it supports BOTH per-user
// OAuth (`authType: 'user_oauth'`) and shared/user API-key connectors
// (`authType: 'api_key'`). The auth-lifecycle methods have well-defined no-op
// paths for API-key connectors so Maps/YouTube-public fit without special-casing
// the core.
// ============================================================================

/** Two first-class auth models. The whole framework is built around this union. */
export type ConnectorAuthType = 'user_oauth' | 'api_key';

export type ConnectorCategory =
  | 'google_workspace'
  | 'maps'
  | 'media'
  | 'productivity'
  | 'storage'
  | 'other';

/** Connection status — mirrors the DB CHECK enum on user_connections.status. */
export type ConnectionStatus = 'connected' | 'disconnected' | 'error' | 'expired' | 'syncing';

/** The unified internal model. Downstream consumers only ever see these three. */
export type NormalizedKind = 'document' | 'record' | 'event';

export interface ConnectorCapabilities {
  /** Supports text search / RAG retrieval over its items. */
  searchable: boolean;
  /** Has a background sync (full + incremental) that materializes items. */
  syncable: boolean;
  /** Offers push/webhook delivery (Gmail/Drive/Calendar `watch`). */
  realtime: boolean;
  /** Authenticates with an API key rather than per-user OAuth. */
  apiKeyBased: boolean;
}

export interface ConnectorMetadata {
  /** Stable id, e.g. 'gmail'. Used as the catalog PK and connector_id everywhere. */
  id: string;
  displayName: string;
  description: string;
  /** lucide-react icon name the client maps to a component (e.g. 'Mail'). */
  icon: string;
  category: ConnectorCategory;
  authType: ConnectorAuthType;
  /**
   * Connectors that share ONE provider OAuth client + a single consent screen. The UI
   * groups these into one "Connect Google" card and grants their union of scopes in a
   * single popup. Undefined → the connector connects on its own.
   */
  providerGroup?: 'google';
  /** OAuth scopes requested (least-privilege). Empty for api_key connectors. */
  requiredScopes: string[];
  capabilities: ConnectorCapabilities;
  /** For api_key connectors: env var holding the shared platform key, if any. */
  apiKeyEnv?: string;
  /** For api_key connectors: whether the user supplies their own key (vs shared). */
  userProvidesKey?: boolean;
  docsUrl?: string;
}

/** A normalized item produced by a connector's normalize()/sync(). */
export interface NormalizedItem {
  kind: NormalizedKind;
  /** Stable id within the source system; the idempotent upsert key. */
  externalId: string;
  title?: string | null;
  snippet?: string | null;
  contentText?: string | null;
  url?: string | null;
  author?: string | null;
  /** ISO-8601. Message date / event start / file mtime. */
  occurredAt?: string | null;
  /** Connector-specific normalized fields (typed per connector, stored as JSONB). */
  payload?: Record<string, unknown>;
}

/** OAuth/api-key token material. Persisted encrypted, separately from metadata. */
export interface TokenSet {
  accessToken: string;
  refreshToken?: string | null;
  /** ISO-8601 expiry of the access token. */
  expiresAt?: string | null;
  /** Space-delimited granted scope string. */
  scope?: string | null;
  tokenType?: string;
}

/** A lightweight handle to a stored connection, passed to data-lifecycle methods. */
export interface ConnectionRef {
  id: string;
  userId: string;
  connectorId: string;
  accountIdentifier: string;
  grantedScopes: string[];
  metadata: Record<string, unknown>;
}

// ---- Auth lifecycle I/O -----------------------------------------------------

export interface InitiateAuthInput {
  userId: string;
  /** The exact callback URL registered with the provider (strictly validated). */
  redirectUri: string;
  /** For api_key connectors: the key the user supplied (optional if shared env). */
  apiKey?: string;
  /** Optional scope override (defaults to metadata.requiredScopes). */
  scopes?: string[];
}

export interface InitiateAuthResult {
  /** 'redirect' → send the browser to authorizationUrl. 'completed' → done (api_key). */
  mode: 'redirect' | 'completed';
  authorizationUrl?: string;
  /** PKCE verifier the framework must persist (encrypted) for the callback. */
  codeVerifier?: string;
  /** CSRF state nonce the framework persists + checks on callback. */
  state?: string;
  /** For the api_key 'completed' path: the resolved account identity. */
  accountIdentifier?: string;
  accountLabel?: string;
  /** Tokens to persist for the api_key 'completed' path. */
  tokens?: TokenSet;
}

export interface HandleCallbackInput {
  code: string;
  codeVerifier: string;
  redirectUri: string;
  userId: string;
  scopes: string[];
}

export interface HandleCallbackResult {
  tokens: TokenSet;
  /** Resolved account identity, e.g. the connected Google email. */
  accountIdentifier: string;
  accountLabel?: string;
  grantedScopes: string[];
}

// ---- Data lifecycle I/O -----------------------------------------------------

export interface SyncContext {
  connection: ConnectionRef;
  /** Returns a valid (refreshed-if-needed) access token or API key. */
  getAccessToken: () => Promise<string>;
  /** Resume cursor from connector_sync_state.cursor (connector-defined shape). */
  cursor: Record<string, unknown>;
  signal?: AbortSignal;
  /** Soft cap on items to return this run (paginate via the returned cursor). */
  limit?: number;
}

export interface SyncResult {
  items: NormalizedItem[];
  /** Next cursor, persisted to connector_sync_state for resumable/idempotent sync. */
  cursor: Record<string, unknown>;
  /** true → more pages remain; the runner enqueues a follow-up incremental job. */
  hasMore: boolean;
}

export interface FetchInput {
  connection: ConnectionRef;
  getAccessToken: () => Promise<string>;
  /** Connector-defined resource selector, e.g. 'search' | 'thread' | 'geocode'. */
  resource: string;
  params: Record<string, unknown>;
  signal?: AbortSignal;
}

// ---- The contract -----------------------------------------------------------

export interface AccountConnector {
  readonly metadata: ConnectorMetadata;

  /**
   * Begin connecting. OAuth connectors return mode:'redirect' + an authorization
   * URL (+ PKCE verifier + state for the framework to persist). API-key connectors
   * validate the key and return mode:'completed' with tokens to persist.
   */
  initiate(input: InitiateAuthInput): Promise<InitiateAuthResult>;

  /** Exchange the OAuth code for tokens + resolve account identity. OAuth only. */
  handleCallback(input: HandleCallbackInput): Promise<HandleCallbackResult>;

  /** Refresh an access token. OAuth only (api_key connectors return the key unchanged). */
  refresh(refreshToken: string): Promise<TokenSet>;

  /** Best-effort provider-side revocation on disconnect. No-op for api_key. */
  revoke(tokens: TokenSet): Promise<void>;

  /** First sync — full backfill. May paginate via the returned cursor/hasMore. */
  syncFull(ctx: SyncContext): Promise<SyncResult>;

  /** Subsequent sync — incremental, resuming from ctx.cursor. */
  syncIncremental(ctx: SyncContext): Promise<SyncResult>;

  /** On-demand read for query-style connectors (e.g. Maps geocode/places). */
  fetch(input: FetchInput): Promise<unknown>;

  /** Map a raw provider payload to normalized items. */
  normalize(raw: unknown): NormalizedItem[];
}

/** Typed error so callers can distinguish auth failures (→ reconnect prompt). */
export class ConnectorAuthError extends Error {
  readonly code: 'invalid_grant' | 'revoked' | 'expired' | 'unauthorized' | 'no_credentials';
  constructor(code: ConnectorAuthError['code'], message: string) {
    super(message);
    this.name = 'ConnectorAuthError';
    this.code = code;
  }
}

/** Typed error for upstream rate limiting (429) so the runner can back off. */
export class ConnectorRateLimitError extends Error {
  readonly retryAfterMs?: number;
  constructor(message: string, retryAfterMs?: number) {
    super(message);
    this.name = 'ConnectorRateLimitError';
    this.retryAfterMs = retryAfterMs;
  }
}
