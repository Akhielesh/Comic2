/**
 * The device registry's HTTP side (ADR 0006 D4.4, D9 #9): how a watch — and later the native
 * apps — gets scoped, hardware-bound access without ever holding an account token.
 * Dormant until the owner sets DEVICE_TOKEN_JWK (and applies live_security_v2.sql): until then
 * enrol / token answer 501 `not_enabled`, which the apps treat as "not available yet".
 *
 *   POST /api/devices/enroll   Bearer <Supabase token>   (wire.ts EnrollRequest)
 *        {sigPub, ecdhPub?, platform, name, nurseries: [{id, can}], attest?}
 *     A signed-in phone registers a hardware key — its own or its watch's (the watch's public key
 *     arrives over WatchConnectivity / the Data Layer). Needs aal2 from anyone with a second
 *     factor (device approval is an admin action). Each nursery is checked with the caller's own
 *     token (`monitor_my_role`): the device may do at most what the person may, never above a
 *     caregiver, and only what was asked (`can`). `live_device_enroll` records it (and the
 *     account's security log); the answer is a 30-day GRANT bound to the key's thumbprint.
 *     → {ok, grant, devId, exp, nid, scp, created}. A new device is announced on the person's
 *       other devices (their call line's `/x/notify`, ADR 0006 WS-10).
 *   POST /api/devices/token    {grant} + DS-Proof (signed by that hardware key)
 *     → {ok, access, exp, nid, scp}: a 10-minute access token. Asks `live_device_active` every
 *       time (no session needed), so a revoked device gets nothing from the next exchange on;
 *       if Supabase can't be asked, nothing is minted (fail closed).
 *   POST /api/devices/push     Bearer <device access token> + DS-Proof, or Bearer <Supabase token>
 *        {kind, token, enc, env?, plat?, la?, fcm?}   (push/router.ts parsePushSub)
 *     Stores where the device gets pushes in each of its nurseries' rooms (`/x/push-reg`). A
 *     device token is checked against the registry first, like the exchange (`live_device_active`,
 *     fail closed): a revoked watch's access token is still unexpired for up to 10 minutes, and a
 *     push target it stored now would outlive it.
 *   DELETE /api/devices/:id    Bearer <Supabase token>
 *     `live_device_revoke` (aal2 when MFA is on), then every nursery of the person hears
 *     `/x/device-revoked {uid, dev, thumb}`: the room drops that device's push targets, closes
 *     its sockets and refuses its actions at once; an access token already issued lapses within
 *     10 minutes anyway.
 *   /api/devices/code, /api/devices/approve: the RFC 8628 device-code fallback — Phase 3 (501).
 *
 * The DS-Proof nonce memory here is per isolate. Replaying a captured token exchange elsewhere
 * gains nothing: the access token it returns is bound to the same hardware key, so using it
 * needs a fresh proof that only the device can make. The rooms, where proofs authorize actions,
 * keep their nonces in SQLite (ADR 0006 WS-9).
 */

import { CAN } from '../../packages/monitor-core/src/glance';
import { DEVICE_PLATFORMS, type DevicePlatform } from '../../packages/monitor-core/src/wire';
import {
  ISSUER,
  MemoryNonceStore,
  deviceTokensConfigured,
  mintDeviceAccess,
  mintDeviceGrant,
  scopesForRole,
  verifyDeviceToken,
  verifyDsProof,
  type DeviceTokenEnv,
  type NonceStore,
  type Scope,
} from './auth/deviceToken';
import { ecJwkFromRaw, jwkThumbprint, parseJwt, unb64url } from './auth/jose';
import { keepTellingRooms, MAX_ROOMS, methodNotAllowed, myNurseries, parseJson, readBody, reply, retryable, RETRY_DELAYS_MS, rpcFailure, tellLine, tellRooms, UUID_RE, verifyCaller, type KickEnv } from './kick';
import { withinLimit } from './origin';
import { parsePushSub } from './push/router';
import { bearerFrom, callRpc, stepUpNeeded, type RpcResult, type SupabaseEnv } from './supabaseAuth';

export interface DevicesEnv extends KickEnv, DeviceTokenEnv {}

export interface DevicesOptions {
  fetcher?: typeof fetch;
  now?: number;
  /** DS-Proof nonce memory (tests); the isolate's own by default. */
  nonces?: NonceStore;
  /** Background retries for rooms that didn't hear a revocation (tests shorten them). */
  retryDelaysMs?: readonly number[];
}

