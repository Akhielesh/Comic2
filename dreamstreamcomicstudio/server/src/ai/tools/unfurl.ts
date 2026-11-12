// Link unfurl — fetch a URL and extract OpenGraph/meta preview data (title,
// description, image, site name) for source hover-cards. Reachable pre-auth
// (/api/chat/unfurl), so every part is bounded:
//  - SSRF: fetchPublicUrl via fetchTextCapped({ publicOnly }) — https + public host, the
//    resolved IP pinned for the connection, every redirect hop re-checked;
//  - time and size: one 8 s deadline over headers AND body, download stopped at 150 KB;
//  - CPU: linear-time meta scanning (htmlScan.ts), no backtracking regexes;
//  - memory: a bounded LRU cache (500 entries) of short, owned copies of the fields, expired
//    entries swept on access — no interval timer (the container must stay sleepable).

import { isSafeMcpUrl } from './mcpClient.js';
import { fetchTextCapped } from './http.js';
import { asciiLower, metaTags, titleText } from './htmlScan.js';

export interface UnfurlResult {
  url: string;
  title?: string;
  description?: string;
  image?: string;
  siteName?: string;
}

const TTL_MS = 30 * 60_000;
export const UNFURL_CACHE_MAX = 500;
const MAX_BYTES = 150_000;
const MAX_URL_CHARS = 2048;
const UA = 'Mozilla/5.0 (compatible; DreamStreamBot/1.0; +https://dreamstream)';

const cache = new Map<string, { at: number; data: UnfurlResult }>();

const decode = (s: string): string =>
  s
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#x27;|&#39;/g, "'").replace(/&#x2F;/g, '/')
    .trim();

/** A short, independent copy (a slice of the page would keep the whole page alive in the cache). */
const owned = (s: string | undefined, max: number): string | undefined => {
  if (!s) return undefined;
  const clipped = s.slice(0, max);
  return clipped ? Buffer.from(clipped, 'utf8').toString('utf8') : undefined;
};

const httpUrl = (raw: string | undefined, base: string): string | undefined => {
  if (!raw) return undefined;
  try {
    const u = new URL(raw, base);
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.href : undefined;
  } catch {
    return undefined;
  }
};

/** Parse preview fields from a page's HTML (pure, linear time). Exported for tests. */
export const parseUnfurl = (html: string, url: string): UnfurlResult => {
  const lower = asciiLower(html);
  const meta = metaTags(html, lower);
  const pick = (...keys: string[]): string | undefined => {
    for (const k of keys) {
      const v = meta.get(k);
      if (v) {
        const d = decode(v);
        if (d) return d;
      }
    }
    return undefined;
  };
  const titleTag = titleText(html, lower);
  return {
    url: owned(url, MAX_URL_CHARS) || url,
    title: owned(pick('og:title', 'twitter:title') || (titleTag ? decode(titleTag) || undefined : undefined), 300),
    description: owned(pick('og:description', 'description', 'twitter:description'), 500),
    image: owned(httpUrl(pick('og:image', 'twitter:image'), url), MAX_URL_CHARS),
    siteName: owned(pick('og:site_name'), 120)
  };
};

const cacheGet = (url: string, now: number): UnfurlResult | undefined => {
  const hit = cache.get(url);
  if (!hit) return undefined;
  cache.delete(url);
  if (now - hit.at >= TTL_MS) return undefined;
  cache.set(url, hit); // most recently used goes to the back
  return hit.data;
};

const cachePut = (url: string, data: UnfurlResult, now: number): void => {
  // Sweep expired entries on access (bounded: the map never holds more than UNFURL_CACHE_MAX).
  for (const [k, v] of cache) if (now - v.at >= TTL_MS) cache.delete(k);
  cache.delete(url);
  while (cache.size >= UNFURL_CACHE_MAX) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
  cache.set(url, { at: now, data });
};

/** Test/inspection hooks. */
export const __unfurlCacheSize = (): number => cache.size;
export const __clearUnfurlCache = (): void => cache.clear();

export const unfurlUrl = async (url: string): Promise<UnfurlResult> => {
  const cached = cacheGet(url, Date.now());
  if (cached) return cached;

  if (url.length > MAX_URL_CHARS) throw new Error('URL too long');
  const safe = isSafeMcpUrl(url);
  if (!safe.ok) throw new Error(safe.reason || 'URL not allowed');

  const page = await fetchTextCapped(url, {
    timeoutMs: 8000,
    accept: 'text/html',
    headers: { 'User-Agent': UA },
    maxBytes: MAX_BYTES,
    publicOnly: true
  });
  const data = parseUnfurl(page.text, url);
  cachePut(url, data, Date.now());
  return data;
};
