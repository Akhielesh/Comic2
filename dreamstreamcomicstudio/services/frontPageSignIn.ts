// A main-site sign-in link that the front page redirect carried to Comic Studio goes back to the main site.
//
// The edge sends the main site's bare front page to https://comics.dreamstreamstudio.ai/ (services/productHost.ts
// frontPageToComicsUrl), and it cannot see the fragment. When the auth server builds a link itself (a dashboard invite
// or recovery, or a redirect it does not allow) it lands on the Supabase Site URL, the bare main front page, with the
// sign-in in the fragment (`/#access_token=…&refresh_token=…&type=…`, or `/#error=…&error_code=…`). The browser keeps
// the fragment across the 302, so that link would finish on the comics host, where no main-site session is made.
//
// Comic Studio's own links always land on its /auth/callback (productHost resolveAuthRedirectUrl), so a sign-in link
// in the fragment of the comics host's bare front page can only be one of those main-site links. index.tsx asks this
// before anything renders and, on a match, replaces the page with the main front page's escape hatch (/?home=1, never
// redirected) and the same fragment, where the main app reads it as it always has (hooks/useAuthLinkCallback). Nothing
// here reads, checks or uses a token: it only decides which host's page the link opens on.
import { readMainAuthLink } from './authLink';
import { MAIN_FRONT_PAGE_TO_COMICS, MAIN_ORIGIN, isComicsHost, isTrackingKey, mainFrontPageUrl } from './productHost';

/**
 * Where to send this page instead, or null to stay. Pure. A match needs all of: the redirect switch on, the comics
 * host (or its alias), the path exactly '/', a query that is empty or tracking keys only (all the redirect carries),
 * and a fragment the main app reads as a sign-in link on its front page.
 */
export const signInLinkBackToMain = (href: string, on: boolean = MAIN_FRONT_PAGE_TO_COMICS): string | null => {
  if (!on) return null;
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return null;
  }
  if (!isComicsHost(url.hostname) || url.pathname !== '/' || url.hash.length < 2) return null;
  for (const key of url.searchParams.keys()) if (!isTrackingKey(key)) return null;
  // Read the fragment alone, as the main app would on its own front page.
  if (!readMainAuthLink(new URL(`${MAIN_ORIGIN}/${url.hash}`))) return null;
  return mainFrontPageUrl(url.hash);
};
