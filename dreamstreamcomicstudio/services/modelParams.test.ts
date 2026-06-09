import { describe, it, expect } from 'vitest';
import { getModelSize } from './modelParams';

describe('modelParams', () => {
  it('reports published sizes for known open-weight families', () => {
    expect(getModelSize('deepseek/deepseek-v3.1')?.params).toMatch(/671B/);
    expect(getModelSize('meta-llama/llama-3.1-405b-instruct')?.params).toBe('405B');
    expect(getModelSize('qwen/qwen3-coder')?.params).toMatch(/480B/);
    expect(getModelSize('z-ai/glm-4.6')?.params).toMatch(/357B/);
    expect(getModelSize('black-forest-labs/flux-1.1-pro')?.params).toBe('12B');
  });

  it('flags MoE vs dense architecture', () => {
    expect(getModelSize('deepseek/deepseek-v3.1')?.arch).toBe('moe');
    expect(getModelSize('meta-llama/llama-3.1-405b')?.arch).toBe('dense');
  });

  it('returns null for closed / undisclosed models', () => {
    expect(getModelSize('openai/gpt-4o')).toBeNull();
    expect(getModelSize('anthropic/claude-sonnet-4')).toBeNull();
    expect(getModelSize('google/gemini-2.5-pro')).toBeNull();
  });
});
