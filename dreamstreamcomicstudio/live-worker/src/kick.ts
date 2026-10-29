/**
 * "Sign out everywhere" that really closes everything (ADR 0006 §1, F1/F9), and the helpers every
 * account-level route uses to tell a person's rooms about them.
 *
 *   POST /api/me/kick          Authorization: Bearer <Supabase access token>     body: {} | {why}
 *     1. who is asking: the token, verified (supabaseAuth.verifyAccessToken — JWKS locally, or
 *        Supabase itself for legacy HS256 tokens);
 *     2. their nurseries (`monitor_list`, with their own token);
 *     3. every nursery's MonitorRoom `/x/kick {uid, why}` and their call line (UserLine)
 *        `/x/kick`, all at once, each given ≤ 4 s so the whole answer lands inside the 5 s the
 *        acceptance criterion allows; the rooms close the person's sockets (monitor, family-call
 *        line, admin, glance), drop their push targets and answer `{closed, turn}`;
 *     4. the TURN usernames the rooms hand back are revoked at Cloudflare (after answering).
 *   → 200 `{ok, rooms, closed, unconfirmed}`. `ok` is true only when every room AND the line
 *     confirmed (the web app's "open monitors and calls were disconnected" depends on it —
 *     live/account.ts kickMySockets). A room that doesn't know `/x/kick` yet (before ADR 0006
 *     WS-9/WS-10 deploy) answers 404: unconfirmed, never pretended. Those sockets still close
 *     once their token can't be renewed (`exp` + 120 s, once the rooms enforce it).
 *
 * The client calls this BEFORE `signOut({scope:'global'})` (it needs a live token). The "Not
 * you?" page calls it AFTER the backend has ended every session, with the token this browser
 * still holds: a token whose session was revoked is still accepted here — kicking yourself only
 * ever takes access away — but such a token can no longer list nurseries once
 * live_security_v2.sql is applied (`session_revoked`), so then only the call line is reached and
 * the answer says so (`error: 'session_revoked'`, ok: false).
 *
 * Two-step sign-in: someone with a verified factor must present an aal2 token (403
 * `mfa_required`) — a phished password alone can't switch off a family's monitors.
 */

import { userLineName } from './directCalls';
import { hasTurnConfig, type IceEnv } from './ice';
import { withinLimit, type RateLimiterLike } from './origin';
import { bearerFrom, callRpc, mfaProblem, verifyAccessToken, type AccessIdentity, type SupabaseEnv } from './supabaseAuth';

export interface KickEnv extends SupabaseEnv, IceEnv {
  MONITOR_ROOM?: DurableObjectNamespace;
  USER_LINE?: DurableObjectNamespace;
  RL_WS?: RateLimiterLike;
}

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Each room gets this long to answer, so a fan-out finishes inside the 5 s budget. */
export const ROOM_TIMEOUT_MS = 4_000;
/** At most this many nurseries are told in one fan-out (a person is in far fewer). */
export const MAX_ROOMS = 50;
/** TURN usernames revoked per request, at most. */
const MAX_TURN = 200;
const TURN_NAME_RE = /^[A-Za-z0-9._:+/=-]{1,256}$/;
const TURN_API = 'https://rtc.live.cloudflare.com/v1/turn/keys';

/* ----------------------------------------------------------------- replies */

/** JSON, never cached (every answer here is about one person). */
export const reply = (data: unknown, status = 200, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers } });

export const methodNotAllowed = (allow: string): Response => reply({ ok: false, error: 'method_not_allowed' }, 405, { allow });

/**
 * The request body as text, or null when it's larger than `max` bytes (declared or actual).
 * Read once: proofs (DS-Proof) are checked against these exact bytes.
 */
export async function readBody(req: Request, max: number): Promise<string | null> {
  const declared = Number(req.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > max) return null;
  const text = await req.text();
  return new TextEncoder().encode(text).length > max ? null : text;
}

