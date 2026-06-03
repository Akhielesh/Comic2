import { describe, it, expect, beforeEach } from 'vitest';
import { addKey, listKeys, clearAllKeys } from './apiKeys';

describe('clearAllKeys (sign-out security)', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it('wipes every stored BYOK key + the multi-key store and legacy slots', () => {
    addKey({ provider: 'openrouter', key: 'sk-or-secret', label: 'mine' });
    addKey({ provider: 'nvidia', key: 'nvapi-secret', label: 'nv' });
    window.localStorage.setItem('dreamstream_openrouter_key', 'legacy-or');
    window.localStorage.setItem('dreamstream_api_key', 'legacy-gemini');
    expect(listKeys().length).toBe(2);

    clearAllKeys();

    expect(listKeys().length).toBe(0);
    expect(window.localStorage.getItem('dreamstream_api_keys_v2')).toBeNull();
    expect(window.localStorage.getItem('dreamstream_openrouter_key')).toBeNull();
    expect(window.localStorage.getItem('dreamstream_api_key')).toBeNull();
  });

  it('leaves no secret recoverable from storage after a wipe', () => {
    addKey({ provider: 'openrouter', key: 'sk-or-super-secret-value', label: 'mine' });
    clearAllKeys();
    const dump = JSON.stringify(window.localStorage);
    expect(dump).not.toContain('sk-or-super-secret-value');
  });
});
