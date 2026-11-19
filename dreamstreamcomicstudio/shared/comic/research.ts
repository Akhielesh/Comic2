// Comic research: the bounded, allow-listed shape of everything Wikipedia and Wikimedia Commons hand the studio
// (docs/features/comic-research.md). One normalizer serves fresh responses, stored cards and the doc's research
// state, so a stored value can never carry more than a fresh one. Pure and dependency-free apart from the language
// registry (shared/comic/languages.ts), which decides the Wikipedia hosts and the script table.

import { LANGUAGES, SCRIPTS, languageSpec, type ScriptId } from './languages.js';

export interface ComicResearchResult {
  title: string;
  source: string;
  description?: string;
  /** Articles only: the opening of the article, plain text (≤ 600 characters). Untrusted reference data. */
  extract?: string;
  /** Articles only: the registry language of the article's Wikipedia; omitted for an English article that never stated it. */
  lang?: string;
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

/** C0/C1 controls and the bidi embeddings, overrides and isolates (they can hide or reorder text). */
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f‪-‮⁦-⁩]/g;

export const comicResearchText = (value: unknown, limit: number): string => typeof value === 'string'
  ? value.replace(/<[^>]*>/g, '').replace(CONTROL_CHARS, ' ').replace(/\s+/g, ' ').trim().slice(0, limit)
  : '';

// ── Hosts ────────────────────────────────────────────────────────────────────

/** Registry code → its Wikipedia host, derived from LANGUAGES ('zh-Hans' → 'zh.wikipedia.org'). */
export const WIKI_HOSTS: Readonly<Record<string, string>> = Object.freeze(
  Object.fromEntries(LANGUAGES.map((l) => [l.code, `${l.code.split('-')[0].toLowerCase()}.wikipedia.org`]))
);
const WIKI_HOST_LIST: readonly string[] = Object.values(WIKI_HOSTS);
const LANGUAGE_BY_HOST: ReadonlyMap<string, string> = new Map(Object.entries(WIKI_HOSTS).map(([code, host]) => [host, code]));
export const COMMONS_HOST = 'commons.wikimedia.org';

/** The Wikipedia host for a language tag ('te-IN' → te.wikipedia.org), or undefined outside the registry. */
export const wikiHostFor = (lang?: string): string | undefined => {
  const code = languageSpec(lang)?.code;
  return code ? WIKI_HOSTS[code] : undefined;
};

/** The registry language of a Wikipedia host ('zh.wikipedia.org' → 'zh-Hans'), or undefined for any other host. */
export const wikiLanguageOf = (host: string): string | undefined => LANGUAGE_BY_HOST.get(host);

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

/** An article page on one of the registry's Wikipedias, or a `File:` page on Commons. */
const sourceUrl = (raw: unknown, image: boolean): URL | undefined => {
  const url = trustedUrl(raw, image ? [COMMONS_HOST] : WIKI_HOST_LIST);
  if (!url || !url.pathname.startsWith('/wiki/')) return undefined;
  try {
    const title = decodeURIComponent(url.pathname.slice(6));
    if (!title.trim() || title === '.' || title === '..' || /[\u0000-\u001f\u007f]/.test(title)) return undefined;
    if (image && !/^File:.+/.test(title)) return undefined;
    return url;
  } catch {
    return undefined;
  }
};

/**
 * An article's language: the host decides. A stated `lang` that agrees with the host is kept; a non-English host
 * always gets its own; an English article that stated nothing stays without the key (stored cards keep their shape).
 */
const articleLang = (url: URL, stated: unknown): string | undefined => {
  const host = wikiLanguageOf(url.hostname);
  if (!host) return undefined;
  const said = typeof stated === 'string' ? languageSpec(stated)?.code : undefined;
  return host !== 'en' || said === host ? host : undefined;
};

// ── Licences ─────────────────────────────────────────────────────────────────

/** Every licence research accepts at all (others are dropped): CC0, public domain, CC BY, CC BY-SA. */
const ACCEPTED_LICENCE = /^(?:CC(?:[ -]?0|[ -]BY(?:-SA)?)(?:\s+\d+(?:\.\d+)?)?|public domain)$/i;

