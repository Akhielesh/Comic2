/**
 * Edge read path for shared comics (sharing.md §5.4, contract §14.1). Runs INSIDE the
 * dreamstream-api Worker, before the container proxy and after the agent gate, so reading a
 * shared comic never wakes (or even reaches) the backend container.
 *
 *   GET|HEAD /api/comic/public/s/:slug          → { publication, doc, urls } (frozen snapshot)
 *   POST     /api/comic/public/s/:slug/event    → 204 always (view / complete / share analytics)
 *   GET      /api/comic/oembed?url=…            → oEmbed JSON for our own /c/<slug> links only
 *   POST     /api/comic/public/s/:slug/report   → NOT handled here (proxied: Turnstile + safety store)
 *
 * READ-ONLY by construction: these handlers only call the anon read RPCs (and the HMAC-proofed
 * tracking RPC); no route here can change a comic. The `publication` object is rebuilt from an
 * allow-list (never forwarded as the RPC returned it: no assetKey, no row internals); it carries
 * the frozen content rating (G / PG / PG-13) only when the RPC sends a known one, and older
 * publications without a rating still load. The snapshot `doc` is the server-built allow-list.
 * Every miss — unknown, revoked, unpublished, suspended, malformed — returns ONE canonical 404 body. Payloads are re-verified: every image
 * path must sit under this publication's opaque pub/<assetKey>/ prefix, or nothing is served.
 * Rate limits use Workers Rate Limiting bindings (no secrets in wrangler.jsonc).
 */
import { comicShareUrl, COMICS_ORIGIN } from '../../services/productHost';
import { SLUG_RE } from '../../shared/comic/publication';
import { escAttr, validateShareCardRpc, type ShareCardRpc } from '../../functions/_shared/shareHead';
import { rpc, supabaseOrigin, type SupabaseEnv } from '../../functions/_shared/supabaseRpc';

export interface RateLimiter {
  limit(opts: { key: string }): Promise<{ success: boolean }>;
}

export interface PublicComicEnv extends SupabaseEnv {
  STORAGE_BUCKET?: string;
  /** Comma-separated site origins allowed to read cross-origin (same var the backend uses). */
  CORS_ORIGIN?: string;
  /** Worker secret: salt for the daily viewer hash + the tracking HMAC (= comic_publication_config.view_salt). */
  SHARE_VIEW_SALT?: string;
  PUBLIC_COMIC_RL?: RateLimiter;
  PUBLIC_EVENT_RL?: RateLimiter;
}

interface Ctx {
  waitUntil(promise: Promise<unknown>): void;
}

const PAYLOAD_RE = /^\/api\/comic\/public\/s\/([^/]+)\/?$/;
const EVENT_RE = /^\/api\/comic\/public\/s\/([^/]+)\/event\/?$/;
const OEMBED_PATH = '/api/comic/oembed';
const NOT_FOUND_BODY = '{"error":{"message":"This comic isn\'t available.","code":"NOT_FOUND"}}';
const SITE_HOSTS = new Set(['comics.dreamstreamstudio.ai', 'comic.dreamstreamstudio.ai', 'dreamstreamstudio.ai', 'www.dreamstreamstudio.ai']);
const EVENT_TYPES = new Set(['view', 'complete', 'share']);
const CHANNELS = new Set(['copy', 'native', 'qr', 'whatsapp', 'x', 'facebook', 'telegram', 'email', 'embed', 'direct']);
const LANG_RE = /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8}){0,2}$/;
/**
 * The content ratings a publication can carry (= shared/comic/safety.ts CONTENT_RATINGS; kept local
 * so the Worker bundle doesn't pull the i18n module in — a test pins the two together).
 */
export const PUBLIC_RATINGS: ReadonlySet<string> = new Set(['G', 'PG', 'PG-13']);
export type PublicRating = 'G' | 'PG' | 'PG-13';
/** A known rating from an RPC answer, else undefined (unknown is never shown, never kids-friendly). */
export const publicRatingOf = (v: unknown): PublicRating | undefined => (typeof v === 'string' && PUBLIC_RATINGS.has(v) ? (v as PublicRating) : undefined);

// ── Responses ────────────────────────────────────────────────────────────────

const SECURITY_HEADERS: Record<string, string> = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'strict-origin-when-cross-origin',
  'cache-control': 'no-store',
  'x-robots-tag': 'noindex'
};

