// Reading — how public comics are read (Discover DISC-0). Types, constants and pure functions only.
//
// One contract, several sides:
//   * the public reader (share/readSession.ts) builds read batches with encodeReadBody and sends them as text/plain
//     (a CORS-safelisted type, so no preflight) to READ_PATH(slug), never on a timer;
//   * the edge Worker (api-proxy/src/publicComic.ts) re-reads every body with decodeReadBody, which keeps only the
//     allow-listed fields and values; the database (server/sql/comic_reading.sql) repeats each threshold below and
//     never trusts the body for the page count, qualification or finishing;
//   * the creator's Readers tab and the admin Reading section re-validate the container's answers with
//     decodeReadInsights / decodeReadingAdminOverview, which also hold the k ≥ K_MIN rule for every breakdown.
//
// What a read may carry is exactly ReadBody: never a slug, a referrer, an address or a lasting id. `d` is a random code
// the browser makes again every UTC day (never for children's comics); the edge turns it, or the address and browser
// when it is missing, into a one-day number the database deletes after two days. Runtime imports stay small
// (PUBLIC_KIDS_AUDIENCE, SLUG_RE, and the dependency-free language registry for the Library language rule).

import type { ContentRating } from './safety.js';
import { PUBLIC_KIDS_AUDIENCE, SLUG_RE } from './publication.js';
import { LANGUAGES, matchLanguage } from './languages.js';

// ── The read event ──────────────────────────────────────────────────────────────────────────────────────────────

/** Where the reader sends its batches (POST, text/plain JSON; always answered 204). */
export const READ_PATH = (slug: string): string => `/api/comic/public/s/${slug}/read`;
/** The largest body the edge reads, in UTF-8 bytes; a larger one is dropped unread. */
export const READ_BODY_MAX = 2048;
/** Page numbers in a body are 1..READ_PAGE_MAX (the publication page limit). */
export const READ_PAGE_MAX = 500;
/** At most this many [page, ms] pairs in one body. */
export const READ_PAIRS_MAX = 60;
/** Longest language tag in a body. */
export const READ_LANG_MAX = 35;

/** open: the comic was opened (once per mount); read: pages on screen and for how long; lang: an edition switch; share. */
export type ReadEventType = 'open' | 'read' | 'lang' | 'share';
export const READ_EVENT_TYPES: readonly ReadEventType[] = ['open', 'read', 'lang', 'share'];

/**
 * How the reader arrived: `?via=` first, else the browsing session's entry channel, else the referrer's host
 * (channelFromReferrer). Every share channel (publication.ts SHARE_CHANNELS) is one of these, so old links keep
 * theirs; `linkedin`, `library`, `up_next` and `search` exist only here.
 */
export type ReadChannel =
  | 'linkedin'
  | 'whatsapp'
  | 'x'
  | 'facebook'
  | 'telegram'
  | 'email'
  | 'qr'
  | 'embed'
  | 'copy'
  | 'native'
  | 'library'
  | 'up_next'
  | 'search'
  | 'direct'
  | 'other';
export const READ_CHANNELS: readonly ReadChannel[] = [
  'linkedin', 'whatsapp', 'x', 'facebook', 'telegram', 'email', 'qr', 'embed', 'copy', 'native', 'library', 'up_next', 'search', 'direct', 'other'
];

/** Which of our own surfaces the reader came from (`?src=`): a plain link, a Library row, the share page's shelves. */
export type ReadSurface =
  | 'link'
  | 'lib.billboard'
  | 'lib.continue'
  | 'lib.lang'
  | 'lib.trending'
  | 'lib.top10'
  | 'lib.new'
  | 'lib.picks'
  | 'lib.kind'
  | 'lib.grid'
  | 'more'
  | 'up_next'
  | 'embed';
export const READ_SURFACES: readonly ReadSurface[] = [
  'link', 'lib.billboard', 'lib.continue', 'lib.lang', 'lib.trending', 'lib.top10', 'lib.new', 'lib.picks', 'lib.kind', 'lib.grid', 'more', 'up_next', 'embed'
];

export type ReadDevice = 'phone' | 'tablet' | 'desktop';
export const READ_DEVICES: readonly ReadDevice[] = ['phone', 'tablet', 'desktop'];

/** One page on screen in a batch: [page 1..READ_PAGE_MAX, visible ms 0..PAGE_MS_BATCH_CAP]. */
export type ReadPagePair = [page: number, ms: number];

