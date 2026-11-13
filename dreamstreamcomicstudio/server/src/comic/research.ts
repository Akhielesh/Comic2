import type { ComicResearchResult, ComicResearchResults } from '../../../shared/comic/research.js';
import { fetchJson } from '../ai/tools/http.js';
import { TtlCache } from '../lib/cache.js';

const cache = new TtlCache<ComicResearchResults>(5 * 60_000, 120);
const REQUEST = { timeoutMs: 7_000, headers: { 'User-Agent': 'DreamStreamComicStudio/1.0 (https://dreamstreamstudio.ai)' } };

interface ArticleResponse {
  pages?: Array<{ key?: string; title?: string; description?: string }>;
}

interface CommonsResponse {
  query?: { pages?: Array<{
    title?: string;
    index?: number;
    imageinfo?: Array<{ mime?: string; thumburl?: string; extmetadata?: { LicenseShortName?: { value?: string }; Artist?: { value?: string } } }>;
  }> };
}

const text = (value: unknown, limit: number): string => typeof value === 'string'
  ? value.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim().slice(0, limit)
  : '';

const commonsThumb = (raw: unknown): string | undefined => {
  if (typeof raw !== 'string') return undefined;
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:' || url.port || url.username || url.password || !['thumb.wikimedia.org', 'upload.wikimedia.org'].includes(url.hostname)) return undefined;
    if (!url.pathname.startsWith('/wikipedia/commons/thumb/')) return undefined;
    url.search = '';
    url.hash = '';
    return url.href;
  } catch {
    return undefined;
  }
};

export const parseComicResearch = (wiki?: ArticleResponse, commons?: CommonsResponse): ComicResearchResults => {
  const articles: ComicResearchResult[] = (Array.isArray(wiki?.pages) ? wiki.pages : []).slice(0, 4).flatMap((page) => {
    const title = text(page?.title, 160);
    const key = text(page?.key, 240);
    if (!title || !key || key === '.' || key === '..') return [];
    return [{ title, source: `https://en.wikipedia.org/wiki/${encodeURIComponent(key)}`, description: text(page.description, 260) }];
  });
  const images: ComicResearchResult[] = (Array.isArray(commons?.query?.pages) ? commons.query.pages : []).filter(Boolean).slice(0, 6)
    .sort((a, b) => (a.index ?? 999) - (b.index ?? 999)).flatMap((page) => {
    const file = text(page?.title, 240);
    const info = page?.imageinfo?.[0];
    const thumbnail = commonsThumb(info?.thumburl);
    const license = text(info?.extmetadata?.LicenseShortName?.value, 65);
    const credit = text(info?.extmetadata?.Artist?.value, 160);
    if (!file.startsWith('File:') || !thumbnail || !/^(?:CC[ -](?:BY\b|0\b)|public domain\b)/i.test(license) || !/^image\/(jpeg|png|webp)$/.test(info?.mime ?? '')) return [];
    if (/^CC[ -]BY\b/i.test(license) && !credit) return [];
    return [{ title: file.slice(5).replace(/\.(jpe?g|png|webp)$/i, ''), source: `https://commons.wikimedia.org/wiki/${encodeURIComponent(file.replace(/ /g, '_'))}`, thumbnail, license, ...(credit ? { credit } : {}) }];
  });
  return { articles, images, incomplete: !wiki || !commons };
};

export function searchComicResearch(query: string): Promise<ComicResearchResults> {
  return cache.getOrSet(query.toLowerCase(), async () => {
    const commons = new URLSearchParams({
      action: 'query', format: 'json', formatversion: '2', generator: 'search', gsrnamespace: '6',
      gsrsearch: `${query} filetype:bitmap`, gsrlimit: '6', prop: 'imageinfo', iiprop: 'url|mime|extmetadata',
      iiurlwidth: '320', iiextmetadatafilter: 'LicenseShortName|Artist'
    });
    const [articles, images] = await Promise.allSettled([
      fetchJson<ArticleResponse>(`https://en.wikipedia.org/w/rest.php/v1/search/page?q=${encodeURIComponent(query)}&limit=4`, REQUEST),
      fetchJson<CommonsResponse>(`https://commons.wikimedia.org/w/api.php?${commons}`, REQUEST)
    ]);
    if (articles.status === 'rejected' && images.status === 'rejected') throw new Error('Research providers are unavailable.');
    return parseComicResearch(articles.status === 'fulfilled' ? articles.value : undefined, images.status === 'fulfilled' ? images.value : undefined);
  });
}
