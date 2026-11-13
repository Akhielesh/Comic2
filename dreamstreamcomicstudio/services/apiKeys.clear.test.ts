import { describe, it, expect, beforeEach } from 'vitest';
import { addKey, listKeys, clearAllKeys, deleteKey, hasUsableKey, updateKey, setKeyValidation, getProviderKeyValue } from './apiKeys';

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

  it('removes the legacy fallback when a provider’s last active key is deleted', () => {
    window.localStorage.setItem('dreamstream_openrouter_key', 'legacy-key');
    const [imported] = listKeys();
    expect(imported.key).toBe('legacy-key');
    deleteKey(imported.id);
    expect(hasUsableKey('openrouter')).toBe(false);
    expect(window.localStorage.getItem('dreamstream_openrouter_key')).toBeNull();
  });

  it('rotating a key discards its old verdict and ignores an in-flight check of the previous secret', () => {
    const key = addKey({ provider: 'openai', key: 'old-key' });
    setKeyValidation(key.id, 'valid', 'Valid old key.', 'old-key');
    updateKey(key.id, { key: 'replacement-key' });
    setKeyValidation(key.id, 'valid', 'Late response for old key.', 'old-key');
    expect(listKeys()[0]).toMatchObject({ key: 'replacement-key' });
    expect(listKeys()[0].validation).toBeUndefined();
    expect(listKeys()[0].validatedAt).toBeUndefined();
  });

  it('reads a legacy provider key added after the initial migration consistently', () => {
    listKeys();
    window.localStorage.setItem('dreamstream_nvidia_key', 'nvapi-later');
    expect(hasUsableKey('nvidia')).toBe(true);
    expect(getProviderKeyValue('nvidia')).toBe('nvapi-later');
    addKey({ provider: 'nvidia', key: 'nvapi-active' });
    expect(getProviderKeyValue('nvidia')).toBe('nvapi-active');
  });

  it('a malformed persisted key collection does not break every request', () => {
    window.localStorage.setItem('dreamstream_api_keys_v2', '{"keys":[]}');
    expect(listKeys()).toEqual([]);
    window.localStorage.setItem('dreamstream_api_keys_v2', '[null,{},42]');
    expect(listKeys()).toEqual([]);
  });
});
