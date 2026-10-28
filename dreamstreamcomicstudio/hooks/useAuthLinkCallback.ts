// The main app's sign-in link handler (/auth/callback, and the Site URL fallback '/').
//
// supabase-js never adopts a session from the URL by itself (detectSessionInUrl: false), so
// this is the one place the main app turns link tokens into a session:
//   - a link this browser asked for — it carries the nonce of a sign-in started here
//     (services/pendingSignIn) — completes at once;
//   - any other link stops at a calm "Finish signing in?" step — Continue completes it,
//     Not now clears the URL and leaves the current session (if any) exactly as it was;
//   - inside a frame, no link signs in at all (another site could disguise "Continue").
// Every token shape is handled explicitly (token_hash → verifyOtp, code →
// exchangeCodeForSession, #access_token+#refresh_token → setSession, error params → an honest
// error), and the URL is cleaned once the visitor's choice is made. Fragment tokens are checked
// with the auth server first: one it refuses is reported as expired and never handed to
// setSession, which would sign the current session out.
import { useCallback, useEffect, useRef, useState } from 'react';
import { lookupAccessTokenEmail, supabase } from '../services/supabase';
import {
  EXPIRED_LINK_MESSAGE,
  FRAMED_LINK_MESSAGE,
  cleanMainAuthUrl,
  completeLinkSignIn,
  inFrame,
  linkErrorMessage,
  peekLinkAccount,
  readMainAuthLink,
  type AuthCallbackFlow,
  type LinkAccount,
  type MainAuthLink,
} from '../services/authLink';
import { clearSignInIntents, consumeSignInIntent } from '../services/pendingSignIn';
import { safeNext } from '../services/safeNext';
import { isStreamUrl } from '../shared/streamHost';

export type AuthCallbackStatus = 'idle' | 'confirm' | 'verifying' | 'success' | 'error';

export interface AuthLinkCallbackOptions {
  /** A sign-in link is on this page: show the auth-callback view. */
  onOpen: () => void;
  /** The visitor chose "Not now": leave the auth-callback view. */
  onDecline: () => void;
  /** Leave for a verified `next` destination (a full navigation). */
  navigate?: (dest: string) => void;
}

export interface AuthLinkCallback {
  status: AuthCallbackStatus;
  message: string | null;
  flow: AuthCallbackFlow;
  /** The account the link signs in to, when it can be known before signing in. */
  email: string | null;
  /** "Continue" on the confirm step. */
  confirm: () => void;
  /** "Not now" on the confirm step. */
  decline: () => void;
  /** Back to idle (after the visitor moved on from the result). */
  reset: () => void;
}

const cleanUrl = () => {
  try {
    window.history.replaceState({}, '', cleanMainAuthUrl(window.location.href));
  } catch {
    /* history unavailable */
  }
};

export function useAuthLinkCallback(options: AuthLinkCallbackOptions): AuthLinkCallback {
  const [status, setStatus] = useState<AuthCallbackStatus>('idle');
  const [message, setMessage] = useState<string | null>(null);
  const [flow, setFlow] = useState<AuthCallbackFlow>('unknown');
  const [email, setEmail] = useState<string | null>(null);
  const pendingRef = useRef<{ link: MainAuthLink; account: Promise<LinkAccount> } | null>(null);
  // Handle the page's link once — StrictMode's mount → unmount → mount must not use it twice
  // (a one-time token can't be verified twice, and the intent is consumed by the first look).
  const startedRef = useRef(false);
  const optionsRef = useRef(options);
  optionsRef.current = options;

  const finish = useCallback(async (link: MainAuthLink, account?: Promise<LinkAccount>) => {
    setStatus('verifying');
    setMessage(null);
    try {
      if (link.tokens!.kind === 'session') {
        // A token the auth server already refuses can't sign in — and setSession would drop the
        // session this browser has on the way. Say it expired instead.
        const found = await (account ?? peekLinkAccount(lookupAccessTokenEmail, link.tokens!));
        if (found.dead) {
          clearSignInIntents();
          setStatus('error');
          setMessage(EXPIRED_LINK_MESSAGE);
          return;
        }
      }
      const { error } = await completeLinkSignIn(supabase.auth, link.tokens!, link.otpType);
      if (error) {
        // A link that failed is over: nothing here waits for it any more.
        clearSignInIntents();
        setStatus('error');
        setMessage(error.message || 'Failed to verify link.');
        return;
      }
      const dest = link.flow !== 'recovery' ? safeNext(link.next) : null;
      if (dest && !isStreamUrl(dest)) {
        cleanUrl();
        (optionsRef.current.navigate ?? ((to: string) => window.location.replace(to)))(dest);
        return;
      }
      setStatus('success');
      setFlow(link.flow);
      setMessage(link.flow === 'recovery' ? 'Recovery link verified. Continue to set a new password.' : 'Authentication successful.');
    } finally {
      cleanUrl();
    }
  }, []);

  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    const url = new URL(window.location.href);
    const link = readMainAuthLink(url);
    if (!link) return;
    setFlow(link.flow);
    optionsRef.current.onOpen();
    // Framed by another page: never sign in here, not even after a click (clickjacking).
    if (inFrame()) {
      setStatus('error');
      setMessage(FRAMED_LINK_MESSAGE);
      cleanUrl();
      return;
    }
    if (!link.tokens || link.tokens.kind === 'error') {
      // The link came back unusable (expired, refused): the sign-in it belonged to is over, so no
      // record stays behind for a later link to use.
      clearSignInIntents();
      setStatus('error');
      setMessage(linkErrorMessage(link.tokens));
      cleanUrl();
      return;
    }
    // This browser asked for exactly this sign-in (the link carries its nonce): no question.
    if (consumeSignInIntent(url)) {
      void finish(link);
      return;
    }
    // Nobody here asked for it: ask before signing this browser in. The account's email (fragment
    // tokens only) fills in when the auth server answers; a token it refuses ends the question.
    const account = peekLinkAccount(lookupAccessTokenEmail, link.tokens);
    const pending = { link, account };
    pendingRef.current = pending;
    setStatus('confirm');
    void account.then((found) => {
      if (pendingRef.current !== pending) return;
      if (found.dead) {
        pendingRef.current = null;
        setStatus('error');
        setMessage(EXPIRED_LINK_MESSAGE);
        cleanUrl();
        return;
      }
      setEmail(found.email);
    });
  }, [finish]);

  const confirm = useCallback(() => {
    const pending = pendingRef.current;
    if (!pending) return;
    pendingRef.current = null;
    void finish(pending.link, pending.account);
  }, [finish]);

  const decline = useCallback(() => {
    pendingRef.current = null;
    // "Not now": whatever was pending is dropped with the link.
    clearSignInIntents();
    cleanUrl();
    setStatus('idle');
    setMessage(null);
    setEmail(null);
    optionsRef.current.onDecline();
  }, []);

  const reset = useCallback(() => {
    setStatus('idle');
    setMessage(null);
  }, []);

  return { status, message, flow, email, confirm, decline, reset };
}
