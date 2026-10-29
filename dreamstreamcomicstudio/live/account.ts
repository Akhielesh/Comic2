/**
 * Stream Studio accounts — sign in / create right inside the live app.
 *
 * The welcome code is never checked on the client: it's sent to a Supabase
 * RPC that compares it against a bcrypt hash (rate limited per IP + per
 * user + globally). A correct code mints a one-time ticket that rides the
 * sign-up and is redeemed into a membership on first sign-in — so even an
 * account created straight against the auth API gets no Stream Studio access
 * without the code. Pre-launch accounts are grandfathered server-side.
 */

import { useEffect, useState } from 'react';
import { EMAIL_SERVICE_DOWN, requestAuthEmail } from '@/services/authEmail';
import { completeLinkSignIn, inFrame, peekLinkAccount, readLinkTokens, type LinkAccount, type LinkFailure, type LinkTokens } from '@/services/authLink';
import { clearSignInIntents, consumeSignInIntent } from '@/services/pendingSignIn';
import { claimDevice } from './accountPurge';
import type { AccountNameResult } from '@/services/accountName';
import { STREAM_RETURN_SCREENS } from '@/shared/streamHost';
import { WORKER_BASE } from './config';
import { LIVE_APP_PATH } from './host';

/**
 * `needs_mfa`: signed in with the password, but the account has two-step sign-in on and this
 * session hasn't given the code yet (aal1). Nothing member-only works until it has: the StepUp
 * sheet (views/account/StepUp.tsx) asks for the code. Only the SERVER decides this (live_me's
 * `mfa_required`) — never this device on its own: a session signed in before two-step sign-in was
 * switched on keeps watching (a nursery camera must not go dark because a parent turned it on
 * from another room), and nothing is enforced here that the server doesn't enforce.
 */
export type AccountStatus = 'loading' | 'signed_out' | 'needs_code' | 'needs_mfa' | 'member' | 'offline';

export interface LiveAccount {
  status: AccountStatus;
  userId?: string;
  email?: string;
  name?: string;
  verifiedVia?: string;
  suggestedName?: string;
  /** Two-step sign-in is on for this account (the server's answer). Unknown when absent. */
  mfa?: boolean;
  /** This session's assurance level, as the server read it ('aal2' once the code was given). */
  aal?: 'aal1' | 'aal2';
  /**
   * Two-step sign-in is on, but this session was signed in before it was switched on: it keeps
   * watching (a nursery camera stays on air) and asks for the code only before admin actions.
   */
  mfaGrace?: boolean;
  /**
   * Signed out because this session was ended somewhere else — "Sign out everywhere", "Not you?
   * Secure my account", a password reset. The app says so once instead of silently showing
   * "Sign in".
   */
  ended?: 'revoked';
}

export interface Person {
  user_id: string;
  display_name: string;
}

const TICKET_KEY = 'ds-live-welcome-ticket';

type Supa = typeof import('@/services/supabase')['supabase'];

let clientPromise: Promise<Supa | null> | null = null;
export function supa(): Promise<Supa | null> {
  clientPromise ??= import('@/services/supabase').then((m) => m.supabase).catch(() => null);
  return clientPromise;
}

/* --------------------------------------------------------------- store */

let current: LiveAccount = { status: 'loading' };
const listeners = new Set<(a: LiveAccount) => void>();
let authSubscribed = false;

function set(a: LiveAccount): void {
  current = a;
  for (const l of listeners) l(a);
}

export const getAccount = (): LiveAccount => current;

/** Resolves once the account has loaded (or after `maxMs`), so anything that announces the
 *  user's name — the studio's room socket — doesn't go out as a placeholder. */
export function accountSettled(maxMs = 3000): Promise<LiveAccount> {
  if (current.status !== 'loading') return Promise.resolve(current);
  return new Promise((resolve) => {
    const done = (a: LiveAccount) => {
      if (a.status === 'loading') return;
      listeners.delete(done);
      window.clearTimeout(timer);
      resolve(a);
    };
    const timer = window.setTimeout(() => {
      listeners.delete(done);
      resolve(current);
    }, maxMs);
    listeners.add(done);
    void refreshAccount();
  });
}

/** React hook — every view shares one account state. */
export function useAccount(): LiveAccount {
  const [a, setA] = useState(current);
  useEffect(() => {
    listeners.add(setA);
    setA(current);
    if (current.status === 'loading') void refreshAccount();
    return () => {
      listeners.delete(setA);
    };
  }, []);
  return a;
}

/* ------------------------------------------------------------ errors */

export function friendlyError(code: string | undefined, fallback = 'Something went wrong — try again.'): string {
  switch (code) {
    case 'invalid_code':
      return 'That welcome code isn’t right. Codes are case-sensitive — check capital letters.';
    case 'too_many_attempts':
      return 'Too many attempts. For security, wait 15 minutes and try again.';
    case 'welcome_code_required':
      return 'New accounts need a welcome code to use Stream Studio.';
    case 'not_signed_in':
      return 'Sign in first.';
    case 'not_member':
      return 'Unlock Stream Studio with your welcome code first.';
    case 'setup':
      return 'Accounts are being set up on the server — please try again in a few minutes.';
    default:
      return fallback;
  }
}

/** Supabase "function not found" ⇒ the migration hasn't been applied yet. */
const isMissingRpc = (e: { code?: string; message?: string } | null | undefined) =>
  !!e && (e.code === 'PGRST202' || /could not find the function/i.test(e.message || ''));

async function rpc<T>(fn: string, args: Record<string, unknown> = {}): Promise<{ data: T | null; error: string | null }> {
  const sb = await supa();
  if (!sb) return { data: null, error: 'offline' };
  const { data, error } = await sb.rpc(fn, args);
  if (error) return { data: null, error: isMissingRpc(error) ? 'setup' : error.message || 'error' };
  return { data: data as T, error: null };
}

/* ------------------------------------------------------------ session */

export async function accessToken(): Promise<string | null> {
  const sb = await supa();
  if (!sb) return null;
  try {
    const { data } = await sb.auth.getSession();
    const s = data.session;
    if (!s) return null;
    // Refresh a token that's about to expire before handing it to the worker.
    if (s.expires_at && s.expires_at * 1000 - Date.now() < 60_000) {
      const r = await sb.auth.refreshSession();
      return r.data.session?.access_token ?? null;
    }
    return s.access_token;
  } catch {
    return null;
  }
}

/* ------------------------------------------------------ socket re-auth */

/**
 * The window event every open room socket listens to (monitor, call line, admin — WS-6's
 * live/monitor/client.ts): `detail` is the new access token, which the socket sends as
 * `{t:'reauth', token}` when the room lists the `reauth` capability. Fired on a sign-in, on every
 * token refresh and when the two-step code upgrades the session to aal2 — so a socket never
 * outlives its token and an MFA step-up reaches sockets that are already open.
 */
export const TOKEN_EVENT = 'ds:token';
let announced: string | null = null;

export function announceToken(token: string | null | undefined): void {
  if (!token || token === announced) return;
  announced = token;
  try {
    window.dispatchEvent(new CustomEvent(TOKEN_EVENT, { detail: token }));
  } catch { /* no window (tests, workers) */ }
}