function allowedOrigin(req: Request, env: PublicComicEnv): string | null {
  const origin = req.headers.get('origin');
  if (!origin) return null;
  const allowed = new Set([COMICS_ORIGIN, 'https://dreamstreamstudio.ai', ...(env.CORS_ORIGIN || '').split(',').map((o) => o.trim()).filter(Boolean)]);
  return allowed.has(origin) ? origin : null;
}

function json(req: Request, env: PublicComicEnv, body: string, status = 200, extra: Record<string, string> = {}): Response {
  const headers = new Headers({ 'content-type': 'application/json; charset=utf-8', ...SECURITY_HEADERS, ...extra });
  const origin = allowedOrigin(req, env);
  if (origin) {
    headers.set('access-control-allow-origin', origin);
    headers.set('vary', 'Origin');
  }
  return new Response(req.method === 'HEAD' ? null : body, { status, headers });
}

/** The ONE not-found answer (identical bytes and headers for every miss). */
export const notFound = (req: Request, env: PublicComicEnv): Response => json(req, env, NOT_FOUND_BODY, 404);
const tooMany = (req: Request, env: PublicComicEnv): Response =>
  json(req, env, '{"error":{"message":"Too many requests. Try again in a minute.","code":"RATE_LIMIT"}}', 429, { 'retry-after': '60' });

const clientIp = (req: Request) => (req.headers.get('cf-connecting-ip') || '0.0.0.0').slice(0, 64);

async function allow(limiter: RateLimiter | undefined, key: string): Promise<boolean> {
  if (!limiter) return true;
  try {
    return (await limiter.limit({ key })).success;
  } catch {
    return true; // a limiter outage never takes reading down
  }
}

// ── Payload ──────────────────────────────────────────────────────────────────

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** Every storage path in a snapshot (cover, pages, their variants) — the only images a reader needs. */
export function snapshotImagePaths(doc: Record<string, unknown>): string[] | null {
  const out: string[] = [];
  const add = (render: unknown): boolean => {
    if (!isRecord(render) || !isRecord(render.asset)) return true;
    const asset = render.asset;
    if (typeof asset.path !== 'string') return false;
    out.push(asset.path);
    if (asset.variants !== undefined) {
      if (!Array.isArray(asset.variants)) return false;
      for (const v of asset.variants) {
        if (!isRecord(v) || typeof v.path !== 'string') return false;
        out.push(v.path);
      }
    }
    return true;
  };
  if (isRecord(doc.cover) && !add(doc.cover.render)) return null;
  if (!Array.isArray(doc.pages)) return null;
  for (const page of doc.pages) if (!isRecord(page) || !add(page.render)) return null;
  return out;
}

/** Every "path" string anywhere in the snapshot (defense in depth: nothing outside pub/<key>/). */
function allPathStrings(value: unknown, out: string[] = []): string[] {
  if (Array.isArray(value)) value.forEach((v) => allPathStrings(v, out));
  else if (isRecord(value)) for (const [k, v] of Object.entries(value)) k === 'path' && typeof v === 'string' ? out.push(v) : allPathStrings(v, out);
  return out;
}

export const publicObjectUrl = (env: PublicComicEnv, path: string): string => {
  const bucket = env.STORAGE_BUCKET && /^[a-z0-9-]{3,63}$/.test(env.STORAGE_BUCKET) ? env.STORAGE_BUCKET : 'comic-assets';
  return `${supabaseOrigin(env)}/storage/v1/object/public/${bucket}/${path.split('/').map(encodeURIComponent).join('/')}`;
};

