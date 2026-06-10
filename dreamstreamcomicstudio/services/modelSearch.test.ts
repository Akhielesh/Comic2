import { describe, expect, it } from 'vitest';
import { boundedEditDistance, modelMatchesQuery, scoreModelForQuery, searchModels } from './modelSearch';
import type { CatalogModel } from './modelCatalog';

const make = (overrides: Partial<CatalogModel> & { id: string; name: string }): CatalogModel => ({
  source: 'openrouter',
  description: '',
  contextLength: 128_000,
  createdAt: 0,
  inputModalities: ['text'],
  outputModalities: ['text'],
  supportedParameters: [],
  pricing: { promptPerToken: 0.000001, completionPerToken: 0.000002, imagePerImage: 0, requestFlat: 0 },
  isFree: false,
  costClass: 'paid',
  supportsImageOutput: false,
  supportsImageInput: false,
  supportsJsonOutput: false,
  roles: [],
  costBand: 'low',
  drawbacks: [],
  possibilities: [],
  ...overrides
});

const claude = make({ id: 'anthropic/claude-sonnet-4.5', name: 'Claude Sonnet 4.5' });
const gpt4oMini = make({ id: 'openai/gpt-4o-mini', name: 'GPT-4o mini' });
const geminiImage = make({
  id: 'google/gemini-2.5-flash-image',
  name: 'Gemini 2.5 Flash Image',
  inputModalities: ['text', 'image'],
  outputModalities: ['image'],
  supportsImageOutput: true,
  supportsImageInput: true,
  isFree: true,
  costClass: 'free_verified',
  costBand: 'free',
  pricing: { promptPerToken: 0, completionPerToken: 0, imagePerImage: 0, requestFlat: 0 }
});
const deepseekR1 = make({
  id: 'deepseek/deepseek-r1',
  name: 'DeepSeek R1',
  supportedParameters: ['reasoning'],
  isFree: true,
  costClass: 'free_verified',
  costBand: 'free',
  pricing: { promptPerToken: 0, completionPerToken: 0, imagePerImage: 0, requestFlat: 0 }
});
const nemotron = make({ id: 'nvidia/llama-3.1-nemotron-70b-instruct', name: 'Llama 3.1 Nemotron 70B', source: 'nvidia' });
const kimi = make({ id: 'moonshotai/kimi-k2', name: 'Kimi K2' });

const ALL = [claude, gpt4oMini, geminiImage, deepseekR1, nemotron, kimi];

describe('boundedEditDistance', () => {
  it('computes small distances and respects the bound', () => {
    expect(boundedEditDistance('claude', 'claude', 2)).toBe(0);
    expect(boundedEditDistance('claud', 'claude', 2)).toBe(1);
    expect(boundedEditDistance('deepsek', 'deepseek', 2)).toBe(1);
    expect(boundedEditDistance('zzzzz', 'claude', 1)).toBeGreaterThan(1);
  });
});

describe('searchModels — token + alias matching', () => {
  it('matches by family alias even when the token is not in the id', () => {
    expect(searchModels(ALL, 'claude')).toContain(claude);
    expect(searchModels(ALL, 'kimi')).toContain(kimi);
  });

  it('matches vendor names ("anthropic", "google")', () => {
    expect(searchModels(ALL, 'anthropic')).toEqual([claude]);
    expect(searchModels(ALL, 'google')).toContain(geminiImage);
  });

  it('matches partial model tokens ("4o" finds GPT-4o mini)', () => {
    expect(searchModels(ALL, '4o')).toContain(gpt4oMini);
  });

  it('matches collapsed tokens ("gpt4o" finds gpt-4o)', () => {
    expect(searchModels(ALL, 'gpt4o')).toContain(gpt4oMini);
  });

  it('ranks an exact id hit first', () => {
    const results = searchModels(ALL, 'openai/gpt-4o-mini');
    expect(results[0]).toBe(gpt4oMini);
  });
});

describe('searchModels — typo tolerance', () => {
  it('finds models despite one-letter typos', () => {
    expect(searchModels(ALL, 'claud')).toContain(claude); // prefix
    expect(searchModels(ALL, 'cluade')).toContain(claude); // transposition-ish (distance 2)
    expect(searchModels(ALL, 'deepsek')).toContain(deepseekR1);
    expect(searchModels(ALL, 'gemeni')).toContain(geminiImage);
  });

  it('does not fuzz very short tokens into noise', () => {
    // "qq" shouldn't match anything here (too short for fuzzy).
    expect(searchModels(ALL, 'qq')).toEqual([]);
  });
});

describe('searchModels — facets and domains', () => {
  it('keeps facet semantics: "free" only returns free models', () => {
    const results = searchModels(ALL, 'free');
    expect(results).toContain(geminiImage);
    expect(results).toContain(deepseekR1);
    expect(results).not.toContain(claude);
  });

  it('ANDs every token: "free image" narrows to free image models', () => {
    expect(searchModels(ALL, 'free image')).toEqual([geminiImage]);
  });

  it('treats domain words as benchmark-backed filters ("coding")', () => {
    const results = searchModels(ALL, 'coding');
    // Claude Sonnet and DeepSeek R1 have strong coding benchmarks; the image model must not appear.
    expect(results).toContain(claude);
    expect(results).not.toContain(geminiImage);
  });

  it('source tokens work ("nvidia")', () => {
    expect(searchModels(ALL, 'nvidia')).toEqual([nemotron]);
  });
});

describe('searchModels — general behavior', () => {
  it('returns the input order for an empty query', () => {
    expect(searchModels(ALL, '')).toEqual(ALL);
    expect(searchModels(ALL, '   ')).toEqual(ALL);
  });

  it('returns nothing for gibberish', () => {
    expect(searchModels(ALL, 'xqzlrptv')).toEqual([]);
  });

  it('every-token-must-match: a good token plus gibberish excludes', () => {
    expect(searchModels(ALL, 'claude xqzlrptv')).toEqual([]);
  });

  it('modelMatchesQuery mirrors scoreModelForQuery > 0', () => {
    expect(modelMatchesQuery(claude, 'sonnet')).toBe(true);
    expect(modelMatchesQuery(claude, 'grok')).toBe(false);
    expect(scoreModelForQuery(claude, '')).toBe(1);
  });
});
