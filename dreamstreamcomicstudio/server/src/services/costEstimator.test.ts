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

  it('applies higher Nano Banana Pro price path for 4K images', async () => {
    const oneK = await estimateCharge({
      provider: 'gemini',
      model: 'gemini-3-pro-image-preview',
      operation: 'unit_test_image_pricing',
      imageUnits: 1,
      resolution: '1K'
    });

    const fourK = await estimateCharge({
      provider: 'gemini',
      model: 'gemini-3-pro-image-preview',
      operation: 'unit_test_image_pricing',
      imageUnits: 1,
      resolution: '4K'
    });

    const oneKImageLine = oneK.lines.find((line) => line.kind === 'image_units');
    const fourKImageLine = fourK.lines.find((line) => line.kind === 'image_units');

    expect(oneKImageLine).toBeDefined();
    expect(fourKImageLine).toBeDefined();
    expect((fourKImageLine?.unitPriceUsd || 0)).toBeGreaterThan(oneKImageLine?.unitPriceUsd || 0);
    expect(fourK.estimatedCt).toBeGreaterThan(oneK.estimatedCt);
  });
});
