import { describe, it, expect } from 'vitest';
import { parseParamCountB, isTimeoutProneFreeModel, speedTier } from './modelSpeed';

describe('parseParamCountB', () => {
  it('extracts the largest advertised param count from an id', () => {
    expect(parseParamCountB('nvidia/nemotron-3-ultra-550b-a55b:free')).toBe(550);
    expect(parseParamCountB('meta-llama/llama-3.1-405b-instruct')).toBe(405);
    expect(parseParamCountB('qwen/qwen3-235b-a22b:free')).toBe(235);
    expect(parseParamCountB('meta-llama/llama-3.3-70b-instruct')).toBe(70);
    expect(parseParamCountB('openai/gpt-oss-120b')).toBe(120);
  });

  it('returns 0 when no param count is advertised', () => {
    expect(parseParamCountB('deepseek/deepseek-chat-v3.1:free')).toBe(0);
    expect(parseParamCountB('anthropic/claude-3.5-haiku')).toBe(0);
    expect(parseParamCountB('openai/gpt-4o-mini')).toBe(0);
    expect(parseParamCountB('')).toBe(0);
  });

  it('does not treat context windows (k) or unrelated digits as params', () => {
    expect(parseParamCountB('google/gemini-2.0-flash')).toBe(0);
    expect(parseParamCountB('deepseek/deepseek-r1-0528:free')).toBe(0);
  });
});

describe('isTimeoutProneFreeModel', () => {
  it('flags very large FREE models (the recurring MODEL_TIMEOUT case)', () => {
    expect(isTimeoutProneFreeModel('nvidia/nemotron-3-ultra-550b-a55b:free', true)).toBe(true);
    expect(isTimeoutProneFreeModel('meta-llama/llama-3.1-405b-instruct:free', true)).toBe(true);
    expect(isTimeoutProneFreeModel('qwen/qwen3-235b-a22b:free', true)).toBe(true);
  });

  it('does not flag smaller free models or paid models', () => {
    expect(isTimeoutProneFreeModel('meta-llama/llama-3.3-70b-instruct:free', true)).toBe(false);
    expect(isTimeoutProneFreeModel('openai/gpt-oss-120b:free', true)).toBe(false);
    // Same huge model, but paid → not flagged (paid infra, user opted into cost).
    expect(isTimeoutProneFreeModel('nvidia/nemotron-3-ultra-550b-a55b', false)).toBe(false);
  });
});

describe('speedTier (unchanged guard)', () => {
  it('classifies measured latency into fast/ok/slow', () => {
    expect(speedTier(800)).toBe('fast');
    expect(speedTier(9000)).toBe('ok');
    expect(speedTier(60000)).toBe('slow');
  });
});
