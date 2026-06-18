import { describe, it, expect } from 'vitest';
import { makeProviderError, safeClientMessage } from './errors.js';

describe('makeProviderError', () => {
  it('tags a 403 shared-key spend cap as 503 capacity with a safe, actionable message', () => {
    const e = makeProviderError(
      403,
      'OpenRouter /chat/completions failed: 403 Forbidden {"error":{"message":"Key limit exceeded (total limit)"}}'
    );
    expect(e.status).toBe(503);
    expect(e.publicCode).toBe('PROVIDER_CAPACITY');
    expect(e.publicMessage).toMatch(/capacity|free model|your own API key/i);
    // Original upstream text is preserved for logs AND so the message-based retriable
    // checks (which look for 403/404/429) keep working.
    expect(e.message).toMatch(/403/);
  });

  it('tags 402 out-of-credits as capacity', () => {
    const e = makeProviderError(402, '402 Payment Required: requires more credits, or fewer max_tokens');
    expect(e.status).toBe(503);
    expect(e.publicCode).toBe('PROVIDER_CAPACITY');
    expect(e.publicMessage).toMatch(/credits|free model/i);
  });

  it('tags 429 as rate limited', () => {
    const e = makeProviderError(429, '429 Too Many Requests');
    expect(e.status).toBe(429);
    expect(e.publicCode).toBe('RATE_LIMITED');
  });

  it('maps an unknown-model 400 to MODEL_NOT_FOUND', () => {
    const e = makeProviderError(400, '400 Bad Request: foo/bar is not a valid model id');
    expect(e.status).toBe(400);
    expect(e.publicCode).toBe('MODEL_NOT_FOUND');
  });

  it('maps an upstream 5xx to 502 Bad Gateway (their fault, not ours)', () => {
    const e = makeProviderError(503, '503 Service Unavailable');
    expect(e.status).toBe(502);
    expect(e.publicCode).toBe('BAD_GATEWAY');
    expect(e.publicMessage).toMatch(/provider|try again/i);
  });

  it('preserves other 4xx status without leaking a public message', () => {
    const e = makeProviderError(404, 'No endpoints found for foo/bar');
    expect(e.status).toBe(404);
    expect(e.publicMessage).toBeUndefined();
    expect(e.message).toMatch(/no endpoints/i);
  });
});

describe('safeClientMessage', () => {
  it('prefers an explicit publicMessage', () => {
    const e = Object.assign(new Error('raw internal text'), { publicMessage: 'Switch to a faster model.' });
    expect(safeClientMessage(e)).toBe('Switch to a faster model.');
  });

  it('blocks raw provider JSON and uses the fallback', () => {
    expect(safeClientMessage(new Error('OpenRouter /chat failed: 403 {"error":{"message":"x"}}'))).toMatch(
      /failed\. please try again/i
    );
  });

  it('blocks raw SQL/uuid errors and uses the fallback', () => {
    expect(safeClientMessage(new Error('invalid input syntax for type uuid: "demo-connection"'))).toMatch(/try again/i);
  });

  it('passes through a clean, actionable upstream phrasing', () => {
    expect(safeClientMessage(new Error('The model returned no response. Please try again.'))).toMatch(/no response/i);
  });

  it('uses the provided fallback when nothing is safe', () => {
    expect(safeClientMessage(undefined, 'The swarm failed. Please try again.')).toMatch(/swarm failed/i);
  });
});
