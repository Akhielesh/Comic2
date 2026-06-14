import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import crypto from 'node:crypto';
import {
  generatePkce,
  generateState,
  isAllowedRedirectUri,
  googleRedirectUri,
  exchangeGoogleCode,
  refreshGoogleToken,
  fetchGoogleUserInfo
} from './oauth.js';
import { ConnectorAuthError } from './types.js';

const mockResponse = (body: any, init: { status?: number } = {}) => {
  const status = init.status ?? 200;
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
    json: async () => body
  } as unknown as Response;
};

const b64url = (buf: Buffer) =>
  buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

describe('PKCE + state', () => {
  it('generates a verifier and a matching S256 challenge', () => {
    const { codeVerifier, codeChallenge } = generatePkce();
    expect(codeVerifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const expected = b64url(crypto.createHash('sha256').update(codeVerifier).digest());
    expect(codeChallenge).toBe(expected);
  });

  it('generates unique, URL-safe state nonces (CSRF tokens)', () => {
    const a = generateState();
    const b = generateState();
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[A-Za-z0-9_-]+$/);
  });
});

describe('redirect URI validation', () => {
  it('accepts ONLY the exact configured callback', () => {
    expect(isAllowedRedirectUri(googleRedirectUri())).toBe(true);
    expect(isAllowedRedirectUri('https://evil.example/callback')).toBe(false);
    expect(isAllowedRedirectUri(googleRedirectUri() + '/extra')).toBe(false);
  });
});

describe('token exchange + refresh (mocked Google)', () => {
  beforeEach(() => {
    global.fetch = vi.fn();
  });
  afterEach(() => vi.restoreAllMocks());

  it('exchanges an auth code for a TokenSet', async () => {
    (global.fetch as any).mockResolvedValueOnce(
      mockResponse({ access_token: 'AT', refresh_token: 'RT', expires_in: 3600, scope: 'a b', token_type: 'Bearer' })
    );
    const tokens = await exchangeGoogleCode({ code: 'c', codeVerifier: 'v', redirectUri: googleRedirectUri() });
    expect(tokens.accessToken).toBe('AT');
    expect(tokens.refreshToken).toBe('RT');
    expect(tokens.scope).toBe('a b');
    expect(new Date(tokens.expiresAt!).getTime()).toBeGreaterThan(Date.now());
  });

  it('maps invalid_grant to a typed ConnectorAuthError (revoked/expired)', async () => {
    (global.fetch as any).mockResolvedValueOnce(mockResponse({ error: 'invalid_grant', error_description: 'Token revoked' }, { status: 400 }));
    await expect(refreshGoogleToken('RT')).rejects.toMatchObject({ name: 'ConnectorAuthError', code: 'invalid_grant' });
  });

  it('keeps the existing refresh token when Google omits a new one', async () => {
    (global.fetch as any).mockResolvedValueOnce(mockResponse({ access_token: 'AT2', expires_in: 3600 }));
    const tokens = await refreshGoogleToken('RT-keep');
    expect(tokens.accessToken).toBe('AT2');
    expect(tokens.refreshToken).toBe('RT-keep');
  });

  it('throws when refreshing without a refresh token', async () => {
    await expect(refreshGoogleToken('')).rejects.toBeInstanceOf(ConnectorAuthError);
  });

  it('resolves the connected account email from userinfo', async () => {
    (global.fetch as any).mockResolvedValueOnce(mockResponse({ email: 'me@example.com', name: 'Me', sub: '123' }));
    const info = await fetchGoogleUserInfo('AT');
    expect(info.email).toBe('me@example.com');
    expect(info.name).toBe('Me');
  });

  it('surfaces a userinfo failure as an auth error', async () => {
    (global.fetch as any).mockResolvedValueOnce(mockResponse('nope', { status: 401 }));
    await expect(fetchGoogleUserInfo('AT')).rejects.toBeInstanceOf(ConnectorAuthError);
  });
});

describe('authorization URL building (configured client)', () => {
  it('builds a consent URL with PKCE + offline access when a client is configured', async () => {
    vi.stubEnv('GOOGLE_OAUTH_CLIENT_ID', 'test-client-id');
    vi.stubEnv('GOOGLE_OAUTH_CLIENT_SECRET', 'test-secret');
    vi.resetModules();
    const oauth = await import('./oauth.js');
    expect(oauth.isGoogleOAuthConfigured()).toBe(true);
    const url = oauth.buildGoogleAuthUrl({
      scopes: ['https://www.googleapis.com/auth/gmail.readonly'],
      state: 'STATE',
      codeChallenge: 'CHAL',
      redirectUri: oauth.googleRedirectUri()
    });
    const parsed = new URL(url);
    expect(parsed.searchParams.get('client_id')).toBe('test-client-id');
    expect(parsed.searchParams.get('code_challenge')).toBe('CHAL');
    expect(parsed.searchParams.get('code_challenge_method')).toBe('S256');
    expect(parsed.searchParams.get('access_type')).toBe('offline');
    expect(parsed.searchParams.get('state')).toBe('STATE');
    vi.unstubAllEnvs();
    vi.resetModules();
  });
});
