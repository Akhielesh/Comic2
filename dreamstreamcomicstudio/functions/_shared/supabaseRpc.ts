/**
 * Minimal PostgREST RPC client for the edge (Pages Functions and the dreamstream-api Worker).
 *
 * Security: the host is FIXED (the project's Supabase URL from env, else the compiled-in public
 * constant) — never a user-supplied URL, so there is no SSRF surface; redirects are not followed;
 * the only credential is the PUBLIC anon key (it already ships in the frontend bundle). The anon
 * role can execute only the allow-listed SECURITY DEFINER read RPCs (server/sql/comic_publications.sql).
 * Function names are allow-listed too.
 */

/** Public project constants (identical to api-proxy/wrangler.jsonc vars and the frontend bundle). */
export const PUBLIC_SUPABASE_URL = 'https://bdjfmxfmhqhzvgrhbbzm.supabase.co';
export const PUBLIC_SUPABASE_ANON_KEY =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImJkamZteGZtaHFoenZncmhiYnptIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzA0MTMzNjgsImV4cCI6MjA4NTk4OTM2OH0.Pvv2PXaWtRt6_o5JIyis7ZZycRRDnxOce-3gciBP5Pk';

export interface SupabaseEnv {
  VITE_SUPABASE_URL?: string;
  VITE_SUPABASE_ANON_KEY?: string;
}

const RPC_NAMES = new Set(['comic_share_card', 'comic_public_payload', 'comic_share_card_by_project', 'comic_publication_track']);

/** The Supabase origin to talk to: env (validated https *.supabase.co) else the public constant. */
export function supabaseOrigin(env: SupabaseEnv | undefined): string {
  const raw = (env?.VITE_SUPABASE_URL || '').trim();
  try {
    const u = new URL(raw);
    if (u.protocol === 'https:' && /^[a-z0-9]{10,40}\.supabase\.co$/.test(u.hostname) && !u.username && !u.password) return u.origin;
  } catch {
    /* fall through */
  }
  return PUBLIC_SUPABASE_URL;
}

export const anonKey = (env: SupabaseEnv | undefined): string => {
  const key = (env?.VITE_SUPABASE_ANON_KEY || '').trim();
  return /^[A-Za-z0-9._-]{20,2000}$/.test(key) ? key : PUBLIC_SUPABASE_ANON_KEY;
};

export type RpcResult<T> = { ok: true; data: T | null } | { ok: false; reason: 'timeout' | 'unavailable' };

/**
 * POST /rest/v1/rpc/<name>. `ok:false` means the database could not answer (timeout, 5xx,
 * network) — callers degrade gracefully; `ok:true, data:null` means "no such live row".
 */
export async function rpc<T>(env: SupabaseEnv | undefined, name: string, args: Record<string, unknown>, opts: { timeoutMs?: number; fetchImpl?: typeof fetch } = {}): Promise<RpcResult<T>> {
  if (!RPC_NAMES.has(name)) throw new Error(`rpc ${name} is not allow-listed`);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 1500);
  const key = anonKey(env);
  try {
    const res = await (opts.fetchImpl || fetch)(`${supabaseOrigin(env)}/rest/v1/rpc/${name}`, {
      method: 'POST',
      headers: { apikey: key, authorization: `Bearer ${key}`, 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(args),
      redirect: 'manual',
      signal: controller.signal
    });
    // A live-or-dead answer is always 200 (+ null for "no such live row"). Any other status — a
    // wrong key, a migration not applied yet, a PostgREST error, 429/5xx — means the database
    // could not answer, so callers degrade honestly ("try again") instead of telling a reader a
    // live link is dead. The slug is validated before the call, so no status depends on which
    // slug was asked (no oracle).
    if (!res.ok) {
      console.warn('supabase_rpc_failed', { name, status: res.status });
      return { ok: false, reason: 'unavailable' };
    }
    const text = await res.text();
    if (!text || text === 'null') return { ok: true, data: null };
    if (text.length > 4_000_000) return { ok: false, reason: 'unavailable' };
    return { ok: true, data: JSON.parse(text) as T };
  } catch (err) {
    return { ok: false, reason: (err as Error)?.name === 'AbortError' ? 'timeout' : 'unavailable' };
  } finally {
    clearTimeout(timer);
  }
}
