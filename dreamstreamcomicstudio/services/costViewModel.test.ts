import { describe, expect, it } from 'vitest';
import { buildCostViewModel } from './costViewModel';

describe('cost view model', () => {
  it('separates accrued and projected remaining costs', () => {
    const model = buildCostViewModel({
      accruedUsd: 1.2,
      estimatedTokens: 4000,
      pendingPanelCount: 10
    });

    expect(model.accruedUsd).toBe(1.2);
    expect(model.projectedRemainingUsd).toBeGreaterThanOrEqual(0);
    expect(model.totalProjectedUsd).toBeCloseTo(model.accruedUsd + model.projectedRemainingUsd, 4);
  });
});
