import { describe, it, expect } from 'vitest';
import type { CatalogModel } from './modelCatalog';
import { getModelDomains, domainStrength, topDomains } from './modelDomains';
import { getModelBenchmarks, normalizeScore } from './modelBenchmarks';

// Minimal catalog-model factory — only the fields the domain/benchmark layers read.
const model = (over: Partial<CatalogModel> & { id: string }): CatalogModel => ({
  name: over.id,
  source: 'openrouter',
  inputModalities: ['text'],
  outputModalities: ['text'],
  supportedParameters: [],
  pricing: { promptPerToken: 0, completionPerToken: 0, imagePerImage: 0, requestFlat: 0 },
  isFree: false,
  costClass: 'paid',
  supportsImageOutput: false,
  supportsImageInput: false,
  supportsJsonOutput: false,
  roles: [],
  costBand: 'medium',
  drawbacks: [],
  possibilities: [],
  ...over
});

describe('modelBenchmarks', () => {
  it('matches a model id to its family snapshot', () => {
    const bm = getModelBenchmarks('anthropic/claude-3.5-sonnet');
    expect(bm?.family).toBe('Claude 3.5 Sonnet');
    expect(bm?.scores.humaneval).toBeGreaterThan(80);
    expect(bm?.sourceUrl).toMatch(/^https?:\/\//);
  });

  it('prefers the more specific family (coder before generic qwen)', () => {
    expect(getModelBenchmarks('qwen/qwen-2.5-coder-32b')?.family).toBe('Qwen2.5-Coder');
    expect(getModelBenchmarks('qwen/qwen-2.5-72b')?.family).toBe('Qwen2.5');
  });

  it('returns null for unknown models', () => {
    expect(getModelBenchmarks('some/unknown-model-xyz')).toBeNull();
  });

  it('normalizes scores into a clamped 0–100 range', () => {
    expect(normalizeScore('humaneval', 96)).toBe(100);
    expect(normalizeScore('humaneval', 0)).toBe(2); // clamped to floor, min 2
  });
});

describe('modelDomains', () => {
  it('tags a coder model strongly for coding', () => {
    const m = model({ id: 'qwen/qwen-2.5-coder-32b' });
    expect(domainStrength(m, 'coding')).toBeGreaterThanOrEqual(70);
    expect(topDomains(m).some((d) => d.id === 'coding')).toBe(true);
  });

  it('tags a science-strong model for science', () => {
    const m = model({ id: 'google/gemini-2.5-pro' });
    expect(domainStrength(m, 'science')).toBeGreaterThan(60);
  });

  it('derives image_gen from capability, not benchmarks', () => {
    const m = model({ id: 'black-forest-labs/flux-1.1', supportsImageOutput: true, outputModalities: ['image'] });
    const domains = getModelDomains(m);
    expect(domains.some((d) => d.id === 'image_gen')).toBe(true);
    // no text benchmarks for flux → no coding tag
    expect(domains.some((d) => d.id === 'coding')).toBe(false);
  });

  it('marks reasoning models even without a benchmark match', () => {
    const m = model({ id: 'someorg/mystery-thinking-model', supportedParameters: ['reasoning'] });
    expect(domainStrength(m, 'reasoning')).toBeGreaterThan(0);
  });
});