export async function refreshAccount(): Promise<LiveAccount> {
  const sb = await supa();
  if (!sb) {
    set({ status: 'offline' });
    return current;
  }
  if (!authSubscribed) {
    authSubscribed = true;
    sb.auth.onAuthStateChange((event, session) => {
      if ((event === 'SIGNED_IN' || event === 'TOKEN_REFRESHED' || event === 'MFA_CHALLENGE_VERIFIED') && session) {
        announceToken(session.access_token);
      }
      if (event === 'SIGNED_OUT') {
        announced = null;
        // Signed out in another tab (e.g. the main app). Without "Remember me" this
        // tab may hold its own copy of the session — drop it so both agree.
        void (async () => {
          try {
            if ((await sb.auth.getSession()).data.session) await sb.auth.signOut({ scope: 'local' });
          } catch { /* already gone */ }
          void refreshAccount();
        })();
        return;
      }
      // MFA_CHALLENGE_VERIFIED: the code was given (maybe in another tab) — leave needs_mfa.
      // TOKEN_REFRESHED: pick up a change made elsewhere (two-step sign-in turned off, the
      // session ended) without waiting for a reload. A transient failure never downgrades a
      // member (refreshAccount keeps them), so this can't take a running monitor down.
      if (event === 'SIGNED_IN' || event === 'USER_UPDATED' || event === 'MFA_CHALLENGE_VERIFIED' || event === 'TOKEN_REFRESHED') void refreshAccount();
    });
  }
  let session;
  try {
    const got = await sb.auth.getSession();
    session = got.data.session;
    // The stored session needed a refresh and the auth server couldn't be reached (a reload while
    // the internet is down, the home Wi-Fi still up): Supabase keeps the session for a retryable
    // failure, so this is no answer — never "signed out", and nothing of the account's is wiped.
    // (A refresh token the server REJECTED comes back without a session and another error: that one
    // is signed out.)
    if (!session && unreachable(got.error)) return stayIn();
  } catch {
    return stayIn();
  }
  if (!session) {
    // Nobody signed in: the last account's name, events and nursery data go too.
    if (claimDevice(null)) notifyPurged();
    // Two checks can overlap (every screen asks on mount): one that finds the session already
    // ended elsewhere signs it out, and the other then finds none — it keeps "why", so the
    // "you were signed out" notice isn't lost.
    set(current.status === 'signed_out' && current.ended ? { status: 'signed_out', ended: current.ended } : { status: 'signed_out' });
    return current;
  }
  if (claimDevice(session.user.id)) notifyPurged();
  const email = session.user.email ?? undefined;
  const me = await rpc<{
    member?: boolean;
    needs_code?: boolean;
    suggested_name?: string;
    error?: string;
    mfa?: boolean;
    aal?: string;
    mfa_grace?: boolean;
    profile?: { display_name?: string; verified_via?: string };
  }>('live_me');
  if (me.data?.error === 'session_revoked') {
    // Ended elsewhere ("Sign out everywhere", "Not you?", a password reset): this device's copy
    // of the session is dead weight — drop it and everything the account left here.
    const { signOut } = await import('./sync');
    await signOut('local');
    announced = null;
    set({ status: 'signed_out', ended: 'revoked' });
    return current;
  }
  // Two-step sign-in is on and this session owes the code: the server's word only. (Supabase's
  // own "next level aal2" is not enough: it counts an authenticator nobody switched on here, and
  // would shut a camera that the server still lets watch.)
  if (me.data?.error === 'mfa_required') {
    set({ status: 'needs_mfa', userId: session.user.id, email, mfa: true, aal: 'aal1' });
    return current;
  }
  if (me.error || !me.data) return noAnswer(session.user.id, email);
  const mfa = typeof me.data.mfa === 'boolean' ? me.data.mfa : undefined;
  const aal = me.data.aal === 'aal2' ? 'aal2' : me.data.aal === 'aal1' ? 'aal1' : undefined;
  const grace = me.data.mfa_grace === true;
  if (me.data.member) {
    set({
      status: 'member',
      userId: session.user.id,
      email,
      name: me.data.profile?.display_name,
      verifiedVia: me.data.profile?.verified_via,
      mfa,
      ...(aal ? { aal } : {}),
      ...(grace ? { mfaGrace: true } : {}),
    });
    return current;
  }
  // Not a member yet: redeem a pending sign-up ticket, or join as a
  // grandfathered (pre-launch) account — no code prompt needed for either.
  const meta = (session.user.user_metadata ?? {}) as { live_ticket?: string; display_name?: string };
  const ticket = readTicket() || meta.live_ticket || null;
  if (ticket || !me.data.needs_code) {
    const joined = await rpc<{ ok: boolean; profile?: { display_name?: string; verified_via?: string } }>('live_join', {
      p_ticket: ticket,
      p_display_name: meta.display_name ?? me.data.suggested_name ?? null,
    });
    if (joined.data?.ok) {
      clearTicket();
      // The ticket is single-use and spent — don't leave it in the profile.
      if (meta.live_ticket) void sb.auth.updateUser({ data: { live_ticket: null } }).catch(() => undefined);
      set({ status: 'member', userId: session.user.id, email, name: joined.data.profile?.display_name, verifiedVia: joined.data.profile?.verified_via });
      return current;
    }
    // The join itself failed (no internet, a 5xx): no answer — a pre-launch account or a sign-up
    // with its ticket is never told it needs a code it doesn't need (the ticket is kept; the next
    // check joins). The server's own "no" ({ ok: false }) is the definite answer below.
    if (joined.error || !joined.data) return noAnswer(session.user.id, email);
  }
  set({ status: 'needs_code', userId: session.user.id, email, suggestedName: me.data.suggested_name });
  return current;
}

/** supabase-js's "couldn't reach the auth server" (network down, 502/503/504) — not an answer. */
const unreachable = (e: unknown): boolean => !!e && typeof e === 'object' && (e as { name?: unknown }).name === 'AuthRetryableFetchError';

/** A definite answer the server gave this page: kept through a blip, like a member's. */
const DEFINITE: ReadonlySet<AccountStatus> = new Set(['member', 'needs_code', 'needs_mfa']);

/**
 * The session couldn't be read just now. A definite answer stands — a member stays a member (a
 * running nursery camera or monitor is never signed out of its screen, or gated out of Stream
 * Studio, by a blip), and an account still owing the welcome code or the two-step code isn't let
 * into the studio by one either. Anyone else is 'offline' (let through, as before), never
 * "signed out".
 */
function stayIn(): LiveAccount {
  if (DEFINITE.has(current.status)) return current;
  set({ status: 'offline', ...(current.userId ? { userId: current.userId, email: current.email } : {}) });
  return current;
}

/**
 * The session is fine but the server couldn't answer for it (live_me or the automatic join failed:
 * a token refresh while the Wi-Fi drops, a tab waking up). The same rule as stayIn, for this
 * account only: a different account signing in gets no answer of the last one's.
 */
function noAnswer(userId: string, email: string | undefined): LiveAccount {
  if (DEFINITE.has(current.status) && current.userId === userId) return current;
  set({ status: 'offline', userId, email });
  return current;
}

/** Views holding a copy of the purged settings re-read them; the last account's alerts go too. */
function notifyPurged(): void {
  try {
    window.dispatchEvent(new Event('ds-live-account-purged'));
  } catch { /* no window */ }
  void import('./monitor/push').then((m) => m.closeAlertNotifications()).catch(() => undefined);
}

function readTicket(): string | null {
  try {
    return localStorage.getItem(TICKET_KEY);
  } catch {
    return null;
  }
}

function clearTicket(): void {
  try {
    localStorage.removeItem(TICKET_KEY);
  } catch { /* storage unavailable */ }
}

/* ------------------------------------------------- email link return */

/** Screens an email or handoff link may bring you back to (`?after=…`) — shared with the server. */
const RETURN_SCREENS = new Set<string>(STREAM_RETURN_SCREENS);

/**
 * Where confirmation links land. No fragment on purpose: Supabase appends the
 * session as `#access_token=…`, and a second `#` (as in `#/account`) would
 * hide it from the client. The screen to return to rides in `?after=`. The app's path is '/' on
 * Stream Studio's own host and '/live' on the main one (live/host.ts).
 */
