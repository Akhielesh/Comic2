import { describe, expect, it } from 'vitest';
import { failureCaption, failureFacts, failureKind, failureReason, formatFailedAt, isTransientFailure } from './failure';

describe('failure copy', () => {
  it('classifies provider errors into short, calm reasons', () => {
    expect(failureKind('busy (rate limited)')).toBe('rate_limited');
    expect(failureKind('Google AI Studio answered 429 Too Many Requests')).toBe('rate_limited');
    expect(failureKind('RESOURCE_EXHAUSTED: quota')).toBe('rate_limited');
    expect(failureKind('upstream 503 overloaded')).toBe('busy');
    expect(failureKind('Timed out after 120s')).toBe('timeout');
    expect(failureKind('Blocked by the content policy')).toBe('safety');
    expect(failureKind('The model refused this one.')).toBe('declined');
    expect(failureKind('fetch failed: ECONNRESET')).toBe('network');
    expect(failureKind('Your API key was rejected (401)')).toBe('key');
    expect(failureKind('Cancelled')).toBe('stopped');
    expect(failureKind('')).toBe('unknown');
    expect(failureReason('weird')).toBe('didn’t finish');
    expect(isTransientFailure('429')).toBe(true);
    expect(isTransientFailure('blocked by safety')).toBe(false);
  });

  it('says when, in local time: today, yesterday, or a date', () => {
    const now = new Date(2026, 9, 22, 18, 0).getTime();
    expect(formatFailedAt(new Date(2026, 9, 22, 16, 52).getTime(), now)).toBe('16:52');
    expect(formatFailedAt(new Date(2026, 9, 21, 9, 5).getTime(), now)).toBe('yesterday 09:05');
    expect(formatFailedAt(new Date(2026, 9, 2, 23, 59).getTime(), now)).toBe('Oct 2, 23:59');
    expect(formatFailedAt(undefined, now)).toBeUndefined();
    expect(failureCaption('429', new Date(2026, 9, 22, 16, 52).getTime(), now)).toBe('failed 16:52 · rate limited');
    expect(failureCaption(undefined, undefined, now)).toBe('failed · didn’t finish');
  });

  it('failureFacts reads errorDetail (object or string) and falls back to error + updatedAt', () => {
    expect(failureFacts(undefined)).toEqual({});
    expect(failureFacts({ error: 'Timed out', updatedAt: 5 })).toEqual({ error: 'Timed out', at: 5 });
    const obj = failureFacts({
      error: 'Busy right now.',
      updatedAt: 9,
      attempts: 3,
      errorDetail: { code: '429', provider: 'OpenRouter', at: 7, text: 'upstream Google' }
    } as never);
    expect(obj).toEqual({ error: 'Busy right now. — upstream Google — 429', at: 7, facts: 'OpenRouter · 429', attempts: 3 });
    expect(failureReason(obj.error)).toBe('rate limited');
    // a string detail is shown as-is (capped), never parsed
    const long = `OpenRouter · 503 · ${'x'.repeat(300)}`;
    expect(failureFacts({ errorDetail: long } as never).facts).toHaveLength(120);
    // junk is ignored, not shown
    expect(failureFacts({ error: 'x', errorDetail: { at: 'yesterday', code: 42 } } as never)).toEqual({ error: 'x' });
  });
});
