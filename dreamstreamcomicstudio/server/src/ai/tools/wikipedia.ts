// Shared Wikipedia and Wikidata reads: Chat's wiki_lookup and country_info use them today, and comic
// research builds on the same functions. Keyless, HTTPS only, and every call goes through fetchJson, so
// each one is metered (`wikipedia` and `wikidata` budgets in lib/providerUsage.ts) and shares one
// deadline over headers and body.
//
// Two answers are kept apart on purpose: "the source answered and found nothing" (null, [] or
// undefined) and "the source is unavailable" (a throw). A caller must never turn the second into
// "not found".

import { fetchJson } from './http.js';

export interface WikiFetchOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

const WIKI_HOST = /^[a-z]{2,3}(?:-[a-z0-9]{2,8})*\.wikipedia\.org$/;
const WIKI_LANG = /^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/;
const THUMB_HOST = 'upload.wikimedia.org';
const WIKIDATA_API = 'https://www.wikidata.org/w/api.php';

/** A language wiki's host, `{lang}.wikipedia.org` (lowercase; no port, path or other domain). */
export const isWikipediaHost = (host: string): boolean => typeof host === 'string' && WIKI_HOST.test(host);

const wikiHost = (host: string): string => {
  if (!isWikipediaHost(host)) throw new Error('Not a Wikipedia host.');
  return host;
};

const fetchOpts = (opts: WikiFetchOptions): WikiFetchOptions => ({ signal: opts.signal, timeoutMs: opts.timeoutMs });

const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const text = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);

const pageUrl = (host: string, key: string): string => `https://${host}/wiki/${encodeURIComponent(key)}`;

/** An https URL on exactly `host`, or undefined. */
const httpsOn = (raw: unknown, host: string): string | undefined => {
  if (typeof raw !== 'string' || raw.length > 2048) return undefined;
  try {
    const url = new URL(raw);
    return url.protocol === 'https:' && url.hostname === host && !url.port && !url.username && !url.password ? url.href : undefined;
  } catch {
    return undefined;
  }
};

// --- Wikipedia ------------------------------------------------------------------------------

export interface WikiSearchHit {
  /** Page key (title with underscores), the REST summary's path segment. */
  key: string;
  title: string;
  description?: string;
  /** The search snippet, as Wikipedia sends it (it carries <span class="searchmatch"> marks). */
  excerpt?: string;
}

/** Full-text page search on one language wiki (REST `search/page`). At most `limit` hits (1-10). */
export const wikiSearch = async (host: string, query: string, limit: number, opts: WikiFetchOptions = {}): Promise<WikiSearchHit[]> => {
  const h = wikiHost(host);
  const n = Math.max(1, Math.min(10, Math.floor(limit) || 1));
  const data = await fetchJson<unknown>(`https://${h}/w/rest.php/v1/search/page?q=${encodeURIComponent(query)}&limit=${n}`, fetchOpts(opts));
  if (!record(data) || !Array.isArray(data.pages)) throw new Error(`${h} search answered without a result list.`);
  return data.pages
    .flatMap((page): WikiSearchHit[] => {
      if (!record(page)) return [];
      const key = text(page.key);
      const title = text(page.title);
      if (!key || !title) return [];
      const description = text(page.description);
      const excerpt = text(page.excerpt);
      return [{ key, title, ...(description ? { description } : {}), ...(excerpt ? { excerpt } : {}) }];
    })
    .slice(0, n);
};

export interface WikiSummary {
  title?: string;
  description?: string;
  /** Plain-text lead of the article. */
  extract?: string;
  /** The article's https link on the same wiki. */
  url: string;
  /** A Wikimedia-hosted https thumbnail, when the article has one. */
  thumbnail?: string;
}

/** The REST summary of one page (title, description, plain-text extract, link, thumbnail). */
export const wikiSummary = async (host: string, key: string, opts: WikiFetchOptions = {}): Promise<WikiSummary> => {
  const h = wikiHost(host);
  const data = await fetchJson<unknown>(`https://${h}/api/rest_v1/page/summary/${encodeURIComponent(key)}`, fetchOpts(opts));
  if (!record(data)) throw new Error(`${h} summary answered without a page.`);
  const urls = record(data.content_urls) && record(data.content_urls.desktop) ? data.content_urls.desktop : {};
  const thumb = record(data.thumbnail) ? httpsOn(data.thumbnail.source, THUMB_HOST) : undefined;
  return {
    title: text(data.title),
    description: text(data.description),
    extract: text(data.extract),
    url: httpsOn(urls.page, h) ?? pageUrl(h, key),
    ...(thumb ? { thumbnail: thumb } : {})
  };
};

