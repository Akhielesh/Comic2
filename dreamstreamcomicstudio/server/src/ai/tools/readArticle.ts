// Server-side "reader mode": fetch a public article URL and extract its readable
// content (title, byline, lead image, paragraphs) so the chat can show it INLINE
// instead of bouncing the user to a new tab. Most news sites block iframing, so this
// extraction is the only reliable way to read in-window.
//
// Deliberately dependency-free: a small, robust heuristic (strip chrome, pick the
// densest text container, keep paragraphs + subheads) rather than a full readability
// port. Best-effort — callers fall back to "open original" when extraction is thin.

import { fetchTextCapped, hostOf } from './http.js';
import { decodeGoogleNewsUrl, isGoogleNewsUrl } from './googleNews.js';
import { asciiLower, firstElement, forEachBlock, metaTags, removeElements, stripMarkdownInline, stripTagsLinear, titleText } from './htmlScan.js';
import { currentAccountId, hasRequestContext } from '../../lib/accountContext.js';

/** Download cap for a page read (the body stops streaming here). */
export const READ_MAX_BYTES = 1_000_000;
/** What the parser sees: the first 256 KB of the page (articles start well inside it). */
export const READ_PARSE_CHARS = 256 * 1024;
/** Cap for the Jina reader fallback's response. */
const JINA_MAX_BYTES = 1_000_000;

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
  /**
   * Why a read failed (ok=false). `fetch_failed` = the request itself errored (timeout,
   * connection refused, 403/anti-bot, SSRF block) → the HOST is likely blocking automated
   * reads, so callers can skip the whole host instead of burning the timeout again.
   * `empty` = fetched fine but no readable content (this PAGE only — paywall/JS-rendered).
   */
  reason?: 'fetch_failed' | 'empty';
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

const stripTags = (html: string): string => decodeEntities(stripTagsLinear(html)).replace(/\s+/g, ' ').trim();

/** First non-empty meta value among the keys (property or name), entity-decoded. */
const metaContent = (meta: Map<string, string>, keys: string[]): string | undefined => {
  for (const k of keys) {
    const raw = meta.get(k);
    if (!raw) continue;
    const v = decodeEntities(raw).trim();
    if (v) return v;
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

/** Is the current caller an anonymous web request (signed-out visitor)? Background work is not. */
const isAnonymousCaller = (): boolean => hasRequestContext() && !currentAccountId();

/**
 * Extract the readable article from a page's HTML (pure, linear-time: see htmlScan.ts).
 * Exported for tests and for callers that already hold the HTML.
 */
export const extractArticle = (
  html: string,
  url: string
): Pick<ReadArticleResult, 'title' | 'byline' | 'image' | 'blocks'> & { charCount: number } => {
  const lower = asciiLower(html);
  const meta = metaTags(html, lower);
  const titleTag = titleText(html, lower);
  const title = metaContent(meta, ['og:title', 'twitter:title']) || (titleTag ? decodeEntities(titleTag).trim() || undefined : undefined);
  const image = absolutize(metaContent(meta, ['og:image', 'og:image:url', 'twitter:image']), url);
  const byline = metaContent(meta, ['author', 'article:author']);

  // Isolate the main content region: prefer <article>, then <main>, then the whole body.
  const region =
    firstElement(html, 'article', lower) || firstElement(html, 'main', lower) || firstElement(html, 'body', lower) || html;

  // Drop non-content chrome before pulling text.
  const cleaned = removeElements(
    region,
    ['script', 'style', 'noscript', 'svg', 'nav', 'header', 'footer', 'aside', 'form', 'figure', 'figcaption'],
    { comments: true }
  );

  // Walk block elements in order, keeping subheads and substantive paragraphs.
  const blocks: ReadArticleResult['blocks'] = [];
  const seen = new Set<string>();
  forEachBlock(cleaned, ['h2', 'h3', 'p', 'li'], (tag, inner) => {
    const text = stripTags(inner);
    if (!text || text.length < (tag === 'h2' || tag === 'h3' ? 3 : 40)) return true; // skip nav-ish fragments
    if (seen.has(text)) return true;
    seen.add(text);
    blocks.push({ type: tag === 'h2' || tag === 'h3' ? 'h' : 'p', text: text.slice(0, 2000) });
    return blocks.length < 120;
  });

  // Total readable text length is the quality signal.
  const charCount = blocks.reduce((n, b) => n + (b.type === 'p' ? b.text.length : 0), 0);
  return { title: title?.slice(0, 300), byline: byline?.slice(0, 160), image, blocks: blocks.slice(0, 80), charCount };
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

  // SSRF gate: this route is reachable pre-auth, so every hop goes through fetchPublicUrl
  // (https + public host, the resolved IP pinned for the connection, each redirect
  // re-checked — a 302 to 127.0.0.1 or cloud metadata is refused, not followed). One 9 s
  // deadline covers headers AND body, and the download stops at 1 MB.
  let html: string;
  try {
    const page = await fetchTextCapped(target, {
      timeoutMs: 9000,
      accept: 'text/html,*/*',
      signal,
      maxBytes: READ_MAX_BYTES,
      publicOnly: true
    });
    html = page.text.slice(0, READ_PARSE_CHARS);
  } catch {
    // The request itself failed (timeout / refused / anti-bot 403 / SSRF) — the host is
    // likely blocking automated reads. Flag it so the caller can skip the host next time
    // instead of re-paying the 9s timeout.
    base.reason = 'fetch_failed';
    return base;
  }

  const { charCount, ...extracted } = extractArticle(html, url);
  const direct: ReadArticleResult = {
    ...base,
    ...extracted,
    ok: charCount >= 240, // a couple of real paragraphs
    // Fetched fine but thin → this PAGE is paywalled/JS-only; the host isn't blocking us,
    // so don't penalize the whole host (only `fetch_failed` does that).
    reason: charCount >= 240 ? undefined : 'empty'
  };
  if (direct.ok) return direct;

  // Direct fetch came back thin (bot wall / JS-only site — most large publishers
  // 403 datacenter IPs). Best-effort second pass through the Jina reader proxy,
  // which fetches + extracts on its own infra. Budget-metered and only for signed-in
  // callers: an anonymous visitor must not be able to spend the shared Jina quota (or
  // use it to fetch pages for them). Failures keep the honest "open original" fallback.
  if (isAnonymousCaller()) return direct;
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

/** Strip inline markdown (links, emphasis, images) down to plain text (linear: htmlScan.ts). */
const stripMdInline = stripMarkdownInline;

const readViaJina = async (url: string, signal?: AbortSignal) => {
  const key = process.env.JINA_API_KEY;
  const { text } = await fetchTextCapped(`https://r.jina.ai/${url}`, {
    timeoutMs: 14_000,
    accept: 'text/plain',
    headers: key ? { Authorization: `Bearer ${key}` } : undefined,
    signal,
    maxBytes: JINA_MAX_BYTES
  });
  return parseJinaReader(text.slice(0, READ_PARSE_CHARS));
};
