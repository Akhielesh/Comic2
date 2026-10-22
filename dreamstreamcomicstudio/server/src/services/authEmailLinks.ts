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
//
// Stream Studio's own host (shared/streamHost.ts): with STREAM_HOST_ON, a live-app sign-up
// confirmation (and the sign-in handoff into Stream Studio) points at STREAM_ORIGIN — a constant,
// never taken from the request. Every other link (recovery, magic link, main-app sign-up) stays on
// the main app's origin even when the request came from the Stream Studio host: that's where the
// new-password screen lives. So the full set of origins a link can name is APP_PUBLIC_URL's,
// AUTH_LINK_ORIGINS, and STREAM_ORIGIN for Stream Studio links only.

import { APP_PUBLIC_URL, AUTH_LINK_ORIGINS } from '../config.js';
import {
  STREAM_HOST_ON,
  STREAM_ORIGIN,
  STREAM_RETURN_SCREENS,
  parseStreamScreen,
  type StreamReturnScreen
} from '../../../shared/streamHost.js';

export type AuthApp = 'main' | 'live';

/** Verification types we build links for (GoTrue's `properties.verification_type`). */
export const AUTH_LINK_TYPES = ['signup', 'magiclink', 'recovery', 'invite'] as const;
export type AuthLinkType = (typeof AUTH_LINK_TYPES)[number];

/** Live-app screens a confirmation link may return to (`?after=…`). Shared with the live app. */
export const LIVE_RETURN_SCREENS = STREAM_RETURN_SCREENS;
export type LiveReturnScreen = StreamReturnScreen;

export const isAuthLinkType = (value: unknown): value is AuthLinkType =>
  typeof value === 'string' && (AUTH_LINK_TYPES as readonly string[]).includes(value);

export const parseApp = (value: unknown): AuthApp => (value === 'live' ? 'live' : 'main');

export const parseAfter = (value: unknown): LiveReturnScreen | undefined => parseStreamScreen(value);

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
/** The configured allowlist (APP_PUBLIC_URL's origin first, then AUTH_LINK_ORIGINS). */
export const LINK_ORIGIN_ALLOWLIST: readonly string[] = DEFAULT_ALLOWLIST;
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
  /** STREAM_HOST_ON — a parameter so tests can run both sides of the switch. */
  streamHostOn?: boolean;
}

/** http://localhost:3000 and friends: a developer's own machine (AUTH_LINK_ORIGINS). */
const isLocalOrigin = (origin: string): boolean => /^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(origin);

/**
 * Where Stream Studio lives for a link from `origin`: its own host when the switch is on (a
 * developer on localhost keeps their local /live), else `{origin}/live` exactly as before.
 */
export const streamAppBase = (origin: string, streamHostOn: boolean = STREAM_HOST_ON): string => {
  const base = origin.replace(/\/+$/, '');
  return streamHostOn && !isLocalOrigin(base) ? `${STREAM_ORIGIN}/` : `${base}/live`;
};

/**
 * Build the link for an auth email.
 *   main app (and every recovery / magic link):  {origin}/auth/callback?token_hash=…&type=…
 *   live-app sign-up confirmation:                {origin}/live?after=…&token_hash=…&type=signup
 *     with STREAM_HOST_ON:                        https://stream.dreamstreamstudio.ai/?after=…&token_hash=…&type=signup
 * Throws on an unexpected verification type or a missing token — never emails a dead link.
 */
export const buildAuthLink = ({ app, origin, hashedToken, verificationType, after, streamHostOn = STREAM_HOST_ON }: AuthLinkInput): string => {
  if (!isAuthLinkType(verificationType)) throw new Error(`unsupported verification type "${verificationType}"`);
  if (!hashedToken) throw new Error('missing hashed token');
  const base = origin.replace(/\/+$/, '');
  const token = `token_hash=${encodeURIComponent(hashedToken)}&type=${verificationType}`;
  if (app === 'live' && verificationType === 'signup') {
    const screen = parseAfter(after);
    return `${streamAppBase(base, streamHostOn)}?${screen ? `after=${screen}&` : ''}${token}`;
  }
  return `${base}/auth/callback?${token}`;
};

/** Main-app paths the handoff may land on: the home page, the model library, or one view. */
const MAIN_HANDOFF_VIEWS = new Set([
  'dashboard',
  'chat',
  'settings',
  'gallery',
  'models',
  'learn',
  'how-it-works',
  'privacy',
  'terms'
]);

/**
 * Strict allowlist for the handoff into the main app (`next` on /auth/callback): '/', '/models'
 * or '/?view=<known view>'. Anything else (other origins, '//host', encoded tricks) → null.
 */
export const parseMainHandoffPath = (value: unknown): string | null => {
  if (value === undefined || value === null || value === '') return '/';
  if (typeof value !== 'string' || value.length > 64) return null;
  if (value === '/' || value === '/models') return value;
  const m = /^\/\?view=([a-z][a-z-]{0,23})$/.exec(value);
  return m && MAIN_HANDOFF_VIEWS.has(m[1]) ? value : null;
};

/**
 * Strict allowlist for the handoff into Stream Studio: the app itself or one of its screens,
 * written either way ('/live', '/live#/monitor', '/', '#/settings', a full Stream Studio URL).
 * Returns the screen ('' for the app's home) or null when the path isn't one of those.
 */
export const parseStreamHandoffPath = (value: unknown): StreamReturnScreen | '' | null => {
  if (value === undefined || value === null || value === '') return '';
  if (typeof value !== 'string' || value.length > 96) return null;
  const m = /^(?:https:\/\/stream\.dreamstreamstudio\.ai)?(?:\/(?:live(?:\.html)?\/?)?)?(?:#\/([a-z]+))?$/.exec(value);
  if (!m) return null;
  if (!m[1]) return '';
  return parseStreamScreen(m[1]) ?? null;
};

export interface HandoffLinkInput {
  to: 'live' | 'main';
  /** The main app's origin (pickLinkOrigin) — used for `to: 'main'`. */
  mainOrigin: string;
  hashedToken: string;
  verificationType: string;
  /** to 'live': the screen (parseStreamHandoffPath). */
  after?: StreamReturnScreen | '';
  /** to 'main': the path (parseMainHandoffPath). */
  next?: string;
}

/**
 * The one-time sign-in link that carries a signed-in person from one app to the other.
 *   to 'live':  https://stream.dreamstreamstudio.ai/?token_hash=…&type=magiclink[&after=…]
 *   to 'main':  {main}/auth/callback?token_hash=…&type=magiclink&next=</ or /?view=…>
 * Both origins are fixed (never the request's), so this can't be turned into an open redirect.
 */
export const buildHandoffLink = ({ to, mainOrigin, hashedToken, verificationType, after, next }: HandoffLinkInput): string => {
  if (!isAuthLinkType(verificationType)) throw new Error(`unsupported verification type "${verificationType}"`);
  if (!hashedToken) throw new Error('missing hashed token');
  const token = `token_hash=${encodeURIComponent(hashedToken)}&type=${verificationType}`;
  if (to === 'live') {
    const screen = parseStreamScreen(after);
    return `${STREAM_ORIGIN}/?${token}${screen ? `&after=${screen}` : ''}`;
  }
  // `next` always rides along: it tells the main app this is a handoff, so it goes straight on
  // to the page instead of stopping at "Authentication successful".
  const path = parseMainHandoffPath(next) ?? '/';
  const base = mainOrigin.replace(/\/+$/, '');
  return `${base}/auth/callback?${token}&next=${encodeURIComponent(path)}`;
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