export interface WikiLanglink {
  lang: string;
  /** `{lang}.wikipedia.org`. */
  host: string;
  title: string;
  key: string;
  url: string;
}

/**
 * The same article on the `lang` wiki, through the source page's language links (redirects followed).
 * Undefined when that wiki has no such article; the same language answers without a request.
 */
export const wikiLanglink = async (
  host: string,
  title: string,
  lang: string,
  opts: WikiFetchOptions = {}
): Promise<WikiLanglink | undefined> => {
  const h = wikiHost(host);
  if (typeof lang !== 'string' || !WIKI_LANG.test(lang)) throw new Error('Not a Wikipedia language code.');
  const target = `${lang}.wikipedia.org`;
  if (target === h) {
    const key = title.replace(/ /g, '_');
    return { lang, host: h, title, key, url: pageUrl(h, key) };
  }
  const params = new URLSearchParams({
    action: 'query',
    format: 'json',
    formatversion: '2',
    prop: 'langlinks',
    titles: title,
    lllang: lang,
    redirects: '1'
  });
  const data = await fetchJson<unknown>(`https://${h}/w/api.php?${params}`, fetchOpts(opts));
  if (!record(data) || !record(data.query) || !Array.isArray(data.query.pages)) throw new Error(`${h} answered without pages.`);
  const page = data.query.pages.find(record);
  const links = page && Array.isArray(page.langlinks) ? page.langlinks : [];
  const link = links.find((l): l is Record<string, unknown> => record(l) && l.lang === lang);
  const linked = text(link?.title);
  if (!linked) return undefined;
  const key = linked.replace(/ /g, '_');
  return { lang, host: target, title: linked, key, url: pageUrl(target, key) };
};

// --- Wikidata: country facts ----------------------------------------------------------------

/** Wikidata answered, but not usably: an API error or a reply in another shape. */
export class WikidataUnavailableError extends Error {
  constructor(message = 'Wikidata did not answer.') {
    super(message);
    this.name = 'WikidataUnavailableError';
  }
}

interface Snak {
  snaktype?: string;
  datavalue?: { type?: string; value?: unknown };
}
interface Statement {
  mainsnak?: Snak;
  rank?: string;
  qualifiers?: Record<string, Snak[] | undefined>;
}
export interface WikidataEntity {
  id?: string;
  missing?: string;
  labels?: Record<string, { value?: string } | undefined>;
  claims?: Record<string, Statement[] | undefined>;
}

export interface CountryFacts {
  /** Wikidata item id, e.g. Q142. */
  id: string;
  name: string;
  /** ISO 3166-1 alpha-2 (P297). */
  alpha2?: string;
  capitals: string[];
  population?: number;
  /** Year of the population figure (its point-in-time qualifier). */
  populationYear?: number;
  areaKm2?: number;
  currencies: string[];
  /** Official languages (P37). */
  languages: string[];
  continents: string[];
  /** The item's page on Wikidata (CC0 data). */
  url: string;
}

/** "country" and "sovereign state": the classes an item must currently carry to count as a country. */
const COUNTRY_CLASSES = new Set(['Q6256', 'Q3624078']);
const SQUARE_KILOMETRE = /\/Q712226$/;
const QID = /^Q\d{1,12}$/;
const LABEL_MAX = 80;

const cleanLabel = (v: unknown): string | undefined => {
  if (typeof v !== 'string') return undefined;
  const s = v.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, LABEL_MAX);
  return s || undefined;
};

/** Statements that hold now: not deprecated, a real value, and no end time (P582). */
const currentStatements = (entity: WikidataEntity | undefined, prop: string): Statement[] =>
  (entity?.claims?.[prop] ?? []).filter(
    (s) => !!s && s.rank !== 'deprecated' && s.mainsnak?.snaktype === 'value' && !!s.mainsnak.datavalue && !s.qualifiers?.P582?.length
  );

