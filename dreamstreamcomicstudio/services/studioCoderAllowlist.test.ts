import { describe, it, expect } from 'vitest';
import { isAllowlistedCoder, curateCoders } from './studioCoderAllowlist';

describe('studioCoderAllowlist', () => {
  it('recognizes reputable coders', () => {
    expect(isAllowlistedCoder('anthropic/claude-3.5-sonnet')).toBe(true);
    expect(isAllowlistedCoder('openai/gpt-4o')).toBe(true);
    expect(isAllowlistedCoder('deepseek/deepseek-chat')).toBe(true);
    expect(isAllowlistedCoder('qwen/qwen-2.5-coder-32b-instruct')).toBe(true);
    expect(isAllowlistedCoder('google/gemini-2.0-flash-exp')).toBe(true);
  });

  it('rejects unknown / weak / empty ids', () => {
    expect(isAllowlistedCoder('some-random/tiny-model')).toBe(false);
    expect(isAllowlistedCoder('')).toBe(false);
    expect(isAllowlistedCoder(undefined)).toBe(false);
  });

  it('curateCoders hides download-only models and keeps the curated set', () => {
    const coders = [
      { id: 'anthropic/claude-3.5-sonnet', apiCallable: true },
      { id: 'openai/gpt-4o', apiCallable: true },
      { id: 'deepseek/deepseek-chat', apiCallable: true },
      { id: 'nvidia/embed-only', apiCallable: false }, // download-only → hidden
      { id: 'obscure/weak-model', apiCallable: true }, // not allowlisted → hidden
    ];
    const out = curateCoders(coders).map((m) => m.id);
    expect(out).toContain('anthropic/claude-3.5-sonnet');
    expect(out).not.toContain('nvidia/embed-only');
    expect(out).not.toContain('obscure/weak-model');
  });

  it('falls back to the callable list when nothing matches the curated patterns (never empties)', () => {
    const coders = [
      { id: 'obscure/a', apiCallable: true },
      { id: 'obscure/b', apiCallable: true },
      { id: 'obscure/c', apiCallable: false },
    ];
    const out = curateCoders(coders).map((m) => m.id);
    expect(out).toEqual(['obscure/a', 'obscure/b']); // callable ones, broken hidden
  });
});
