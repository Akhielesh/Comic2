export const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || '';

export const buildApiUrl = (path: string) => {
  if (!path.startsWith('/')) return `${API_BASE_URL}/${path}`;
  return `${API_BASE_URL}${path}`;
};

// Cloudflare Turnstile (bot protection). Empty site key ⇒ fully dormant: no widget renders,
// no token is required, nothing changes. Set VITE_TURNSTILE_SITE_KEY to turn it on.
export const TURNSTILE_SITE_KEY = (import.meta.env.VITE_TURNSTILE_SITE_KEY || '').trim();
export const turnstileEnabled = (): boolean => Boolean(TURNSTILE_SITE_KEY);
