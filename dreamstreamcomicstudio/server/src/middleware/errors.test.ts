import { describe, it, expect, vi, beforeEach } from 'vitest';

// recordServerError writes to the telemetry store (Supabase) — mock it so we can assert
// WHETHER it's called without touching the network.
vi.mock('../services/telemetryStore.js', () => ({ recordServerError: vi.fn() }));

import { recordServerError } from '../services/telemetryStore.js';
import { errorHandler } from './errors.js';
import { modelTimeoutError } from '../ai/providers/errors.js';

const mockRes = () => {
  const res: { status: ReturnType<typeof vi.fn>; json: ReturnType<typeof vi.fn>; body?: unknown; code?: number } = {} as never;
  res.status = vi.fn((c: number) => { res.code = c; return res; });
  res.json = vi.fn((b: unknown) => { res.body = b; return res; });
  return res;
};
const mockReq = () => ({ requestId: 'r1', originalUrl: '/api/chat', method: 'POST', ip: '1.2.3.4' }) as never;

describe('modelTimeoutError', () => {
  it('is a 504 with a user-safe public message', () => {
    const e = modelTimeoutError(90000);
    expect(e.status).toBe(504);
    expect(e.publicCode).toBe('MODEL_TIMEOUT');
    expect(e.publicMessage).toContain('took too long');
    expect(e.message).toContain('90s');
  });
});

describe('errorHandler', () => {
  beforeEach(() => vi.clearAllMocks());

  it('maps a model timeout to 504 GATEWAY_TIMEOUT with the friendly message, and does NOT record it as a server error', () => {
    const res = mockRes();
    errorHandler(modelTimeoutError(90000), mockReq(), res as never, (() => {}) as never);
    expect(res.code).toBe(504);
    const body = res.body as { error: { code: string; message: string } };
    expect(body.error.code).toBe('MODEL_TIMEOUT'); // specific publicCode wins over generic GATEWAY_TIMEOUT
    expect(body.error.message).toContain('faster model');
    expect(recordServerError).not.toHaveBeenCalled();
  });

  it('records a genuine 500 as a server error', () => {
    const res = mockRes();
    errorHandler({ message: 'boom' }, mockReq(), res as never, (() => {}) as never);
    expect(res.code).toBe(500);
    expect((res.body as { error: { code: string } }).error.code).toBe('INTERNAL_ERROR');
    expect(recordServerError).toHaveBeenCalledTimes(1);
  });

  it('never logs or records a share capability or a query token (S19)', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const cases: [string, string][] = [
      ['/api/shares/token/tok_abc123XYZ?x=1', '/api/shares/token/:token'],
      ['/api/comic/public/s/Ab3dEf6hIj9kLm2nP/report', '/api/comic/public/s/:slug/report'],
      ['/api/newsletter/confirm?t=NEWSLETTERTOKEN', '/api/newsletter/confirm']
    ];
    for (const [originalUrl, masked] of cases) {
      vi.mocked(recordServerError).mockClear();
      error.mockClear();
      const req = { requestId: 'r1', originalUrl, url: originalUrl, method: 'GET', ip: '1.2.3.4' } as never;
      errorHandler({ message: 'boom' }, req, mockRes() as never, (() => {}) as never);
      const line = String(error.mock.calls[0][0]);
      expect(JSON.parse(line).path).toBe(masked);
      for (const secret of ['tok_abc123XYZ', 'Ab3dEf6hIj9kLm2nP', 'NEWSLETTERTOKEN']) expect(line).not.toContain(secret);
      expect(vi.mocked(recordServerError).mock.calls[0][0].path).toBe(masked);
    }
    error.mockRestore();
  });
});
