/**
 * "Sign out everywhere" that really closes everything (ADR 0006 §1, F1/F9), and the helpers every
 * account-level route uses to tell a person's rooms about them.
 *
 *   POST /api/me/kick          Authorization: Bearer <Supabase access token>     body: {} | {why}
 *     1. who is asking: the token, verified (supabaseAuth.verifyAccessToken — JWKS locally, or
 *        Supabase itself for legacy HS256 tokens);
 *     2. their nurseries, from their memberships (`monitor_list`, with their own token);
 *     3. `kickEverywhere`: every nursery's MonitorRoom `/x/kick {uid, why, at}` and their call
 *        line (UserLine) `/x/kick`, all at once; the line names the direct calls (CallRoom) the
 *        person is in, and each of those hears `/x/kick` too. The whole fan-out answers inside
 *        KICK_BUDGET_MS (4.5 s), under the 5 s the acceptance criterion allows; the rooms close the
 *        person's sockets (monitor, family-call line, admin, glance, call), drop their push targets
 *        and answer `{closed, turn}`;
 *     4. the TURN usernames the rooms hand back are revoked at Cloudflare (after answering).
 *   → 200 `{ok, rooms, calls, closed, unconfirmed}`. `ok` is true only when every room, the line
 *     and every call it named confirmed (the web app's "open monitors and calls were
 *     disconnected" depends on it — live/account.ts kickMySockets). A room that doesn't know
 *     `/x/kick` yet (before ADR 0006 WS-9/WS-10 deploy) answers 404: unconfirmed, never pretended.
 *
 * The client calls this BEFORE `signOut({scope:'global'})` (it needs a live token). "Not you?
 * Secure my account" can't: the backend has just ended every session, so the account's tokens
 * can no longer list its nurseries (`session_revoked` once live_security_v2.sql is applied). For
 * that the backend kicks with its own signed credential instead — `POST /x/user/:uid/kick`
 * (ops.ts), naming the nurseries from the membership table — which runs the same
 * `kickEverywhere`. A revoked session calling this route is still accepted (kicking yourself
 * only ever takes access away): its call line is reached, and the answer says the rest couldn't
 * be listed (`error: 'session_revoked'`, ok: false).
 *
 * `at` on every `/x/kick` is when the kick was asked for: a room closes the person's sockets
 * admitted before it and refuses tokens issued before it (`iat < at`) until they expire, so a
 * message that arrives late never cuts off a fresh sign-in (contract notes, ADR 0006 WS-7).
 *
 * Two-step sign-in: someone with a verified factor must present an aal2 token (403
 * `mfa_required`) — a phished password alone can't switch off a family's monitors.
 */

import { CALL_ID_RE, userLineName } from './directCalls';
import { hasTurnConfig, type IceEnv } from './ice';
import { withinLimit, type RateLimiterLike } from './origin';
import { bearerFrom, callRpc, mfaProblem, verifyAccessToken, type AccessIdentity, type SupabaseEnv } from './supabaseAuth';

export interface KickEnv extends SupabaseEnv, IceEnv {
  MONITOR_ROOM?: DurableObjectNamespace;
  USER_LINE?: DurableObjectNamespace;
  /** Direct calls' rooms: a kick reaches the ones the person's call line names. */
  CALL_ROOM?: DurableObjectNamespace;
  RL_WS?: RateLimiterLike;
}

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Each room gets this long to answer, so a fan-out finishes inside the 5 s budget. */
export const ROOM_TIMEOUT_MS = 4_000;
/**
 * A whole kick — nurseries, call line, then the calls the line names — answers within this, under
 * the 5 s the acceptance criterion allows (the calls get what's left after the line answers).
 */
export const KICK_BUDGET_MS = 4_500;
/** At most this many nurseries are told in one fan-out (a person is in far fewer); more is reported unconfirmed. */
export const MAX_ROOMS = 50;
/** Direct calls one kick reaches at most (a person is in one or two at a time); more is reported unconfirmed. */
export const MAX_CALLS = 20;
/** Nursery ids kept from a membership list (the fan-out tells MAX_ROOMS of them and counts the rest). */
const MAX_LISTED = 500;
/** A failed tell is tried once more only when this much of its time is left (a deploy resets an object at once). */
const RETRY_MIN_MS = 500;
const RETRY_PAUSE_MS = 150;
/** How long a request we stopped waiting for is kept alive (ctx.waitUntil), so a slow room still hears it. */
const KEEP_MS = 25_000;
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
  return { ok: true, nids: [...new Set(nids)].slice(0, MAX_LISTED) };
}

/* ----------------------------------------------------------------- fan-out */

export interface Told {
  /** The room answered 2xx. */
  ok: boolean;
  /** HTTP status; 0 = no answer in time, or it threw. */
  status: number;
  data: Record<string, unknown> | null;
}