export function parseJson(text: string): unknown {
  if (!text.trim()) return {};
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/* ------------------------------------------------------------------ caller */

export type Caller =
  | {
      ok: true;
      uid: string;
      token: string;
      /** The verified token; null only for an accepted revoked session (`allowRevoked`). */
      id: AccessIdentity | null;
      /** The token's session has been ended (signed out everywhere, "Not you?"). */
      revoked: boolean;
    }
  | { ok: false; res: Response };

/**
 * Who is asking, from `Authorization: Bearer <Supabase access token>`. Failures come back as the
 * response to send: 401 `auth` (no token, bad, expired, or — unless allowed — a revoked session),
 * 403 `mfa_required` (has a second factor, presented aal1), 503 `unavailable` (couldn't check).
 */
export async function verifyCaller(req: Request, env: SupabaseEnv, opts: { allowRevoked?: boolean; fetcher?: typeof fetch; now?: number } = {}): Promise<Caller> {
  const token = bearerFrom(req);
  if (!token) return { ok: false, res: reply({ ok: false, error: 'auth' }, 401) };
  const v = await verifyAccessToken(token, env, { fetcher: opts.fetcher, now: opts.now });
  if (v.ok) {
    if (mfaProblem(v.id)) return { ok: false, res: reply({ ok: false, error: 'mfa_required' }, 403) };
    return { ok: true, uid: v.id.uid, token, id: v.id, revoked: false };
  }
  // Only the RPC path reports `revoked`, after PostgREST verified the token's signature — so
  // the uid it names is the token's own.
  if (v.reason === 'revoked' && opts.allowRevoked && v.uid) return { ok: true, uid: v.uid, token, id: null, revoked: true };
  if (v.reason === 'mfa_required') return { ok: false, res: reply({ ok: false, error: 'mfa_required' }, 403) };
  if (v.reason === 'unavailable') return { ok: false, res: reply({ ok: false, error: 'unavailable' }, 503) };
  return { ok: false, res: reply({ ok: false, error: 'auth' }, 401) };
}

/** Supabase RPC failures → the error codes the apps already explain (live/monitor/client.ts monitorError). */
export function rpcFailure(status: number): { status: number; error: string } {
  if (status === 401 || status === 403) return { status: 401, error: 'auth' };
  // PostgREST answers 404 for a function that isn't there: the SQL hasn't been applied yet.
  if (status === 404) return { status: 503, error: 'setup' };
  return { status: 503, error: 'unavailable' };
}

/* --------------------------------------------------------------- nurseries */

export type NurseryList = { ok: true; nids: string[] } | { ok: false; error: string; status: number };

/** The caller's nurseries (`monitor_list`, with their own token). */
export async function myNurseries(env: SupabaseEnv, token: string, fetcher?: typeof fetch): Promise<NurseryList> {
  const r = await callRpc<{ ok?: boolean; error?: string; nurseries?: { id?: unknown }[] }>(env, token, 'monitor_list', {}, fetcher);
  if (!r.ok) {
    const f = rpcFailure(r.status);
    return { ok: false, error: f.error, status: f.status };
  }
  const d = r.data || {};
  if (d.ok === false) {
    const error = typeof d.error === 'string' ? d.error : 'unavailable';
    // Not a Stream Studio member: no nurseries (their call line can still be reached).
    if (error === 'not_member') return { ok: true, nids: [] };
    return { ok: false, error: error === 'session_revoked' ? 'session_revoked' : error, status: error === 'mfa_required' ? 403 : error === 'session_revoked' ? 401 : 503 };
  }
  const nids = Array.isArray(d.nurseries) ? d.nurseries.map((n) => String(n?.id ?? '').toLowerCase()).filter((id) => UUID_RE.test(id)) : [];
  return { ok: true, nids: [...new Set(nids)].slice(0, MAX_ROOMS) };
}

/* ----------------------------------------------------------------- fan-out */

export interface Told {
  /** The room answered 2xx. */
  ok: boolean;
  /** HTTP status; 0 = no answer in time, or it threw. */
  status: number;
  data: Record<string, unknown> | null;
}

function within<T>(p: Promise<T>, ms: number): Promise<T | 'timeout'> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  return Promise.race([p, new Promise<'timeout'>((resolve) => (timer = setTimeout(() => resolve('timeout'), ms)))]).finally(() => {
    if (timer != null) clearTimeout(timer);
  });
}

async function tell(stub: DurableObjectStub, url: string, body: unknown, timeoutMs: number): Promise<Told> {
  try {
    const res = await within(stub.fetch(new Request(url, { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } })), timeoutMs);
    if (res === 'timeout') return { ok: false, status: 0, data: null };
    let data: Record<string, unknown> | null = null;
    try {
      const text = await res.text();
      const parsed = text.length <= 64 * 1024 ? (JSON.parse(text) as unknown) : null;
      data = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
    } catch {
      /* not JSON */
    }
    return { ok: res.ok, status: res.status, data };
  } catch {
    return { ok: false, status: 0, data: null };
  }
}

/** POST an internal message to one nursery's MonitorRoom (`/x/...`). The Worker never routes /x/ from outside. */
export function tellRoom(env: KickEnv, nid: string, path: string, body: unknown, timeoutMs = ROOM_TIMEOUT_MS): Promise<Told> {
  if (!env.MONITOR_ROOM || !UUID_RE.test(nid)) return Promise.resolve({ ok: false, status: 0, data: null });
  const stub = env.MONITOR_ROOM.get(env.MONITOR_ROOM.idFromName(nid));
  return tell(stub, `https://monitor.internal${path}?nid=${nid}`, body, timeoutMs);
}

/** The same message to many nurseries at once. */
export function tellRooms(env: KickEnv, nids: readonly string[], path: string, body: unknown, timeoutMs = ROOM_TIMEOUT_MS): Promise<Told[]> {
  return Promise.all(nids.slice(0, MAX_ROOMS).map((nid) => tellRoom(env, nid, path, body, timeoutMs)));
}

