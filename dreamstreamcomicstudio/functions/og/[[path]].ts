/**
 * GET|HEAD /og/<assetKey>/og-<lang>-<hash>.jpg — the software-made link-preview image of a
 * published comic, served SAME-ORIGIN (Twitterbot honours robots.txt for the image URL too, and
 * /api/ is disallowed there). Streams the public object from the FIXED Supabase host — the path
 * is validated against a strict pattern first, so nothing user-supplied ever reaches the URL
 * beyond an opaque key + content-hashed file name. No redirects followed; JPEG only; ≤ 2 MB.
 */
import { supabaseOrigin, type SupabaseEnv } from '../_shared/supabaseRpc';

const OG_FILE_RE = /^\/og\/([A-Za-z0-9]{22})\/(og-[a-z0-9]{2,12}-[0-9a-f]{12}\.jpg)$/;
const MAX_BYTES = 2 * 1024 * 1024;
const BUCKET = 'comic-assets';

interface OgContext {
  request: Request;
  env: SupabaseEnv & { STORAGE_BUCKET?: string };
}

const notFound = () => new Response('Not found', { status: 404, headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' } });

export async function handleOg(request: Request, env: OgContext['env'], fetchImpl: typeof fetch = fetch): Promise<Response> {
  if (request.method !== 'GET' && request.method !== 'HEAD') return new Response(null, { status: 405, headers: { allow: 'GET, HEAD' } });
  const m = OG_FILE_RE.exec(new URL(request.url).pathname);
  if (!m) return notFound();
  const bucket = env.STORAGE_BUCKET && /^[a-z0-9-]{3,63}$/.test(env.STORAGE_BUCKET) ? env.STORAGE_BUCKET : BUCKET;
  const target = `${supabaseOrigin(env)}/storage/v1/object/public/${bucket}/pub/${m[1]}/${m[2]}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
    const upstream = await fetchImpl(target, { method: 'GET', redirect: 'manual', signal: controller.signal });
    if (upstream.status !== 200 || !upstream.body) return notFound();
    const length = Number(upstream.headers.get('content-length') || '0');
    if (length > MAX_BYTES) return notFound();
    const headers = new Headers({
      'content-type': 'image/jpeg',
      'cache-control': 'public, max-age=86400',
      'x-content-type-options': 'nosniff',
      'cross-origin-resource-policy': 'cross-origin',
      'content-security-policy': "default-src 'none'; sandbox"
    });
    if (length > 0) headers.set('content-length', String(length));
    return new Response(request.method === 'HEAD' ? null : upstream.body, { status: 200, headers });
  } catch {
    return notFound();
  } finally {
    clearTimeout(timer);
  }
}

export const onRequest = ({ request, env }: OgContext): Promise<Response> => handleOg(request, env);
