import { describe, expect, it } from 'vitest';
import { selectEffectiveModelPricing } from './pricingCatalog.js';

describe('selectEffectiveModelPricing', () => {
  it('prefers ACTIVE snapshot over newer REVIEW_REQUIRED snapshot for same model', () => {
    const rows = [
      {
        provider: 'gemini',
        model_id: 'gemini-2.5-flash',
        input_per_1k: 0.001,
        output_per_1k: 0.002,
        image_per_output: 0,
        source_url: 'review',
        parser_confidence: 0.6,
        status: 'REVIEW_REQUIRED',
        effective_from: '2026-02-12T03:00:00.000Z'
      },
      {
        provider: 'gemini',
        model_id: 'gemini-2.5-flash',
        input_per_1k: 0.0003,
        output_per_1k: 0.0025,
        image_per_output: 0,
        source_url: 'active',
        parser_confidence: 0.95,
        status: 'ACTIVE',
        effective_from: '2026-02-11T03:00:00.000Z'
      }
    ];

    const selected = selectEffectiveModelPricing(rows);
    expect(selected).toHaveLength(1);
    expect(selected[0].status).toBe('ACTIVE');
    expect(selected[0].source).toBe('active');
    expect(selected[0].inputPer1kUsd).toBe(0.0003);
  });
});
