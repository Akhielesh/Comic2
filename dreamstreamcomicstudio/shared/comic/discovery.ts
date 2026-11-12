// Discover — the public listing contract (redesign DS-R2; owner decision R-D3). Types and a pure codec only.
//
// One codec, two sides:
//   * the edge Worker (api-proxy/src/publicDiscover.ts) parses the query strictly, calls the anon listing RPCs
//     (server/sql/comic_discovery.sql) and rebuilds every item from this allow-list (discoverPageFromRpc /
//     discoverShelvesFromRpc), so nothing the RPC sends beyond it reaches a reader;
//   * the Discover UI (DS-R6) builds request URLs (discoverListUrl / discoverShelvesUrl) and re-validates what comes
//     back (decodeDiscoverPage / decodeDiscoverShelves), so a stray field never reaches a component.
//
// What a listing may say about a comic is exactly DiscoverItem: never the snapshot, safety data, an asset key or a
// user id. A creator byline (`creator`) is present only when the creator turned on "Show my username" for that
// publication (comic_publications.show_creator): the SQL decides, the codec only carries it. Covers are the opaque
// pub/ copies only. Runtime imports stay tiny (SLUG_RE) so the Worker bundle does not grow.

import type { AspectRatio, ComicKind } from './doc.js';
import type { ContentRating } from './safety.js';
import { SLUG_RE } from './publication.js';

// ── Limits (server/sql/comic_discovery.sql repeats each one; tests/config/discoveryListingGuard.test.ts pins both) ──

export const DISCOVER_PATH = '/api/comic/public/discover';
export const DISCOVER_SHELVES_PATH = '/api/comic/public/discover/shelves';
/** Items per page, and the most a caller may ask for. */
export const DISCOVER_LIMIT_MAX = 24;
/** Longest search, in characters (code points). */
export const DISCOVER_Q_MAX = 60;
/** Items per shelf. */
export const DISCOVER_SHELF_SIZE = 12;
/** "In your language" and the Webtoons / Manga shelves only show with at least this many comics. */
export const DISCOVER_SHELF_MIN = 4;
/**
 * Seconds a listing may be reused, in the browser (max-age) and again at the edge (s-maxage): a moderation hold or an
 * unpublish leaves every listing within 2 × 30 = 60 s. The comic itself (/c/<slug>) is never cached and stops at once.
 */
export const DISCOVER_CACHE_SECONDS = 30;
/** "This week": first published in the last 7 days (New), or read in the last 7 days (Trending). */
export const DISCOVER_WEEK_DAYS = 7;

// ── Vocabulary ──────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Trending = reads in the last 7 days; New = first published, newest first; Most read = all-time reads. A read counts
 * each reader once a day (comic_publication_track), so a reader who comes back on another day counts again.
 */
export type DiscoverSort = 'trending' | 'new' | 'most_read';
export const DISCOVER_SORTS: readonly DiscoverSort[] = ['trending', 'new', 'most_read'];
/** 'kids' = G or PG (an unrated comic is never kids-friendly); a rating = exactly that rating. */
export type DiscoverRatingFilter = 'kids' | ContentRating;
export const DISCOVER_RATINGS: readonly ContentRating[] = ['G', 'PG', 'PG-13'];
export const DISCOVER_RATING_FILTERS: readonly DiscoverRatingFilter[] = ['kids', ...DISCOVER_RATINGS];
const KIND_KEYS: Record<ComicKind, true> = { comic: true, manga: true, webtoon: true, strip: true, storybook: true };
export const DISCOVER_KINDS = Object.keys(KIND_KEYS) as ComicKind[];
const ASPECT_KEYS: Record<AspectRatio, true> = {
  '1:1': true, '2:3': true, '3:2': true, '3:4': true, '4:3': true, '4:5': true, '5:4': true,
  '9:16': true, '16:9': true, '21:9': true, '1:4': true, '4:1': true, '1:8': true, '8:1': true
};
export const DISCOVER_ASPECTS = Object.keys(ASPECT_KEYS) as AspectRatio[];
export type DiscoverLength = 'short' | 'medium' | 'long';
/** Page-count bands for the Length filter (inclusive). */
export const DISCOVER_LENGTHS: Readonly<Record<DiscoverLength, { min: number; max: number }>> = {
  short: { min: 1, max: 8 },
  medium: { min: 9, max: 24 },
  long: { min: 25, max: 500 }
};
export type DiscoverShelfId = 'featured' | 'trending' | 'new' | 'kids' | 'lang' | 'webtoon' | 'manga';
/** Home order. Featured hides when nothing is featured; every shelf hides when empty. */
export const DISCOVER_SHELF_IDS: readonly DiscoverShelfId[] = ['featured', 'trending', 'new', 'kids', 'lang', 'webtoon', 'manga'];
/** Shelves that need DISCOVER_SHELF_MIN comics to show (a thin shelf reads as broken). */
export const DISCOVER_THIN_SHELVES: readonly DiscoverShelfId[] = ['lang', 'webtoon', 'manga'];

