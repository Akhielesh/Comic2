export interface ComicResearchResult {
  title: string;
  source: string;
  description?: string;
  thumbnail?: string;
  license?: string;
  credit?: string;
}

export interface ComicResearchResults {
  articles: ComicResearchResult[];
  images: ComicResearchResult[];
  incomplete: boolean;
}

const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);

export const comicResearchText = (value: unknown, limit: number): string => typeof value === 'string'
  ? value.replace(/<[^>]*>/g, '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, limit)
  : '';

const trustedUrl = (raw: unknown, hosts: readonly string[]): URL | undefined => {
  if (typeof raw !== 'string' || raw.length > 2048) return undefined;
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:' || url.port || url.username || url.password || !hosts.includes(url.hostname)) return undefined;
    url.search = '';
    url.hash = '';
    return url;
  } catch {
    return undefined;
  }
};

/** The only remote images research can preview or offer to the attachment pipeline. */
export const commonsThumbnail = (raw: unknown): string | undefined => {
  const url = trustedUrl(raw, ['thumb.wikimedia.org', 'upload.wikimedia.org']);
  return url && /^\/wikipedia\/commons\/thumb\/.+/.test(url.pathname) ? url.href : undefined;
};

const sourceUrl = (raw: unknown, image: boolean): string | undefined => {
  const url = trustedUrl(raw, [image ? 'commons.wikimedia.org' : 'en.wikipedia.org']);
  if (!url || !url.pathname.startsWith('/wiki/')) return undefined;
  try {
    const title = decodeURIComponent(url.pathname.slice(6));
    if (!title.trim() || title === '.' || title === '..' || /[\u0000-\u001f\u007f]/.test(title)) return undefined;
    if (image && !/^File:.+/.test(title)) return undefined;
    return url.href;
  } catch {
    return undefined;
  }
};

/** Accept both fresh responses and stored cards through the same bounded source allowlist. */
export const normalizeComicResearch = (value: unknown): ComicResearchResults | undefined => {
  if (!record(value) || !Array.isArray(value.articles) || !Array.isArray(value.images) || typeof value.incomplete !== 'boolean') return undefined;
  const articles = value.articles.slice(0, 4).flatMap((entry): ComicResearchResult[] => {
    if (!record(entry)) return [];
    const title = comicResearchText(entry.title, 160);
    const source = sourceUrl(entry.source, false);
    if (!title || !source) return [];
    const description = comicResearchText(entry.description, 260);
    return [{ title, source, ...(description ? { description } : {}) }];
  });
  const images = value.images.slice(0, 6).flatMap((entry): ComicResearchResult[] => {
    if (!record(entry)) return [];
    const title = comicResearchText(entry.title, 235);
    const source = sourceUrl(entry.source, true);
    const thumbnail = commonsThumbnail(entry.thumbnail);
    const license = comicResearchText(entry.license, 65);
    const credit = comicResearchText(entry.credit, 160);
    if (!title || !source || !thumbnail || !/^(?:CC(?:[ -]?0|[ -]BY(?:-SA)?)(?:\s+\d+(?:\.\d+)?)?|public domain)$/i.test(license)) return [];
    if (/^CC[ -]BY\b/i.test(license) && !credit) return [];
    return [{ title, source, thumbnail, license, ...(credit ? { credit } : {}) }];
  });
  return { articles, images, incomplete: value.incomplete };
};
