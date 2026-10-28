// Sign-in intent: did THIS browser ask for the sign-in a link is about to complete?
//
// Email links (magic link, sign-up confirmation, password reset, resend) come back through a
// URL that carries tokens. Anyone can mint such a link for their OWN account and send it to
// someone else; opening it would silently sign the visitor's browser in to the sender's account
// (login CSRF), and the login sync would then carry this device's data into it.
//
// So a sign-in started here is bound to its link: the browser makes a random nonce, sends it
// with the request (POST /api/auth/email/* as `sn`), and our backend puts it in the link it
// mails (`&sn=…`). The pages that receive links (App's /auth/callback handler, Stream Studio's
// consumeAuthReturn) sign in without asking only when the link carries the nonce of a fresh
// sign-in started in this browser. An attacker's link — made for their own account — can't
// carry it: the nonce never leaves this browser except inside the email sent to the address
// that was typed here. Every other link stops at "Finish signing in?", so a link opened on
// another device still works, at the cost of one click.
//
// Password sign-in needs no intent (no URL). Records live in localStorage (a magic link opens
// in a new tab) and are scoped to this origin by the browser: a link that lands on another
// origin (Stream Studio's own host, or the main app from there) asks once.

export const PENDING_SIGN_IN_KEY = 'ds.pendingSignIn';
/** The query parameter a sign-in link carries its nonce in. */
export const SIGN_IN_NONCE_PARAM = 'sn';
/** How long a started sign-in stays "fresh": as long as the emailed link itself (GoTrue: 1 h). */
export const SIGN_IN_INTENT_TTL_MS = 60 * 60 * 1000;
/** Sign-ins kept at once (asked twice for a link, a reset and a magic link…). */
const MAX_PENDING = 5;
/** Tolerated clock skew for a record written a moment "in the future" (another tab, a clock change). */
const FUTURE_SKEW_MS = 60 * 1000;
/** What a nonce looks like — shared with the server (server/src/services/authEmailLinks.ts). */
const NONCE_RE = /^[A-Za-z0-9-]{16,64}$/;

export type SignInKind = 'magiclink' | 'signup' | 'recovery' | 'resend' | 'handoff';

/**
 * The link type (`?type=` / `#type=`, what verifyOtp is told) each kind of started sign-in comes
 * back as: a resend is a sign-up confirmation, a handoff is a magic link. A nonce is only ever put
 * into the link our backend built for that request, so a link of another type carrying it was
 * tampered with — it asks first. Link types this table doesn't know are judged by the nonce alone.
 */
const LINK_TYPE_OF_KIND: Record<SignInKind, string> = {
  magiclink: 'magiclink',
  signup: 'signup',
  recovery: 'recovery',
  resend: 'signup',
  handoff: 'magiclink',
};
const KNOWN_LINK_TYPES: ReadonlySet<string> = new Set(Object.values(LINK_TYPE_OF_KIND));

interface PendingSignIn {
  nonce: string;
  at: number;
  kind: string;
  /** The address the link was sent to — for display and diagnostics only; the nonce is the gate. */
  email?: string;
}

const storage = (): Storage | undefined => {
  if (typeof window === 'undefined') return undefined;
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
};

export const isSignInNonce = (value: unknown): value is string => typeof value === 'string' && NONCE_RE.test(value);

/** A fresh random nonce for a sign-in this browser is about to start. */
export function newSignInNonce(): string {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  } catch {
    const part = () => Math.random().toString(36).slice(2).padEnd(8, '0');
    return `${Date.now().toString(36)}-${part()}-${part()}`;
  }
}

const asEntry = (value: unknown): PendingSignIn | null => {
  if (!value || typeof value !== 'object') return null;
  const e = value as Partial<PendingSignIn>;
  if (!isSignInNonce(e.nonce) || typeof e.at !== 'number' || !Number.isFinite(e.at)) return null;
  return {
    nonce: e.nonce,
    at: e.at,
    kind: typeof e.kind === 'string' ? e.kind : 'unknown',
    ...(typeof e.email === 'string' && e.email ? { email: e.email } : {}),
  };
};

