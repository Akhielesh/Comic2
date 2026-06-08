import { describe, it, expect } from 'vitest';
import { KeyPool } from './keyPool.js';

describe('KeyPool', () => {
  it('de-dupes and drops empty keys', () => {
    const p = new KeyPool(['a', 'a', '', '  ', 'b']);
    expect(p.size).toBe(2);
  });

  it('round-robins across keys', () => {
    const p = new KeyPool(['a', 'b', 'c']);
    expect(p.next()).toBe('a');
    expect(p.next()).toBe('b');
    expect(p.next()).toBe('c');
    expect(p.next()).toBe('a');
  });

  it('skips a rate-limited key until its cooldown elapses', () => {
    let t = 0;
    const p = new KeyPool(['a', 'b'], { cooldownMs: 1000, now: () => t });
    p.markRateLimited('a');
    expect(p.available()).toBe(1);
    expect(p.next()).toBe('b');
    expect(p.next()).toBe('b'); // a still benched
    t = 1000;
    expect(p.available()).toBe(2);
    expect(p.next()).toBe('a'); // a usable again
  });

  it('returns null when every key is benched', () => {
    let t = 0;
    const p = new KeyPool(['a', 'b'], { cooldownMs: 1000, now: () => t });
    p.markRateLimited('a');
    p.markRateLimited('b');
    expect(p.next()).toBeNull();
    expect(p.available()).toBe(0);
    t = 1000;
    expect(p.next()).toBe('a');
  });

  it('an empty pool yields null', () => {
    const p = new KeyPool([]);
    expect(p.size).toBe(0);
    expect(p.next()).toBeNull();
  });
});
