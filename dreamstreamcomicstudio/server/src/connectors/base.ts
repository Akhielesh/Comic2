// ============================================================================
// Connector base classes — collapse the auth boilerplate to one place per model
// ============================================================================
//
// GoogleOAuthConnector implements the full OAuth lifecycle (initiate/handleCallback/
// refresh/revoke) on top of oauth.ts; a concrete connector (Gmail, Drive, …) only
// supplies metadata + the data lifecycle. ApiKeyConnector implements the no-op auth
// path for shared/user API-key connectors (Maps, YouTube-public).
// ============================================================================

import {
  ConnectorAuthError,
  type AccountConnector,
  type ConnectorMetadata,
  type FetchInput,
  type HandleCallbackInput,
  type HandleCallbackResult,
  type InitiateAuthInput,
  type InitiateAuthResult,
  type NormalizedItem,
  type SyncContext,
  type SyncResult,
  type TokenSet
} from './types.js';
import {
  buildGoogleAuthUrl,
  exchangeGoogleCode,
  fetchGoogleUserInfo,
  generatePkce,
  generateState,
  isAllowedRedirectUri,
  isGoogleOAuthConfigured,
  refreshGoogleToken,
  revokeGoogleToken
} from './oauth.js';

export abstract class GoogleOAuthConnector implements AccountConnector {
  abstract readonly metadata: ConnectorMetadata;

  async initiate(input: InitiateAuthInput): Promise<InitiateAuthResult> {
    if (!isGoogleOAuthConfigured()) {
      throw new ConnectorAuthError(
        'no_credentials',
        `${this.metadata.displayName} is unavailable — the Google OAuth client is not configured.`
      );
    }
    if (!isAllowedRedirectUri(input.redirectUri)) {
      throw new ConnectorAuthError('unauthorized', 'redirect_uri is not on the allowlist');
    }
    const scopes = input.scopes?.length ? input.scopes : this.metadata.requiredScopes;
    const { codeVerifier, codeChallenge } = generatePkce();
    const state = generateState();
    const authorizationUrl = buildGoogleAuthUrl({
      scopes,
      state,
      codeChallenge,
      redirectUri: input.redirectUri
    });
    return { mode: 'redirect', authorizationUrl, codeVerifier, state };
  }

  async handleCallback(input: HandleCallbackInput): Promise<HandleCallbackResult> {
    const tokens = await exchangeGoogleCode({
      code: input.code,
      codeVerifier: input.codeVerifier,
      redirectUri: input.redirectUri
    });
    const info = await fetchGoogleUserInfo(tokens.accessToken);
    const grantedScopes = tokens.scope ? tokens.scope.split(/\s+/).filter(Boolean) : input.scopes;
    return {
      tokens,
      accountIdentifier: info.email || info.sub || 'google-account',
      accountLabel: info.name || info.email || undefined,
      grantedScopes
    };
  }

  refresh(refreshToken: string): Promise<TokenSet> {
    return refreshGoogleToken(refreshToken);
  }

  async revoke(tokens: TokenSet): Promise<void> {
    await revokeGoogleToken(tokens.refreshToken || tokens.accessToken);
  }

  abstract syncFull(ctx: SyncContext): Promise<SyncResult>;
  abstract syncIncremental(ctx: SyncContext): Promise<SyncResult>;
  abstract fetch(input: FetchInput): Promise<unknown>;
  abstract normalize(raw: unknown): NormalizedItem[];
}

export interface ApiKeyValidation {
  valid: boolean;
  reason?: string;
  accountIdentifier?: string;
  accountLabel?: string;
}

export abstract class ApiKeyConnector implements AccountConnector {
  abstract readonly metadata: ConnectorMetadata;

  /** The shared platform key from env, if configured. */
  protected sharedKey(): string | undefined {
    if (!this.metadata.apiKeyEnv) return undefined;
    const v = process.env[this.metadata.apiKeyEnv];
    return v && v.trim() ? v.trim() : undefined;
  }

  async initiate(input: InitiateAuthInput): Promise<InitiateAuthResult> {
    const key = (input.apiKey && input.apiKey.trim()) || this.sharedKey();
    if (!key) {
      throw new ConnectorAuthError('no_credentials', `${this.metadata.displayName} needs an API key.`);
    }
    const result = await this.validateKey(key);
    if (!result.valid) {
      throw new ConnectorAuthError('unauthorized', result.reason || 'The API key was rejected.');
    }
    return {
      mode: 'completed',
      accountIdentifier: result.accountIdentifier || this.metadata.id,
      accountLabel: result.accountLabel || this.metadata.displayName,
      tokens: { accessToken: key }
    };
  }

  // No OAuth callback for api_key connectors.
  async handleCallback(): Promise<HandleCallbackResult> {
    throw new ConnectorAuthError('unauthorized', `${this.metadata.displayName} does not use an OAuth callback.`);
  }

  // The key is the token; nothing to refresh.
  async refresh(refreshToken: string): Promise<TokenSet> {
    return { accessToken: refreshToken };
  }

  async revoke(): Promise<void> {
    /* api keys aren't revoked provider-side from here; deleting the row suffices. */
  }

  // API-key connectors are query-on-demand by default (fetch()), not synced.
  async syncFull(): Promise<SyncResult> {
    return { items: [], cursor: {}, hasMore: false };
  }

  async syncIncremental(): Promise<SyncResult> {
    return { items: [], cursor: {}, hasMore: false };
  }

  abstract fetch(input: FetchInput): Promise<unknown>;

  normalize(_raw?: unknown): NormalizedItem[] {
    return [];
  }

  /** Validate a candidate key by making a cheap real call. */
  protected abstract validateKey(key: string): Promise<ApiKeyValidation>;
}
