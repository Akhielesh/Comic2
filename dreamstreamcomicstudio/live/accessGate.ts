/**
 * Who may open which Stream Studio screen — pure, so every route × account status is tested
 * (accessGate.unit.test.ts) and LiveApp only renders the answer.
 *
 * Stream Studio is for signed-in DreamStream accounts (one account across every studio —
 * docs/features/accounts-and-access.md, "Signing in to Stream Studio"). A signed-out visitor
 * gets the sign-in screen, never the dashboard, the create flow, settings, the events this
 * browser remembers or a tour.
 *
 * The exception is a link someone was SENT: those are capability links (the event id, a guest
 * key, a nursery share code, the "Not you?" token) and open with just a name, or nothing at all.
 * They live in one list — LINK_ROUTES — so the policy changes in one place.
 *
 * Safety (baby monitor): only a DEFINITE answer gates — signed out, no welcome code yet, or the
 * two-step code still owed. 'offline' (a session is here but the server couldn't confirm it, or
 * the auth client didn't load) lets the person through exactly as before, and account.ts never
 * downgrades a member on a failed request — so a running nursery camera or monitor is never
 * gated out by a network blip, a reload while the internet is down or a slow answer. (Nor does a
 * blip open the studio: a definite "not yet" is kept through one the same way, and a failed
 * request is never read as "not yet".)
 */
import type { AccountStatus } from './account';
import type { Route } from './LiveApp';
import { loadGuest } from './monitor/guest';

export type RouteView = Route['view'];

/**
 * Screens a link people were sent opens — no account needed:
 *  - 'viewer', 'event', 'event-auto' — the watch page and the invite page (`?e=ID`);
 *  - 'guest' — a meeting or broadcast guest seat (`?e=ID#/guest?g=KEY`);
 *  - 'monitor-join' — a nursery share link (`#/monitor/join/<nursery>/<code>`, plus the passcode
 *    the parent tells them separately);
 *  - 'secure' — "Not you? Secure my account" from a new-sign-in email (`#/secure/<token>`): it
 *    must work signed out, that's the point of it.
 * Sign-in links (email confirmations, the stream-host handoff — `?token_hash=…`, `?code=…`,
 * `#access_token=…`, `?error=…`) aren't a screen: LiveApp finishes them on any route
 * (consumeAuthReturn) and holds the splash meanwhile (statusForGate).
 * A nursery share link also leads ON to a screen of its own — see GUEST_PASS_ROUTES.
 */
export const LINK_ROUTES = ['viewer', 'event', 'event-auto', 'guest', 'monitor-join', 'secure'] as const satisfies readonly RouteView[];

/**
 * Screens a nursery share link leads on to — open, in every account state, to a device holding a
 * guest pass for THAT nursery (holdsGuestPass), and gated like any studio screen otherwise:
 *  - 'monitor-watch' — the nursery's watch page (`#/monitor/<nursery>/watch`). The share link +
 *    passcode save the pass and send the guest here (MonitorJoin); reopening the share link, a
 *    reload, or tapping a crying / smoke alert (live-sw.js) lands here too. MonitorViewer watches on
 *    the pass (useGuestPass) and never asks for an account; a member's own access still wins.
 * Not the camera, the nursery's hub or the monitor home: a pass only ever watches.
 */
export const GUEST_PASS_ROUTES = ['monitor-watch'] as const satisfies readonly RouteView[];

/**
 * Screens gated when they OPEN, never shut while they run — an account change in the meantime (a
 * sign-out in another tab: Comic Studio shares the session; the two-step code asked for again)
 * leaves the screen up, and the gate applies once the person leaves it (or reloads):
 *  - 'studio' — the host's studio (`?e=ID#/studio?k=KEY`). Unmounting it would cut a live broadcast
 *    or meeting mid-stream: camera off, the room closed, every viewer and guest dropped, a recording
 *    left unsaved — and none of its "you're on air" guards run for an in-app swap. The host key, not
 *    the account, runs the stream, so keeping it up exposes nothing new.
 * (The baby monitor's screens keep their own MonitorGate, as before.)
 */
export const GATED_ON_ENTRY = ['studio'] as const satisfies readonly RouteView[];

/** What LiveApp renders instead of (or as) the screen. */
export type Gate =
  /** The screen itself. */
  | 'open'
  /** Not known yet: a quiet splash — never the dashboard, never the sign-in screen. */
  | 'splash'
  /** Signed out: sign in (or create an account) with your DreamStream account. */
  | 'sign-in'
  /** Signed in, no Stream Studio welcome code yet (the private beta): one more step. */
  | 'needs-code'
  /** Password given, two-step code still owed. */
  | 'needs-mfa';

const LINKS: ReadonlySet<string> = new Set(LINK_ROUTES);
const GUEST_PASS: ReadonlySet<string> = new Set(GUEST_PASS_ROUTES);
const ON_ENTRY: ReadonlySet<string> = new Set(GATED_ON_ENTRY);

/** A screen a link people were sent opens — never gated. */
export const isLinkRoute = (view: RouteView): boolean => LINKS.has(view);

/**
 * This device holds a guest pass for the nursery this screen is for, and the screen is one a pass
 * opens (GUEST_PASS_ROUTES). Reads this device's storage: LiveApp asks once per address, so the
 * answer can't change under a running watch page (a pass the room ended is the viewer's to say).
 */
export function holdsGuestPass(route: Route): boolean {
  return GUEST_PASS.has(route.view) && 'nid' in route && loadGuest(route.nid) != null;
}

/**
 * The gate for a screen, given the account's status.
 *  - guestPass: this device holds a guest pass for it (holdsGuestPass);
 *  - running: this very screen (the same address, not reloaded) already opened and is still up —
 *    a GATED_ON_ENTRY screen then stays open whatever the account says now.
 */
export function gateFor(
  route: RouteView | Pick<Route, 'view'>,
  status: AccountStatus,
  opts: { guestPass?: boolean; running?: boolean } = {},
): Gate {
  const view = typeof route === 'string' ? route : route.view;
  if (isLinkRoute(view)) return 'open';
  if (opts.guestPass && GUEST_PASS.has(view)) return 'open';
  if (opts.running && ON_ENTRY.has(view)) return 'open';
  switch (status) {
    case 'loading':
      return 'splash';
    case 'signed_out':
      return 'sign-in';
    case 'needs_code':
      return 'needs-code';
    case 'needs_mfa':
      return 'needs-mfa';
    case 'member':
    case 'offline':
      return 'open';
    default:
      // Anything else is not a definite answer: never shut a screen on it.
      return 'open';
  }
}

/**
 * The status the gate goes by. While a sign-in link is being finished (an email confirmation,
 * the DreamStream handoff, a link this browser didn't ask for waiting for "Continue"), "signed
 * out" isn't the answer yet — the link is about to sign the person in — so the splash holds
 * instead of flashing the sign-in screen.
 */
export function statusForGate(status: AccountStatus, opts: { authPending?: boolean } = {}): AccountStatus {
  return opts.authPending && status === 'signed_out' ? 'loading' : status;
}
