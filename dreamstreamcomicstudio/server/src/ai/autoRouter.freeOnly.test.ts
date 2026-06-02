import { describe, it, expect, vi, beforeEach } from 'vitest';

const catalogMock = vi.hoisted(() => ({ models: [] as any[] }));
vi.mock('../services/modelCatalog.js', () => ({
  getCatalog: async () => catalogMock
}));

import { pickTextModel, pickImageModel, NoFreeModelAvailableError } from './autoRouter.js';

const model = (over: any) => ({
  id: 'x',
  name: 'x',
  source: 'openrouter',
  inputModalities: ['text'],
  outputModalities: ['text'],
  supportedParameters: [],
  pricing: { promptPerToken: 0, completionPerToken: 0, imagePerImage: 0, requestFlat: 0 },
  isFree: true,
  costClass: 'free_verified',
  supportsImageOutput: false,
  supportsImageInput: false,
  supportsJsonOutput: true,
  roles: [],
  costBand: 'free',
  drawbacks: [],
  possibilities: [],
  ...over
});

describe('autoRouter free-only', () => {
  beforeEach(() => {
    catalogMock.models = [];
  });

  it('returns a :free text model when one exists', async () => {
    catalogMock.models = [model({ id: 'meta-llama/llama-3.3-70b-instruct:free' })];
    const id = await pickTextModel({ costPref: 'free-only' });
    expect(id).toBe('meta-llama/llama-3.3-70b-instruct:free');
  });

  it('throws NoFreeModelAvailableError when no free text model passes the gate', async () => {
    catalogMock.models = [
      model({
        id: 'openai/gpt-4o',
        costClass: 'paid',
        isFree: false,
        pricing: { promptPerToken: 0.000005, completionPerToken: 0.000015, imagePerImage: 0, requestFlat: 0 }
      })
    ];
    await expect(pickTextModel({ costPref: 'free-only' })).rejects.toBeInstanceOf(NoFreeModelAvailableError);
  });

  it('never returns a token-billed image model in free-only image mode', async () => {
    // gemini-2.5-flash-image style: imagePerImage=0 but token-billed (zero_priced_token_billed).
    catalogMock.models = [
      model({
        id: 'google/gemini-2.5-flash-image',
        supportsImageOutput: true,
        outputModalities: ['image'],
        isFree: false,
        costClass: 'zero_priced_token_billed',
        pricing: { promptPerToken: 0.0000003, completionPerToken: 0.0000025, imagePerImage: 0, requestFlat: 0 }
      })
    ];
    await expect(pickImageModel({ costPref: 'free-only' })).rejects.toBeInstanceOf(NoFreeModelAvailableError);
  });

  it('prefers NVIDIA free image models over OpenRouter :free image models in free-only', async () => {
    catalogMock.models = [
      model({
        id: 'some/free-image:free',
        source: 'openrouter',
        supportsImageOutput: true,
        outputModalities: ['image']
      }),
      model({
        id: 'black-forest-labs/flux.1-schnell',
        source: 'nvidia',
        supportsImageOutput: true,
        outputModalities: ['image']
      })
    ];
    const id = await pickImageModel({ costPref: 'free-only' });
    expect(id).toBe('black-forest-labs/flux.1-schnell');
  });
});
