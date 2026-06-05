// HMAC request signing for the Studio control plane → Studio Worker hop.
//
// The Cloudflare Studio Worker accepts ONLY requests signed with the shared
// STUDIO_HMAC_SECRET, so browsers can never reach it directly — every launch/stop goes
// through this Railway control plane, which authenticates the user first, then signs.
// The signature scheme matches the Worker's verify (sha256 HMAC of the raw JSON body,
// formatted `sha256=<hex>`), see studio-worker/src/index.ts.

import crypto from 'crypto';

/** Sign a raw request body. Send the result as the `x-studio-signature` header. */
export const signStudioBody = (rawBody: string, secret: string): string =>
  'sha256=' + crypto.createHmac('sha256', secret).update(rawBody).digest('hex');

/** Verify a provided signature against the body (constant-time). */
export const verifyStudioSignature = (rawBody: string, secret: string, provided: string | undefined | null): boolean => {
  if (!secret || !provided) return false;
  const expected = signStudioBody(rawBody, secret);
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
};
