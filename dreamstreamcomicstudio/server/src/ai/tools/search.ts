// Web search orchestrator.
//
// WHY THIS EXISTS: the chat agent's web_search was scraping-only (DuckDuckGo HTML/
// Lite + the Instant-Answer API). From a datacenter IP (Railway) DuckDuckGo soft-
// blocks the scrapers and the Instant-Answer API only resolves entity/disambiguation
// queries — so most real research queries came back EMPTY, and the model fabricated
// "TBD" answers. That made the whole "AI with web access" experience feel broken.
//
// This module turns search into a provider chain that degrades gracefully and,
// crucially, becomes genuinely reliable the moment a (free-tier) API key is set:
//
//   1. Keyed providers (used only if their env key is present) — real search APIs:
//        TAVILY_API_KEY        → Tavily (purpose-built for AI agents)
//        BRAVE_API_KEY         → Brave Search API
//        GOOGLE_CSE_KEY + _CX  → Google Programmable Search
//   2. Keyless fallbacks: DuckDuckGo (html→lite→IA) → Bing HTML → Wikipedia.
//
// First provider to return results wins. Every provider is wrapped so a failure just
// advances to the next one. Set ANY one key to get reliable results in production.

import { ddgWebSearch, type WebResult } from './duckduckgo.js';
import { TtlCache } from '../../lib/cache.js';
import { ProviderBudgetError, assertProviderBudget, noteProviderCall } from '../../lib/providerUsage.js';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const PER_PROVIDER_TIMEOUT_MS = 7_000;
const GLOBAL_BUDGET_MS = 20_000;

const decodeEntities = (text: string): string =>
  text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&#x2F;|&#47;/g, '/');
const stripTags = (html: string): string => decodeEntities(html.replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim();

const timeoutSignal = (parent: AbortSignal | undefined, ms: number) => {
  const c = new AbortController();
  const timer = setTimeout(() => c.abort(), ms);
  const onAbort = () => c.abort();
  if (parent) {
    if (parent.aborted) c.abort();
    else parent.addEventListener('abort', onAbort, { once: true });
  }
  return { signal: c.signal, done: () => { clearTimeout(timer); parent?.removeEventListener('abort', onAbort); } };
};

const fetchJson = async <T>(url: string, headers: Record<string, string>, signal: AbortSignal): Promise<T> => {
  const res = await fetch(url, { headers: { 'User-Agent': UA, ...headers }, signal });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as T;
};

// ---------------------------------------------------------------- keyed providers ---

const tavilySearch = async (query: string, signal: AbortSignal, limit: number): Promise<WebResult[] | null> => {
  const key = process.env.TAVILY_API_KEY;
  if (!key) return null; // skipped: no key — not a failed attempt
  const res = await fetch('https://api.tavily.com/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'User-Agent': UA },
    body: JSON.stringify({ api_key: key, query, max_results: limit, search_depth: 'basic', include_answer: false }),
    signal
  });
  if (!res.ok) throw new Error(`Tavily ${res.status}`);
  const data = (await res.json()) as { results?: { title?: string; url?: string; content?: string }[] };
  return (data.results || [])
    .filter((r) => r.url)
    .slice(0, limit)
    .map((r) => ({ title: r.title || r.url || '', url: r.url as string, snippet: (r.content || '').slice(0, 400) }));
};

const braveSearch = async (query: string, signal: AbortSignal, limit: number): Promise<WebResult[] | null> => {
  const key = process.env.BRAVE_API_KEY;
  if (!key) return null; // skipped: no key — not a failed attempt
  const data = await fetchJson<{ web?: { results?: { title?: string; url?: string; description?: string }[] } }>(
    `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${limit}`,
    { Accept: 'application/json', 'X-Subscription-Token': key },
    signal
  );
  return (data.web?.results || [])
    .filter((r) => r.url)
    .slice(0, limit)
    .map((r) => ({ title: r.title ? stripTags(r.title) : (r.url as string), url: r.url as string, snippet: r.description ? stripTags(r.description) : '' }));
};

// Serper.dev — cheapest paid Google-results API (~$0.30–1.00 per 1k queries, 2,500
// free one-time credits). Scraping-based upstream, so it sits after Tavily/Brave.
const serperSearch = async (query: string, signal: AbortSignal, limit: number): Promise<WebResult[] | null> => {
  const key = process.env.SERPER_API_KEY;
  if (!key) return null; // skipped: no key — not a failed attempt
  const res = await fetch('https://google.serper.dev/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-API-KEY': key, 'User-Agent': UA },
    body: JSON.stringify({ q: query, num: Math.min(limit, 10) }),
    signal
  });
  if (!res.ok) throw new Error(`Serper ${res.status}`);
  const data = (await res.json()) as { organic?: { title?: string; link?: string; snippet?: string }[] };
  return (data.organic || [])
    .filter((r) => r.link)
    .slice(0, limit)
    .map((r) => ({ title: r.title || (r.link as string), url: r.link as string, snippet: r.snippet || '' }));
};