/** A read batch, exactly as sent (keys in this order). Every field but `v` and `t` is optional. */
export interface ReadBody {
  v: 1;
  t: ReadEventType;
  /** The per-day code: 16 random bytes, base64url (22 characters). Never for children's comics. */
  d?: string;
  /**
   * The edition on screen: BCP-47 shape (the same as Discover's `lang` and the SQL guard, at most three subtags), lower
   * case once decoded, so a re-cased tag is the same value. It is still only a claim: ingest (comic_read_ingest, DISC-1)
   * counts a read under readCountedEdition(lang, card.languages, card.defaultLang), never under the tag as sent, so a
   * comic's page-stats rows and `by_lang_q` keys are only ever its published editions, however many tags a client
   * invents (each new key would otherwise be a new row per page per day).
   */
  lang?: string;
  ch?: ReadChannel;
  src?: ReadSurface;
  dev?: ReadDevice;
  /** Pages on screen since the last batch and their visible time (each page once; time split across a spread). */
  p?: ReadPagePair[];
  /** The highest page reached so far. */
  mx?: number;
  /**
   * For `lang`: the edition switched from (same shape, lower case). Ingest counts a switch only when both `from` and
   * `lang` are published editions (readEditionOf) and differ.
   */
  from?: string;
}

// ── Thresholds (server/sql/comic_reading.sql repeats each one; DISC-1's parity test pins both) ──────────────────

/** A page counts as seen after this much visible time. */
export const QUALIFY_PAGE_MS = 1000;
/** A qualified read has seen at least this many pages (or the page count, when the comic is shorter)… */
export const QUALIFY_MIN_PAGES = 2;
/** …and at least this much visible time in all. */
export const QUALIFY_TOTAL_MS = 8000;
/** A finished read reached the last page and has seen at least this share of the pages. */
export const FINISH_SHARE = 0.6;
/** Visible time per page per batch is counted up to this. */
export const PAGE_MS_BATCH_CAP = 120000;
/** Visible time per reader per day is counted up to this × the page count. */
export const VIEWER_DWELL_CAP_PER_PAGE = 120000;
/** Batches per reader per comic per day; later ones answer `capped`. */
export const BATCHES_PER_DAY = 40;
/** Ranked readers per narrow network (IPv4 address or IPv6 /64) per comic per day. */
export const RANK_CAP_NARROW = 3;
/** Ranked readers per wide network (IPv4 /24 or IPv6 /48) per comic per day. */
export const RANK_CAP_WIDE = 20;
/** Readers counted in a creator's stats per wide network per comic per day. */
export const CREATOR_CAP_WIDE = 50;
/** k-anonymity: page details and every breakdown bucket need at least this many readers. */
export const K_MIN = 5;
/** The reader sends a batch every this many newly reached pages (and on the last page, a switch, a share, hide). */
export const FLUSH_EVERY_NEW_PAGES = 4;

// ── Small validators ────────────────────────────────────────────────────────────────────────────────────────────

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const DAY_CODE_RE = /^[A-Za-z0-9_-]{22}$/;
/**
 * A language tag: the shape Discover's `lang` (discovery.ts discoverLang), the edge's /event check and the SQL guard
 * (comic_discovery.sql) accept, at most three subtags. Published editions are far shorter ('zh-Hans').
 */
const LANG_RE = /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8}){0,2}$/;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const EVENT_SET = new Set<string>(READ_EVENT_TYPES);
const CHANNEL_SET = new Set<string>(READ_CHANNELS);
const SURFACE_SET = new Set<string>(READ_SURFACES);
const DEVICE_SET = new Set<string>(READ_DEVICES);
const COUNT_MAX = 1_000_000_000;
const MAX_TIME_MS = 8_640_000_000_000_000;
// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f]/gu;

const isLang = (v: unknown): v is string => typeof v === 'string' && v.length <= READ_LANG_MAX && LANG_RE.test(v);
/** A language tag in its canonical (lower-case) form, or undefined. */
const langOf = (v: unknown): string | undefined => (isLang(v) ? v.toLowerCase() : undefined);
const wholeIn = (v: unknown, min: number, max: number): v is number => typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max;
const numberIn = (v: unknown, min: number, max: number): v is number => typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max;
const count = (v: unknown): v is number => wholeIn(v, 0, COUNT_MAX);

/** UTF-8 length of a string, without allocating (lone surrogates count as the 3-byte replacement character). */
function utf8Bytes(text: string): number {
  let n = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < text.length && (text.charCodeAt(i + 1) & 0xfc00) === 0xdc00) {
      n += 4;
      i++;
    } else n += 3;
  }
  return n;
}

/**
 * Page pairs as the edge keeps them: each pair exactly [whole page 1..500, whole ms 0..120000] (anything else dropped),
 * a page given twice merged (summed, capped at PAGE_MS_BATCH_CAP) so each page is once per batch, at most
 * READ_PAIRS_MAX pages, in first-seen order.
 */
