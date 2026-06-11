import crypto from 'node:crypto';
import { describe, it, expect, beforeEach } from 'vitest';
import { decryptLegacyClientBlob, encryptSecret, decryptSecret, isSecureStoreAvailable } from './secureStore.js';

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

describe('decryptLegacyClientBlob (migration of in-browser-encrypted user_settings)', () => {
  // Reproduce exactly what services/crypto.ts produced in the browser: PBKDF2 over
  // the (public) app secret + static salt, AES-256-GCM, ciphertext||tag base64.
  const legacyEncrypt = (plaintext: string): { ciphertext: string; iv: string } => {
    const key = crypto.pbkdf2Sync('dreamstream-comic-studio-secret-key-v1', 'dreamstream-salt', 100000, 32, 'sha256');
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    return {
      ciphertext: Buffer.concat([enc, cipher.getAuthTag()]).toString('base64'),
      iv: iv.toString('base64')
    };
  };

  it('decrypts a blob produced by the legacy client scheme', () => {
    const snapshot = JSON.stringify({ version: 1, keys: [], settings: { defaultTextModel: 'x' } });
    const enc = legacyEncrypt(snapshot);
    expect(decryptLegacyClientBlob(enc.ciphertext, enc.iv)).toBe(snapshot);
  });

  it('returns null for server-scheme blobs (so the two schemes are unambiguous)', () => {
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-secret';
    const enc = encryptSecret('{"version":2}');
    expect(decryptLegacyClientBlob(enc!.ciphertext, enc!.iv)).toBeNull();
    expect(decryptSecret(enc!.ciphertext, enc!.iv)).toBe('{"version":2}');
  });

  it('returns null on garbage input', () => {
    expect(decryptLegacyClientBlob('not-base64!!!', 'zz')).toBeNull();
    expect(decryptLegacyClientBlob('', '')).toBeNull();
  });
});
