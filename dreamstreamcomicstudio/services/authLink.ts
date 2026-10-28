// Sign-in links: read the tokens a URL carries and complete them explicitly.
//
// supabase-js is created with `detectSessionInUrl: false` (services/supabase.ts): it never
// adopts a session from the address bar on its own. The two pages that receive our links —
// the main app's /auth/callback (and the Site URL fallback '/') and Stream Studio's
// consumeAuthReturn — read the tokens here, decide whether to sign in (a fresh sign-in intent
// from services/pendingSignIn, or the visitor's "Continue"), and complete them with the
// matching auth call. Every token shape is handled, and the URL is cleaned afterwards.
//
// Dependency-light on purpose: Stream Studio imports it too.

export type LinkTokens =
  /** One-time link from our backend / the auth hook: verifyOtp. */
  | { kind: 'token_hash'; tokenHash: string; type: string | null }
  /** PKCE code: exchangeCodeForSession (needs the code verifier stored in this browser). */
  | { kind: 'code'; code: string }
  /** Implicit-flow tokens in the fragment (older links): setSession. */
  | { kind: 'session'; accessToken: string; refreshToken: string; type: string | null }
  /** The auth server sent an error back, or the link is unusable. */
  | { kind: 'error'; code: string | null; description: string | null };

/**
 * The query or fragment parameters a sign-in link may carry (removed once handled). `sn` is the
 * nonce that ties a link to the sign-in this browser started (services/pendingSignIn).
 */
export const AUTH_LINK_PARAMS = ['code', 'type', 'token_hash', 'error', 'error_code', 'error_description', 'flow', 'sn'] as const;

/**
 * True when this page is inside a frame. Sign-in links never sign in there: another site could
 * frame a link and disguise the "Continue" button (clickjacking), so the visitor is told to open
 * the link in its own tab instead.
 */
export const inFrame = (): boolean => {
  if (typeof window === 'undefined') return false;
  try {
    return window.top !== window.self;
  } catch {
    return true; // a cross-origin parent that hides itself: still a frame
  }
};

/** Shown instead of signing in when a sign-in link loads inside a frame. */
export const FRAMED_LINK_MESSAGE = 'For your security, sign-in links only work in their own tab. Open the link again in a new tab.';

