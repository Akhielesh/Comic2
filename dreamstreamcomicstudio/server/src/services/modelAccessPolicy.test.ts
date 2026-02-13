import { describe, expect, it } from 'vitest';
import { assertModelAllowedForTier, resolveAllowedModels } from './modelAccessPolicy.js';

describe('modelAccessPolicy', () => {
  it('coerces free text model to Gemini 2.0 Flash before rollover', () => {
    const result = assertModelAllowedForTier({
      scope: 'text',
      planTier: 'free',
      requestedModel: 'gemini-2.5-flash',
      at: '2026-03-01T00:00:00.000Z'
    });

    expect(result.effectiveModel).toBe('gemini-2.0-flash');
    expect(result.coerced).toBe(true);
  });

  it('coerces free text model to Gemini 2.5 Flash on and after rollover date', () => {
    const result = assertModelAllowedForTier({
      scope: 'text',
      planTier: 'free',
      requestedModel: 'gemini-2.0-flash',
      at: '2026-03-31T00:00:00.000Z'
    });

    expect(result.effectiveModel).toBe('gemini-2.5-flash');
    expect(result.coerced).toBe(true);
  });

  it('blocks free users from pro-only text models with MODEL_NOT_ALLOWED_FOR_PLAN', () => {
    try {
      assertModelAllowedForTier({
        scope: 'assistant',
        planTier: 'free',
        requestedModel: 'gemini-3-pro-preview',
        at: '2026-03-01T00:00:00.000Z'
      });
      throw new Error('Expected error was not thrown');
    } catch (error: any) {
      expect(error?.status).toBe(403);
      expect(error?.publicCode).toBe('MODEL_NOT_ALLOWED_FOR_PLAN');
      expect(Array.isArray(error?.details?.allowedModels)).toBe(true);
    }
  });

  it('allows pro tiers to use Gemini 3 family models', () => {
    const result = assertModelAllowedForTier({
      scope: 'text',
      planTier: 'pro',
      requestedModel: 'gemini-3-pro-preview'
    });

    expect(result.effectiveModel).toBe('gemini-3-pro-preview');
    expect(result.coerced).toBe(false);
  });

  it('keeps free image model list to Flux + Nano Banana', () => {
    const allowed = resolveAllowedModels('image', 'free');
    expect(allowed).toEqual(['pixazo/flux-1-schnell', 'gemini-2.5-flash-image']);
  });
});
