/**
 * Supabase-backed identity for the live worker.
 *
 * The worker holds NO secrets: it forwards the caller's own bearer token to
 * PostgREST, where SECURITY DEFINER RPCs (server/sql/live_accounts_and_monitor.sql)
 * resolve `auth.uid()` from the verified JWT and answer membership/role
 * questions. An invalid or expired token is rejected by Supabase itself (401),
 * so a forged token can never authorize anything here.
 */

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