const NO_ANSWER: Told = { ok: false, status: 0, data: null };

export interface TellOptions {
  /** How long to wait for the answer (default ROOM_TIMEOUT_MS). */
  timeoutMs?: number;
  /** Keeps a request alive after we stop waiting for it (ctx.waitUntil), so a slow room still hears it. */
  keep?: (p: Promise<unknown>) => void;
}

function within<T>(p: Promise<T>, ms: number): Promise<T | 'timeout'> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  return Promise.race([p, new Promise<'timeout'>((resolve) => (timer = setTimeout(() => resolve('timeout'), Math.max(0, ms))))]).finally(() => {
    if (timer != null) clearTimeout(timer);
  });
}

const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Worth trying again: no answer (it threw — a deploy resets objects) or the object failed (5xx). Never a 4xx. */
export const retryable = (t: Told): boolean => !t.ok && (t.status === 0 || t.status >= 500);

async function tellOnce(stub: DurableObjectStub, url: string, body: string, timeoutMs: number, keep?: (p: Promise<unknown>) => void): Promise<Told> {
  try {
    const sent = stub.fetch(new Request(url, { method: 'POST', body, headers: { 'content-type': 'application/json' } }));
    if (keep) keep(within(sent.catch(() => null), KEEP_MS).catch(() => null));
    const res = await within(sent, timeoutMs);
    if (res === 'timeout') return NO_ANSWER;
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
    return NO_ANSWER;
  }
}

/**
 * One internal message to one Durable Object, answered within `timeoutMs`. A try that failed fast
 * (a Durable Object reset by a deploy throws at once; a stub that threw must be made anew) is
 * tried once more while enough of the time is left. Every message sent this way is idempotent.
 */
async function tell(stubFor: () => DurableObjectStub, url: string, body: unknown, opts: TellOptions): Promise<Told> {
  const timeoutMs = opts.timeoutMs ?? ROOM_TIMEOUT_MS;
  const deadline = Date.now() + timeoutMs;
  const text = JSON.stringify(body);
  let stub: DurableObjectStub;
  try {
    stub = stubFor();
  } catch {
    return NO_ANSWER;
  }
  const first = await tellOnce(stub, url, text, timeoutMs, opts.keep);
  if (!retryable(first) || deadline - Date.now() - RETRY_PAUSE_MS < RETRY_MIN_MS) return first;
  await pause(RETRY_PAUSE_MS);
  try {
    stub = stubFor();
  } catch {
    return first;
  }
  return tellOnce(stub, url, text, deadline - Date.now(), opts.keep);
}

/** POST an internal message to one nursery's MonitorRoom (`/x/...`). The Worker never routes /x/ from outside. */
export function tellRoom(env: KickEnv, nid: string, path: string, body: unknown, opts: TellOptions = {}): Promise<Told> {
  const ns = env.MONITOR_ROOM;
  if (!ns || !UUID_RE.test(nid)) return Promise.resolve(NO_ANSWER);
  return tell(() => ns.get(ns.idFromName(nid)), `https://monitor.internal${path}?nid=${nid}`, body, opts);
}

/**
 * Background retries for a message some rooms didn't confirm (all inside the 30 s a Worker may
 * keep working after answering; each try also gets the room's own 4 s).
 */
export const RETRY_DELAYS_MS: readonly number[] = [2_000, 6_000];

/**
 * Tell these rooms again after each pause until each confirms or refuses (a 4xx — a room without
 * the route yet — is an answer). Only for messages that can never undo a newer change (a device
 * revocation stays revoked). Returns how many confirmed.
 */
export async function keepTellingRooms(env: KickEnv, nids: readonly string[], path: string, body: unknown, delays: readonly number[] = RETRY_DELAYS_MS): Promise<number> {
  let left = [...nids];
  let heard = 0;
  for (const delay of delays) {
    if (!left.length) break;
    await pause(delay);
    const told = await Promise.all(left.map((nid) => tellRoom(env, nid, path, body)));
    heard += told.filter((t) => t.ok).length;
    left = left.filter((_, i) => retryable(told[i]));
  }
  if (left.length) console.warn(JSON.stringify({ evt: 'rooms_untold', path, rooms: left.length }));
  return heard;
}

/** The same message to many nurseries at once (the first MAX_ROOMS). */
export function tellRooms(env: KickEnv, nids: readonly string[], path: string, body: unknown, opts: TellOptions = {}): Promise<Told[]> {
  return Promise.all(nids.slice(0, MAX_ROOMS).map((nid) => tellRoom(env, nid, path, body, opts)));
}

/** POST an internal message to a person's call line (UserLine `/x/...`). */
export function tellLine(env: KickEnv, uid: string, path: string, body: unknown, opts: TellOptions = {}): Promise<Told> {
  const ns = env.USER_LINE;
  if (!ns || !UUID_RE.test(uid)) return Promise.resolve(NO_ANSWER);
  return tell(() => ns.get(ns.idFromName(userLineName(uid))), `https://line.internal${path}?uid=${uid}`, body, opts);
}