const isolateNonces = new MemoryNonceStore();

/** Nurseries one grant may cover (deviceToken.ts caps it at 10 too). */
const MAX_NURSERIES = 10;
const DEV_ID_RE = /^[A-Za-z0-9_-]{22}$/;

const notEnabled = () => reply({ ok: false, error: 'not_enabled' }, 501);

/** The Glance `can` bits a client asks for → the scopes they name. `glance` always. */
export function scopesFromCan(can: number): Scope[] {
  const out: Scope[] = ['glance'];
  const bits: [number, Scope][] = [
    [CAN.ack, 'ack'],
    [CAN.soothe, 'soothe'],
    [CAN.listen, 'listen'],
    [CAN.talk, 'talk'],
    [CAN.peek, 'peek'],
    [CAN.duty, 'duty'],
    [CAN.log, 'log'],
  ];
  for (const [bit, s] of bits) if ((can & bit) !== 0) out.push(s);
  return out;
}

/** A P-256 public key as sent (uncompressed point, base64url) → its RFC 7638 thumbprint, or null. */
export async function keyThumbprint(raw: unknown): Promise<string | null> {
  if (typeof raw !== 'string' || raw.length > 128) return null;
  const bytes = unb64url(raw);
  const jwk = bytes && bytes.length === 65 ? ecJwkFromRaw(bytes) : null;
  return jwk ? jwkThumbprint(jwk) : null;
}

/**
 * An RPC that needs no session (`live_device_active`): the publishable key alone. A legacy anon
 * key (a JWT) also rides as the bearer, as Supabase expects; a new `sb_publishable_` key never
 * does (it isn't a JWT).
 */
export async function anonRpc<T>(env: SupabaseEnv, fn: string, args: Record<string, unknown>, fetcher: typeof fetch = fetch): Promise<RpcResult<T>> {
  if (!env.SUPABASE_URL || !env.SUPABASE_PUBLISHABLE_KEY) return { ok: false, status: 503 };
  const headers: Record<string, string> = { apikey: env.SUPABASE_PUBLISHABLE_KEY, 'content-type': 'application/json', accept: 'application/json' };
  if (env.SUPABASE_PUBLISHABLE_KEY.startsWith('eyJ')) headers.authorization = `Bearer ${env.SUPABASE_PUBLISHABLE_KEY}`;
  try {
    const res = await fetcher(`${env.SUPABASE_URL.replace(/\/$/, '')}/rest/v1/rpc/${fn}`, { method: 'POST', headers, body: JSON.stringify(args) });
    if (!res.ok) return { ok: false, status: res.status };
    return { ok: true, data: (await res.json()) as T };
  } catch {
    return { ok: false, status: 502 };
  }
}

/** The device RPCs' refusals → HTTP. */
function refusal(error: unknown): Response {
  const e = typeof error === 'string' && /^[a-z_]{1,40}$/.test(error) ? error : 'unknown';
  if (e === 'session_revoked' || e === 'signed_out') return reply({ ok: false, error: 'auth' }, 401);
  if (e === 'mfa_required' || e === 'not_member' || e === 'forbidden') return reply({ ok: false, error: e }, 403);
  if (e === 'not_found') return reply({ ok: false, error: e }, 404);
  if (e === 'limit_reached') return reply({ ok: false, error: e }, 409);
  return reply({ ok: false, error: e }, 400);
}

const cleanName = (v: unknown): string => (typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f<>]/g, '').trim().slice(0, 40) : '');

/* ------------------------------------------------------------------ enrol */

