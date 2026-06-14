import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { googleApiFetch } from './googleClient.js';
import { ConnectorAuthError, ConnectorRateLimitError } from './types.js';

const mockResponse = (body: any, init: { status?: number; headers?: Record<string, string> } = {}) => {
  const status = init.status ?? 200;
  const headers = init.headers ?? {};
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (k: string) => headers[k.toLowerCase()] ?? null },
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
    json: async () => body
  } as unknown as Response;
};

describe('googleApiFetch', () => {
  beforeEach(() => {
    global.fetch = vi.fn();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('returns parsed JSON on success', async () => {
    (global.fetch as any).mockResolvedValueOnce(mockResponse({ ok: true, n: 5 }));
    const out = await googleApiFetch<{ ok: boolean; n: number }>('https://gmail.googleapis.com/x', { accessToken: 't' });
    expect(out).toEqual({ ok: true, n: 5 });
  });

  it('returns {} for an empty 204 body', async () => {
    (global.fetch as any).mockResolvedValueOnce(mockResponse('', { status: 204 }));
    const out = await googleApiFetch('https://gmail.googleapis.com/x', { accessToken: 't' });
    expect(out).toEqual({});
  });

  it('throws a typed auth error on 401 (revoked/expired token)', async () => {
    (global.fetch as any).mockResolvedValueOnce(mockResponse('unauthorized', { status: 401 }));
    await expect(googleApiFetch('https://gmail.googleapis.com/x', { accessToken: 't' })).rejects.toBeInstanceOf(
      ConnectorAuthError
    );
  });

  it('surfaces a non-retryable 4xx with a clear message', async () => {
    (global.fetch as any).mockResolvedValueOnce(mockResponse({ error: { message: 'Bad scope' } }, { status: 400 }));
    await expect(googleApiFetch('https://gmail.googleapis.com/x', { accessToken: 't' })).rejects.toThrow(/Bad scope/);
  });

  it('throws ConnectorRateLimitError on 429 once retries are exhausted', async () => {
    (global.fetch as any).mockResolvedValue(mockResponse('rate', { status: 429, headers: { 'retry-after': '0' } }));
    await expect(googleApiFetch('https://gmail.googleapis.com/x', { accessToken: 't', maxRetries: 0 })).rejects.toBeInstanceOf(
      ConnectorRateLimitError
    );
  });

  it('treats a 403 insufficient-scope as a reconnect-worthy auth error', async () => {
    (global.fetch as any).mockResolvedValue(
      mockResponse({ error: { status: 'PERMISSION_DENIED', message: 'Request had insufficient authentication scopes.' } }, { status: 403 })
    );
    await expect(
      googleApiFetch('https://gmail.googleapis.com/x', { accessToken: 't', maxRetries: 0 })
    ).rejects.toBeInstanceOf(ConnectorAuthError);
  });

  it('keeps a 403 "API disabled" as a hard (non-auth) error so it is not mistaken for a reconnect', async () => {
    (global.fetch as any).mockResolvedValue(
      mockResponse(
        { error: { status: 'PERMISSION_DENIED', message: 'Gmail API has not been used in project 123 before or it is disabled.' } },
        { status: 403 }
      )
    );
    const err = (await googleApiFetch('https://gmail.googleapis.com/x', { accessToken: 't', maxRetries: 0 }).catch(
      (e) => e
    )) as Error;
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(ConnectorAuthError);
    expect(err.message).toMatch(/disabled/i);
  });

  it('treats a 403 rateLimitExceeded as retryable quota, not a hard error', async () => {
    (global.fetch as any).mockResolvedValue(
      mockResponse({ error: { errors: [{ reason: 'rateLimitExceeded' }], message: 'rateLimitExceeded' } }, { status: 403 })
    );
    await expect(googleApiFetch('https://gmail.googleapis.com/x', { accessToken: 't', maxRetries: 0 })).rejects.toBeInstanceOf(
      ConnectorRateLimitError
    );
  });

  it('retries on 429 with backoff and then succeeds', async () => {
    vi.useFakeTimers();
    (global.fetch as any)
      .mockResolvedValueOnce(mockResponse('rate', { status: 429 }))
      .mockResolvedValueOnce(mockResponse({ done: true }));
    const p = googleApiFetch<{ done: boolean }>('https://gmail.googleapis.com/y', { accessToken: 't', maxRetries: 2 });
    await vi.advanceTimersByTimeAsync(20_000);
    await expect(p).resolves.toEqual({ done: true });
    expect((global.fetch as any).mock.calls.length).toBe(2);
  });

  it('retries on 5xx and then succeeds', async () => {
    vi.useFakeTimers();
    (global.fetch as any)
      .mockResolvedValueOnce(mockResponse('boom', { status: 503 }))
      .mockResolvedValueOnce(mockResponse({ ok: 1 }));
    const p = googleApiFetch('https://gmail.googleapis.com/z', { accessToken: 't', maxRetries: 2 });
    await vi.advanceTimersByTimeAsync(20_000);
    await expect(p).resolves.toEqual({ ok: 1 });
  });
});
