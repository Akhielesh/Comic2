// Link unfurl — fetch a URL and extract OpenGraph/meta preview data (title,
// description, image, site name) for source hover-cards. SSRF-guarded (https +
// private-host blocklist, shared with the MCP client), size-capped, cached.

import { isSafeMcpUrl, fetchPublicUrl } from './mcpClient.js';

export interface UnfurlResult {
  url: string;
  title?: string;
  description?: string;
  image?: string;
  siteName?: string;
}

const cache = new Map<string, { at: number; data: UnfurlResult }>();
const TTL_MS = 30 * 60_000;
const MAX_BYTES = 150_000;
const UA = 'Mozilla/5.0 (compatible; DreamStreamBot/1.0; +https://dreamstream)';

const decode = (s: string): string =>
  s
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#x27;|&#39;/g, "'").replace(/&#x2F;/g, '/')
    .trim();

// Match a <meta> tag with property/name == key, content in either attribute order.
const metaContent = (html: string, key: string): string | undefined => {
  const k = key.replace(/[:]/g, '\\:');
  const a = html.match(new RegExp(`<meta[^>]+(?:property|name)=["']${k}["'][^>]*?content=["']([^"']*)["']`, 'i'));
  if (a?.[1]) return decode(a[1]);
  const b = html.match(new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]*?(?:property|name)=["']${k}["']`, 'i'));
  if (b?.[1]) return decode(b[1]);
  return undefined;
};

export const unfurlUrl = async (url: string): Promise<UnfurlResult> => {
  const cached = cache.get(url);
  if (cached && Date.now() - cached.at < TTL_MS) return cached.data;

  const safe = isSafeMcpUrl(url);
  if (!safe.ok) throw new Error(safe.reason || 'URL not allowed');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    // fetchPublicUrl re-runs the SSRF gate (DNS-resolution check included) on
    // every redirect hop — this route is reachable pre-auth, so a public site
    // 302'ing into 127.0.0.1/metadata must be caught, not followed.
    const res = await fetchPublicUrl(url, { headers: { 'User-Agent': UA, Accept: 'text/html' }, signal: controller.signal });
    if (!res.ok) throw new Error(`Fetch failed (${res.status})`);

    let html = '';
    const reader = (res.body as ReadableStream<Uint8Array> | null)?.getReader();
    if (reader) {
      const dec = new TextDecoder();
      let total = 0;
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.length;
        html += dec.decode(value, { stream: true });
        if (total > MAX_BYTES) { controller.abort(); break; }
      }
    } else {
      html = (await res.text()).slice(0, MAX_BYTES);
    }

    const titleTag = html.match(/<title[^>]*>([^<]+)<\/title>/i)?.[1];
    const data: UnfurlResult = {
      url,
      title: metaContent(html, 'og:title') || metaContent(html, 'twitter:title') || (titleTag ? decode(titleTag) : undefined),
      description: metaContent(html, 'og:description') || metaContent(html, 'description') || metaContent(html, 'twitter:description'),
      image: metaContent(html, 'og:image') || metaContent(html, 'twitter:image'),
      siteName: metaContent(html, 'og:site_name')
    };
    cache.set(url, { at: Date.now(), data });
    return data;
  } finally {
    clearTimeout(timer);
  }
};
