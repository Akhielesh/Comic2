// SHARE_VIEW_SALT for the edge share routes (viewer hash + tracking HMAC).
//
// Preferred home: a real Worker secret (`wrangler secret put SHARE_VIEW_SALT`). Fallback: the
// D1 `backend_env` row of the same name — the same store the backend container boots from, so one
// row serves both the edge (here) and the server's report-dedupe fallback. Read at most once per
// 5 minutes per isolate, never logged, never returned to a client. Without a usable value the share
// routes still serve comics; only view tracking stays off (comic_publication_track is a no-op).

import type { EnvDb } from './backendEnv';

export interface ShareSaltEnv {
  SHARE_VIEW_SALT?: string;
  BACKEND_ENV?: EnvDb;
}

/** The minimum the routes accept (publicComic.ts checks the same). */
export const SHARE_VIEW_SALT_MIN_CHARS = 32;
const CACHE_MS = 5 * 60_000;

let cached: { value: string | undefined; at: number } | null = null;

const usable = (value: unknown): string | undefined => {
  const v = typeof value === 'string' ? value.trim() : '';
  return v.length >= SHARE_VIEW_SALT_MIN_CHARS ? v : undefined;
};

/** The salt to use: the Worker secret when set, else the cached D1 row, else undefined. */
export async function resolveShareViewSalt(env: ShareSaltEnv, now = Date.now()): Promise<string | undefined> {
  const own = usable(env.SHARE_VIEW_SALT);
  if (own) return own;
  if (!env.BACKEND_ENV) return undefined;
  if (cached && now - cached.at < CACHE_MS) return cached.value;
  let value: string | undefined;
  try {
    const { results } = await env.BACKEND_ENV.prepare("SELECT value FROM backend_env WHERE name = 'SHARE_VIEW_SALT' LIMIT 1").all<{ value?: unknown }>();
    value = usable(results?.[0]?.value);
  } catch {
    value = undefined; // D1 hiccup: tracking stays off for this window, reads are unaffected
  }
  cached = { value, at: now };
  return value;
}

/** `env` with SHARE_VIEW_SALT filled from the fallback when the Worker secret is absent. */
export async function withShareViewSalt<E extends ShareSaltEnv>(env: E, now = Date.now()): Promise<E> {
  const salt = await resolveShareViewSalt(env, now);
  if (!salt || salt === env.SHARE_VIEW_SALT) return env;
  return { ...env, SHARE_VIEW_SALT: salt };
}

/** Tests only. */
export function resetShareViewSaltCache(): void {
  cached = null;
}
