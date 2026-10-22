import { describe, expect, it } from 'vitest';
import { IMAGE_MODELS } from '../../../shared/comic/models.js';
import {
  FALLBACK_MODEL_PRICING,
  looksLikeImageModel,
  registryImagePriceUsd,
  resolveModelPricing,
  selectEffectiveModelPricing
} from './pricingCatalog.js';

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

describe('Comic Studio v4 pricing rows', () => {
  const find = (provider: string, model: string) =>
    FALLBACK_MODEL_PRICING.find((row) => row.provider === provider && row.model === model);

  it('prices every registry image model on both transports per image', () => {
    for (const spec of IMAGE_MODELS) {
      for (const [route, modelId] of Object.entries(spec.routes)) {
        const row = find(route === 'gemini' ? 'gemini' : 'openrouter', modelId!);
        expect(row, `${route}:${modelId}`).toBeDefined();
        expect(row!.imagePerOutputUsd).toBeGreaterThan(0);
        expect(row!.inputPer1kUsd).toBe(0);
        expect(row!.outputPer1kUsd).toBe(0);
      }
    }
    expect(find('openrouter', 'google/gemini-nano-banana-2.1')?.imagePerOutputUsd).toBe(0.0504);
    expect(find('gemini', 'gemini-nano-banana-2.1')?.imagePerOutputUsd).toBe(0.0504);
    expect(find('openrouter', 'google/gemini-3-pro-image')?.imagePerOutputUsd).toBe(0.134);
    expect(find('gemini', 'gemini-3-pro-image')?.imagePerOutputUsd).toBe(0.134);
  });

  it('keeps one row per provider:model and the shape of the existing rows', () => {
    const keys = FALLBACK_MODEL_PRICING.map((row) => `${row.provider}:${row.model}`);
    expect(new Set(keys).size).toBe(keys.length);
    const shape = Object.keys(FALLBACK_MODEL_PRICING[0]).sort();
    for (const row of FALLBACK_MODEL_PRICING) expect(Object.keys(row).sort()).toEqual(shape);
    // Hand-maintained legacy rows are not overridden by generated ones.
    expect(find('openrouter', 'google/gemini-2.5-flash-image')?.imagePerOutputUsd).toBe(0.04);
  });

  it('prices the studio text roles per token (OpenRouter list prices)', () => {
    expect(find('openrouter', 'google/gemini-3.8-flash')).toMatchObject({ inputPer1kUsd: 0.000825, outputPer1kUsd: 0.004125 });
    expect(find('openrouter', 'anthropic/claude-sonnet-5.5')).toMatchObject({ inputPer1kUsd: 0.002, outputPer1kUsd: 0.01 });
    expect(find('openrouter', 'openai/gpt-6-luna')).toMatchObject({ inputPer1kUsd: 0.0001, outputPer1kUsd: 0.0005 });
    expect(find('openrouter', 'google/gemini-4-argon')).toMatchObject({ inputPer1kUsd: 0.002, outputPer1kUsd: 0.01 });
    expect(find('openrouter', 'google/gemini-3.7-flash')).toMatchObject({ inputPer1kUsd: 0.00075, outputPer1kUsd: 0.00375 });
    expect(find('gemini', 'gemini-3.8-flash')).toMatchObject({ inputPer1kUsd: 0.000825, outputPer1kUsd: 0.004125 });
  });

  it('uses the 2K price when listed, else the highest', () => {
    expect(registryImagePriceUsd({ '1K': 0.03, '2K': 0.05, '4K': 0.1 })).toBe(0.05);
    expect(registryImagePriceUsd({ '1K': 0.039 })).toBe(0.039);
    expect(registryImagePriceUsd({})).toBe(0);
  });
});

describe('resolveModelPricing', () => {
  // No Supabase in unit tests → the fallback catalog is the live catalog.
  it('resolves registry image models exactly', async () => {
    const row = await resolveModelPricing('openrouter', 'google/gemini-nano-banana-2.1');
    expect(row.imagePerOutputUsd).toBe(0.0504);
  });

  it('never prices an unknown image model from a $0-image text row', async () => {
    const row = await resolveModelPricing('openrouter', 'google/gemini-9-flash-image-preview');
    expect(row.imagePerOutputUsd).toBeGreaterThan(0);
    expect(row.imagePerOutputUsd).toBe(Math.max(...FALLBACK_MODEL_PRICING.filter((r) => r.provider === 'openrouter').map((r) => r.imagePerOutputUsd)));
    expect(looksLikeImageModel('black-forest-labs/flux-9')).toBe(true);
    expect(looksLikeImageModel('anthropic/claude-sonnet-5.5')).toBe(false);
  });

  it('keeps the provider-wide fallback for unknown text models', async () => {
    const row = await resolveModelPricing('openrouter', 'mystery/text-model');
    expect(row.provider).toBe('openrouter');
    expect(row.model).toBe('google/gemini-2.5-flash');
  });
});
