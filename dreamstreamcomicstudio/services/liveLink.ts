// Links between DreamStream and Stream Studio, and the seamless sign-in between them.
//
// Stream Studio's address comes from shared/streamHost.ts: '/live…' on this origin while
// STREAM_HOST_ON is off (exactly as before), https://stream.dreamstreamstudio.ai once it's on.
// The two hosts keep separate sessions (Supabase keeps them in localStorage, per origin), and
// refresh tokens are single use, so a session is never copied across. Instead, a signed-in person
// crossing over gets a one-time sign-in link for their own account from POST /api/auth/handoff,
// which the other app verifies into a session of its own. If anything about that fails (signed
// out, offline, a slow backend), the plain link is used and the other app asks them to sign in.
//
// Used by both apps: the main app opens Stream Studio with openLiveApp / followLiveLink; Stream
// Studio opens DreamStream with openMainApp and links to its pages with mainAppUrl.
import type React from 'react';
import {
  MAIN_ORIGIN,
  STREAM_HOST_ON,
  STREAM_ORIGIN,
  isStreamHost,
  isStreamUrl,
  screenOfHash,
  streamAppHref,
  type StreamReturnScreen,
} from '../shared/streamHost';
import { buildApiUrl } from './clientConfig';
import { SIGN_IN_NONCE_PARAM, isSignInNonce, markSignInStarted } from './pendingSignIn';

/** A slow (sleeping) backend shouldn't hold a click for long: past this, use the plain link. */
const HANDOFF_TIMEOUT_MS = 6000;

/** True while running on Stream Studio's own host. */
export const onStreamHost = (): boolean => typeof location !== 'undefined' && isStreamHost(location.hostname);

/** Where a Stream Studio link (written the old way: '/live', '/live#/monitor') should point. */
export const liveAppUrl = (legacy = '/live', on: boolean = STREAM_HOST_ON): string => streamAppHref(legacy, on);

/**
 * A main-app path ('/?view=privacy') as a link that works from here: unchanged on the main app,
 * absolute (https://dreamstreamstudio.ai/…) on the Stream Studio host.
 */
export const mainAppUrl = (path = '/'): string => {
  const p = path.startsWith('/') ? path : `/${path}`;
  return onStreamHost() ? `${MAIN_ORIGIN}${p}` : p;
};

const isMainUrl = (href: string): boolean => {
  try {
    return new URL(href).origin === MAIN_ORIGIN;
  } catch {
    return false;
  }
};

/**
 * Ask for a one-time sign-in link into the other app ('live' = Stream Studio, 'main' = DreamStream).
 * Null when signed out, refused, too slow or anything unexpected — callers fall back to a plain link.
 * Only ever returns a URL on one of our two hosts.
 */