export type ResearchLicenceKind = 'cc0' | 'public-domain' | 'cc-by' | 'cc-by-sa';

/**
 * The licences whose pictures may be attached as references for drawing. CC BY needs a credit a published comic
 * cannot show yet (RW-8 adds 'cc-by' once the Sources row exists); CC BY-SA is never attachable.
 */
export const ATTACHABLE_LICENCES: readonly ResearchLicenceKind[] = Object.freeze(['cc0', 'public-domain'] as const);

export const licenceKind = (license: unknown): ResearchLicenceKind | undefined => {
  if (typeof license !== 'string') return undefined;
  const value = license.trim();
  if (!ACCEPTED_LICENCE.test(value)) return undefined;
  if (/^public domain$/i.test(value)) return 'public-domain';
  if (/^CC[ -]?0\b/i.test(value)) return 'cc0';
  return /^CC[ -]BY-SA\b/i.test(value) ? 'cc-by-sa' : 'cc-by';
};

export const attachableLicence = (license: unknown): boolean => {
  const kind = licenceKind(license);
  return !!kind && ATTACHABLE_LICENCES.includes(kind);
};

/** Decided from the licence on every read, never stored: an old card stops offering "Add image" the day the rule tightens. */
export const isAttachable = (result: Pick<ComicResearchResult, 'thumbnail' | 'license'>): boolean => !!result.thumbnail && attachableLicence(result.license);

/** A picture's licence and credit pass when the licence is accepted and every CC BY family licence names its author. */
const pictureLicence = (license: string, credit: string): boolean => {
  const kind = licenceKind(license);
  return !!kind && (kind === 'cc0' || kind === 'public-domain' || !!credit);
};

// ── Results (fresh responses and stored cards) ───────────────────────────────

/** Accept both fresh responses and stored cards through the same bounded source allowlist. */
export const normalizeComicResearch = (value: unknown): ComicResearchResults | undefined => {
  if (!record(value) || !Array.isArray(value.articles) || !Array.isArray(value.images) || typeof value.incomplete !== 'boolean') return undefined;
  const articles = value.articles.slice(0, 4).flatMap((entry): ComicResearchResult[] => {
    if (!record(entry)) return [];
    const title = comicResearchText(entry.title, 160);
    const url = sourceUrl(entry.source, false);
    if (!title || !url) return [];
    const description = comicResearchText(entry.description, 260);
    const extract = comicResearchText(entry.extract, RESEARCH_LIMITS.extract);
    const lang = articleLang(url, entry.lang);
    return [{ title, source: url.href, ...(description ? { description } : {}), ...(extract ? { extract } : {}), ...(lang ? { lang } : {}) }];
  });
  const images = value.images.slice(0, 6).flatMap((entry): ComicResearchResult[] => {
    if (!record(entry)) return [];
    const title = comicResearchText(entry.title, 235);
    const source = sourceUrl(entry.source, true)?.href;
    const thumbnail = commonsThumbnail(entry.thumbnail);
    const license = comicResearchText(entry.license, 65);
    const credit = comicResearchText(entry.credit, 160);
    if (!title || !source || !thumbnail || !pictureLicence(license, credit)) return [];
    return [{ title, source, thumbnail, license, ...(credit ? { credit } : {}) }];
  });
  return { articles, images, incomplete: value.incomplete };
};

// ── The doc's research state (ComicDoc.research arrives with RW-5; inert until then) ──

export const RESEARCH_LIMITS = Object.freeze({
  sources: 8, lookups: 8, subject: 60, lookedUp: 80, title: 160, extract: 600, license: 65, credit: 160, subjectWords: 6
});

export interface ResearchSource {
  kind: 'article' | 'image';
  title: string;
  /** An article on a registry Wikipedia, or a Commons `File:` page. */
  url: string;
  /** Registry code: an article's is its Wikipedia's; a picture's is the language it was found in (English when unknown). */
  lang: string;
  /** Articles only. */
  extract?: string;
  license?: string;
  credit?: string;
  /** `auto`: the planner's own look-up; `pinned`: the creator chose it. */
  origin: 'auto' | 'pinned';
}

