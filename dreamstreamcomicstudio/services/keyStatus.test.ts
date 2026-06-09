import { describe, it, expect } from 'vitest';
import { normalizeKeyStatus } from './keyStatus';

describe('normalizeKeyStatus', () => {
  it('uses the key limit_remaining when present', () => {
    const s = normalizeKeyStatus({
      sources: { openrouter: { connected: true, liveKey: { is_free_tier: false, limit_remaining: 12.5 } } }
    });
    expect(s).toEqual({ connected: true, isFreeTier: false, remainingUsd: 12.5 });
  });

  it('falls back to account credits remaining when the key has no cap', () => {
    const s = normalizeKeyStatus({
      sources: { openrouter: { connected: true, liveKey: { is_free_tier: false, limit_remaining: null }, credits: { remaining: 8 } } }
    });
    expect(s.remainingUsd).toBe(8);
  });

  it('detects a free-tier key', () => {
    const s = normalizeKeyStatus({ sources: { openrouter: { connected: true, liveKey: { is_free_tier: true } } } });
    expect(s.isFreeTier).toBe(true);
    expect(s.remainingUsd).toBeNull();
  });

  it('returns a safe default when there is no openrouter data', () => {
    expect(normalizeKeyStatus({})).toEqual({ connected: false, isFreeTier: false, remainingUsd: null });
    expect(normalizeKeyStatus(null)).toEqual({ connected: false, isFreeTier: false, remainingUsd: null });
  });
});
