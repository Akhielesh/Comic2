import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { addKey, clearAllKeys } from './apiKeys';
import { setLocalOwner, clearLocalOwner } from './localOwner';
import { setProviderEnabled } from './sourceGovernance';

const getSession = vi.hoisted(() => vi.fn());
vi.mock('./supabase', () => ({ supabase: { auth: { getSession } }, isStoredSession: () => true }));
import { checkPersonalProviderBalance, fetchAccountProviderUsage } from './accountProviderUsage';

const owner = '11111111-1111-4111-8111-111111111111';
const other = '22222222-2222-4222-8222-222222222222';
const request = vi.fn();
const signal = () => new AbortController().signal;

beforeEach(() => {
  vi.stubGlobal('fetch', request);
  getSession.mockResolvedValue({ data: { session: { access_token: 'signed-in-token', user: { id: owner } } } });
  setLocalOwner(owner);
  setProviderEnabled('deepseek', true);
  addKey({ provider: 'deepseek', label: 'A', key: 'selected-secret' });
  addKey({ provider: 'openrouter', label: 'B', key: 'unrelated-secret' });
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  clearAllKeys();
  clearLocalOwner();
});

describe('provider activity request privacy', () => {
  it('loads recorded activity using only the signed-in account bearer and bypasses HTTP caches', async () => {
    request.mockResolvedValue(new Response(JSON.stringify({ sources: {}, providers: [], balanceReports: [] })));
    await fetchAccountProviderUsage(owner, signal());
    expect(request.mock.calls[0][0]).toBe('/api/usage/account-providers');
    expect(request.mock.calls[0][1]).toMatchObject({ headers: { Authorization: 'Bearer signed-in-token' }, cache: 'no-store' });
    expect(Object.keys(request.mock.calls[0][1].headers)).toEqual(['Authorization', 'X-Allowed-Sources']);
    expect(JSON.stringify(request.mock.calls)).not.toContain('secret');
  });

  it('sends only the selected key on an explicit balance check and supports a cloud-only key', async () => {
    request.mockImplementation(async () => new Response(JSON.stringify({ report: { provider: 'deepseek' }, saved: true })));
    await checkPersonalProviderBalance(owner, 'deepseek', signal());
    const [url, init] = request.mock.calls[0];
    expect(url).toBe('/api/keys/balance');
    expect(init.headers['X-DeepSeek-Key']).toBe('selected-secret');
    expect(init.headers['X-OpenRouter-Key']).toBeUndefined();
    expect(JSON.parse(init.body)).toEqual({ provider: 'deepseek' });
    expect(url + init.body).not.toContain('secret');
    clearAllKeys();
    await checkPersonalProviderBalance(owner, 'deepseek', signal());
    expect(request.mock.calls[1][1].headers['X-DeepSeek-Key']).toBeUndefined();
  });

  it('avoids even a request when another account owns the session or device, or the provider is off', async () => {
    await expect(fetchAccountProviderUsage(other, signal())).rejects.toThrow();
    await expect(checkPersonalProviderBalance(other, 'deepseek', signal())).rejects.toThrow();
    setLocalOwner(other);
    await expect(checkPersonalProviderBalance(owner, 'deepseek', signal())).rejects.toThrow();
    setLocalOwner(owner);
    setProviderEnabled('deepseek', false);
    await expect(checkPersonalProviderBalance(owner, 'deepseek', signal())).rejects.toThrow();
    expect(request).not.toHaveBeenCalled();
  });

  it('does not surface arbitrary upstream diagnostics or mismatched provider reads', async () => {
    request.mockResolvedValueOnce(new Response('credential-diagnostic', { status: 502 }));
    await expect(checkPersonalProviderBalance(owner, 'deepseek', signal())).rejects.toThrow('Balance unavailable');
    request.mockResolvedValueOnce(new Response(JSON.stringify({ report: { provider: 'openrouter' }, saved: true })));
    await expect(checkPersonalProviderBalance(owner, 'deepseek', signal())).rejects.toThrow('Balance unavailable');
  });
});
