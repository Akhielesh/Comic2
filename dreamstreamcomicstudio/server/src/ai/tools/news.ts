// News via Google News RSS — free, keyless, open, and far more reliable than HTML
// scraping. Supports a free-text query, topical sections (World, Business, Tech…)
// and locale/region targeting so "latest news" resolves to the user's place and
// language. Returns a structured NewsResultsArtifact the client renders as a card.
//
// Like the other tools these public endpoints can't be runtime-verified inside the
// build sandbox (no outbound network); the parser is pure + unit-tested, and all
// network failures degrade to a clear message rather than throwing.

import type { NewsItem, NewsResultsArtifact } from '../../../../apiTypes.js';

const RSS_BASE = 'https://news.google.com/rss';
const DEFAULT_TIMEOUT_MS = 10_000;

// Stable Google News section ids for topical feeds. Keyed by the loose topic words
// a model is likely to pass; unmapped topics fall through to a keyword search.
const TOPIC_SECTIONS: Record<string, string> = {
  top: 'TOP',
  headlines: 'TOP',
  world: 'WORLD',
  global: 'WORLD',
  international: 'WORLD',
  nation: 'NATION',
  national: 'NATION',
  business: 'BUSINESS',
  finance: 'BUSINESS',
  economy: 'BUSINESS',
  markets: 'BUSINESS',
  stocks: 'BUSINESS',
  technology: 'TECHNOLOGY',
  tech: 'TECHNOLOGY',
  entertainment: 'ENTERTAINMENT',
  sports: 'SPORTS',
  sport: 'SPORTS',
  science: 'SCIENCE',
  health: 'HEALTH',
  politics: 'NATION'
};

export interface NewsQuery {
  query?: string;
  topic?: string;
  /** ISO country code (e.g. "US", "GB", "IN"). */
  region?: string;
  /** Language code (e.g. "en", "fr"). */
  lang?: string;
}

/** Build the Google News locale params from a region/language pair. */
const localeParams = (region?: string, lang?: string): string => {
  const gl = (region || 'US').toUpperCase();
  const hl = `${(lang || 'en').toLowerCase()}-${gl}`;
  const ceid = `${gl}:${(lang || 'en').toLowerCase()}`;
  return `hl=${encodeURIComponent(hl)}&gl=${encodeURIComponent(gl)}&ceid=${encodeURIComponent(ceid)}`;
};

/** Resolve a NewsQuery to a concrete Google News RSS URL. */
export const buildNewsUrl = (q: NewsQuery): string => {
  const loc = localeParams(q.region, q.lang);
  const query = (q.query || '').trim();
  // A free-text query always wins (most specific). Otherwise use a topical section
  // when we recognize the topic, else fall back to the top-headlines feed.
  if (query) {
    return `${RSS_BASE}/search?q=${encodeURIComponent(query)}&${loc}`;
  }
  const section = q.topic ? TOPIC_SECTIONS[q.topic.trim().toLowerCase()] : 'TOP';
  if (section && section !== 'TOP') {
    return `${RSS_BASE}/headlines/section/topic/${section}?${loc}`;
  }
  return `${RSS_BASE}?${loc}`;
};