async function enroll(req: Request, env: DevicesEnv, ctx: Pick<ExecutionContext, 'waitUntil'>, opts: DevicesOptions): Promise<Response> {
  if (!(await deviceTokensConfigured(env))) return notEnabled();
  const raw = await readBody(req, 16 * 1024);
  if (raw == null) return reply({ ok: false, error: 'bad_request' }, 413);
  const caller = await verifyCaller(req, env, { fetcher: opts.fetcher, now: opts.now });
  if (!caller.ok) return caller.res;
  if (caller.id && stepUpNeeded(caller.id)) return reply({ ok: false, error: 'mfa_required' }, 403);

  const b = parseJson(raw) as Record<string, unknown> | undefined;
  if (!b || typeof b !== 'object' || Array.isArray(b)) return reply({ ok: false, error: 'bad_request' }, 400);
  const jkt = await keyThumbprint(b.sigPub);
  const platform = b.platform as DevicePlatform;
  const asked = Array.isArray(b.nurseries) ? b.nurseries : null;
  if (!jkt || !DEVICE_PLATFORMS.includes(platform) || !asked || !asked.length || asked.length > MAX_NURSERIES) return reply({ ok: false, error: 'bad_request' }, 400);
  if (b.ecdhPub != null && !(await keyThumbprint(b.ecdhPub))) return reply({ ok: false, error: 'bad_request' }, 400);
  const wants = new Map<string, number>();
  for (const n of asked) {
    const id = String((n as { id?: unknown })?.id ?? '').toLowerCase();
    const can = (n as { can?: unknown })?.can;
    if (!UUID_RE.test(id) || !Number.isInteger(can) || (can as number) < 0 || (can as number) > 127) return reply({ ok: false, error: 'bad_request' }, 400);
    wants.set(id, (wants.get(id) ?? 0) | (can as number));
  }

  // What the person may do in each nursery, asked with their own token.
  const roles = await Promise.all(
    [...wants.keys()].map(async (nid) => ({ nid, r: await callRpc<{ ok?: boolean; role?: unknown; error?: string }>(env, caller.token, 'monitor_my_role', { p_nursery: nid }, opts.fetcher) })),
  );
  const nids: string[] = [];
  const scp = new Set<Scope>();
  for (const { nid, r } of roles) {
    if (!r.ok) {
      const f = rpcFailure(r.status);
      return reply({ ok: false, error: f.error }, f.status);
    }
    if (r.data?.error === 'mfa_required' || r.data?.error === 'session_revoked') return refusal(r.data.error);
    const role = r.data?.ok ? r.data.role : null;
    if (role !== 'parent' && role !== 'caregiver' && role !== 'viewer') continue;
    const allowed = new Set<string>(scopesForRole(role));
    const granted = scopesFromCan(wants.get(nid) ?? 0).filter((s) => allowed.has(s));
    if (!granted.length) continue;
    nids.push(nid);
    for (const s of granted) scp.add(s);
  }
  if (!nids.length) return reply({ ok: false, error: 'forbidden' }, 403);

  const name = cleanName(b.name);
  const en = await callRpc<{ ok?: boolean; error?: string; created?: boolean; device?: { id?: unknown; name?: unknown; platform?: unknown } }>(
    env,
    caller.token,
    'live_device_enroll',
    { p_thumb: jkt, p_platform: platform, p_name: name },
    opts.fetcher,
  );
  // Before live_security_v2.sql the registry doesn't exist: dormant, not broken.
  if (!en.ok) {
    if (en.status === 404) return notEnabled();
    const f = rpcFailure(en.status);
    return reply({ ok: false, error: f.error }, f.status);
  }
  if (!en.data?.ok) return refusal(en.data?.error);
  const dev = String(en.data.device?.id ?? '').toLowerCase();
  if (!UUID_RE.test(dev)) return reply({ ok: false, error: 'unavailable' }, 503);

  const grant = await mintDeviceGrant(env, { uid: caller.uid, dev, jkt, nids, scp: [...scp] }, opts.now);
  if (!grant) return notEnabled();
  if (en.data.created) {
    // The new-device push mirror on the person's other devices (UserLine, WS-10). Best effort.
    const at = opts.now ?? Date.now();
    ctx.waitUntil(tellLine(env, caller.uid, '/x/notify', { uid: caller.uid, kind: 'device_added', at, name: cleanName(en.data.device?.name) || name, platform }).catch(() => null));
  }
  return reply({ ok: true, grant: grant.token, devId: dev, exp: grant.exp * 1000, nid: grant.claims.nid, scp: grant.claims.scp, created: en.data.created === true });
}

/* ------------------------------------------------------------------ token */

/**
 * Is this device still in the registry, for this account and this key? Asked on every use of a
 * device credential the Worker acts on (token exchange, push registration), with the publishable
 * key alone — never only at mint: an access token outlives a revocation by up to 10 minutes.
 * null = go ahead; otherwise the refusal (401 `revoked`; 503 when Supabase can't be asked — fail
 * closed; 501 before live_security_v2.sql).
 */
