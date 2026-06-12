import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  __resetPlatformAllowance,
  allowanceCapUsd,
  allowanceCrossingNotices,
  allowanceEnabled,
  allowanceExhaustedMessage,
  allowancePctUsed,
  buildAllowanceExhaustedDetails,
  buildAllowanceStatus,
  bumpAllowanceCache,
  coalesceEventUsd,
  firstOfNextUtcMonthIso,
  getAllowanceStatus,
  setAllowanceSpendQuery,
  startOfCurrentUtcMonthIso,
  thresholdsCrossed,
  thresholdsMet
} from './platformAllowance.js';

beforeEach(() => {
  __resetPlatformAllowance();
  process.env.PLATFORM_MONTHLY_ALLOWANCE_USD = '5';
});

afterEach(() => {
  delete process.env.PLATFORM_MONTHLY_ALLOWANCE_USD;
  __resetPlatformAllowance();
});

describe('cap configuration', () => {
  it('defaults to $5 when the env var is unset or blank', () => {
    delete process.env.PLATFORM_MONTHLY_ALLOWANCE_USD;
    expect(allowanceCapUsd()).toBe(5);
    process.env.PLATFORM_MONTHLY_ALLOWANCE_USD = '  ';
    expect(allowanceCapUsd()).toBe(5);
  });

  it('falls back to the default on a non-numeric value', () => {
    process.env.PLATFORM_MONTHLY_ALLOWANCE_USD = 'lots';
    expect(allowanceCapUsd()).toBe(5);
  });

  it('disables the feature entirely at <= 0', () => {
    process.env.PLATFORM_MONTHLY_ALLOWANCE_USD = '0';
    expect(allowanceEnabled()).toBe(false);
    process.env.PLATFORM_MONTHLY_ALLOWANCE_USD = '-3';
    expect(allowanceEnabled()).toBe(false);
    process.env.PLATFORM_MONTHLY_ALLOWANCE_USD = '12.5';
    expect(allowanceCapUsd()).toBe(12.5);
    expect(allowanceEnabled()).toBe(true);
  });
});

describe('month window / reset date math (UTC)', () => {
  it('computes the start of the current UTC month', () => {
    expect(startOfCurrentUtcMonthIso(new Date('2026-06-12T15:30:00Z'))).toBe('2026-06-01T00:00:00.000Z');
    // Just before midnight UTC on the 1st still belongs to the new month.
    expect(startOfCurrentUtcMonthIso(new Date('2026-06-01T00:00:00Z'))).toBe('2026-06-01T00:00:00.000Z');
  });

  it('resets on the first of the NEXT UTC month, including the year rollover', () => {
    expect(firstOfNextUtcMonthIso(new Date('2026-06-12T15:30:00Z'))).toBe('2026-07-01T00:00:00.000Z');
    expect(firstOfNextUtcMonthIso(new Date('2026-12-31T23:59:59Z'))).toBe('2027-01-01T00:00:00.000Z');
  });
});

describe('percentage clamp + thresholds', () => {
  it('clamps pct to 0..100', () => {
    expect(allowancePctUsed(-1, 5)).toBe(0);
    expect(allowancePctUsed(0, 5)).toBe(0);
    expect(allowancePctUsed(2.5, 5)).toBe(50);
    expect(allowancePctUsed(7.5, 5)).toBe(100);
    expect(allowancePctUsed(1, 0)).toBe(0); // disabled cap → no percentage
  });

  it('reports thresholds met at a given pct', () => {
    expect(thresholdsMet(10)).toEqual([]);
    expect(thresholdsMet(30)).toEqual([30]);
    expect(thresholdsMet(75)).toEqual([30, 70]);
    expect(thresholdsMet(100)).toEqual([30, 70, 90, 100]);
  });

  it('reports only NEWLY crossed thresholds between two percentages', () => {
    expect(thresholdsCrossed(25, 35)).toEqual([30]);
    expect(thresholdsCrossed(30, 35)).toEqual([]); // 30 was already met
    expect(thresholdsCrossed(10, 100)).toEqual([30, 70, 90, 100]);
    expect(thresholdsCrossed(95, 99)).toEqual([]);
  });
});

describe('buildAllowanceStatus', () => {
  it('marks exhausted at/over the cap and lists crossed thresholds', () => {
    const now = new Date('2026-06-12T00:00:00Z');
    const halfway = buildAllowanceStatus(2.5, 5, now);
    expect(halfway).toMatchObject({ enabled: true, pctUsed: 50, exhausted: false, crossed: [30] });
    expect(halfway.resetsAt).toBe('2026-07-01T00:00:00.000Z');

    const done = buildAllowanceStatus(5, 5, now);
    expect(done).toMatchObject({ pctUsed: 100, exhausted: true, crossed: [30, 70, 90, 100] });
  });

  it('reports disabled (and no thresholds) when the cap is 0', () => {
    const status = buildAllowanceStatus(3, 0);
    expect(status).toMatchObject({ enabled: false, pctUsed: 0, exhausted: false, crossed: [] });
  });
});

