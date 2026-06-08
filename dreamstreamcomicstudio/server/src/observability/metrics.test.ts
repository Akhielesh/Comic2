import { describe, it, expect, afterEach } from 'vitest';
import { incr, getCounter, snapshot, _resetMetrics } from './metrics.js';

afterEach(() => _resetMetrics());

describe('metrics registry', () => {
  it('increments counters', () => {
    incr('reqs');
    incr('reqs');
    expect(getCounter('reqs')).toBe(2);
  });

  it('supports a custom increment amount', () => {
    incr('tokens', undefined, 100);
    incr('tokens', undefined, 50);
    expect(getCounter('tokens')).toBe(150);
  });

  it('keeps label sets distinct and order-independent', () => {
    incr('ai_error', { provider: 'openrouter' });
    incr('ai_error', { provider: 'nvidia' });
    incr('ai_error', { provider: 'openrouter' });
    expect(getCounter('ai_error', { provider: 'openrouter' })).toBe(2);
    expect(getCounter('ai_error', { provider: 'nvidia' })).toBe(1);
    // label order doesn't matter
    incr('x', { a: '1', b: '2' });
    expect(getCounter('x', { b: '2', a: '1' })).toBe(1);
  });

  it('snapshots all counters with serialized label keys', () => {
    incr('ai_request', { provider: 'openrouter' });
    const snap = snapshot();
    expect(snap['ai_request{provider="openrouter"}']).toBe(1);
  });

  it('returns 0 for unknown counters', () => {
    expect(getCounter('nope')).toBe(0);
  });
});