function pagePairs(raw: unknown, forgiving: boolean): ReadPagePair[] {
  if (!Array.isArray(raw)) return [];
  const order: number[] = [];
  const ms = new Map<number, number>();
  for (const pair of raw) {
    if (!Array.isArray(pair) || pair.length !== 2) continue;
    const [page, rawMs] = pair as unknown[];
    if (!wholeIn(page, 1, READ_PAGE_MAX)) continue;
    let time: number;
    if (forgiving) {
      if (typeof rawMs !== 'number' || !Number.isFinite(rawMs)) continue;
      time = Math.min(PAGE_MS_BATCH_CAP, Math.max(0, Math.round(rawMs)));
    } else {
      if (!wholeIn(rawMs, 0, PAGE_MS_BATCH_CAP)) continue;
      time = rawMs;
    }
    const seen = ms.get(page);
    if (seen === undefined) {
      if (order.length >= READ_PAIRS_MAX) continue;
      order.push(page);
      ms.set(page, time);
    } else ms.set(page, Math.min(PAGE_MS_BATCH_CAP, seen + time));
  }
  return order.map((page) => [page, ms.get(page) as number]);
}

/** The allow-list, shared by both directions. `forgiving` (the encoder) rounds and clamps the reader's own times. */
function readBodyOf(raw: unknown, forgiving: boolean): ReadBody | null {
  if (!isRecord(raw) || raw.v !== 1 || typeof raw.t !== 'string' || !EVENT_SET.has(raw.t)) return null;
  const body: ReadBody = { v: 1, t: raw.t as ReadEventType };
  if (typeof raw.d === 'string' && DAY_CODE_RE.test(raw.d)) body.d = raw.d;
  const lang = langOf(raw.lang);
  if (lang) body.lang = lang;
  if (typeof raw.ch === 'string' && CHANNEL_SET.has(raw.ch)) body.ch = raw.ch as ReadChannel;
  if (typeof raw.src === 'string' && SURFACE_SET.has(raw.src)) body.src = raw.src as ReadSurface;
  if (typeof raw.dev === 'string' && DEVICE_SET.has(raw.dev)) body.dev = raw.dev as ReadDevice;
  const p = pagePairs(raw.p, forgiving);
  if (p.length) body.p = p;
  if (wholeIn(raw.mx, 1, READ_PAGE_MAX)) body.mx = raw.mx;
  const from = langOf(raw.from);
  if (from) body.from = from;
  return body;
}

/**
 * The text the reader sends. Fields outside the allow-list are left out; visible times are rounded to whole ms and
 * clamped to PAGE_MS_BATCH_CAP; a page given twice is merged. null only when `v` or `t` is not valid. The largest
 * possible body is about half of READ_BODY_MAX.
 */
export function encodeReadBody(body: ReadBody): string | null {
  const clean = readBodyOf(body, true);
  return clean ? JSON.stringify(clean) : null;
}

/**
 * The edge's reading of a body: the request text (dropped when over READ_BODY_MAX bytes or not a JSON object) or an
 * already-built object (the /event adapter). Unknown fields, out-of-range pages and times, bad channels, surfaces,
 * devices, day codes and languages are dropped; a wrong `v` or `t` makes the whole body null.
 */