export function confirmRedirectUrl(): string {
  const screen = location.hash.replace(/^#\/?/, '').split(/[/?]/)[0];
  const after = RETURN_SCREENS.has(screen) ? `?after=${screen}` : '';
  return `${location.origin}${LIVE_APP_PATH}${after}`;
}

/**
 * `handoff`: a one-time sign-in link from DreamStream (type=magiclink), not an email confirmation.
 * `framed`: the link loaded inside another page's frame — it never signs in there (clickjacking).
 */
export type AuthReturnResult =
  | { confirmed: true; handoff?: boolean }
  | { error: 'expired' | 'failed' | 'framed'; message?: string; handoff?: boolean };

/**
 * A sign-in link this browser didn't ask for: nothing has happened yet. The app asks
 * "Finish signing in?" — `proceed` signs in (and cleans the URL), `dismiss` drops the link and
 * leaves whoever is signed in exactly as they were.
 */
export interface AuthReturnConfirm {
  confirm: true;
  /**
   * The account the link signs in to, when that can be known before signing in (older
   * #access_token links: the auth server is asked). Resolves later — the question never waits
   * for it — and to null when it can't be known.
   */
  email: Promise<string | null>;
  handoff?: boolean;
  proceed: () => Promise<AuthReturnResult>;
  dismiss: () => void;
}

/** This page load came back from a sign-in link (`?after=…` or link tokens): the app holds its tour. */
export function hasAuthReturn(href: string = location.href): boolean {
  try {
    const url = new URL(href);
    return !!url.searchParams.get('after') || !!readLinkTokens(url);
  } catch {
    return false;
  }
}

export type AuthReturn = AuthReturnResult | AuthReturnConfirm;

type LinkType = 'signup' | 'invite' | 'magiclink' | 'recovery' | 'email';
const LINK_TYPES: readonly string[] = ['signup', 'invite', 'magiclink', 'recovery', 'email'];

/** Sign in with the link's tokens and describe the outcome the way the app shows it. */
async function finishLink(tokens: LinkTokens, type: LinkType, handoff: boolean, account: () => Promise<LinkAccount>): Promise<AuthReturnResult> {
  const tag = handoff ? { handoff } : {};
  // A fragment token the auth server already refuses can't sign in, and setSession would drop
  // the session this browser has on the way: report it as expired without trying.
  if (tokens.kind === 'session' && (await account()).dead) return { error: 'expired', ...tag };
  const sb = await supa();
  // On success the auth call stores the session and fires SIGNED_IN, which refreshes the account.
  const failure: LinkFailure | null = sb
    ? (await completeLinkSignIn(sb.auth, tokens, type)).error
    : { message: '' };
  if (!failure) return { confirmed: true, ...tag };
  // A fragment-token link that produced no session reads as "didn't work" (as before).
  if (tokens.kind === 'session') return { error: 'failed', ...tag };
  if (failure.code === 'otp_expired' || failure.status === 403 || /expired|invalid/i.test(failure.message || '')) {
    // Already used (opening it twice) or too old.
    return { error: 'expired', ...tag };
  }
  return { error: 'failed', ...(failure.message ? { message: failure.message } : {}), ...tag };
}

/**
 * Back from an email link: verify it, explain a dead link, and land on the screen the user
 * started from. Link shapes:
 *   ?after=…&token_hash=…&type=signup    — sent by our backend; verified here.
 *   ?token_hash=…&type=magiclink&after=… — the sign-in handoff from DreamStream
 *                                          (POST /api/auth/handoff); verified here too.
 *   #access_token=…&refresh_token=…      — older links (Supabase / the auth hook).
 *   ?code=…                              — a PKCE code (needs this browser's code verifier).
 * SECURITY: supabase-js no longer adopts sessions from the URL (detectSessionInUrl: false), and
 * a link signs this browser in automatically only when it carries the nonce of a sign-in started
 * in this browser (`&sn=…`, services/pendingSignIn). Any other link returns
 * `{ confirm: true, proceed, dismiss }` so the app can ask first — an attacker's link for their
 * own account never signs a visitor in silently. Inside a frame no link signs in at all. The
 * token never stays in the address bar or history once the choice is made.
 * Returns null on an ordinary page load.
 */
export async function consumeAuthReturn(): Promise<AuthReturn | null> {
  const url = new URL(location.href);
  const after = url.searchParams.get('after');
  const tokens = readLinkTokens(url);
  if (!after && !tokens) return null;

  const clean = () => {
    const now = new URL(location.href);
    for (const key of ['after', 'token_hash', 'type', 'code', 'error', 'error_code', 'error_description', 'sn']) now.searchParams.delete(key);
    const screen = after && RETURN_SCREENS.has(after) ? `#/${after}` : '';
    history.replaceState(null, '', `${now.pathname}${now.search}${screen}`);
  };

  if (!tokens) {
    clean();
    return null;
  }
  if (tokens.kind === 'error') {
    clean();
    // The sign-in this link belonged to is over: no record stays behind for a later link to use.
    clearSignInIntents();
    // Only the error code: error_description is free text anyone can put in a link.
    return tokens.code && /expired|access_denied/i.test(tokens.code) ? { error: 'expired' } : { error: 'failed' };
  }
  // Framed by another page: never sign in here, not even after a click (clickjacking).
  if (inFrame()) {
    clean();
    return { error: 'framed' };
  }

  // Our links say type=signup (confirmations) or magiclink (the handoff); accept the other
  // one-time-link types verifyOtp knows.
  const rawType = tokens.kind === 'token_hash' ? tokens.type || 'signup' : 'signup';
  const handoff = tokens.kind === 'token_hash' && rawType === 'magiclink';
  const type: LinkType = LINK_TYPES.includes(rawType) ? (rawType as LinkType) : 'signup';
  // Who the link's access token belongs to (fragment tokens only) — asked once, lazily.
  let accountLookup: Promise<LinkAccount> | null = null;
  const account = (): Promise<LinkAccount> =>
    (accountLookup ??= import('@/services/supabase')
      .then((m) => peekLinkAccount(m.lookupAccessTokenEmail, tokens))
      .catch(() => ({ email: null, dead: false })));
  const run = async (): Promise<AuthReturnResult> => {
    const result = await finishLink(tokens, type, handoff, account);
    clean();
    if ('error' in result) clearSignInIntents(); // a link that failed is over
    return result;
  };

  // This browser asked for exactly this sign-in (the link carries its nonce): finish it now.
  if (consumeSignInIntent(url)) return run();

  // Nobody here asked for it: the app asks first — at once; the email fills in when known.
  let settled = false;
  return {
    confirm: true,
    email: tokens.kind === 'session' ? account().then((found) => found.email) : Promise.resolve(null),
    ...(handoff ? { handoff } : {}),
    proceed: () => {
      settled = true;
      return run();
    },
    dismiss: () => {
      if (settled) return;
      settled = true;
      clean();
      clearSignInIntents(); // "Not now": whatever was pending is dropped with the link
    },
  };
}

/* ---------------------------------------------------------- actions */

export async function signIn(email: string, password: string): Promise<{ ok: boolean; error?: string; unconfirmed?: boolean }> {
  const sb = await supa();
  if (!sb) return { ok: false, error: 'Sign-in is unavailable right now.' };
  const { error } = await sb.auth.signInWithPassword({ email: email.trim().toLowerCase(), password });
  if (error) {
    if (/email not confirmed/i.test(error.message) || error.code === 'email_not_confirmed') {
      return { ok: false, unconfirmed: true, error: 'Confirm your email first — check your inbox for the link we sent.' };
    }
    const msg = /invalid login/i.test(error.message) ? 'Email or password is incorrect.' : error.message;
    return { ok: false, error: msg };
  }
  // Signed in with a password: nothing here waits for an emailed link any more, so no link
  // opened later may skip the "Finish signing in?" step on the strength of an old request.
  clearSignInIntents();
  await refreshAccount();
  return { ok: true };
}

/**
 * Send the sign-up confirmation email again — through our backend (one a minute per
 * address), always from dreamstreamstudio.ai.
 */
export async function resendConfirmation(email: string, captchaToken?: string): Promise<{ ok: boolean; error?: string }> {
  const address = email.trim().toLowerCase();
  const after = new URL(confirmRedirectUrl()).searchParams.get('after') || undefined;
  const viaApi = await requestAuthEmail('resend', { email: address, app: 'live', after, captchaToken: captchaToken || undefined });
  if (viaApi.status === 'ok') return { ok: true };
  if (viaApi.status === 'error') {
    // The one-a-minute rule gets the short version; the hourly/daily caps and the per-network
    // limiter explain themselves (their wait can be much longer than a minute).
    if (viaApi.code === 'too_soon') {
      return { ok: false, error: 'Just sent one — wait a minute before asking again.' };
    }
    return { ok: false, error: viaApi.message };
  }

  // Never Supabase's own mailer: every auth email comes from dreamstreamstudio.ai.
  return { ok: false, error: EMAIL_SERVICE_DOWN };
}

/** The link lands on the main app's /auth/callback — that's where the new-password screen lives. */
export async function sendPasswordReset(email: string, captchaToken?: string): Promise<{ ok: boolean; error?: string }> {
  const address = email.trim().toLowerCase();
  const viaApi = await requestAuthEmail('recovery', { email: address, app: 'main', captchaToken: captchaToken || undefined });
  if (viaApi.status === 'ok') return { ok: true };
  if (viaApi.status === 'error') return { ok: false, error: viaApi.message };

  return { ok: false, error: EMAIL_SERVICE_DOWN };
}

/** Verify the code server-side BEFORE creating anything. */
export async function checkWelcomeCode(code: string): Promise<{ ok: boolean; ticket?: string; error?: string }> {
  const r = await rpc<{ ok: boolean; ticket?: string; error?: string }>('live_welcome_check', { p_code: code });
  if (r.error) return { ok: false, error: friendlyError(r.error === 'setup' ? 'setup' : undefined) };
  if (!r.data?.ok || !r.data.ticket) return { ok: false, error: friendlyError(r.data?.error) };
  return { ok: true, ticket: r.data.ticket };
}

const USERNAME_SAFE = (first: string) =>
  (first.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]/g, '').slice(0, 12) || 'member').padEnd(3, '0');

