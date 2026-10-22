/**
 * Cloudflare Pages middleware for dreamstreamstudio.ai — the page half of the AI-agent gate.
 *
 * AI agents (and automated browsers) asking for a page are redirected to the check-in at
 * /api/agent-gate, which the dreamstream-api Worker answers at the edge (questionnaire,
 * synthetic sample record, logging). Everyone else — people, search engines, link-preview
 * bots, plain HTTP clients like the ops smoke scripts — gets the app exactly as before.
 *
 * It also sends the hosts that only redirect (www and the Pages production alias) to the
 * custom domain first, so there is one site and one sign-in.
 *
 * public/_routes.json keeps this function off static assets, so it only runs for page loads.
 * Detection lives in api-proxy/src/agent-gate.ts so the page and API halves never drift.
 */
import { detectAgent } from '../api-proxy/src/agent-gate';

interface PagesContext {
  request: Request;
  next: () => Promise<Response>;
}

const CANONICAL_ORIGIN = 'https://dreamstreamstudio.ai';
/** Hosts that only redirect: www and the Pages production alias would each keep a separate
 *  session (localStorage is per host). Exact match, so preview and branch deploys
 *  (<hash>.comic2.pages.dev, <branch>.comic2.pages.dev) keep serving. */
const REDIRECT_HOSTS = new Set(['www.dreamstreamstudio.ai', 'comic2.pages.dev']);

/** Crawl policy files and the pretty check-in URL stay reachable for every client. */
function isOpenPath(pathname: string): boolean {
  return pathname === '/robots.txt' || pathname === '/llms.txt' || pathname.startsWith('/.well-known/');
}

export const onRequest = async ({ request, next }: PagesContext): Promise<Response> => {
  const url = new URL(request.url);
  // One site, one sign-in. Path and query are kept; browsers re-attach the #fragment
  // (host keys, guest keys, auth tokens) to a fragment-less Location (RFC 9110 §10.2.2).
  if (REDIRECT_HOSTS.has(url.hostname)) {
    return new Response(null, { status: 301, headers: { location: `${CANONICAL_ORIGIN}${url.pathname}${url.search}` } });
  }
  if (isOpenPath(url.pathname)) return next();

  const isCheckinAlias = url.pathname === '/agents' || url.pathname === '/agents/';
  const agent = isCheckinAlias ? null : detectAgent(request, 'page');
  if (!agent && !isCheckinAlias) return next();

  const target = new URL('/api/agent-gate', url.origin);
  if (!isCheckinAlias) target.searchParams.set('from', url.pathname);
  const via = url.searchParams.get('via');
  if (via === 'webdriver') target.searchParams.set('via', via);
  return new Response(null, {
    status: 302,
    headers: {
      location: target.toString(),
      'cache-control': 'no-store',
      vary: 'user-agent',
      'x-robots-tag': 'noindex, nofollow, noarchive, nosnippet, noai, noimageai',
    },
  });
};