async function handlePayload(req: Request, env: PublicComicEnv, slug: string): Promise<Response> {
  if (req.method !== 'GET' && req.method !== 'HEAD') return json(req, env, '{"error":{"message":"Method not allowed.","code":"METHOD"}}', 405, { allow: 'GET, HEAD' });
  if (!(await allow(env.PUBLIC_COMIC_RL, `payload:${clientIp(req)}`))) return tooMany(req, env);
  if (!SLUG_RE.test(slug)) return notFound(req, env);
  const result = await rpc<unknown>(env, 'comic_public_payload', { p_slug: slug }, { timeoutMs: 4000 });
  if (!result.ok) return json(req, env, '{"error":{"message":"Comics are taking a moment to load. Try again shortly.","code":"UNAVAILABLE"}}', 503, { 'retry-after': '5' });
  const raw = result.data;
  if (!isRecord(raw) || !isRecord(raw.publication) || !isRecord(raw.doc)) return notFound(req, env);
  const pub = raw.publication;
  const card = validateShareCardRpc(pub);
  if (!card || card.slug !== slug) return notFound(req, env);
  const prefix = `pub/${card.assetKey}/`;
  const images = snapshotImagePaths(raw.doc);
  const every = allPathStrings(raw.doc);
  if (!images || every.some((p) => !p.startsWith(prefix) || p.includes('..'))) {
    console.error('public_comic_payload_rejected', { reason: 'path outside the publication prefix' });
    return notFound(req, env);
  }
  const urls: Record<string, string> = {};
  for (const p of images) urls[p] = publicObjectUrl(env, p);
  const rating = publicRatingOf(pub.rating);
  const publication = {
    slug: card.slug,
    visibility: card.visibility,
    languages: card.languages,
    ...(card.defaultLang ? { defaultLang: card.defaultLang } : {}),
    startPage: card.startPage ?? null,
    allowDownload: card.allowDownload,
    allowEmbed: card.allowEmbed,
    publishedAt: typeof pub.publishedAt === 'number' ? pub.publishedAt : 0,
    updatedAt: typeof pub.updatedAt === 'number' ? pub.updatedAt : 0,
    card: card.card,
    ...(rating ? { rating } : {})
  };
  return json(req, env, JSON.stringify({ publication, doc: raw.doc, urls }), 200);
}

// ── Events ───────────────────────────────────────────────────────────────────

const hex = (buf: ArrayBuffer) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');

export async function viewerHash(salt: string, day: string, ip: string, ua: string): Promise<string> {
  return hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${salt}|${day}|${ip}|${ua}`))).slice(0, 32);
}

export async function trackProof(salt: string, slug: string, viewer: string, day: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(salt), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return hex(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${slug}:${viewer}:${day}`)));
}

async function handleEvent(req: Request, env: PublicComicEnv, ctx: Ctx, slug: string, now: number): Promise<Response> {
  const accepted = new Response(null, { status: 204, headers: { ...SECURITY_HEADERS } });
  if (req.method !== 'POST') return json(req, env, '{"error":{"message":"Method not allowed.","code":"METHOD"}}', 405, { allow: 'POST' });
  // Analytics never hold readers up and never answer differently for live vs dead links.
  if (!SLUG_RE.test(slug) || !env.SHARE_VIEW_SALT || env.SHARE_VIEW_SALT.length < 32) return accepted;
  if (!(await allow(env.PUBLIC_EVENT_RL, `event:${clientIp(req)}`))) return accepted;
  if (Number(req.headers.get('content-length') || '0') > 1024) return accepted;
  const text = await req.text().catch(() => '');
  if (!text || text.length > 1024) return accepted;
  let body: Record<string, unknown>;
  try {
    const parsed = JSON.parse(text) as unknown;
    if (!isRecord(parsed)) return accepted;
    body = parsed;
  } catch {
    return accepted;
  }
  if (typeof body.type !== 'string' || !EVENT_TYPES.has(body.type)) return accepted;
  const channel = typeof body.channel === 'string' && CHANNELS.has(body.channel) ? body.channel : 'direct';
  const lang = typeof body.lang === 'string' && LANG_RE.test(body.lang) ? body.lang : '';
  const day = new Date(now).toISOString().slice(0, 10);
  const viewer = await viewerHash(env.SHARE_VIEW_SALT, day, clientIp(req), (req.headers.get('user-agent') || '').slice(0, 300));
  const proof = await trackProof(env.SHARE_VIEW_SALT, slug, viewer, day);
  ctx.waitUntil(rpc(env, 'comic_publication_track', { p_slug: slug, p_event: body.type, p_viewer: viewer, p_channel: channel, p_lang: lang, p_proof: proof }, { timeoutMs: 3000 }));
  return accepted;
}

// ── oEmbed ───────────────────────────────────────────────────────────────────

/** Our own /c/<slug>[/tail] link → slug; anything else (foreign host, other path, credentials) → null. */
export function slugFromShareUrl(raw: string | null): string | null {
  if (!raw || raw.length > 600) return null;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' || u.username || u.password || u.port || !SITE_HOSTS.has(u.hostname)) return null;
  const m = /^\/c\/([A-Za-z0-9]{17})(?:\/(?:embed|[a-z0-9-]{1,80}))?\/?$/.exec(u.pathname);
  return m ? m[1] : null;
}