export interface ResearchState {
  /** The public subject the comic retells or is set in ("Ramayana"); always passes guardResearchSubject. */
  subject?: string;
  sources: ResearchSource[];
  /** Automatic look-ups so far (0..8). */
  lookups: number;
  /** "subject|language" of the last automatic look-up. */
  lookedUp?: string;
}

export const normalizeResearchSource = (value: unknown): ResearchSource | undefined => {
  if (!record(value)) return undefined;
  const { kind, origin } = value;
  if ((kind !== 'article' && kind !== 'image') || (origin !== 'auto' && origin !== 'pinned')) return undefined;
  const title = comicResearchText(value.title, RESEARCH_LIMITS.title);
  const url = sourceUrl(value.url, kind === 'image');
  if (!title || !url) return undefined;
  const license = comicResearchText(value.license, RESEARCH_LIMITS.license);
  const credit = comicResearchText(value.credit, RESEARCH_LIMITS.credit);
  if (kind === 'image' && !pictureLicence(license, credit)) return undefined;
  const lang = kind === 'article'
    ? wikiLanguageOf(url.hostname)!
    : (typeof value.lang === 'string' && languageSpec(value.lang)?.code) || 'en';
  const extract = kind === 'article' ? comicResearchText(value.extract, RESEARCH_LIMITS.extract) : '';
  return {
    kind, title, url: url.href, lang,
    ...(extract ? { extract } : {}),
    ...(license && licenceKind(license) ? { license } : {}),
    ...(credit ? { credit } : {}),
    origin
  };
};

/** At most `RESEARCH_LIMITS.sources`: the oldest automatic source goes first, then the oldest pinned one. */
const fitSources = (sources: ResearchSource[]): ResearchSource[] => {
  const out = [...sources];
  while (out.length > RESEARCH_LIMITS.sources) {
    const auto = out.findIndex((s) => s.origin === 'auto');
    out.splice(auto >= 0 ? auto : 0, 1);
  }
  return out;
};

export const normalizeResearchState = (value: unknown): ResearchState | undefined => {
  if (!record(value)) return undefined;
  const subject = typeof value.subject === 'string' ? guardResearchSubject(value.subject) : undefined;
  const seen = new Set<string>();
  const sources = (Array.isArray(value.sources) ? value.sources.slice(0, 64) : []).flatMap((entry): ResearchSource[] => {
    const source = normalizeResearchSource(entry);
    if (!source || seen.has(source.url)) return [];
    seen.add(source.url);
    return [source];
  });
  const raw = typeof value.lookups === 'number' && Number.isFinite(value.lookups) ? Math.floor(value.lookups) : 0;
  const lookedUp = comicResearchText(value.lookedUp, RESEARCH_LIMITS.lookedUp);
  return {
    ...(subject?.ok ? { subject: subject.subject } : {}),
    sources: fitSources(sources),
    lookups: Math.min(RESEARCH_LIMITS.lookups, Math.max(0, raw)),
    ...(lookedUp ? { lookedUp } : {})
  };
};

/** The URLs the creator pinned to this comic (a defensive read of `doc.research`; empty before RW-5). */
export const pinnedSourceUrls = (doc: unknown): Set<string> => {
  const research = record(doc) ? doc.research : undefined;
  const sources = record(research) && Array.isArray(research.sources) ? research.sources.slice(0, 64) : [];
  const urls = new Set<string>();
  for (const entry of sources) {
    const source = normalizeResearchSource(entry);
    if (source?.origin === 'pinned') urls.add(source.url);
  }
  return urls;
};

// ── The subject guard (what may be sent to Wikipedia as a search) ────────────

export type ResearchSubjectRefusal = 'length' | 'words' | 'email' | 'link' | 'number' | 'phone' | 'control' | 'blocked_name';
export type ResearchSubjectCheck = { ok: true; subject: string } | { ok: false; reason: ResearchSubjectRefusal };

