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
    expect(e.vendorStatus).toBe(401);
    expect(e.message).toMatch(/^OpenAI \/chat\/completions failed: 401 Unauthorized \(invalid_api_key\) /);
    expect(e.message).not.toMatch(/sk-/);
    // comic/llm.ts statusOf reads "failed: NNN" from the message.
    expect(/\bfailed:\s*(\d{3})\b/.exec(e.message)?.[1]).toBe('401');
  });

  it('keeps content_policy_violation on a 400 so the safety classifier still sees it', () => {
    const body = JSON.stringify({ error: { message: 'Your request was rejected by our safety system.', code: 'content_policy_violation' } });
    const e = vendorHttpError('OpenAI', '/images/generations', 400, 'Bad Request', body);
    expect(e.vendorStatus).toBe(400);
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

  it('drops a vendor code that is shaped like a key', () => {
    const deepseekShaped = `sk-${'a'.repeat(32)}`;
    const e = vendorHttpError('X', '/p', 401, 'Unauthorized', JSON.stringify({ error: { message: 'no', code: deepseekShaped, type: 'auth_error' } }));
    expect(e.message).toBe('X /p failed: 401 Unauthorized (auth_error) no');
    expect(e.message).not.toContain('sk-');
  });
});

describe('vendorHttpError status mapping (our answer, not the vendor\'s)', () => {
  const body = (message: string, code?: string) => JSON.stringify({ error: { message, ...(code ? { code } : {}) } });
  const own = { byok: true };

  it('a refused own key is our 502 PROVIDER_KEY_REJECTED naming the maker, never a 401 that reads as "sign in again"', () => {
    for (const status of [401, 403]) {
      const e = vendorHttpError('OpenAI', '/chat/completions', status, '', body('Incorrect API key provided', 'invalid_api_key'), own);
      expect(e.vendorStatus).toBe(status);
      expect(e.status).toBe(502);
      expect(e.publicCode).toBe('PROVIDER_KEY_REJECTED');
      expect(e.publicMessage).toBe('Your OpenAI key was refused. Check it in Settings → API keys.');
      // comic/llm.ts statusOf still reads the vendor's own code from the message.
      expect(e.message).toMatch(new RegExp(`failed: ${status}\\b`));
    }
  });

  it('a refused platform key does not tell the person to check their own key', () => {
    const e = vendorHttpError('Gemini', '/chat/completions', 401, '', body('API key not valid'));
    expect(e.status).toBe(502);
    expect(e.publicCode).toBe('PROVIDER_KEY_REJECTED');
    expect(e.publicMessage).not.toMatch(/your gemini key/i);
  });

  it('402, and a 403 spend cap, are 503 PROVIDER_CAPACITY', () => {
    const credit = vendorHttpError('xAI', '/chat/completions', 402, 'Payment Required', body('top up'), own);
    expect([credit.status, credit.publicCode, credit.vendorStatus]).toEqual([503, 'PROVIDER_CAPACITY', 402]);
    expect(credit.publicMessage).toMatch(/your xAI key/i);
    const cap = vendorHttpError('OpenAI', '/chat/completions', 403, 'Forbidden', body('Key limit exceeded (total limit)'), own);
    expect([cap.status, cap.publicCode]).toEqual([503, 'PROVIDER_CAPACITY']);
  });

  it('404 is 502 MODEL_NOT_FOUND, 429 stays 429 RATE_LIMITED, 5xx and 529 are 502 BAD_GATEWAY', () => {
    const missing = vendorHttpError('Anthropic', '/messages', 404, 'Not Found', body('model: claude-x'), own);
    expect([missing.status, missing.publicCode, missing.vendorStatus]).toEqual([502, 'MODEL_NOT_FOUND', 404]);
    const busy = vendorHttpError('OpenAI', '/chat/completions', 429, 'Too Many Requests', body('Rate limit reached'), own);
    expect([busy.status, busy.publicCode]).toEqual([429, 'RATE_LIMITED']);
    for (const status of [500, 503, 529]) {
      const down = vendorHttpError('Anthropic', '/messages', status, '', body('Overloaded'), own);
      expect([down.status, down.publicCode, down.vendorStatus]).toEqual([502, 'BAD_GATEWAY', status]);
      expect(down.publicMessage).toMatch(/try again/i);
    }
  });

  it('any other vendor 4xx is our 502 with a fixed sentence, not the vendor text as a client error', () => {
    const e = vendorHttpError('OpenAI', '/chat/completions', 400, 'Bad Request', body('Your request was rejected by our safety system.', 'content_policy_violation'), own);
    expect(e.status).toBe(502);
    expect(e.vendorStatus).toBe(400);
    // Not BAD_GATEWAY: comic/llm.ts retries a BAD_GATEWAY once as a passing blip.
    expect(e.publicCode).toBe('PROVIDER_REJECTED');
    expect(e.publicMessage).toBe("OpenAI couldn't take this request. Try again, rephrase it, or pick another model.");
    expect(e.message).toContain('content_policy_violation');
  });
});

describe('comic/llm.ts reads a mapped vendor error as before', () => {
  const ctx = { role: 'writer' as const, route: 'gemini' as const, byok: true };
  const body = (message: string, code?: string) => JSON.stringify({ error: { message, ...(code ? { code } : {}) } });

  it('keeps refusals final, blips retryable and the safety words visible', async () => {
    const { toLlmStudioError } = await import('../../comic/llm.js');
    const of = (status: number, message: string, code?: string) =>
      toLlmStudioError(vendorHttpError('Gemini', '/chat/completions', status, '', body(message, code), { byok: true }), ctx);
    const rejected = of(400, 'messages: field required');
    expect([rejected.code, rejected.retryable]).toEqual(['PROVIDER_ERROR', false]);
    expect(rejected.userMessage).toMatch(/rejected/);
    expect(of(401, 'API key not valid').userMessage).toMatch(/key was rejected/);
    expect(of(429, 'Resource has been exhausted').code).toBe('RATE_LIMIT');
    const blip = of(503, 'The model is overloaded');
    expect([blip.code, blip.retryable]).toEqual(['PROVIDER_ERROR', true]);
    expect(of(400, 'Your request was rejected by our safety system.', 'content_policy_violation').code).toBe('SAFETY_BLOCKED');
    expect(of(402, 'top up').userMessage).toMatch(/out of credits/);
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
