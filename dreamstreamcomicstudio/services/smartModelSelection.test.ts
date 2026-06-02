import { describe, it, expect } from 'vitest';
import { buildSmartTeam, rankModelsForTask } from './smartModelSelection';
import type { CatalogModel } from './modelCatalog';

const m = (over: Partial<CatalogModel>): CatalogModel => ({
  id: 'x/y', name: 'Y', source: 'openrouter',
  inputModalities: ['text'], outputModalities: ['text'], supportedParameters: [],
  pricing: { promptPerToken: 0.000001, completionPerToken: 0.000002, imagePerImage: 0, requestFlat: 0 },
  isFree: false, costClass: 'paid', supportsImageOutput: false, supportsImageInput: false, supportsJsonOutput: false,
  roles: [], costBand: 'low', drawbacks: [], possibilities: [],
  ...over
});

const freeText = m({ id: 'meta/llama-3.3-70b:free', name: 'Llama Free', isFree: true, costClass: 'free_verified', costBand: 'free', supportsJsonOutput: true });
const paidText = m({ id: 'openai/gpt-4o', name: 'GPT-4o', costBand: 'high', supportsJsonOutput: true });
const reasoningText = m({ id: 'deepseek/deepseek-r1:free', name: 'R1 Free', isFree: true, costClass: 'free_verified', costBand: 'free', supportsJsonOutput: true });
const refImage = m({ id: 'google/gemini-2.5-flash-image', name: 'Nano Banana', supportsImageOutput: true, supportsImageInput: true, outputModalities: ['image'], inputModalities: ['text', 'image'], costBand: 'medium' });
const freeImage = m({ id: 'some/free-image:free', name: 'Free Image', isFree: true, costClass: 'free_verified', costBand: 'free', supportsImageOutput: true, outputModalities: ['image'] });

describe('smart model selection', () => {
  it('free mode excludes paid models', () => {
    const ranked = rankModelsForTask([freeText, paidText], 'script_analysis', 'free');
    expect(ranked.every((r) => r.model.isFree)).toBe(true);
    expect(ranked.find((r) => r.model.id === 'openai/gpt-4o')).toBeUndefined();
  });

  it('panel_breakdown favors a reasoning model', () => {
    const best = rankModelsForTask([freeText, reasoningText], 'panel_breakdown', 'best')[0];
    expect(best.model.id).toBe('deepseek/deepseek-r1:free');
  });

  it('panel_art gates out text-only models and favors reference-capable image models', () => {
    const ranked = rankModelsForTask([freeText, refImage, freeImage], 'panel_art', 'best');
    expect(ranked[0].model.id).toBe('google/gemini-2.5-flash-image');
    expect(ranked.find((r) => r.model.id === freeText.id)).toBeUndefined();
  });

  it('free team uses free text + free image when available', () => {
    const team = buildSmartTeam([freeText, paidText, refImage, freeImage], 'free');
    expect(team.text?.model.isFree).toBe(true);
    expect(team.image?.model.isFree).toBe(true);
  });

  it('free team yields no image when no free image model exists', () => {
    const team = buildSmartTeam([freeText, refImage], 'free');
    expect(team.text?.model.isFree).toBe(true);
    expect(team.image).toBeNull();
  });
});