/** POST an internal message to a person's call line (UserLine `/x/...`). */
export function tellLine(env: KickEnv, uid: string, path: string, body: unknown, timeoutMs = ROOM_TIMEOUT_MS): Promise<Told> {
  if (!env.USER_LINE || !UUID_RE.test(uid)) return Promise.resolve({ ok: false, status: 0, data: null });
  const stub = env.USER_LINE.get(env.USER_LINE.idFromName(userLineName(uid)));
  return tell(stub, `https://line.internal${path}?uid=${uid}`, body, timeoutMs);
}

/** `{closed, turn}` from a room's `/x/kick` or `/x/members` (wire.ts XKickResult), cleaned. */
export function kickResult(t: Told): { closed: number; turn: string[] } {
  const d = t.ok ? t.data : null;
  const closed = d && Number.isInteger(d.closed) && (d.closed as number) >= 0 ? Math.min(d.closed as number, 10_000) : 0;
  const turn = d && Array.isArray(d.turn) ? (d.turn as unknown[]).filter((u): u is string => typeof u === 'string' && TURN_NAME_RE.test(u)).slice(0, 50) : [];
  return { closed, turn };
}

/**
 * Revoke these TURN usernames at Cloudflare, so a removed or signed-out person's relay stops
 * before its TTL. Best effort (the credentials lapse on their own within 4 h); returns how many
 * were revoked or already gone.
 */
export async function revokeTurnUsernames(env: IceEnv, names: Iterable<string>, fetcher: typeof fetch = fetch): Promise<number> {
  if (!hasTurnConfig(env)) return 0;
  const list = [...new Set([...names].filter((u) => TURN_NAME_RE.test(u)))].slice(0, MAX_TURN);
  if (!list.length) return 0;
  const init = { method: 'POST', headers: { authorization: `Bearer ${env.TURN_KEY_API_TOKEN}` } };
  const out = await Promise.allSettled(list.map((u) => fetcher(`${TURN_API}/${env.TURN_KEY_ID}/credentials/${encodeURIComponent(u)}/revoke`, init)));
  return out.filter((r) => r.status === 'fulfilled' && (r.value.ok || r.value.status === 404)).length;
}

/* -------------------------------------------------------------------- kick */

export type KickWhy = 'signout' | 'secure';

export interface KickOptions {
  fetcher?: typeof fetch;
  now?: number;
}

/** POST /api/me/kick. */
export async function handleKick(req: Request, env: KickEnv, ctx: Pick<ExecutionContext, 'waitUntil'>, opts: KickOptions = {}): Promise<Response> {
  if (req.method !== 'POST') return methodNotAllowed('POST');
  const raw = await readBody(req, 1024);
  if (raw == null) return reply({ ok: false, error: 'bad_request' }, 413);
  const caller = await verifyCaller(req, env, { allowRevoked: true, fetcher: opts.fetcher, now: opts.now });
  if (!caller.ok) return caller.res;
  // A brake per account: each kick wakes every one of the person's rooms.
  if (!(await withinLimit(env.RL_WS, `kick:${caller.uid}`))) return reply({ ok: false, error: 'rate_limited' }, 429, { 'retry-after': '60' });
  const body = parseJson(raw) as { why?: unknown } | undefined;
  const why: KickWhy = body && body.why === 'secure' ? 'secure' : 'signout';

  const list: NurseryList = caller.revoked ? { ok: false, error: 'session_revoked', status: 401 } : await myNurseries(env, caller.token, opts.fetcher);
  if (!list.ok && list.error === 'mfa_required') return reply({ ok: false, error: 'mfa_required' }, 403);
  const nids = list.ok ? list.nids : [];
  const msg = { uid: caller.uid, why };
  const [rooms, line] = await Promise.all([tellRooms(env, nids, '/x/kick', msg), tellLine(env, caller.uid, '/x/kick', msg)]);

  const results = [...rooms, line].map(kickResult);
  const turn = results.flatMap((r) => r.turn);
  if (turn.length) ctx.waitUntil(revokeTurnUsernames(env, turn, opts.fetcher).catch(() => 0));
  const unconfirmed = rooms.filter((r) => !r.ok).length + (line.ok ? 0 : 1);
  const ok = list.ok && unconfirmed === 0;
  if (!ok) {
    // One line for `wrangler tail`: how many places didn't confirm — no ids, names or tokens.
    console.warn(JSON.stringify({ evt: 'kick_partial', rooms: nids.length, unconfirmed, list: list.ok ? 'ok' : list.error }));
  }
  return reply({
    ok,
    rooms: nids.length,
    closed: results.reduce((n, r) => n + r.closed, 0),
    unconfirmed,
    ...(list.ok ? {} : { error: list.error }),
  });
}