const googleCseSearch = async (query: string, signal: AbortSignal, limit: number): Promise<WebResult[] | null> => {
  const key = process.env.GOOGLE_CSE_KEY;
  const cx = process.env.GOOGLE_CSE_CX;
  if (!key || !cx) return null; // skipped: no key — not a failed attempt
  const data = await fetchJson<{ items?: { title?: string; link?: string; snippet?: string }[] }>(
    `https://www.googleapis.com/customsearch/v1?key=${key}&cx=${cx}&q=${encodeURIComponent(query)}&num=${Math.min(limit, 10)}`,
    { Accept: 'application/json' },
    signal
  );
  return (data.items || [])
    .filter((r) => r.link)
    .slice(0, limit)
    .map((r) => ({ title: r.title || (r.link as string), url: r.link as string, snippet: r.snippet || '' }));
};

// -------------------------------------------------------------- keyless fallbacks ---

/** Parse Bing's organic results (`li.b_algo`). Pure + testable. */
export const parseBingHtml = (html: string, limit = 6): WebResult[] => {
  const results: WebResult[] = [];
  const blockRe = /<li class="b_algo"[\s\S]*?(?=<li class="b_algo"|<\/ol>|$)/g;
  let bm: RegExpExecArray | null;
  while ((bm = blockRe.exec(html)) !== null && results.length < limit) {
    const block = bm[0];
    const a = block.match(/<h2>\s*<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
    if (!a) continue;
    const url = decodeEntities(a[1]);
    const title = stripTags(a[2]);
    const p = block.match(/<p[^>]*class="[^"]*b_lineclamp[^"]*"[^>]*>([\s\S]*?)<\/p>/i) || block.match(/<p[^>]*>([\s\S]*?)<\/p>/i);
    const snippet = p ? stripTags(p[1]) : '';
    if (title && /^https?:\/\//.test(url)) results.push({ title, url, snippet });
  }
  return results;
};

const bingScrape = async (query: string, signal: AbortSignal, limit: number): Promise<WebResult[]> => {
  const res = await fetch(`https://www.bing.com/search?q=${encodeURIComponent(query)}&setlang=en&cc=us`, {
    headers: { 'User-Agent': UA, Accept: 'text/html', 'Accept-Language': 'en-US,en;q=0.9' },
    signal
  });
  if (!res.ok) throw new Error(`Bing ${res.status}`);
  return parseBingHtml(await res.text(), limit);
};

/** Wikipedia full-text search — reliable from datacenter, good grounding for entities. */
export const wikipediaSearch = async (query: string, signal: AbortSignal, limit: number): Promise<WebResult[]> => {
  const data = await fetchJson<{ query?: { search?: { title?: string; snippet?: string }[] } }>(
    `https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(query)}&srlimit=${limit}&format=json&origin=*`,
    { Accept: 'application/json' },
    signal
  );
  return (data.query?.search || [])
    .filter((r) => r.title)
    .slice(0, limit)
    .map((r) => ({
      title: r.title as string,
      url: `https://en.wikipedia.org/wiki/${encodeURIComponent((r.title as string).replace(/ /g, '_'))}`,
      snippet: r.snippet ? stripTags(r.snippet) : ''
    }));
};

// ----------------------------------------------------------------- orchestration ---

// SearXNG — open-source metasearch (aggregates Google/Bing/DDG/etc.) with a keyless
// JSON API. This is the strongest FREE web-search option. Set SEARXNG_URL to your own
// self-hosted instance for unlimited, private, no-key search; otherwise we try a few
// public instances (best-effort — public instances rotate/rate-limit).
const PUBLIC_SEARXNG = ['https://searx.be', 'https://searx.tiekoetter.com', 'https://search.bus-hit.me', 'https://priv.au'];

export interface SearxResult {
  title?: string;
  url?: string;
  content?: string;
}
export const parseSearxngJson = (data: { results?: SearxResult[] }, limit: number): WebResult[] =>
  (data.results || [])
    .filter((r) => r.url && r.title)
    .slice(0, limit)
    .map((r) => ({ title: r.title as string, url: r.url as string, snippet: (r.content || '').slice(0, 400) }));

const searxngSearch = async (query: string, signal: AbortSignal, limit: number): Promise<WebResult[]> => {
  const bases = [process.env.SEARXNG_URL, ...PUBLIC_SEARXNG].filter(Boolean) as string[];
  for (const base of bases.slice(0, 5)) {
    const t = timeoutSignal(signal, 3500); // bound each instance so one slow host can't eat the budget
    try {
      const url = `${base.replace(/\/$/, '')}/search?q=${encodeURIComponent(query)}&format=json&language=en&safesearch=0`;
      const data = await fetchJson<{ results?: SearxResult[] }>(url, { Accept: 'application/json' }, t.signal);
      const out = parseSearxngJson(data, limit);
      if (out.length) return out;
    } catch {
      /* try the next instance */
    } finally {
      t.done();
    }
  }
  return [];
};

type Provider = { name: string; run: (q: string, s: AbortSignal, n: number) => Promise<WebResult[] | null> };

// Representative URL per provider so the usage meter/budget guard can attribute
// calls (SearXNG resolves to the configured instance).
const METER_URLS: Record<string, string> = {
  tavily: 'https://api.tavily.com/search',
  brave: 'https://api.search.brave.com/res/v1/web/search',
  serper: 'https://google.serper.dev/search',
  google: 'https://www.googleapis.com/customsearch/v1',
  searxng: (process.env.SEARXNG_URL || 'https://searx.be') + '/search',
  duckduckgo: 'https://duckduckgo.com/html',
  bing: 'https://www.bing.com/search',
  wikipedia: 'https://en.wikipedia.org/w/api.php'
};

// Ordered best→fallback. Keyed providers short-circuit to [] without a network call
// when their key is absent, so the keyless chain (SearXNG → DuckDuckGo → Bing →
// Wikipedia) is what runs by default — entirely free, no API keys required.
const PROVIDERS: Provider[] = [
  { name: 'tavily', run: tavilySearch },
  { name: 'brave', run: braveSearch },
  { name: 'serper', run: serperSearch },
  { name: 'google', run: googleCseSearch },
  { name: 'searxng', run: searxngSearch },
  { name: 'duckduckgo', run: ddgWebSearch },
  { name: 'bing', run: bingScrape },
  { name: 'wikipedia', run: wikipediaSearch }
];

export interface WebSearchOutcome {
  results: WebResult[];
  /** Which provider produced the results (or 'none'). */
  provider: string;
  /** Providers that were attempted, for diagnostics. */
  tried: string[];
  /**
   * Outcome quality, so callers can be HONEST with the user instead of treating a
   * blocked/failed search the same as a genuinely empty one:
   *   'ok'    — a provider returned results.
   *   'empty' — providers ran cleanly but found nothing for this query.
   *   'error' — every attempt failed/threw (e.g. datacenter soft-block, timeouts);
   *             the absence of results is unreliable, NOT evidence that nothing exists.
   */
  status: 'ok' | 'empty' | 'error';
}

// Short result cache: identical queries within 5 minutes (per process) share one
// upstream call — agents love re-searching the same thing, and this is the single
// cheapest way to protect search quotas.
const searchCache = new TtlCache<WebSearchOutcome>(5 * 60_000, 300);

/** Run the provider chain; first non-empty wins. Never throws. */
export const webSearch = async (query: string, signal?: AbortSignal, limit = 6): Promise<WebSearchOutcome> => {
  const cacheKey = `${limit}:${query.trim().toLowerCase()}`;
  const cached = searchCache.get(cacheKey);
  if (cached) return cached;
  const deadline = Date.now() + GLOBAL_BUDGET_MS;
  const tried: string[] = [];
  let errorCount = 0;
  let budgetBlocked = 0;
  let cleanCompletions = 0; // providers that actually RAN and returned (no throw, no skip)
  for (const p of PROVIDERS) {
    if (Date.now() >= deadline) break;
    const t = timeoutSignal(signal, Math.min(PER_PROVIDER_TIMEOUT_MS, deadline - Date.now()));
    // Resolved per call (not at module load) so a late-set SEARXNG_URL attributes right.
    const meterUrl =
      p.name === 'searxng' ? `${process.env.SEARXNG_URL || 'https://searx.be'}/search` : METER_URLS[p.name] || p.name;
    try {
      assertProviderBudget(meterUrl);
      const results = await p.run(query, t.signal, limit);
      // null = the provider skipped (e.g. a keyed provider with no key). A skip is NOT an
      // attempt — don't list it as tried or meter it, and don't let it mask an outage.
      if (results === null) continue;
      noteProviderCall(meterUrl, true);
      tried.push(p.name);
      if (results.length) {
        const out: WebSearchOutcome = { results, provider: p.name, tried, status: 'ok' };
        searchCache.set(cacheKey, out);
        return out;
      }
      cleanCompletions += 1; // ran fine, just found nothing
    } catch (err) {
      // A budget block is an intentional skip to protect the quota — advance to the
      // next provider without counting it as an upstream failure.
      if (err instanceof ProviderBudgetError) {
        budgetBlocked += 1;
        tried.push(`${p.name}(budget)`);
      } else {
        noteProviderCall(meterUrl, false);
        tried.push(p.name);
        errorCount += 1;
      }
    } finally {
      t.done();
    }
  }
  // Only call it an outage ('error') when providers actually FAILED and NONE completed
  // cleanly. A partial success — some provider ran and simply found nothing — is 'empty',
  // not a live-search outage, so the model gets the right guidance.
  // Budget exhaustion is an OUTAGE on our side, never evidence of absence — without
  // this, an all-capped chain would read as "no results" and invite fabrication.
  const status: WebSearchOutcome['status'] =
    (errorCount > 0 || budgetBlocked > 0) && cleanCompletions === 0 ? 'error' : 'empty';
  return { results: [], provider: 'none', tried, status };
};