export interface CreateInput {
  name: string;
  email: string;
  password: string;
  dob: string;
  code: string;
}

export async function createAccount(
  input: CreateInput
): Promise<{ ok: boolean; error?: string; confirmEmail?: boolean; note?: string }> {
  const name = input.name.trim().replace(/\s+/g, ' ').slice(0, 40);
  if (!name) return { ok: false, error: 'Add your name — it’s how family and viewers will find you.' };
  if (input.password.length < 8) return { ok: false, error: 'Use a password with at least 8 characters.' };

  const checked = await checkWelcomeCode(input.code);
  if (!checked.ok || !checked.ticket) return { ok: false, error: checked.error };
  try {
    localStorage.setItem(TICKET_KEY, checked.ticket);
  } catch { /* storage unavailable — user_metadata still carries it */ }

  const [first, ...rest] = name.split(' ');
  const email = input.email.trim().toLowerCase();
  const after = new URL(confirmRedirectUrl()).searchParams.get('after') || undefined;
  // Our backend creates the account and mails the confirmation from dreamstreamstudio.ai;
  // the welcome ticket stands in for a captcha there.
  for (let attempt = 0; attempt < 3; attempt++) {
    const username = `${USERNAME_SAFE(first)}_${Math.floor(1000 + Math.random() * 9000)}`;
    const metadata = {
      username,
      first_name: first,
      last_name: rest.join(' ') || null,
      dob: input.dob,
      display_name: name,
      terms_accepted: true,
      marketing_consent: false,
      email_pref_product_updates: true,
      email_pref_marketing: false,
      live_ticket: checked.ticket,
      signup_source: 'stream_studio',
    };
    const viaApi = await requestAuthEmail('signup', { app: 'live', after, email, password: input.password, data: metadata });
    if (viaApi.status === 'ok') return { ok: true, confirmEmail: true };
    if (viaApi.status === 'unreachable') return { ok: false, error: EMAIL_SERVICE_DOWN };
    // Profile trigger collision (username taken) — retry with a new suffix.
    if (viaApi.code === 'database_error') {
      if (attempt < 2) continue;
      return { ok: false, error: 'Could not create the account — try again.' };
    }
    if (viaApi.code === 'email_exists') return { ok: false, error: 'An account with this email already exists — sign in instead.' };
    if (viaApi.code === 'send_failed') {
      // The account exists; only the email failed — the "check your email" screen offers a resend.
      return { ok: true, confirmEmail: true, note: 'Your account is ready, but the email didn’t go out — tap “Resend email”.' };
    }
    if (viaApi.code === 'captcha_required') {
      return { ok: false, error: 'We couldn’t verify your welcome code — check it and try again.' };
    }
    return { ok: false, error: viaApi.message };
  }
  return { ok: false, error: 'Could not create the account — try again.' };
}

/** Signed in, not a member yet: unlock with the code. */
export async function redeemWelcomeCode(code: string, displayName?: string): Promise<{ ok: boolean; error?: string }> {
  const r = await rpc<{ ok: boolean; error?: string }>('live_join', { p_code: code, p_display_name: displayName || null });
  if (r.error) return { ok: false, error: friendlyError(r.error === 'setup' ? 'setup' : undefined) };
  if (!r.data?.ok) return { ok: false, error: friendlyError(r.data?.error) };
  await refreshAccount();
  return { ok: true };
}

/** One name for the whole account (DreamStream, Stream Studio, the monitor and calls):
 *  saved through the server, which also renames the Stream Studio profile when there is
 *  one — so it works before the welcome code too. (The live_update_profile RPC stays for
 *  tabs still running an older build.) */
export async function updateDisplayName(name: string): Promise<{ ok: boolean; error?: string; name?: string }> {
  let r: AccountNameResult;
  try {
    const { updateAccountName } = await import('@/services/accountName');
    r = await updateAccountName(name);
  } catch {
    return { ok: false, error: 'Couldn’t save your name right now — try again.' };
  }
  if (!r.ok) return { ok: false, error: r.error };
  await refreshAccount();
  return { ok: true, name: r.name };
}

export async function searchPeople(q: string): Promise<Person[]> {
  if (q.trim().length < 2) return [];
  const r = await rpc<{ ok: boolean; people?: Person[] }>('live_search_people', { p_query: q.trim() });
  return r.data?.ok ? (r.data.people ?? []) : [];
}

/* ------------------------------------------------------------ sign out */

/**
 * Sign out of THIS device only: other devices stay signed in. Everything the account left here
 * goes with it — name, events, nursery data, and this device's alert subscriptions (including an
 * old one from dreamstreamstudio.ai/live, so a signed-out device gets no baby alerts at all).
 */
export async function signOutThisDevice(): Promise<void> {
  const { signOut } = await import('./sync');
  await signOut('local');
  announced = null;
  set({ status: 'signed_out' });
}

export interface SignOutEverywhereResult {
  /**
   * The live Worker closed every open monitor, call line and admin socket of the account
   * (POST /api/me/kick answered `{ok: true}`). False: the route isn't there yet or couldn't
   * reach every room — open sockets then close at their next re-check (exp + 120 s once the
   * rooms enforce it), and the copy says only that.
   */
  kicked: boolean;
  /** Supabase ended every session (each device must sign in again). False: offline — only this device signed out. */
  global: boolean;
}

/**
 * The live Worker's "close everything this account has open" (ADR 0006 §1, WS-7 kick.ts):
 * POST /api/me/kick with the caller's bearer token. Contract: 2xx JSON `{ok: true}` only when
 * every nursery room and the call line confirmed; anything else counts as not kicked.
 */
