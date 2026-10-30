// Publishing — frozen publication snapshots behind /c/<slug> (contract §9.3). Types + pure helpers only.
//
// comic_publications is the source of truth; ComicDoc.publication is a server-written mirror for the UI and the
// director's context line. Links are read-only; readers may download unless the author turns allowDownload off.

import type { AspectRatio, ComicDoc } from './doc.js';
import type { ContentRating } from './safety.js';

export type Visibility = 'private' | 'unlisted' | 'public'; // 'private' = no live publication
export type PublicationStatus = 'live' | 'unpublished' | 'suspended';
export const SLUG_LENGTH = 17; // 17 × base62 ≈ 101 bits (≥ 96 required)
export const SLUG_RE = /^[A-Za-z0-9]{17}$/;
export const ASSET_KEY_RE = /^[A-Za-z0-9]{22}$/; // ≈ 131 bits, storage prefix pub/<key>/
export const SHARE_PATH = (slug: string): string => `/c/${slug}`;
export const OG_TEMPLATE_VERSION = 1;
/**
 * A public snapshot's page check is geometry only (server publication/snapshot.ts publicQc): no score, issues or
 * time, so its `checkedAt` is this value (a live page check always stores the real time). A snapshot page with this
 * marker and no face lists was published before the faces were (keepOut/heads); the lettering never moves its stored
 * balloons there (lettering/layout.ts).
 */
export const PUBLIC_QC_CHECKED_AT = 0;
/** The only audience a public snapshot carries: the category word, for a children's book that is not a storybook. */
export const PUBLIC_KIDS_AUDIENCE = 'children';
export type ShareChannel = 'copy' | 'native' | 'qr' | 'whatsapp' | 'x' | 'facebook' | 'telegram' | 'email' | 'embed' | 'direct';
export const SHARE_CHANNELS: readonly ShareChannel[] = ['copy', 'native', 'qr', 'whatsapp', 'x', 'facebook', 'telegram', 'email', 'embed', 'direct'];
export interface ShareLinkOptions { lang?: string; page?: number; via?: ShareChannel; guided?: boolean }

const MAX_PAGE_PARAM = 500;
const LANG_SHAPE = /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8}){0,3}$/;

/** Canonical link builder (client, server, director, Pages Function). Drops params equal to the publication defaults. */
export function buildShareUrl(
  origin: string,
  slug: string,
  o: ShareLinkOptions = {},
  pub?: { defaultLang?: string; startPage?: number | null }
): string {
  const base = `${(origin || '').replace(/\/+$/, '')}${SHARE_PATH(slug)}`;
  const params = new URLSearchParams();
  if (typeof o.page === 'number' && Number.isFinite(o.page)) {
    const p = Math.min(MAX_PAGE_PARAM, Math.max(0, Math.floor(o.page)));
    const start = pub?.startPage;
    if (!(typeof start === 'number' && p === start)) params.set('p', String(p));
  }
  if (o.lang && LANG_SHAPE.test(o.lang) && !(pub?.defaultLang && pub.defaultLang === o.lang)) params.set('lang', o.lang);
  if (o.guided) params.set('guided', '1');
  if (o.via && SHARE_CHANNELS.includes(o.via)) params.set('via', o.via);
  const qs = params.toString();
  return qs ? `${base}?${qs}` : base;
}

/** Clamps + allow-lists p (0..500), lang (BCP-47 shape), via (enum), guided ('1'). */
export function parseShareParams(search: string | URLSearchParams): ShareLinkOptions {
  const params = typeof search === 'string' ? new URLSearchParams(search.startsWith('?') ? search.slice(1) : search) : search;
  const out: ShareLinkOptions = {};
  const p = params.get('p');
  if (p !== null && /^\d{1,6}$/.test(p.trim())) out.page = Math.min(MAX_PAGE_PARAM, Math.max(0, Number(p.trim())));
  const lang = params.get('lang');
  if (lang && lang.length <= 35 && LANG_SHAPE.test(lang)) out.lang = lang;
  const via = params.get('via');
  if (via && (SHARE_CHANNELS as readonly string[]).includes(via)) out.via = via as ShareChannel;
  if (params.get('guided') === '1') out.guided = true;
  return out;
}

