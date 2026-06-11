// Server-side "reader mode": fetch a public article URL and extract its readable
// content (title, byline, lead image, paragraphs) so the chat can show it INLINE
// instead of bouncing the user to a new tab. Most news sites block iframing, so this
// extraction is the only reliable way to read in-window.
//
// Deliberately dependency-free: a small, robust heuristic (strip chrome, pick the
// densest text container, keep paragraphs + subheads) rather than a full readability
// port. Best-effort — callers fall back to "open original" when extraction is thin.

import { fetchText, hostOf } from './http.js';

export interface ReadArticleResult {
  url: string;
  host: string;
  title?: string;
  byline?: string;
  image?: string;
  /** Ordered blocks: subheads ({h}) and paragraphs ({p}). */
  blocks: { type: 'h' | 'p'; text: string }[];
  /** Whether we got a usable amount of text. */
  ok: boolean;
}

// --- SSRF guard: only fetch public http(s) URLs, never internal/loopback hosts. ---
const PRIVATE_HOST = /^(localhost$|127\.|10\.|192\.168\.|169\.254\.|0\.0\.0\.0$|\[?::1\]?$|\[?fe80:|\[?fc00:|\[?fd)/i;
const isPrivateIpv4 = (host: string): boolean => {
  const m = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  return a === 10 || a === 127 || a === 0 || (a === 192 && b === 168) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31);
};
export const isFetchableUrl = (raw: string): boolean => {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
  const host = u.hostname.toLowerCase();
  if (PRIVATE_HOST.test(host) || isPrivateIpv4(host)) return false;
  return true;
};

const decodeEntities = (s: string): string =>
  s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, n) => {
      try {
        return String.fromCodePoint(Number(n));
      } catch {
        return '';
      }
    })
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => {
      try {
        return String.fromCodePoint(parseInt(h, 16));
      } catch {
        return '';
      }
    });

const stripTags = (html: string): string => decodeEntities(html.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();

const metaContent = (html: string, patterns: RegExp[]): string | undefined => {
  for (const re of patterns) {
    const m = html.match(re);
    if (m && m[1]) {
      const v = decodeEntities(m[1]).trim();
      if (v) return v;
    }
  }
  return undefined;
};

const absolutize = (src: string | undefined, base: string): string | undefined => {
  if (!src) return undefined;
  try {
    return new URL(src, base).href;
  } catch {
    return undefined;
  }
};

export const readArticle = async (url: string, signal?: AbortSignal): Promise<ReadArticleResult> => {
  const host = hostOf(url);
  const base: ReadArticleResult = { url, host, blocks: [], ok: false };
  if (!isFetchableUrl(url)) return base;

  let html: string;
  try {
    html = await fetchText(url, { timeoutMs: 9000, accept: 'text/html,*/*', signal });
  } catch {
    return base;
  }

  const title =
    metaContent(html, [
      /<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i,
      /<meta[^>]+name=["']twitter:title["'][^>]+content=["']([^"']+)["']/i,
      /<title[^>]*>([^<]+)<\/title>/i
    ]) || undefined;
  const image = absolutize(
    metaContent(html, [
      /<meta[^>]+property=["']og:image(?::url)?["'][^>]+content=["']([^"']+)["']/i,
      /<meta[^>]+name=["']twitter:image["'][^>]+content=["']([^"']+)["']/i
    ]),
    url
  );
  const byline = metaContent(html, [
    /<meta[^>]+name=["']author["'][^>]+content=["']([^"']+)["']/i,
    /<meta[^>]+property=["']article:author["'][^>]+content=["']([^"']+)["']/i
  ]);

  // Isolate the main content region: prefer <article>, then <main>, then the whole body.
  const region =
    html.match(/<article[\s\S]*?<\/article>/i)?.[0] ||
    html.match(/<main[\s\S]*?<\/main>/i)?.[0] ||
    html.match(/<body[\s\S]*?<\/body>/i)?.[0] ||
    html;

  // Drop non-content chrome before pulling text.
  const cleaned = region
    .replace(/<(script|style|noscript|svg|nav|header|footer|aside|form|figure|figcaption)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ');

  // Walk block elements in order, keeping subheads and substantive paragraphs.
  const blocks: ReadArticleResult['blocks'] = [];
  const blockRe = /<(h2|h3|p|li)\b[^>]*>([\s\S]*?)<\/\1>/gi;
  let m: RegExpExecArray | null;
  const seen = new Set<string>();
  while ((m = blockRe.exec(cleaned)) && blocks.length < 120) {
    const tag = m[1].toLowerCase();
    const text = stripTags(m[2]);
    if (!text || text.length < (tag === 'h2' || tag === 'h3' ? 3 : 40)) continue; // skip nav-ish fragments
    if (seen.has(text)) continue;
    seen.add(text);
    blocks.push({ type: tag === 'h2' || tag === 'h3' ? 'h' : 'p', text: text.slice(0, 2000) });
  }

  // Total readable text length is the quality signal.
  const charCount = blocks.reduce((n, b) => n + (b.type === 'p' ? b.text.length : 0), 0);
  return {
    url,
    host,
    title: title?.slice(0, 300),
    byline: byline?.slice(0, 160),
    image,
    blocks: blocks.slice(0, 80),
    ok: charCount >= 240 // a couple of real paragraphs
  };
};
