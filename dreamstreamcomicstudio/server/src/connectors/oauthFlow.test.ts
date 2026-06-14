import { describe, it, expect, vi, afterEach } from 'vitest';

// Integration-ish: the OAuth connector lifecycle (initiate → handleCallback) against
// mocked Google endpoints. The CSRF `state` nonce + PKCE verifier returned by
// initiate are what the route persists (one-time) and validates on callback.

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

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.resetModules();
});

const importGmailConfigured = async () => {
  vi.stubEnv('GOOGLE_OAUTH_CLIENT_ID', 'cid');
  vi.stubEnv('GOOGLE_OAUTH_CLIENT_SECRET', 'sec');
  vi.resetModules();
  const { GmailConnector } = await import('./connectors/gmail.js');
  const { googleRedirectUri } = await import('./oauth.js');
  return { GmailConnector, googleRedirectUri };
};

describe('OAuth connector flow', () => {
  it('initiate returns a redirect URL with PKCE + a CSRF state nonce', async () => {
    const { GmailConnector, googleRedirectUri } = await importGmailConfigured();
    const res = await new GmailConnector().initiate({ userId: 'u1', redirectUri: googleRedirectUri() });
    expect(res.mode).toBe('redirect');
    expect(res.authorizationUrl).toContain('code_challenge=');
    expect(res.authorizationUrl).toContain('code_challenge_method=S256');
    expect(res.state).toBeTruthy();
    expect(res.codeVerifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('initiate rejects a redirect_uri that is not the configured callback (open-redirect guard)', async () => {
    const { GmailConnector } = await importGmailConfigured();
    await expect(
      new GmailConnector().initiate({ userId: 'u1', redirectUri: 'https://evil.example/callback' })
    ).rejects.toMatchObject({ code: 'unauthorized' });
  });

  it('initiate fails clearly when no Google client is configured', async () => {
    vi.resetModules();
    const { GmailConnector } = await import('./connectors/gmail.js');
    const { googleRedirectUri } = await import('./oauth.js');
    await expect(
      new GmailConnector().initiate({ userId: 'u1', redirectUri: googleRedirectUri() })
    ).rejects.toMatchObject({ code: 'no_credentials' });
  });

  it('handleCallback exchanges the code and resolves the connected account', async () => {
    vi.resetModules();
    const { GmailConnector } = await import('./connectors/gmail.js');
    global.fetch = vi
      .fn()
      .mockResolvedValueOnce(
        mockResponse({ access_token: 'AT', refresh_token: 'RT', expires_in: 3600, scope: 'https://www.googleapis.com/auth/gmail.readonly', token_type: 'Bearer' })
      )
      .mockResolvedValueOnce(mockResponse({ email: 'me@example.com', name: 'Me', sub: '42' })) as any;

    const res = await new GmailConnector().handleCallback({
      code: 'auth-code',
      codeVerifier: 'verifier',
      redirectUri: 'https://app/api/connectors/oauth/callback',
      userId: 'u1',
      scopes: ['https://www.googleapis.com/auth/gmail.readonly']
    });

    expect(res.tokens.accessToken).toBe('AT');
    expect(res.tokens.refreshToken).toBe('RT');
    expect(res.accountIdentifier).toBe('me@example.com');
    expect(res.accountLabel).toBe('Me');
    expect(res.grantedScopes).toContain('https://www.googleapis.com/auth/gmail.readonly');
  });
});
