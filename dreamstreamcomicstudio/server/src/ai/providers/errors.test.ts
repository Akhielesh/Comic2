import { describe, it, expect } from 'vitest';
import { makeProviderError, safeClientMessage, vendorHttpError } from './errors.js';

describe('vendorHttpError', () => {
  const FAKE_OPENAI = `sk-proj-${'test0000'.repeat(6)}`;

  it('keeps the status and the vendor code, and never the key a 401 body echoes', () => {
    const body = JSON.stringify({
      error: { message: 'Incorrect API key provided: sk-proj-abcd…wxyz', type: 'invalid_request_error', code: 'invalid_api_key' }
    });
    const e = vendorHttpError('OpenAI', '/chat/completions', 401, 'Unauthorized', body);
    expect(e).toBeInstanceOf(Error);
    expect(e.status).toBe(401);
    expect(e.message).toMatch(/^OpenAI \/chat\/completions failed: 401 Unauthorized \(invalid_api_key\) /);
    expect(e.message).not.toMatch(/sk-/);
    // comic/llm.ts statusOf reads "failed: NNN" from the message.
    expect(/\bfailed:\s*(\d{3})\b/.exec(e.message)?.[1]).toBe('401');
  });

  it('keeps content_policy_violation on a 400 so the safety classifier still sees it', () => {
    const body = JSON.stringify({ error: { message: 'Your request was rejected by our safety system.', code: 'content_policy_violation' } });
    const e = vendorHttpError('OpenAI', '/images/generations', 400, 'Bad Request', body);
    expect(e.status).toBe(400);
    expect(e.message).toContain('content_policy_violation');
    expect(e.message).toMatch(/failed: 400/);
  });

  it('reads Anthropic and Gemini error shapes, skipping a numeric code that repeats the status', () => {
    const anthropic = vendorHttpError(
      'Anthropic',
      '/messages',
      401,
      'Unauthorized',
      JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } })
    );
    expect(anthropic.message).toBe('Anthropic /messages failed: 401 Unauthorized (authentication_error) invalid x-api-key');
    const gemini = vendorHttpError(
      'Gemini',
      '/chat/completions',
      400,
      '',
      JSON.stringify([{ error: { code: 400, message: 'API key not valid. Please pass a valid API key.', status: 'INVALID_ARGUMENT' } }])
    );
    expect(gemini.message).toBe('Gemini /chat/completions failed: 400 (INVALID_ARGUMENT) API key not valid. Please pass a valid API key.');
  });

  it('caps the detail at 160 characters and redacts a non-JSON body', () => {
    const long = vendorHttpError('xAI', '/chat/completions', 500, 'Internal Server Error', `upstream said ${FAKE_OPENAI} ${'x'.repeat(400)}`);
    expect(long.message).not.toContain('sk-proj');
    const detail = long.message.replace(/^xAI \/chat\/completions failed: 500 Internal Server Error /, '');
    expect(detail.length).toBeLessThanOrEqual(160);
    const huge = vendorHttpError('OpenAI', '/chat/completions', 429, 'Too Many Requests', JSON.stringify({ error: { message: 'm'.repeat(5000), code: 'rate_limit_exceeded' } }));
    expect(huge.message.length).toBeLessThan(260);
    expect(huge.message).toContain('(rate_limit_exceeded)');
  });

  it('drops a code that is not a short plain token', () => {
    const e = vendorHttpError('OpenAI', '/chat/completions', 403, 'Forbidden', JSON.stringify({ error: { message: 'no', code: 'has spaces <b>', type: 'x'.repeat(60) } }));
    expect(e.message).toBe('OpenAI /chat/completions failed: 403 Forbidden no');
  });

  it('handles an empty body and a redacted status text', () => {
    const e = vendorHttpError('Anthropic', 'stream', 529, `Overloaded ${FAKE_OPENAI}`, '');
    expect(e.message).toBe('Anthropic stream failed: 529 Overloaded [key]');
  });
});

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
