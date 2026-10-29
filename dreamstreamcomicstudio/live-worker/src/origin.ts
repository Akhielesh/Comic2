/**
 * Edge gates for the live Worker (ADR 0006 D6.2; security study F8, F13, F15): where a request
 * comes from, and how often. Nothing here reads a token or wakes a Durable Object, so a refusal
 * costs no DO request — which is the point of refusing at the edge.
 *
 * Origin (WebSocket upgrades only — first-frame auth is the real lock; this is defence in
 * depth against cross-site socket hijacking):
 *   - allowed: our sites (ALLOWED_ORIGINS); the API's own origin (React Native's WebSocket
 *     sends the socket URL's origin, so the native apps arrive as https://<this host>); no
 *     Origin at all (native code, curl); and localhost pages only while the Worker itself runs
 *     on localhost (wrangler dev);
 *   - refused with 403, before any room is asked: another site's page, a sandboxed iframe's
 *     `null`, a Pages preview host we haven't listed.
 *
 * Rate limits (Workers Rate Limiting bindings; per Cloudflare location, eventually consistent —
 * a brake, not an exact count):
 *   RL_WS         60 / 60 s per address, every monitor and call socket upgrade (F8)
 *   RL_GUEST      10 / 60 s per address, share-link joins (F13)
 *   RL_GUEST_NID  30 / 60 s per nursery, share-link joins
 *   RL_EVENT      10 / 60 s per account, Stream Studio event creation
 * Keys are prefixed `edge:` so the room's own limiter (monitorGuests.ts `ip:`/`n:` keys, if a
 * room is given the same binding) counts separately instead of halving the allowance.
 * An address is the client's IPv4 address, or its IPv6 /64 (one subscriber's whole prefix —
 * keying a single v6 address would let anyone rotate through 2^64 of them).
 * Every limit fails OPEN: a missing binding, a missing address or a binding error lets the
 * request through. The rooms' own caps and lockouts stand behind these, and a baby monitor must
 * never stop connecting because a rate limiter hiccuped.
 *
 * Refusals speak the shared contract (packages/monitor-core wire.ts): a socket upgrade is
 * accepted and closed at once with 4008 `rate_limited`, so the app can read why and back off
 * (a plain 429 to an upgrade reaches a browser only as close code 1006); anything else is HTTP
 * 429 with Retry-After.
 */

import { CLOSE, CLOSE_REASON } from '../../packages/monitor-core/src/wire';

/** The shape of a Workers Rate Limiting binding (`env.RL_WS.limit({ key })`). */
export interface RateLimiterLike {
  limit(o: { key: string }): Promise<{ success: boolean }>;
}

export interface EdgeEnv {
  ALLOWED_ORIGINS?: string;
  RL_WS?: RateLimiterLike;
  RL_GUEST?: RateLimiterLike;
  RL_GUEST_NID?: RateLimiterLike;
  RL_EVENT?: RateLimiterLike;
}

/** Every binding's period (wrangler.jsonc `simple.period`), seconds: what Retry-After says. */
export const LIMIT_PERIOD_S = 60;

/* ------------------------------------------------------------------ origin */

const LOCAL_HOST = /^(localhost|127\.0\.0\.1|\[::1\])$/;

export function allowedOrigins(env: EdgeEnv): Set<string> {
  return new Set(
    (env.ALLOWED_ORIGINS || '')
      .split(',')
      .map((s) => s.trim().replace(/\/+$/, ''))
      .filter(Boolean),
  );
}

/** May a socket upgrade carrying this Origin header proceed? */
export function originAllowed(origin: string | null, reqUrl: URL, env: EdgeEnv): boolean {
  if (origin == null || origin === '') return true; // native apps and tools send none
  const o = origin.trim();
  const list = allowedOrigins(env);
  if (list.has('*') || list.has(o)) return true;
  let parsed: URL;
  try {
    parsed = new URL(o);
  } catch {
    return false; // `null` (sandboxed frames, file://) and junk
  }
  if (parsed.origin !== o) return false; // an Origin is scheme://host[:port], nothing more
  // The API's own origin: React Native (iOS and Android) sends the socket URL's origin.
  if (parsed.origin === reqUrl.origin) return true;
  // wrangler dev: the local app on another localhost port. Never in production — there the
  // Worker's own host is ours, not localhost.
  return LOCAL_HOST.test(reqUrl.hostname) && LOCAL_HOST.test(parsed.hostname);
}

/** Refusals by origin, counted so a site we forgot to list shows up in `wrangler tail`. */
const refusedOrigins = new Map<string, number>();

/** One bounded log line per refused origin (the 1st, 10th, 100th … time): the origin only, never a path or address. */
export function noteRefusedOrigin(origin: string | null): void {
  const key = String(origin ?? '').slice(0, 120) || '(empty)';
  const n = (refusedOrigins.get(key) ?? 0) + 1;
  if (refusedOrigins.size > 200 && !refusedOrigins.has(key)) refusedOrigins.clear();
  refusedOrigins.set(key, n);
  if (Number.isInteger(Math.log10(n))) console.warn(JSON.stringify({ evt: 'ws_origin_refused', origin: key, n }));
}

