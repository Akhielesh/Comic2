import { describe, it, expect, beforeEach, vi } from 'vitest';

const catalogMock = vi.hoisted(() => ({ models: [] as any[] }));
vi.mock('../services/modelCatalog.js', () => ({ getCatalog: async () => catalogMock }));

import { pickCodingModel, prefersCodingModel, CODING_MODEL_PRIORITY, STRONG_CODING_PRIORITY } from './autoRouter.js';

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

describe('prefersCodingModel', () => {
  it('recognizes strong coding families', () => {
    expect(prefersCodingModel(model({ id: 'deepseek/deepseek-coder-v2' }))).toBe(true);
    expect(prefersCodingModel(model({ id: 'qwen/qwen-2.5-coder-32b-instruct:free' }))).toBe(true);
    expect(prefersCodingModel(model({ id: 'mistralai/codestral-2501' }))).toBe(true);
  });

  it('does not flag unrelated models', () => {
    expect(prefersCodingModel(model({ id: 'mistralai/mistral-7b-instruct:free' }))).toBe(false);
    expect(prefersCodingModel(model({ id: 'nousresearch/hermes-3' }))).toBe(false);
  });

  it('priority list is non-empty and lowercase', () => {
    expect(CODING_MODEL_PRIORITY.length).toBeGreaterThan(0);
    expect(CODING_MODEL_PRIORITY.every((n) => n === n.toLowerCase())).toBe(true);
  });
});

describe('pickCodingModel', () => {
  beforeEach(() => {
    catalogMock.models = [];
  });

  it('prefers a coding model over a generic one when both are free', async () => {
    catalogMock.models = [
      model({ id: 'mistralai/mistral-7b-instruct:free' }),
      model({ id: 'qwen/qwen-2.5-coder-32b-instruct:free' })
    ];
    expect(await pickCodingModel()).toBe('qwen/qwen-2.5-coder-32b-instruct:free');
  });

  it('falls back to a normal pick when no coding model exists', async () => {
    catalogMock.models = [model({ id: 'meta-llama/llama-3.1-8b-instruct:free' })];
    expect(await pickCodingModel()).toBe('meta-llama/llama-3.1-8b-instruct:free');
  });

  it('quality mode prefers the STRONGEST coder (frontier), free or paid', async () => {
    catalogMock.models = [
      model({ id: 'qwen/qwen-2.5-coder-32b-instruct:free' }),
      model({ id: 'anthropic/claude-sonnet-4', isFree: false, costClass: 'paid', contextLength: 200000 }),
      model({ id: 'deepseek/deepseek-chat-v3.1:free' }),
    ];
    expect(await pickCodingModel({ costPref: 'quality' })).toBe('anthropic/claude-sonnet-4');
  });

  it('free mode still prefers the best FREE coder over a paid frontier model', async () => {
    catalogMock.models = [
      model({ id: 'anthropic/claude-sonnet-4', isFree: false, costClass: 'paid', contextLength: 200000 }),
      model({ id: 'qwen/qwen3-coder:free' }),
    ];
    expect(await pickCodingModel({ costPref: 'free' })).toBe('qwen/qwen3-coder:free');
  });

  it('STRONG_CODING_PRIORITY is non-empty and lowercase', () => {
    expect(STRONG_CODING_PRIORITY.length).toBeGreaterThan(0);
    expect(STRONG_CODING_PRIORITY.every((n) => n === n.toLowerCase())).toBe(true);
  });
});
