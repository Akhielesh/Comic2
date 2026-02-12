import { describe, expect, it } from 'vitest';
import { estimateCharge } from './costEstimator.js';

describe('estimateCharge', () => {
  it('converts billable USD to CT using ceil rounding', async () => {
    const result = await estimateCharge(
      {
        provider: 'internal',
        model: 'nonexistent-model',
        operation: 'unit_test',
        inputTokens: 1234,
        outputTokens: 567,
        imageUnits: 0
      },
      { markup: 1.3 }
    );

    const expectedCt = Math.ceil(result.estimatedBillableUsd / 0.0001);
    expect(result.estimatedCt).toBe(expectedCt);
    expect(result.ctPerUsd).toBe(10_000);
  });
});