/** POST an internal message to one direct call's room (CallRoom `/x/...`). */
export function tellCall(env: KickEnv, id: string, path: string, body: unknown, opts: TellOptions = {}): Promise<Told> {
  const ns = env.CALL_ROOM;
  if (!ns || !CALL_ID_RE.test(id)) return Promise.resolve(NO_ANSWER);
  return tell(() => ns.get(ns.idFromName(id)), `https://call.internal${path}?id=${id}`, body, opts);
}

/**
 * The direct calls a line's `/x/kick` answer names (`calls`: CallRoom ids the person is in, being
 * rung into or just placed), once each; `over` counts any past MAX_CALLS (reported unconfirmed).
 */
export function callsNamed(t: Told): { ids: string[]; over: number } {
  const raw = t.ok && Array.isArray(t.data?.calls) ? (t.data.calls as unknown[]) : [];
  const ids = [...new Set(raw.filter((c): c is string => typeof c === 'string' && CALL_ID_RE.test(c)))];
  return { ids: ids.slice(0, MAX_CALLS), over: Math.max(0, ids.length - MAX_CALLS) };
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

/** Worker → room, line and call `/x/kick` (wire.ts XKickBody, plus `at`). */
export interface KickMessage {
  uid: string;
  why: KickWhy;
  /** When the kick was asked for (ms): rooms close what was admitted before it, never a later sign-in. */
  at: number;
}

export interface KickReport {
  /** Every room, the line and every call it named confirmed. */
  ok: boolean;
  /** Nurseries asked (all of them, including any past MAX_ROOMS). */
  rooms: number;
  /** Direct calls the line named. */
  calls: number;
  /** Sockets closed, as the rooms report. */
  closed: number;
  /** Places that didn't confirm (no answer in time, an error, a room without `/x/kick` yet, or past a cap). */
  unconfirmed: number;
}

/**
 * Close every socket `uid` holds and drop their push targets: each nursery in `nids` (from their
 * memberships), their call line, and each direct call the line names — at once, inside
 * KICK_BUDGET_MS. Requests still in flight at the deadline are kept alive (`ctx.waitUntil`), so a
 * slow room still hears it; the answer only ever counts what confirmed. TURN usernames the rooms
 * return are revoked after answering.
 */
export async function kickEverywhere(
  env: KickEnv,
  ctx: Pick<ExecutionContext, 'waitUntil'>,
  uid: string,
  nids: readonly string[],
  why: KickWhy,
  opts: { fetcher?: typeof fetch; now?: number } = {},
): Promise<KickReport> {
  const deadline = Date.now() + KICK_BUDGET_MS;
  const keep = (p: Promise<unknown>) => ctx.waitUntil(p);
  const msg: KickMessage = { uid, why, at: opts.now ?? Date.now() };
  const all = [...new Set(nids.filter((n) => UUID_RE.test(n)))];
  const told = all.slice(0, MAX_ROOMS);

  const [rooms, { line, calls, over }] = await Promise.all([
    Promise.all(told.map((nid) => tellRoom(env, nid, '/x/kick', msg, { keep }))),
    tellLine(env, uid, '/x/kick', msg, { keep }).then(async (line) => {
      const named = callsNamed(line);
      const left = Math.max(0, deadline - Date.now());
      const calls = await Promise.all(named.ids.map((id) => tellCall(env, id, '/x/kick', msg, { timeoutMs: left, keep })));
      return { line, calls, over: named.over };
    }),
  ]);

  const results = [...rooms, line, ...calls].map(kickResult);
  const turn = results.flatMap((r) => r.turn);
  if (turn.length) ctx.waitUntil(revokeTurnUsernames(env, turn, opts.fetcher).catch(() => 0));
  const unconfirmed = rooms.filter((r) => !r.ok).length + (all.length - told.length) + (line.ok ? 0 : 1) + calls.filter((c) => !c.ok).length + over;
  return {
    ok: unconfirmed === 0,
    rooms: all.length,
    calls: calls.length + over,
    closed: results.reduce((n, r) => n + r.closed, 0),
    unconfirmed,
  };
}

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
  const report = await kickEverywhere(env, ctx, caller.uid, list.ok ? list.nids : [], why, opts);
  const ok = list.ok && report.ok;
  if (!ok) {
    // One line for `wrangler tail`: how many places didn't confirm — no ids, names or tokens.
    console.warn(JSON.stringify({ evt: 'kick_partial', via: 'me', rooms: report.rooms, calls: report.calls, unconfirmed: report.unconfirmed, list: list.ok ? 'ok' : list.error }));
  }
  return reply({ ...report, ok, ...(list.ok ? {} : { error: list.error }) });
}
