// Server-side "reader mode": fetch a public article URL and extract its readable
// content (title, byline, lead image, paragraphs) so the chat can show it INLINE
// instead of bouncing the user to a new tab. Most news sites block iframing, so this
// extraction is the only reliable way to read in-window.
//
// Deliberately dependency-free: a small, robust heuristic (strip chrome, pick the
// densest text container, keep paragraphs + subheads) rather than a full readability
// port. Best-effort — callers fall back to "open original" when extraction is thin.

import { fetchText, hostOf } from './http.js';
import { assertSafePublicUrl } from './mcpClient.js';
import { decodeGoogleNewsUrl, isGoogleNewsUrl } from './googleNews.js';

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
  /** The publisher URL when `url` was an aggregator redirect (Google News). */
  resolvedUrl?: string;
  resolvedHost?: string;
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

  // Google News RSS links are JS-redirect interstitials with no article text —
  // resolve them to the publisher's URL first or extraction always comes up empty.
  let target = url;
  if (isGoogleNewsUrl(url)) {
    const real = await decodeGoogleNewsUrl(url, signal).catch(() => null);
    if (real && isFetchableUrl(real)) {
      target = real;
      base.resolvedUrl = real;
      base.resolvedHost = hostOf(real);
    }
  }

  // SSRF gate: the hostname-pattern check in isFetchableUrl misses DNS rebinding
  // (a public name resolving to 127.0.0.1 / cloud metadata) — verify the RESOLVED
  // IPs too. This route is reachable pre-auth, so the check must be airtight.
  let html: string;
  try {
    await assertSafePublicUrl(target);
    html = await fetchText(target, { timeoutMs: 9000, accept: 'text/html,*/*', signal });
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
  const direct: ReadArticleResult = {
    ...base,
    title: title?.slice(0, 300),
    byline: byline?.slice(0, 160),
    image,
    blocks: blocks.slice(0, 80),
    ok: charCount >= 240 // a couple of real paragraphs
  };
  if (direct.ok) return direct;

  // Direct fetch came back thin (bot wall / JS-only site — most large publishers
  // 403 datacenter IPs). Best-effort second pass through the Jina reader proxy,
  // which fetches + extracts on its own infra. Budget-metered; failures keep the
  // honest "open original" fallback.
  const viaJina = await readViaJina(target, signal).catch((): null => null);
  if (viaJina && viaJina.blocks.length) {
    return {
      ...direct,
      title: direct.title || viaJina.title,
      image: direct.image || viaJina.image,
      blocks: viaJina.blocks,
      ok: true
    };
  }
  return direct;
};

// ------------------------------------------------------ Jina reader fallback ----

/** Parse a Jina Reader text/plain response ("Title: …\n…\nMarkdown Content:\n…")
 *  into reader blocks. Pure + exported for tests. */
export const parseJinaReader = (text: string): { title?: string; image?: string; blocks: ReadArticleResult['blocks'] } | null => {
  const title = text.match(/^Title:\s*(.+)$/m)?.[1]?.trim();
  const idx = text.indexOf('Markdown Content:');
  const md = idx >= 0 ? text.slice(idx + 'Markdown Content:'.length) : text;
  const blocks: ReadArticleResult['blocks'] = [];
  let image: string | undefined;
  const seen = new Set<string>();
  for (const rawLine of md.split(/\n+/)) {
    if (blocks.length >= 80) break;
    const line = rawLine.trim();
    if (!line) continue;
    const img = line.match(/^!\[[^\]]*\]\((https?:[^)\s]+)/);
    if (img) {
      image = image || img[1];
      continue;
    }
    const head = line.match(/^#{1,4}\s+(.+)$/);
    if (head) {
      const t = stripMdInline(head[1]);
      if (t && !seen.has(t)) {
        seen.add(t);
        blocks.push({ type: 'h', text: t.slice(0, 300) });
      }
      continue;
    }
    // Skip nav/list/link-noise lines; keep substantive paragraphs.
    if (/^[-*>|]|^\d+\.\s|^\[/.test(line)) continue;
    const t = stripMdInline(line);
    if (t.length < 40 || seen.has(t)) continue;
    seen.add(t);
    blocks.push({ type: 'p', text: t.slice(0, 2000) });
  }
  const charCount = blocks.reduce((n, b) => n + (b.type === 'p' ? b.text.length : 0), 0);
  if (charCount < 240) return null;
  return { title, image, blocks };
};

/** Strip inline markdown (links, emphasis, images) down to plain text. */
const stripMdInline = (s: string): string =>
  s
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[*_`]{1,3}([^*_`]+)[*_`]{1,3}/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();

const readViaJina = async (url: string, signal?: AbortSignal) => {
  const key = process.env.JINA_API_KEY;
  const text = await fetchText(`https://r.jina.ai/${url}`, {
    timeoutMs: 14_000,
    accept: 'text/plain',
    headers: key ? { Authorization: `Bearer ${key}` } : undefined,
    signal
  });
  return parseJinaReader(text);
};