/** The current statements, narrowed to the preferred ones when Wikidata marks any. */
const bestStatements = (entity: WikidataEntity | undefined, prop: string): Statement[] => {
  const current = currentStatements(entity, prop);
  const preferred = current.filter((s) => s.rank === 'preferred');
  return preferred.length ? preferred : current;
};

const itemId = (s: Statement): string | undefined => {
  const v = s.mainsnak?.datavalue?.value;
  const id = record(v) ? v.id : undefined;
  return typeof id === 'string' && QID.test(id) ? id : undefined;
};

const quantity = (s: Statement): { amount: number; unit: string } | undefined => {
  const v = s.mainsnak?.datavalue?.value;
  if (!record(v) || typeof v.amount !== 'string') return undefined;
  const amount = Number(v.amount);
  return Number.isFinite(amount) ? { amount, unit: typeof v.unit === 'string' ? v.unit : '1' } : undefined;
};

const yearOf = (s: Statement): number | undefined => {
  const v = s.qualifiers?.P585?.[0]?.datavalue?.value;
  const m = record(v) && typeof v.time === 'string' ? /^[+-]?(\d{1,6})-/.exec(v.time) : null;
  return m ? Number(m[1]) : undefined;
};

const ids = (entity: WikidataEntity, prop: string, max: number): string[] =>
  [...new Set(bestStatements(entity, prop).map(itemId).filter((x): x is string => !!x))].slice(0, max);

/** True when the item currently counts as a country or sovereign state. Pure. */
export const isCountryEntity = (entity: WikidataEntity | undefined): boolean =>
  currentStatements(entity, 'P31').some((s) => {
    const id = itemId(s);
    return !!id && COUNTRY_CLASSES.has(id);
  });

const LIMITS = { capitals: 3, currencies: 3, languages: 6, continents: 3 } as const;

/** The item ids whose labels a country needs (capital, currency, languages, continent). Pure. */
const labelIdsFor = (entity: WikidataEntity): string[] =>
  [
    ...new Set([
      ...ids(entity, 'P36', LIMITS.capitals),
      ...ids(entity, 'P38', LIMITS.currencies),
      ...ids(entity, 'P37', LIMITS.languages),
      ...ids(entity, 'P30', LIMITS.continents)
    ])
  ].slice(0, 50);

/**
 * Country facts from a Wikidata item and the English labels of the items it points to. Values whose
 * label is unknown are left out rather than shown as raw ids. Null when the item is not a country. Pure.
 */
export const parseWikidataCountry = (entity: WikidataEntity, labels: Record<string, string>): CountryFacts | null => {
  if (!entity || typeof entity.id !== 'string' || !QID.test(entity.id) || !isCountryEntity(entity)) return null;
  const named = (prop: string, max: number): string[] =>
    ids(entity, prop, max)
      .map((id) => cleanLabel(labels[id]))
      .filter((x): x is string => !!x);

  // Population: the preferred figure; without one, the latest by its point in time.
  const pops = bestStatements(entity, 'P1082')
    .map((s) => ({ q: quantity(s), year: yearOf(s) }))
    .filter((p): p is { q: { amount: number; unit: string }; year: number | undefined } => !!p.q && p.q.amount > 0);
  const pop = pops.reduce<(typeof pops)[number] | undefined>((best, p) => (!best || (p.year ?? -1) > (best.year ?? -1) ? p : best), undefined);

  // Area: only a figure in square kilometres (other units are skipped, never converted by guess).
  const area = bestStatements(entity, 'P2046')
    .map(quantity)
    .find((q) => !!q && SQUARE_KILOMETRE.test(q.unit) && q.amount > 0);

  const alpha2 = currentStatements(entity, 'P297')
    .map((s) => s.mainsnak?.datavalue?.value)
    .find((v): v is string => typeof v === 'string' && /^[A-Z]{2}$/.test(v));

  const name =
    cleanLabel(entity.labels?.en?.value) ??
    cleanLabel(Object.values(entity.labels ?? {}).find((l) => !!l?.value)?.value) ??
    entity.id;

  return {
    id: entity.id,
    name,
    ...(alpha2 ? { alpha2 } : {}),
    capitals: named('P36', LIMITS.capitals),
    ...(pop ? { population: pop.q.amount, ...(pop.year ? { populationYear: pop.year } : {}) } : {}),
    ...(area ? { areaKm2: area.amount } : {}),
    currencies: named('P38', LIMITS.currencies),
    languages: named('P37', LIMITS.languages),
    continents: named('P30', LIMITS.continents),
    url: `https://www.wikidata.org/wiki/${entity.id}`
  };
};

