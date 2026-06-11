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
 *   GET  /api/events/:id/stats?k=hostKey   host-gated analytics + activity log
 *   POST /api/events/:id/rsvp              name-only "save my spot" from invites
 */

import { EventRoom } from './eventRoom';

export { EventRoom };

interface Env {
  EVENT_ROOM: DurableObjectNamespace;
  LIVE_BUCKET: R2Bucket;
  ALLOWED_ORIGINS: string;
}

const MAX_SEGMENT_BYTES = 32 * 1024 * 1024; // hard cap; ~6.8 Mbps * 10 s is well under this
const MAX_REC_PART_BYTES = 64 * 1024 * 1024; // multipart recording upload part ceiling

/** Host-key gate shared by the recording routes (the DO owns the key). */
async function authHost(env: Env, id: string, key: string | null): Promise<boolean> {
  if (!key) return false;
  const res = await room(env, id).fetch(
    new Request('https://room.internal/auth', { headers: { 'x-host-key': key } }),
  );
  return res.status === 204;
}

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
    'Access-Control-Allow-Methods': 'GET,POST,PUT,OPTIONS',
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
    const m = pathname.match(/^\/api\/events(?:\/([a-z0-9]+))?(?:\/(ws|segments|stats|rsvp|recordings))?(?:\/(\d+))?$/);
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

      // GET /api/events/:id/stats?k=hostKey — analytics + activity log (host only)
      if (sub === 'stats' && req.method === 'GET') {
        return withCors(await roomCall(env, id, `/stats${url.search}`), cors);
      }

      // POST /api/events/:id/rsvp — save a spot on the invite page (name only)
      if (sub === 'rsvp' && req.method === 'POST') {
        return withCors(
          await roomCall(env, id, '/rsvp', {
            method: 'POST',
            body: await req.text(),
            headers: { 'content-type': 'application/json' },
          }),
          cors,
        );
      }

      // /api/events/:id/recordings — host's server-side recording store.
      // Multipart upload (R2) so multi-GB masters fit through Worker limits:
      //   POST ?op=init {file,mime}            → { key, uploadId }
      //   PUT  ?op=part&key&uploadId&n=…       → { partNumber, etag }
      //   POST ?op=complete {key,uploadId,parts,file,bytes,mime,durMs}
      //   GET  ?k=hostKey                      → { recordings, expiresAt }
      //   GET  ?k=hostKey&download=<key>       → the file (attachment)
      if (sub === 'recordings') {
        const op = url.searchParams.get('op');
        const hostKey = req.headers.get('x-host-key') ?? url.searchParams.get('k');

        if (req.method === 'GET') {
          if (!(await authHost(env, id, hostKey))) return withCors(json({ error: 'forbidden' }, 403), cors);
          const download = url.searchParams.get('download');
          if (download) {
            if (!download.startsWith(`events/${id}/rec/`)) return withCors(json({ error: 'bad key' }, 400), cors);
            const obj = await env.LIVE_BUCKET.get(download);
            if (!obj) return withCors(json({ error: 'recording not found (expired?)' }, 404), cors);
            const filename = download.split('/').pop() || 'recording';
            return withCors(
              new Response(obj.body, {
                headers: {
                  'content-type': obj.httpMetadata?.contentType || 'video/webm',
                  'content-disposition': `attachment; filename="${filename.replace(/"/g, '')}"`,
                  'content-length': String(obj.size),
                },
              }),
              cors,
            );
          }
          return withCors(await roomCall(env, id, `/rec/list?k=${encodeURIComponent(hostKey ?? '')}`), cors);
        }

        if (!(await authHost(env, id, hostKey))) return withCors(json({ error: 'forbidden' }, 403), cors);

        if (req.method === 'POST' && op === 'init') {
          const { file, mime } = (await req.json().catch(() => ({}))) as { file?: string; mime?: string };
          const safe = String(file ?? 'recording.webm').replace(/[^\w.-]/g, '_').slice(0, 80);
          const key = `events/${id}/rec/${Date.now()}-${safe}`;
          const upload = await env.LIVE_BUCKET.createMultipartUpload(key, {
            httpMetadata: { contentType: String(mime ?? 'video/webm') },
          });
          return withCors(json({ key, uploadId: upload.uploadId }), cors);
        }

        if (req.method === 'PUT' && op === 'part') {
          const key = url.searchParams.get('key') ?? '';
          const uploadId = url.searchParams.get('uploadId') ?? '';
          const n = Number(url.searchParams.get('n'));
          if (!key.startsWith(`events/${id}/rec/`) || !uploadId || !Number.isFinite(n) || n < 1) {
            return withCors(json({ error: 'bad part request' }, 400), cors);
          }
          const body = await req.arrayBuffer();
          if (body.byteLength === 0 || body.byteLength > MAX_REC_PART_BYTES) {
            return withCors(json({ error: 'part size out of bounds' }, 413), cors);
          }
          const upload = env.LIVE_BUCKET.resumeMultipartUpload(key, uploadId);
          const part = await upload.uploadPart(n, body);
          return withCors(json({ partNumber: part.partNumber, etag: part.etag }), cors);
        }

        if (req.method === 'POST' && op === 'complete') {
          const body = (await req.json().catch(() => ({}))) as {
            key?: string;
            uploadId?: string;
            parts?: { partNumber: number; etag: string }[];
            file?: string;
            bytes?: number;
            mime?: string;
            durMs?: number;
          };
          const key = String(body.key ?? '');
          if (!key.startsWith(`events/${id}/rec/`) || !body.uploadId || !Array.isArray(body.parts)) {
            return withCors(json({ error: 'bad complete request' }, 400), cors);
          }
          const upload = env.LIVE_BUCKET.resumeMultipartUpload(key, body.uploadId);
          await upload.complete(body.parts);
          const res = await roomCall(env, id, '/rec/register', {
            method: 'POST',
            body: JSON.stringify({ key, file: body.file, bytes: body.bytes, mime: body.mime, durMs: body.durMs }),
            headers: { 'content-type': 'application/json', 'x-host-key': hostKey ?? '' },
          });
          if (!res.ok) return withCors(res, cors);
          return withCors(json({ ok: true, key }), cors);
        }

        return withCors(json({ error: 'bad recordings request' }, 400), cors);
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