export async function requestHandoff(
  to: 'live' | 'main',
  path?: string,
  timeoutMs = HANDOFF_TIMEOUT_MS,
  opts: { /** The RECEIVING app's sign-in nonce, when it started this crossing (echoed into the link as `sn`). */ sn?: string | null } = {}
): Promise<string | null> {
  const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timer = ctrl ? setTimeout(() => ctrl.abort(), timeoutMs) : null;
  try {
    // Loaded on demand: Stream Studio's viewer pages use this module's links but never sign in.
    const { supabase } = await import('./supabase');
    const token = (await supabase.auth.getSession()).data.session?.access_token;
    if (!token) return null;
    const res = await fetch(buildApiUrl('/api/auth/handoff'), {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ to, ...(path ? { path } : {}), ...(isSignInNonce(opts.sn) ? { sn: opts.sn } : {}) }),
      signal: ctrl?.signal,
    });
    if (!res.ok) return null;
    const body = (await res.json().catch(() => null)) as { url?: unknown } | null;
    const url = typeof body?.url === 'string' ? body.url : null;
    if (!url) return null;
    if (!(to === 'live' ? isStreamUrl(url) : isMainUrl(url))) return null;
    // No sign-in intent is recorded here: the link opens on the OTHER host, which keeps its own
    // storage and can't see it — while a record left on this origin would be a standing pass for
    // any link opened here. The receiving app asks "Finish signing in?" once (services/pendingSignIn;
    // /api/auth/handoff echoes a receiving app's own nonce, `sn`, for crossings it starts itself).
    return url;
  } catch {
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** How these helpers leave the page (an object so tests can watch it). */
export const linkNav = {
  assign: (url: string): void => window.location.assign(url),
  replace: (url: string): void => window.location.replace(url),
};

const navigate = (url: string, replace?: boolean) => (replace ? linkNav.replace(url) : linkNav.assign(url));

/**
 * One crossing per page. Each handoff link replaces the account's previous one (Supabase keeps a
 * single one-time sign-in token per account), so a second handoff started while the first is
 * loading — a double click, or two redirects racing — would cancel the link being opened.
 * Later calls share the first; the guard lifts after a while in case the page never left.
 */
let crossing: Promise<void> | null = null;
const CROSSING_HOLD_MS = 10_000;
function once(run: () => Promise<void>): Promise<void> {
  if (crossing) return crossing;
  const p = run();
  crossing = p;
  void p.finally(() => setTimeout(() => {
    if (crossing === p) crossing = null;
  }, CROSSING_HOLD_MS));
  return p;
}
/** Test hook. */
export const resetCrossing = (): void => void (crossing = null);

/** The screen a Stream Studio link opens, when that's all it carries (no ?e=…, no deeper route). */
function carriedScreen(href: string): StreamReturnScreen | '' | null {
  let url: URL;
  try {
    url = new URL(href, `${STREAM_ORIGIN}/`);
  } catch {
    return null;
  }
  if (url.search) return null;
  if (!url.hash || url.hash === '#' || url.hash === '#/') return '';
  const screen = screenOfHash(url.hash);
  return screen && url.hash === `#/${screen}` ? screen : null;
}

/**
 * Open Stream Studio. Switch off: the old same-origin link, as before. Switch on: signed in here ⇒
 * arrive signed in there (handoff); otherwise — or for a link that carries more than a screen,
 * like a viewer link — the plain address.
 */
export async function openLiveApp(legacy = '/live', opts: { replace?: boolean; on?: boolean } = {}): Promise<void> {
  const on = opts.on ?? STREAM_HOST_ON;
  // A hand-back from Stream Studio ("Continue with DreamStream") carries the nonce of the sign-in
  // THAT host started (`?sn=`): it goes into the handoff request, never into the address.
  const { href: plain, sn } = splitHandoffNonce(liveAppUrl(legacy, on));
  if (!on || onStreamHost()) return navigate(plain, opts.replace);
  return once(async () => {
    const screen = carriedScreen(plain);
    const url = screen === null ? null : await requestHandoff('live', screen ? `#/${screen}` : '', undefined, { sn });
    navigate(url ?? plain, opts.replace);
  });
}

/**
 * `?sn=<nonce>` out of a Stream Studio address: the nonce (when it is one) and the address
 * without it. An address that carries none is returned exactly as given.
 */
function splitHandoffNonce(href: string): { href: string; sn: string | null } {
  let url: URL;
  try {
    url = new URL(href, `${STREAM_ORIGIN}/`);
  } catch {
    return { href, sn: null };
  }
  const raw = url.searchParams.get(SIGN_IN_NONCE_PARAM);
  if (raw === null) return { href, sn: null };
  url.searchParams.delete(SIGN_IN_NONCE_PARAM);
  return { href: url.href, sn: isSignInNonce(raw) ? raw : null };
}

/**
 * onClick for an <a href={liveAppUrl(…)}>: a plain click hands the sign-in over; a new-tab click
 * (⌘/Ctrl/Shift/middle) keeps the browser's own behaviour with the plain link.
 */
export function followLiveLink(e: React.MouseEvent<HTMLElement>, legacy = '/live', on: boolean = STREAM_HOST_ON): void {
  if (!on || e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
  e.preventDefault();
  void openLiveApp(legacy, { on });
}

/**
 * Open a DreamStream page from Stream Studio ('/', '/?view=chat'). On the Stream Studio host,
 * signed in ⇒ arrive signed in (handoff); otherwise the plain link.
 *
 * Sign-in intents live per origin, so a handoff the RECEIVING app didn't start — this one, and
 * openLiveApp's from DreamStream — stops at its "Finish signing in?" step once (one tap, the
 * person's own account named by the link). Only the hand-back started by continueWithDreamStream
 * carries the receiving host's nonce and completes without asking. Re-check this before flipping
 * STREAM_HOST_ON.
 */
export async function openMainApp(path = '/', opts: { replace?: boolean; on?: boolean } = {}): Promise<void> {
  const plain = mainAppUrl(path);
  // (Before the switch, the Stream Studio host is only being checked: no handoff there yet.)
  if (!onStreamHost() || !(opts.on ?? STREAM_HOST_ON)) return navigate(plain, opts.replace);
  return once(async () => {
    const url = await requestHandoff('main', path);
    navigate(url ?? plain, opts.replace);
  });
}

/**
 * "Continue with DreamStream" on the Stream Studio host while signed out here: DreamStream (where
 * the person may already be signed in) signs them in if needed, then hands the session back to
 * the given screen. Only the screen travels — never a viewer, studio or guest key.
 */
export function continueWithDreamStream(screen?: StreamReturnScreen | ''): void {
  // The sign-in this starts comes back HERE as a handoff link, so the intent is recorded on this
  // host — the one that receives the link — and its nonce travels along: DreamStream hands it to
  // /api/auth/handoff, which echoes it into the link, and that link (only) completes here without
  // asking. Recorded on Stream Studio's own host only: anywhere else the link would land on
  // another origin, and a record here would be a standing pass for any link opened here.
  const sn = onStreamHost() ? markSignInStarted('handoff') : null;
  const back = `${STREAM_ORIGIN}/${sn ? `?${SIGN_IN_NONCE_PARAM}=${sn}` : ''}${screen ? `#/${screen}` : ''}`;
  navigate(`${MAIN_ORIGIN}/?next=${encodeURIComponent(back)}`);
}
