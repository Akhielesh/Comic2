import { isPrivatePath } from '../../shared/comic/imagePaths';

export interface UrlEntry {
  url: string;
  /** Epoch ms after which the URL stops working (Infinity for data:/blob: URLs). */
  expiresAt: number;
}

/** Conservative fallback for a public-lane URL without a readable storage token. */
export const URL_FALLBACK_TTL_MS = 10 * 60_000;
/** Re-sign a URL when less than this much validity remains. */
export const URL_RESIGN_BEFORE_MS = 5 * 60_000;

export const PRIVATE_URL_TTL_MS = 300_000;
export const PRIVATE_RENEW_BEFORE_MS = 30_000;

const decodeBase64Url = (input: string): string => {
  const b64 = input.replace(/-/g, '+').replace(/_/g, '/');
  const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
  if (typeof atob === 'function') return atob(padded);
  return Buffer.from(padded, 'base64').toString('binary');
};

/**
 * When a signed storage URL expires. Supabase signed URLs carry a JWT in `?token=` whose
 * `exp` is authoritative; anything else falls back to the server's minimum-validity
 * guarantee so we re-sign early rather than show a broken image.
 */
export const signedUrlExpiry = (url: string, receivedAt: number, path = ''): number => {
  const privatePath = isPrivatePath(path);
  const fallback = receivedAt + (privatePath ? PRIVATE_URL_TTL_MS : URL_FALLBACK_TTL_MS);
  if (/^(data|blob):/i.test(url)) return privatePath ? fallback : Number.POSITIVE_INFINITY;
  try {
    const token = new URL(url).searchParams.get('token');
    const payload = token?.split('.')[1];
    if (payload) {
      const exp = (JSON.parse(decodeBase64Url(payload)) as { exp?: unknown }).exp;
      if (typeof exp === 'number' && Number.isFinite(exp)) return privatePath ? Math.min(exp * 1000, fallback) : exp * 1000;
    }
  } catch {
    /* not a URL / not a JWT — use the fallback */
  }
  return fallback;
};

export const urlIsFresh = (entry: UrlEntry | undefined, now: number, path = ''): boolean =>
  !!entry && entry.expiresAt - now > (isPrivatePath(path) ? PRIVATE_RENEW_BEFORE_MS : URL_RESIGN_BEFORE_MS);

export const mergeUrls = (
  current: Record<string, UrlEntry>,
  incoming: Record<string, string> | undefined,
  now: number
): Record<string, UrlEntry> => {
  if (!incoming) return current;
  const entries = Object.entries(incoming).filter(([path, url]) => typeof path === 'string' && typeof url === 'string' && url);
  if (!entries.length) return current;
  const next = { ...current };
  for (const [path, url] of entries) {
    // A broken signer must never turn a private filename into a public-bucket URL.
    if (isPrivatePath(path) && /\/storage\/v1\/(?:object|render\/image)\/public\//i.test(url)) delete next[path];
    else {
      const expiresAt = signedUrlExpiry(url, now, path);
      const previous = current[path];
      next[path] = { url, expiresAt: isPrivatePath(path) && previous?.url === url ? Math.min(previous.expiresAt, expiresAt) : expiresAt };
    }
  }
  return next;
};

/** Embedded document URLs are never credentials for private artwork. Signed maps come from the owner API. */
export function directDisplayUrl(value: string): string | undefined {
  if (/^(data|blob):/i.test(value)) return value;
  try {
    const url = new URL(value);
    if (!/^https?:$/.test(url.protocol)) return undefined;
    const suffix = decodeURIComponent(url.pathname).match(/(?:^|\/)((?:q|u)\/.+)$/)?.[1];
    if (suffix && isPrivatePath(suffix)) return undefined;
    return value;
  } catch {
    return undefined;
  }
}
