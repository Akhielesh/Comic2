import { describe, it, expect } from 'vitest';
import { staticModelsFor, PROVIDERS_WITH_STATIC_MODELS } from './staticModels.js';

describe('static provider catalogs', () => {
  it('ships curated models for every direct provider', () => {
    for (const id of ['openai', 'anthropic', 'gemini', 'deepseek', 'zai', 'minimax', 'tencent', 'xai'] as const) {
      const models = staticModelsFor(id);
      expect(models.length).toBeGreaterThan(0);
      expect(PROVIDERS_WITH_STATIC_MODELS).toContain(id);
    }
  });

  it('tags each curated model with its source and never falsely advertises it as free', () => {
    for (const id of PROVIDERS_WITH_STATIC_MODELS) {
      for (const m of staticModelsFor(id)) {
        expect(m.source).toBe(id);
        // Curated models carry real per-token pricing, so they must classify as paid.
        expect(m.isFree).toBe(false);
        expect(m.costClass).toBe('paid');
        expect(m.contextLength).toBeGreaterThan(0);
        expect(m.outputModalities).toContain('text');
      }
    }
  });

  it('returns nothing for the live-listing gateways', () => {
    expect(staticModelsFor('openrouter')).toEqual([]);
    expect(staticModelsFor('nvidia')).toEqual([]);
  });
});
