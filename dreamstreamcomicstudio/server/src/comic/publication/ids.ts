// Unguessable publication identifiers (contract §9.3/§12.7; addendum: ≥ 96 bits, CSPRNG,
// never sequential, never derived from a project or user id).

import crypto from 'node:crypto';
import { ASSET_KEY_RE, SLUG_LENGTH, SLUG_RE } from '../../../../shared/comic/publication.js';

const BASE62 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

/** Unbiased base62: bytes ≥ 248 (= 4 × 62) are rejected so every symbol is equally likely. */
export const randomBase62 = (length: number): string => {
  let out = '';
  while (out.length < length) {
    for (const byte of crypto.randomBytes(length * 2)) {
      if (byte >= 248) continue;
      out += BASE62[byte % 62];
      if (out.length === length) break;
    }
  }
  return out;
};

/** Public share slug: 17 × base62 ≈ 101 bits (matches SLUG_RE). */
export function newSlug(): string {
  const slug = randomBase62(SLUG_LENGTH);
  if (!SLUG_RE.test(slug)) throw new Error('newSlug: shape mismatch');
  return slug;
}

/** Storage key for pub/<key>/: 22 × base62 ≈ 131 bits (matches ASSET_KEY_RE). */
export function newAssetKey(): string {
  const key = randomBase62(22);
  if (!ASSET_KEY_RE.test(key)) throw new Error('newAssetKey: shape mismatch');
  return key;
}