export function decodeReadBody(raw: unknown): ReadBody | null {
  let value = raw;
  if (typeof raw === 'string') {
    if (utf8Bytes(raw) > READ_BODY_MAX) return null;
    try {
      value = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  return readBodyOf(value, false);
}

/**
 * The published edition a read's `lang` stands for, in its canonical lower-case form, or undefined when `lang` is not
 * one of `editions` (the comic's card.languages). Exact tags only, compared without case: 'ZH-HANS' is the 'zh-Hans'
 * edition; 'zh-CN', 'hi-IN' or a made-up tag is none.
 */
export function readEditionOf(lang: unknown, editions: readonly unknown[]): string | undefined {
  const tag = langOf(lang);
  if (!tag) return undefined;
  return editions.some((e) => langOf(e) === tag) ? tag : undefined;
}

/**
 * The edition a read is counted under (the page-stats key, the `by_lang_q` key and the viewer's `lang`): its own `lang`
 * when that is a published edition, else the comic's default edition when that is published, else the original
 * (editions[0]). undefined only when the comic lists no valid edition. comic_read_ingest repeats this rule in SQL.
 */
export function readCountedEdition(lang: unknown, editions: readonly unknown[], defaultLang?: unknown): string | undefined {
  return readEditionOf(lang, editions) ?? readEditionOf(defaultLang, editions) ?? editions.map(langOf).find((e) => e !== undefined);
}

// ── Channel and surface ─────────────────────────────────────────────────────────────────────────────────────────

/**
 * Our own hosts (the comics host, its alias, the main site): a referrer from here is the Library or direct. The one list:
 * the edge's read route (api-proxy publicComic.ts, DISC-3) imports it for its "Origin is one of ours" check instead of
 * keeping its own copy.
 */
export const READ_OWN_HOSTS: ReadonlySet<string> = new Set(['comics.dreamstreamstudio.ai', 'comic.dreamstreamstudio.ai', 'dreamstreamstudio.ai', 'www.dreamstreamstudio.ai']);
const HOST_RE = /^[a-z0-9.-]{1,253}$/;
/** Google search itself (google.<tld>, www.google.<tld>); Docs, Drive, Sites and Groups links are shares, not searches. */
const GOOGLE_SEARCH_RE = /^(?:www\.)?google\.[a-z]{2,3}(?:\.[a-z]{2})?$/;
/** Webmail hosts that would otherwise read as their company's search engine. */
const WEBMAIL_HOSTS: ReadonlySet<string> = new Set(['mail.google.com', 'outlook.live.com', 'outlook.office.com', 'outlook.office365.com', 'mail.yahoo.com']);
/** Android apps send `android-app://<package>/` as the referrer, so the "host" is the app's package name. */
const ANDROID_APPS: Readonly<Record<string, ReadChannel>> = {
  'com.linkedin.android': 'linkedin',
  'com.google.android.gm': 'email',
  'com.microsoft.office.outlook': 'email',
  'com.google.android.googlequicksearchbox': 'search',
  'com.whatsapp': 'whatsapp',
  'org.telegram.messenger': 'telegram',
  'com.twitter.android': 'x',
  'com.facebook.katana': 'facebook'
};

/** `host` is `domain` or one of its subdomains. */
const under = (host: string, domain: string): boolean => host === domain || host.endsWith(`.${domain}`);

/** The Library: `/?view=gallery` (any other parameters too) or the `/library` short link. */
function isLibraryPath(path: string | null | undefined): boolean {
  if (typeof path !== 'string') return false;
  const noHash = path.split('#')[0];
  const q = noHash.indexOf('?');
  const pathname = q < 0 ? noHash : noHash.slice(0, q);
  if (pathname === '/library' || pathname === '/library/') return true;
  if (pathname !== '/' && pathname !== '') return false;
  return q >= 0 && new URLSearchParams(noHash.slice(q + 1)).get('view') === 'gallery';
}

/**
 * The channel a referrer stands for, from its host only (and, for our own hosts, whether the path is the Library).
 * The caller reads `document.referrer` and passes `url.hostname` and `url.pathname + url.search`; the referrer itself
 * is never sent. No referrer: `direct`; a host we do not know: `other`.
 */
export function channelFromReferrer(host: string | null | undefined, path?: string | null): ReadChannel {
  if (typeof host !== 'string' || !host.trim()) return 'direct';
  const h = host.trim().toLowerCase().replace(/:\d{1,5}$/, '').replace(/\.$/, '');
  if (!HOST_RE.test(h)) return 'other';
  if (READ_OWN_HOSTS.has(h)) return isLibraryPath(path) ? 'library' : 'direct';
  if (Object.prototype.hasOwnProperty.call(ANDROID_APPS, h)) return ANDROID_APPS[h];
  if (h === 'lnkd.in' || under(h, 'linkedin.com')) return 'linkedin';
  if (h === 't.co' || under(h, 'x.com') || under(h, 'twitter.com')) return 'x';
  if (under(h, 'facebook.com')) return 'facebook';
  if (h === 't.me' || under(h, 'telegram.org')) return 'telegram';
  if (under(h, 'whatsapp.com')) return 'whatsapp';
  if (WEBMAIL_HOSTS.has(h)) return 'email';
  if (GOOGLE_SEARCH_RE.test(h) || under(h, 'bing.com') || under(h, 'duckduckgo.com')) return 'search';
  return 'other';
}

function searchParam(search: string | URLSearchParams, name: string): string | undefined {
  const params = typeof search === 'string' ? new URLSearchParams(search.startsWith('?') ? search.slice(1) : search) : search;
  const value = params.get(name);
  return value === null ? undefined : value.toLowerCase();
}

/** `?via=` against READ_CHANNELS (not SHARE_CHANNELS: `?via=linkedin` works without a LinkedIn share button). */
export function readChannelFromSearch(search: string | URLSearchParams): ReadChannel | undefined {
  const via = searchParam(search, 'via');
  return via !== undefined && CHANNEL_SET.has(via) ? (via as ReadChannel) : undefined;
}

/** `?src=` against READ_SURFACES. */
export function readSurfaceFromSearch(search: string | URLSearchParams): ReadSurface | undefined {
  const src = searchParam(search, 'src');
  return src !== undefined && SURFACE_SET.has(src) ? (src as ReadSurface) : undefined;
}

// ── Children's comics and the Library language ──────────────────────────────────────────────────────────────────

/**
 * A children's comic: rated G, a storybook (the kind, or the card's kind label "Storybook"), or a snapshot whose
 * `brief.audience` is PUBLIC_KIDS_AUDIENCE. Children's comics are counted as totals only: no day code, no page times.
 */
export function isKidsComic(input: { rating?: ContentRating | string | null; kind?: string | null; audience?: string | null }): boolean {
  return input.rating === 'G' || (typeof input.kind === 'string' && input.kind.toLowerCase() === 'storybook') || input.audience === PUBLIC_KIDS_AUDIENCE;
}

/** The languages a comic can be published in (languages.ts), as the Library language rule compares them. */
export const LIBRARY_LANGUAGES: readonly string[] = LANGUAGES.map((l) => l.code);

/**
 * The language the Library opens in (Discover's `your_lang`): the first of the reader's languages that `supported`
 * holds under the app's one language rule (languages.ts matchLanguage, the rule the share page uses), else `en`; the
 * catalogue's own tag, lower case. So 'te-IN' → 'te', 'zh-CN' → 'zh-hans', but 'zh-TW' (Traditional) and 'pa-Arab'
 * (Shahmukhi) are not Simplified Chinese or Gurmukhi Punjabi: they fall to the next language, else `en`.
 */
export function libraryLang(langs: readonly string[], supported: readonly string[] = LIBRARY_LANGUAGES): string {
  const prefs = langs.filter((l): l is string => typeof l === 'string' && l.length <= READ_LANG_MAX);
  return (matchLanguage(prefs, supported) ?? 'en').toLowerCase();
}

const ACCEPT_LANGUAGE_MAX = 1024;
const ACCEPT_ENTRIES_MAX = 20;
const Q_RE = /^\s*q\s*=\s*(0(?:\.\d{0,3})?|1(?:\.0{0,3})?)\s*$/i;

/**
 * An Accept-Language header's tags, most preferred first (by q, then header order), without `*` and q=0 entries, at most
 * 20 (the header is read up to 1 KB). An entry with a malformed q is left out.
 */
export function acceptLanguageTags(header: string | null | undefined): string[] {
  if (typeof header !== 'string') return [];
  const entries: Array<{ tag: string; q: number; i: number }> = [];
  for (const part of header.slice(0, ACCEPT_LANGUAGE_MAX).split(',').slice(0, ACCEPT_ENTRIES_MAX)) {
    const [rawTag, ...params] = part.split(';');
    const tag = rawTag.trim();
    if (!tag || tag === '*' || tag.length > READ_LANG_MAX) continue;
    let q = 1;
    let bad = false;
    for (const param of params) {
      if (!/^\s*q\s*=/i.test(param)) continue;
      const m = Q_RE.exec(param);
      if (m) q = Number(m[1]);
      else bad = true;
    }
    if (bad || q <= 0) continue;
    entries.push({ tag, q, i: entries.length });
  }
  return entries.sort((a, b) => b.q - a.q || a.i - b.i).map((e) => e.tag);
}

/**
 * The Library language from a request's Accept-Language header: exactly libraryLang over acceptLanguageTags. The comics
 * edge's shelves preload (DISC-6E) calls this, so its `your_lang` is byte for byte the one the page then asks for from
 * navigator.languages (browsers send the same list in both).
 */
export function libraryLangFromAcceptLanguage(header: string | null | undefined, supported: readonly string[] = LIBRARY_LANGUAGES): string {
  return libraryLang(acceptLanguageTags(header), supported);
}

// ── The creator's answer: GET /api/comic/projects/:id/readers?range= ────────────────────────────────────────────

export const READ_INSIGHTS_PATH = (projectId: string): string => `/api/comic/projects/${encodeURIComponent(projectId)}/readers`;
export type ReadRange = 7 | 28 | 'all';
export const READ_RANGES: readonly ReadRange[] = [7, 28, 'all'];
/** `?range=` → the range, or undefined (the route answers 400). */
export const parseReadRange = (v: unknown): ReadRange | undefined => (v === '7' ? 7 : v === '28' ? 28 : v === 'all' ? 'all' : undefined);
/** The daily series covers at most this many days. */
export const READ_DAILY_MAX = 28;

export type ReadCounting = 'on' | 'off';
/** Why pages and breakdowns are left out: fewer than K_MIN reads in the range, or a children's comic. */
export type ReadWithheld = 'few' | 'kids';

export interface ReadTotals {
  opens: number;
  starts: number;
  /** Qualified reads (one per reader per day). */
  reads: number;
  finishes: number;
  /** Finishes as a share of reads, 0..100. */
  finishPct: number;
  avgReadMs: number;
  avgPages: number;
  pageCount: number;
  shares: number;
}
export interface ReadDay { day: string; opens: number; reads: number; finishes: number }
export interface ReadFunnel { opened: number; started: number; read: number; finished: number }
export interface ReadPages {
  /** Per page (index 0 = page 1): % of readers whose furthest page is at least this one. */
  reachedPct: number[];
  /** Per page: average visible time, ms. */
  avgMs: number[];
  biggestDrop?: { after: number; pct: number };
  linger?: [page: number, ms: number];
  skim?: [page: number, ms: number, typicalMs: number];
}
/**
 * One edition in the Readers tab. `switchedTo` (readers who switched to this edition) is present only with K_MIN or
 * more, on `other` too: 1-4 would single out a reader's choice, and a 0 shown beside hidden 1-4s would tell them apart.
 * DISC-7a's builder applies the same rule.
 */
export interface ReadEditionBucket { lang: string; reads: number; switchedTo?: number }
export interface ReadBucket<Id extends string> { id: Id; reads: number }

/**
 * The Readers tab's answer. Every list merges buckets under K_MIN readers into `other`; `pages` and the four lists
 * are absent when `withheld` is set (always for children's comics, always under K_MIN reads).
 */
export interface ReadInsights {
  counting: ReadCounting;
  range: ReadRange;
  kids: boolean;
  totals: ReadTotals;
  previous: ReadTotals | null;
  /** Up to READ_DAILY_MAX days. */
  daily: ReadDay[];
  funnel: ReadFunnel;
  pages?: ReadPages;
  editions?: ReadEditionBucket[];
  channels?: ReadBucket<ReadChannel>[];
  sources?: ReadBucket<ReadSurface | 'other'>[];
  devices?: ReadBucket<ReadDevice | 'other'>[];
  withheld?: ReadWithheld;
}

const TOTAL_KEYS = ['opens', 'starts', 'reads', 'finishes', 'shares'] as const;

function totalsOf(raw: unknown): ReadTotals | null {
  if (!isRecord(raw)) return null;
  for (const key of TOTAL_KEYS) if (!count(raw[key])) return null;
  if (!numberIn(raw.finishPct, 0, 100) || !numberIn(raw.avgReadMs, 0, MAX_TIME_MS) || !numberIn(raw.avgPages, 0, READ_PAGE_MAX)) return null;
  if (!wholeIn(raw.pageCount, 1, READ_PAGE_MAX)) return null;
  return {
    opens: raw.opens as number,
    starts: raw.starts as number,
    reads: raw.reads as number,
    finishes: raw.finishes as number,
    finishPct: raw.finishPct,
    avgReadMs: raw.avgReadMs,
    avgPages: raw.avgPages,
    pageCount: raw.pageCount,
    shares: raw.shares as number
  };
}

function daysOf(raw: unknown): ReadDay[] {
  if (!Array.isArray(raw)) return [];
  const out: ReadDay[] = [];
  for (const d of raw) {
    if (out.length >= READ_DAILY_MAX) break;
    if (isRecord(d) && typeof d.day === 'string' && DAY_RE.test(d.day) && count(d.opens) && count(d.reads) && count(d.finishes)) {
      out.push({ day: d.day, opens: d.opens, reads: d.reads, finishes: d.finishes });
    }
  }
  return out;
}

function funnelOf(raw: unknown): ReadFunnel | null {
  if (!isRecord(raw) || !count(raw.opened) || !count(raw.started) || !count(raw.read) || !count(raw.finished)) return null;
  return { opened: raw.opened, started: raw.started, read: raw.read, finished: raw.finished };
}

function pagesOf(raw: unknown, pageCount: number): ReadPages | undefined {
  if (!isRecord(raw) || !Array.isArray(raw.reachedPct) || !Array.isArray(raw.avgMs)) return undefined;
  const reached = raw.reachedPct as unknown[];
  const avg = raw.avgMs as unknown[];
  if (reached.length !== pageCount || avg.length !== pageCount) return undefined;
  if (!reached.every((v) => numberIn(v, 0, 100)) || !avg.every((v) => numberIn(v, 0, MAX_TIME_MS))) return undefined;
  const pages: ReadPages = { reachedPct: reached as number[], avgMs: avg as number[] };
  const drop = raw.biggestDrop;
  if (isRecord(drop) && wholeIn(drop.after, 1, pageCount - 1) && numberIn(drop.pct, 0, 100)) pages.biggestDrop = { after: drop.after, pct: drop.pct };
  const linger = raw.linger;
  if (Array.isArray(linger) && linger.length === 2 && wholeIn(linger[0], 1, pageCount) && numberIn(linger[1], 0, MAX_TIME_MS)) pages.linger = [linger[0], linger[1]];
  const skim = raw.skim;
  if (Array.isArray(skim) && skim.length === 3 && wholeIn(skim[0], 1, pageCount) && numberIn(skim[1], 0, MAX_TIME_MS) && numberIn(skim[2], 0, MAX_TIME_MS)) {
    pages.skim = [skim[0], skim[1], skim[2]];
  }
  return pages;
}

/** A bucket shows only with K_MIN readers or more; `other` (the merged small buckets) may be smaller. Ids once each. */
function bucketsOf<Id extends string>(raw: unknown, ids: ReadonlySet<string>): ReadBucket<Id>[] {
  if (!Array.isArray(raw)) return [];
  const out: ReadBucket<Id>[] = [];
  for (const b of raw) {
    if (out.length >= ids.size) break;
    if (!isRecord(b) || typeof b.id !== 'string' || !ids.has(b.id) || out.some((o) => o.id === b.id) || !count(b.reads)) continue;
    if (b.id !== 'other' && b.reads < K_MIN) continue;
    out.push({ id: b.id as Id, reads: b.reads });
  }
  return out;
}

const EDITIONS_MAX = 20;
function editionsOf(raw: unknown): ReadEditionBucket[] {
  if (!Array.isArray(raw)) return [];
  const out: ReadEditionBucket[] = [];
  for (const e of raw) {
    if (out.length >= EDITIONS_MAX) break;
    if (!isRecord(e) || !count(e.reads) || (e.switchedTo !== undefined && !count(e.switchedTo))) continue;
    const lang = e.lang === 'other' ? 'other' : langOf(e.lang);
    if (!lang || out.some((o) => o.lang === lang)) continue;
    if (lang !== 'other' && e.reads < K_MIN) continue;
    const bucket: ReadEditionBucket = { lang, reads: e.reads };
    if (typeof e.switchedTo === 'number' && e.switchedTo >= K_MIN) bucket.switchedTo = e.switchedTo;
    out.push(bucket);
  }
  return out;
}

const CHANNEL_IDS: ReadonlySet<string> = CHANNEL_SET; // READ_CHANNELS already holds 'other'
const SURFACE_IDS: ReadonlySet<string> = new Set([...READ_SURFACES, 'other']);
const DEVICE_IDS: ReadonlySet<string> = new Set([...READ_DEVICES, 'other']);

/**
 * The Readers tab's check of the container's answer: unknown fields dropped at every level, null when the core
 * (counting, range, kids, totals, funnel) is missing or malformed. Buckets under K_MIN readers (other than `other`)
 * are refused; a children's comic is always withheld as `kids`, fewer than K_MIN reads always as `few`, and a
 * withheld answer never carries pages or breakdowns.
 */
export function decodeReadInsights(raw: unknown): ReadInsights | null {
  if (!isRecord(raw)) return null;
  if (raw.counting !== 'on' && raw.counting !== 'off') return null;
  if (raw.range !== 7 && raw.range !== 28 && raw.range !== 'all') return null;
  if (typeof raw.kids !== 'boolean') return null;
  const totals = totalsOf(raw.totals);
  const funnel = funnelOf(raw.funnel);
  if (!totals || !funnel) return null;
  const out: ReadInsights = {
    counting: raw.counting,
    range: raw.range,
    kids: raw.kids,
    totals,
    previous: totalsOf(raw.previous),
    daily: daysOf(raw.daily),
    funnel
  };
  let withheld: ReadWithheld | undefined = raw.withheld === 'few' || raw.withheld === 'kids' ? raw.withheld : undefined;
  if (raw.kids) withheld = 'kids';
  else if (!withheld && totals.reads < K_MIN) withheld = 'few';
  if (withheld) {
    out.withheld = withheld;
    return out;
  }
  const pages = pagesOf(raw.pages, totals.pageCount);
  if (pages) out.pages = pages;
  out.editions = editionsOf(raw.editions);
  out.channels = bucketsOf<ReadChannel>(raw.channels, CHANNEL_IDS);
  out.sources = bucketsOf<ReadSurface | 'other'>(raw.sources, SURFACE_IDS);
  out.devices = bucketsOf<ReadDevice | 'other'>(raw.devices, DEVICE_IDS);
  return out;
}

// ── The admin's answer: GET /api/comic/admin/reading?days= ──────────────────────────────────────────────────────

export const READING_ADMIN_PATH = '/api/comic/admin/reading';
export type ReadingAdminDays = 7 | 28;
export const READING_ADMIN_DAYS: readonly ReadingAdminDays[] = [7, 28];
export const parseReadingAdminDays = (v: unknown): ReadingAdminDays | undefined => (v === '7' ? 7 : v === '28' ? 28 : undefined);

/** comic_read_ingest's one-word answers; every one but `ok` is counted in comic_read_health. */
export type ReadIngestStatus = 'ok' | 'shape' | 'nosalt' | 'proof' | 'gone' | 'capped';
export const READ_INGEST_STATUSES: readonly ReadIngestStatus[] = ['ok', 'shape', 'nosalt', 'proof', 'gone', 'capped'];
export type ReadHealthStatus = Exclude<ReadIngestStatus, 'ok'>;
/** The two pg_cron jobs (server/sql/comic_reading.sql). */
export type ReadingJobName = 'comic-rank-refresh' | 'comic-reading-purge-daily';
export const READING_JOBS: readonly ReadingJobName[] = ['comic-rank-refresh', 'comic-reading-purge-daily'];
/** Why the admin section says the counter is off: no config row, only proof/nosalt answers, no stats in 24 h. */
export type ReadingOffReason = 'config_missing' | 'proof_failures' | 'no_stats_24h';
export const READING_OFF_REASONS: readonly ReadingOffReason[] = ['config_missing', 'proof_failures', 'no_stats_24h'];
/** The most ranked rows the admin answer carries. */
export const READING_ADMIN_RANKED_MAX = 100;

export interface ReadingHealthRow { day: string; status: ReadHealthStatus; n: number }
/** A job's last run from cron.job_run_details; only `name` when it never ran. */
export interface ReadingJobRun { name: ReadingJobName; lastRunAt?: number; status?: 'succeeded' | 'failed' | 'running'; durationMs?: number }
/** One listed comic and why it ranks where it does (comic_rank). */
export interface ReadingRankRow { slug: string; title: string; score: number; heat: number; quality: number; fresh: number; reads7d: number }

export interface ReadingAdminOverview {
  counting: ReadCounting;
  /** Empty when counting is on. */
  reasons: ReadingOffReason[];
  days: ReadingAdminDays;
  /** Whether the counting secret's database row exists (never its value). */
  configPresent: boolean;
  statsRows24h: number;
  health: ReadingHealthRow[];
  jobs: ReadingJobRun[];
  /** comic_publication_page_stats' size (revisit the design at 50 MB). */
  pageStatsBytes: number;
  ranked: ReadingRankRow[];
  /** Totals per day across public comics. */
  daily: ReadDay[];
}

const HEALTH_SET = new Set<string>(READ_INGEST_STATUSES.filter((s) => s !== 'ok'));
const JOB_SET = new Set<string>(READING_JOBS);
const REASON_SET = new Set<string>(READING_OFF_REASONS);
const RUN_STATUSES = new Set(['succeeded', 'failed', 'running']);
const HEALTH_MAX = 28 * HEALTH_SET.size;

function cleanTitle(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined;
  const text = [...v.replace(CONTROL_RE, '').trim()].slice(0, 90).join('').trim();
  return text || undefined;
}

function jobsOf(raw: unknown): ReadingJobRun[] {
  if (!Array.isArray(raw)) return [];
  const out: ReadingJobRun[] = [];
  for (const j of raw) {
    if (!isRecord(j) || typeof j.name !== 'string' || !JOB_SET.has(j.name) || out.some((o) => o.name === j.name)) continue;
    const run: ReadingJobRun = { name: j.name as ReadingJobName };
    if (wholeIn(j.lastRunAt, 0, MAX_TIME_MS)) run.lastRunAt = j.lastRunAt;
    if (typeof j.status === 'string' && RUN_STATUSES.has(j.status)) run.status = j.status as ReadingJobRun['status'];
    if (wholeIn(j.durationMs, 0, MAX_TIME_MS)) run.durationMs = j.durationMs;
    out.push(run);
  }
  return out;
}

function rankedOf(raw: unknown): ReadingRankRow[] {
  if (!Array.isArray(raw)) return [];
  const out: ReadingRankRow[] = [];
  for (const r of raw) {
    if (out.length >= READING_ADMIN_RANKED_MAX) break;
    if (!isRecord(r) || typeof r.slug !== 'string' || !SLUG_RE.test(r.slug) || out.some((o) => o.slug === r.slug)) continue;
    const title = cleanTitle(r.title);
    const nums = [r.score, r.heat, r.quality, r.fresh];
    if (!title || !nums.every((n) => numberIn(n, 0, Number.MAX_VALUE)) || !count(r.reads7d)) continue;
    out.push({ slug: r.slug, title, score: r.score as number, heat: r.heat as number, quality: r.quality as number, fresh: r.fresh as number, reads7d: r.reads7d });
  }
  return out;
}

/**
 * The admin section's check of the container's answer: unknown fields dropped (never the salt, ids or job commands),
 * null when counting, days or configPresent is malformed. Health rows keep the non-`ok` statuses only; jobs, reasons
 * and ranked rows keep known values only.
 */
export function decodeReadingAdminOverview(raw: unknown): ReadingAdminOverview | null {
  if (!isRecord(raw)) return null;
  if (raw.counting !== 'on' && raw.counting !== 'off') return null;
  if (raw.days !== 7 && raw.days !== 28) return null;
  if (typeof raw.configPresent !== 'boolean') return null;
  const reasons: ReadingOffReason[] = [];
  if (raw.counting === 'off' && Array.isArray(raw.reasons)) {
    for (const r of raw.reasons) if (typeof r === 'string' && REASON_SET.has(r) && !reasons.includes(r as ReadingOffReason)) reasons.push(r as ReadingOffReason);
  }
  const health: ReadingHealthRow[] = [];
  if (Array.isArray(raw.health)) {
    for (const h of raw.health) {
      if (health.length >= HEALTH_MAX) break;
      if (isRecord(h) && typeof h.day === 'string' && DAY_RE.test(h.day) && typeof h.status === 'string' && HEALTH_SET.has(h.status) && count(h.n)) {
        health.push({ day: h.day, status: h.status as ReadHealthStatus, n: h.n });
      }
    }
  }
  return {
    counting: raw.counting,
    reasons,
    days: raw.days,
    configPresent: raw.configPresent,
    statsRows24h: count(raw.statsRows24h) ? raw.statsRows24h : 0,
    health,
    jobs: jobsOf(raw.jobs),
    pageStatsBytes: wholeIn(raw.pageStatsBytes, 0, Number.MAX_SAFE_INTEGER) ? raw.pageStatsBytes : 0,
    ranked: rankedOf(raw.ranked),
    daily: daysOf(raw.daily)
  };
}
