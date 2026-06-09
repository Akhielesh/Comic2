import { describe, it, expect } from 'vitest';
import type { CatalogModel } from './modelCatalog';
import { valueScore, recommendModels } from './modelRecommendations';

const mk = (over: Partial<CatalogModel> & { id: string }): CatalogModel => ({
  id: over.id,
  name: over.name ?? over.id,
  source: 'openrouter',
  inputModalities: ['text'],
  outputModalities: ['text'],
  supportedParameters: [],
  pricing: { promptPerToken: 0, completionPerToken: 0, imagePerImage: 0, requestFlat: 0 },
  isFree: false,
  costClass: 'paid',
  supportsImageOutput: false,
  supportsImageInput: false,
  supportsJsonOutput: true,
  roles: [],
  costBand: 'low',
  drawbacks: [],
  possibilities: [],
  ...over,
});

// completionPerToken is per-token; $0.8/M => 0.8e-6.
const perM = (usdPerMillion: number) => usdPerMillion / 1_000_000;

describe('modelRecommendations', () => {
  it('a strong, cheap model beats a strong but expensive one and a weak cheap one', () => {
    const cheapStrong = mk({ id: 'deepseek/deepseek-v3.1', pricing: { promptPerToken: 0, completionPerToken: perM(0.8), imagePerImage: 0, requestFlat: 0 } });
    const expensiveStrong = mk({ id: 'anthropic/claude-opus-4', pricing: { promptPerToken: 0, completionPerToken: perM(75), imagePerImage: 0, requestFlat: 0 } });
    const cheapWeak = mk({ id: 'meta-llama/llama-3.1-8b', pricing: { promptPerToken: 0, completionPerToken: perM(0.2), imagePerImage: 0, requestFlat: 0 } });
    expect(valueScore(cheapStrong)).toBeGreaterThan(valueScore(expensiveStrong));
    expect(valueScore(cheapStrong)).toBeGreaterThan(valueScore(cheapWeak));
  });

  it('scores 0 for image models, download-only models, and models without benchmark data', () => {
    expect(valueScore(mk({ id: 'deepseek/deepseek-v3.1', supportsImageOutput: true }))).toBe(0);
    expect(valueScore(mk({ id: 'deepseek/deepseek-v3.1', apiCallable: false }))).toBe(0);
    expect(valueScore(mk({ id: 'some/unknown-model-xyz' }))).toBe(0);
  });

  it('recommendModels returns top-N text picks de-duped by family + a reference-capable image pick', () => {
    const models = [
      mk({ id: 'deepseek/deepseek-v3.1', pricing: { promptPerToken: 0, completionPerToken: perM(0.8), imagePerImage: 0, requestFlat: 0 } }),
      mk({ id: 'deepseek/deepseek-v3.2', pricing: { promptPerToken: 0, completionPerToken: perM(0.7), imagePerImage: 0, requestFlat: 0 } }), // same family -> deduped
      mk({ id: 'google/gemini-2.5-flash', pricing: { promptPerToken: 0, completionPerToken: perM(0.6), imagePerImage: 0, requestFlat: 0 } }),
      mk({ id: 'anthropic/claude-haiku', pricing: { promptPerToken: 0, completionPerToken: perM(4), imagePerImage: 0, requestFlat: 0 } }),
      mk({ id: 'google/gemini-2.5-flash-image', supportsImageOutput: true, supportsImageInput: true, pricing: { promptPerToken: 0, completionPerToken: 0, imagePerImage: 0.03, requestFlat: 0 } }),
      mk({ id: 'black-forest-labs/flux-schnell', supportsImageOutput: true, supportsImageInput: false, pricing: { promptPerToken: 0, completionPerToken: 0, imagePerImage: 0.003, requestFlat: 0 } }),
    ];
    const { bestValue, topImage } = recommendModels(models, 2);
    expect(bestValue).toHaveLength(2);
    // Only one DeepSeek variant should appear (family de-dupe).
    expect(bestValue.filter((m) => m.id.startsWith('deepseek/')).length).toBe(1);
    // Reference-capable image model wins over the cheaper non-reference one.
    expect(topImage?.id).toBe('google/gemini-2.5-flash-image');
  });
});
