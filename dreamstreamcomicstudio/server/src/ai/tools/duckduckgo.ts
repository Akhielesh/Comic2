// DuckDuckGo search — free, keyless, open. DuckDuckGo aggregates results from many
// upstream sources, so this is a single dependency-free web/image tool the agent can call.
//
// NOTE: like the OpenRouter provider, this targets DuckDuckGo's public HTML/JSON
// endpoints and cannot be runtime-verified inside the build sandbox (no outbound
// network). Validate end-to-end in a networked environment. All failures degrade to a
// clear message rather than throwing, so a flaky search never breaks the chat.

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const DEFAULT_TIMEOUT_MS = 12_000;

export interface WebResult {
  title: string;
  url: string;
  snippet: string;
}

export interface ImageResult {
  url: string;
  thumbnail?: string;
  title?: string;
  source?: string;
}

const withTimeout = (signal: AbortSignal | undefined, ms: number): { signal: AbortSignal; done: () => void } => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  const onAbort = () => controller.abort();
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener('abort', onAbort, { once: true });
  }
  return {
    signal: controller.signal,
    done: () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
  };
};

const decodeEntities = (text: string): string =>
  text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&#x2F;|&#47;/g, '/');

const stripTags = (html: string): string => decodeEntities(html.replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim();

// DDG HTML result links are redirects: //duckduckgo.com/l/?uddg=<encoded real url>&...
const resolveDdgUrl = (href: string): string => {
  try {
    const normalized = href.startsWith('//') ? `https:${href}` : href;
    const u = new URL(normalized, 'https://duckduckgo.com');
    const uddg = u.searchParams.get('uddg');
    if (uddg) return decodeURIComponent(uddg);
    return normalized;
  } catch {
    return href;
  }
};

/** Parse DuckDuckGo's HTML results page into structured results. Pure + testable. */
export const parseDdgHtml = (html: string, limit = 6): WebResult[] => {
  const results: WebResult[] = [];
  const anchorRe = /<a[^>]+class="[^"]*result__a[^"]*"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
  const snippetRe = /<a[^>]+class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/g;

  const snippets: string[] = [];
  let sm: RegExpExecArray | null;
  while ((sm = snippetRe.exec(html)) !== null) snippets.push(stripTags(sm[1]));

  let am: RegExpExecArray | null;
  let idx = 0;
  while ((am = anchorRe.exec(html)) !== null && results.length < limit) {
    const url = resolveDdgUrl(am[1]);
    const title = stripTags(am[2]);
    if (!title || !url) {
      idx += 1;
      continue;
    }
    results.push({ title, url, snippet: snippets[idx] || '' });
    idx += 1;
  }
  return results;
};

export const ddgWebSearch = async (
  query: string,
  signal?: AbortSignal,
  limit = 6
): Promise<WebResult[]> => {
  const t = withTimeout(signal, DEFAULT_TIMEOUT_MS);
  try {
    const res = await fetch(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, {
      method: 'POST',
      headers: {
        'User-Agent': UA,
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'text/html'
      },
      body: `q=${encodeURIComponent(query)}`,
      signal: t.signal
    });
    if (!res.ok) throw new Error(`DuckDuckGo returned ${res.status}`);
    const html = await res.text();
    return parseDdgHtml(html, limit);
  } finally {
    t.done();
  }
};

const getVqd = async (query: string, signal: AbortSignal): Promise<string | null> => {
  const res = await fetch(`https://duckduckgo.com/?q=${encodeURIComponent(query)}&iax=images&ia=images`, {
    headers: { 'User-Agent': UA },
    signal
  });
  const html = await res.text();
  const match =
    html.match(/vqd=["']([\d-]+)["']/) ||
    html.match(/vqd=([\d-]+)&/) ||
    html.match(/"vqd":"([\d-]+)"/);
  return match ? match[1] : null;
};

export const ddgImageSearch = async (
  query: string,
  signal?: AbortSignal,
  limit = 6
): Promise<ImageResult[]> => {
  const t = withTimeout(signal, DEFAULT_TIMEOUT_MS);
  try {
    const vqd = await getVqd(query, t.signal);
    if (!vqd) throw new Error('Could not initialize DuckDuckGo image search (no token).');

    const res = await fetch(
      `https://duckduckgo.com/i.js?l=us-en&o=json&q=${encodeURIComponent(query)}&vqd=${vqd}&f=,,,&p=1`,
      {
        headers: {
          'User-Agent': UA,
          Accept: 'application/json',
          Referer: 'https://duckduckgo.com/'
        },
        signal: t.signal
      }
    );
    if (!res.ok) throw new Error(`DuckDuckGo images returned ${res.status}`);
    const json = (await res.json()) as { results?: any[] };
    const rows = Array.isArray(json.results) ? json.results : [];
    return rows.slice(0, limit).map((r) => ({
      url: String(r?.image || ''),
      thumbnail: typeof r?.thumbnail === 'string' ? r.thumbnail : undefined,
      title: typeof r?.title === 'string' ? r.title : undefined,
      source: typeof r?.url === 'string' ? r.url : undefined
    })).filter((r) => r.url);
  } finally {
    t.done();
  }
};
