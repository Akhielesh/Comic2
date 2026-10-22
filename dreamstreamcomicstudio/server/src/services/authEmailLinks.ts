// Links for the auth emails the backend sends itself (routes/authEmail.ts). Pure — no I/O —
// so every rule is unit-tested in authEmailLinks.test.ts.
//
// Where a link may point is the security-critical part: whoever opens a recovery or magic
// link is signed in as that account. So the origin comes from a STRICT allowlist —
// APP_PUBLIC_URL's origin plus the exact origins in AUTH_LINK_ORIGINS — and the request's
// Origin header is only used when it matches one of those exactly. Never isAllowedOrigin():
// its `*.dreamstreamstudio.ai` wildcard includes user-controlled Studio preview hosts.
//
// Links carry GoTrue's `hashed_token` (verified client-side with verifyOtp({ token_hash, type })),
// never the raw `email_otp` and never Supabase's own action_link.

import { APP_PUBLIC_URL, AUTH_LINK_ORIGINS } from '../config.js';

export type AuthApp = 'main' | 'live';

/** Verification types we build links for (GoTrue's `properties.verification_type`). */
export const AUTH_LINK_TYPES = ['signup', 'magiclink', 'recovery', 'invite'] as const;
export type AuthLinkType = (typeof AUTH_LINK_TYPES)[number];

/** Live-app screens a confirmation link may return to (`/live?after=…`). */
export const LIVE_RETURN_SCREENS = ['monitor', 'settings', 'create'] as const;
export type LiveReturnScreen = (typeof LIVE_RETURN_SCREENS)[number];

export const isAuthLinkType = (value: unknown): value is AuthLinkType =>
  typeof value === 'string' && (AUTH_LINK_TYPES as readonly string[]).includes(value);

export const parseApp = (value: unknown): AuthApp => (value === 'live' ? 'live' : 'main');

export const parseAfter = (value: unknown): LiveReturnScreen | undefined =>
  typeof value === 'string' && (LIVE_RETURN_SCREENS as readonly string[]).includes(value)
    ? (value as LiveReturnScreen)
    : undefined;

/** `https://Example.com/path` → `https://example.com`; null for anything that isn't http(s). */
const originOf = (raw: string): string | null => {
  if (!raw || raw.includes('*')) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    return url.origin;
  } catch {
    return null;
  }
};

/** The allowlist: APP_PUBLIC_URL's origin first (the default), then the extra exact origins. */
export const buildLinkOriginAllowlist = (appPublicUrl: string, extraOrigins: readonly string[] = []): string[] => {
  const all = [originOf(appPublicUrl), ...extraOrigins.map(originOf)].filter((o): o is string => Boolean(o));
  return [...new Set(all)];
};

const DEFAULT_ALLOWLIST = buildLinkOriginAllowlist(APP_PUBLIC_URL, AUTH_LINK_ORIGINS);
// APP_PUBLIC_URL is always set (config default), but never let a typo there produce a
// relative link.
const FALLBACK_ORIGIN = DEFAULT_ALLOWLIST[0] || 'https://dreamstreamstudio.ai';

/**
 * The origin to put in an emailed link: the request's Origin when it EXACTLY matches the
 * allowlist (so a sign-up from localhost lands back on localhost), otherwise APP_PUBLIC_URL's.
 */
export const pickLinkOrigin = (
  requestOrigin: string | null | undefined,
  allowlist: readonly string[] = DEFAULT_ALLOWLIST
): string => {
  const fallback = allowlist[0] || FALLBACK_ORIGIN;
  if (!requestOrigin) return fallback;
  return allowlist.includes(requestOrigin) ? requestOrigin : fallback;
};

export interface AuthLinkInput {
  app: AuthApp;
  /** Already allowlisted (pickLinkOrigin). */
  origin: string;
  /** GoTrue `properties.hashed_token`. */
  hashedToken: string;
  /** GoTrue `properties.verification_type` — what the token really is, not what we asked for. */
  verificationType: string;
  /** Live app only: the screen to return to after confirming. */
  after?: string | null;
}

/**
 * Build the link for an auth email.
 *   main app (and every recovery / magic link):  {origin}/auth/callback?token_hash=…&type=…
 *   live-app sign-up confirmation:                {origin}/live?after=…&token_hash=…&type=signup
 * Throws on an unexpected verification type or a missing token — never emails a dead link.
 */
export const buildAuthLink = ({ app, origin, hashedToken, verificationType, after }: AuthLinkInput): string => {
  if (!isAuthLinkType(verificationType)) throw new Error(`unsupported verification type "${verificationType}"`);
  if (!hashedToken) throw new Error('missing hashed token');
  const base = origin.replace(/\/+$/, '');
  const token = `token_hash=${encodeURIComponent(hashedToken)}&type=${verificationType}`;
  if (app === 'live' && verificationType === 'signup') {
    const screen = parseAfter(after);
    return `${base}/live?${screen ? `after=${screen}&` : ''}${token}`;
  }
  return `${base}/auth/callback?${token}`;
};

/** True when the link lands in the live app (→ Stream Studio branding). */
export const linksToLiveApp = (app: AuthApp, verificationType: string): boolean =>
  app === 'live' && verificationType === 'signup';

/** `ada@example.com` → `a***@example.com` — enough to correlate logs without storing addresses. */
export const maskEmail = (email: string): string => {
  const [local, domain] = String(email || '').split('@');
  if (!domain) return '***';
  return `${local.slice(0, 1)}***@${domain}`;
};
