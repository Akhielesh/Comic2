/**
 * dreamstream-live — API worker for DreamStream Live.
 *
 * Delivery rail: the streamer's browser uploads short self-contained media
 * segments here; they land in R2 (zero egress fees) and viewers fetch them
 * back through the Cloudflare cache, so 100 viewers cost roughly the same as
 * one. Room realtime (chat / lobby / presence / segment notifications) lives
 * in the EventRoom Durable Object.
 *
 * Routes:
 *   POST /api/events                       create an event → { id, hostKey }
 *   GET  /api/events/:id                   public event meta
 *   GET  /api/events/:id/ws                WebSocket → EventRoom
 *   POST /api/events/:id/segments?seq&ms   host uploads one segment (binary body)
 *   GET  /api/events/:id/segments/:seq     viewers fetch a segment (CDN-cached)
 */

import { EventRoom } from './eventRoom';

export { EventRoom };

interface Env {
  EVENT_ROOM: DurableObjectNamespace;
  LIVE_BUCKET: R2Bucket;
  ALLOWED_ORIGINS: string;
}

const MAX_SEGMENT_BYTES = 15 * 1024 * 1024; // hard cap; ~6.8 Mbps * 6 s is well under this

const json = (data: unknown, status = 200, extra: Record<string, string> = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json', ...extra },
  });

function corsHeaders(req: Request, env: Env): Record<string, string> {
  const origin = req.headers.get('Origin');
  if (!origin) return {};
  const allowed = (env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim());
  if (!allowed.includes('*') && !allowed.includes(origin)) return {};
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'content-type,x-host-key',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

const withCors = (res: Response, cors: Record<string, string>) => {
  const out = new Response(res.body, res);
  for (const [k, v] of Object.entries(cors)) out.headers.set(k, v);
  return out;
};

const room = (env: Env, id: string) => env.EVENT_ROOM.get(env.EVENT_ROOM.idFromName(id));

const roomCall = (env: Env, id: string, path: string, init?: RequestInit) =>
  room(env, id).fetch(new Request(`https://room.internal${path}`, init));

const newEventId = () =>
  Array.from(crypto.getRandomValues(new Uint8Array(8)), (b) => 'abcdefghjkmnpqrstuvwxyz23456789'[b % 31]).join('');

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const cors = corsHeaders(req, env);
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });

    const url = new URL(req.url);
    // Behind the site route the worker is mounted at /live-api/* — strip the prefix.
    const pathname = url.pathname.replace(/^\/live-api(?=\/)/, '');
    const m = pathname.match(/^\/api\/events(?:\/([a-z0-9]+))?(?:\/(ws|segments))?(?:\/(\d+))?$/);
    if (!m) return withCors(json({ error: 'not found' }, 404), cors);
    const [, id, sub, seqStr] = m;

    try {
      // POST /api/events — create
      if (!id && req.method === 'POST') {
        const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
        const eventId = newEventId();
        const res = await roomCall(env, eventId, '/init', {
          method: 'POST',
          body: JSON.stringify({ ...body, id: eventId }),
          headers: { 'content-type': 'application/json' },
        });
        if (!res.ok) return withCors(res, cors);
        const { hostKey } = (await res.json()) as { hostKey: string };
        return withCors(json({ id: eventId, hostKey }), cors);
      }

      if (!id) return withCors(json({ error: 'not found' }, 404), cors);

      // GET /api/events/:id — public meta
      if (!sub && req.method === 'GET') {
        return withCors(await roomCall(env, id, '/meta'), cors);
      }

      // GET /api/events/:id/ws — hand the socket to the room (no CORS on WS)
      if (sub === 'ws') {
        return room(env, id).fetch(new Request(`https://room.internal/ws${url.search}`, req));
      }

      // POST /api/events/:id/segments?seq=&ms= — host pushes one segment
      if (sub === 'segments' && req.method === 'POST') {
        const seq = Number(url.searchParams.get('seq'));
        const ms = Number(url.searchParams.get('ms')) || 3000;
        const hostKey = req.headers.get('x-host-key') ?? '';
        if (!Number.isFinite(seq) || seq <= 0) return withCors(json({ error: 'bad seq' }, 400), cors);

        const bytes = await req.arrayBuffer();
        if (bytes.byteLength === 0 || bytes.byteLength > MAX_SEGMENT_BYTES) {
          return withCors(json({ error: 'segment size out of bounds' }, 413), cors);
        }
        const contentType = req.headers.get('content-type') || 'video/webm';
        const key = `events/${id}/seg/${seq}`;
        await env.LIVE_BUCKET.put(key, bytes, { httpMetadata: { contentType } });

        const res = await roomCall(env, id, '/ingest', {
          method: 'POST',
          body: JSON.stringify({ seq, ms, at: Date.now(), mime: contentType }),
          headers: { 'content-type': 'application/json', 'x-host-key': hostKey },
        });
        if (!res.ok) {
          ctx.waitUntil(env.LIVE_BUCKET.delete(key)); // unauthorized upload — don't keep the bytes
          return withCors(res, cors);
        }
        return withCors(json({ ok: true, seq }), cors);
      }

      // GET /api/events/:id/segments/:seq — viewers pull segments via the edge cache
      if (sub === 'segments' && req.method === 'GET' && seqStr) {
        const cache = caches.default;
        const cacheKey = new Request(url.toString());
        const hit = await cache.match(cacheKey);
        if (hit) return withCors(hit, cors);

        const obj = await env.LIVE_BUCKET.get(`events/${id}/seg/${seqStr}`);
        if (!obj) return withCors(json({ error: 'segment not found' }, 404), cors);
        const res = new Response(obj.body, {
          headers: {
            'content-type': obj.httpMetadata?.contentType || 'video/webm',
            // Segments are immutable once written — cache hard so 100 viewers ≈ 1 R2 read.
            'cache-control': 'public, max-age=86400, immutable',
          },
        });
        ctx.waitUntil(cache.put(cacheKey, res.clone()));
        return withCors(res, cors);
      }

      return withCors(json({ error: 'not found' }, 404), cors);
    } catch (err) {
      console.error('live-worker error', err);
      return withCors(json({ error: 'internal error' }, 500), cors);
    }
  },
};
