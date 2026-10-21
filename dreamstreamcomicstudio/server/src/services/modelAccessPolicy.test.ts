import { describe, expect, it } from 'vitest';
import { IMAGE_MODELS } from '../../../shared/comic/models.js';
import { assertModelAllowedForTier, resolveAllowedModels, toEffectiveTier } from './modelAccessPolicy.js';

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

  it('keeps free image model list to Flux + Nano Banana (+ Comic Studio Nano Banana 2.1)', () => {
    const allowed = resolveAllowedModels('image', 'free');
    expect(allowed).toEqual([
      'pixazo/flux-1-schnell',
      'gemini-2.5-flash-image',
      'gemini-nano-banana-2.1',
      'google/gemini-nano-banana-2.1'
    ]);
  });
});

describe('modelAccessPolicy — paid plans and Comic Studio image models', () => {
  it.each(['creator', 'custom', 'pro', 'studio', 'admin'])('treats the paid plan %s as pro', (plan) => {
    expect(toEffectiveTier(plan)).toBe('pro');
    const result = assertModelAllowedForTier({ scope: 'image', planTier: plan, requestedModel: 'google/gemini-3-pro-image' });
    expect(result.effectiveModel).toBe('google/gemini-3-pro-image');
  });

  it('keeps free and unknown plans on the free tier', () => {
    expect(toEffectiveTier('free')).toBe('free');
    expect(toEffectiveTier(undefined)).toBe('free');
    expect(toEffectiveTier('mystery')).toBe('free');
  });

  it('gives paid plans every registry image model on both transports', () => {
    const allowed = resolveAllowedModels('image', 'creator');
    for (const spec of IMAGE_MODELS) {
      for (const id of Object.values(spec.routes)) expect(allowed).toContain(id);
    }
    expect(allowed).toContain('gemini-3-pro-image-preview');
    expect(new Set(allowed).size).toBe(allowed.length);
  });

  it('lets free plans use Nano Banana 2.1 but not Pro', () => {
    expect(assertModelAllowedForTier({ scope: 'image', planTier: 'free', requestedModel: 'gemini-nano-banana-2.1' }).effectiveModel).toBe(
      'gemini-nano-banana-2.1'
    );
    expect(() => assertModelAllowedForTier({ scope: 'image', planTier: 'free', requestedModel: 'google/gemini-3-pro-image' })).toThrow();
  });
});
