import { describe, it, expect } from 'vitest';
import { createOpenAICompatibleProvider } from './openaiCompatible.js';
import { staticModelsFor } from './staticModels.js';

describe('openai-compatible provider factory', () => {
  const provider = createOpenAICompatibleProvider({
    id: 'openai',
    label: 'OpenAI',
    baseUrl: 'https://example.invalid/v1',
    timeoutMs: 1000,
    modelsPath: '/models',
    supportsTools: true
  });

  it('returns the curated static seed when no key is supplied (no network)', async () => {
    const models = await provider.listModels();
    const seed = staticModelsFor('openai');
    expect(models.map((m) => m.id).sort()).toEqual(seed.map((m) => m.id).sort());
    expect(models.every((m) => m.source === 'openai')).toBe(true);
  });

  it('implements the full AIProvider surface', () => {
    expect(provider.id).toBe('openai');
    expect(typeof provider.generateText).toBe('function');
    expect(typeof provider.generateTextStream).toBe('function');
    expect(typeof provider.generateImage).toBe('function');
    expect(typeof provider.listModels).toBe('function');
  });

  it('a text-only provider refuses image generation with a clear error', async () => {
    await expect(provider.generateImage({ model: 'x', prompt: 'y' }, { apiKey: 'k', byok: true })).rejects.toThrow(/text provider/i);
  });
});
