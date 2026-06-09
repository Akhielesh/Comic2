import { describe, it, expect } from 'vitest';
import { classifyApiError, describeApiError, isRetryableError } from './apiErrors';

describe('classifyApiError', () => {
  it('explains a transport failure (status 0) in plain language and marks it retryable', () => {
    const f = classifyApiError({ status: 0, message: 'Failed to fetch' });
    expect(f.title).toBe("Can't reach the AI server");
    expect(f.detail.toLowerCase()).toContain('waking up');
    expect(f.retryable).toBe(true);
  });

  it('marks auth errors non-retryable with a clear next step', () => {
    expect(classifyApiError({ status: 401 }).retryable).toBe(false);
    expect(classifyApiError({ status: 401 }).title).toBe('Sign-in needed');
    expect(classifyApiError({ status: 403 }).retryable).toBe(false);
  });

  it('treats waking/timeout/rate-limit/5xx as retryable', () => {
    for (const status of [429, 502, 503, 504, 500]) {
      expect(classifyApiError({ status }).retryable).toBe(true);
    }
  });

  it('passes through an aborted request', () => {
    const f = classifyApiError({ name: 'AbortError' });
    expect(f.title).toBe('Cancelled');
    expect(f.retryable).toBe(false);
  });

  it('falls back to the error message for an unknown error', () => {
    expect(classifyApiError(new Error('weird thing')).detail).toBe('weird thing');
    expect(classifyApiError(null).detail).toBe('An unexpected error occurred.');
  });
});

describe('describeApiError', () => {
  it('formats a one-line "Title — detail" string', () => {
    expect(describeApiError({ status: 0 })).toMatch(/^Can't reach the AI server — /);
  });
});

describe('isRetryableError (network auto-retry policy)', () => {
  it('auto-retries transport, timeout, rate-limit and 5xx', () => {
    for (const status of [0, 408, 425, 429, 500, 502, 503, 504]) {
      expect(isRetryableError({ status })).toBe(true);
    }
  });

  it('does NOT auto-retry 404 or auth failures, or aborts, or status-less errors', () => {
    expect(isRetryableError({ status: 404 })).toBe(false);
    expect(isRetryableError({ status: 401 })).toBe(false);
    expect(isRetryableError({ status: 403 })).toBe(false);
    expect(isRetryableError({ name: 'AbortError', status: 0 })).toBe(false);
    expect(isRetryableError(new Error('no status'))).toBe(false);
  });
});
