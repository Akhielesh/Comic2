// The board's money rule (P1-LIMITS): governed users never see dollars; their own key and admins do.
import { afterEach, describe, expect, it } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { DEFAULT_CAPS } from '../../../shared/comic/capabilities';
import { __resetAllowanceStore, publishAllowanceStatus, type AllowanceStatus } from '../../../services/usageAllowance';
import { boardCostContext, costFormatFor, useCostFormat } from './costFormat';

const status = (over: Partial<AllowanceStatus> = {}): AllowanceStatus => ({
  enabled: true,
  governed: true,
  pctUsed: 20,
  pctLeft: 80,
  exhausted: false,
  crossed: [],
  resetsAt: null,
  friendlyUnits: { standardPages: 100, draftPages: 300, pctPerStandardPage: 1, label: 'about 100 standard comic pages left' },
  usePlatformAllowance: true,
  byokFallbackMode: 'ask',
  byokAvailable: false,
  ...over
});

afterEach(() => __resetAllowanceStore());

describe('boardCostContext', () => {
  it('own key and admins: dollars', () => {
    expect(boardCostContext({ ...DEFAULT_CAPS, byok: true }, status()).governed).toBe(false);
    expect(boardCostContext({ ...DEFAULT_CAPS, admin: true }, null).governed).toBe(false);
  });

  it('the server saying no limit applies: dollars', () => {
    expect(boardCostContext(DEFAULT_CAPS, status({ governed: false })).governed).toBe(false);
    expect(boardCostContext({ ...DEFAULT_CAPS, usage: { governed: false, pctLeft: 100, exhausted: false, pctPerStandardPage: null } }, null).governed).toBe(false);
  });

  it('unknown status: governed (never a dollar figure until we know)', () => {
    const ctx = boardCostContext(DEFAULT_CAPS, null);
    expect(ctx.governed).toBe(true);
    expect(costFormatFor(ctx).quote(0.07)).toBe('uses a little of your usage');
  });

  it('governed with a known share: "≈N% of your usage" for quotes and spend', () => {
    const fmt = costFormatFor(boardCostContext(DEFAULT_CAPS, status()));
    expect(fmt.governed).toBe(true);
    expect(fmt.quote(0.5)).toMatch(/^≈[\d.]+% of your usage$/);
    expect(fmt.spent(0.5)).toMatch(/% of your usage$/);
    expect(fmt.quote(0)).toBe('Free');
    // Own-key spend is the user's own money: dollars.
    expect(fmt.spent(0.0655, { byok: true })).toBe('$0.07');
  });

  it('dollars keep the board’s familiar "≈ $0.07" quotes and precise spend', () => {
    const fmt = costFormatFor(boardCostContext({ ...DEFAULT_CAPS, byok: true }, null));
    expect(fmt.quote(0.0655)).toBe('≈ $0.07');
    expect(fmt.spent(0.004)).toBe('$0.004');
  });
});

describe('useCostFormat', () => {
  it('follows the shared usage status (subscribe only, no requests)', () => {
    const { result } = renderHook(() => useCostFormat(DEFAULT_CAPS));
    expect(result.current.quote(0.1)).toBe('uses a little of your usage');
    act(() => publishAllowanceStatus(status({ governed: false })));
    expect(result.current.quote(0.1)).toBe('≈ $0.10');
    act(() => publishAllowanceStatus(status()));
    expect(result.current.quote(0.1)).toMatch(/% of your usage$/);
  });
});
