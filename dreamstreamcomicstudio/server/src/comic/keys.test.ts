// @vitest-environment node
import { describe, expect, it } from 'vitest';
import type { Request } from 'express';
import { hasAnyStudioKey, studioKeysFromRequest } from './keys.js';

const reqWith = (apiKeys: Request['apiKeys']) => ({ apiKeys }) as unknown as Request;

describe('studioKeysFromRequest', () => {
  it('reads the generic providerKeys map first', () => {
    const keys = studioKeysFromRequest(
      reqWith({
        openRouterKey: 'legacy-or',
        openRouterByok: false,
        providerKeys: {
          openrouter: { key: 'sk-or-generic', byok: true },
          gemini: { key: 'AIza-generic', byok: false }
        }
      })
    );
    expect(keys).toEqual({
      openrouter: { key: 'sk-or-generic', byok: true },
      gemini: { key: 'AIza-generic', byok: false }
    });
  });

  it('falls back to the named legacy fields', () => {
    const keys = studioKeysFromRequest(
      reqWith({ openRouterKey: ' sk-or-legacy ', openRouterByok: true, geminiKey: 'AIza-legacy', geminiByok: false })
    );
    expect(keys.openrouter).toEqual({ key: 'sk-or-legacy', byok: true });
    expect(keys.gemini).toEqual({ key: 'AIza-legacy', byok: false });
  });

  it('omits providers whose key is empty or null (governance-disabled)', () => {
    const keys = studioKeysFromRequest(
      reqWith({
        openRouterKey: null,
        geminiKey: '   ',
        providerKeys: { openrouter: { key: null, byok: false }, gemini: { key: '', byok: true } }
      })
    );
    expect(keys).toEqual({});
    expect(hasAnyStudioKey(keys)).toBe(false);
  });

  it('returns no keys when the middleware never ran', () => {
    expect(studioKeysFromRequest({} as Request)).toEqual({});
  });

  it('moves an OpenRouter key pasted into the Gemini slot to OpenRouter', () => {
    const keys = studioKeysFromRequest(reqWith({ providerKeys: { gemini: { key: 'sk-or-v1-abc', byok: true } } }));
    expect(keys).toEqual({ openrouter: { key: 'sk-or-v1-abc', byok: true } });
    expect(hasAnyStudioKey(keys)).toBe(true);
  });

  it('drops a misplaced OpenRouter key when a real OpenRouter key exists', () => {
    const keys = studioKeysFromRequest(
      reqWith({
        providerKeys: {
          openrouter: { key: 'sk-or-platform', byok: false },
          gemini: { key: 'sk-or-user', byok: true }
        }
      })
    );
    expect(keys).toEqual({ openrouter: { key: 'sk-or-platform', byok: false } });
  });

  it('coerces a missing byok flag to false', () => {
    const keys = studioKeysFromRequest(reqWith({ geminiKey: 'AIza-x' }));
    expect(keys.gemini).toEqual({ key: 'AIza-x', byok: false });
  });
});
