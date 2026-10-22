/**
 * GET|HEAD /c/<slug>[/<title-tail>|/embed] — a shared comic (sharing.md §5.2, contract §14).
 *
 * Returns the SPA's own index.html to EVERY client with the comic's preview head injected
 * (renderShareHead). Card data comes from the anon RPC `comic_share_card` over the public key,
 * so a WhatsApp/X/iMessage preview never wakes the backend container. Read-only by nature:
 * this function only ever reads one allow-listed card.
 *
 *  - Malformed slug → 404 without any lookup (the shape is public knowledge).
 *  - Unknown / revoked / unpublished / suspended → the SAME 404 bytes and headers (no oracle).
 *  - Database slow or down (1.5 s) → the plain SPA, 200, no-store: people still get the app.
 *  - /embed when the author turned embedding off → the same 404.
 *  - Headers: enforced CSP with hashed inline scripts, nosniff, Referrer-Policy, frame-ancestors
 *    'self' (+ X-Frame-Options) except /embed, noindex/noai for unlisted, no-store everywhere so a
 *    revoked link stops working at once.
 */
import { parseShareParams, SLUG_RE } from '../../shared/comic/publication';
import { buildCsp, inlineHashes } from '../_shared/csp';
import { injectHead, notFoundHead, renderShareHead, validateShareCardRpc, type ShareCardRpc } from '../_shared/shareHead';
import { rpc, supabaseOrigin, type SupabaseEnv } from '../_shared/supabaseRpc';

export interface ShareEnv extends SupabaseEnv {
  ASSETS: { fetch(input: Request | string | URL, init?: RequestInit): Promise<Response> };
}

interface ShareContext {
  request: Request;
  env: ShareEnv;
}

const TAIL_RE = /^[a-z0-9-]{1,80}$/;

export interface ParsedSharePath {
  slug: string;
  embed: boolean;
}

/** /c/<slug>, /c/<slug>/, /c/<slug>/<title-tail>, /c/<slug>/embed → parts; anything else → null. */
export function parseSharePath(pathname: string): ParsedSharePath | null {
  const m = /^\/c\/([^/]+)(?:\/([^/]+))?\/?$/.exec(pathname);
  if (!m || !SLUG_RE.test(m[1])) return null;
  const tail = m[2];
  if (tail !== undefined && tail !== 'embed' && !TAIL_RE.test(tail)) return null;
  return { slug: m[1], embed: tail === 'embed' };
}

const BASE_HEADERS: Record<string, string> = {
  'content-type': 'text/html; charset=utf-8',
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'strict-origin-when-cross-origin',
  'permissions-policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
  'cross-origin-opener-policy': 'same-origin-allow-popups'
};

async function shell(env: ShareEnv, request: Request): Promise<string> {
  const res = await env.ASSETS.fetch(new URL('/', request.url).toString());
  return res.ok ? res.text() : '<!doctype html><html><head><meta charset="utf-8"><!--ds:head--></head><body><div id="root"></div></body></html>';
}

async function respond(request: Request, env: ShareEnv, html: string, status: number, extra: Record<string, string>, embed: boolean): Promise<Response> {
  const headers = new Headers(BASE_HEADERS);
  headers.set('content-security-policy', buildCsp({ hashes: await inlineHashes(html), supabaseOrigin: supabaseOrigin(env), embed }));
  if (!embed) headers.set('x-frame-options', 'SAMEORIGIN');
  for (const [k, v] of Object.entries(extra)) headers.set(k, v);
  return new Response(request.method === 'HEAD' ? null : html, { status, headers });
}

/** The single not-found answer: identical bytes and headers for every dead or unknown link. */
export async function notFound(request: Request, env: ShareEnv): Promise<Response> {
  const html = injectHead(await shell(env, request), notFoundHead());
  return respond(request, env, html, 404, { 'x-robots-tag': 'noindex, nofollow, noarchive, noai, noimageai' }, false);
}

export async function handleShare(request: Request, env: ShareEnv): Promise<Response> {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return new Response(null, { status: 405, headers: { allow: 'GET, HEAD', 'cache-control': 'no-store' } });
  }
  const url = new URL(request.url);
  const parsed = parseSharePath(url.pathname);
  if (!parsed) return notFound(request, env);

  const result = await rpc<unknown>(env, 'comic_share_card', { p_slug: parsed.slug });
  if (!result.ok) {
    // Database slow/down: people still get the app (it shows its own error if the read fails too).
    const html = await shell(env, request);
    return respond(request, env, html, 200, { 'x-robots-tag': 'noindex' }, false);
  }
  const card: ShareCardRpc | null = validateShareCardRpc(result.data);
  if (!card || card.slug !== parsed.slug || (parsed.embed && !card.allowEmbed)) return notFound(request, env);

  const params = parseShareParams(url.search);
  const head = renderShareHead(card, { origin: url.origin, lang: params.lang, page: params.page, embed: parsed.embed });
  const html = injectHead(await shell(env, request), head);
  const robots = card.visibility === 'public' && !parsed.embed ? 'noai, noimageai' : 'noindex, nofollow, noarchive, noai, noimageai';
  const extra: Record<string, string> = { 'x-robots-tag': robots, vary: 'accept-language' };
  if (card.visibility === 'public') extra['content-signal'] = 'search=yes, ai-train=no, ai-input=no';
  return respond(request, env, html, 200, extra, parsed.embed);
}

export const onRequest = ({ request, env }: ShareContext): Promise<Response> => handleShare(request, env);
