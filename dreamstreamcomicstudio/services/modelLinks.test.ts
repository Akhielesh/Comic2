import { describe, it, expect } from 'vitest';
import { modelLinks } from './modelLinks';
import type { CatalogModel } from './modelCatalog';

const model = (over: Partial<CatalogModel>): CatalogModel => ({
  id: 'x/y',
  name: 'Y',
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

describe('modelLinks', () => {
  it('links an OpenRouter model to its page (without the :free suffix)', () => {
    const links = modelLinks(model({ id: 'meta-llama/llama-3.3-70b-instruct:free' }));
    const source = links.find((l) => l.kind === 'source');
    expect(source?.url).toBe('https://openrouter.ai/meta-llama/llama-3.3-70b-instruct');
  });

  it('links an NVIDIA model to build.nvidia.com', () => {
    const links = modelLinks(model({ id: 'meta/llama-3.3-70b-instruct', source: 'nvidia' }));
    expect(links.find((l) => l.kind === 'source')?.url).toBe('https://build.nvidia.com/meta/llama-3.3-70b-instruct');
  });

  it('adds a Hugging Face search link by model name (no dead repo guesses)', () => {
    const hf = modelLinks(model({ id: 'qwen/qwen-2.5-72b-instruct' })).find((l) => l.kind === 'host');
    expect(hf?.url).toContain('huggingface.co/models?search=');
    expect(hf?.url).toContain('qwen-2.5-72b-instruct');
  });
});