async function stillActive(env: DevicesEnv, claims: { dev: string; sub: string; cnf: { jkt: string } }, fetcher?: typeof fetch): Promise<Response | null> {
  const active = await anonRpc<{ ok?: boolean; active?: boolean; user_id?: unknown }>(env, 'live_device_active', { p_device: claims.dev, p_thumb: claims.cnf.jkt }, fetcher);
  if (!active.ok) return active.status === 404 ? notEnabled() : reply({ ok: false, error: 'unavailable' }, 503);
  if (!active.data?.active || String(active.data.user_id ?? '').toLowerCase() !== claims.sub) return reply({ ok: false, error: 'revoked' }, 401);
  return null;
}

async function token(req: Request, env: DevicesEnv, opts: DevicesOptions): Promise<Response> {
  if (!(await deviceTokensConfigured(env))) return notEnabled();
  const raw = await readBody(req, 8 * 1024);
  if (raw == null) return reply({ ok: false, error: 'bad_request' }, 413);
  const b = parseJson(raw) as { grant?: unknown } | undefined;
  if (!b || typeof b.grant !== 'string' || b.grant.length > 4096) return reply({ ok: false, error: 'bad_request' }, 400);
  const now = opts.now ?? Date.now();
  const g = await verifyDeviceToken(env, b.grant, 'grant', now);
  if (g.ok === false) {
    if (g.reason === 'unavailable') return notEnabled();
    return reply({ ok: false, error: g.reason === 'expired' ? 'grant_expired' : 'invalid_grant' }, 401);
  }
  const claims = g.claims;
  // A brake per device: a watch asks every 10 minutes, not every second.
  if (!(await withinLimit(env.RL_WS, `tok:${claims.dev}`))) return reply({ ok: false, error: 'rate_limited' }, 429, { 'retry-after': '60' });
  const proof = await verifyDsProof(req, claims.cnf.jkt, opts.nonces ?? isolateNonces, { now, body: raw });
  if (proof.ok === false) return reply({ ok: false, error: 'bad_proof', reason: proof.reason }, 401);

  const standing = await stillActive(env, claims, opts.fetcher);
  if (standing) return standing;

  const access = await mintDeviceAccess(env, claims, now);
  if (!access) return notEnabled();
  return reply({ ok: true, access: access.token, exp: access.exp * 1000, nid: access.claims.nid, scp: access.claims.scp });
}

/* ------------------------------------------------------------------- push */

async function push(req: Request, env: DevicesEnv, opts: DevicesOptions): Promise<Response> {
  const raw = await readBody(req, 8 * 1024);
  if (raw == null) return reply({ ok: false, error: 'bad_request' }, 413);
  const b = parseJson(raw) as Record<string, unknown> | undefined;
  if (!b || typeof b !== 'object' || Array.isArray(b)) return reply({ ok: false, error: 'bad_request' }, 400);
  const bearer = bearerFrom(req);
  if (!bearer) return reply({ ok: false, error: 'auth' }, 401);
  const now = opts.now ?? Date.now();

  let who: { uid: string; dev: string | null };
  let nids: string[];
  let via: 'device' | 'account';
  let scp: Scope[] | undefined;
  if (parseJwt(bearer)?.payload.iss === ISSUER) {
    // A device's own access token, with a proof made by its hardware key.
    if (!(await deviceTokensConfigured(env))) return notEnabled();
    const v = await verifyDeviceToken(env, bearer, 'access', now);
    if (v.ok === false) return reply({ ok: false, error: v.reason === 'unavailable' ? 'not_enabled' : 'auth' }, v.reason === 'unavailable' ? 501 : 401);
    const proof = await verifyDsProof(req, v.claims.cnf.jkt, opts.nonces ?? isolateNonces, { now, body: raw });
    if (proof.ok === false) return reply({ ok: false, error: 'bad_proof', reason: proof.reason }, 401);
    // Revoked since its token was minted: it must not store a push target that outlives the token.
    const standing = await stillActive(env, v.claims, opts.fetcher);
    if (standing) return standing;
    who = { uid: v.claims.sub, dev: v.claims.dev };
    nids = v.claims.nid;
    via = 'device';
    scp = v.claims.scp;
  } else {
    const caller = await verifyCaller(req, env, { fetcher: opts.fetcher, now: opts.now });
    if (!caller.ok) return caller.res;
    const list = await myNurseries(env, caller.token, opts.fetcher);
    if (!list.ok) return reply({ ok: false, error: list.error }, list.status);
    const only = Array.isArray(b.nids) ? new Set(b.nids.map((n) => String(n).toLowerCase())) : null;
    who = { uid: caller.uid, dev: typeof b.dev === 'string' && DEV_ID_RE.test(b.dev) ? b.dev : null };
    nids = only ? list.nids.filter((n) => only.has(n)) : list.nids;
    via = 'account';
  }
  const sub = parsePushSub(b, who, now);
  if (!sub) return reply({ ok: false, error: 'bad_request' }, 400);
  if (!nids.length) return reply({ ok: true, rooms: 0, stored: 0 });
  const told = await tellRooms(env, nids, '/x/push-reg', { uid: who.uid, dev: who.dev, via, sub, ...(scp ? { scp } : {}) });
  const stored = told.filter((t) => t.ok).length;
  // Rooms that don't take native push targets yet (before ADR 0006 WS-9): say so plainly.
  if (!stored && told.every((t) => t.status === 404)) return reply({ ok: false, error: 'not_enabled', rooms: nids.length, stored: 0 }, 501);
  return reply({ ok: stored === nids.length, rooms: nids.length, stored });
}

