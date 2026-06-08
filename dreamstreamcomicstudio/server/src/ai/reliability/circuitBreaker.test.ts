import { describe, it, expect } from 'vitest';
import { CircuitBreaker } from './circuitBreaker.js';

describe('CircuitBreaker', () => {
  it('starts closed and allows requests', () => {
    const cb = new CircuitBreaker();
    expect(cb.getState()).toBe('closed');
    expect(cb.canRequest()).toBe(true);
  });

  it('opens after the failure threshold and fails fast', () => {
    let t = 0;
    const cb = new CircuitBreaker({ failureThreshold: 3, cooldownMs: 1000, now: () => t });
    cb.onFailure();
    cb.onFailure();
    expect(cb.canRequest()).toBe(true); // 2 < 3
    cb.onFailure();
    expect(cb.getState()).toBe('open');
    expect(cb.canRequest()).toBe(false);
  });

  it('transitions to half-open after the cooldown', () => {
    let t = 0;
    const cb = new CircuitBreaker({ failureThreshold: 1, cooldownMs: 1000, now: () => t });
    cb.onFailure();
    expect(cb.canRequest()).toBe(false);
    t = 1000;
    expect(cb.getState()).toBe('half-open');
    expect(cb.canRequest()).toBe(true);
  });

  it('closes on a successful half-open probe', () => {
    let t = 0;
    const cb = new CircuitBreaker({ failureThreshold: 1, cooldownMs: 100, now: () => t });
    cb.onFailure();
    t = 100;
    cb.getState(); // → half-open
    cb.onSuccess();
    expect(cb.getState()).toBe('closed');
  });

  it('re-opens immediately if the half-open probe fails', () => {
    let t = 0;
    const cb = new CircuitBreaker({ failureThreshold: 2, cooldownMs: 100, now: () => t });
    cb.onFailure();
    cb.onFailure(); // open
    t = 100; // → half-open
    cb.getState();
    cb.onFailure(); // probe fails → re-open
    expect(cb.canRequest()).toBe(false);
  });

  it('resets the failure count on success', () => {
    const cb = new CircuitBreaker({ failureThreshold: 3 });
    cb.onFailure();
    cb.onFailure();
    cb.onSuccess();
    cb.onFailure();
    cb.onFailure();
    expect(cb.canRequest()).toBe(true); // not 3 consecutive
  });
});
