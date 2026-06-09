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
});
