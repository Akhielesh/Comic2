/**
 * The public shell's share of App's routing: browser Back / Forward between the public top-level pages,
 * and where the floating launchers may sit.
 *
 * App routes with one `currentView` state. `handleNavigate` pushes a history entry for each page and the
 * ?view= sync effect rewrites the current entry's address (replaceState), but nothing listened for the
 * browser's own traversal, so Back changed the address and left the page on screen (Home → How it works →
 * Back stayed on How it works). `usePublicViewHistory` restores the page an entry names.
 *
 * Strictly scoped to the public pages. Comic Studio, both readers and their sheets push entries of their
 * own and handle their own Back (components/comicstudio/mobile/backStack.ts, ComicReader, the immersive
 * reader), and the signed-in workspaces keep App's existing behaviour: when the page on screen OR the page
 * the entry names is anything else, the listener does nothing at all.
 */
import { useEffect } from 'react';
import { usePhoneViewport } from './useMediaQuery';

/** The public top-level pages Back and Forward move between (each has its own address). */
export const PUBLIC_HISTORY_VIEWS: ReadonlySet<string> = new Set(['home', 'how-it-works', 'gallery', 'models', 'privacy', 'terms', 'auth']);

/**
 * Pages that only ever show the sign-in page to a signed-out visitor (App's isProtectedViewStrict, minus the
 * project workspaces, whose addresses carry a project id and are never ours). Signed out, they are public too:
 * Home → "Comic Studio" (the sign-in page) → Back returns home. Signed in, they are workspaces: no-op.
 */
const SIGN_IN_GATED_VIEWS: ReadonlySet<string> = new Set(['dashboard', 'chat', 'learn', 'settings', 'ventures']);

/** Public pages that can be left with Back but never restored (they need state the address does not carry). */
const LEAVE_ONLY_VIEWS: ReadonlySet<string> = new Set(['profile']);

/** A page Back / Forward may restore, for this visitor. */
export const isRestorablePublicView = (view: string, signedIn: boolean): boolean =>
  PUBLIC_HISTORY_VIEWS.has(view) || (!signedIn && SIGN_IN_GATED_VIEWS.has(view));

/**
 * The public page a history entry's address names, or null when it names anything else: another path
 * (/c/<slug>, /share/…, /auth/callback, a legal document's own path), a reader or workspace entry
 * (?view=read&id=…, ?view=studio&id=…, ?board=…) or a view this listener does not restore.
 */
export function publicViewFromLocation(loc: Pick<Location, 'pathname' | 'search'>, signedIn = false): string | null {
  const path = loc.pathname.replace(/\/+$/, '') || '/';
  if (path === '/models') return 'models';
  if (path !== '/') return null;
  const params = new URLSearchParams(loc.search);
  if (params.has('id') || params.has('board')) return null;
  const view = params.get('view');
  if (view === null) return 'home';
  return isRestorablePublicView(view, signedIn) ? view : null;
}

/**
 * Browser Back / Forward between the public pages restore the page the entry names. A no-op when the page on
 * screen or the entry's page is a studio, a reader, chat (signed in) or any signed-in workspace, and when the
 * entry names the page already shown (a #fragment jump).
 *
 * Also keeps a public page's address honest: handleNavigate gives the model catalog its own path (/models)
 * and the ?view= sync only rewrites the query, so leaving the catalog for Home kept /models in the address
 * (a refresh reopened the catalog, and Forward from it did too). On a public page other than the catalog the
 * path goes back to "/" (replaceState: no new entry). Declared after App's ?view= sync effect, so it runs
 * after it.
 */
export function usePublicViewHistory<V extends string>(view: V, restore: (view: NoInfer<V>) => void, signedIn: boolean): void {
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const onPopState = () => {
      if (!isRestorablePublicView(view, signedIn) && !LEAVE_ONLY_VIEWS.has(view)) return;
      const target = publicViewFromLocation(window.location, signedIn);
      if (!target || target === view) return;
      restore(target as V);
    };
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, [view, restore, signedIn]);

  useEffect(() => {
    if (typeof window === 'undefined' || view === 'models' || !PUBLIC_HISTORY_VIEWS.has(view)) return;
    if (window.location.pathname.replace(/\/+$/, '') !== '/models') return;
    try {
      window.history.replaceState(window.history.state, '', `/${window.location.search}${window.location.hash}`);
    } catch {
      /* history unavailable: the page still shows */
    }
  }, [view]);
}

/**
 * Public surfaces: marketing, legal, sign-in, the library and the catalog (App's effective view — a
 * signed-out visitor on a gated page is already 'auth' there).
 */
export const isPublicSurface = (effectiveView: string): boolean => PUBLIC_HISTORY_VIEWS.has(effectiveView) || LEAVE_ONLY_VIEWS.has(effectiveView);

/**
 * On a phone, the floating launchers (the assistant's bottom-left button, the bottom-right Feedback pill)
 * sat on the public pages' hero calls to action and footers. There they step aside: the assistant's launcher
 * is not drawn (an assistant already open stays open) and the Feedback pill is not mounted. Tablets,
 * desktops and every signed-in workspace keep both.
 */
export const collapsesFloatingChrome = (effectiveView: string, phone: boolean): boolean => phone && isPublicSurface(effectiveView);

/** The phone check for collapsesFloatingChrome (a hook, so App calls it before its early returns). */
export const useFloatingChromePhone = usePhoneViewport;
