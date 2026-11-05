// Double opt-in confirmation tokens (newsletter / register interest).
//
// A token is only good if THIS server issued it for THIS address: it carries its issue time and a
// random nonce, both bound to the address by an HMAC under EMAIL_HMAC_SECRET (domain-separated
// from the unsubscribe token). So:
//   * a row written straight into waitlist_signups with a token of someone's choosing (the anon
//     INSERT grant, before server/sql/register_interest_2026_11.sql is applied) can never confirm,
//     and is never re-sent: registerInterest only reuses a token that verifies;
//   * the link's lifetime runs from its ORIGINAL issue time, so re-sending the same link (which
//     keeps links already in the inbox working) never extends it.
//
// Format: 64 lowercase hex chars = issued-at (8, unix seconds) + nonce (24) + MAC (32, truncated
// HMAC-SHA256). Older 48-char random tokens no longer verify (none were ever mailed in production:
// email_log held no newsletter-confirm send on 2026-11-05).

import crypto from 'crypto';
import { EMAIL_HMAC_SECRET, NEWSLETTER_CONFIRM_TTL_HOURS } from '../config.js';

const DOMAIN = 'newsletter-confirm.v1';
const TOKEN_RE = /^[0-9a-f]{64}$/;

/** False when there is no signing secret: then no confirmation can be issued at all. */
export const confirmTokensAvailable = (): boolean => EMAIL_HMAC_SECRET.length > 0;

const mac = (email: string, issuedHex: string, nonceHex: string): string =>
  crypto.createHmac('sha256', EMAIL_HMAC_SECRET).update(`${DOMAIN}:${email}:${issuedHex}:${nonceHex}`).digest('hex').slice(0, 32);

/** A fresh token for `email` (already normalized). Throws without a signing secret. */
export const issueConfirmToken = (email: string, now = Date.now()): string => {
  if (!confirmTokensAvailable()) throw new Error('EMAIL_HMAC_SECRET is not set');
  const issuedHex = Math.floor(now / 1000).toString(16).padStart(8, '0');
  const nonceHex = crypto.randomBytes(12).toString('hex');
  return `${issuedHex}${nonceHex}${mac(email, issuedHex, nonceHex)}`;
};

/** When the token was issued (ms), or null if this server did not issue it for `email`. */
export const confirmTokenIssuedAt = (email: string, token: unknown): number | null => {
  if (!confirmTokensAvailable() || typeof token !== 'string' || !TOKEN_RE.test(token)) return null;
  const issuedHex = token.slice(0, 8);
  const nonceHex = token.slice(8, 32);
  const expected = Buffer.from(mac(email, issuedHex, nonceHex));
  const given = Buffer.from(token.slice(32));
  if (expected.length !== given.length || !crypto.timingSafeEqual(expected, given)) return null;
  return parseInt(issuedHex, 16) * 1000;
};

/** Past its lifetime (NEWSLETTER_CONFIRM_TTL_HOURS from issue; 0 = never expires). */
export const confirmTokenExpired = (issuedAtMs: number, now = Date.now(), marginMs = 0): boolean =>
  NEWSLETTER_CONFIRM_TTL_HOURS > 0 && now - issuedAtMs > NEWSLETTER_CONFIRM_TTL_HOURS * 3_600_000 - marginMs;
