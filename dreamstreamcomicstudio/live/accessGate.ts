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
 * gated out by a network blip, a reload while the internet is down or a slow answer.
 */
import type { AccountStatus } from './account';
import type { Route } from './LiveApp';

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
 */
export const LINK_ROUTES = ['viewer', 'event', 'event-auto', 'guest', 'monitor-join', 'secure'] as const satisfies readonly RouteView[];

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

/** A screen a link people were sent opens — never gated. */
export const isLinkRoute = (view: RouteView): boolean => LINKS.has(view);

/** The gate for a screen, given the account's status. */
export function gateFor(route: RouteView | Pick<Route, 'view'>, status: AccountStatus): Gate {
  const view = typeof route === 'string' ? route : route.view;
  if (isLinkRoute(view)) return 'open';
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