export async function kickMySockets(token: string, timeoutMs = 8000): Promise<boolean> {
  const ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timer = ctl ? setTimeout(() => ctl.abort(), timeoutMs) : undefined;
  try {
    const res = await fetch(`${WORKER_BASE}/api/me/kick`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: '{}',
      signal: ctl?.signal,
    });
    if (!res.ok) return false;
    const body = (await res.json().catch(() => null)) as { ok?: unknown } | null;
    return body?.ok === true;
  } catch {
    return false;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * The real "Sign out everywhere": close every socket the account has open (monitors, call
 * lines), end every session in Supabase, then wipe this device. The kick goes first — it needs
 * a token that's still good — and the sign-out happens whatever the kick says.
 */
export async function signOutEverywhere(): Promise<SignOutEverywhereResult> {
  const token = await accessToken();
  const kicked = token ? await kickMySockets(token) : false;
  const { signOut } = await import('./sync');
  const { ok } = await signOut('global');
  announced = null;
  set({ status: 'signed_out' });
  return { kicked, global: ok };
}

/** What to tell someone after "Sign out everywhere" — never more than happened. */
export function signOutEverywhereMessage(r: SignOutEverywhereResult): string {
  if (!r.global) return 'Couldn’t reach the server, so only this device is signed out. Try “Sign out everywhere” again when you’re back online.';
  if (r.kicked) return 'Signed out everywhere — open monitors and calls on your other devices were disconnected.';
  return 'Signed out everywhere. Every device has to sign in again; a monitor or call already open elsewhere stays connected until it next reconnects.';
}

/**
 * The failure half of an `{ok: true, …} | {ok: false, …}` answer. (A type guard rather than
 * `if (!r.ok)`: this project compiles without strictNullChecks, where a boolean `ok` doesn't
 * narrow the union.)
 */
export const failed = <T extends { ok: boolean }>(r: T): r is Extract<T, { ok: false }> => r.ok === false;

/* ------------------------------------------------- two-step sign-in (TOTP) */

export interface TotpFactor {
  id: string;
  name: string;
  createdAt: string;
}

export interface MfaState {
  /** Could ask at all (signed in, online). */
  ok: boolean;
  /** Two-step sign-in is on (an authenticator switched on here): new sign-ins need the code. */
  on: boolean;
  factors: TotpFactor[];
  /** This session's level: 'aal2' once the code was given. */
  aal: 'aal1' | 'aal2' | null;
  /**
   * The server can run two-step sign-in (live_security_v2.sql applied). Until it can, it can't be
   * turned on: an authenticator without recovery codes and a way to undo it would risk a lockout.
   */
  available: boolean;
  /** Recovery codes not used yet (null: unknown). */
  codesLeft: number | null;
  /** This session was signed in before it was switched on: it watches without the code. */
  grace: boolean;
  /** Why it couldn't be read (when !ok). */
  error?: SecurityListError;
}

export type MfaErrorCode =
  | 'invalid_code'
  | 'expired'
  | 'disabled'
  | 'step_up'
  | 'too_many'
  | 'rate_limited'
  | 'offline'
  | 'reauth'
  | 'wrong_password'
  | 'recovery_invalid'
  | 'recovery_locked'
  | 'signed_out'
  | 'failed';

export interface MfaFailure {
  ok: false;
  code: MfaErrorCode;
  error: string;
}

const MFA_COPY: Record<MfaErrorCode, string> = {
  invalid_code: 'That code didn’t match. Type the newest code from your authenticator app — and check your phone sets its clock automatically.',
  expired: 'That code timed out. Type the newest one from your authenticator app.',
  disabled: 'Two-step sign-in isn’t switched on for DreamStream accounts yet. Nothing has changed on your account.',
  step_up: 'Confirm it’s you with a code from your authenticator app first.',
  too_many: 'You’ve added as many authenticators as an account can have. Remove one first.',
  rate_limited: 'Too many tries. Wait a minute, then try the newest code.',
  offline: 'Can’t reach the server — check your connection and try again.',
  reauth: 'For your safety, turning on two-step sign-in needs your password typed again first. Nothing has changed on your account — start again.',
  wrong_password: 'That password isn’t right. Nothing has changed on your account.',
  recovery_invalid: 'That recovery code didn’t work. Check it against the list you saved — each code works once.',
  recovery_locked: 'Too many tries. For your safety, wait 15 minutes before trying another recovery code.',
  signed_out: 'This sign-in has ended. Sign in again, then try once more.',
  failed: 'That didn’t work — try again in a moment.',
};

const failure = (code: MfaErrorCode): MfaFailure => ({ ok: false, code, error: MFA_COPY[code] });

/** A Supabase auth error → what went wrong, in words a parent can act on. */
export function mfaFailure(e: { code?: string; status?: number; message?: string } | null | undefined): MfaFailure {
  const code = String(e?.code ?? '');
  const msg = String(e?.message ?? '');
  let kind: MfaErrorCode = 'failed';
  if (code === 'mfa_verification_failed' || /invalid (totp )?code|verification failed/i.test(msg)) kind = 'invalid_code';
  else if (code === 'mfa_challenge_expired' || /expired/i.test(msg)) kind = 'expired';
  else if (/not_enabled$/.test(code) || /mfa.*(disabled|not enabled)/i.test(msg)) kind = 'disabled';
  else if (code === 'insufficient_aal' || /aal2/i.test(msg)) kind = 'step_up';
  else if (code === 'too_many_enrolled_mfa_factors') kind = 'too_many';
  else if (e?.status === 429 || /rate limit/i.test(code + msg)) kind = 'rate_limited';
  else if (/fetch|network|offline/i.test(msg)) kind = 'offline';
  return failure(kind);
}

const sixDigits = (code: string) => code.replace(/\D/g, '').slice(0, 6);

type FactorRow = { id: string; friendly_name?: string; factor_type: string; status: string; created_at: string };

async function factorRows(sb: Supa): Promise<FactorRow[] | null> {
  try {
    const { data, error } = await sb.auth.mfa.listFactors();
    if (error || !data) return null;
    return (data.all ?? []) as FactorRow[];
  } catch {
    return null;
  }
}

type MfaStatusRow = {
  ok?: boolean;
  error?: string;
  on?: boolean;
  aal?: string;
  grace?: boolean;
  codes_left?: number;
  factors?: { id: string; name?: string; created_at: string }[];
};

/**
 * Two-step sign-in for this account, as the SERVER counts it (live_mfa_status): on or off, its
 * authenticators, recovery codes left, and this session's level. Also tidies away authenticators
 * that were never switched on here. Before the server can run it: `available: false`.
 */
export async function mfaStatus(): Promise<MfaState> {
  const off = (over: Partial<MfaState> = {}): MfaState => ({ ok: false, on: false, factors: [], aal: null, available: false, codesLeft: null, grace: false, ...over });
  const r = await rpc<MfaStatusRow>('live_mfa_status');
  if (r.error === 'setup') return off({ ok: true });
  if (r.error || !r.data) return off({ error: listError(r.error) });
  if (r.data.ok === false) return off({ error: listError(r.data.error) });
  const factors = (r.data.factors ?? []).map((f) => ({ id: f.id, name: f.name || 'Authenticator app', createdAt: f.created_at }));
  return {
    ok: true,
    on: r.data.on === true,
    factors,
    aal: r.data.aal === 'aal2' ? 'aal2' : r.data.aal === 'aal1' ? 'aal1' : null,
    available: true,
    codesLeft: typeof r.data.codes_left === 'number' ? r.data.codes_left : null,
    grace: r.data.grace === true,
  };
}

/**
 * True when an admin action needs the code first: two-step sign-in is on and this session is
 * aal1 (including a session old enough to keep watching without it). Asked of the server each
 * time — never a copy of the session cached on this device, which can be stale after a change
 * on another device. Before the server enforces two-step sign-in, nothing is asked here either.
 */
export async function stepUpNeeded(): Promise<boolean> {
  const me = await rpc<{ error?: string; mfa?: boolean; aal?: string }>('live_me');
  if (me.error || !me.data) return false; // can't tell: the server still refuses, and the caller shows that
  if (me.data.error === 'mfa_required') return true;
  return me.data.mfa === true && me.data.aal !== 'aal2';
}

/* ------------------------------------------------------------ re-authentication */

const PRIMARY_AMR = (m: unknown): boolean =>
  typeof m === 'string' && !['totp', 'mfa/totp', 'mfa/phone', 'mfa/webauthn', 'mfa/recovery_code', 'token_refresh', 'anonymous'].includes(m);

/** Seconds since this session last proved who it is with a password or an email link (Infinity: never / unknown). */
export function secondsSinceSignIn(accessTokenJwt: string | null | undefined, nowMs = Date.now()): number {
  try {
    const part = String(accessTokenJwt ?? '').split('.')[1];
    if (!part) return Infinity;
    const json = JSON.parse(atob(part.replace(/-/g, '+').replace(/_/g, '/'))) as { amr?: unknown };
    const amr = Array.isArray(json.amr) ? json.amr : [];
    let newest = -Infinity;
    for (const e of amr) {
      const m = e && typeof e === 'object' ? (e as { method?: unknown; timestamp?: unknown }) : null;
      if (m && PRIMARY_AMR(m.method) && typeof m.timestamp === 'number') newest = Math.max(newest, m.timestamp);
    }
    return newest === -Infinity ? Infinity : Math.max(0, nowMs / 1000 - newest);
  } catch {
    return Infinity;
  }
}

/** The server allows 30 minutes; ask again past 10 so a slow set-up still finishes inside it. */
export const REAUTH_FRESH_S = 10 * 60;

/** Has this session signed in (password or email link) recently enough to turn on two-step sign-in? */
export async function signInIsFresh(): Promise<boolean> {
  const sb = await supa();
  if (!sb) return false;
  try {
    const token = (await sb.auth.getSession()).data.session?.access_token;
    return secondsSinceSignIn(token) <= REAUTH_FRESH_S;
  } catch {
    return false;
  }
}

/**
 * Prove it's you before switching two-step sign-in on: the password, typed again. Supabase can
 * only check a password by signing in, so this signs this device in afresh (you may get a
 * "new sign-in" email for it — that's this) and ends the session it replaces, so it doesn't
 * linger in your devices list. Someone holding only a stolen session can't get past this.
 */
export async function confirmPassword(password: string): Promise<{ ok: true } | MfaFailure> {
  const sb = await supa();
  if (!sb) return failure('offline');
  let old: { access_token: string; user: { email?: string | null } } | null = null;
  try {
    old = (await sb.auth.getSession()).data.session;
  } catch { /* handled below */ }
  const email = old?.user.email?.trim().toLowerCase();
  if (!old || !email) return failure('signed_out');
  try {
    const { error } = await sb.auth.signInWithPassword({ email, password });
    if (error) {
      if (/invalid login|invalid credentials/i.test(error.message) || error.code === 'invalid_credentials') return failure('wrong_password');
      return mfaFailure(error);
    }
  } catch (e) {
    return mfaFailure({ message: e instanceof Error ? e.message : 'offline' });
  }
  try {
    await sb.auth.admin.signOut(old.access_token, 'local');
  } catch { /* it expires on its own */ }
  return { ok: true };
}

/* ------------------------------------------------------------ recovery codes */

/**
 * Lost the phone: a recovery code (from the list shown when two-step sign-in was turned on)
 * gets you back in. Supabase can't take a recovery code as the second step, so it switches
 * two-step sign-in OFF on the account (server: live_mfa_recover) — the app then asks you to set
 * it up again on the new phone. Works from a session that still owes the code.
 */
export async function recoverWithCode(code: string): Promise<{ ok: true; removed: number } | MfaFailure> {
  const clean = code.replace(/[^A-Za-z0-9]/g, '');
  if (clean.length !== 12) return { ok: false, code: 'recovery_invalid', error: 'A recovery code has 12 letters and numbers, like abcd-efgh-jkmn.' };
  const r = await rpc<{ ok?: boolean; error?: string; removed?: number }>('live_mfa_recover', { p_code: code });
  if (r.error === 'setup') return failure('disabled');
  if (r.error === 'offline' || (!r.data && /fetch|network/i.test(r.error ?? ''))) return failure('offline');
  if (r.error || !r.data) return failure('failed');
  if (r.data.ok !== true) {
    const e = r.data.error;
    return failure(e === 'invalid_code' ? 'recovery_invalid' : e === 'too_many' ? 'recovery_locked' : e === 'session_revoked' ? 'signed_out' : 'failed');
  }
  const sb = await supa();
  // The token still says "aal1, code owed" — get one that matches the account now.
  await sb?.auth.refreshSession().catch(() => undefined);
  await refreshAccount();
  return { ok: true, removed: typeof r.data.removed === 'number' ? r.data.removed : 0 };
}

/** A new set of recovery codes (the old ones stop working). Needs the code on this session (`step_up`). */
export async function regenerateRecoveryCodes(): Promise<{ ok: true; codes: string[] } | MfaFailure> {
  const r = await rpc<{ ok?: boolean; error?: string; codes?: string[] }>('live_mfa_codes_regenerate');
  if (r.error === 'setup') return failure('disabled');
  if (r.error || !r.data) return failure(r.error === 'offline' ? 'offline' : 'failed');
  if (r.data.ok !== true) return failure(r.data.error === 'mfa_required' ? 'step_up' : r.data.error === 'session_revoked' ? 'signed_out' : 'failed');
  return { ok: true, codes: (r.data.codes ?? []).filter((c) => typeof c === 'string') };
}

export interface TotpEnrollment {
  ok: true;
  factorId: string;
  /** An SVG QR code as a data: URL (rendered in an <img>). */
  qr: string;
  /** The setup key: typed into an app that can't scan, and the way back after losing the phone. */
  secret: string;
  uri: string;
}

/**
 * Start adding an authenticator: Supabase creates an unverified factor and the QR code. Half-done
 * set-ups from before are cleared first (they'd otherwise pile up against the factor limit).
 * Adding a second authenticator once one is on needs aal2 (code `step_up`).
 */
export async function enrollTotp(): Promise<TotpEnrollment | MfaFailure> {
  const sb = await supa();
  if (!sb) return mfaFailure({ message: 'offline' });
  const rows = await factorRows(sb);
  for (const f of rows ?? []) {
    if (f.factor_type === 'totp' && f.status === 'unverified') {
      try {
        await sb.auth.mfa.unenroll({ factorId: f.id });
      } catch { /* the server tidies stale ones too */ }
    }
  }
  const verified = (rows ?? []).filter((f) => f.factor_type === 'totp' && f.status === 'verified').length;
  // Names must be unique per account; the date says which phone is which in the list.
  const friendlyName = `Authenticator ${verified + 1} · ${new Date().toISOString().slice(0, 10)} ${Math.random().toString(36).slice(2, 6)}`;
  try {
    const { data, error } = await sb.auth.mfa.enroll({ factorType: 'totp', friendlyName, issuer: 'DreamStream' });
    if (error || !data) return mfaFailure(error ?? undefined);
    return { ok: true, factorId: data.id, qr: data.totp.qr_code, secret: data.totp.secret, uri: data.totp.uri };
  } catch (e) {
    return mfaFailure({ message: e instanceof Error ? e.message : 'offline' });
  }
}

export interface TotpTurnedOn {
  ok: true;
  /** It was the first authenticator: two-step sign-in is on now. */
  first: boolean;
  /** Recovery codes — shown once, only when it was the first. */
  codes: string[];
}

/**
 * Finish adding an authenticator with its first code (the session becomes aal2), then switch it
 * on with the server (live_mfa_activate): for the first one that needs a fresh sign-in, makes the
 * recovery codes and emails the person. If the server won't switch it on, the authenticator is
 * removed again — never left half-on, where it could ask for codes the account can't recover.
 */
export async function verifyTotp(factorId: string, code: string): Promise<TotpTurnedOn | MfaFailure> {
  const sb = await supa();
  if (!sb) return mfaFailure({ message: 'offline' });
  const digits = sixDigits(code);
  if (digits.length !== 6) return { ok: false, code: 'invalid_code', error: 'Type the 6-digit code from your authenticator app.' };
  try {
    const { error } = await sb.auth.mfa.challengeAndVerify({ factorId, code: digits });
    if (error) return mfaFailure(error);
  } catch (e) {
    return mfaFailure({ message: e instanceof Error ? e.message : 'offline' });
  }
  const r = await rpc<{ ok?: boolean; error?: string; first?: boolean; codes?: string[] }>('live_mfa_activate', { p_factor: factorId });
  if (r.data?.ok === true) {
    await refreshAccount();
    return { ok: true, first: r.data.first === true, codes: (r.data.codes ?? []).filter((c) => typeof c === 'string') };
  }
  // Not switched on: take it off again (this session is aal2 now, so it may).
  try {
    await sb.auth.mfa.unenroll({ factorId });
  } catch { /* the server tidies one that was never switched on within the hour */ }
  await sb.auth.refreshSession().catch(() => undefined);
  await refreshAccount();
  if (r.error === 'setup') return failure('disabled');
  if (r.error === 'offline') return failure('offline');
  if (r.data?.error === 'reauth_required') return failure('reauth');
  if (r.data?.error === 'session_revoked') return failure('signed_out');
  return failure('failed');
}

/** Abandon a set-up that was never confirmed (the unverified factor goes). */
export async function cancelTotpEnrollment(factorId: string): Promise<void> {
  const sb = await supa();
  try {
    await sb?.auth.mfa.unenroll({ factorId });
  } catch { /* nothing to tidy */ }
}

/**
 * Remove an authenticator (turning two-step sign-in off when it was the last). Needs aal2 —
 * whoever has only the password can't switch it off. The session is refreshed afterwards so its
 * level matches the factors that are left.
 */
export async function unenrollTotp(factorId: string): Promise<{ ok: true } | MfaFailure> {
  const sb = await supa();
  if (!sb) return mfaFailure({ message: 'offline' });
  try {
    const { error } = await sb.auth.mfa.unenroll({ factorId });
    if (error) return mfaFailure(error);
    await sb.auth.refreshSession().catch(() => undefined);
  } catch (e) {
    return mfaFailure({ message: e instanceof Error ? e.message : 'offline' });
  }
  await refreshAccount();
  return { ok: true };
}

/**
 * The second step: a code from the account's authenticator upgrades this session to aal2 — at
 * sign-in, and before admin actions (share links, adding people, export, approving devices).
 * Supabase stores the upgraded session and fires MFA_CHALLENGE_VERIFIED, so open sockets get
 * the aal2 token over `ds:token`. With no authenticator there's nothing to step up to: ok.
 */
export async function stepUp(code: string, factorId?: string): Promise<{ ok: true } | MfaFailure> {
  const sb = await supa();
  if (!sb) return mfaFailure({ message: 'offline' });
  const digits = sixDigits(code);
  if (digits.length !== 6) return { ok: false, code: 'invalid_code', error: 'Type the 6-digit code from your authenticator app.' };
  const rows = await factorRows(sb);
  if (!rows) return mfaFailure({ message: 'offline' });
  // Every authenticator has its own secret, so a code is good for exactly one of them — and the
  // person can't be expected to know which (a second phone, a password manager). Ask each in
  // turn, newest first (the one most likely in hand), unless they said which one it came from.
  const verified = rows
    .filter((f) => f.factor_type === 'totp' && f.status === 'verified')
    .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
  const picked = factorId ? verified.filter((f) => f.id === factorId) : verified;
  if (!verified.length) {
    // Nothing to step up to — two-step sign-in was turned off (maybe on another device): bring
    // this session and the account state up to date so nothing keeps asking for a code.
    await sb.auth.refreshSession().catch(() => undefined);
    await refreshAccount();
    return { ok: true };
  }
  let last: MfaFailure | null = null;
  for (const factor of (picked.length ? picked : verified).slice(0, 10)) {
    try {
      const { error } = await sb.auth.mfa.challengeAndVerify({ factorId: factor.id, code: digits });
      if (!error) {
        await refreshAccount();
        return { ok: true };
      }
      last = mfaFailure(error);
    } catch (e) {
      last = mfaFailure({ message: e instanceof Error ? e.message : 'offline' });
    }
    // Only "that code doesn't fit this authenticator" is worth trying on the next one; too many
    // tries, no connection or a server problem would only burn more attempts.
    if (last.code !== 'invalid_code' && last.code !== 'expired') return last;
  }
  return last ?? mfaFailure(undefined);
}

/* ------------------------------------------- devices and security history */

/** An account device (phone, browser, watch) from `live_device_list` (server/sql/live_security_v2.sql). */
export interface MyDevice {
  id: string;
  platform: string;
  name: string;
  created_at: string;
  last_seen: string;
  revoked_at: string | null;
}

/** One line of the account's security history (`live_security_events`). */
export interface SecurityEvent {
  id: number;
  kind: string;
  method: string | null;
  ua: string | null;
  ip: string | null;
  at: string;
  this_session: boolean;
  active: boolean;
  secured: boolean;
  detail: Record<string, unknown> | null;
}

/**
 * Why a list couldn't load: `setup` — the security update (live_security_v2.sql) isn't on the
 * server yet; `mfa_required` — the code is owed first; anything else is a plain failure.
 */
export type SecurityListError = 'setup' | 'mfa_required' | 'session_revoked' | 'offline' | 'failed';

const listError = (e: string | null | undefined): SecurityListError =>
  e === 'setup' || e === 'mfa_required' || e === 'session_revoked' || e === 'offline' ? e : 'failed';

export async function listMyDevices(): Promise<{ ok: true; devices: MyDevice[] } | { ok: false; error: SecurityListError }> {
  const r = await rpc<{ ok?: boolean; error?: string; devices?: MyDevice[] }>('live_device_list');
  if (r.error || !r.data) return { ok: false, error: listError(r.error) };
  if (!r.data.ok) return { ok: false, error: listError(r.data.error) };
  return { ok: true, devices: r.data.devices ?? [] };
}

export async function listSecurityEvents(limit = 20): Promise<{ ok: true; events: SecurityEvent[] } | { ok: false; error: SecurityListError }> {
  const r = await rpc<{ ok?: boolean; error?: string; events?: SecurityEvent[] }>('live_security_events', { p_limit: limit });
  if (r.error || !r.data) return { ok: false, error: listError(r.error) };
  if (!r.data.ok) return { ok: false, error: listError(r.data.error) };
  return { ok: true, events: r.data.events ?? [] };
}

/** Device sign-outs the nurseries haven't all heard about yet (their ids), so the retry stays. */
const UNCONFIRMED_KEY = 'ds-live-unconfirmed-revokes';

export function unconfirmedRevokes(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(UNCONFIRMED_KEY) || '[]') as unknown;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').slice(0, 50) : [];
  } catch {
    return [];
  }
}

