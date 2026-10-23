/**
 * dreamstream-live — API worker for Stream Studio.
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
 *   POST /api/events/:id/segments?seq&ms   host uploads one segment (binary body; one DO request: /ingest)
 *   GET  /api/events/:id/segments/:seq     viewers fetch a segment (CDN-cached)
 *   GET  /api/events/:id/stats?k=hostKey   host-gated analytics + activity log
 *   POST /api/events/:id/rsvp              name-only "save my spot" from invites
 *
 * Baby Monitor (never records — media is peer-to-peer):
 *   GET  /api/monitor/vapid                Web Push public key
 *   GET  /api/monitor/:nurseryId/ws        WebSocket → MonitorRoom (auth = first frame)
 *   GET  /api/monitor/:nurseryId/export    CSV history (Authorization: Bearer; parents & caregivers)
 *   POST /api/monitor/:nurseryId/guest     share link + passcode → guest pass (no account)
 *
 * Direct calls (Calls → search → call anyone on Stream Studio):
 *   GET  /api/calls/u/:userId/ws           WebSocket → that member's UserLine (auth = first frame, own token)
 *   GET  /api/calls/c/:callId/ws           WebSocket → the call's CallRoom (auth = first frame, call ticket)
 *   (Nothing else under /api/calls: the Durable Objects' /x/* endpoints are internal.)
 *
 * Creating an event requires a signed-in Stream Studio member (welcome-code
 * gated; verified against Supabase with the caller's own token). Watching
 * never needs an account.
 */

import { CallRoom } from './callRoom';
import { CLOUD_COPY_PART_BYTES, cloudCopyUsageFor, copyCompleteRoom, copyPartRoom, oversizeCopy, startCloudCopy, usageBody } from './cloudCopyQuota';
import { userLineName } from './directCalls';
import { EventRoom } from './eventRoom';
import { KEY_HOLDER, MonitorRoom, UUID_RE } from './monitorRoom';
import { bearerFrom, verifyMember } from './supabaseAuth';
import { UserLine } from './userLine';

export { CallRoom, EventRoom, MonitorRoom, UserLine };

export interface Env {
  EVENT_ROOM: DurableObjectNamespace;
  MONITOR_ROOM: DurableObjectNamespace;
  /** Direct calls: one line per member, one room per call. */
  USER_LINE: DurableObjectNamespace;
  CALL_ROOM: DurableObjectNamespace;
  LIVE_BUCKET: R2Bucket;
  ALLOWED_ORIGINS: string;
  SUPABASE_URL?: string;
  SUPABASE_PUBLISHABLE_KEY?: string;
  TURN_KEY_ID?: string;
  TURN_KEY_API_TOKEN?: string;
  /** Workers Analytics Engine dataset `stream_usage` (optional): Stream Studio usage points (usageMeter.ts). */
  STREAM_USAGE?: AnalyticsEngineDataset;
}

const MAX_SEGMENT_BYTES = 32 * 1024 * 1024; // hard cap; ~6.8 Mbps * 10 s is well under this

/** Host-key gate shared by the recording routes (the DO owns the key). */
async function authHost(env: Env, id: string, key: string | null): Promise<boolean> {
  if (!key) return false;
  const res = await room(env, id).fetch(
    new Request('https://room.internal/auth', { headers: { 'x-host-key': key } }),
  );
  return res.status === 204;
}

/**
 * Host passes (feature doc §7 C10): a host key the room has confirmed for an event, remembered by
 * this isolate as its SHA-256, so the next segments skip the room's `/auth` (a billed DO request
 * per segment, 600 a stream-hour). A pass never makes a key valid:
 *   - only the room's yes is remembered — a wrong or old key is asked about every time, and is
 *     refused before anything is written to R2;
 *   - the room's `/ingest` still checks the key on every segment, and a refusal there drops the
 *     pass and the stored segment (so a key the room stopped accepting gets at most one segment
 *     into R2 per isolate, never to a viewer);
 *   - each `/ingest` yes renews it; unused, it lapses after HOST_PASS_TTL_MS.
 */
