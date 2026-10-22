import { describe, expect, it } from 'vitest';
import { failureCaption, failureKind, failureReason, formatFailedAt, isTransientFailure } from './failure';

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
});
