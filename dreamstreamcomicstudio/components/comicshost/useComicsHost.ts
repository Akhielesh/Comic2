// Host-aware boot for Comic Studio on comics.dreamstreamstudio.ai — the ONE seam App.tsx calls.
// On the apex (and localhost, previews) it is inert: active=false, no effects, nothing changes.
//
// On the comics host:
//   - a signed-in visitor opening the bare host goes straight to their comics (the dashboard;
//     product gating for `comic_studio` still applies there, in App.tsx);
//   - a signed-out visitor sees the Comic Studio landing (App renders <ComicsLanding/> for 'home');
//   - the landing's own chrome (ComicsHeader, no floating widgets) carries on into the views a visitor
//     reaches from it — sign-in, Privacy, Terms and the Library — before and after sign-in. Account settings
//     remain reachable from the product menu, and each view change starts at the top of the page (never
//     with its title under the sticky header);
//   - views that belong to other products (Chat Studio, Operator Console, model catalog) open on
//     the main site instead (replace(), so Back never loops), and nothing of theirs renders here.
// Deep links (?view=studio&id=…, ?view=read…), auth callbacks, invites and the ?next= hand-back
// keep their existing handling: the boot only applies to a load with no intent of its own.

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { isComicsHost } from '../../services/productHost';
import { useComicThemeScope } from '../comicstudio/useComicTheme';
import { OFF_HOST_VIEWS, comicsChromeFor, offHostUrlForView, shouldBootToDashboard } from './hostRouting';

export interface UseComicsHostOptions {
  /** App's current (requested) view. */
  view: string;
  setView: (view: 'dashboard') => void;
  signedIn: boolean;
  /** Auth (and the app's own boot checks) resolved — before this, nothing is decided. */
  ready: boolean;
  /** For tests; defaults to the current location's hostname. */
  hostname?: string;
  /** For tests; defaults to window.location.replace. */
  navigate?: (url: string) => void;
}

export interface ComicsHostBoot {
  /** True on comics.dreamstreamstudio.ai (and its alias). */
  active: boolean;
  /** True while the current view is being handed to the main site (render a loader, not the view). */
  leaving: boolean;
  /**
   * The comics host renders its own chrome for the landing, sign-in, Privacy, Terms and the Library, regardless
   * of sign-in state. The suite header and floating widgets step aside; the product menu retains account access.
   */
  ownsChrome: (view: string) => boolean;
}

const snapshotBoot = (): boolean => {
  if (typeof window === 'undefined') return false;
  const { pathname, search, hash } = window.location;
  return shouldBootToDashboard({ pathname, search, hash });
};

// The boot decision runs before paint, so a signed-in visitor never sees one frame of the landing
// on the way to their comics. (useEffect on the server, where layout effects do not run.)
const useBeforePaint = typeof window === 'undefined' ? useEffect : useLayoutEffect;

export function useComicsHost({ view, setView, signedIn, ready, hostname, navigate }: UseComicsHostOptions): ComicsHostBoot {
  const active = isComicsHost(hostname);
  useComicThemeScope(active);
  // Read the URL during the FIRST render, before App's URL-sync effect rewrites ?view=/&id=.
  const [bootEligible] = useState(snapshotBoot);
  const bootDecidedRef = useRef(false);
  const leaving = active && OFF_HOST_VIEWS.has(view);

  useBeforePaint(() => {
    if (!active || !ready || bootDecidedRef.current) return;
    bootDecidedRef.current = true; // decided once per load: later "home" clicks show the landing
    if (signedIn && view === 'home' && bootEligible) setView('dashboard');
  }, [active, ready, signedIn, view, bootEligible, setView]);

  // A view change on the comics host starts at the top of the page (a Library click used to land mid-page, its
  // title under the sticky header). Not on the first render: the browser restores a reload's position itself.
  const lastViewRef = useRef(view);
  useEffect(() => {
    if (lastViewRef.current === view) return;
    lastViewRef.current = view;
    if (!active || typeof window === 'undefined') return;
    try {
      window.scrollTo({ top: 0 });
    } catch {
      /* no scrolling outside a browser */
    }
  }, [active, view]);

  useEffect(() => {
    if (!leaving) return;
    const target = offHostUrlForView(view);
    if (!target) return;
    if (navigate) navigate(target);
    else window.location.replace(target);
  }, [leaving, view, navigate]);

  return {
    active,
    leaving,
    ownsChrome: (v: string) => comicsChromeFor(v, { active, signedIn }).owns
  };
}