const ASPECT_RATIO = (aspect: string): number => {
  const [w, h] = aspect.split(':').map(Number);
  return w > 0 && h > 0 ? h / w : 1.5;
};

export function oembedFor(card: ShareCardRpc, origin: string, maxwidth?: number, maxheight?: number, rating?: PublicRating): Record<string, unknown> {
  const title = card.card.title;
  const canonical = comicShareUrl(card.slug);
  const og = card.card.og[card.defaultLang || ''] || Object.values(card.card.og)[0];
  let width = Math.min(560, maxwidth && maxwidth >= 200 ? Math.floor(maxwidth) : 560);
  let height = Math.round(width * ASPECT_RATIO(card.card.aspect)) + 56;
  if (maxheight && maxheight >= 200 && height > maxheight) {
    height = Math.floor(maxheight);
    width = Math.max(200, Math.round((height - 56) / ASPECT_RATIO(card.card.aspect)));
  }
  const out: Record<string, unknown> = {
    version: '1.0',
    type: card.allowEmbed ? 'rich' : 'link',
    provider_name: 'DreamStream Studio',
    provider_url: COMICS_ORIGIN,
    title,
    ...(card.card.creator ? { author_name: card.card.creator } : {}),
    // Provider-specific field (oEmbed 1.0 §2.3.4 allows extras): the frozen publish-time rating.
    ...(rating && PUBLIC_RATINGS.has(rating) ? { content_rating: rating } : {})
  };
  if (og) Object.assign(out, { thumbnail_url: `${origin}/og/${og.path.slice('pub/'.length)}`, thumbnail_width: 1200, thumbnail_height: 630 });
  if (card.allowEmbed) {
    out.width = width;
    out.height = height;
    out.html = `<iframe src="${escAttr(`${canonical}/embed`)}" title="${escAttr(title)}" width="${width}" height="${height}" loading="lazy" allow="fullscreen" referrerpolicy="strict-origin-when-cross-origin" style="border:0;border-radius:12px;max-width:100%"></iframe>`;
  }
  return out;
}

async function handleOembed(req: Request, env: PublicComicEnv, url: URL): Promise<Response> {
  if (req.method !== 'GET' && req.method !== 'HEAD') return json(req, env, '{"error":{"message":"Method not allowed.","code":"METHOD"}}', 405, { allow: 'GET, HEAD' });
  if (!(await allow(env.PUBLIC_COMIC_RL, `oembed:${clientIp(req)}`))) return tooMany(req, env);
  const format = url.searchParams.get('format');
  if (format && format !== 'json') return json(req, env, '{"error":{"message":"Only JSON is supported.","code":"FORMAT"}}', 501);
  const slug = slugFromShareUrl(url.searchParams.get('url'));
  if (!slug) return json(req, env, '{"error":{"message":"Only DreamStream comic links are supported.","code":"BAD_REQUEST"}}', 400);
  const result = await rpc<unknown>(env, 'comic_share_card', { p_slug: slug });
  if (!result.ok) return json(req, env, '{"error":{"message":"Try again shortly.","code":"UNAVAILABLE"}}', 503, { 'retry-after': '5' });
  const card = validateShareCardRpc(result.data);
  if (!card || card.slug !== slug) return notFound(req, env);
  const num = (k: string) => {
    const v = Number(url.searchParams.get(k));
    return Number.isFinite(v) && v > 0 ? v : undefined;
  };
  // no-store (the shared default) and no oEmbed cache_age: a revoked or regenerated link must stop
  // describing the comic at once (addendum: "revoked slugs stop working immediately").
  const rating = isRecord(result.data) ? publicRatingOf(result.data.rating) : undefined;
  return json(req, env, JSON.stringify(oembedFor(card, url.origin, num('maxwidth'), num('maxheight'), rating)), 200);
}

// ── Router ───────────────────────────────────────────────────────────────────

/** Handles the edge public-comic routes; returns null for anything else (the proxy continues). */
export async function handlePublicComic(req: Request, env: PublicComicEnv, ctx: Ctx, url: URL, now = Date.now()): Promise<Response | null> {
  if (url.pathname === OEMBED_PATH) return handleOembed(req, env, url);
  const event = EVENT_RE.exec(url.pathname);
  if (event) return handleEvent(req, env, ctx, event[1], now);
  const payload = PAYLOAD_RE.exec(url.pathname);
  if (payload) return handlePayload(req, env, payload[1]);
  return null;
}
