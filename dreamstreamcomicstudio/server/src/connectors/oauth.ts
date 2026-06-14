// ============================================================================
// Google OAuth 2.0 + PKCE helpers (shared by every user_oauth connector)
// ============================================================================
//
// A custom server-side OAuth flow (chosen over Supabase's social provider so we can:
// hold multiple independent per-service connections with incremental least-privilege
// scopes; own token refresh/revocation; encrypt tokens at rest in OUR DB; and model
// API-key connectors in the SAME framework). All Google connectors share ONE OAuth
// client; scopes differ per connector.
//
// PKCE: we generate a high-entropy code_verifier, send only its S256 challenge to
// Google, and store the verifier server-side (encrypted, keyed by the CSRF `state`
// nonce) so an intercepted authorization code is useless without it.
// ============================================================================

import crypto from 'node:crypto';
import {
  GOOGLE_OAUTH_CLIENT_ID,
  GOOGLE_OAUTH_CLIENT_SECRET,
  GOOGLE_OAUTH_REDIRECT_URL
} from '../config.js';
import { ConnectorAuthError, type TokenSet } from './types.js';

const GOOGLE_AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const GOOGLE_REVOKE_ENDPOINT = 'https://oauth2.googleapis.com/revoke';
const GOOGLE_USERINFO_ENDPOINT = 'https://www.googleapis.com/oauth2/v3/userinfo';

const base64url = (buf: Buffer): string =>
  buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/** Whether a Google OAuth client is configured (else the OAuth path is inert). */
export const isGoogleOAuthConfigured = (): boolean =>
  Boolean(GOOGLE_OAUTH_CLIENT_ID && GOOGLE_OAUTH_CLIENT_SECRET);

/** RFC 7636 PKCE pair. The verifier is 32 random bytes (43-char base64url). */
export const generatePkce = (): { codeVerifier: string; codeChallenge: string } => {
  const codeVerifier = base64url(crypto.randomBytes(32));
  const codeChallenge = base64url(crypto.createHash('sha256').update(codeVerifier).digest());
  return { codeVerifier, codeChallenge };
};

/** Unguessable, one-time CSRF state nonce (also the lookup key for the verifier). */
export const generateState = (): string => base64url(crypto.randomBytes(32));

/**
 * STRICT redirect-URI validation. Only the exact configured callback is allowed —
 * never a caller-supplied or pattern-matched value (open-redirect / token-theft guard).
 */
export const isAllowedRedirectUri = (redirectUri: string): boolean =>
  redirectUri === GOOGLE_OAUTH_REDIRECT_URL;

export const googleRedirectUri = (): string => GOOGLE_OAUTH_REDIRECT_URL;

/** Build the consent URL. `access_type=offline` + `prompt=consent` to obtain a refresh token. */
export const buildGoogleAuthUrl = (opts: {
  scopes: string[];
  state: string;
  codeChallenge: string;
  redirectUri: string;
  loginHint?: string;
}): string => {
  if (!isGoogleOAuthConfigured()) {
    throw new ConnectorAuthError('no_credentials', 'Google OAuth client is not configured');
  }
  const params = new URLSearchParams({
    client_id: GOOGLE_OAUTH_CLIENT_ID,
    redirect_uri: opts.redirectUri,
    response_type: 'code',
    scope: opts.scopes.join(' '),
    state: opts.state,
    code_challenge: opts.codeChallenge,
    code_challenge_method: 'S256',
    access_type: 'offline',
    include_granted_scopes: 'true',
    prompt: 'consent'
  });
  if (opts.loginHint) params.set('login_hint', opts.loginHint);
  return `${GOOGLE_AUTH_ENDPOINT}?${params.toString()}`;
};

interface GoogleTokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  token_type?: string;
  error?: string;
  error_description?: string;
}

const expiresAtFrom = (expiresIn?: number): string | null =>
  typeof expiresIn === 'number' && expiresIn > 0
    ? new Date(Date.now() + expiresIn * 1000).toISOString()
    : null;

const postForm = async (url: string, form: Record<string, string>): Promise<GoogleTokenResponse> => {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(form).toString()
  });
  let json: GoogleTokenResponse = {};
  try {
    json = (await res.json()) as GoogleTokenResponse;
  } catch {
    throw new ConnectorAuthError('unauthorized', `Google token endpoint returned a non-JSON ${res.status} response`);
  }
  if (!res.ok || json.error) {
    // invalid_grant is Google's signal for a revoked/expired refresh token.
    const code = json.error === 'invalid_grant' ? 'invalid_grant' : 'unauthorized';
    throw new ConnectorAuthError(code, json.error_description || json.error || `Google token error (${res.status})`);
  }
  return json;
};

/** Exchange an authorization code (+ PKCE verifier) for a TokenSet. */
export const exchangeGoogleCode = async (opts: {
  code: string;
  codeVerifier: string;
  redirectUri: string;
}): Promise<TokenSet> => {
  const json = await postForm(GOOGLE_TOKEN_ENDPOINT, {
    client_id: GOOGLE_OAUTH_CLIENT_ID,
    client_secret: GOOGLE_OAUTH_CLIENT_SECRET,
    code: opts.code,
    code_verifier: opts.codeVerifier,
    grant_type: 'authorization_code',
    redirect_uri: opts.redirectUri
  });
  if (!json.access_token) {
    throw new ConnectorAuthError('unauthorized', 'Google did not return an access token');
  }
  return {
    accessToken: json.access_token,
    refreshToken: json.refresh_token ?? null,
    expiresAt: expiresAtFrom(json.expires_in),
    scope: json.scope ?? null,
    tokenType: json.token_type || 'Bearer'
  };
};

/** Refresh an access token from a stored refresh token. */
export const refreshGoogleToken = async (refreshToken: string): Promise<TokenSet> => {
  if (!refreshToken) throw new ConnectorAuthError('no_credentials', 'No refresh token on file');
  const json = await postForm(GOOGLE_TOKEN_ENDPOINT, {
    client_id: GOOGLE_OAUTH_CLIENT_ID,
    client_secret: GOOGLE_OAUTH_CLIENT_SECRET,
    refresh_token: refreshToken,
    grant_type: 'refresh_token'
  });
  if (!json.access_token) {
    throw new ConnectorAuthError('invalid_grant', 'Refresh did not yield an access token');
  }
  return {
    accessToken: json.access_token,
    // Google usually omits a new refresh token on refresh — keep the existing one.
    refreshToken: json.refresh_token ?? refreshToken,
    expiresAt: expiresAtFrom(json.expires_in),
    scope: json.scope ?? null,
    tokenType: json.token_type || 'Bearer'
  };
};

/** Best-effort provider-side revocation. Never throws on a 4xx (already-revoked). */
export const revokeGoogleToken = async (token: string): Promise<void> => {
  if (!token) return;
  try {
    await fetch(`${GOOGLE_REVOKE_ENDPOINT}?token=${encodeURIComponent(token)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
    });
  } catch {
    // Revocation is best-effort; the local credential delete is what matters.
  }
};

/** Resolve the connected Google account identity (email + name) from an access token. */
export const fetchGoogleUserInfo = async (
  accessToken: string
): Promise<{ email: string; name?: string; sub?: string }> => {
  const res = await fetch(GOOGLE_USERINFO_ENDPOINT, {
    headers: { Authorization: `Bearer ${accessToken}` }
  });
  if (!res.ok) {
    throw new ConnectorAuthError('unauthorized', `Could not read Google account profile (${res.status})`);
  }
  const json = (await res.json()) as { email?: string; name?: string; sub?: string };
  return { email: json.email || '', name: json.name, sub: json.sub };
};
