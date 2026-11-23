/** These paths reside in the private bucket. Keep the signer and browser fallback in agreement. */
export const isQuarantinePath = (path: string): boolean => typeof path === 'string' && path.startsWith('q/');

export const isPrivatePath = (path: string): boolean =>
  typeof path === 'string' && (/^u\/[^/]+\/p\/[^/]+\/ref\//.test(path) || isQuarantinePath(path));

export const sanitizeImagePath = (value: unknown): string | null => {
  const raw = typeof value === 'string' ? value : Array.isArray(value) ? value[0] : '';
  if (typeof raw !== 'string') return null;
  const normalized = raw.trim().replace(/^\/+/, '');
  if (!normalized) return null;
  if (normalized.length > 512) return null;
  if (normalized.includes('..') || normalized.includes('\\')) return null;
  // The path is authorized as a literal string but signed through a URL (storage-js does not
  // encode it), and URL parsing collapses dot segments — including percent-encoded ones
  // (`%2e%2e`) — so `u/<me>/%2e%2e/<victim>/...` would be authorized as the requester's own
  // path yet signed as the victim's. Storage paths are plain [A-Za-z0-9._-] segments: refuse
  // percent-escapes, query/fragment markers, control characters and empty or dot segments.
  if (/[%?#\u0000-\u001f\u007f]/.test(normalized)) return null;
  if (normalized.split('/').some((segment) => segment === '' || segment === '.')) return null;
  return normalized;
};
