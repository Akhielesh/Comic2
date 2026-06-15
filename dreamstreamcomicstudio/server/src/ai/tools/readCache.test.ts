import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import {
  isHostBlocked,
  markHostBlocked,
  getCachedPage,
  setCachedPage,
  __resetReadCache
} from './readCache.js';

beforeEach(() => __resetReadCache());
afterEach(() => vi.useRealTimers());

describe('readCache — host block negative cache', () => {
  it('a host is not blocked until marked', () => {
    expect(isHostBlocked('etihad.com')).toBe(false);
  });

  it('marking a host blocks it (so the next read fast-fails instead of timing out)', () => {
    markHostBlocked('etihad.com');
    expect(isHostBlocked('etihad.com')).toBe(true);
    // A different host is unaffected.
    expect(isHostBlocked('reuters.com')).toBe(false);
  });

  it('a blocked host expires after the TTL (self-heals)', () => {
    vi.useFakeTimers();
    markHostBlocked('expedia.com');
    expect(isHostBlocked('expedia.com')).toBe(true);
    vi.advanceTimersByTime(120_000 + 1); // past HOST_BLOCK_TTL_MS
    expect(isHostBlocked('expedia.com')).toBe(false);
  });

  it('ignores empty host', () => {
    markHostBlocked('');
    expect(isHostBlocked('')).toBe(false);
  });
});

describe('readCache — positive page cache', () => {
  it('returns null until a page is cached, then returns its text', () => {
    const url = 'https://reuters.com/markets/x';
    expect(getCachedPage(url)).toBeNull();
    setCachedPage(url, '# Title\nSource: …\n\nbody');
    expect(getCachedPage(url)).toContain('body');
  });

  it('a cached page expires after the TTL', () => {
    vi.useFakeTimers();
    const url = 'https://reuters.com/markets/y';
    setCachedPage(url, 'cached body');
    expect(getCachedPage(url)).toBe('cached body');
    vi.advanceTimersByTime(300_000 + 1); // past PAGE_TTL_MS
    expect(getCachedPage(url)).toBeNull();
  });

  it('does not cache empty text', () => {
    setCachedPage('https://x.com/a', '');
    expect(getCachedPage('https://x.com/a')).toBeNull();
  });
});