const DIGIT_RUN = /\p{Nd}{5,}/u;
const NUMBER_RUN = /[+(]?\p{Nd}[\p{Nd}\s\-.()/‐-―]*\p{Nd}/gu;
const YEAR_RANGE = /^([12]\d{3})\s*[-/‐-―]?\s*([12]\d{3})$/;

/** Seven or more digits held together by separators, unless it is a span of years ("1914-1918", "1603 1868"). */
const phoneLike = (text: string): boolean => {
  for (const run of text.match(NUMBER_RUN) ?? []) {
    if ((run.match(/\p{Nd}/gu) ?? []).length < 7) continue;
    const years = YEAR_RANGE.exec(run);
    if (years && +years[1] >= 1000 && +years[2] <= 2100 && +years[2] >= +years[1]) continue;
    return true;
  }
  return false;
};

/**
 * The public name of a work, place, period or event, and nothing that could be a person's private data: 2-60
 * characters after trimming, at most 6 words, no `@`, link, run of 5+ digits, phone-like number or control character,
 * and none of `blockedNames` (case-insensitive substring; names under 2 characters are ignored).
 */
export const guardResearchSubject = (text: string, { blockedNames = [] }: { blockedNames?: readonly string[] } = {}): ResearchSubjectCheck => {
  if (typeof text !== 'string') return { ok: false, reason: 'length' };
  const trimmed = text.trim();
  if (new RegExp(CONTROL_CHARS.source).test(trimmed)) return { ok: false, reason: 'control' };
  const subject = trimmed.replace(/\s+/g, ' ');
  const length = Array.from(subject).length;
  if (length < 2 || length > RESEARCH_LIMITS.subject) return { ok: false, reason: 'length' };
  if (subject.split(' ').length > RESEARCH_LIMITS.subjectWords) return { ok: false, reason: 'words' };
  if (/[@＠]/.test(subject)) return { ok: false, reason: 'email' };
  if (/http|www\.|:\/\//i.test(subject)) return { ok: false, reason: 'link' };
  if (DIGIT_RUN.test(subject)) return { ok: false, reason: 'number' };
  if (phoneLike(subject)) return { ok: false, reason: 'phone' };
  const lower = subject.toLowerCase();
  for (const name of blockedNames) {
    const needle = typeof name === 'string' ? name.trim().replace(/\s+/g, ' ').toLowerCase() : '';
    if (Array.from(needle).length >= 2 && lower.includes(needle)) return { ok: false, reason: 'blocked_name' };
  }
  return { ok: true, subject };
};

// ── Script → language (only where the script names exactly one registry language) ──

const SCRIPT_IDS = Object.keys(SCRIPTS) as ScriptId[];
const LANGUAGES_BY_SCRIPT: ReadonlyMap<ScriptId, readonly string[]> = new Map(
  SCRIPT_IDS.map((id) => [id, LANGUAGES.filter((l) => l.script === id).map((l) => l.code)])
);

/**
 * The registry language of the text's script, only when that script maps to exactly one registry language
 * (Telugu → te, Hangul → ko, kana → ja, …). The script with the most letters decides; Latin, Devanagari (hi/mr),
 * Arabic (ar/ur) and Han without kana (zh-Hans/ja) are ambiguous and give undefined.
 */
export const scriptLanguage = (text: string): string | undefined => {
  if (typeof text !== 'string') return undefined;
  const counts = new Map<ScriptId, number>();
  for (const ch of Array.from(text).slice(0, 2000)) {
    for (const id of SCRIPT_IDS) if (SCRIPTS[id].letters.test(ch)) counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  const most = Math.max(0, ...counts.values());
  if (!most) return undefined;
  const top = SCRIPT_IDS.filter((id) => counts.get(id) === most);
  const langs = new Set(top.flatMap((id) => LANGUAGES_BY_SCRIPT.get(id) ?? []));
  return langs.size === 1 ? [...langs][0] : undefined;
};