function markUnconfirmed(id: string, unconfirmed: boolean): void {
  try {
    const rest = unconfirmedRevokes().filter((x) => x !== id);
    const next = unconfirmed ? [id, ...rest].slice(0, 50) : rest;
    if (next.length) localStorage.setItem(UNCONFIRMED_KEY, JSON.stringify(next));
    else localStorage.removeItem(UNCONFIRMED_KEY);
  } catch { /* storage unavailable: the list just won't offer the retry */ }
}

export type RevokeResult = { ok: true; confirmed: boolean } | { ok: false; error: SecurityListError | 'not_found' | 'retry' };

/**
 * Sign a device out for good. Through the live Worker (WS-7 `DELETE /api/devices/:id`): it revokes
 * in Supabase AND tells every nursery, so the device's sockets close and its alerts stop at once.
 * `confirmed` only when every nursery heard (`told === rooms`); otherwise the list keeps a "Finish
 * signing out" retry for it (a repeat DELETE tells the rooms again).
 * Only a Worker WITHOUT the route (404/405/501, before WS-7 deploys) falls back to the plain
 * `live_device_revoke` — never reported as confirmed. Any other failure (offline, busy, rate
 * limited, a server error) changes nothing and says "try again": papering over it with the plain
 * revoke would mark a stolen phone "signed out" while it kept getting the nursery's alerts.
 */
