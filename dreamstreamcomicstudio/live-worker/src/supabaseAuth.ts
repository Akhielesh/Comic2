/**
 * Supabase-backed identity for the live worker.
 *
 * The worker holds NO secrets: it forwards the caller's own bearer token to
 * PostgREST, where SECURITY DEFINER RPCs (server/sql/live_accounts_and_monitor.sql)
 * resolve `auth.uid()` from the verified JWT and answer membership/role
 * questions. An invalid or expired token is rejected by Supabase itself (401),
 * so a forged token can never authorize anything here.
 *
 * `verifyAccessToken` (bottom of the file) also checks tokens locally against
 * Supabase's published signing keys — still no secret held here — so rooms can
 * re-authenticate sockets without a database round trip.
 */

import { getSigningKey } from './auth/jwks';
import { parseJwt, verifySignature, type Alg } from './auth/jose';

export interface SupabaseEnv {
  SUPABASE_URL?: string;
  SUPABASE_PUBLISHABLE_KEY?: string;
}

export interface LiveIdentity {
  userId: string;
  displayName: string;
}

export type RpcResult<T> = { ok: true; data: T } | { ok: false; status: number };

/** Short in-isolate cache so a burst of requests doesn't re-verify the same token. */
const CACHE_TTL_MS = 60_000;
const memberCache = new Map<string, { at: number; who: LiveIdentity | null }>();

export function bearerFrom(req: Request): string | null {
  const h = req.headers.get('authorization') || '';
  const m = h.match(/^Bearer\s+([A-Za-z0-9._~+/=-]{20,4096})$/);
  return m ? m[1] : null;
}

export async function callRpc<T>(
  env: SupabaseEnv,
  token: string,
  fn: string,
  args: Record<string, unknown> = {},
  fetcher: typeof fetch = fetch,
): Promise<RpcResult<T>> {
  if (!env.SUPABASE_URL || !env.SUPABASE_PUBLISHABLE_KEY) return { ok: false, status: 503 };
  try {
    const res = await fetcher(`${env.SUPABASE_URL.replace(/\/$/, '')}/rest/v1/rpc/${fn}`, {
      method: 'POST',
      headers: {
        apikey: env.SUPABASE_PUBLISHABLE_KEY,
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        accept: 'application/json',
      },
      body: JSON.stringify(args),
    });
    if (!res.ok) return { ok: false, status: res.status };
    return { ok: true, data: (await res.json()) as T };
  } catch {
    return { ok: false, status: 502 };
  }
}

/**
 * A definitive answer (`ok: true`: the member, or `who: null` for signed out / not a
 * member) or "couldn't ask" (`ok: false`: Supabase errored, timed out, or isn't
 * configured). Callers that must not tell a signed-in member to "sign in again"
 * during an outage use this; the rest use `verifyMember`.
 */
export type MemberCheck = { ok: true; who: LiveIdentity | null } | { ok: false; status: number };

export async function checkMember(env: SupabaseEnv, token: string, fetcher: typeof fetch = fetch): Promise<MemberCheck> {
  const key = await tokenKey(token);
  const hit = memberCache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return { ok: true, who: hit.who };
  const res = await callRpc<{ member?: boolean; user_id?: string; profile?: { display_name?: string } }>(
    env,
    token,
    'live_me',
    {},
    fetcher,
  );
  // Only definitive answers count (and are cached) — a 5xx shouldn't lock someone out for a minute.
  if (!res.ok && res.status !== 401) return { ok: false, status: res.status };
  const who =
    res.ok && res.data.member && res.data.user_id
      ? { userId: res.data.user_id, displayName: String(res.data.profile?.display_name || 'Member').slice(0, 40) }
      : null;
  memberCache.set(key, { at: Date.now(), who });
  if (memberCache.size > 500) memberCache.clear();
  return { ok: true, who };
}

/** Verified Stream Studio member behind this bearer token, or null (signed out, not a member, or Supabase unreachable). */
export async function verifyMember(
  env: SupabaseEnv,
  token: string,
  fetcher: typeof fetch = fetch,
): Promise<LiveIdentity | null> {
  const r = await checkMember(env, token, fetcher);
  return r.ok ? r.who : null;
}

async function tokenKey(token: string): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  return btoa(String.fromCharCode(...new Uint8Array(d)));
}

/** Test hook. */
export function clearMemberCache(): void {
  memberCache.clear();
}

/* ------------------------------------------------- local token verification */
// ADR 0006 D5.4 / D9 #17: verify Supabase access tokens here, against the project's published
// signing keys (./auth/jwks.ts), so re-auth and socket admission cost no database round trip.
//
//   ES256 / RS256 with a known `kid`  → checked locally (signature, exp, iss, aud, role, sub).
//   HS256 (the legacy shared secret), no JWKS, or JWKS unreachable
//                                     → asked of Supabase (live_me with the token), as before.
//
// What local verification can't see: a session revoked since the token was issued (sign out
// everywhere, "Not you?"). Such a token stays valid until its `exp` (20 min, owner setting) and
// can no longer be refreshed, so rooms close the socket at `exp + 120 s` (EXPIRY_GRACE_MS) and
// re-ask Supabase every 6 h (./auth/roleCache.ts). The RPC path does see revocation
// (live_security_v2.sql → `session_revoked`).


/** Clock skew we tolerate on `exp`/`iat` (seconds). */
export const CLOCK_SKEW_S = 30;
/** Rooms close a socket this long after its token's `exp` unless it re-authenticates. */
export const EXPIRY_GRACE_MS = 120_000;

export type Aal = 'aal1' | 'aal2';