/* ----------------------------------------------------------------- revoke */

async function revoke(req: Request, env: DevicesEnv, ctx: Pick<ExecutionContext, 'waitUntil'>, opts: DevicesOptions, id: string): Promise<Response> {
  const caller = await verifyCaller(req, env, { fetcher: opts.fetcher, now: opts.now });
  if (!caller.ok) return caller.res;
  if (caller.id && stepUpNeeded(caller.id)) return reply({ ok: false, error: 'mfa_required' }, 403);
  const r = await callRpc<{ ok?: boolean; error?: string; already?: boolean; device?: { id?: unknown; thumb?: unknown } }>(env, caller.token, 'live_device_revoke', { p_device: id }, opts.fetcher);
  if (!r.ok) {
    const f = rpcFailure(r.status);
    return reply({ ok: false, error: f.error }, f.status);
  }
  if (!r.data?.ok) return refusal(r.data?.error);
  const thumb = typeof r.data.device?.thumb === 'string' ? r.data.device.thumb : null;
  // Tell every nursery: its sockets close and its push targets go now, not at token expiry.
  const list = await myNurseries(env, caller.token, opts.fetcher);
  const nids = list.ok ? list.nids : [];
  const msg = { uid: caller.uid, dev: id, thumb };
  const told = await tellRooms(env, nids, '/x/device-revoked', msg, { keep: (p) => ctx.waitUntil(p) });
  // A room that didn't hear keeps the device's push targets: tell it again in the background.
  const missed = nids.slice(0, MAX_ROOMS).filter((_, i) => retryable(told[i]));
  if (missed.length) ctx.waitUntil(keepTellingRooms(env, missed, '/x/device-revoked', msg, opts.retryDelaysMs ?? RETRY_DELAYS_MS).catch(() => 0));
  return reply({ ok: true, already: r.data.already === true, rooms: nids.length, told: told.filter((t) => t.ok).length });
}

/* ---------------------------------------------------------------- routing */

/**
 * /api/devices/<sub>. `sub` is what follows `/api/devices/`: enroll, token, push, code, approve,
 * or a device id (DELETE).
 */
export async function handleDevices(req: Request, env: DevicesEnv, ctx: Pick<ExecutionContext, 'waitUntil'>, sub: string, opts: DevicesOptions = {}): Promise<Response> {
  switch (sub) {
    case 'enroll':
      return req.method === 'POST' ? enroll(req, env, ctx, opts) : methodNotAllowed('POST');
    case 'token':
      return req.method === 'POST' ? token(req, env, opts) : methodNotAllowed('POST');
    case 'push':
      return req.method === 'POST' ? push(req, env, opts) : methodNotAllowed('POST');
    case 'code':
    case 'approve':
      // The RFC 8628 device-code fallback for Wear OS arrives in Phase 3 (ADR 0006 §1).
      return reply({ ok: false, error: 'not_yet' }, 501);
  }
  const id = sub.toLowerCase();
  if (UUID_RE.test(id)) return req.method === 'DELETE' ? revoke(req, env, ctx, opts, id) : methodNotAllowed('DELETE');
  return reply({ ok: false, error: 'not_found' }, 404);
}
