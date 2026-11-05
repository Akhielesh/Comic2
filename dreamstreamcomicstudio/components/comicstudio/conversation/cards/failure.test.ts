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

  it('reads the studio’s own failure sentences right (server imageClient / billing copy)', () => {
    const cases: [string, string][] = [
      // our own deadline: "…and was stopped" is a timeout, not a user stop
      ['The image model took longer than 120s and was stopped. Please try again.', 'timed out'],
      ['The image provider timed out. Please try again.', 'timed out'],
      // the shared service at capacity mentions "API keys" — it is still a busy service
      ['The shared image service is at capacity right now. Try again later, or add your own key in Settings → API keys.', 'provider busy'],
      ["That image model isn't available on OpenRouter right now. Please try again later.", 'provider busy'],
      ['The image provider had a temporary problem. Please try again. (OpenRouter said: upstream error.)', 'provider busy'],
      // a key with no quota is a key/billing problem, not a rate limit
      ['Your Gemini key has no image-generation quota (its Google Cloud project has no billing). Enable billing for that project in Google AI Studio.', 'key or billing issue'],
      ['Your OpenRouter key is out of credits or over its spending limit. Top it up (or raise the limit), then try again.', 'key or billing issue'],
      ['The image service rejected the platform key. Please try again later.', 'key or billing issue'],
      // a rate-limited BYOK route that mentions quota and billing is still a rate limit
      ["OpenRouter sent Nano Banana through the Google key in your OpenRouter Integrations, and that key is rate-limited. Wait a minute, or check that key's quota and billing in Google AI Studio.", 'rate limited'],
      ['Nano Banana is being throttled by its provider (Google) for everyone on OpenRouter right now — your key and limits are fine.', 'rate limited'],
      ["The image model's safety filter declined this one. Try rewording the scene — less graphic violence or no real people's likeness usually helps.", 'held by the safety check'],
      ['The image model replied without a picture. Please try again.', 'the model declined'],
      ['The image model rejected the request. (OpenRouter said: bad prompt.)', 'the model declined'],
      // usage limits are their own calm reason
      ["You've used all of your DreamStream usage. It doesn't reset on its own — ask us for a top-up, or add your own API key in Settings → API keys to keep going.", 'usage limit reached'],
      ["You've reached today's generation limit for your plan. It resets tomorrow — or upgrade, or add your own key in Settings → API keys.", 'usage limit reached'],
      ["We couldn't check your usage just now, so nothing was spent. Please try again in a moment — or add your own key in Settings → API keys.", 'provider busy'],
      ['Cancelled.', 'stopped']
    ];
    for (const [text, reason] of cases) expect([text, failureReason(text)]).toEqual([text, reason]);
    expect(isTransientFailure('The image model took longer than 120s and was stopped.')).toBe(true);
    expect(isTransientFailure("You've reached your monthly overage cap.")).toBe(false);
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
