// Routing rules for the Comic Studio host (comics.dreamstreamstudio.ai). Pure functions: the hook
// (useComicsHost) and App.tsx call them; the edge Worker (comics-edge) handles the path-level
// equivalents (/live*, /models, /share/* → main site) before the SPA even loads.

import { mainAppUrl } from '../../services/productHost';

/** App views that belong to OTHER DreamStream products. On the comics host they open on the main
 *  site instead (its own session there), never inside Comic Studio. */
export const OFF_HOST_VIEWS: ReadonlySet<string> = new Set(['chat', 'ventures', 'models']);

/** Main-site URL for an off-host view (paths match how the main app restores each view). */
export const offHostUrlForView = (view: string): string | null => {
  if (!OFF_HOST_VIEWS.has(view)) return null;
  if (view === 'models') return mainAppUrl('/models');
  return mainAppUrl(`/?view=${encodeURIComponent(view)}`);
};

/** Query keys that mean "this load already has somewhere to go" (deep links, auth round trips,
 *  invites, the ?next= hand-back) — the comics host must not override them with its own boot. */
const INTENT_PARAMS = ['view', 'id', 'board', 'next', 'invite', 'code', 'token_hash', 'type', 'error', 'error_description'];

/**
 * True when a signed-in visitor opened the bare comics host (`/`, maybe with harmless tracking
 * params such as ?source=pwa) and should go straight to their comics (the dashboard).
 */
export const shouldBootToDashboard = (location: { pathname: string; search: string; hash: string }): boolean => {
  if (location.pathname !== '/' && location.pathname !== '') return false;
  const params = new URLSearchParams(location.search);
  if (INTENT_PARAMS.some((key) => params.has(key))) return false;
  const hash = location.hash.startsWith('#') ? location.hash.slice(1) : location.hash;
  if (/(^|&)(access_token|refresh_token|token_hash|error_description)=/.test(hash)) return false;
  return true;
};

/** Public Comic Studio views keep the product chrome before and after sign-in. */
export const COMICS_CHROME_VIEWS: ReadonlySet<string> = new Set(['home', 'auth', 'privacy', 'terms', 'gallery']);

/** Which view the comics header is drawn over (it hides "Sign in" on the sign-in page, marks the Library). */
export type ComicsHeaderCurrent = 'auth' | 'gallery' | 'other';

export interface ComicsChrome {
  /** The comics host draws this view's chrome: the suite header steps aside (App's StaticSiteHeader). */
  owns: boolean;
  /** App renders ComicsHeader above the view (the landing renders its own). */
  header: boolean;
  /** The floating widgets (Feedback pill, assistant launcher) may show; never over the comics host's own views. */
  widgets: boolean;
  /** What ComicsHeader is drawn over, when App renders it. */
  current: ComicsHeaderCurrent;
}

/**
 * The comics host's chrome for one view, as App.tsx renders it. The landing is always the comics host's own; the
 * sign-in, Privacy, Terms and Library views are too, so the journey from the landing stays in one product even
 * after sign-in. Account settings remain reachable from ComicsHeader. Other app views keep their existing header,
 * and off the comics host nothing changes. Pure, so every rule is unit-tested without rendering App.
 */
export const comicsChromeFor = (view: string, { active }: { active: boolean; signedIn: boolean }): ComicsChrome => {
  const owns = active && COMICS_CHROME_VIEWS.has(view);
  return {
    owns,
    header: owns && view !== 'home',
    widgets: !owns,
    current: view === 'auth' ? 'auth' : view === 'gallery' ? 'gallery' : 'other'
  };
};