/** A verified Supabase access token, reduced to what rooms use. */
export interface AccessIdentity {
  uid: string;
  /** The auth session (`session_id`) — what "sign out everywhere" ends. */
  sid: string | null;
  /** Expiry, epoch seconds. */
  exp: number;
  aal: Aal;
  /**
   * Has a verified second factor (the `ds_mfa` claim from live_access_token_hook, or
   * Supabase's answer on the RPC path). null = unknown (hook not enabled yet): ask the
   * room's role check, which knows.
   */
  mfa: boolean | null;
  /** How it was verified. */
  via: 'jwks' | 'rpc';
}

export type VerifyFailure = 'malformed' | 'expired' | 'invalid' | 'revoked' | 'mfa_required' | 'unavailable';
export type VerifyResult = { ok: true; id: AccessIdentity } | { ok: false; reason: VerifyFailure; uid?: string };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const audIncludes = (aud: unknown, want: string): boolean => (Array.isArray(aud) ? aud.includes(want) : aud === want);

/** True when this identity must finish two-step sign-in first (a verified factor, aal1 token). */
export const mfaProblem = (id: Pick<AccessIdentity, 'mfa' | 'aal'>): boolean => id.mfa === true && id.aal !== 'aal2';

/**
 * Admin actions (share links, adding members, export, approving a device) need `aal2` from
 * anyone who has a second factor. Someone without one can't step up — the nudge to turn it on
 * is the app's job — so for them the answer is "no step-up needed".
 */
export const stepUpNeeded = (id: Pick<AccessIdentity, 'mfa' | 'aal'>): boolean => mfaProblem(id);

function claimsOf(payload: Record<string, unknown>): { uid: string; sid: string | null; exp: number; aal: Aal; mfa: boolean | null } | null {
  const uid = typeof payload.sub === 'string' && UUID_RE.test(payload.sub) ? payload.sub.toLowerCase() : null;
  const exp = typeof payload.exp === 'number' && Number.isFinite(payload.exp) ? Math.floor(payload.exp) : null;
  if (!uid || exp == null) return null;
  const sid = typeof payload.session_id === 'string' && UUID_RE.test(payload.session_id) ? payload.session_id.toLowerCase() : null;
  return { uid, sid, exp, aal: payload.aal === 'aal2' ? 'aal2' : 'aal1', mfa: typeof payload.ds_mfa === 'boolean' ? payload.ds_mfa : null };
}

/**
 * Verify a Supabase access token. Never throws. `unavailable` means "couldn't tell right now"
 * (Supabase unreachable on the RPC path) — callers must not treat it as signed out.
 */
export async function verifyAccessToken(
  token: string,
  env: SupabaseEnv,
  opts: { now?: number; fetcher?: typeof fetch } = {},
): Promise<VerifyResult> {
  const now = opts.now ?? Date.now();
  const fetcher = opts.fetcher ?? fetch;
  const jwt = parseJwt(token);
  if (!jwt) return { ok: false, reason: 'malformed' };
  const claims = claimsOf(jwt.payload);
  if (!claims) return { ok: false, reason: 'malformed' };
  if (claims.exp + CLOCK_SKEW_S <= Math.floor(now / 1000)) return { ok: false, reason: 'expired', uid: claims.uid };

  const alg = jwt.header.alg;
  const kid = typeof jwt.header.kid === 'string' ? jwt.header.kid : '';
  if ((alg === 'ES256' || alg === 'RS256') && kid) {
    const found = await getSigningKey(env, kid, alg as Alg, now, fetcher);
    if ('key' in found) {
      if (!(await verifySignature(alg as Alg, found.key, jwt.signature, jwt.signingInput))) return { ok: false, reason: 'invalid' };
      const p = jwt.payload;
      const iss = env.SUPABASE_URL ? `${env.SUPABASE_URL.replace(/\/+$/, '')}/auth/v1` : null;
      if (iss && p.iss !== iss) return { ok: false, reason: 'invalid' };
      if (!audIncludes(p.aud, 'authenticated') || p.role !== 'authenticated') return { ok: false, reason: 'invalid' };
      if (typeof p.iat === 'number' && p.iat - CLOCK_SKEW_S > Math.floor(now / 1000)) return { ok: false, reason: 'invalid' };
      return { ok: true, id: { ...claims, via: 'jwks' } };
    }
    // A kid Supabase doesn't list (after a refetch): not a token it signed.
    if ('missing' in found) return { ok: false, reason: 'invalid' };
    // JWKS unreachable: fall through to asking Supabase.
  } else if (alg !== 'HS256') {
    // `none`, or anything we don't verify: never accepted, never forwarded.
    return { ok: false, reason: 'invalid' };
  }

  // Legacy HS256 or JWKS unavailable: Supabase verifies the token (and the session) for us.
  const res = await callRpc<{ signed_in?: boolean; user_id?: string; error?: string; mfa?: boolean }>(env, token, 'live_me', {}, fetcher);
  if (!res.ok) {
    if (res.status === 401 || res.status === 403) return { ok: false, reason: 'invalid' };
    return { ok: false, reason: 'unavailable' };
  }
  const d = res.data || {};
  if (d.error === 'session_revoked') return { ok: false, reason: 'revoked', uid: claims.uid };
  if (typeof d.user_id !== 'string' || d.user_id.toLowerCase() !== claims.uid) return { ok: false, reason: 'invalid' };
  if (d.error === 'mfa_required') return { ok: false, reason: 'mfa_required', uid: claims.uid };
  return { ok: true, id: { ...claims, mfa: typeof d.mfa === 'boolean' ? d.mfa : claims.mfa, via: 'rpc' } };
}