describe('coalesceEventUsd', () => {
  it('prefers billable_usd, falls back to provider_cost_usd, then 0', () => {
    expect(coalesceEventUsd({ billable_usd: 0.2, provider_cost_usd: 0.1 })).toBe(0.2);
    expect(coalesceEventUsd({ billable_usd: null, provider_cost_usd: 0.1 })).toBe(0.1);
    expect(coalesceEventUsd({ billable_usd: null, provider_cost_usd: null })).toBe(0);
    // billable 0 is a real value (e.g. comped) — NOT a miss.
    expect(coalesceEventUsd({ billable_usd: 0, provider_cost_usd: 0.4 })).toBe(0);
  });
});

describe('getAllowanceStatus (injected spend query)', () => {
  it('reads month-to-date spend once and caches per user', async () => {
    let calls = 0;
    setAllowanceSpendQuery(async (userId, sinceIso) => {
      calls += 1;
      expect(userId).toBe('user-1');
      expect(sinceIso).toBe(startOfCurrentUtcMonthIso());
      return 1.5;
    });

    const first = await getAllowanceStatus('user-1');
    const second = await getAllowanceStatus('user-1');
    expect(first.pctUsed).toBe(30);
    expect(second.pctUsed).toBe(30);
    expect(calls).toBe(1);
  });

  it('never queries when the feature is disabled', async () => {
    process.env.PLATFORM_MONTHLY_ALLOWANCE_USD = '0';
    let calls = 0;
    setAllowanceSpendQuery(async () => {
      calls += 1;
      return 99;
    });
    const status = await getAllowanceStatus('user-1');
    expect(status.enabled).toBe(false);
    expect(calls).toBe(0);
  });

  it('fails OPEN (enabled:false) when metering is unavailable', async () => {
    setAllowanceSpendQuery(async () => {
      throw new Error('no supabase admin');
    });
    const status = await getAllowanceStatus('user-1');
    expect(status.enabled).toBe(false);
    expect(status.exhausted).toBe(false);
  });
});

describe('bumpAllowanceCache', () => {
  it('optimistically adds settled spend and reports crossed thresholds', async () => {
    setAllowanceSpendQuery(async () => 1); // 20% of $5
    await getAllowanceStatus('user-1');

    const bump = bumpAllowanceCache('user-1', 2); // → $3 = 60%
    expect(bump).toMatchObject({ pctBefore: 20, pctAfter: 60, crossedNow: [30] });

    // The cache reflects the bump without re-querying.
    const status = await getAllowanceStatus('user-1');
    expect(status.usedUsd).toBe(3);
    expect(status.pctUsed).toBe(60);

    // A second bump straight to exhaustion crosses 70, 90 and 100.
    const second = bumpAllowanceCache('user-1', 2.5);
    expect(second).toMatchObject({ pctBefore: 60, pctAfter: 100, crossedNow: [70, 90, 100] });
    expect((await getAllowanceStatus('user-1')).exhausted).toBe(true);
  });

  it('is a no-op without a cached status or a positive delta', async () => {
    expect(bumpAllowanceCache('cold-user', 1)).toBeNull();
    setAllowanceSpendQuery(async () => 1);
    await getAllowanceStatus('user-1');
    expect(bumpAllowanceCache('user-1', 0)).toBeNull();
    expect(bumpAllowanceCache('user-1', -2)).toBeNull();
  });
});

describe('user-facing messaging (PERCENT only)', () => {
  it('the exhausted message speaks in percent and never dollars', () => {
    const message = allowanceExhaustedMessage('2026-07-01T00:00:00.000Z');
    expect(message).toContain('100%');
    expect(message).toContain('July 1');
    expect(message).not.toContain('$');
  });

  it('builds limit details carrying the fallback hints', () => {
    const status = buildAllowanceStatus(5, 5, new Date('2026-06-12T00:00:00Z'));
    const details = buildAllowanceExhaustedDetails({ status, canFallbackToByok: true, byokFallbackMode: 'ask' });
    expect(details.reason).toBe('platform_allowance_exhausted');
    expect(details.canFallbackToByok).toBe(true);
    expect(details.byokFallbackMode).toBe('ask');
    expect(details.resetAt).toBe('2026-07-01T00:00:00.000Z');
    expect(details.message).not.toContain('$');
  });

  it('emits info notices at 30/70, warn at 90, and nothing for 100', () => {
    const notices = allowanceCrossingNotices([30, 70, 90, 100], '2026-07-01T00:00:00.000Z');
    expect(notices).toHaveLength(3);
    expect(notices.map((n) => n.level)).toEqual(['info', 'info', 'warn']);
    for (const notice of notices) {
      expect(notice.message).toMatch(/\d+% of your monthly DreamStream allowance/);
      expect(notice.message).not.toContain('$');
    }
  });
});
