import { isPrivatePath, legacyArtScope } from '../../shared/comic/imagePaths';

export interface UrlEntry {
  url: string;
  /** Epoch ms after which the URL stops working (Infinity for data:/blob: URLs). */
  expiresAt: number;
  /** Previously signed physical storage locations for this same immutable project key. */
  retiredLocations?: readonly string[];
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

/** Old Director originals and variants keep the same logical key through the private-storage cutover. */
export const isProtectedStudioPath = (path: string): boolean => isPrivatePath(path) || !!legacyArtScope(path);

/** Authenticate access through the API's signed map. The decoded claims here only bind its location and lifetime. */
function legacySignedLocation(path: string, url: string): string | undefined {
  try {
    const parsed = new URL(url);
    if (!/^https?:$/.test(parsed.protocol) || parsed.username || parsed.password) return undefined;
    const configured = import.meta.env.VITE_SUPABASE_URL ? new URL(import.meta.env.VITE_SUPABASE_URL) : undefined;
    if (configured && parsed.origin !== configured.origin) return undefined;
    const prefix = (configured?.pathname.replace(/\/$/, '') ?? '') + '/storage/v1/';
    if (!parsed.pathname.startsWith(prefix)) return undefined;
    const match = /^(?:object|render\/image)\/sign\/([^/]+)\/(.+)$/.exec(parsed.pathname.slice(prefix.length));
    if (!match || decodeURIComponent(match[2]) !== path || /%2f|%5c/i.test(match[2])) return undefined;
    const bucket = decodeURIComponent(match[1]);
    if (!bucket || bucket === '.' || bucket === '..' || /[/\\?#\x00-\x1f]/.test(bucket)) return undefined;
    const token = parsed.searchParams.get('token')?.split('.');
    if (token?.length !== 3 || !token[0] || !token[2]) return undefined;
    const claim = JSON.parse(decodeBase64Url(token[1])) as { url?: unknown; exp?: unknown };
    if (typeof claim.exp !== 'number' || !Number.isFinite(claim.exp) || claim.url !== bucket + '/' + path) return undefined;
    return parsed.origin + '/' + bucket;
  } catch {
    return undefined;
  }
}

/** A decoded bitmap may survive a routine signature renewal, but must never cross physical storage locations. */
export function studioBitmapKey(path: string, url: string | undefined): string | undefined {
  if (path.includes('\0')) return undefined;
  if (legacyArtScope(path)) {
    const location = url && legacySignedLocation(path, url);
    return location ? path + '\0' + location : undefined;
  }
  return isPrivatePath(path) && !url ? undefined : path;
}

/**
 * When a signed storage URL expires. Supabase signed URLs carry a JWT in `?token=` whose
 * `exp` is authoritative; anything else falls back to the server's minimum-validity
 * guarantee so we re-sign early rather than show a broken image.
 */
export const signedUrlExpiry = (url: string, receivedAt: number, path = ''): number => {
  const privatePath = isProtectedStudioPath(path);
  const fallback = receivedAt + (privatePath ? PRIVATE_URL_TTL_MS : URL_FALLBACK_TTL_MS);
  if (/^(data|blob):/i.test(url)) return privatePath ? fallback : Number.POSITIVE_INFINITY;
  try {
    const token = new URL(url).searchParams.get('token');
    const payload = token?.split('.')[1];
    if (payload) {
      const { exp, iat } = JSON.parse(decodeBase64Url(payload)) as { exp?: unknown; iat?: unknown };
      if (typeof exp === 'number' && Number.isFinite(exp)) {
        if (!privatePath) return exp * 1000;
        const issuedLimit = legacyArtScope(path) && typeof iat === 'number' && Number.isFinite(iat)
          ? iat * 1000 + PRIVATE_URL_TTL_MS : fallback;
        return Math.min(exp * 1000, fallback, issuedLimit);
      }
    }
  } catch {
    /* not a URL / not a JWT — use the fallback */
  }
  return fallback;
};

export const urlIsFresh = (entry: UrlEntry | undefined, now: number, path = ''): boolean =>
  !!entry && entry.expiresAt - now > (isProtectedStudioPath(path) ? PRIVATE_RENEW_BEFORE_MS : URL_RESIGN_BEFORE_MS);

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
    const previous = current[path];
    let retiredLocations = previous?.retiredLocations;
    if (legacyArtScope(path)) {
      const location = legacySignedLocation(path, url);
      if (!location) {
        delete next[path];
        continue;
      }
      const prior = previous && legacySignedLocation(path, previous.url);
      if (prior && prior !== location) {
        // A late public response cannot put old artwork back after the private signer has taken over.
        const publicBucket = import.meta.env.VITE_SUPABASE_BUCKET || 'comic-assets';
        if (location.endsWith('/' + publicBucket) || retiredLocations?.includes(location)) continue;
        retiredLocations = [...(retiredLocations ?? []), prior];
      }
    } else if (isPrivatePath(path) && /\/storage\/v1\/(?:object|render\/image)\/public\//i.test(url)) {
      delete next[path];
      continue;
    }
    const expiresAt = signedUrlExpiry(url, now, path);
    next[path] = {
      url,
      expiresAt: isProtectedStudioPath(path) && previous?.url === url ? Math.min(previous.expiresAt, expiresAt) : expiresAt,
      ...(retiredLocations ? { retiredLocations } : {})
    };
  }
  return next;
};

/** A successful refresh is authoritative for every requested path, including omissions. */
export function refreshSignedUrls(current: Record<string, UrlEntry>, paths: readonly string[], incoming: Record<string, string>, now: number) {
  const next = { ...mergeUrls(current, incoming, now) };
  for (const path of paths) if (!incoming[path]) delete next[path];
  return next;
}

export function signingAccessDenied(err: unknown): boolean {
  const status = (err as { status?: number } | null)?.status;
  return status === 401 || status === 403 || status === 404;
}

/** Embedded document URLs are never credentials for private artwork. Signed maps come from the owner API. */
export function directDisplayUrl(value: string): string | undefined {
  if (/^(data|blob):/i.test(value)) return value;
  try {
    const url = new URL(value);
    if (!/^https?:$/.test(url.protocol)) return undefined;
    const pathname = decodeURIComponent(url.pathname);
    for (const prefix of pathname.matchAll(/\/(?:q|u)(?=\/)/g)) {
      if (isProtectedStudioPath(pathname.slice(prefix.index! + 1))) return undefined;
    }
    return value;
  } catch {
    return undefined;
  }
}
