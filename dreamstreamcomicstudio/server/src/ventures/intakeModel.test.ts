// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

// No network: capture the chat call and pin the auto-picked coder.
const chat = vi.hoisted(() => ({ runChat: vi.fn(async () => ({ text: '{"name":"x"}' })) }));
vi.mock('../ai/chat.js', () => chat);
const router = vi.hoisted(() => ({
  pickCodingModel: vi.fn(async () => 'auto/coder'),
  TEXT_FALLBACK: 'openai/gpt-4o-mini'
}));
vi.mock('../ai/autoRouter.js', () => router);

const { resolveIntakeProvider, resolveIntakeModel, intakeComplete } = await import('./intakeModel.js');
const { VENTURES_INTAKE_TIMEOUT_MS } = await import('../config.js');

beforeEach(() => {
  chat.runChat.mockClear();
  router.pickCodingModel.mockClear();
});

describe('resolveIntakeProvider', () => {
  it('prefers OpenRouter when both keys exist and no source is asked for', () => {
    expect(resolveIntakeProvider({ openRouterKey: 'or', nvidiaKey: 'nv' })).toEqual({ provider: 'openrouter', apiKey: 'or' });
  });

  it('honors an explicit nvidia source when that key exists', () => {
    expect(resolveIntakeProvider({ openRouterKey: 'or', nvidiaKey: 'nv' }, ' NVIDIA ')).toEqual({ provider: 'nvidia', apiKey: 'nv' });
  });

  it('falls back to whichever key exists when the asked-for source has none', () => {
    expect(resolveIntakeProvider({ nvidiaKey: 'nv' }, 'openrouter')).toEqual({ provider: 'nvidia', apiKey: 'nv' });
  });

  it('returns null when the caller has no model key', () => {
    expect(resolveIntakeProvider(undefined)).toBeNull();
    expect(resolveIntakeProvider({ openRouterKey: null, nvidiaKey: '' })).toBeNull();
  });
});

describe('resolveIntakeModel', () => {
  it('uses a pinned model as-is', async () => {
    expect(await resolveIntakeModel('openrouter', '  vendor/model  ')).toBe('vendor/model');
    expect(router.pickCodingModel).not.toHaveBeenCalled();
  });

  it('auto-picks the strongest coder by default', async () => {
    expect(await resolveIntakeModel('openrouter')).toBe('auto/coder');
    expect(router.pickCodingModel).toHaveBeenCalledWith({ costPref: 'quality' });
  });

  it('falls back to the text fallback when auto-pick fails', async () => {
    router.pickCodingModel.mockRejectedValueOnce(new Error('catalog down'));
    expect(await resolveIntakeModel('openrouter', undefined, 'free')).toBe('openai/gpt-4o-mini');
  });
});

describe('intakeComplete', () => {
  it('returns null without a key so the route can answer NO_MODEL_KEY', async () => {
    expect(await intakeComplete({}, {}, 2500)).toBeNull();
  });

  it('calls the model with the intake timeout and the caller key', async () => {
    const complete = await intakeComplete({ openRouterKey: 'or' }, { model: 'vendor/model' }, 2500);
    expect(await complete!('prompt')).toBe('{"name":"x"}');
    expect(chat.runChat).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: 'openrouter',
        apiKey: 'or',
        model: 'vendor/model',
        maxTokens: 2500,
        timeoutMs: VENTURES_INTAKE_TIMEOUT_MS,
        messages: [{ role: 'user', content: 'prompt' }]
      })
    );
  });
});