// ── Wire shapes ─────────────────────────────────────────────────────────────────────────────────────────────────

/** The published cover's opaque public copies (pub/ only). Both are always set when a comic has art. */
export interface DiscoverCover { w480: string; w1080: string }
/** Only when the creator showed their username on this publication. `avatarUrl` only for an id-free avatar in our storage. */
export interface DiscoverCreator { username: string; avatarUrl?: string }
/** One public comic in a listing: the complete allow-list. */
export interface DiscoverItem {
  slug: string;
  title: string;
  description: string;
  kind: ComicKind;
  pageCount: number;
  aspect: AspectRatio;
  cover?: DiscoverCover;
  /** The frozen publish-time rating; absent = unknown (never kids-friendly). */
  rating?: ContentRating;
  /** Published editions; [0] is the original. */
  languages: string[];
  /** Latest publish (ms). Republished within 7 days of a first publish older than that reads as "Updated". */
  publishedAt: number;
  /** First publish (ms). Within 7 days reads as "New". */
  firstPublishedAt: number;
  likes: number;
  themeColor?: string;
  creator?: DiscoverCreator;
}
/**
 * GET /api/comic/public/discover. `next` is opaque: pass it back as `cursor` with the same query. It names the last
 * item only (never a score); a cursor whose comic has left the listing answers an empty page, so start again.
 */
export interface DiscoverPage { items: DiscoverItem[]; next?: string }
export type DiscoverShelves = Partial<Record<DiscoverShelfId, DiscoverItem[]>>;
/** GET /api/comic/public/discover/shelves. Only shelves worth showing are present. */
export interface DiscoverShelvesResponse { shelves: DiscoverShelves }

export interface DiscoverQuery {
  sort: DiscoverSort;
  q?: string;
  rating?: DiscoverRatingFilter;
  /** Only comics published in this language (lower case). */
  lang?: string;
  kind?: ComicKind;
  length?: DiscoverLength;
  /** "This week" (see DISCOVER_WEEK_DAYS); ignored by most_read. */
  week?: boolean;
  limit: number;
  /** A page's `next`, for the same query. */
  cursor?: string;
}
export interface DiscoverShelvesQuery {
  rating?: DiscoverRatingFilter;
  lang?: string;
  kind?: ComicKind;
  /** The reader's language, for the "In your language" shelf (shown only when `lang` is not set). */
  yourLang?: string;
}

export type DiscoverParse<T> = { ok: true; value: T } | { ok: false; reason: string };
const ok = <T>(value: T): DiscoverParse<T> => ({ ok: true, value });
const fail = <T>(reason: string): DiscoverParse<T> => ({ ok: false, reason });

// ── Small validators ────────────────────────────────────────────────────────────────────────────────────────────

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const LANG_RE = /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8}){0,2}$/;
const USERNAME_RE = /^[A-Za-z0-9_.-]{2,40}$/;
const HEX_RE = /^#[0-9a-fA-F]{6}$/;
const COVER_PATH_RE = /^pub\/[A-Za-z0-9]{22}\/[A-Za-z0-9._-]{1,120}$/;
const SUPABASE_HOST_RE = /^[a-z0-9]{10,40}\.supabase\.co$/;
const OBJECT_PATH_RE = /^\/storage\/v1\/object\/public\/[a-z0-9-]{3,63}\/([A-Za-z0-9._/-]{1,300})$/;
// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f]/gu;
const KIND_SET = new Set<string>(DISCOVER_KINDS);
const ASPECT_SET = new Set<string>(DISCOVER_ASPECTS);
const RATING_SET = new Set<string>(DISCOVER_RATINGS);
const MAX_TIME_MS = 8_640_000_000_000_000;

/** A language tag in its canonical (lower-case) form, or undefined. */
export const discoverLang = (v: unknown): string | undefined =>
  typeof v === 'string' && v.length <= 35 && LANG_RE.test(v) ? v.toLowerCase() : undefined;

