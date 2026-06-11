// Server-side secret encryption for the BYOK key mirror (user_api_keys).
//
// The previous scheme encrypted keys in the BROWSER with a hardcoded secret shipped
// in the bundle (services/crypto.ts), so anyone with the frontend could decrypt every
// row in a DB dump. This encrypts with AES-256-GCM under a key derived from the
// Supabase service-role secret — which only the server holds — so the stored
// ciphertext is useless without the server's secret.
//
// Note: the client already transmits BYOK keys to the server in request headers for
// every generation, so routing the *storage* write through the server adds no new
// exposure; it only removes the decryptable-by-anyone liability.

import crypto from 'node:crypto';

const getMasterKey = (): Buffer | null => {
  const secret = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!secret) return null;
  // Derive a stable 32-byte key from the server secret (domain-separated).
  return crypto.createHash('sha256').update(`byok-wrap-v1:${secret}`).digest();
};

export const isSecureStoreAvailable = (): boolean => getMasterKey() !== null;

export const encryptSecret = (plaintext: string): { ciphertext: string; iv: string } | null => {
  const key = getMasterKey();
  if (!key) return null;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  // ciphertext||authTag, base64 (same layout WebCrypto produces) so the column shape
  // is unchanged.
  return { ciphertext: Buffer.concat([enc, tag]).toString('base64'), iv: iv.toString('base64') };
};

export const decryptSecret = (ciphertextB64: string, ivB64: string): string | null => {
  const key = getMasterKey();
  if (!key) return null;
  try {
    const raw = Buffer.from(ciphertextB64, 'base64');
    const iv = Buffer.from(ivB64, 'base64');
    if (raw.length < 17) return null;
    const tag = raw.subarray(raw.length - 16);
    const enc = raw.subarray(0, raw.length - 16);
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf8');
  } catch {
    return null;
  }
};

// ---- Legacy client-scheme decryption (migration only) --------------------------
//
// Before the settings snapshot moved server-side, services/crypto.ts encrypted it in
// the BROWSER with this hardcoded app secret (PBKDF2 → AES-256-GCM). The secret
// shipped in the public bundle, so this provided no real protection — but existing
// `user_settings` rows are still in that format. This decryptor lets the server read
// (and then re-encrypt) those rows once; it must never be used for new writes.

const LEGACY_APP_SECRET = 'dreamstream-comic-studio-secret-key-v1';
const LEGACY_SALT = 'dreamstream-salt';

const getLegacyKey = (): Buffer =>
  crypto.pbkdf2Sync(LEGACY_APP_SECRET, LEGACY_SALT, 100000, 32, 'sha256');

export const decryptLegacyClientBlob = (ciphertextB64: string, ivB64: string): string | null => {
  try {
    const raw = Buffer.from(ciphertextB64, 'base64');
    const iv = Buffer.from(ivB64, 'base64');
    if (raw.length < 17) return null;
    // WebCrypto AES-GCM emits ciphertext||authTag — the same layout encryptSecret uses.
    const tag = raw.subarray(raw.length - 16);
    const enc = raw.subarray(0, raw.length - 16);
    const decipher = crypto.createDecipheriv('aes-256-gcm', getLegacyKey(), iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf8');
  } catch {
    return null;
  }
};