const HOST_PASS_TTL_MS = 10 * 60_000;
const HOST_PASS_MAX = 512;
const hostPasses = new Map<string, { h: string; until: number }>();

/** Test hook. */
export function resetHostPasses(): void {
  hostPasses.clear();
}

async function keyHash(key: string): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(key)));
  return Array.from(d, (b) => b.toString(16).padStart(2, '0')).join('');
}

function sameHash(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function hasHostPass(id: string, key: string, now: number): Promise<boolean> {
  const p = hostPasses.get(id);
  if (!p || p.until <= now) return false;
  return sameHash(p.h, await keyHash(key));
}

async function grantHostPass(id: string, key: string, now: number): Promise<void> {
  const h = await keyHash(key);
  hostPasses.delete(id); // re-insert: the Map's order is the eviction order (oldest first)
  hostPasses.set(id, { h, until: now + HOST_PASS_TTL_MS });
  while (hostPasses.size > HOST_PASS_MAX) hostPasses.delete(hostPasses.keys().next().value as string);
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
    'Access-Control-Allow-Headers': 'content-type,x-host-key,authorization',
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

    // ---------------------------------------------------------- baby monitor
    const mon = pathname.match(/^\/api\/monitor\/(vapid|[0-9a-f-]{36})(?:\/(ws|export|guest))?$/);
    if (mon) {
      try {
        if (mon[1] === 'vapid' && req.method === 'GET') {
          if (!env.MONITOR_ROOM) return withCors(json({ error: 'monitor unavailable' }, 503), cors);
          const res = await env.MONITOR_ROOM.get(env.MONITOR_ROOM.idFromName(KEY_HOLDER)).fetch(new Request('https://monitor.internal/vapid'));
          const keys = (await res.json()) as { publicKey?: string };
          return withCors(json({ publicKey: keys.publicKey ?? null }, res.ok ? 200 : 503, { 'cache-control': 'public, max-age=3600' }), cors);
        }
        if (mon[2] === 'export' && UUID_RE.test(mon[1]) && req.method === 'GET') {
          const res = await env.MONITOR_ROOM.get(env.MONITOR_ROOM.idFromName(mon[1])).fetch(
            new Request(`https://monitor.internal/export${url.search}`, { headers: { authorization: req.headers.get('authorization') ?? '' } }),
          );
          return withCors(res, cors);
        }
        if (mon[2] === 'guest' && UUID_RE.test(mon[1]) && req.method === 'POST') {
          // Share link + passcode → a guest pass. The room rate-limits and locks out guessing.
          const body = await req.text();
          if (body.length > 2048) return withCors(json({ ok: false, reason: 'bad_link' }, 413), cors);
          const res = await env.MONITOR_ROOM.get(env.MONITOR_ROOM.idFromName(mon[1])).fetch(
            new Request(`https://monitor.internal/guest?nid=${mon[1]}`, {
              method: 'POST',
              body,
              // A signed-in person's own token (optional): the room asks Supabase who they are.
              headers: { 'content-type': 'application/json', 'cf-connecting-ip': req.headers.get('cf-connecting-ip') ?? '', authorization: req.headers.get('authorization') ?? '' },
            }),
          );
          return withCors(new Response(res.body, { status: res.status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } }), cors);
        }
        if (mon[2] === 'ws' && UUID_RE.test(mon[1])) {
          // Auth happens on the first frame inside the room (no tokens in URLs/logs).
          return env.MONITOR_ROOM.get(env.MONITOR_ROOM.idFromName(mon[1])).fetch(
            new Request(`https://monitor.internal/ws?nid=${mon[1]}`, req),
          );
        }
      } catch (err) {
        console.error('monitor route error', err);
        return withCors(json({ error: 'internal error' }, 500), cors);
      }
      return withCors(json({ error: 'not found' }, 404), cors);
    }

    // ---------------------------------------------------------- direct calls
    // Strict: a member's line or a call's room, sockets only.
    if (pathname.startsWith('/api/calls/')) {
      const line = pathname.match(/^\/api\/calls\/u\/([0-9a-f-]{36})\/ws$/);
      const call = pathname.match(/^\/api\/calls\/c\/([0-9a-f]{16})\/ws$/);
      try {
        if (line && UUID_RE.test(line[1]) && env.USER_LINE) {
          return env.USER_LINE.get(env.USER_LINE.idFromName(userLineName(line[1]))).fetch(new Request(`https://line.internal/ws?uid=${line[1]}`, req));
        }
        if (call && env.CALL_ROOM) {
          return env.CALL_ROOM.get(env.CALL_ROOM.idFromName(call[1])).fetch(new Request(`https://call.internal/ws?id=${call[1]}`, req));
        }
      } catch (err) {
        console.error('calls route error', err);
        return withCors(json({ error: 'internal error' }, 500), cors);
      }
      return withCors(json({ error: 'not found' }, 404), cors);
    }

    const m = pathname.match(/^\/api\/events(?:\/([a-z0-9]+))?(?:\/(ws|segments|stats|rsvp|recordings|exit))?(?:\/(\d+))?$/);
    if (!m) return withCors(json({ error: 'not found' }, 404), cors);
    const [, id, sub, seqStr] = m;

    try {
      // POST /api/events — create (signed-in Stream Studio members only)
      if (!id && req.method === 'POST') {
        const token = bearerFrom(req);
        const who = token ? await verifyMember(env, token) : null;
        if (!who) {
          return withCors(
            json({ error: 'sign_in_required', message: 'Sign in to your Stream Studio account to host. Viewers never need one.' }, 401),
            cors,
          );
        }
        const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
        const eventId = newEventId();
        const res = await roomCall(env, eventId, '/init', {
          method: 'POST',
          body: JSON.stringify({ ...body, host: body.host || who.displayName, ownerId: who.userId, id: eventId }),
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

      // POST /api/events/:id/exit?k=hostKey — pagehide beacon from the host's
      // studio tab: end the stream immediately (sendBeacon can't set headers,
      // so the key rides the query string; it's the same secret as the WS `k`).
      if (sub === 'exit' && req.method === 'POST') {
        const k = url.searchParams.get('k') ?? req.headers.get('x-host-key') ?? '';
        return withCors(
          await roomCall(env, id, '/host-exit', { method: 'POST', headers: { 'x-host-key': k } }),
          cors,
        );
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
      //   POST ?op=init {file,mime,bytes}      → { key, uploadId, partBytes, quota } (Bearer; 10 GB/account fair use)
      //   GET  ?op=quota&k=hostKey[&bytes=N]   → { usedBytes, limitBytes, copies, nextFreeAt, retryBytes } (Bearer)
      //   PUT  ?op=part&key&uploadId&n=…       → { partNumber, etag }  (must fit the size reserved at init)
      //   POST ?op=complete {key,uploadId,parts,file,mime,durMs} (R2's real size is checked and registered)
      //   GET  ?k=hostKey                      → { recordings, expiresAt }
      //   GET  ?k=hostKey&download=<key>       → the file (attachment)
      if (sub === 'recordings') {
        const op = url.searchParams.get('op');
        const hostKey = req.headers.get('x-host-key') ?? url.searchParams.get('k');

        if (req.method === 'GET') {
          if (!(await authHost(env, id, hostKey))) return withCors(json({ error: 'forbidden' }, 403), cors);
          if (op === 'quota') {
            const q = await cloudCopyUsageFor(env, req, { eventId: id, bytes: url.searchParams.get('bytes') }, Date.now(), (p) => ctx.waitUntil(p));
            return withCors(q.ok ? json(usageBody(q.usage, q.retryBytes), 200, { 'cache-control': 'no-store' }) : json(q.body, q.status), cors);
          }
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
          const { file, mime, bytes } = (await req.json().catch(() => ({}))) as { file?: string; mime?: string; bytes?: number };
          // Fair use (ADR 0007 D5): 10 GB of 7-day copies per account, rolling, on server truth
          // (cloudCopyQuota.ts). Honest error, nothing stored; on yes the size is reserved and
          // the upload's key carries it, so every part and the final object are held to it.
          const started = await startCloudCopy(env, req, { eventId: id, bytes, file, mime }, Date.now(), (p) => ctx.waitUntil(p));
          if (!started.ok) return withCors(json(started.body, started.status), cors);
          return withCors(
            json({ key: started.key, uploadId: started.uploadId, partBytes: CLOUD_COPY_PART_BYTES, quota: usageBody(started.usage) }),
            cors,
          );
        }

        if (req.method === 'PUT' && op === 'part') {
          const key = url.searchParams.get('key') ?? '';
          const uploadId = url.searchParams.get('uploadId') ?? '';
          const n = Number(url.searchParams.get('n'));
          if (!key.startsWith(`events/${id}/rec/`) || !uploadId || !Number.isInteger(n) || n < 1) {
            return withCors(json({ error: 'bad part request' }, 400), cors);
          }
          // Server truth: the parts together can never hold more than the size reserved at init.
          const room = copyPartRoom(id, key, n);
          if (!room.ok) return withCors(json(room.body, room.status), cors);
          if (Number(req.headers.get('content-length')) > room.maxBytes) {
            return withCors(json({ error: 'part size out of bounds' }, 413), cors);
          }
          const body = await req.arrayBuffer();
          if (body.byteLength === 0 || body.byteLength > room.maxBytes) {
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
          const room = copyCompleteRoom(id, key);
          if (!room.ok) return withCors(json(room.body, room.status), cors);
          const upload = env.LIVE_BUCKET.resumeMultipartUpload(key, body.uploadId);
          let stored: R2Object;
          try {
            stored = await upload.complete(body.parts);
          } catch {
            // Replaced by a newer try of the same recording, expired, or parts missing.
            return withCors(
              json({ error: 'upload_gone', message: 'This 7-day copy couldn’t be finished — start it again. Your recording is still on this device.' }, 409),
              cors,
            );
          }
          // R2's own size, not the app's: over the reservation → not kept.
          if (stored.size > room.reserved) {
            await env.LIVE_BUCKET.delete(key);
            const over = oversizeCopy(stored.size, room.reserved);
            return withCors(json(over.body, over.status), cors);
          }
          const res = await roomCall(env, id, '/rec/register', {
            method: 'POST',
            // `stored`: what R2 really holds (usage + the host's list), not what the client said.
            body: JSON.stringify({ key, file: body.file, bytes: stored.size, stored: stored.size, mime: body.mime, durMs: body.durMs }),
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

        // Cost/security guardrail: reject forged segment uploads before reading
        // their body or writing bytes to R2, so a bad host key can't turn public
        // event IDs into R2 write amplification. The room's /auth answers that
        // once per isolate (a host pass, above); /ingest below re-checks the key
        // on every segment after storage succeeds.
        if (!hostKey) return withCors(json({ error: 'forbidden' }, 403), cors);
        if (!(await hasHostPass(id, hostKey, Date.now()))) {
          if (!(await authHost(env, id, hostKey))) return withCors(json({ error: 'forbidden' }, 403), cors);
          await grantHostPass(id, hostKey, Date.now());
        }

        const bytes = await req.arrayBuffer();
        if (bytes.byteLength === 0 || bytes.byteLength > MAX_SEGMENT_BYTES) {
          return withCors(json({ error: 'segment size out of bounds' }, 413), cors);
        }
        const contentType = req.headers.get('content-type') || 'video/webm';
        const key = `events/${id}/seg/${seq}`;
        await env.LIVE_BUCKET.put(key, bytes, { httpMetadata: { contentType } });

        const res = await roomCall(env, id, '/ingest', {
          method: 'POST',
          body: JSON.stringify({ seq, ms, at: Date.now(), mime: contentType, bytes: bytes.byteLength }),
          headers: { 'content-type': 'application/json', 'x-host-key': hostKey },
        });
        if (!res.ok) {
          hostPasses.delete(id); // the room said no: ask it again next time, before R2
          ctx.waitUntil(env.LIVE_BUCKET.delete(key)); // defensive cleanup if the room rejects after storage
          return withCors(res, cors);
        }
        await grantHostPass(id, hostKey, Date.now()); // the room just confirmed the key again
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