/** Text from the card: control characters out, trimmed, at most `max` characters; undefined when empty. */
function cleanText(v: unknown, max: number): string | undefined {
  if (typeof v !== 'string') return undefined;
  const text = [...v.replace(CONTROL_RE, '').trim()].slice(0, max).join('').trim();
  return text || undefined;
}

function wholeNumber(v: unknown, min: number, max: number): number | undefined {
  return typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max ? v : undefined;
}

const isSafePubPath = (p: unknown): p is string => typeof p === 'string' && COVER_PATH_RE.test(p) && !p.includes('..');

/** A Supabase Storage public-object URL (https, no credentials, port, query or fragment); its object path, or null. */
function publicObjectPath(value: unknown, origin?: string): string | null {
  if (typeof value !== 'string' || value.length > 500) return null;
  let u: URL;
  try {
    u = new URL(value);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' || u.username || u.password || u.port || u.search || u.hash || !SUPABASE_HOST_RE.test(u.hostname)) return null;
  if (origin && u.origin !== origin) return null;
  const m = OBJECT_PATH_RE.exec(u.pathname);
  if (!m || m[1].includes('..') || m[1].includes('//')) return null;
  return m[1];
}

/** A cover URL a publication card may show: a public copy under pub/<key>/ in our storage. */
export const isPublicCoverUrl = (value: unknown): value is string => isSafePubPath(publicObjectPath(value));

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
/**
 * An avatar a byline may show: a public object in our storage (never a third-party image host) whose URL holds no
 * id. Uploaded avatars live under `<uid>/avatar-…` (services/db.ts clientUploadPath), so they are left out until
 * they get an opaque copy: a listing never carries a user id.
 */
export const isPublicAvatarUrl = (value: unknown, origin?: string): value is string => {
  const path = publicObjectPath(value, origin);
  return path !== null && !UUID_RE.test(value as string);
};

// ── Cursor ──────────────────────────────────────────────────────────────────────────────────────────────────────

const SORT_CODE: Record<DiscoverSort, string> = { trending: 't', new: 'n', most_read: 'r' };
/** `<sort code>.<slug>`: nothing else, so no reader statistic or staff rank can ride along. */
const CURSOR_RE = /^([tnr])\.([A-Za-z0-9]{17})$/;

/**
 * The keyset position after an item: the slug of a page's last item, and nothing else. The ranking score (reads, a
 * publish time, the staff rank) stays inside the database: comic_discover_list continues after that comic's current
 * score, and answers an empty page when the comic is no longer listed under the query.
 */
export interface DiscoverCursor { slug: string }

export function encodeDiscoverCursor(sort: DiscoverSort, cursor: DiscoverCursor): string {
  return `${SORT_CODE[sort]}.${cursor.slug}`;
}

/** The cursor's position, only for the sort it was made for (a cursor never moves between sorts). */
export function decodeDiscoverCursor(sort: DiscoverSort, value: unknown): DiscoverCursor | null {
  if (typeof value !== 'string') return null;
  const m = CURSOR_RE.exec(value);
  if (!m || m[1] !== SORT_CODE[sort]) return null;
  return { slug: m[2] };
}

const isCursorShape = (v: unknown): v is string => typeof v === 'string' && CURSOR_RE.test(v);

/** The RPC's `next` → a cursor: only its slug is read (anything else the RPC might add is dropped). */
const cursorFromRpc = (v: unknown): DiscoverCursor | null =>
  isRecord(v) && typeof v.slug === 'string' && SLUG_RE.test(v.slug) ? { slug: v.slug } : null;

// ── Queries ─────────────────────────────────────────────────────────────────────────────────────────────────────

const LIST_KEYS = new Set(['sort', 'q', 'rating', 'lang', 'kind', 'length', 'week', 'limit', 'cursor']);
const SHELF_KEYS = new Set(['rating', 'lang', 'kind', 'your_lang']);

function singles(params: URLSearchParams, allowed: Set<string>): DiscoverParse<Map<string, string>> {
  const out = new Map<string, string>();
  for (const [key, value] of params) {
    if (!allowed.has(key)) return fail(`Unknown parameter "${key.slice(0, 24)}".`);
    if (out.has(key)) return fail(`"${key}" can only be given once.`);
    out.set(key, value);
  }
  return ok(out);
}

/** A search as it is sent: NFC, whitespace folded, ≤ DISCOVER_Q_MAX characters; undefined when blank. */
export function normalizeDiscoverSearch(raw: string): DiscoverParse<string | undefined> {
  const text = raw.normalize('NFC').replace(/\s+/gu, ' ').trim();
  if (!text) return ok(undefined);
  if (new RegExp(CONTROL_RE.source, 'u').test(text)) return fail('A search can’t contain control characters.');
  if ([...text].length > DISCOVER_Q_MAX) return fail(`A search can be at most ${DISCOVER_Q_MAX} characters.`);
  return ok(text);
}

function ratingFilter(v: string | undefined): DiscoverParse<DiscoverRatingFilter | undefined> {
  if (v === undefined) return ok(undefined);
  return (DISCOVER_RATING_FILTERS as readonly string[]).includes(v) ? ok(v as DiscoverRatingFilter) : fail('Unknown rating filter.');
}
function kindFilter(v: string | undefined): DiscoverParse<ComicKind | undefined> {
  if (v === undefined) return ok(undefined);
  return KIND_SET.has(v) ? ok(v as ComicKind) : fail('Unknown kind.');
}
function langFilter(v: string | undefined, name: string): DiscoverParse<string | undefined> {
  if (v === undefined) return ok(undefined);
  const lang = discoverLang(v);
  return lang ? ok(lang) : fail(`"${name}" must be a language code such as en or pt-BR.`);
}

/** Strict: every parameter known, given once, well formed (the Worker answers 400 otherwise). */
export function parseDiscoverQuery(search: string | URLSearchParams): DiscoverParse<DiscoverQuery> {
  const params = singles(typeof search === 'string' ? new URLSearchParams(search) : search, LIST_KEYS);
  if (params.ok === false) return params;
  const p = params.value;
  const sort = (p.get('sort') ?? 'trending') as DiscoverSort;
  if (!DISCOVER_SORTS.includes(sort)) return fail('Unknown sort.');
  const query: DiscoverQuery = { sort, limit: DISCOVER_LIMIT_MAX };
  const q = normalizeDiscoverSearch(p.get('q') ?? '');
  if (q.ok === false) return q;
  if (q.value) query.q = q.value;
  const rating = ratingFilter(p.get('rating'));
  if (rating.ok === false) return rating;
  if (rating.value) query.rating = rating.value;
  const lang = langFilter(p.get('lang'), 'lang');
  if (lang.ok === false) return lang;
  if (lang.value) query.lang = lang.value;
  const kind = kindFilter(p.get('kind'));
  if (kind.ok === false) return kind;
  if (kind.value) query.kind = kind.value;
  const length = p.get('length');
  if (length !== undefined) {
    if (!Object.prototype.hasOwnProperty.call(DISCOVER_LENGTHS, length)) return fail('Unknown length.');
    query.length = length as DiscoverLength;
  }
  const week = p.get('week');
  if (week !== undefined) {
    if (week !== '1') return fail('"week" must be 1.');
    query.week = true;
  }
  const limit = p.get('limit');
  if (limit !== undefined) {
    const n = /^[1-9]\d?$/.test(limit) ? Number(limit) : NaN;
    if (!(n >= 1 && n <= DISCOVER_LIMIT_MAX)) return fail(`"limit" must be a whole number from 1 to ${DISCOVER_LIMIT_MAX}.`);
    query.limit = n;
  }
  const cursor = p.get('cursor');
  if (cursor !== undefined) {
    if (!decodeDiscoverCursor(sort, cursor)) return fail('That cursor does not belong to this listing. Start again from the first page.');
    query.cursor = cursor;
  }
  return ok(query);
}

export function parseDiscoverShelvesQuery(search: string | URLSearchParams): DiscoverParse<DiscoverShelvesQuery> {
  const params = singles(typeof search === 'string' ? new URLSearchParams(search) : search, SHELF_KEYS);
  if (params.ok === false) return params;
  const p = params.value;
  const query: DiscoverShelvesQuery = {};
  const rating = ratingFilter(p.get('rating'));
  if (rating.ok === false) return rating;
  if (rating.value) query.rating = rating.value;
  const lang = langFilter(p.get('lang'), 'lang');
  if (lang.ok === false) return lang;
  if (lang.value) query.lang = lang.value;
  const kind = kindFilter(p.get('kind'));
  if (kind.ok === false) return kind;
  if (kind.value) query.kind = kind.value;
  const yours = langFilter(p.get('your_lang'), 'your_lang');
  if (yours.ok === false) return yours;
  if (yours.value) query.yourLang = yours.value;
  return ok(query);
}

/** The canonical query string (fixed order, defaults left out): the edge cache key and the URL the UI requests. */
export function discoverSearch(query: DiscoverQuery): string {
  const p = new URLSearchParams();
  if (query.sort !== 'trending') p.set('sort', query.sort);
  if (query.q) p.set('q', query.q);
  if (query.rating) p.set('rating', query.rating);
  if (query.lang) p.set('lang', query.lang);
  if (query.kind) p.set('kind', query.kind);
  if (query.length) p.set('length', query.length);
  if (query.week) p.set('week', '1');
  if (query.limit !== DISCOVER_LIMIT_MAX) p.set('limit', String(query.limit));
  if (query.cursor) p.set('cursor', query.cursor);
  return p.toString();
}

export function discoverShelvesSearch(query: DiscoverShelvesQuery): string {
  const p = new URLSearchParams();
  if (query.rating) p.set('rating', query.rating);
  if (query.lang) p.set('lang', query.lang);
  if (query.kind) p.set('kind', query.kind);
  if (query.yourLang) p.set('your_lang', query.yourLang);
  return p.toString();
}

const withSearch = (path: string, search: string) => (search ? `${path}?${search}` : path);
/** The listing URL for a query (relative; the UI prefixes its API base). Filters: sort, q, rating, lang, kind, length, week. */
export const discoverListUrl = (query: Partial<DiscoverQuery> = {}): string =>
  withSearch(DISCOVER_PATH, discoverSearch({ sort: 'trending', limit: DISCOVER_LIMIT_MAX, ...query }));
export const discoverShelvesUrl = (query: DiscoverShelvesQuery = {}): string => withSearch(DISCOVER_SHELVES_PATH, discoverShelvesSearch(query));

/** comic_discover_list's arguments for a query (names and order exactly as the SQL declares them). */
export function discoverListRpcArgs(query: DiscoverQuery): Record<string, string | number | boolean | null> {
  const after = query.cursor ? decodeDiscoverCursor(query.sort, query.cursor) : null;
  return {
    p_sort: query.sort,
    p_q: query.q ?? null,
    p_rating: query.rating ?? null,
    p_lang: query.lang ?? null,
    p_kind: query.kind ?? null,
    p_length: query.length ?? null,
    p_week: !!query.week,
    p_limit: query.limit,
    p_after_slug: after ? after.slug : null
  };
}

/** comic_discover_shelves's arguments. */
export function discoverShelvesRpcArgs(query: DiscoverShelvesQuery): Record<string, string | null> {
  return { p_rating: query.rating ?? null, p_lang: query.lang ?? null, p_kind: query.kind ?? null, p_your_lang: query.yourLang ?? null };
}

// ── Items ───────────────────────────────────────────────────────────────────────────────────────────────────────

/** How an item's cover is read: paths from the RPC (mapped to public URLs by the Worker) or URLs from the wire. */
type CoverReader = (raw: unknown) => DiscoverCover | undefined;

function buildItem(raw: unknown, readCover: CoverReader, avatarOrigin?: string): DiscoverItem | null {
  if (!isRecord(raw)) return null;
  if (typeof raw.slug !== 'string' || !SLUG_RE.test(raw.slug)) return null;
  const title = cleanText(raw.title, 90);
  const pageCount = wholeNumber(raw.pageCount, 1, DISCOVER_LENGTHS.long.max);
  if (!title || pageCount === undefined) return null;
  const publishedAt = wholeNumber(raw.publishedAt, 0, MAX_TIME_MS) ?? 0;
  const languages: string[] = [];
  if (Array.isArray(raw.languages)) {
    for (const l of raw.languages) {
      if (typeof l === 'string' && l.length <= 35 && LANG_RE.test(l) && !languages.includes(l) && languages.length < 12) languages.push(l);
    }
  }
  const item: DiscoverItem = {
    slug: raw.slug,
    title,
    description: cleanText(raw.description, 200) ?? '',
    kind: typeof raw.kind === 'string' && KIND_SET.has(raw.kind) ? (raw.kind as ComicKind) : 'comic',
    pageCount,
    aspect: typeof raw.aspect === 'string' && ASPECT_SET.has(raw.aspect) ? (raw.aspect as AspectRatio) : '2:3',
    languages,
    publishedAt,
    firstPublishedAt: wholeNumber(raw.firstPublishedAt, 0, MAX_TIME_MS) ?? publishedAt,
    likes: wholeNumber(raw.likes, 0, 1_000_000_000) ?? 0
  };
  const cover = readCover(raw.cover);
  if (cover) item.cover = cover;
  if (typeof raw.rating === 'string' && RATING_SET.has(raw.rating)) item.rating = raw.rating as ContentRating;
  if (typeof raw.themeColor === 'string' && HEX_RE.test(raw.themeColor)) item.themeColor = raw.themeColor;
  if (isRecord(raw.creator) && typeof raw.creator.username === 'string' && USERNAME_RE.test(raw.creator.username)) {
    item.creator = { username: raw.creator.username };
    if (isPublicAvatarUrl(raw.creator.avatarUrl, avatarOrigin)) item.creator.avatarUrl = raw.creator.avatarUrl;
  }
  return item;
}

function buildItems(raw: unknown, readCover: CoverReader, max: number, avatarOrigin?: string): DiscoverItem[] {
  if (!Array.isArray(raw)) return [];
  const out: DiscoverItem[] = [];
  const seen = new Set<string>();
  for (const entry of raw) {
    if (out.length >= max) break;
    const item = buildItem(entry, readCover, avatarOrigin);
    if (item && !seen.has(item.slug)) {
      seen.add(item.slug);
      out.push(item);
    }
  }
  return out;
}

function buildShelves(raw: unknown, readCover: CoverReader, avatarOrigin?: string): DiscoverShelves {
  const shelves: DiscoverShelves = {};
  if (!isRecord(raw)) return shelves;
  for (const id of DISCOVER_SHELF_IDS) {
    const items = buildItems(raw[id], readCover, DISCOVER_SHELF_SIZE, avatarOrigin);
    const min = DISCOVER_THIN_SHELVES.includes(id) ? DISCOVER_SHELF_MIN : 1;
    if (items.length >= min) shelves[id] = items;
  }
  return shelves;
}

export interface DiscoverRpcOptions {
  /** A pub/ path → its public URL (the Worker's publicObjectUrl). */
  coverUrl: (path: string) => string;
  /** Avatars are shown only from this origin (the project's Supabase origin). */
  avatarOrigin?: string;
}

const rpcCover = (coverUrl: (path: string) => string): CoverReader => (raw) =>
  isRecord(raw) && isSafePubPath(raw.w480) && isSafePubPath(raw.w1080) ? { w480: coverUrl(raw.w480), w1080: coverUrl(raw.w1080) } : undefined;

const wireCover: CoverReader = (raw) =>
  isRecord(raw) && isPublicCoverUrl(raw.w480) && isPublicCoverUrl(raw.w1080) ? { w480: raw.w480, w1080: raw.w1080 } : undefined;

/**
 * comic_discover_list's answer → the wire page. `null` data (no rows) is an empty page; anything that is not a
 * listing at all is null (the Worker answers 503, never "nothing here").
 */
export function discoverPageFromRpc(raw: unknown, sort: DiscoverSort, opts: DiscoverRpcOptions): DiscoverPage | null {
  if (raw === null || raw === undefined) return { items: [] };
  if (!isRecord(raw) || !Array.isArray(raw.items)) return null;
  const page: DiscoverPage = { items: buildItems(raw.items, rpcCover(opts.coverUrl), DISCOVER_LIMIT_MAX, opts.avatarOrigin) };
  const next = cursorFromRpc(raw.next);
  if (next) page.next = encodeDiscoverCursor(sort, next);
  return page;
}

/** comic_discover_shelves's answer → the wire shelves (thin and empty shelves left out). */
export function discoverShelvesFromRpc(raw: unknown, opts: DiscoverRpcOptions): DiscoverShelvesResponse | null {
  if (raw === null || raw === undefined) return { shelves: {} };
  if (!isRecord(raw)) return null;
  return { shelves: buildShelves(raw, rpcCover(opts.coverUrl), opts.avatarOrigin) };
}

/** The UI's check of a listing response: the allow-list again (unknown fields dropped), or null for a non-listing. */
export function decodeDiscoverPage(raw: unknown): DiscoverPage | null {
  if (!isRecord(raw) || !Array.isArray(raw.items)) return null;
  const page: DiscoverPage = { items: buildItems(raw.items, wireCover, DISCOVER_LIMIT_MAX) };
  if (isCursorShape(raw.next)) page.next = raw.next;
  return page;
}

export function decodeDiscoverShelves(raw: unknown): DiscoverShelvesResponse | null {
  if (!isRecord(raw) || !isRecord(raw.shelves)) return null;
  return { shelves: buildShelves(raw.shelves, wireCover) };
}
