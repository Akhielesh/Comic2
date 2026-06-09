// Cloudflare Turnstile server-side verification. Dormant unless TURNSTILE_SECRET_KEY is set:
// when unconfigured, verifyTurnstile() returns true so no endpoint is gated and nothing breaks.
// When configured, a valid, unexpired token is REQUIRED.

import { TURNSTILE_SECRET_KEY } from '../config.js';

const SITEVERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

export const turnstileConfigured = (): boolean => Boolean(TURNSTILE_SECRET_KEY);

/** Verify a Turnstile token against Cloudflare. Returns true when not configured (no-op gate). */
export const verifyTurnstile = async (token: string | undefined, ip?: string): Promise<boolean> => {
  if (!turnstileConfigured()) return true;
  if (!token) return false;
  try {
    const body = new URLSearchParams({ secret: TURNSTILE_SECRET_KEY, response: token });
    if (ip) body.set('remoteip', ip);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    try {
      const res = await fetch(SITEVERIFY_URL, { method: 'POST', body, signal: controller.signal });
      const data = (await res.json().catch(() => null)) as { success?: boolean } | null;
      return Boolean(data?.success);
    } finally {
      clearTimeout(timer);
    }
  } catch {
    // Network failure verifying — fail CLOSED when configured (deny), since the gate is opt-in.
    return false;
  }
};
