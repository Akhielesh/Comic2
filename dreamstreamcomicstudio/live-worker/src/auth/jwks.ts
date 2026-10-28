/**
 * Supabase's public signing keys (JWKS), cached per isolate so access tokens are verified
 * locally — no database round trip per socket or re-auth (ADR 0006 D5.4, D9 #17).
 *
 *   GET <SUPABASE_URL>/auth/v1/.well-known/jwks.json
 *
 * - Cached 15 minutes. A token naming a key we don't have triggers one early refetch (key
 *   rotation), at most every 30 s, so a flood of forged `kid`s can't turn into a flood of
 *   fetches.
 * - A failed fetch holds further fetches for 60 s and reports "unavailable": callers fall back
 *   to asking Supabase (the RPC path), never to accepting the token.
 * - Only asymmetric keys are listed. Projects still signing with the legacy HS256 secret have
 *   an empty list here, and every token takes the RPC path — correct, just slower.
 */

import { importVerifyKey, type Alg, type PublicJwk } from './jose';

export const JWKS_TTL_MS = 15 * 60_000;
export const JWKS_MISS_REFETCH_MS = 30_000;
export const JWKS_FAIL_HOLD_MS = 60_000;

export interface JwksEnv {
  SUPABASE_URL?: string;
  SUPABASE_PUBLISHABLE_KEY?: string;
}

interface Entry {
  at: number;
  keys: PublicJwk[];
  imported: Map<string, Promise<CryptoKey | null>>;
  lastMissFetch: number;
  failUntil: number;
  inflight: Promise<boolean> | null;
}

const cache = new Map<string, Entry>();

export const jwksUrl = (env: JwksEnv): string | null =>
  env.SUPABASE_URL ? `${env.SUPABASE_URL.replace(/\/+$/, '')}/auth/v1/.well-known/jwks.json` : null;

export type KeyLookup = { key: CryptoKey } | { missing: true } | { unavailable: true };

async function refresh(url: string, e: Entry, env: JwksEnv, now: number, fetcher: typeof fetch): Promise<boolean> {
  if (e.inflight) return e.inflight;
  e.inflight = (async () => {
    try {
      const res = await fetcher(url, { headers: { accept: 'application/json', ...(env.SUPABASE_PUBLISHABLE_KEY ? { apikey: env.SUPABASE_PUBLISHABLE_KEY } : {}) } });
      if (!res.ok) throw new Error(`jwks ${res.status}`);
      const body = (await res.json()) as { keys?: unknown };
      const keys = Array.isArray(body.keys) ? (body.keys as PublicJwk[]).filter((k) => k && typeof k === 'object' && typeof k.kty === 'string') : [];
      e.keys = keys.slice(0, 20);
      e.imported = new Map();
      e.at = now;
      e.failUntil = 0;
      return true;
    } catch {
      e.failUntil = now + JWKS_FAIL_HOLD_MS;
      return false;
    } finally {
      e.inflight = null;
    }
  })();
  return e.inflight;
}

const pick = (e: Entry, kid: string, alg: Alg): PublicJwk | undefined =>
  e.keys.find((k) => k.kid === kid && (alg === 'ES256' ? k.kty === 'EC' : k.kty === 'RSA') && (!k.alg || k.alg === alg) && (!k.use || k.use === 'sig'));

/** The verification key Supabase lists under `kid` for `alg`. */
export async function getSigningKey(env: JwksEnv, kid: string, alg: Alg, now = Date.now(), fetcher: typeof fetch = fetch): Promise<KeyLookup> {
  const url = jwksUrl(env);
  if (!url || !kid || kid.length > 200) return { unavailable: true };
  let e = cache.get(url);
  if (!e) {
    e = { at: 0, keys: [], imported: new Map(), lastMissFetch: 0, failUntil: 0, inflight: null };
    cache.set(url, e);
  }
  const stale = now - e.at >= JWKS_TTL_MS;
  if (stale) {
    if (now < e.failUntil && e.at === 0) return { unavailable: true };
    if (now >= e.failUntil) {
      const ok = await refresh(url, e, env, now, fetcher);
      // Keep using a recently good list through a short outage, but never one that's
      // more than twice its age — then it's "unavailable" and callers ask Supabase.
      if (!ok && (e.at === 0 || now - e.at >= 2 * JWKS_TTL_MS)) return { unavailable: true };
    } else if (now - e.at >= 2 * JWKS_TTL_MS) {
      return { unavailable: true };
    }
  }
  let jwk = pick(e, kid, alg);
  if (!jwk && now - e.lastMissFetch >= JWKS_MISS_REFETCH_MS && now >= e.failUntil) {
    e.lastMissFetch = now;
    if (await refresh(url, e, env, now, fetcher)) jwk = pick(e, kid, alg);
  }
  if (!jwk) return { missing: true };
  const memo = `${alg}:${kid}`;
  let imported = e.imported.get(memo);
  if (!imported) {
    imported = importVerifyKey(jwk, alg);
    e.imported.set(memo, imported);
  }
  const key = await imported;
  return key ? { key } : { missing: true };
}

/** Tests only. */
export function resetJwksCache(): void {
  cache.clear();
}
