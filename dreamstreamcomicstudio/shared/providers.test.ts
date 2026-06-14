import { describe, it, expect } from 'vitest';
import {
  PROVIDER_REGISTRY,
  PROVIDERS_ORDERED,
  TEXT_PROVIDER_IDS,
  getProviderDef,
  isTextProvider,
  providerLabel,
  providerShortLabel
} from './providers';

describe('provider registry', () => {
  it('includes the eight new providers alongside openrouter + nvidia', () => {
    for (const id of ['openrouter', 'nvidia', 'openai', 'anthropic', 'gemini', 'deepseek', 'zai', 'minimax', 'tencent', 'xai']) {
      expect(TEXT_PROVIDER_IDS).toContain(id);
      expect(getProviderDef(id)).toBeDefined();
    }
  });

  it('gives every provider the required fields', () => {
    for (const def of PROVIDERS_ORDERED) {
      expect(def.label).toBeTruthy();
      expect(def.short).toBeTruthy();
      expect(def.header).toMatch(/^X-/);
      expect(def.keyEnv).toBeTruthy();
      expect(def.baseUrl).toMatch(/^https:\/\//);
      expect(def.keysUrl).toMatch(/^https:\/\//);
      expect(['openai', 'anthropic']).toContain(def.api);
    }
  });

  it('uses a unique request header + key env per provider', () => {
    const headers = PROVIDERS_ORDERED.map((d) => d.header.toLowerCase());
    const envs = PROVIDERS_ORDERED.map((d) => d.keyEnv);
    expect(new Set(headers).size).toBe(headers.length);
    expect(new Set(envs).size).toBe(envs.length);
  });

  it('marks only the platform-funded gateways as platformServed', () => {
    const served = PROVIDERS_ORDERED.filter((d) => d.platformServed).map((d) => d.id).sort();
    expect(served).toEqual(['gemini', 'nvidia', 'openrouter']);
  });

  it('resolves labels and the type guard', () => {
    expect(isTextProvider('openai')).toBe(true);
    expect(isTextProvider('pixazo')).toBe(false);
    expect(providerLabel('anthropic')).toBe('Anthropic');
    expect(providerShortLabel('gemini')).toBe('Gemini');
    expect(providerLabel('nope')).toBe('nope');
  });
});
