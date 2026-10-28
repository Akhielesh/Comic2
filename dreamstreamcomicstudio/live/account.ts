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
import { LIVE_APP_PATH } from './host';

export type AccountStatus = 'loading' | 'signed_out' | 'needs_code' | 'member' | 'offline';

export interface LiveAccount {
  status: AccountStatus;
  userId?: string;
  email?: string;
  name?: string;
  verifiedVia?: string;
  suggestedName?: string;
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

export async function refreshAccount(): Promise<LiveAccount> {
  const sb = await supa();
  if (!sb) {
    set({ status: 'offline' });
    return current;
  }
  if (!authSubscribed) {
    authSubscribed = true;
    sb.auth.onAuthStateChange((event) => {
      if (event === 'SIGNED_OUT') {
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
      if (event === 'SIGNED_IN' || event === 'USER_UPDATED') void refreshAccount();
    });
  }
  let session;
  try {
    session = (await sb.auth.getSession()).data.session;
  } catch {
    set({ status: 'offline' });
    return current;
  }
  if (!session) {
    // Nobody signed in: the last account's name, events and nursery data go too.
    if (claimDevice(null)) notifyPurged();
    set({ status: 'signed_out' });
    return current;
  }
  if (claimDevice(session.user.id)) notifyPurged();
  const email = session.user.email ?? undefined;
  const me = await rpc<{ member?: boolean; needs_code?: boolean; suggested_name?: string; profile?: { display_name?: string; verified_via?: string } }>('live_me');
  if (me.error || !me.data) {
    set({ status: 'offline', userId: session.user.id, email });
    return current;
  }
  if (me.data.member) {
    set({ status: 'member', userId: session.user.id, email, name: me.data.profile?.display_name, verifiedVia: me.data.profile?.verified_via });
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
  }
  set({ status: 'needs_code', userId: session.user.id, email, suggestedName: me.data.suggested_name });
  return current;
}

/** Views holding a copy of the purged settings re-read them. */
function notifyPurged(): void {
  try {
    window.dispatchEvent(new Event('ds-live-account-purged'));
  } catch { /* no window */ }
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

export async function signOutEverywhereLocal(): Promise<void> {
  const { signOut } = await import('./sync');
  await signOut();
  set({ status: 'signed_out' });
}

/* ------------------------------------------------- auth sheet control */

export type AuthMode = 'signin' | 'create' | 'code' | 'reset';
let authOpener: ((mode: AuthMode, reason?: string) => void) | null = null;

export function registerAuthOpener(fn: ((mode: AuthMode, reason?: string) => void) | null): void {
  authOpener = fn;
}

/** Open the in-app sign-in / create-account sheet from anywhere. */
export function openAuth(mode: AuthMode = 'signin', reason?: string): void {
  authOpener?.(mode, reason);
}
