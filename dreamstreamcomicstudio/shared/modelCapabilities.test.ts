import { describe, it, expect } from 'vitest';
import {
  classifyModelKind,
  deriveModelCapabilities,
  productFitForModel
} from './modelCapabilities';

const chatModel = {
  id: 'google/gemini-2.5-flash',
  inputModalities: ['text', 'image'],
  outputModalities: ['text'],
  supportedParameters: ['temperature', 'tools', 'response_format', 'reasoning'],
  contextLength: 1_000_000
};

describe('classifyModelKind', () => {
  it('classifies general chat models as chat', () => {
    expect(classifyModelKind(chatModel)).toBe('chat');
  });

  it('flags the special-purpose models that polluted bench run 6d0b89f2', () => {
    expect(classifyModelKind({ id: 'meta-llama/llama-guard-4-12b' })).toBe('safety-classifier');
    expect(classifyModelKind({ id: 'nvidia/nemotron-3.5-content-safety:free' })).toBe('safety-classifier');
    expect(classifyModelKind({ id: 'relace/relace-apply-3' })).toBe('code-apply');
    expect(classifyModelKind({ id: 'morph/morph-v3-fast' })).toBe('code-apply');
    expect(classifyModelKind({ id: 'openrouter/bodybuilder' })).toBe('request-router');
    expect(classifyModelKind({ id: 'openai/o3-deep-research' })).toBe('deep-research');
    expect(classifyModelKind({ id: 'google/lyria-3-pro-preview', outputModalities: ['audio'] })).toBe('media');
  });

  it('treats non-text modalities as media even without a name match', () => {
    expect(classifyModelKind({ id: 'openai/gpt-audio', inputModalities: ['audio'], outputModalities: ['audio'] })).toBe('media');
  });
});

describe('deriveModelCapabilities', () => {
  it('derives flags from catalog metadata', () => {
    const caps = deriveModelCapabilities(chatModel);
    expect(caps).toMatchObject({
      kind: 'chat',
      vision: true,
      tools: true,
      reasoning: true,
      json: true,
      longContext: true,
      temperature: true
    });
  });

  it('marks o-series style models as temperature-incompatible', () => {
    const caps = deriveModelCapabilities({
      id: 'openai/o4-mini',
      supportedParameters: ['reasoning', 'max_tokens']
    });
    expect(caps.temperature).toBe(false);
    expect(caps.reasoning).toBe(true);
  });
});

describe('productFitForModel', () => {
  it('allows chat models everywhere', () => {
    expect(productFitForModel(chatModel, 'chat_studio').allowed).toBe(true);
    expect(productFitForModel(chatModel, 'stream_studio').allowed).toBe(true);
    expect(productFitForModel(chatModel, 'comic_studio').allowed).toBe(true);
  });

  it('blocks special-purpose models from every studio with a reason', () => {
    const fit = productFitForModel({ id: 'meta-llama/llama-guard-4-12b' }, 'chat_studio');
    expect(fit.allowed).toBe(false);
    expect(fit.blockedReason).toMatch(/safety classifier/);
  });

  it('requires tool calling for Code Studio but not Chat Studio', () => {
    const toolless = { ...chatModel, id: 'some/chatty-model', supportedParameters: ['temperature'] };
    expect(productFitForModel(toolless, 'chat_studio').allowed).toBe(true);
    expect(productFitForModel(toolless, 'stream_studio').allowed).toBe(false);
  });

  it('reports missing recommended capabilities without blocking', () => {
    const basic = { ...chatModel, supportedParameters: ['temperature', 'tools'] };
    const fit = productFitForModel(basic, 'chat_studio');
    expect(fit.allowed).toBe(true);
    expect(fit.missingRecommended).toContain('json');
  });

  it('passes unknown products through (forward compatibility)', () => {
    expect(productFitForModel({ id: 'meta-llama/llama-guard-4-12b' }, 'future_studio').allowed).toBe(true);
  });
});
