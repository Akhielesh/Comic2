// @vitest-environment node
import { describe, expect, it } from 'vitest';
import type { Request } from 'express';
import { hasAnyStudioKey, platformStudioKeys, prefersGeminiDirect, studioKeysFromRequest } from './keys.js';

const reqWith = (apiKeys: Request['apiKeys']) => ({ apiKeys }) as unknown as Request;

// A fake request that also carries an `X-Allowed-Sources` governance header.
const reqWithAllowed = (apiKeys: Request['apiKeys'], allowed: string) =>
  ({ apiKeys, header: (h: string) => (h === 'X-Allowed-Sources' ? allowed : undefined) }) as unknown as Request;

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

  it('promotes a BYOK key in the Gemini slot over a non-BYOK platform OpenRouter key', () => {
    const keys = studioKeysFromRequest(
      reqWith({
        providerKeys: {
          openrouter: { key: 'sk-or-platform', byok: false },
          gemini: { key: 'sk-or-user', byok: true }
        }
      })
    );
    expect(keys).toEqual({ openrouter: { key: 'sk-or-user', byok: true } });
  });

  it('keeps an existing BYOK OpenRouter key over a misplaced sk-or key', () => {
    const keys = studioKeysFromRequest(
      reqWith({
        providerKeys: {
          openrouter: { key: 'sk-or-other', byok: true },
          gemini: { key: 'sk-or-user', byok: true }
        }
      })
    );
    expect(keys).toEqual({ openrouter: { key: 'sk-or-other', byok: true } });
  });

  it('drops a misplaced OpenRouter key entirely when governance disabled OpenRouter', () => {
    const keys = studioKeysFromRequest(
      reqWithAllowed({ providerKeys: { gemini: { key: 'sk-or-user', byok: true } } }, 'gemini')
    );
    expect(keys).toEqual({});
    expect(hasAnyStudioKey(keys)).toBe(false);
  });

  it('still promotes a misplaced OpenRouter key when governance allows OpenRouter', () => {
    const keys = studioKeysFromRequest(
      reqWithAllowed({ providerKeys: { gemini: { key: 'sk-or-user', byok: true } } }, 'gemini,openrouter')
    );
    expect(keys).toEqual({ openrouter: { key: 'sk-or-user', byok: true } });
  });

  it('coerces a missing byok flag to false', () => {
    const keys = studioKeysFromRequest(reqWith({ geminiKey: 'AIza-x' }));
    expect(keys.gemini).toEqual({ key: 'AIza-x', byok: false });
  });
});

describe('prefersGeminiDirect', () => {
  it('is true when a BYOK Gemini key sits beside a non-BYOK (platform) OpenRouter key', () => {
    expect(prefersGeminiDirect({ gemini: { key: 'AIza-user', byok: true }, openrouter: { key: 'sk-or-platform', byok: false } })).toBe(true);
  });

  it('is false when the OpenRouter key is itself BYOK', () => {
    expect(prefersGeminiDirect({ gemini: { key: 'AIza-user', byok: true }, openrouter: { key: 'sk-or-user', byok: true } })).toBe(false);
  });

  it('is false for a non-BYOK (platform) Gemini key', () => {
    expect(prefersGeminiDirect({ gemini: { key: 'AIza-platform', byok: false }, openrouter: { key: 'sk-or-platform', byok: false } })).toBe(false);
  });

  it('is false when there is no Gemini key', () => {
    expect(prefersGeminiDirect({ openrouter: { key: 'sk-or-platform', byok: false } })).toBe(false);
  });
});

describe('platformStudioKeys', () => {
  it('returns the platform keys as non-BYOK, OpenRouter first', () => {
    expect(platformStudioKeys({ openrouter: 'sk-or-platform', gemini: 'AIza-platform' })).toEqual({
      openrouter: { key: 'sk-or-platform', byok: false },
      gemini: { key: 'AIza-platform', byok: false }
    });
  });

  it('never uses an OpenRouter key as a Gemini key, and is null without keys', () => {
    expect(platformStudioKeys({ gemini: 'sk-or-misfiled' })).toBeNull();
    expect(platformStudioKeys({ openrouter: '  ', gemini: '' })).toBeNull();
    expect(prefersGeminiDirect(platformStudioKeys({ openrouter: 'sk-or-a', gemini: 'AIza-b' })!)).toBe(false);
  });
});