export async function revokeMyDevice(id: string): Promise<RevokeResult> {
  const token = await accessToken();
  if (!token) return { ok: false, error: 'retry' };
  let res: Response;
  try {
    res = await fetch(`${WORKER_BASE}/api/devices/${encodeURIComponent(id)}`, { method: 'DELETE', headers: { authorization: `Bearer ${token}` } });
  } catch {
    return { ok: false, error: 'retry' };
  }
  const body = (await res.json().catch(() => null)) as { ok?: unknown; error?: unknown; rooms?: unknown; told?: unknown } | null;
  if (res.ok && body?.ok !== false) {
    const rooms = typeof body?.rooms === 'number' ? body.rooms : null;
    const told = typeof body?.told === 'number' ? body.told : null;
    const confirmed = rooms == null || told == null || told >= rooms;
    markUnconfirmed(id, !confirmed);
    return { ok: true, confirmed };
  }
  const error = typeof body?.error === 'string' ? body.error : '';
  if (error === 'mfa_required') return { ok: false, error: 'mfa_required' };
  if (error === 'not_found') {
    // Its record is gone (removed, or cleared after 180 days): nothing left to finish.
    markUnconfirmed(id, false);
    return { ok: false, error: 'not_found' };
  }
  if (res.status === 401 || error === 'auth') return { ok: false, error: 'session_revoked' };
  if (res.status === 404 || res.status === 405 || res.status === 501) {
    // A Worker that doesn't have the route yet: the database alone. The watch's grant stops at its
    // next token exchange; the nurseries haven't heard, so the retry stays.
    const r = await rpc<{ ok?: boolean; error?: string }>('live_device_revoke', { p_device: id });
    if (r.error || !r.data) return { ok: false, error: listError(r.error) };
    if (!r.data.ok) return { ok: false, error: r.data.error === 'not_found' ? 'not_found' : listError(r.data.error) };
    markUnconfirmed(id, true);
    return { ok: true, confirmed: false };
  }
  return { ok: false, error: 'retry' };
}