const fragmentParams = (url: URL): URLSearchParams => new URLSearchParams(url.hash.replace(/^#/, ''));

/**
 * The sign-in tokens a URL carries, or null when it carries none. Errors win (an expired link
 * also says so), then a PKCE code, then a token hash, then fragment tokens. An access token
 * without its refresh token can't make a session: reported as an error.
 */
export function readLinkTokens(url: URL): LinkTokens | null {
  const hash = fragmentParams(url);
  const query = url.searchParams;
  const pick = (key: string): string | null => query.get(key) || hash.get(key) || null;

  const description = pick('error_description');
  const errorCode = hash.get('error_code') || hash.get('error') || (description ? query.get('error_code') || query.get('error') : null);
  if (description || errorCode) return { kind: 'error', code: errorCode || null, description: description || null };

  const code = query.get('code');
  if (code) return { kind: 'code', code };

  const tokenHash = pick('token_hash');
  if (tokenHash) return { kind: 'token_hash', tokenHash, type: pick('type') };

  const accessToken = hash.get('access_token');
  if (accessToken) {
    const refreshToken = hash.get('refresh_token');
    if (!refreshToken) return { kind: 'error', code: null, description: null };
    return { kind: 'session', accessToken, refreshToken, type: hash.get('type') };
  }
  return null;
}

/** The slice of supabase.auth this module needs (kept narrow so tests can hand in a fake). */
export interface LinkAuthApi {
  verifyOtp(params: { token_hash: string; type: never }): Promise<{ error: unknown }>;
  exchangeCodeForSession(code: string): Promise<{ error: unknown }>;
  setSession(session: { access_token: string; refresh_token: string }): Promise<{ error: unknown }>;
}

/**
 * What the auth server says about a link's access token before anything is signed in:
 * its account's email when it answers, and `dead` when it refuses the token (401/403 — the
 * token expired or its session is gone). Signing in with a dead token would fail AND make
 * supabase-js drop the session this browser already has, so a dead link is never used.
 */
export interface LinkAccount {
  email: string | null;
  dead: boolean;
}

/** Who an access token belongs to, asked of the auth server (services/supabase lookupAccessTokenEmail). */
export type TokenEmailLookup = (accessToken: string) => Promise<LinkAccount>;

const UNKNOWN_ACCOUNT: LinkAccount = { email: null, dead: false };

export interface LinkFailure {
  message?: string;
  code?: string;
  status?: number;
}

const asFailure = (error: unknown): LinkFailure | null => {
  if (!error) return null;
  if (typeof error === 'object') {
    const e = error as { message?: unknown; code?: unknown; status?: unknown };
    return {
      message: typeof e.message === 'string' ? e.message : undefined,
      code: typeof e.code === 'string' ? e.code : undefined,
      status: typeof e.status === 'number' ? e.status : undefined,
    };
  }
  return { message: String(error) };
};

/**
 * Sign in with the link's tokens. `otpType` is the verifyOtp type the caller mapped from the
 * link (each app accepts its own set). Never throws; `{ error: null }` means signed in.
 */
export async function completeLinkSignIn(auth: LinkAuthApi, tokens: LinkTokens, otpType: string): Promise<{ error: LinkFailure | null }> {
  try {
    switch (tokens.kind) {
      case 'token_hash':
        return { error: asFailure((await auth.verifyOtp({ token_hash: tokens.tokenHash, type: otpType as never })).error) };
      case 'code':
        return { error: asFailure((await auth.exchangeCodeForSession(tokens.code)).error) };
      case 'session':
        return {
          error: asFailure((await auth.setSession({ access_token: tokens.accessToken, refresh_token: tokens.refreshToken })).error),
        };
      default:
        // Never the link's own error_description: anyone can write it into a URL.
        return { error: { code: tokens.code || undefined } };
    }
  } catch (err) {
    return { error: asFailure(err) ?? { message: undefined } };
  }
}

/**
 * The account a link would sign in to, when that can be known without signing in: fragment
 * tokens carry an access token, so the auth server is asked who it belongs to — through a lookup
 * that never touches this browser's stored session. (Not supabase-js's getUser(jwt): for a token
 * whose session is gone it signs the CURRENT session out.) Never decoded locally either: an
 * unsigned token could claim any address. A token hash or a code can't be read without using it
 * up — unknown. A lookup that fails (offline, slow) is unknown too, never "dead".
 */
export async function peekLinkAccount(lookup: TokenEmailLookup | null | undefined, tokens: LinkTokens): Promise<LinkAccount> {
  if (tokens.kind !== 'session' || !lookup) return UNKNOWN_ACCOUNT;
  try {
    const found = await lookup(tokens.accessToken);
    const email = typeof found?.email === 'string' && found.email ? found.email : null;
    return { email, dead: found?.dead === true };
  } catch {
    return UNKNOWN_ACCOUNT;
  }
}

/* ------------------------------------------------------------------ main app */

export type AuthCallbackFlow = 'magiclink' | 'recovery' | 'signup' | 'unknown';
type MainOtpType = 'magiclink' | 'recovery' | 'signup' | 'email_change';

export interface MainAuthLink {
  /** Null on /auth/callback with nothing usable: an honest "invalid link". */
  tokens: LinkTokens | null;
  flow: AuthCallbackFlow;
  otpType: MainOtpType;
  /** A sign-in handoff says where to go next (checked with safeNext before use). */
  next: string | null;
}

const normalisePath = (pathname: string): string => pathname.replace(/\/+$/, '') || '/';

/**
 * The main app acts on sign-in tokens only where our links land: /auth/callback, and the
 * Supabase Site URL fallback '/' (only when it actually carries tokens). Every other page — a
 * share link, the reader, /models — ignores tokens in its URL. Null = not a sign-in link.
 */
export function readMainAuthLink(url: URL): MainAuthLink | null {
  const path = normalisePath(url.pathname);
  if (path !== '/auth/callback' && path !== '/') return null;
  const tokens = readLinkTokens(url);
  if (!tokens && path === '/') return null;
  const hash = fragmentParams(url);
  const rawType = url.searchParams.get('type') || hash.get('type') || 'magiclink';
  const flow: AuthCallbackFlow = rawType === 'recovery' || rawType === 'signup' || rawType === 'magiclink' ? rawType : 'unknown';
  const otpType: MainOtpType = rawType === 'recovery' || rawType === 'signup' || rawType === 'email_change' ? rawType : 'magiclink';
  return { tokens, flow, otpType, next: url.searchParams.get('next') };
}

/** The address with every sign-in parameter, the fragment and the callback path removed. */
export function cleanMainAuthUrl(href: string): string {
  const url = new URL(href);
  for (const key of [...AUTH_LINK_PARAMS, 'next']) url.searchParams.delete(key);
  url.hash = '';
  if (normalisePath(url.pathname) === '/auth/callback') url.pathname = '/';
  return `${url.pathname}${url.search}`;
}

/** A link that has expired or was already used (its error code, or a token the server refused). */
export const EXPIRED_LINK_MESSAGE = 'This link has expired or was already used. Request a new one and try again.';

/**
 * An honest message for a link that came back with an error (or without usable tokens). Only
 * the error CODE is read: `error_description` is free text anyone can put in a URL, and showing
 * it on our own page would let a crafted link say whatever it likes ("re-enter your key at…").
 */
export function linkErrorMessage(tokens: LinkTokens | null): string {
  if (!tokens) return 'Invalid callback link. Please request a new one.';
  if (tokens.kind !== 'error') return 'Failed to verify link.';
  if (tokens.code && /expired|access_denied/i.test(tokens.code)) return EXPIRED_LINK_MESSAGE;
  return 'This link is invalid or expired. Request a new one and try again.';
}
