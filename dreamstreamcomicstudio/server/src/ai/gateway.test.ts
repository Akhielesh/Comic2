import { describe, it, expect } from 'vitest';
import { defaultModelForProvider, defaultProviderId } from './gateway.js';

describe('gateway provider defaults', () => {
  it('gives each direct provider its own default chat model (never an OpenRouter slug)', () => {
    expect(defaultModelForProvider('openai')).toBe('gpt-4o-mini');
    expect(defaultModelForProvider('anthropic')).toMatch(/^claude/);
    expect(defaultModelForProvider('gemini')).toBe('gemini-2.5-flash');
    expect(defaultModelForProvider('deepseek')).toBe('deepseek-chat');
    expect(defaultModelForProvider('xai')).toMatch(/^grok/);
    for (const id of ['openai', 'anthropic', 'gemini', 'deepseek', 'zai', 'minimax', 'tencent', 'xai']) {
      // A direct provider default must NOT look like an OpenRouter "vendor/model" slug.
      expect(defaultModelForProvider(id)).not.toContain('/');
    }
  });

  it('has no direct default for the unified gateways (they keep their own logic)', () => {
    expect(defaultModelForProvider('openrouter')).toBeUndefined();
    expect(defaultModelForProvider('nvidia')).toBeUndefined();
  });

  it('only ever defaults the platform provider to a unified gateway', () => {
    expect(['openrouter', 'nvidia']).toContain(defaultProviderId());
  });
});
