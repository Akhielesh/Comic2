import { describe, it, expect, beforeEach } from 'vitest';
import { encryptSecret, decryptSecret, isSecureStoreAvailable } from './secureStore.js';

describe('secureStore (server-side BYOK encryption)', () => {
  beforeEach(() => {
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-secret';
  });

  it('round-trips a key', () => {
    const enc = encryptSecret('sk-or-v1-abcdef0123456789');
    expect(enc).not.toBeNull();
    const back = decryptSecret(enc!.ciphertext, enc!.iv);
    expect(back).toBe('sk-or-v1-abcdef0123456789');
  });

  it('uses a fresh iv each time (ciphertext differs for the same input)', () => {
    const a = encryptSecret('same-key');
    const b = encryptSecret('same-key');
    expect(a!.iv).not.toBe(b!.iv);
    expect(a!.ciphertext).not.toBe(b!.ciphertext);
    expect(decryptSecret(a!.ciphertext, a!.iv)).toBe('same-key');
    expect(decryptSecret(b!.ciphertext, b!.iv)).toBe('same-key');
  });

  it('fails closed (returns null) when the server secret is absent', () => {
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    expect(isSecureStoreAvailable()).toBe(false);
    expect(encryptSecret('x')).toBeNull();
    expect(decryptSecret('y', 'z')).toBeNull();
  });

  it('returns null on tampered ciphertext (GCM auth)', () => {
    const enc = encryptSecret('tamper-me');
    const tampered = `${enc!.ciphertext.slice(0, -4)}AAAA`;
    expect(decryptSecret(tampered, enc!.iv)).toBeNull();
  });
});