export interface PublishRequest {
  visibility: 'unlisted' | 'public';
  /**
   * Published editions; each must pass editionReadiness().publishable. The source language is ALWAYS
   * published, first (readers always get the original; i18n.md §11.1, sharing.md §3 languages[0]),
   * whether or not it is named here. Default [format.language].
   */
  languages?: string[];
  /**
   * The edition readers start in (one of the published languages). Absent: when `languages` leaves out
   * the original, an edition it names (the live default if named, else the first); otherwise the live
   * default if still published, else the original.
   */
  defaultLang?: string;
  startPage?: number | null;
  allowDownload?: boolean; // default TRUE (addendum)
  allowEmbed?: boolean; // default true
  showCreator?: boolean; // default false (privacy; kids content)
  /** Owner-confirmed exclusion of safety-blocked pages. */
  excludePageIds?: string[];
}
export type PublicationSettingsPatch = Partial<Pick<PublishRequest,
  'visibility' | 'defaultLang' | 'startPage' | 'allowDownload' | 'allowEmbed' | 'showCreator'>>;

export const PUBLISH_DEFAULTS = { allowDownload: true, allowEmbed: true, showCreator: false } as const;

export interface PublishReadiness {
  ok: boolean;
  drawnPages: number;
  plannedPages: number;
  missing: Array<{ kind: 'cover' | 'page'; n?: number; status: string }>;
  stalePages: number[];
  safety: { status: 'cleared' | 'needs_check' | 'blocked'; blockedPages: number[]; reasons: string[] };
  /**
   * Every edition the comic holds, not only the ones asked about: the requested (or published, else the
   * source) languages first, then the doc's other editions, so the Share sheet can offer a finished
   * translation that is not published yet. `requested` marks the entries this readiness was asked
   * about; absent means requested (older views). `ok` considers requested entries only.
   */
  languages: Array<{ lang: string; publishable: boolean; blocking: string[]; requested?: boolean }>;
  /**
   * Ship 2 (pro plan §8; PD-5): per drawn page, the printed photo overlays (`photos`) and frame pictures (`frames`)
   * publishing leaves out — any that is not checked studio art at this rating (an image from outside the studio, a photo
   * never checked, one over the rating). Never a blocker: a frame shows its cut of the page's drawing and an overlay is
   * not printed. Guide-only overlays are never published and never listed. Absent when there are none (older views too).
   */
  leftOutPictures?: Array<{ n: number; photos: number; frames: number }>;
}
export interface PublicationOwnerView {
  visibility: Visibility;
  status: PublicationStatus | null;
  slug?: string;
  url?: string;
  ogImageUrl?: string;
  languages: string[];
  defaultLang?: string;
  startPage?: number | null;
  allowDownload: boolean;
  allowEmbed: boolean;
  showCreator: boolean;
  publishedRev: number;
  docRev: number;
  behind: boolean; // live doc changed since the snapshot
  publishedAt?: number;
  firstPublishedAt?: number;
  stats?: { views: number; uniques7d: number; completes7d: number; byChannel7d: Record<string, number>; daily: Array<{ day: string; views: number }> };
  readiness: PublishReadiness;
  suspendedReason?: string;
  /** The rating the live publication was safety-checked under (frozen at publish time; P2-PUBLIC-PAYLOAD). */
  rating?: ContentRating;
  /**
   * Pages the owner left out of the live publication ("Publish without page N" consent) that publishing
   * would still refuse (blocked now, or still an outside image). The Share sheet's Update resends them as
   * `excludePageIds`, since the gate keeps a blocked verdict; a page redrawn since is not listed, so an
   * Update publishes the redraw if the gate passes it.
   */
  excludedPageIds?: string[];
  /**
   * What link previews actually show (live rows): the FROZEN card's title and description in the
   * default language, and the published cover copy (the og:image fallback). Not the live doc's text.
   */
  card?: { title: string; description: string; coverUrl?: string };
}

