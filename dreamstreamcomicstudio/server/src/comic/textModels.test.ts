// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { estimateTextCostUsd, resolveTextRoute, roleModelChain, TEXT_ROLE_DEFAULTS } from './textModels.js';

const OR = { openrouter: { key: 'sk-or-x', byok: false } };
const GEM = { gemini: { key: 'AIza-x', byok: true } };

describe('TEXT_ROLE_DEFAULTS', () => {
  it('pins strong models per role with the agreed timeouts, temperatures and token caps', () => {
    expect(TEXT_ROLE_DEFAULTS.director).toMatchObject({
      models: ['google/gemini-3.8-flash', 'anthropic/claude-sonnet-5.5', 'openai/gpt-6-luna'],
      timeoutMs: 90_000,
      temperature: 0.6,
      maxTokens: 2500
    });
    expect(TEXT_ROLE_DEFAULTS.writer).toMatchObject({
      models: ['anthropic/claude-sonnet-5.5', 'google/gemini-4-argon', 'google/gemini-3.8-flash'],
      timeoutMs: 150_000,
      temperature: 0.8,
      maxTokens: 16_000
    });
    expect(TEXT_ROLE_DEFAULTS.vision).toMatchObject({
      models: ['google/gemini-3.8-flash', 'google/gemini-3.7-flash'],
      timeoutMs: 60_000,
      temperature: 0.1,
      maxTokens: 2500
    });
  });

  it('lets the writer run well past the 55s browser-route text cap', () => {
    expect(TEXT_ROLE_DEFAULTS.writer.timeoutMs).toBeGreaterThan(55_000);
  });
});

describe('resolveTextRoute', () => {
  it('prefers OpenRouter with the full chain (≤3)', () => {
    const route = resolveTextRoute('writer', { ...OR, ...GEM }, {});
    expect(route).toEqual({
      route: 'openrouter',
      model: 'anthropic/claude-sonnet-5.5',
      models: ['anthropic/claude-sonnet-5.5', 'google/gemini-4-argon', 'google/gemini-3.8-flash'],
      key: OR.openrouter
    });
  });

  it('uses Gemini direct with google/ stripped and only Google models', () => {
    const writer = resolveTextRoute('writer', GEM, {});
    expect(writer).toEqual({
      route: 'gemini',
      model: 'gemini-4-argon',
      models: ['gemini-4-argon', 'gemini-3.8-flash'],
      key: GEM.gemini
    });
    const director = resolveTextRoute('director', GEM, {});
    expect(director?.model).toBe('gemini-3.8-flash');
    expect(director?.models).toEqual(['gemini-3.8-flash']);
    const vision = resolveTextRoute('vision', GEM, {});
    expect(vision?.models).toEqual(['gemini-3.8-flash', 'gemini-3.7-flash']);
  });

  it('returns null without any key', () => {
    expect(resolveTextRoute('director', {}, {})).toBeNull();
  });

  it('honours env overrides (comma chain, deduped, capped at 3, bare gemini ids normalized)', () => {
    const env = { COMIC_DIRECTOR_MODEL: 'x-ai/grok-9, gemini-9-flash , x-ai/grok-9, a/b, c/d' };
    expect(roleModelChain('director', env)).toEqual(['x-ai/grok-9', 'google/gemini-9-flash', 'a/b', 'c/d']);
    const route = resolveTextRoute('director', OR, env);
    expect(route?.model).toBe('x-ai/grok-9');
    expect(route?.models).toEqual(['x-ai/grok-9', 'google/gemini-9-flash', 'a/b']);
    // Gemini direct picks the first Google model in the override chain.
    expect(resolveTextRoute('director', GEM, env)?.model).toBe('gemini-9-flash');
  });

  it('falls back to the role default Google models when an override names none', () => {
    const env = { COMIC_WRITER_MODEL: 'anthropic/claude-x' };
    expect(resolveTextRoute('writer', GEM, env)?.model).toBe('gemini-4-argon');
  });

  it('ignores an empty override', () => {
    expect(roleModelChain('vision', { COMIC_VISION_MODEL: '  ' })).toEqual([...TEXT_ROLE_DEFAULTS.vision.models]);
  });

  it('is not influenced by anything request-shaped (no X-Text-Model path)', () => {
    // The signature takes no request; the same keys always give the same route.
    expect(resolveTextRoute('writer', OR, {})).toEqual(resolveTextRoute('writer', OR, {}));
    expect(resolveTextRoute.length).toBeLessThanOrEqual(3);
  });
});

describe('estimateTextCostUsd', () => {
  it('prices known models per million tokens (either namespace)', () => {
    expect(estimateTextCostUsd('google/gemini-3.8-flash', 1_000_000, 0)).toBeCloseTo(0.825, 6);
    expect(estimateTextCostUsd('gemini-3.8-flash', 0, 1_000_000)).toBeCloseTo(4.125, 6);
    expect(estimateTextCostUsd('anthropic/claude-sonnet-5.5', 10_000, 2_000)).toBeCloseTo(0.04, 6);
  });

  it('returns undefined for unknown models', () => {
    expect(estimateTextCostUsd('mystery/model', 10, 10)).toBeUndefined();
  });
});

describe('v5 roles (safety, translator, linguist)', () => {
  it('pins the contract §12.9 chains and settings', () => {
    expect(TEXT_ROLE_DEFAULTS.safety).toMatchObject({ models: ['openai/gpt-6-luna', 'google/gemini-3.8-flash'], temperature: 0, timeoutMs: 20_000 });
    expect(TEXT_ROLE_DEFAULTS.translator).toMatchObject({ models: TEXT_ROLE_DEFAULTS.writer.models, temperature: 0.3, timeoutMs: 120_000 });
    expect(TEXT_ROLE_DEFAULTS.linguist).toMatchObject({ models: ['google/gemini-3.8-flash', 'openai/gpt-6-luna'], temperature: 0.1, timeoutMs: 60_000 });
  });

  it('resolve on OpenRouter and on Gemini direct (google/* only)', () => {
    for (const role of ['safety', 'translator', 'linguist'] as const) {
      const or = resolveTextRoute(role, OR, {});
      expect(or).toMatchObject({ route: 'openrouter', models: TEXT_ROLE_DEFAULTS[role].models });
      const direct = resolveTextRoute(role, GEM, {});
      expect(direct?.route).toBe('gemini');
      expect(direct!.models.every((m) => !m.includes('/'))).toBe(true);
    }
    expect(resolveTextRoute('safety', GEM, {})?.models).toEqual(['gemini-3.8-flash']);
    expect(resolveTextRoute('translator', GEM, {})?.models).toEqual(['gemini-4-argon', 'gemini-3.8-flash']);
  });

  it('the translator follows a writer override unless it has its own', () => {
    expect(roleModelChain('translator', { COMIC_WRITER_MODEL: 'google/gemini-4-argon' })).toEqual(['google/gemini-4-argon']);
    expect(roleModelChain('translator', { COMIC_WRITER_MODEL: 'google/gemini-4-argon', COMIC_TRANSLATOR_MODEL: 'gemini-3.8-flash' })).toEqual(['google/gemini-3.8-flash']);
    expect(roleModelChain('linguist', { COMIC_WRITER_MODEL: 'x/y' })).toEqual([...TEXT_ROLE_DEFAULTS.linguist.models]);
  });
});
