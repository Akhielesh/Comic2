import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./store.js', () => ({
  loadCredentials: vi.fn(),
  saveCredentials: vi.fn(),
  setConnectionStatus: vi.fn()
}));

import { getValidAccessToken, markReconnectIfAuth } from './credentials.js';
import * as store from './store.js';
import { ConnectorAuthError } from './types.js';
import { encryptSecret, decryptSecret } from '../lib/secureStore.js';

const fakeConnector = (refreshImpl?: (rt: string) => any) => ({
  metadata: { id: 'gmail' },
  refresh: vi.fn(refreshImpl || (async (rt: string) => ({ accessToken: 'NEW', refreshToken: rt, expiresAt: new Date(Date.now() + 3600_000).toISOString() })))
}) as any;

const conn = (status = 'connected') => ({ id: 'c1', user_id: 'u1', connector_id: 'gmail', status }) as any;

beforeEach(() => vi.clearAllMocks());

describe('token encryption round-trip (AES-256-GCM)', () => {
  it('encrypts and decrypts a token symmetrically with the server key', () => {
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-key';
    const enc = encryptSecret('ya29.super-secret-access-token');
    expect(enc).toBeTruthy();
    expect(enc!.ciphertext).not.toContain('super-secret');
    const back = decryptSecret(enc!.ciphertext, enc!.iv);
    expect(back).toBe('ya29.super-secret-access-token');
  });

  it('fails closed when the wrapping key changes (ciphertext is useless without the secret)', () => {
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'key-A';
    const enc = encryptSecret('token')!;
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'key-B';
    expect(decryptSecret(enc.ciphertext, enc.iv)).toBeNull();
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-key';
  });
});

describe('getValidAccessToken', () => {
  it('returns an API key unchanged (no refresh)', async () => {
    (store.loadCredentials as any).mockResolvedValue({ tokenType: 'api_key', accessToken: 'KEY', refreshToken: null, expiresAt: null });
    const c = fakeConnector();
    expect(await getValidAccessToken(conn(), c)).toBe('KEY');
    expect(c.refresh).not.toHaveBeenCalled();
  });

  it('returns a comfortably-valid access token without refreshing', async () => {
    (store.loadCredentials as any).mockResolvedValue({
      tokenType: 'oauth2',
      accessToken: 'AT',
      refreshToken: 'RT',
      expiresAt: new Date(Date.now() + 3600_000).toISOString()
    });
    const c = fakeConnector();
    expect(await getValidAccessToken(conn(), c)).toBe('AT');
    expect(c.refresh).not.toHaveBeenCalled();
  });

  it('refreshes an expired token, persists it, and clears the error state', async () => {
    (store.loadCredentials as any).mockResolvedValue({
      tokenType: 'oauth2',
      accessToken: 'OLD',
      refreshToken: 'RT',
      expiresAt: new Date(Date.now() - 1000).toISOString()
    });
    const c = fakeConnector();
    const token = await getValidAccessToken(conn('error'), c);
    expect(token).toBe('NEW');
    expect(c.refresh).toHaveBeenCalledWith('RT');
    expect(store.saveCredentials).toHaveBeenCalledWith('c1', 'u1', 'oauth2', expect.objectContaining({ accessToken: 'NEW' }));
    expect(store.setConnectionStatus).toHaveBeenCalledWith('c1', 'connected', null);
  });

  it('marks the connection expired (reconnect) when the refresh token is revoked', async () => {
    (store.loadCredentials as any).mockResolvedValue({
      tokenType: 'oauth2',
      accessToken: 'OLD',
      refreshToken: 'RT',
      expiresAt: new Date(Date.now() - 1000).toISOString()
    });
    const c = fakeConnector(async () => {
      throw new ConnectorAuthError('invalid_grant', 'Token has been revoked');
    });
    await expect(getValidAccessToken(conn(), c)).rejects.toBeInstanceOf(ConnectorAuthError);
    expect(store.setConnectionStatus).toHaveBeenCalledWith('c1', 'expired', expect.any(String));
  });

  it('marks expired when there are no stored credentials', async () => {
    (store.loadCredentials as any).mockResolvedValue(null);
    await expect(getValidAccessToken(conn(), fakeConnector())).rejects.toMatchObject({ code: 'no_credentials' });
    expect(store.setConnectionStatus).toHaveBeenCalledWith('c1', 'expired', expect.any(String));
  });

  it('marks expired when the access token is expired and there is no refresh token', async () => {
    (store.loadCredentials as any).mockResolvedValue({
      tokenType: 'oauth2',
      accessToken: 'OLD',
      refreshToken: null,
      expiresAt: new Date(Date.now() - 1000).toISOString()
    });
    await expect(getValidAccessToken(conn(), fakeConnector())).rejects.toMatchObject({ code: 'expired' });
    expect(store.setConnectionStatus).toHaveBeenCalledWith('c1', 'expired', expect.any(String));
  });
});

describe('markReconnectIfAuth', () => {
  it('maps revoked/expired auth errors to a reconnect status', async () => {
    await markReconnectIfAuth(conn(), new ConnectorAuthError('invalid_grant', 'x'));
    expect(store.setConnectionStatus).toHaveBeenCalledWith('c1', 'expired', expect.any(String));
  });

  it('maps a generic failure to an error status', async () => {
    await markReconnectIfAuth(conn(), new Error('network down'));
    expect(store.setConnectionStatus).toHaveBeenCalledWith('c1', 'error', expect.stringContaining('network down'));
  });
});
