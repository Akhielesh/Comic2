import { describe, it, expect } from 'vitest';
import { quarterValue, isStale, STALE_CUTOFF } from './modelDataAudit';

describe('modelDataAudit', () => {
  it('parses YYYY-Qn into a sortable integer', () => {
    expect(quarterValue('2026-Q1')).toBe(2026 * 4 + 1);
    expect(quarterValue('2024-Q3')).toBe(2024 * 4 + 3);
    expect(quarterValue('nonsense')).toBeNull();
    expect(quarterValue(undefined)).toBeNull();
  });

  it('flags entries older than the cutoff as stale', () => {
    expect(STALE_CUTOFF).toBe(2025 * 4 + 3);
    expect(isStale('2024-Q3')).toBe(true);
    expect(isStale('2025-Q1')).toBe(true);
    expect(isStale('2025-Q3')).toBe(false); // exactly the cutoff is still current
    expect(isStale('2026-Q1')).toBe(false);
    expect(isStale(undefined)).toBe(false); // unknown is not flagged
  });
});
