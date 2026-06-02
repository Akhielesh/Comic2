import { describe, expect, it } from 'vitest';
import {
  classifyModel,
  describeCost,
  estimateUsd,
  fromLegacyPer1k,
  hasFreeSuffix,
  perMillion
} from './pricing';

describe('classifyModel', () => {
  it('treats :free suffix as free_verified', () => {
    expect(
      classifyModel({
        modelId: 'meta-llama/llama-3.3-70b-instruct:free',
        pricing: { promptPerToken: 0, completionPerToken: 0, imagePerImage: 0, requestFlat: 0 }
      })
    ).toBe('free_verified');
  });

  it('treats all-zero axes as free_verified', () => {
    expect(
      classifyModel({
        modelId: 'x/y',
        pricing: { promptPerToken: 0, completionPerToken: 0, imagePerImage: 0, requestFlat: 0 }
      })
    ).toBe('free_verified');
  });

  it('flags Nano-Banana-style token-billed image models (NOT free)', () => {
    // imagePerImage = 0 but completionPerToken > 0 and supportsImageOutput.
    expect(
      classifyModel({
        modelId: 'google/gemini-2.5-flash-image',
        supportsImageOutput: true,
        pricing: {
          promptPerToken: 0.0000003,
          completionPerToken: 0.0000025,
          imagePerImage: 0,
          requestFlat: 0
        }
      })
    ).toBe('zero_priced_token_billed');
  });

  it('classifies Flux-style per-image-only', () => {
    expect(
      classifyModel({
        modelId: 'pixazo/flux-1-schnell',
        supportsImageOutput: true,
        pricing: { promptPerToken: 0, completionPerToken: 0, imagePerImage: 0.005, requestFlat: 0 }
      })
    ).toBe('per_image_only');
  });

  it('classifies anything else as paid', () => {
    expect(
      classifyModel({
        modelId: 'openai/gpt-4o-mini',
        pricing: { promptPerToken: 0.00000015, completionPerToken: 0.0000006, imagePerImage: 0, requestFlat: 0 }
      })
    ).toBe('paid');
  });
});

describe('describeCost', () => {
  it('states all applicable axes for token-billed image models', () => {
    const text = describeCost({
      modelId: 'google/gemini-2.5-flash-image',
      supportsImageOutput: true,
      pricing: { promptPerToken: 0.0000003, completionPerToken: 0.0000025, imagePerImage: 0, requestFlat: 0 }
    });
    expect(text).toMatch(/NOT free/);
    expect(text).toMatch(/input tokens/);
    expect(text).toMatch(/output tokens/);
  });

  it('describes per-image-only models without token chatter', () => {
    const text = describeCost({
      modelId: 'pixazo/flux-1-schnell',
      supportsImageOutput: true,
      pricing: { promptPerToken: 0, completionPerToken: 0, imagePerImage: 0.005, requestFlat: 0 }
    });
    expect(text).toMatch(/per image/i);
    expect(text).not.toMatch(/input tokens/);
  });

  it('mentions :free exemption when applicable', () => {
    const text = describeCost({
      modelId: 'meta-llama/llama-3.3-70b-instruct:free',
      pricing: { promptPerToken: 0, completionPerToken: 0, imagePerImage: 0, requestFlat: 0 }
    });
    expect(text).toMatch(/:free/);
  });
});

describe('estimateUsd', () => {
  it('sums every applicable axis independently', () => {
    const usd = estimateUsd({
      pricing: { promptPerToken: 0.000001, completionPerToken: 0.000002, imagePerImage: 0.1, requestFlat: 0.01 },
      inputTokens: 1000,
      outputTokens: 2000,
      imageCount: 3,
      requestCount: 1
    });
    // 1000*1e-6 + 2000*2e-6 + 3*0.1 + 1*0.01 = 0.001 + 0.004 + 0.3 + 0.01 = 0.315
    expect(usd).toBeCloseTo(0.315, 6);
  });
});

describe('legacy bridge', () => {
  it('converts inputPer1k / imagePerOutput into canonical per-token / per-image axes', () => {
    const axes = fromLegacyPer1k({ inputPer1k: 0.0003, outputPer1k: 0.0025, imagePerOutput: 0.039 });
    expect(axes.promptPerToken).toBeCloseTo(0.0000003, 12);
    expect(axes.completionPerToken).toBeCloseTo(0.0000025, 12);
    expect(axes.imagePerImage).toBe(0.039);
    expect(axes.requestFlat).toBe(0);
  });
});

describe('helpers', () => {
  it('hasFreeSuffix recognises :free, case-insensitive', () => {
    expect(hasFreeSuffix('google/gemini-2.0-flash-exp:FREE')).toBe(true);
    expect(hasFreeSuffix('google/gemini-2.0-flash')).toBe(false);
    expect(hasFreeSuffix(null)).toBe(false);
  });
  it('perMillion formats sensibly and shows — for zero', () => {
    expect(perMillion(0)).toBe('—');
    expect(perMillion(0.000001)).toMatch(/^1\.0/);
  });
});