const decodeEntities = (text: string): string =>
  text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;|&apos;/g, "'")
    .replace(/&#x2F;|&#47;/g, '/')
    .replace(/&nbsp;/g, ' ');

// Google News double-escapes descriptions (&lt;ol&gt;&lt;li&gt;&lt;a href=…), so tags must be
// stripped AFTER entity decoding too — otherwise the UI shows literal markup (a real
// production bug: news cards rendered "<ol><li><a href=…" as text). Decode → strip →
// decode once more (for text like &amp;lt; that survives one pass) → collapse whitespace.
const stripTags = (html: string): string =>
  decodeEntities(decodeEntities(html.replace(/<[^>]+>/g, '')).replace(/<[^>]+>/g, ''))
    .replace(/<[^>]+>/g, '')
    .replace(/\s+/g, ' ')
    .trim();

// Pull the inner text of the first matching tag inside an <item> block.
const tagText = (block: string, tag: string): string | undefined => {
  const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i');
  const m = block.match(re);
  if (!m) return undefined;
  const inner = m[1].replace(/^<!\[CDATA\[/, '').replace(/\]\]>$/, '');
  return inner;
};

// Google News RSS tags the outlet as `<source url="https://www.wsj.com">The Wall
// Street Journal</source>`. The url attribute is the AUTHORITATIVE publisher
// homepage — far better than the news.google.com redirect link for picking the real
// favicon. Pull its hostname (sans www) as the canonical source domain. Pure.
export const sourceDomainOf = (block: string): string | undefined => {
  const m = block.match(/<source\b[^>]*\burl=["']([^"']+)["']/i);
  if (!m) return undefined;
  try {
    return new URL(decodeEntities(m[1])).hostname.replace(/^www\./i, '').toLowerCase() || undefined;
  } catch {
    return undefined;
  }
};

// Hard paywalls: outlets whose articles render as a wall (no readable body in-app),
// so a card full of them is a row of dead "open link" stories. We DEPRIORITIZE these
// and drop them entirely when there are enough open alternatives (see prioritizeNews).
const HARD_PAYWALL_DOMAINS = new Set([
  'wsj.com',
  'ft.com',
  'economist.com',
  'bloomberg.com',
  'nytimes.com',
  'washingtonpost.com',
  'theinformation.com',
  'barrons.com',
  'newyorker.com',
  'wired.com',
  'theatlantic.com',
  'businessinsider.com',
  'seekingalpha.com',
  'foreignpolicy.com',
  'hbr.org',
  'thetimes.co.uk',
  'telegraph.co.uk'
]);

/** True when the host (or a parent domain) is a known hard paywall. Pure. */
export const isPaywalled = (domain?: string): boolean => {
  if (!domain) return false;
  const d = domain.replace(/^www\./i, '').toLowerCase();
  if (HARD_PAYWALL_DOMAINS.has(d)) return true;
  // Match subdomains too (e.g. "europe.wsj.com").
  for (const base of HARD_PAYWALL_DOMAINS) if (d.endsWith(`.${base}`)) return true;
  return false;
};

/**
 * Parse a Google News RSS document into structured items. Pure + testable.
 *
 * Google News titles arrive as "Headline - Source Name"; when a <source> tag is
 * present we strip the trailing " - Source" so the headline reads cleanly and the
 * source is surfaced separately.
 */
export const parseNewsRss = (xml: string, limit = 10): NewsItem[] => {
  const items: NewsItem[] = [];
  const itemRe = /<item\b[^>]*>([\s\S]*?)<\/item>/gi;
  let m: RegExpExecArray | null;
  while ((m = itemRe.exec(xml)) !== null && items.length < limit) {
    const block = m[1];
    const rawTitle = tagText(block, 'title');
    const link = tagText(block, 'link');
    if (!rawTitle || !link) continue;

    const source = tagText(block, 'source');
    const sourceName = source ? stripTags(source) : undefined;
    let title = stripTags(rawTitle);
    if (sourceName && title.endsWith(` - ${sourceName}`)) {
      title = title.slice(0, -1 * ` - ${sourceName}`.length).trim();
    }

    const pubDate = tagText(block, 'pubDate');
    let publishedAt: string | undefined;
    if (pubDate) {
      const d = new Date(stripTags(pubDate));
      if (!Number.isNaN(d.getTime())) publishedAt = d.toISOString();
    }

    // Google News descriptions are usually just "<headline> <source>" with no real
    // summary, so drop anything that merely echoes the title rather than adding info.
    const descRaw = tagText(block, 'description');
    let snippet = descRaw ? stripTags(descRaw).slice(0, 240) : undefined;
    if (snippet && (snippet === title || snippet.startsWith(title))) snippet = undefined;
    // A snippet that still looks like markup/links after stripping adds nothing — drop it.
    if (snippet && /href=|<\w|news\.google\.com/i.test(snippet)) snippet = undefined;

    const sourceDomain = sourceDomainOf(block);
    const paywall = isPaywalled(sourceDomain);

    items.push({
      title,
      url: stripTags(link),
      source: sourceName,
      ...(sourceDomain ? { sourceDomain } : {}),
      publishedAt,
      snippet,
      ...(paywall ? { paywall: true } : {})
    });
  }
  return items;
};

/**
 * Smart paywall policy: keep readable (open) stories first; only fall back to
 * paywalled ones to fill the card when there aren't enough open alternatives. This
 * "automatically removes" dead WSJ/FT/NYT links from a healthy feed while never
 * leaving a thin business/finance feed empty. Stable (preserves feed order). Pure.
 */
export const prioritizeNews = (items: NewsItem[], limit: number): NewsItem[] => {
  const open = items.filter((i) => !i.paywall);
  const walled = items.filter((i) => i.paywall);
  // Enough open stories → drop paywalled entirely. Otherwise top up with the best
  // (highest-ranked) paywalled ones so the card stays full.
  const MIN_OPEN = 5;
  const ranked = open.length >= Math.min(MIN_OPEN, limit) ? open : [...open, ...walled];
  return ranked.slice(0, limit);
};

export const fetchNews = async (
  q: NewsQuery,
  signal?: AbortSignal,
  limit = 12
): Promise<NewsResultsArtifact> => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
  const onAbort = () => controller.abort();
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener('abort', onAbort, { once: true });
  }
  try {
    const res = await fetch(buildNewsUrl(q), {
      headers: { Accept: 'application/rss+xml, application/xml, text/xml' },
      signal: controller.signal
    });
    if (!res.ok) throw new Error(`Google News returned ${res.status}`);
    const xml = await res.text();
    // Over-fetch, then drop hard-paywalled stories when enough open ones remain, so
    // the final card is full of readable articles rather than dead "open link" rows.
    const items = prioritizeNews(parseNewsRss(xml, Math.max(limit * 2, 24)), limit);
    // Emit the EFFECTIVE topic so the client's topic chips highlight correctly:
    // a free-text query has no topic; a topical/headline feed normalizes to its
    // section key, defaulting to 'top' for the plain top-headlines feed.
    const query = (q.query || '').trim();
    const topic = query ? undefined : (q.topic || '').trim().toLowerCase() || 'top';
    return { query, topic, items };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
};
