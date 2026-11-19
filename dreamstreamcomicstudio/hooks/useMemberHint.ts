// The main site's member hint cookie (services/productHost.ts) follows signing in and out in this tab. It only
// observes the auth state App already has; nothing about sign-in, sessions or roles changes here.
import { useEffect, useRef } from 'react';
import { syncMemberHint } from '../services/productHost';

/**
 * - Set while this tab has a signed-in user.
 * - Removed only when a user this tab had signs out (or the session ends) in this tab.
 * - Never removed just because a tab starts without a session: with "Remember me" off each tab keeps its own
 *   session, so a new tab opens signed out while another tab is still signed in, and that must not cost the
 *   member their front page. A hint left behind by a session that lapsed while away grants nothing; it only
 *   serves that browser the main front page, where the person can sign in again.
 */
export function useMemberHint(signedIn: boolean, loading: boolean): void {
  const hadUser = useRef(false);
  useEffect(() => {
    if (loading) return;
    if (signedIn) {
      hadUser.current = true;
      syncMemberHint(true);
    } else if (hadUser.current) {
      hadUser.current = false;
      syncMemberHint(false);
    }
  }, [signedIn, loading]);
}
