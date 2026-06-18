import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  markSharedKeyCapped,
  isSharedKeyCapped,
  sharedKeyCappedForMs,
  __resetSharedKeyCircuit
} from './providerCircuit.js';

describe('providerCircuit (shared platform-key breaker)', () => {
  beforeEach(() => {
    __resetSharedKeyCircuit();
  });
  afterEach(() => {
    vi.useRealTimers();
    __resetSharedKeyCircuit();
  });

  it('is closed by default', () => {
    expect(isSharedKeyCapped()).toBe(false);
    expect(sharedKeyCappedForMs()).toBe(0);
  });

  it('opens after a cap and reports remaining cooldown', () => {
    markSharedKeyCapped(10_000);
    expect(isSharedKeyCapped()).toBe(true);
    expect(sharedKeyCappedForMs()).toBeGreaterThan(0);
  });

  it('self-heals after the cooldown expires', () => {
    vi.useFakeTimers();
    markSharedKeyCapped(1000);
    expect(isSharedKeyCapped()).toBe(true);
    vi.advanceTimersByTime(1001);
    expect(isSharedKeyCapped()).toBe(false);
  });

  it('honors the SHARED_KEY_COOLDOWN_MS env override', () => {
    const prev = process.env.SHARED_KEY_COOLDOWN_MS;
    process.env.SHARED_KEY_COOLDOWN_MS = '5000';
    try {
      markSharedKeyCapped(); // no explicit ttl → uses the env override
      expect(sharedKeyCappedForMs()).toBeGreaterThan(3000);
      expect(sharedKeyCappedForMs()).toBeLessThanOrEqual(5000);
    } finally {
      if (prev === undefined) delete process.env.SHARED_KEY_COOLDOWN_MS;
      else process.env.SHARED_KEY_COOLDOWN_MS = prev;
    }
  });
});
