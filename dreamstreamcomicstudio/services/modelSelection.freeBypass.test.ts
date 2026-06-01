import { describe, it, expect } from 'vitest';
import { isTrulyFreeModelId } from './modelSelection';

describe('isTrulyFreeModelId (truly-free bypasses per-key USD limit)', () => {
  it('treats OpenRouter :free variants as truly free', () => {
    expect(isTrulyFreeModelId('google/gemini-2.0-flash-exp:free')).toBe(true);
    expect(isTrulyFreeModelId('meta-llama/llama-3.3-70b-instruct:free')).toBe(true);
    expect(isTrulyFreeModelId('  deepseek/deepseek-chat:FREE  ')).toBe(true);
  });

  it('treats paid models as NOT free (per-key limit still applies)', () => {
    expect(isTrulyFreeModelId('google/gemini-2.5-flash-image')).toBe(false);
    expect(isTrulyFreeModelId('openai/gpt-4o')).toBe(false);
    expect(isTrulyFreeModelId('nano-banana-2')).toBe(false);
  });

  it('is safe for empty/nullish ids', () => {
    expect(isTrulyFreeModelId(undefined)).toBe(false);
    expect(isTrulyFreeModelId(null)).toBe(false);
    expect(isTrulyFreeModelId('')).toBe(false);
  });
});
