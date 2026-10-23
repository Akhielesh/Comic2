import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({ get: vi.fn(), patch: vi.fn(), put: vi.fn() }));
vi.mock('./apiClient', () => api);

import {
  __resetAllowanceStore,
  formatPctLeft,
  getLastAllowanceStatus,
  highestCrossedThreshold,
  isThresholdDismissed,
  dismissThreshold,
  normalizeAllowanceStatus,
  refreshAllowanceStatus,
  showsUsageMeter,
  updateUsageBudget,
  usageTone
} from './usageAllowance';

const SERVER = {
  enabled: true,
  governed: true,
  pctUsed: 62,
  pctLeft: 38,
  exhausted: false,
  crossed: [30],
  resetsAt: null,
  friendlyUnits: { standardPages: 55, draftPages: 70, pctPerStandardPage: 0.65, label: 'about 55 standard comic pages left' },
  usePlatformAllowance: true,
  byokFallbackMode: 'ask',
  byokAvailable: false
};

beforeEach(() => {
  __resetAllowanceStore();
  api.get.mockReset();
  api.put.mockReset();
  try {
    window.localStorage.clear();
  } catch {
    /* ignore */
  }
});
afterEach(() => __resetAllowanceStore());

describe('normalizeAllowanceStatus (usage left)', () => {
  it('keeps pctLeft, a null reset for lifetime usage and the friendly units', () => {
    const s = normalizeAllowanceStatus(SERVER)!;
    expect(s).toMatchObject({ governed: true, pctUsed: 62, pctLeft: 38, resetsAt: null, exhausted: false });
    expect(s.friendlyUnits).toEqual(SERVER.friendlyUnits);
    expect(showsUsageMeter(s)).toBe(true);
  });

  it('derives the missing percent, clamps, and marks 0% left as exhausted', () => {
    expect(normalizeAllowanceStatus({ pctLeft: 25 })).toMatchObject({ pctUsed: 75, pctLeft: 25, resetsAt: null, friendlyUnits: null });
    expect(normalizeAllowanceStatus({ pctUsed: 140 })).toMatchObject({ pctUsed: 100, pctLeft: 0, exhausted: true });
    expect(normalizeAllowanceStatus({ pctUsed: 10, exhausted: true })).toMatchObject({ pctLeft: 0, exhausted: true });
    // the pre-P1-LIMITS monthly shape still parses
    expect(normalizeAllowanceStatus({ enabled: true, pctUsed: 40, exhausted: false, crossed: [30], resetsAt: '2026-11-01T00:00:00Z' })).toMatchObject({
      governed: true,
      pctLeft: 60,
      resetsAt: '2026-11-01T00:00:00Z'
    });
  });

  it('rejects junk and hides the meter for admins / disabled backends', () => {
    expect(normalizeAllowanceStatus(null)).toBeNull();
    expect(normalizeAllowanceStatus({ pctUsed: 'lots' })).toBeNull();
    expect(showsUsageMeter(normalizeAllowanceStatus({ ...SERVER, governed: false }))).toBe(false);
    expect(showsUsageMeter(normalizeAllowanceStatus({ ...SERVER, enabled: false }))).toBe(false);
    expect(normalizeAllowanceStatus({ ...SERVER, friendlyUnits: { label: '' } })!.friendlyUnits).toBeNull();
  });

  it('formats percent left and picks a calm tone', () => {
    expect(formatPctLeft(38.9)).toBe('38%');
    expect(formatPctLeft(0.4)).toBe('<1%');
    expect(formatPctLeft(0)).toBe('0%');
    expect(usageTone({ pctLeft: 50, exhausted: false })).toBe('ok');
    expect(usageTone({ pctLeft: 20, exhausted: false })).toBe('low');
    expect(usageTone({ pctLeft: 5, exhausted: false })).toBe('critical');
    expect(usageTone({ pctLeft: 50, exhausted: true })).toBe('critical');
  });

  it('remembers banner dismissals per threshold for lifetime usage', () => {
    const s = normalizeAllowanceStatus({ ...SERVER, pctUsed: 72, pctLeft: 28, crossed: [30, 70] })!;
    expect(highestCrossedThreshold(s)).toBe(70);
    expect(isThresholdDismissed(70, null)).toBe(false);
    dismissThreshold(70, null);
    expect(isThresholdDismissed(70, null)).toBe(true);
    expect(isThresholdDismissed(90, null)).toBe(false);
  });
});

describe('refreshAllowanceStatus (event-driven, coalesced — never a timer)', () => {
  it('coalesces concurrent callers and skips a fresh read', async () => {
    api.get.mockResolvedValue(SERVER);
    await Promise.all([refreshAllowanceStatus(), refreshAllowanceStatus(), refreshAllowanceStatus()]);
    expect(api.get).toHaveBeenCalledTimes(1);
    expect(api.get).toHaveBeenCalledWith('/api/usage/allowance', undefined);
    await refreshAllowanceStatus(60_000);
    expect(api.get).toHaveBeenCalledTimes(1);
    await refreshAllowanceStatus(0);
    expect(api.get).toHaveBeenCalledTimes(2);
    expect(getLastAllowanceStatus()?.pctLeft).toBe(38);
  });

  it('keeps the last good status when a read fails', async () => {
    api.get.mockResolvedValueOnce(SERVER).mockRejectedValueOnce(new Error('offline'));
    await refreshAllowanceStatus(0);
    expect(await refreshAllowanceStatus(0)).toBeNull();
    expect(getLastAllowanceStatus()?.pctLeft).toBe(38);
  });
});

describe('admin budgets client', () => {
  it('encodes an email or id into the PUT path', async () => {
    api.put.mockResolvedValue({ success: true, userId: 'u' });
    await updateUsageBudget(' tester+1@example.com ', { budgetUsd: 15 });
    expect(api.put).toHaveBeenCalledWith('/api/admin/usage/budgets/tester%2B1%40example.com', { budgetUsd: 15 });
  });
});
