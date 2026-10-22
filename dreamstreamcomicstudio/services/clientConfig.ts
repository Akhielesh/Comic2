// The frontend talks to the backend at the SITE's own /api/* path: a Cloudflare Worker
// route (dreamstream-api) sits in front of the Pages site and serves /api/* from the
// Cloudflare Container. So the correct VITE_API_BASE_URL is EMPTY (same-origin, no CORS).
//
// The backend left Railway in Oct 2026. A stale VITE_API_BASE_URL still pointing at the
// old `*.up.railway.app` service can linger in the Pages build env and makes every
// request fail with "Couldn't reach the server" (the Railway trial is expired). Ignore
// any Railway base so the app self-heals to same-origin on the next deploy, even before
// the build-time env var is cleared.
export const resolveApiBase = (raw: string): string => {
  const base = (raw || '').trim();
  if (!base) return '';
  let host = '';
  try {
    host = new URL(base).hostname.toLowerCase();
  } catch {
    // Not an absolute URL (e.g. a bare path or malformed value) — treat the whole string.
    if (/\.up\.railway\.app/i.test(base)) return '';
    return base.replace(/\/+$/, '');
  }
  if (host.endsWith('.up.railway.app')) return '';
  return base.replace(/\/+$/, '');
};

export const API_BASE_URL = resolveApiBase(import.meta.env.VITE_API_BASE_URL || '');

export const buildApiUrl = (path: string) => {
  if (!path.startsWith('/')) return `${API_BASE_URL}/${path}`;
  return `${API_BASE_URL}${path}`;
};

// Cloudflare Turnstile (bot protection). Empty site key ⇒ fully dormant: no widget renders,
// no token is required, nothing changes. Set VITE_TURNSTILE_SITE_KEY to turn it on.
export const TURNSTILE_SITE_KEY = (import.meta.env.VITE_TURNSTILE_SITE_KEY || '').trim();
export const turnstileEnabled = (): boolean => Boolean(TURNSTILE_SITE_KEY);