/** The preview text with the rating appended ("… · Rated PG-13"): what every link preview carries. */
export const ratedDescription = (description: string, rating?: ContentRating): string =>
  rating ? (description ? `${description} · Rated ${rating}` : `Rated ${rating}`) : description;
/** doc.publication — server-written mirror for UI + the director context line. */
export interface PublicationMirror {
  visibility: 'unlisted' | 'public';
  status: 'live' | 'suspended';
  slug?: string;
  publishedRev: number;
  publishedAt: number;
  languages: string[];
}
export const isPublicationMirror = (v: unknown): v is PublicationMirror => {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
  const m = v as Record<string, unknown>;
  return (
    (m.visibility === 'unlisted' || m.visibility === 'public') &&
    (m.status === 'live' || m.status === 'suspended') &&
    (m.slug === undefined || (typeof m.slug === 'string' && SLUG_RE.test(m.slug))) &&
    typeof m.publishedRev === 'number' && Number.isFinite(m.publishedRev) &&
    typeof m.publishedAt === 'number' && Number.isFinite(m.publishedAt) &&
    Array.isArray(m.languages) && m.languages.every((l) => typeof l === 'string')
  );
};

/** Stored in comic_publications.card; read by the edge (never wakes the container). */
export interface ShareCard {
  v: 1;
  title: string; // ≤ 90, control chars stripped
  description: string; // logline || tagline || "A 4-page kids storybook made with DreamStream Studio" (≤ 200)
  kindLabel: string;
  pageCount: number;
  aspect: AspectRatio;
  creator?: string; // only with showCreator: public username, never email/real name
  coverUrl?: string; // public URL of the cover 1080w variant (pub/…)
  og: Record<string, { path: string; w: 1200; h: 630; alt: string }>; // lang → og image under pub/<key>/
  i18n: Record<string, { title: string; description: string }>;
  themeColor?: string;
}
export interface PublicPublicationInfo {
  slug: string;
  visibility: 'unlisted' | 'public';
  languages: string[];
  defaultLang?: string;
  startPage?: number | null;
  allowDownload: boolean;
  allowEmbed: boolean;
  publishedAt: number;
  updatedAt: number;
  card: ShareCard;
  /**
   * The content rating (G / PG / PG-13) the publish gate verified this snapshot under, frozen at
   * publish time (comic_publications.safety.rating; P2-PUBLIC-PAYLOAD). Optional: publications made
   * before ratings were recorded have none — readers treat that as unknown, never as kids-friendly.
   */
  rating?: ContentRating;
}
/** GET /api/comic/public/s/:slug (edge). urls: every path in `doc` → public object URL. */
export interface PublicComicPayload { publication: PublicPublicationInfo; doc: ComicDoc; urls: Record<string, string> }

/** One reader language of GET /api/comic/public/:id (P2-AMEND, from P1-ROUTES; contract §14.1). The source first. */
export interface ReaderLanguage {
  code: string;
  endonym: string;
  english: string;
  /** Every line translated and current (always true for the source). */
  complete: boolean;
  isSource: boolean;
}
/**
 * GET /api/comic/public/:id (contract §14.1, as amended). The owner gets a sanitized private preview
 * ('private, no-store', Vary: Authorization); anyone else gets a live PUBLIC publication only ('no-store', so an
 * unpublish takes effect at once). `lang` is set when `?lang=` named a published edition (doc is localized).
 */
export type PublicComicByIdResponse =
  | { doc: ComicDoc; urls: Record<string, string>; languages: ReaderLanguage[]; preview: true; lang?: string }
  | { doc: ComicDoc; urls: Record<string, string>; publication: PublicPublicationInfo; languages: ReaderLanguage[]; lang?: string };
/** The one canonical 404 body for unlisted, private, missing and malformed ids (sent with no-store). */
export const PUBLIC_COMIC_NOT_FOUND = { error: { message: "This comic isn't available.", code: 'NOT_FOUND' } } as const;