const readAll = (): PendingSignIn[] => {
  try {
    const raw = storage()?.getItem(PENDING_SIGN_IN_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    const list = Array.isArray(parsed) ? parsed : [parsed];
    return list.map(asEntry).filter((e): e is PendingSignIn => !!e);
  } catch {
    return [];
  }
};

const writeAll = (entries: PendingSignIn[]): void => {
  try {
    if (entries.length) storage()?.setItem(PENDING_SIGN_IN_KEY, JSON.stringify(entries));
    else storage()?.removeItem(PENDING_SIGN_IN_KEY);
  } catch {
    /* storage unavailable: links from here will ask before signing in */
  }
};

const isFresh = (record: PendingSignIn, now: number): boolean =>
  now - record.at < SIGN_IN_INTENT_TTL_MS && record.at - now <= FUTURE_SKEW_MS;

/**
 * This browser started a sign-in whose link will carry `nonce` (record it only once the email went
 * out). `email`: the address it went to, kept beside the record.
 */
export function recordSignInStarted(kind: SignInKind, nonce: string, now: number = Date.now(), email?: string | null): void {
  if (!isSignInNonce(nonce)) return;
  const kept = readAll().filter((e) => isFresh(e, now) && e.nonce !== nonce);
  kept.push({ nonce, at: now, kind, ...(typeof email === 'string' && email ? { email } : {}) });
  writeAll(kept.slice(-MAX_PENDING));
}

/** New nonce + record in one step; returns the nonce the link must carry. */
export function markSignInStarted(kind: SignInKind, now: number = Date.now()): string {
  const nonce = newSignInNonce();
  recordSignInStarted(kind, nonce, now);
  return nonce;
}

/** The nonce a sign-in link carries (`?sn=…`), or null. */
export function signInNonceOf(url: URL): string | null {
  const value = url.searchParams.get(SIGN_IN_NONCE_PARAM);
  return isSignInNonce(value) ? value : null;
}

/** The link type a sign-in link names (`?type=` or, for fragment tokens, `#type=`), or null. */
const linkTypeOf = (url: URL): string | null =>
  url.searchParams.get('type') || new URLSearchParams(url.hash.replace(/^#/, '')).get('type') || null;

/** Does a started sign-in of this kind come back as a link of this type? (See LINK_TYPE_OF_KIND.) */
const kindFitsLink = (kind: string, linkType: string | null): boolean => {
  const expected = (LINK_TYPE_OF_KIND as Record<string, string | undefined>)[kind];
  if (!expected || !linkType || !KNOWN_LINK_TYPES.has(linkType)) return true;
  return expected === linkType;
};

/** True while any sign-in started in this browser within the last hour is still pending. */
export function hasFreshSignInIntent(now: number = Date.now()): boolean {
  return readAll().some((e) => isFresh(e, now));
}

/**
 * Did THIS browser start the sign-in this link completes? True only when the link carries the
 * nonce of a fresh sign-in started here AND is the kind of link that sign-in comes back as; that
 * record is used up (one link per sign-in). A link without a matching nonce — someone else's
 * link, or one from another device — clears every pending record, so nothing recorded earlier
 * can wave a later link through either.
 */
export function consumeSignInIntent(url: URL | string, now: number = Date.now()): boolean {
  let nonce: string | null = null;
  let linkType: string | null = null;
  try {
    const parsed = typeof url === 'string' ? new URL(url) : url;
    nonce = signInNonceOf(parsed);
    linkType = linkTypeOf(parsed);
  } catch {
    nonce = null;
  }
  const entries = readAll();
  const match = nonce ? entries.find((e) => e.nonce === nonce && isFresh(e, now) && kindFitsLink(e.kind, linkType)) : undefined;
  if (!match) {
    writeAll([]);
    return false;
  }
  writeAll(entries.filter((e) => e !== match && isFresh(e, now)));
  return true;
}

/** Forget every pending sign-in (nothing here is waiting for a link any more). */
export function clearSignInIntents(): void {
  writeAll([]);
}