/** One Wikidata API call. A network failure or a spent budget throws as fetchJson threw it. */
const wikidataGet = async (params: Record<string, string>, opts: WikiFetchOptions): Promise<Record<string, unknown>> => {
  const query = new URLSearchParams({ format: 'json', ...params });
  const data = await fetchJson<unknown>(`${WIKIDATA_API}?${query}`, fetchOpts(opts));
  if (!record(data) || record(data.error)) throw new WikidataUnavailableError();
  return data;
};

const getEntities = async (params: Record<string, string>, props: string, opts: WikiFetchOptions): Promise<WikidataEntity[]> => {
  const data = await wikidataGet({ action: 'wbgetentities', props, languages: 'en', ...params }, opts);
  if (!record(data.entities)) throw new WikidataUnavailableError();
  return Object.values(data.entities).filter(
    (e): e is WikidataEntity => record(e) && !('missing' in e) && typeof e.id === 'string' && QID.test(e.id)
  );
};

const searchItems = async (srsearch: string, limit: number, opts: WikiFetchOptions): Promise<string[]> => {
  const data = await wikidataGet(
    { action: 'query', list: 'search', srsearch, srlimit: String(limit), srnamespace: '0', srprop: '' },
    opts
  );
  const search = record(data.query) ? data.query.search : undefined;
  if (!Array.isArray(search)) throw new WikidataUnavailableError();
  return search
    .map((hit) => (record(hit) ? hit.title : undefined))
    .filter((t): t is string => typeof t === 'string' && QID.test(t))
    .slice(0, limit);
};

const firstCountry = async (itemIds: string[], opts: WikiFetchOptions): Promise<WikidataEntity | undefined> =>
  itemIds.length ? (await getEntities({ ids: itemIds.join('|') }, 'labels|claims', opts)).find(isCountryEntity) : undefined;

/** Search words with no CirrusSearch keywords or regexes in them: letters, marks, spaces, ' . - only. */
const plainWords = (s: string): string =>
  s
    .replace(/[^\p{L}\p{M}\s'.-]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60);

/**
 * Facts about a country from Wikidata (CC0). A 2- or 3-letter code is looked up by ISO 3166-1 alpha-2
 * (P297) or alpha-3 (P298); a name, or a code nothing matches, by its English Wikipedia title (redirects
 * followed); a title that is not a country (a disambiguation page, an island) by a search limited to
 * countries. Then one call labels the values. Null when the source answered and nothing is a country;
 * throws WikidataUnavailableError when its answer is not usable, and fetchJson's error (network, deadline,
 * provider budget) when there was none.
 */
export const wikidataCountry = async (nameOrCode: string, opts: WikiFetchOptions = {}): Promise<CountryFacts | null> => {
  const input = (typeof nameOrCode === 'string' ? nameOrCode : '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 80);
  if (!input) return null;

  let entity: WikidataEntity | undefined;
  if (/^[A-Za-z]{2,3}$/.test(input)) {
    const code = input.toUpperCase();
    entity = await firstCountry(await searchItems(`haswbstatement:${code.length === 2 ? 'P297' : 'P298'}=${code}`, 3, opts), opts);
  }
  if (!entity) {
    entity = (await getEntities({ sites: 'enwiki', titles: input, normalize: '1' }, 'labels|claims', opts)).find(isCountryEntity);
  }
  if (!entity) {
    const words = plainWords(input);
    if (words) entity = await firstCountry(await searchItems(`${words} haswbstatement:P31=Q6256|P31=Q3624078`, 1, opts), opts);
  }
  if (!entity) return null;

  const wanted = labelIdsFor(entity);
  const labels: Record<string, string> = {};
  if (wanted.length) {
    const data = await wikidataGet({ action: 'wbgetentities', props: 'labels', languages: 'en', languagefallback: '1', ids: wanted.join('|') }, opts);
    if (!record(data.entities)) throw new WikidataUnavailableError();
    for (const [id, e] of Object.entries(data.entities)) {
      const label = record(e) && record(e.labels) && record(e.labels.en) ? cleanLabel(e.labels.en.value) : undefined;
      if (label && QID.test(id)) labels[id] = label;
    }
  }
  return parseWikidataCountry(entity, labels);
};
