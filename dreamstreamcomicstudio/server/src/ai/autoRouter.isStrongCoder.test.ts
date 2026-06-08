import { describe, it, expect } from 'vitest';
import { isStrongCoder } from './autoRouter.js';

describe('isStrongCoder', () => {
  it('recognizes frontier / strong coders', () => {
    expect(isStrongCoder('anthropic/claude-sonnet-4')).toBe(true);
    expect(isStrongCoder('anthropic/claude-opus-4.1')).toBe(true);
    expect(isStrongCoder('openai/gpt-4o')).toBe(true);
    expect(isStrongCoder('openai/gpt-5')).toBe(true);
    expect(isStrongCoder('qwen/qwen3-coder')).toBe(true);
    expect(isStrongCoder('deepseek/deepseek-chat-v3.1')).toBe(true);
  });

  it('flags genuinely weak / small free models', () => {
    expect(isStrongCoder('meta-llama/llama-3.1-8b-instruct:free')).toBe(false);
    expect(isStrongCoder('mistralai/mistral-7b-instruct:free')).toBe(false);
    expect(isStrongCoder('google/gemma-2-9b-it:free')).toBe(false);
    expect(isStrongCoder('')).toBe(false);
  });

  it('is case-insensitive', () => {
    expect(isStrongCoder('Anthropic/Claude-Sonnet-4')).toBe(true);
  });
});
