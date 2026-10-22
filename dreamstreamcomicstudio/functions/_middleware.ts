/**
 * Cloudflare Pages middleware for dreamstreamstudio.ai — the page half of the AI-agent gate.
 *
 * AI agents (and automated browsers) asking for a page are redirected to the check-in at
 * /api/agent-gate, which the dreamstream-api Worker answers at the edge (questionnaire,
 * synthetic sample record, logging). Everyone else — people, search engines, link-preview
 * bots, plain HTTP clients like the ops smoke scripts — gets the app exactly as before.
 *
 * It also sends the hosts that only redirect (www and the Pages production alias) to the
 * custom domain first, so there is one site and one sign-in. Requests the Comic Studio front
 * door (comics-edge Worker, comics.dreamstreamstudio.ai) proxies to the Pages origin carry
 * X-Forwarded-Host: comics.dreamstreamstudio.ai and are served, not redirected.
 *
 * Legacy reader links (`/?view=read&id=<uuid>`) of PUBLIC published comics get the comic's
 * preview head with canonical /c/<slug> (the anon RPC only answers for public publications,
 * so an id can never reveal an unlisted slug). Everything else passes through untouched.
 *
 * public/_routes.json keeps this function off static assets, so it only runs for page loads.
 * Detection lives in api-proxy/src/agent-gate.ts so the page and API halves never drift.
 */
import { detectAgent } from '../api-proxy/src/agent-gate';
import { injectHead, renderShareHead, validateShareCardRpc } from './_shared/shareHead';
import { rpc, type SupabaseEnv } from './_shared/supabaseRpc';

interface PagesContext {
  request: Request;
  next: () => Promise<Response>;
  env?: SupabaseEnv;
}

const CANONICAL_ORIGIN = 'https://dreamstreamstudio.ai';
/** Hosts that only redirect: www and the Pages production alias would each keep a separate
 *  session (localStorage is per host). Exact match, so preview and branch deploys
 *  (<hash>.comic2.pages.dev, <branch>.comic2.pages.dev) keep serving. */
const REDIRECT_HOSTS = new Set(['www.dreamstreamstudio.ai', 'comic2.pages.dev']);
/** Front doors that proxy to the Pages origin (comics-edge sets X-Forwarded-Host). */
const PROXIED_HOSTS = new Set(['comics.dreamstreamstudio.ai', 'comic.dreamstreamstudio.ai']);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Crawl policy files and the pretty check-in URL stay reachable for every client. */
function isOpenPath(pathname: string): boolean {
  return pathname === '/robots.txt' || pathname === '/llms.txt' || pathname.startsWith('/.well-known/');
}

/** `/?view=read&id=<uuid>` of a PUBLIC publication → the same preview head as /c/<slug>. */
async function legacyReaderHead(request: Request, url: URL, env: SupabaseEnv | undefined, next: () => Promise<Response>): Promise<Response> {
  const id = url.searchParams.get('id') || '';
  const [res, card] = await Promise.all([next(), UUID_RE.test(id) ? rpc<unknown>(env, 'comic_share_card_by_project', { p_project: id.toLowerCase() }) : Promise.resolve(null)]);
  const rpcCard = card && card.ok ? validateShareCardRpc(card.data) : null;
  if (!rpcCard || rpcCard.visibility !== 'public') return res;
  const type = res.headers.get('content-type') || '';
  if (res.status !== 200 || !type.includes('text/html')) return res;
  const html = injectHead(await res.text(), renderShareHead(rpcCard, { origin: url.origin }));
  const headers = new Headers(res.headers);
  headers.delete('content-length');
  headers.set('cache-control', 'no-store');
  return new Response(request.method === 'HEAD' ? null : html, { status: 200, headers });
}

export const onRequest = async ({ request, next, env }: PagesContext): Promise<Response> => {
  const url = new URL(request.url);
  // One site, one sign-in. Path and query are kept; browsers re-attach the #fragment
  // (host keys, guest keys, auth tokens) to a fragment-less Location (RFC 9110 §10.2.2).
  const forwardedHost = (request.headers.get('x-forwarded-host') || '').trim().toLowerCase();
  if (REDIRECT_HOSTS.has(url.hostname) && !PROXIED_HOSTS.has(forwardedHost)) {
    return new Response(null, { status: 301, headers: { location: `${CANONICAL_ORIGIN}${url.pathname}${url.search}` } });
  }
  if (isOpenPath(url.pathname)) return next();

  const isCheckinAlias = url.pathname === '/agents' || url.pathname === '/agents/';
  const agent = isCheckinAlias ? null : detectAgent(request, 'page');
  if (!agent && !isCheckinAlias) {
    if (url.pathname === '/' && url.searchParams.get('view') === 'read' && url.searchParams.has('id') && (request.method === 'GET' || request.method === 'HEAD')) {
      return legacyReaderHead(request, url, env, next);
    }
    return next();
  }

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