/* ------------------------------------------- "Not you? Secure my account" */

/** The one-time token in a new-sign-in email's link (`#/secure/<token>`, email-worker securityAlert.ts). */
export const SECURE_TOKEN = /^[A-Za-z0-9_-]{20,128}$/;

export interface SecureAccountResult {
  ok: true;
  /** Supabase ended every session of the account (false: the database couldn't — never claimed). */
  signedOutEverywhere: boolean;
  sessionsEnded: number | null;
  /** Phones and watches added since that sign-in, now signed out. */
  devicesRevoked: number;
  /**
   * Authenticators switched on since that sign-in (or by the session it reported) — removed, so an
   * intruder who turned on two-step sign-in can't lock the parent out. null: not known.
   */
  factorsRemoved: number | null;
  resetEmail: 'sent' | 'throttled' | 'unavailable' | 'failed';
  /** "a•••@example.com" — where the reset email went. */
  emailHint: string | null;
  /** This browser was signed in to that account: it's signed out now too. */
  thisDevice: boolean;
  /**
   * The live Worker confirmed every open monitor, call line and alert subscription of the account
   * is closed — asked by the backend with its own signed credential, because the account's tokens
   * all died the moment it was secured. False: not confirmed (the page says what to do).
   */
  kicked: boolean;
}

export interface SecureAccountFailure {
  ok: false;
  code: 'used' | 'expired' | 'invalid_token' | 'unavailable' | 'unreachable' | string;
  message: string;
}

const RESET_EMAIL = new Set(['sent', 'throttled', 'unavailable', 'failed']);

/**
 * Redeem the "Not you?" link: POST /api/auth/email/secure {token} (server/src/routes/authEmail.ts)
 * ends every session of the account, signs out devices added since that sign-in, removes
 * authenticators switched on since then, asks the live Worker (server-side, signed) to close the
 * account's open sockets and drop its alert subscriptions, and emails a password-reset link. Then,
 * if THIS browser was signed in to that same account — its session is among the ones just ended,
 * which the auth server can tell us exactly (no guessing from the email hint) — this browser signs
 * out too (its own kick still reaches the call line; `kicked` is the server's confirmation).
 */
export async function secureAccount(token: string): Promise<SecureAccountResult | SecureAccountFailure> {
  if (!SECURE_TOKEN.test(token)) return { ok: false, code: 'invalid_token', message: 'This link isn’t complete — open it straight from the email again.' };
  const sb = await supa();
  let localToken: string | null = null;
  try {
    localToken = (await sb?.auth.getSession())?.data.session?.access_token ?? null;
  } catch { /* not signed in here */ }

  let status = 0;
  let body: Record<string, unknown> | null = null;
  try {
    const { buildApiUrl } = await import('@/services/clientConfig');
    const res = await fetch(buildApiUrl('/api/auth/email/secure'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token }),
    });
    status = res.status;
    body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  } catch {
    return { ok: false, code: 'unreachable', message: 'Can’t reach DreamStream right now — check your connection and try again. Your link still works.' };
  }
  if (!body || body.ok !== true) {
    const code = typeof body?.code === 'string' ? body.code : status === 404 || status === 405 || !body ? 'unreachable' : `http_${status}`;
    const message =
      typeof body?.message === 'string' && body.message
        ? body.message
        : 'We couldn’t secure your account just now — please try again in a minute. Your link still works.';
    return { ok: false, code, message };
  }

  let thisDevice = false;
  let kicked = body.kicked === true;
  if (sb && localToken) {
    try {
      const { error } = await sb.auth.getUser(localToken);
      const e = error as { status?: number; code?: string; message?: string } | null;
      thisDevice = !!e && (e.status === 401 || e.status === 403 || /session/i.test(`${e.code ?? ''} ${e.message ?? ''}`));
    } catch { /* can't tell: leave this browser as it is */ }
    if (thisDevice) {
      // A token whose session just ended can't list the nurseries any more; the server's kick
      // covers them. This still reaches the call line, and never counts for more than it did.
      kicked = (await kickMySockets(localToken)) || kicked;
      await signOutThisDevice();
    }
  }
  const sessionsEnded = typeof body.sessionsEnded === 'number' ? body.sessionsEnded : null;
  return {
    ok: true,
    signedOutEverywhere: body.signedOutEverywhere === true,
    sessionsEnded,
    devicesRevoked: typeof body.devicesRevoked === 'number' ? body.devicesRevoked : 0,
    factorsRemoved: typeof body.factorsRemoved === 'number' ? body.factorsRemoved : null,
    resetEmail: typeof body.resetEmail === 'string' && RESET_EMAIL.has(body.resetEmail) ? (body.resetEmail as SecureAccountResult['resetEmail']) : 'unavailable',
    emailHint: typeof body.emailHint === 'string' ? body.emailHint : null,
    thisDevice,
    kicked,
  };
}

/* ------------------------------------------------- auth sheet control */

export type AuthMode = 'signin' | 'create' | 'code' | 'reset';
let authOpener: ((mode: AuthMode, reason?: string) => void) | null = null;
let secondStepOpener: (() => void) | null = null;

export function registerAuthOpener(fn: ((mode: AuthMode, reason?: string) => void) | null): void {
  authOpener = fn;
}

/** The StepUp sheet (views/account/StepUp.tsx) registers how to ask for the sign-in code. */
export function registerSecondStepOpener(fn: (() => void) | null): void {
  secondStepOpener = fn;
}

/**
 * Open the in-app sign-in / create-account sheet from anywhere. Someone who has given their
 * password but still owes the two-step code is asked for the code instead — every "Sign in"
 * button in the app then finishes the sign-in rather than starting another.
 */
export function openAuth(mode: AuthMode = 'signin', reason?: string): void {
  if (current.status === 'needs_mfa' && secondStepOpener) {
    secondStepOpener();
    return;
  }
  authOpener?.(mode, reason);
}