/** Test hook. */
export function resetEdgeState(): void {
  refusedOrigins.clear();
}

/* -------------------------------------------------------------------- CORS */

/** CORS for our listed sites (the API is same-origin under /live-api everywhere else). */
export function corsHeaders(req: Request, env: EdgeEnv): Record<string, string> {
  const origin = req.headers.get('Origin');
  if (!origin) return {};
  const allowed = allowedOrigins(env);
  if (!allowed.has('*') && !allowed.has(origin)) return {};
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
    'Access-Control-Allow-Headers': 'content-type,x-host-key,authorization,if-none-match',
    'Access-Control-Expose-Headers': 'etag,retry-after',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

/* ------------------------------------------------------------- rate limits */

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

/** An IPv6 address's first four groups (its /64), lower-case and zero-padded; null if it isn't one. */
export function ipv6Prefix64(ip: string): string | null {
  let s = ip.trim().toLowerCase();
  const zone = s.indexOf('%');
  if (zone >= 0) s = s.slice(0, zone);
  if (!s.includes(':') || !/^[0-9a-f:.]+$/.test(s)) return null;
  // An embedded IPv4 tail (::ffff:1.2.3.4) is two groups.
  const v4 = s.match(/^(.*:)(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (v4) {
    const p = v4[2].split('.').map(Number);
    if (p.some((n) => n > 255)) return null;
    s = `${v4[1]}${((p[0] << 8) | p[1]).toString(16)}:${((p[2] << 8) | p[3]).toString(16)}`;
  }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const missing = 8 - head.length - tail.length;
  if (halves.length === 1 ? head.length !== 8 : missing < 1) return null;
  const groups = [...head, ...Array(halves.length === 2 ? missing : 0).fill('0'), ...tail];
  if (groups.length !== 8 || groups.some((g) => !/^[0-9a-f]{1,4}$/.test(g))) return null;
  return groups.slice(0, 4).map((g) => g.padStart(4, '0')).join(':');
}

/**
 * The address a limit counts against: `4:<IPv4>` or `6:<IPv6 /64>`. null when the request
 * didn't come through Cloudflare's edge (no `cf-connecting-ip`: local dev, tests) — no limit.
 */
export function clientKey(req: Request): string | null {
  let ip = (req.headers.get('cf-connecting-ip') || '').trim();
  if (!ip) return null;
  // An IPv4 address written as IPv6 (::ffff:a.b.c.d) is that IPv4 address, not a /64 shared
  // by every IPv4 client.
  const mapped = ip.toLowerCase().match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (mapped) ip = mapped[1];
  const v4 = ip.match(IPV4);
  if (v4 && v4.slice(1).every((n) => Number(n) <= 255)) return `4:${ip}`;
  const v6 = ipv6Prefix64(ip);
  if (v6) return `6:${v6}`;
  return `x:${ip.slice(0, 64)}`;
}

/**
 * True when this request may proceed. Fails open (see the top of the file): no binding, no key,
 * or a binding that throws.
 */
export async function withinLimit(binding: RateLimiterLike | undefined, key: string | null): Promise<boolean> {
  if (!binding || !key) return true;
  try {
    const r = await binding.limit({ key: `edge:${key}` });
    return r?.success !== false;
  } catch {
    return true;
  }
}

/* ---------------------------------------------------------------- refusals */

export const RATE_LIMITED_MSG = 'Too many connection attempts from this network — trying again in a minute.';

export const isUpgrade = (req: Request): boolean => (req.headers.get('Upgrade') || '').toLowerCase() === 'websocket';

/**
 * Refuse a socket upgrade the way the app can read: accept it, say why, close 4008
 * `rate_limited` (wire.ts CLOSE_ADVICE: back off). A request that isn't an upgrade gets 429.
 */
export function refuseRateLimited(req: Request, extra: Record<string, string> = {}): Response {
  if (!isUpgrade(req)) return tooMany({ error: 'rate_limited' }, extra);
  const pair = new WebSocketPair();
  const server = pair[1];
  server.accept();
  try {
    server.send(JSON.stringify({ t: 'error', code: CLOSE_REASON.rateLimited, msg: RATE_LIMITED_MSG, retryMs: LIMIT_PERIOD_S * 1000 }));
    server.close(CLOSE.LIMITED, CLOSE_REASON.rateLimited);
  } catch {
    /* already closing */
  }
  return new Response(null, { status: 101, webSocket: pair[0] });
}

/** HTTP 429 with Retry-After (and no-store: a refusal must never be cached). */
export function tooMany(body: Record<string, unknown>, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 429,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store', 'retry-after': String(LIMIT_PERIOD_S), ...extra },
  });
}

/** 403 for a socket from an origin we don't serve. Plain HTTP: it isn't one of our apps, so there's nobody to explain it to. */
export function refuseOrigin(extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify({ error: 'origin_not_allowed' }), { status: 403, headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...extra } });
}
